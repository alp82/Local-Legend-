// Synthetic territory and sites for the "Fake territory (50 km²)" debug toggle, to test
// map performance with a large realm. The land is made the way real land is: random
// walks claim the zoom-21 cells within 30 m of their path, then the cells are merged into
// polygons with holes, like get_territory's ST_Union output.
import { cellSizeM, cellXY, CELL_ZOOM, tileXYToLngLat, type Position } from './geo';
import type { Site } from './sitesApi';
import type { Territory, TerritoryGeoJSON } from './territoryApi';
import { SITE_TYPES } from './siteTypes';

/** A block of zoom-21 cells; `claimed[j * w + i]` is cell (x0 + i, y0 + j). */
export type CellGrid = { x0: number; y0: number; w: number; h: number; claimed: Uint8Array };

/** Small deterministic PRNG (mulberry32) so the fake realm is the same every time. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FakeOptions = {
  center: { lat: number; lng: number };
  /** Claimed area to reach, km². */
  targetKm2?: number;
  /** Walks stay within this distance of the center, meters. */
  radiusM?: number;
  seed?: number;
};

/** Claims cells along random walks until the target area is reached. */
export function fakeCells({ center, targetKm2 = 50, radiusM = 6000, seed = 1 }: FakeOptions): CellGrid {
  const random = rng(seed);
  const cellM = cellSizeM(center.lat);
  const R = radiusM / cellM; // walk radius in cells
  const claimR = 30 / cellM; // claim radius in cells
  const half = Math.ceil(R + claimR + 2);
  const c = cellXY(center.lng, center.lat);
  const w = 2 * half;
  const h = 2 * half;
  const grid: CellGrid = { x0: c.x - half, y0: c.y - half, w, h, claimed: new Uint8Array(w * h) };
  const target = Math.round((targetKm2 * 1e6) / (cellM * cellM));
  const stepCells = 40 / cellM;
  let count = 0;

  const claimSegment = (ax: number, ay: number, bx: number, by: number) => {
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - claimR));
    const i1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + claimR));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by) - claimR));
    const j1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + claimR));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const r2 = claimR * claimR;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * w + i;
        if (grid.claimed[idx]) continue;
        const px = i + 0.5 - ax;
        const py = j + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx;
        const ey = py - t * dy;
        if (ex * ex + ey * ey <= r2) {
          grid.claimed[idx] = 1;
          count++;
        }
      }
    }
  };

  while (count < target) {
    // A walk: 1 to 4 km, gently wandering, turning back toward the center at the edge.
    const a = random() * Math.PI * 2;
    const d = Math.sqrt(random()) * R;
    let x = half + Math.cos(a) * d;
    let y = half + Math.sin(a) * d;
    let heading = random() * Math.PI * 2;
    const steps = Math.round((1000 + random() * 3000) / 40);
    for (let s = 0; s < steps && count < target; s++) {
      heading += (random() - 0.5) * 0.9;
      // Streets: snap the heading toward the nearest of 8 directions now and then.
      if (random() < 0.3) heading = Math.round(heading / (Math.PI / 4)) * (Math.PI / 4);
      let nx = x + Math.cos(heading) * stepCells;
      let ny = y + Math.sin(heading) * stepCells;
      if (Math.hypot(nx - half, ny - half) > R) {
        heading = Math.atan2(half - y, half - x) + (random() - 0.5);
        nx = x + Math.cos(heading) * stepCells;
        ny = y + Math.sin(heading) * stepCells;
      }
      claimSegment(x, y, nx, ny);
      x = nx;
      y = ny;
    }
  }
  return grid;
}

export function countCells(grid: CellGrid): number {
  let n = 0;
  for (let i = 0; i < grid.claimed.length; i++) n += grid.claimed[i];
  return n;
}

/**
 * Merges claimed cells into polygons: one outer ring per 4-connected group of cells,
 * with a hole for every unclaimed pocket inside it. Rings follow cell edges with
 * collinear vertices removed. Diagonal neighbors become separate polygons touching at a
 * corner, as in PostGIS.
 */
export function cellsToTerritory(grid: CellGrid): TerritoryGeoJSON {
  const { w, h, claimed } = grid;
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && claimed[j * w + i] === 1;

  // Directed boundary edges with the claimed cell on the right (x east, y south), stored
  // per start vertex. Only saddle vertices (diagonal cells) have two outgoing edges.
  const W1 = w + 1;
  const out0 = new Int32Array(W1 * (h + 1)).fill(-1);
  const out1 = new Int32Array(W1 * (h + 1)).fill(-1);
  const add = (a: number, b: number) => {
    if (out0[a] < 0) out0[a] = b;
    else out1[a] = b;
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!at(i, j)) continue;
      const nw = j * W1 + i;
      const ne = nw + 1;
      const sw = nw + W1;
      const se = sw + 1;
      if (!at(i, j - 1)) add(nw, ne);
      if (!at(i + 1, j)) add(ne, se);
      if (!at(i, j + 1)) add(se, sw);
      if (!at(i - 1, j)) add(sw, nw);
    }
  }

  // 4-connected components, so holes can be matched with their polygon.
  const label = new Int32Array(w * h).fill(-1);
  let components = 0;
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (claimed[start] !== 1 || label[start] >= 0) continue;
    label[start] = components;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop()!;
      const i = idx % w;
      const j = (idx - i) / w;
      const visit = (ii: number, jj: number) => {
        if (at(ii, jj) && label[jj * w + ii] < 0) {
          label[jj * w + ii] = components;
          stack.push(jj * w + ii);
        }
      };
      visit(i + 1, j);
      visit(i - 1, j);
      visit(i, j + 1);
      visit(i, j - 1);
    }
    components++;
  }

  const lngs = new Float64Array(W1);
  for (let i = 0; i <= w; i++) lngs[i] = tileXYToLngLat(grid.x0 + i, 0, CELL_ZOOM)[0];
  const lats = new Float64Array(h + 1);
  for (let j = 0; j <= h; j++) lats[j] = tileXYToLngLat(0, grid.y0 + j, CELL_ZOOM)[1];

  const outers: (Position[] | null)[] = new Array(components).fill(null);
  const holes: Position[][][] = Array.from({ length: components }, () => []);

  // Scanning vertices in order, the first vertex with an unused edge is the top-left
  // corner of its ring, never a saddle, so each ring is closed on returning to it.
  for (let start = 0; start < out0.length; start++) {
    while (out0[start] >= 0) {
      const ring: Position[] = [];
      let area2 = 0;
      let cur = start;
      let next = out0[start];
      out0[start] = out1[start];
      out1[start] = -1;
      const si = start % W1;
      const sj = (start - si) / W1;
      // The claimed cell right of the first edge identifies the polygon.
      let ci = si;
      let cj = sj;
      let dx = (next % W1) - si;
      let dy = (next - (next % W1)) / W1 - sj;
      if (dy > 0) ci -= 1;
      else if (dx < 0) {
        ci -= 1;
        cj -= 1;
      } else if (dy < 0) cj -= 1;
      const owner = label[cj * w + ci];
      ring.push([lngs[si], lats[sj]]);
      for (;;) {
        const ci2 = cur % W1;
        const cj2 = (cur - ci2) / W1;
        const ni = next % W1;
        const nj = (next - ni) / W1;
        area2 += ci2 * nj - ni * cj2;
        dx = ni - ci2;
        dy = nj - cj2;
        cur = next;
        if (cur === start) break;
        // Pick the outgoing edge: at a saddle, turn right (stay with the same cell).
        let pick = out0[cur];
        let slot = 0;
        if (out1[cur] >= 0) {
          const rx = -dy;
          const ry = dx;
          const o1 = out1[cur];
          if ((o1 % W1) - ni === rx && (o1 - (o1 % W1)) / W1 - nj === ry) {
            pick = o1;
            slot = 1;
          }
        }
        if (slot === 0) {
          out0[cur] = out1[cur];
        }
        out1[cur] = -1;
        const pi = pick % W1;
        const pj = (pick - pi) / W1;
        if (pi - ni !== dx || pj - nj !== dy) ring.push([lngs[ni], lats[nj]]);
        next = pick;
      }
      ring.push(ring[0]);
      // Traced clockwise on the map for outer rings; RFC 7946 wants them counterclockwise.
      ring.reverse();
      if (area2 > 0) outers[owner] = ring;
      else holes[owner].push(ring);
    }
  }

  const coordinates: Position[][][] = [];
  for (let k = 0; k < components; k++) {
    const outer = outers[k];
    if (outer) coordinates.push([outer, ...holes[k]]);
  }
  return {
    type: 'FeatureCollection',
    features: coordinates.length
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates } }]
      : [],
  };
}

const PLACE_SUBTYPES = ['viewpoint', 'artwork', 'historic', 'monument', 'staircase', 'cafe', 'cafe', 'cafe', 'fountain'];
const MINE_SUBTYPES = ['sawmill', 'quarry', 'gold_mine'];

/**
 * `count` sites on or near the fake land: owned when the cell is claimed, a silhouette
 * when claimed land is within about 80 m, never deeper in the Mist.
 */
export function fakeSites(grid: CellGrid, count = 500, seed = 2): Site[] {
  const random = rng(seed);
  const { w, h, claimed } = grid;
  const near = 6; // cells
  const sites: Site[] = [];
  for (let attempt = 0; sites.length < count && attempt < count * 200; attempt++) {
    const i = Math.floor(random() * w);
    const j = Math.floor(random() * h);
    let visibility: Site['visibility'] | null = claimed[j * w + i] ? 'owned' : null;
    if (!visibility) {
      search: for (let jj = Math.max(0, j - near); jj <= Math.min(h - 1, j + near); jj += 2) {
        for (let ii = Math.max(0, i - near); ii <= Math.min(w - 1, i + near); ii += 2) {
          if (claimed[jj * w + ii]) {
            visibility = 'silhouette';
            break search;
          }
        }
      }
    }
    if (!visibility) continue;
    const mine = random() < 0.3;
    const list = mine ? MINE_SUBTYPES : PLACE_SUBTYPES;
    const subtype = list[Math.floor(random() * list.length)];
    const [lng, lat] = tileXYToLngLat(grid.x0 + i + 0.5, grid.y0 + j + 0.5, CELL_ZOOM);
    sites.push({
      id: `fake:${sites.length}`,
      kind: mine ? 'mine' : 'place',
      subtype,
      name: visibility === 'owned' ? `Fake ${SITE_TYPES[subtype]?.label ?? subtype} ${sites.length + 1}` : null,
      lng,
      lat,
      visibility,
    });
  }
  return sites;
}

export type FakeWorld = { territory: Territory; sites: Site[]; generateMs: number };

/** Builds the fake realm: about `targetKm2` of land around `center` and 500 sites. */
export function fakeWorld(options: FakeOptions): FakeWorld {
  const t0 = Date.now();
  const grid = fakeCells(options);
  const totalCells = countCells(grid);
  const cellM = cellSizeM(options.center.lat);
  const territory: Territory = { claimed: cellsToTerritory(grid), totalCells, areaM2: totalCells * cellM * cellM };
  const sites = fakeSites(grid);
  return { territory, sites, generateMs: Date.now() - t0 };
}
