// OpenFreeMap transport shared by the sites and terrain functions: finds the
// current tile set from the TileJSON and downloads vector tiles
// (OpenMapTiles schema). Holds no game rules.

/** Identifies the app to the tile server. No personal data. */
export const USER_AGENT = 'LocalLegendPrototype/0.1';

const DEFAULT_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
/** The TileJSON names the current, dated tile set; re-read it this often. */
const TILEJSON_TTL_MS = 6 * 60 * 60 * 1000;

let cachedTemplate: { url: string; at: number } | null = null;

/** The current tile URL template, from the TileJSON. Cached per worker. */
export async function tileTemplate(signal: AbortSignal, refresh = false): Promise<string> {
  if (!refresh && cachedTemplate && Date.now() - cachedTemplate.at < TILEJSON_TTL_MS) return cachedTemplate.url;
  const url = Deno.env.get('TILEJSON_URL') || DEFAULT_TILEJSON_URL;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`TileJSON: HTTP ${res.status}`);
  }
  const template = ((await res.json()) as { tiles?: unknown }).tiles;
  if (!Array.isArray(template) || typeof template[0] !== 'string' || !template[0].includes('{z}')) {
    throw new Error('TileJSON has no tile URL');
  }
  cachedTemplate = { url: template[0], at: Date.now() };
  return template[0];
}

/**
 * Downloads one vector tile. When the tile set named by a cached TileJSON is
 * gone (404 or 410), re-reads the TileJSON once. An empty 204 response is an
 * empty tile.
 */
export async function fetchTile(z: number, x: number, y: number, signal: AbortSignal): Promise<Uint8Array> {
  for (const refresh of [false, true]) {
    const template = await tileTemplate(signal, refresh);
    const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal });
    if (res.status === 204) return new Uint8Array();
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    await res.body?.cancel();
    if (!refresh && (res.status === 404 || res.status === 410)) continue;
    throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  }
  throw new Error('unreachable');
}
