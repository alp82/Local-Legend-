// Pure geometry helpers for the Mist (fog of war), reveal effect and gap detection.
import type { BBox } from './sitesApi';
import type { TerritoryGeoJSON } from './territoryApi';

export type Position = [number, number];
type Ring = Position[];
type PolygonCoords = Ring[];

/** Web Mercator stops at ±85.0511°, so this ring covers the whole visible world. Counterclockwise. */
const WORLD_RING: Ring = [
  [-180, -85.0511],
  [180, -85.0511],
  [180, 85.0511],
  [-180, 85.0511],
  [-180, -85.0511],
];

/** Shoelace area in degree² space; positive when counterclockwise (x = lng, y = lat). */
export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1]);
  }
  return sum / 2;
}

/** Returns the ring wound counterclockwise (`ccw`) or clockwise, closed. */
function orient(ring: Ring, ccw: boolean): Ring {
  const closed = ring.length > 0 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const r = closed ? ring : [...ring, ring[0]];
  return signedArea(r) > 0 === ccw ? r : [...r].reverse();
}

/** Flattens Polygon and MultiPolygon features to a list of polygons (rings of [lng, lat]). */
export function polygonsOf(fc: TerritoryGeoJSON | null | undefined): PolygonCoords[] {
  const out: PolygonCoords[] = [];
  for (const f of fc?.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') out.push(g.coordinates as PolygonCoords);
    else if (g.type === 'MultiPolygon') out.push(...(g.coordinates as PolygonCoords[]));
  }
  return out.filter((p) => p.length > 0 && p[0].length >= 4);
}

/**
 * The Mist: one world-covering polygon with every claimed polygon's outer ring cut out
 * as a hole, plus any unclaimed enclaves (inner rings of claimed land) as fog islands.
 * Winding follows RFC 7946 (outer CCW, holes CW), which MapLibre uses to tell holes from
 * new polygons. Assumes claimed polygons don't overlap each other (the backend unions them).
 */
export function buildFog(claimed: TerritoryGeoJSON | null | undefined): GeoJSON.FeatureCollection {
  const holes: Ring[] = [];
  const islands: PolygonCoords[] = [];
  for (const poly of polygonsOf(claimed)) {
    holes.push(orient(poly[0], false));
    for (const inner of poly.slice(1)) islands.push([orient(inner, true)]);
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiPolygon', coordinates: [[WORLD_RING, ...holes], ...islands] },
      },
    ],
  };
}

function ringKey(ring: Ring): string {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [ring.length, minX, minY, maxX, maxY].map((n) => n.toFixed(7)).join(',');
}

function pointInRing([x, y]: Position, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Land that is claimed in `next` but wasn't in `prev`, for the reveal fade: each new or
 * changed claimed polygon, with the previously claimed polygons inside it cut out.
 * Unchanged polygons (same vertex count and bounding box) are skipped. Empty when `prev`
 * is null (first load shows the map as-is).
 */
export function revealArea(
  prev: TerritoryGeoJSON | null | undefined,
  next: TerritoryGeoJSON | null | undefined,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (prev) {
    const prevOuters = polygonsOf(prev).map((p) => p[0]);
    const prevKeys = new Set(prevOuters.map(ringKey));
    for (const poly of polygonsOf(next)) {
      const outer = poly[0];
      if (prevKeys.has(ringKey(outer))) continue;
      const holes = prevOuters.filter((r) => pointInRing(r[0], outer)).map((r) => orient(r, false));
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [orient(outer, true), ...holes] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Great-circle distance in meters. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

export type Fix = { t: number; lat: number; lng: number };
export type Gap = { fromT: number; toT: number; distanceM: number };

/** Pairs of consecutive fixes (sorted by time) more than `thresholdMs` apart. */
export function findGaps(fixes: Fix[], thresholdMs: number): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1];
    const b = fixes[i];
    if (b.t - a.t > thresholdMs) gaps.push({ fromT: a.t, toT: b.t, distanceM: Math.round(distanceM(a, b)) });
  }
  return gaps;
}

/** Upload retry delay after `failures` consecutive failures: 30 s, 1, 2, 4 … capped at 15 min. */
export function retryDelayMs(failures: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, failures - 1), 15 * 60_000);
}

// ---------------------------------------------------------------------------
// Cells: square Web Mercator tiles at zoom 21, the backend's claim grid
// (supabase/migrations/*_territory.sql). x grows east, y grows south, and
// cell id = x * 2^21 + y.
// ---------------------------------------------------------------------------

export const CELL_ZOOM = 21;
const CELLS = 2 ** CELL_ZOOM;
const MAX_LAT = 85.0511287798066;

/** Tile containing a point at `zoom` (fractional coordinates, not floored). */
export function lngLatToTileXY(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  };
}

/** Longitude/latitude of tile coordinates at `zoom` (the tile's north-west corner for integers). */
export function tileXYToLngLat(x: number, y: number, zoom: number): Position {
  const n = 2 ** zoom;
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
}

/** The zoom-21 cell containing a point. */
export function cellXY(lng: number, lat: number): { x: number; y: number } {
  const t = lngLatToTileXY(lng, lat, CELL_ZOOM);
  return {
    x: Math.min(CELLS - 1, Math.max(0, Math.floor(t.x))),
    y: Math.min(CELLS - 1, Math.max(0, Math.floor(t.y))),
  };
}

export function cellId(x: number, y: number): number {
  return x * CELLS + y;
}

export function cellFromId(id: number): { x: number; y: number } {
  return { x: Math.floor(id / CELLS), y: id % CELLS };
}

/** Cell edge length on the ground, in meters, at a latitude. */
export function cellSizeM(lat: number): number {
  return (40075016.68557849 / CELLS) * Math.cos((lat * Math.PI) / 180);
}

/** Expands a box by `fraction` of its width and height on each side. */
export function padBBox([w, s, e, n]: BBox, fraction: number): BBox {
  const dx = (e - w) * fraction;
  const dy = (n - s) * fraction;
  return [w - dx, Math.max(-MAX_LAT, s - dy), e + dx, Math.min(MAX_LAT, n + dy)];
}

/**
 * Outlines of the zoom-21 cells covering `bbox`, as one MultiLineString of grid lines
 * running along cell edges. Null when it would need more than `maxLines` lines (zoomed
 * out too far to be useful).
 */
export function cellGridLines(bbox: BBox, maxLines = 400): GeoJSON.FeatureCollection | null {
  const [w, s, e, n] = bbox;
  const nw = lngLatToTileXY(w, n, CELL_ZOOM);
  const se = lngLatToTileXY(e, s, CELL_ZOOM);
  const x0 = Math.floor(nw.x);
  const x1 = Math.ceil(se.x);
  const y0 = Math.floor(nw.y);
  const y1 = Math.ceil(se.y);
  if (x1 - x0 + (y1 - y0) + 2 > maxLines) return null;
  const west = tileXYToLngLat(x0, 0, CELL_ZOOM)[0];
  const east = tileXYToLngLat(x1, 0, CELL_ZOOM)[0];
  const north = tileXYToLngLat(0, y0, CELL_ZOOM)[1];
  const south = tileXYToLngLat(0, y1, CELL_ZOOM)[1];
  const lines: Position[][] = [];
  for (let x = x0; x <= x1; x++) {
    const lng = tileXYToLngLat(x, 0, CELL_ZOOM)[0];
    lines.push([
      [lng, south],
      [lng, north],
    ]);
  }
  for (let y = y0; y <= y1; y++) {
    const lat = tileXYToLngLat(0, y, CELL_ZOOM)[1];
    lines.push([
      [west, lat],
      [east, lat],
    ]);
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }],
  };
}

/** Polygon, ring and vertex counts, for the perf readout. */
export function geometryStats(fc: TerritoryGeoJSON | null | undefined): { polygons: number; rings: number; vertices: number } {
  let rings = 0;
  let vertices = 0;
  const polygons = polygonsOf(fc);
  for (const p of polygons) {
    rings += p.length;
    for (const r of p) vertices += r.length;
  }
  return { polygons: polygons.length, rings, vertices };
}
