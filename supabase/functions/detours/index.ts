// detours: returns the signed-in player's detour offers for today.
//
// POST { lat?, lng?, timeZone? } -> get_detour_offers result + { pending: number }
//
// Offers sit only at public, walkable spots, which come from OpenFreeMap
// vector tiles. Postgres can't fetch them, so before reading the offers this
// function leases the spot areas within reach of the player's routes that the
// database hasn't loaded yet (claim_detour_areas, at most a few per call),
// downloads each area's tile, and passes its walkable features to
// ingest_detour_area, one area at a time (see areas.ts). It then calls
// get_detour_offers as the player, which fills the day's empty offer slots
// from the spots it knows. If fetching takes
// longer than WAIT_MS, it answers anyway and keeps fetching in the background.
// `pending` counts the areas still loading; call again later (about 20 s) and
// the empty slots fill. lat and lng are the device's position, used only for a
// player with no walks and no land. The rules live in *_detours.sql.

import { withSupabase } from 'npm:@supabase/server@1.9.2';
import { fetchTile } from '../_shared/openfreemap.ts';
import { type Admin, type LeasedArea, loadAreas } from './areas.ts';
import type { SpotRequest } from './spots.ts';

/** How long a request waits for fresh areas before answering. */
const WAIT_MS = 8_000;
/** Hard stop for one tile download; well below the database lease (60 s). */
const AREA_TIMEOUT_MS = 10_000;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function coordinate(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

Deno.serve(
  withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ message: 'Use POST' }, { status: 405 });
    }
    const body = await req.json().catch(() => ({}));
    const lat = coordinate(body?.lat, 85);
    const lng = coordinate(body?.lng, 180);
    const timeZone = typeof body?.timeZone === 'string' ? body.timeZone : null;

    const { data: claimed, error: claimError } = await ctx.supabaseAdmin.rpc('claim_detour_areas', {
      p_user: ctx.userClaims!.id,
      p_lat: lat,
      p_lng: lng,
    });
    if (claimError) {
      return Response.json({ message: claimError.message, code: claimError.code }, { status: 500 });
    }

    const rows = (claimed ?? []) as { area: number; request: SpotRequest | null }[];
    const mine = rows.filter((r): r is LeasedArea => r.request !== null);
    const busyElsewhere = rows.length - mine.length;
    let finished = 0;
    if (mine.length > 0) {
      // Tiles download together; the CPU-heavy ingests run one at a time.
      const admin = ctx.supabaseAdmin as unknown as Admin;
      const work = loadAreas(admin, mine, { fetchTile, timeoutMs: AREA_TIMEOUT_MS, onDone: () => finished++ });
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
      await Promise.race([work, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
    }

    const { data, error } = await ctx.supabase.rpc('get_detour_offers', {
      p_time_zone: timeZone,
      p_lat: lat,
      p_lng: lng,
    });
    if (error) {
      const status = error.code === '42501' ? 401 : 500;
      return Response.json({ message: error.message, code: error.code }, { status });
    }
    return Response.json({ ...(data as Record<string, unknown>), pending: busyElsewhere + mine.length - finished });
  }),
);
