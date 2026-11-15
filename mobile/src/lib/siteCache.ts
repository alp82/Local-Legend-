// In-memory cache of fetched sites, keyed by a coarse tile grid so panning back over an
// area doesn't refetch it. Pure (no React, no network) so it can be unit-tested.
import { lngLatToTileXY, tileXYToLngLat } from './geo';
import type { BBox, Site } from './sitesApi';

/** Cache tiles are Web Mercator tiles at this zoom: about 2.4 km wide at 0°, 1.7 km at 45°. */
export const GRID_ZOOM = 14;

export type TileKey = string;

const key = (x: number, y: number): TileKey => `${x}/${y}`;

/** Keys of the grid tiles that intersect `bbox`. */
export function tilesForBBox([w, s, e, n]: BBox, zoom = GRID_ZOOM): TileKey[] {
  const nw = lngLatToTileXY(w, n, zoom);
  const se = lngLatToTileXY(e, s, zoom);
  const max = 2 ** zoom - 1;
  const keys: TileKey[] = [];
  for (let x = Math.max(0, Math.floor(nw.x)); x <= Math.min(max, Math.floor(se.x)); x++) {
    for (let y = Math.max(0, Math.floor(nw.y)); y <= Math.min(max, Math.floor(se.y)); y++) keys.push(key(x, y));
  }
  return keys;
}

export function tileOf(lng: number, lat: number, zoom = GRID_ZOOM): TileKey {
  const t = lngLatToTileXY(lng, lat, zoom);
  return key(Math.floor(t.x), Math.floor(t.y));
}

/** Smallest box covering all the tiles. */
export function bboxOfTiles(keys: TileKey[], zoom = GRID_ZOOM): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const k of keys) {
    const [x, y] = k.split('/').map(Number);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + 1);
    y1 = Math.max(y1, y + 1);
  }
  const [w, n] = tileXYToLngLat(x0, y0, zoom);
  const [e, s] = tileXYToLngLat(x1, y1, zoom);
  return [w, s, e, n];
}

export class SiteCache {
  private tiles = new Map<TileKey, Site[]>();

  constructor(private readonly maxTiles = 400) {}

  /** Tiles in `bbox` that haven't been fetched yet. */
  missing(bbox: BBox): TileKey[] {
    return tilesForBBox(bbox).filter((k) => !this.tiles.has(k));
  }

  /**
   * Records the result of fetching the box around `keys`. Each site is filed under the
   * tile containing it; sites outside `keys` are dropped (their tiles are either cached
   * already or will be fetched on their own).
   */
  store(keys: TileKey[], sites: Site[]) {
    const fresh = new Map<TileKey, Site[]>(keys.map((k) => [k, []]));
    for (const site of sites) fresh.get(tileOf(site.lng, site.lat))?.push(site);
    for (const [k, list] of fresh) {
      this.tiles.delete(k);
      this.tiles.set(k, list);
    }
    // Map iteration is insertion order, so the first keys are the oldest.
    for (const k of this.tiles.keys()) {
      if (this.tiles.size <= this.maxTiles) break;
      this.tiles.delete(k);
    }
  }

  /** Every cached site, once each. */
  all(): Site[] {
    return [...this.tiles.values()].flat();
  }

  get size() {
    return this.tiles.size;
  }

  clear() {
    this.tiles.clear();
  }
}
