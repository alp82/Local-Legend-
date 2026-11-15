// Terrain classification for the terrain function: turns one zoom 14 vector
// tile (OpenMapTiles schema) into one terrain code per claim cell. Holds no
// game rules: the classes, their order, the features they match, and the
// distances come from the database (private.terrain_classes()).

import { VectorTile, type VectorTileFeature, type VectorTileLayer } from 'npm:@mapbox/vector-tile@3.0.0';
import { PbfReader } from 'npm:pbf@5.1.2';

/** What the database sends with each area, from private.terrain_filter(). */
export type TerrainRequest = {
  /** Zoom of the area grid; one vector tile per area. */
  zoom: number;
  /** Cells per side of the area: the claim cells (zoom 21) inside the tile. */
  grid: number;
  /** Code for a cell no class matches. */
  none_code: string;
  /** In priority order: a cell gets the first class that matches. */
  classes: TerrainClass[];
};

export type TerrainClass = {
  terrain: string;
  code: string;
  match: { key: string; vals: string[] | null; buffer_m: number }[];
  /** Also matches where buildings cover at least `min` of the square of `radius_m` around the cell. */
  building_cover?: { radius_m: number; min: number };
};

type TilePoint = { x: number; y: number };
type Layer = VectorTileLayer;

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;

/** A boolean raster over the area plus a margin, so buffers reach across the tile edge. */
class Mask {
  readonly bits: Uint8Array;
  constructor(readonly size: number, readonly margin: number) {
    this.bits = new Uint8Array(size * size);
  }
  /** Grid coordinates; (0, 0) is the area's north-west cell. */
  set(i: number, j: number) {
    const a = i + this.margin;
    const b = j + this.margin;
    if (a >= 0 && b >= 0 && a < this.size && b < this.size) this.bits[b * this.size + a] = 1;
  }
  get(i: number, j: number): boolean {
    return this.bits[(j + this.margin) * this.size + i + this.margin] === 1;
  }
}

/**
 * Classifies tile (x, y) at request.zoom. Returns request.grid² codes, row by
 * row from the north-west, the order public.ingest_terrain_area expects.
 */
export function classifyTile(data: Uint8Array, x: number, y: number, request: TerrainRequest): string {
  const tile = new VectorTile(new PbfReader(data));
  const g = request.grid;
  const n = 2 ** request.zoom;
  // Ground size of a cell at the tile's center latitude.
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  const cellM = (EARTH_CIRCUMFERENCE_M * Math.cos(lat)) / n / g;

  const maxBufferM = Math.max(0, ...request.classes.flatMap((c) => c.match.map((m) => m.buffer_m)));
  const margin = Math.ceil(maxBufferM / cellM) + 1;
  const size = g + 2 * margin;

  const classMasks = request.classes.map((cls) => {
    const mask = new Mask(size, margin);
    for (const m of cls.match) {
      const [layerName, field] = splitKey(m.key);
      const layer = tile.layers[layerName];
      if (!layer) continue;
      const vals = m.vals === null ? null : new Set(m.vals);
      const hit = new Mask(size, margin);
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const v = f.properties[field];
        if (v === undefined || v === null || (vals !== null && !vals.has(String(v)))) continue;
        rasterize(f, layer, g, hit);
      }
      dilateInto(hit, mask, m.buffer_m / cellM);
    }
    return mask;
  });

  const covers = request.classes.map((cls) =>
    cls.building_cover ? buildingCover(tile.layers.building, g, margin, size, cls.building_cover.radius_m / cellM) : null
  );

  let out = '';
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      let code = request.none_code;
      for (let c = 0; c < request.classes.length; c++) {
        const cls = request.classes[c];
        const cover = covers[c];
        if (classMasks[c].get(i, j) || (cover && cls.building_cover && cover(i, j) >= cls.building_cover.min)) {
          code = cls.code;
          break;
        }
      }
      out += code;
    }
  }
  return out;
}

function splitKey(key: string): [string, string] {
  const dot = key.indexOf('.');
  return [key.slice(0, dot), key.slice(dot + 1)];
}

/**
 * Marks the cells a feature covers: polygon cells whose center lies inside
 * (even-odd over all rings, so holes stay empty), every cell a line passes
 * through, and the cell of a point.
 */
function rasterize(f: VectorTileFeature, layer: Layer, g: number, mask: Mask) {
  const unit = layer.extent / g; // tile units per cell
  const rings = f.loadGeometry() as TilePoint[][];
  if (f.type === 1) {
    for (const ring of rings) for (const p of ring) mask.set(Math.floor(p.x / unit), Math.floor(p.y / unit));
  } else if (f.type === 2) {
    for (const line of rings) {
      for (let k = 1; k < line.length; k++) {
        const a = line[k - 1];
        const b = line[k];
        const steps = Math.max(1, Math.ceil((2 * Math.hypot(b.x - a.x, b.y - a.y)) / unit));
        for (let s = 0; s <= steps; s++) {
          mask.set(Math.floor((a.x + ((b.x - a.x) * s) / steps) / unit), Math.floor((a.y + ((b.y - a.y) * s) / steps) / unit));
        }
      }
    }
  } else if (f.type === 3) {
    fillPolygon(rings, unit, mask);
  }
}

/** Scanline fill at cell centers, over the area and its margin. */
function fillPolygon(rings: TilePoint[][], unit: number, mask: Mask) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) for (const p of ring) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const j0 = Math.max(-mask.margin, Math.ceil(minY / unit - 0.5));
  const j1 = Math.min(mask.size - mask.margin - 1, Math.floor(maxY / unit - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const cy = (j + 0.5) * unit;
    xs.length = 0;
    for (const ring of rings) {
      for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
        const a = ring[m];
        const b = ring[k];
        // Half-open, so a vertex on the scanline counts once.
        if ((a.y <= cy) !== (b.y <= cy)) xs.push(a.x + ((cy - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.ceil(xs[k] / unit - 0.5);
      const i1 = Math.floor(xs[k + 1] / unit - 0.5);
      for (let i = i0; i <= i1; i++) mask.set(i, j);
    }
  }
}

/** ORs into `out` every cell within `radius` cells (center to center) of a cell set in `src`. */
function dilateInto(src: Mask, out: Mask, radius: number) {
  const r = Math.floor(radius);
  const offsets: [number, number][] = [];
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) if (di * di + dj * dj <= radius * radius) offsets.push([di, dj]);
  const size = src.size;
  for (let b = 0; b < size; b++) {
    for (let a = 0; a < size; a++) {
      if (!src.bits[b * size + a]) continue;
      for (const [di, dj] of offsets) {
        const p = a + di;
        const q = b + dj;
        if (p >= 0 && q >= 0 && p < size && q < size) out.bits[q * size + p] = 1;
      }
    }
  }
}

/**
 * Share of cells inside building footprints in the square of `radius` cells
 * around each cell, from a summed-area table.
 */
function buildingCover(layer: Layer | undefined, g: number, margin: number, size: number, radius: number) {
  const inside = new Mask(size, margin);
  if (layer) {
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type === 3) fillPolygon(f.loadGeometry() as TilePoint[][], layer.extent / g, inside);
    }
  }
  const w = size + 1;
  const sat = new Uint32Array(w * w);
  for (let b = 0; b < size; b++) {
    for (let a = 0; a < size; a++) {
      sat[(b + 1) * w + a + 1] = inside.bits[b * size + a] + sat[b * w + a + 1] + sat[(b + 1) * w + a] - sat[b * w + a];
    }
  }
  const k = Math.max(0, Math.round(radius));
  return (i: number, j: number) => {
    const a0 = Math.max(0, i + margin - k);
    const b0 = Math.max(0, j + margin - k);
    const a1 = Math.min(size, i + margin + k + 1);
    const b1 = Math.min(size, j + margin + k + 1);
    const sum = sat[b1 * w + a1] - sat[b0 * w + a1] - sat[b1 * w + a0] + sat[b0 * w + a0];
    return sum / ((a1 - a0) * (b1 - b0));
  };
}
