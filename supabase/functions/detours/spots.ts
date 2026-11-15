// Vector tile decoding for the detours function: turns one zoom 14
// OpenFreeMap tile (OpenMapTiles schema) into the features
// public.ingest_detour_area builds detour spots from. The download lives in
// ../_shared/openfreemap.ts.
// Holds no game rules: which features to forward comes from the database
// (private.detour_spot_filter), and what counts as a public, walkable spot is
// decided in public.ingest_detour_area.

import { VectorTile } from 'npm:@mapbox/vector-tile@3.0.0';
import { PbfReader } from 'npm:pbf@5.1.2';

/** Which features to forward, from private.detour_spot_filter(). */
export type SpotRequest = {
  /** Zoom of the area grid; one vector tile per area. */
  zoom: number;
  /** Forward a feature if any "<layer>.<field>" property matches; vals null means any value. */
  keys: { key: string; vals: string[] | null }[];
};

type LonLat = [number, number];

/** One feature in the shape ingest_detour_area expects. */
export type SpotFeature = {
  /** Every property as "<layer>.<field>", plus name and name:en. */
  tags: Record<string, string>;
  type: 'point' | 'line' | 'polygon';
  /** Point for points; MultiLineString of lines, or of polygon rings. */
  geometry: { type: 'Point'; coordinates: LonLat } | { type: 'MultiLineString'; coordinates: LonLat[][] };
};

export type SpotPayload = { features: SpotFeature[] };

type TilePoint = { x: number; y: number };

/** Decodes one tile into the features the request names, with full geometry. */
export function spotFeatures(data: Uint8Array, x: number, y: number, request: SpotRequest): SpotPayload {
  const tile = new VectorTile(new PbfReader(data));
  const n = 2 ** request.zoom;

  const toLonLat = (p: TilePoint, extent: number): LonLat => {
    const lon = ((x + p.x / extent) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + p.y / extent)) / n))) * 180) / Math.PI;
    return [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
  };

  const wanted = new Map<string, Set<string> | null>();
  for (const { key, vals } of request.keys) {
    const prev = wanted.get(key);
    wanted.set(key, prev === null || vals === null ? null : new Set([...(prev ?? []), ...vals]));
  }
  const layers = [...new Set(request.keys.map((k) => k.key.split('.')[0]))].sort();

  const features: SpotFeature[] = [];
  for (const layerName of layers) {
    const layer = tile.layers[layerName];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const tags: Record<string, string> = {};
      let keep = false;
      for (const [k, v] of Object.entries(f.properties)) {
        if (v === undefined || v === null) continue;
        const value = String(v);
        if (k === 'name' || k === 'name:en') {
          tags[k] = value;
          continue;
        }
        if (k.startsWith('name')) continue;
        const key = `${layerName}.${k}`;
        tags[key] = value;
        const vals = wanted.get(key);
        if (vals === null || vals?.has(value)) keep = true;
      }
      if (!keep) continue;

      const parts = f.loadGeometry() as TilePoint[][];
      if (f.type === 1) {
        for (const part of parts) {
          for (const p of part) features.push({ tags, type: 'point', geometry: { type: 'Point', coordinates: toLonLat(p, layer.extent) } });
        }
      } else if (f.type === 2 || f.type === 3) {
        const min = f.type === 2 ? 2 : 4;
        const lines = parts.filter((r) => r.length >= min).map((r) => r.map((p) => toLonLat(p, layer.extent)));
        if (lines.length === 0) continue;
        features.push({ tags, type: f.type === 2 ? 'line' : 'polygon', geometry: { type: 'MultiLineString', coordinates: lines } });
      }
    }
  }
  return { features };
}
