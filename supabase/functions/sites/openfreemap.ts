// OpenFreeMap decoding for the sites function: turns one zoom 14 vector tile
// (OpenMapTiles schema) per area into the ingest payload. The download lives
// in ../_shared/openfreemap.ts.
// Holds no game rules: which features to keep comes from the database
// (private.source_filter), and filtering and classification happen in
// public.ingest_site_area.

import { VectorTile, type VectorTileFeature } from 'npm:@mapbox/vector-tile@3.0.0';
import { PbfReader } from 'npm:pbf@5.1.2';

// The download side is shared with the terrain function.
export { fetchTile, tileTemplate, USER_AGENT } from '../_shared/openfreemap.ts';

/** Which features to keep, from private.source_filter(). */
export type SourceFilter = {
  /** Zoom of the area grid; one vector tile per area. */
  zoom: number;
  /** Building cover is measured on a grid of grid x grid cells per area. */
  grid: number;
  /** Keep a feature if any "<layer>.<field>" property matches; vals null means any value. */
  keys: { key: string; vals: string[] | null }[];
};

/** One map object in the shape ingest_site_area expects. */
export type SiteElement = {
  /** "node/123", "way/456", "relation/789", or "hash/<16 hex>" when the tile has no OSM id. */
  id: string;
  /** "<layer>.<field>" properties, plus name and name:en. */
  tags: Record<string, string>;
  /** Point position, if the object has one (POI, or a point on a line). */
  lat?: number;
  lon?: number;
  /** Polygon rings as lines, [lon, lat]; the database assembles the polygon. */
  geometry?: { type: 'MultiLineString'; coordinates: [number, number][][] };
};

export type IngestPayload = {
  elements: SiteElement[];
  /** Share of each grid cell covered by buildings, 0 to 1, row-major from the north-west. */
  building_cover: number[];
};

type TilePoint = { x: number; y: number };

/**
 * The OSM id of a feature. OpenFreeMap (Planetiler) encodes it as
 * osm_id * 10 + type, with type 1 node, 2 way, 3 relation.
 */
export function osmId(id: number | undefined): string | null {
  if (id === undefined || !Number.isSafeInteger(id) || id < 10) return null;
  const type = ['', 'node', 'way', 'relation'][id % 10];
  return type ? `${type}/${Math.floor(id / 10)}` : null;
}

/** FNV-1a, 64 bit, as 16 hex digits. */
function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * The element id: the OSM id, or else a hash of the layer, class, subclass,
 * name, and first vertex, which is stable for the same tile.
 */
export function featureId(id: number | undefined, layer: string, tags: Record<string, string>, first: TilePoint): string {
  return osmId(id) ??
    `hash/${fnv64([layer, tags[`${layer}.class`], tags[`${layer}.subclass`], tags.name, first.x, first.y].join('|'))}`;
}

/**
 * Normalizes one decoded tile. Features that share an OSM id across layers,
 * such as a park POI and its landcover polygon, become one element with both
 * tag sets, the POI point, and the first polygon.
 */
export function normalizeTile(data: Uint8Array, x: number, y: number, filter: SourceFilter): IngestPayload {
  const tile = new VectorTile(new PbfReader(data));
  const n = 2 ** filter.zoom;

  const toLonLat = (p: TilePoint, extent: number): [number, number] => {
    const lon = ((x + p.x / extent) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + p.y / extent)) / n))) * 180) / Math.PI;
    return [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
  };

  const wanted = new Map<string, Set<string> | null>();
  for (const { key, vals } of filter.keys) {
    const prev = wanted.get(key);
    wanted.set(key, prev === null || vals === null ? null : new Set([...(prev ?? []), ...vals]));
  }
  const layers = [...new Set(filter.keys.map((k) => k.key.split('.')[0]))].sort();

  const byId = new Map<string, SiteElement>();
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

      const rings = f.loadGeometry() as TilePoint[][];
      if (rings.length === 0 || rings[0].length === 0) continue;
      const id = featureId(f.id, layerName, tags, rings[0][0]);

      const el = byId.get(id) ?? { id, tags: {} };
      el.tags = { ...el.tags, ...tags };
      if (f.type === 1 && el.lat === undefined) {
        [el.lon, el.lat] = toLonLat(rings[0][0], layer.extent);
      } else if (f.type === 2 && el.lat === undefined) {
        // A point on the line: its middle vertex.
        [el.lon, el.lat] = toLonLat(rings[0][Math.floor(rings[0].length / 2)], layer.extent);
      } else if (f.type === 3 && !el.geometry) {
        const lines = rings.filter((r) => r.length >= 4).map((r) => r.map((p) => toLonLat(p, layer.extent)));
        if (lines.length > 0) el.geometry = { type: 'MultiLineString', coordinates: lines };
      }
      if (el.lat !== undefined || el.geometry) byId.set(id, el);
    }
  }

  const elements = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { elements, building_cover: buildingCover(tile.layers.building?.length ? tile.layers.building : null, filter.grid) };
}

/**
 * Footprint share per grid cell. Each ring counts in the cell holding its
 * vertex average; in tile coordinates outer rings have positive area and
 * holes negative, so holes subtract.
 */
function buildingCover(layer: { length: number; extent: number; feature(i: number): VectorTileFeature } | null, grid: number) {
  const area = new Array<number>(grid * grid).fill(0);
  if (layer) {
    const cell = layer.extent / grid;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== 3) continue;
      for (const ring of f.loadGeometry() as TilePoint[][]) {
        let a = 0, cx = 0, cy = 0;
        for (let j = 0; j < ring.length - 1; j++) {
          a += ring[j].x * ring[j + 1].y - ring[j + 1].x * ring[j].y;
          cx += ring[j].x;
          cy += ring[j].y;
        }
        const pts = ring.length - 1;
        if (pts < 3) continue;
        cx /= pts;
        cy /= pts;
        if (cx < 0 || cy < 0 || cx >= layer.extent || cy >= layer.extent) continue;
        area[Math.floor(cy / cell) * grid + Math.floor(cx / cell)] += a / 2;
      }
    }
    for (let i = 0; i < area.length; i++) {
      area[i] = Math.round(Math.min(Math.max(area[i] / (cell * cell), 0), 1) * 1e4) / 1e4;
    }
  }
  return area;
}
