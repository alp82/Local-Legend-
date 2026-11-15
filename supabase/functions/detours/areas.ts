// Loads leased spot areas for the detours function: downloads their tiles
// together, then ingests them one at a time.
//
// ingest_detour_area is CPU-heavy (polygon unions and point tests over a
// whole zoom 14 tile, a few seconds on the hosted database). Several at once
// starve the database: on November 15, 2026, eight parallel ingests of Kassel
// tiles pushed them and the player's own reads (get_detour_offers, get_sites)
// past the 8 s statement timeout. The downloads come from a CDN and cost the
// database nothing, so only the ingests wait for each other.

import { spotFeatures, type SpotRequest } from './spots.ts';

export type Admin = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

export type LeasedArea = { area: number; request: SpotRequest };

type Download = { tile: Uint8Array; fetchMs: number } | { error: string; fetchMs: number };

type FetchTile = (z: number, x: number, y: number, signal: AbortSignal) => Promise<Uint8Array>;

/** The tile column and row of an area id (x * 2^zoom + y). */
export function areaTile(area: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  return { x: Math.floor(area / n), y: area % n };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function download(fetchTile: FetchTile, { area, request }: LeasedArea, timeoutMs: number): Promise<Download> {
  const started = Date.now();
  try {
    const { x, y } = areaTile(area, request.zoom);
    const tile = await fetchTile(request.zoom, x, y, AbortSignal.timeout(timeoutMs));
    return { tile, fetchMs: Date.now() - started };
  } catch (err) {
    return { error: message(err), fetchMs: Date.now() - started };
  }
}

async function ingest(admin: Admin, { area, request }: LeasedArea, got: Download): Promise<void> {
  const started = Date.now();
  try {
    if ('error' in got) throw new Error(got.error);
    const { x, y } = areaTile(area, request.zoom);
    const payload = spotFeatures(got.tile, x, y, request);
    const { data, error } = await admin.rpc('ingest_detour_area', { p_area: area, p_data: payload });
    if (error) throw new Error(`ingest: ${error.message}`);
    console.log(JSON.stringify({
      area,
      tile: `${request.zoom}/${x}/${y}`,
      bytes: got.tile.byteLength,
      fetchMs: got.fetchMs,
      ingestMs: Date.now() - started,
      features: payload.features.length,
      result: data,
    }));
  } catch (err) {
    console.error(JSON.stringify({ area, fetchMs: got.fetchMs, ingestMs: Date.now() - started, error: message(err) }));
    await admin.rpc('fail_detour_area', { p_area: area, p_error: message(err) });
  }
}

/**
 * Downloads every area's tile at once, then ingests the areas one after
 * another in the given order (nearest first). A failed download or ingest
 * releases that area's lease with fail_detour_area and doesn't stop the rest.
 * onDone runs after each area, failed or not.
 */
export async function loadAreas(
  admin: Admin,
  areas: LeasedArea[],
  options: { fetchTile: FetchTile; timeoutMs: number; onDone?: (area: number) => void },
): Promise<void> {
  const downloads = areas.map((a) => download(options.fetchTile, a, options.timeoutMs));
  for (const [i, a] of areas.entries()) {
    await ingest(admin, a, await downloads[i]);
    options.onDone?.(a.area);
  }
}
