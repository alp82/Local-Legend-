// Which Legend map tiles a view needs, and where they live. Pure functions.
// Server side: supabase/legend-map-renderer (painting) and
// supabase/migrations/*_fantasy_tiles.sql (the queue).
import { lngLatToTileXY } from './geo';
import type { BBox } from './sitesApi';

export type TileZXY = [z: number, x: number, y: number];

/** Tile zooms the renderer paints; MapLibre shows z15 tiles below map zoom 15.5. */
export const LEGEND_MAP_MIN_ZOOM = 14.5;
const Z16_FROM = 15.5;
/** Tiles per request, the server's max_tiles_per_call. */
export const MAX_TILES_PER_REQUEST = 64;

/** The raster tile URL template for a tile version in the public bucket. */
export function legendMapTileUrl(supabaseUrl: string, bucket: string, version: number): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/v${version}/{z}/{x}/{y}.webp`;
}

/** The tile zoom MapLibre loads for a raster source with 512 px tiles at this map zoom. */
export function tileZoomFor(zoom: number): 15 | 16 {
  return zoom < Z16_FROM ? 15 : 16;
}

/**
 * The tiles a view needs: the visible ones first, nearest the centre first, then a ring of
 * `ring` tiles around them. Returns at most MAX_TILES_PER_REQUEST tiles and how many of
 * them are visible. Below LEGEND_MAP_MIN_ZOOM there is nothing to request.
 */
export function tilesForView(bounds: BBox, zoom: number, ring = 1): { tiles: TileZXY[]; visible: number } {
  if (zoom < LEGEND_MAP_MIN_ZOOM) return { tiles: [], visible: 0 };
  const z = tileZoomFor(zoom);
  const n = 2 ** z;
  const [w, s, e, nn] = bounds;
  const a = lngLatToTileXY(w, nn, z);
  const b = lngLatToTileXY(e, s, z);
  const x0 = Math.floor(a.x), y0 = Math.floor(a.y), x1 = Math.floor(b.x), y1 = Math.floor(b.y);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const byDistance = (list: TileZXY[]) =>
    list.sort((p, q) => Math.hypot(p[1] + 0.5 - cx, p[2] + 0.5 - cy) - Math.hypot(q[1] + 0.5 - cx, q[2] + 0.5 - cy));
  const visible: TileZXY[] = [];
  const around: TileZXY[] = [];
  for (let x = x0 - ring; x <= x1 + ring; x++) {
    for (let y = y0 - ring; y <= y1 + ring; y++) {
      if (y < 0 || y >= n) continue;
      const t: TileZXY = [z, ((x % n) + n) % n, y];
      (x >= x0 && x <= x1 && y >= y0 && y <= y1 ? visible : around).push(t);
    }
  }
  const tiles = [...byDistance(visible), ...byDistance(around)].slice(0, MAX_TILES_PER_REQUEST);
  return { tiles, visible: Math.min(visible.length, tiles.length) };
}

export const tileKey = ([z, x, y]: TileZXY) => `${z}/${x}/${y}`;

/** A live label from a tile's label file: a road or water name the painter placed. */
export type LegendMapLabel = { name: string; lng: number; lat: number; rot: number; water: 0 | 1 };

/** The label file next to a tile: <tile>.json in the same version folder. */
export function legendMapLabelUrl(tileUrl: string, [z, x, y]: TileZXY): string {
  return tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace(/\.webp$/, '.json');
}

/** The labels of some tiles as one GeoJSON string; a label two files share is kept once. */
export function labelsGeoJSON(files: LegendMapLabel[][]): string {
  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const file of files) {
    for (const l of file) {
      const key = `${l.name}|${l.lng}|${l.lat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({
        type: 'Feature',
        properties: { name: l.name, rot: l.rot, water: l.water },
        geometry: { type: 'Point', coordinates: [l.lng, l.lat] },
      });
    }
  }
  return JSON.stringify({ type: 'FeatureCollection', features });
}

/**
 * How long to keep asking while tiles on screen are being painted but none of the requested
 * tiles gets painted. A pan queues more tiles than the one painter finishes in a few minutes
 * (about 10 s each), and a player's tiles are painted in the order they were asked for, so
 * the limit restarts with every painted tile instead of running from the first poll.
 */
export const STALL_LIMIT_MS = 300_000;
const POLL_STEPS_MS = [1500, 3000, 6000, 10_000, 15_000];

/** Polling for one set of tiles: polls so far, the last time a requested tile got painted, and how many were pending then. */
export type PollState = { attempt: number; since: number; pending: number };

/**
 * When to ask again: only while tiles on screen are being painted, backing off 1.5, 3, 6, 10
 * up to 15 s, until STALL_LIMIT_MS pass without the requested tiles' `pending` count going
 * down. The caller starts a new PollState (null) only when the set of tiles changes, never on
 * a mere camera move. Returns the delay (null: stop) and the state to keep.
 */
export function nextPoll(
  state: PollState | null,
  now: number,
  onScreenPending: boolean,
  pending: number,
): { delayMs: number | null; state: PollState | null } {
  if (!onScreenPending) return { delayMs: null, state: null };
  const s = !state ? { attempt: 0, since: now, pending } : pending < state.pending ? { ...state, since: now, pending } : state;
  if (now - s.since >= STALL_LIMIT_MS) return { delayMs: null, state: s };
  const delayMs = POLL_STEPS_MS[Math.min(s.attempt, POLL_STEPS_MS.length - 1)];
  return { delayMs, state: { ...s, attempt: s.attempt + 1 } };
}

/** An order-free key for the tiles a view needs: the same set gives the same key. */
export function tileSetKey(tiles: TileZXY[], visible: number): string {
  const sorted = (list: TileZXY[]) => list.map(tileKey).sort().join(',');
  return `${sorted(tiles.slice(0, visible))}|${sorted(tiles.slice(visible))}`;
}

/** The tiles of a tileSetKey: the visible ones first. */
export function tilesOfSetKey(key: string): { tiles: TileZXY[]; visible: number } {
  const [vis, around] = key.split('|').map((part) => (part ? part.split(',').map((k) => k.split('/').map(Number) as TileZXY) : []));
  return { tiles: [...vis, ...around], visible: vis.length };
}
