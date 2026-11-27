// Deployed by the deploy pipeline on merge (docs/deploy.md, Edge Functions).
// terrain: classifies the terrain of the areas where the signed-in player has
// walking pay waiting for it, and stores it, which pays the waiting terrain
// resources.
//
// POST {} -> { classified: number, pending: number }
//
// Postgres pays walking in the same transaction that claims land, but it
// can't fetch map data. When a walk pays on cells whose terrain isn't known,
// the gold and XP pay at once and the terrain resources wait in
// terrain_pending. This function leases those areas (claim_terrain_areas),
// downloads each area's OpenFreeMap vector tile, classifies every claim cell,
// and calls ingest_terrain_area, which stores the result and pays. `pending`
// counts the areas still loading, by this request or another one; call again
// later for them. The classification rules live in private.terrain_classes().

import { withSupabase } from 'npm:@supabase/server@1.9.2';
import { fetchTile } from '../_shared/openfreemap.ts';
import { classifyTile, type TerrainRequest } from './classify.ts';

/** How long a request waits for its areas before answering. */
const WAIT_MS = 8_000;
/** Hard stop for one tile download; stays below the database lease (30 s). */
const AREA_TIMEOUT_MS = 10_000;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

type Admin = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

async function classifyArea(admin: Admin, area: number, request: TerrainRequest): Promise<boolean> {
  const started = Date.now();
  try {
    const n = 2 ** request.zoom;
    const x = Math.floor(area / n);
    const y = area % n;
    const tile = await fetchTile(request.zoom, x, y, AbortSignal.timeout(AREA_TIMEOUT_MS));
    const fetchMs = Date.now() - started;
    const grid = classifyTile(tile, x, y, request);
    const { data, error } = await admin.rpc('ingest_terrain_area', { p_area: area, p_grid: grid });
    if (error) throw new Error(`ingest: ${error.message}`);
    console.log(JSON.stringify({ area, tile: `${request.zoom}/${x}/${y}`, bytes: tile.byteLength, fetchMs, ms: Date.now() - started, result: data }));
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ area, ms: Date.now() - started, error: message }));
    await admin.rpc('fail_terrain_area', { p_area: area, p_error: message });
    return false;
  }
}

Deno.serve(
  withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ message: 'Use POST' }, { status: 405 });
    }

    const { data, error } = await ctx.supabaseAdmin.rpc('claim_terrain_areas', { p_user: ctx.userClaims!.id });
    if (error) {
      return Response.json({ message: error.message, code: error.code }, { status: 500 });
    }

    const rows = (data ?? []) as { area: number; request: TerrainRequest | null }[];
    const mine = rows.filter((r): r is { area: number; request: TerrainRequest } => r.request !== null);
    const busyElsewhere = rows.length - mine.length;
    let classified = 0;
    let finished = 0;
    if (mine.length > 0) {
      // The tiles come from a CDN, so the areas load in parallel.
      const admin = ctx.supabaseAdmin as unknown as Admin;
      const work = Promise.all(mine.map(({ area, request }) =>
        classifyArea(admin, area, request).then((ok) => {
          finished++;
          if (ok) classified++;
        })
      ));
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
      await Promise.race([work, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
    }

    return Response.json({ classified, pending: busyElsewhere + mine.length - finished });
  }),
);
