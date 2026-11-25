// Which fantasy map tiles a view needs, and where they live. Pure functions.
// Server side: supabase/fantasy-renderer (painting) and
// supabase/migrations/*_fantasy_tiles.sql (the queue).
import { lngLatToTileXY } from './geo';
import type { BBox } from './sitesApi';

export type TileZXY = [z: number, x: number, y: number];

/** Tile zooms the renderer paints; MapLibre shows z15 tiles below map zoom 15.5. */
export const FANTASY_MIN_ZOOM = 14.5;
const Z16_FROM = 15.5;
/** Tiles per request, the server's max_tiles_per_call. */
export const MAX_TILES_PER_REQUEST = 64;

/** The raster tile URL template for a tile version in the public bucket. */
export function fantasyTileUrl(supabaseUrl: string, bucket: string, version: number): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/v${version}/{z}/{x}/{y}.webp`;
}

/** The tile zoom MapLibre loads for a raster source with 512 px tiles at this map zoom. */
export function tileZoomFor(zoom: number): 15 | 16 {
  return zoom < Z16_FROM ? 15 : 16;
}

/**
 * The tiles a view needs: the visible ones first, nearest the centre first, then a ring of
 * `ring` tiles around them. Returns at most MAX_TILES_PER_REQUEST tiles and how many of
 * them are visible. Below FANTASY_MIN_ZOOM there is nothing to request.
 */
export function tilesForView(bounds: BBox, zoom: number, ring = 1): { tiles: TileZXY[]; visible: number } {
  if (zoom < FANTASY_MIN_ZOOM) return { tiles: [], visible: 0 };
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
