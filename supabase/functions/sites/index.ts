// sites: returns the map sites the signed-in player may see in a box.
//
// POST { bbox: [west, south, east, north] } -> { sites: Site[], pending: number }
//
// Before reading, it fetches the areas near the player's land that the
// database hasn't cached yet (at most a few per call) as OpenFreeMap vector
// tiles and ingests them. A tile usually loads in well under a second. If
// fetching takes longer than WAIT_MS, it answers from the cache and keeps
// fetching in the background. `pending` counts the areas still being fetched,
// by this request or another one; call again later for them.
// Visibility rules live in public.get_sites; data rules in the sites migrations.

import { withSupabase } from 'npm:@supabase/server@1.9.2';
import { fetchTile, normalizeTile, type SourceFilter } from './openfreemap.ts';

/** How long a request waits for fresh areas before answering from the cache. */
const WAIT_MS = 8_000;
/** Hard stop for one tile download; stays below the database lease (30 s). */
const AREA_TIMEOUT_MS = 10_000;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

type Admin = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

function parseBBox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return value as [number, number, number, number];
}

async function ingestArea(admin: Admin, area: number, source: SourceFilter): Promise<void> {
  const started = Date.now();
  try {
    const n = 2 ** source.zoom;
    const x = Math.floor(area / n);
    const y = area % n;
    const tile = await fetchTile(source.zoom, x, y, AbortSignal.timeout(AREA_TIMEOUT_MS));
    const fetchedMs = Date.now() - started;
    const payload = normalizeTile(tile, x, y, source);
    const { data, error } = await admin.rpc('ingest_site_area', { p_area: area, p_data: payload });
    if (error) throw new Error(`ingest: ${error.message}`);
    console.log(JSON.stringify({
      area,
      tile: `${source.zoom}/${x}/${y}`,
      bytes: tile.byteLength,
      fetchMs: fetchedMs,
      ms: Date.now() - started,
      elements: payload.elements.length,
      result: data,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ area, ms: Date.now() - started, error: message }));
    await admin.rpc('fail_site_area', { p_area: area, p_error: message });
  }
}

Deno.serve(
  withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ message: 'Use POST' }, { status: 405 });
    }
    const body = await req.json().catch(() => null);
    const bbox = parseBBox(body?.bbox);
    if (!bbox) {
      return Response.json({ message: 'bbox must be [west, south, east, north]', code: '22023' }, { status: 400 });
    }
    const [west, south, east, north] = bbox;

    const { data: claimed, error: claimError } = await ctx.supabaseAdmin.rpc('claim_site_areas', {
      p_user: ctx.userClaims!.id,
      west,
      south,
      east,
      north,
    });
    if (claimError) {
      const status = claimError.code === '22023' ? 400 : 500;
      return Response.json({ message: claimError.message, code: claimError.code }, { status });
    }

    const rows = (claimed ?? []) as { area: number; source: SourceFilter | null }[];
    const areas = rows.filter((r): r is { area: number; source: SourceFilter } => r.source !== null);
    const busyElsewhere = rows.length - areas.length;
    const done = new Set<number>();
    if (areas.length > 0) {
      // The tiles come from a CDN, so the areas load in parallel.
      const admin = ctx.supabaseAdmin as unknown as Admin;
      const work = Promise.all(areas.map(({ area, source }) => ingestArea(admin, area, source).then(() => done.add(area))));
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
      await Promise.race([work, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
    }

    const { data: sites, error } = await ctx.supabase.rpc('get_sites', { west, south, east, north });
    if (error) {
      const status = error.code === '22023' ? 400 : error.code === '42501' ? 401 : 500;
      return Response.json({ message: error.message, code: error.code }, { status });
    }
    return Response.json({ sites: sites ?? [], pending: busyElsewhere + areas.length - done.size });
  }),
);
