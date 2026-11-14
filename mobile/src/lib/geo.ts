// Pure geometry helpers for the Mist (fog of war), reveal effect and gap detection.
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
