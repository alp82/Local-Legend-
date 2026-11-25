// PROTOTYPE, throwaway. Round 2 world generator for variant B.
//
// 1. Seeds on a jittered global grid (denser near towns, sparser in the wild) → Voronoi cells.
// 2. Every cell is cut out of the real water polygons, so nothing land-based crosses water;
//    each piece left over is typed on its own.
// 3. Each piece gets a land type from real data at its centroid: landcover, landuse, parks,
//    distance to water, elevation and slope from the DEM, building density and the nearest
//    settlement's tier, plus two octaves of world-anchored noise for regional character.
//    Neighbouring pieces of the same type read as one organic patch; field crops and
//    pasture variants are chosen per warped "field group" so fields span several cells.
// 4. Borders between different patches become hedgerows (with hedge trees), dry-stone walls
//    or fences; scatter symbols (livestock, haystacks, trees, rocks, reeds, stalls, graves,
//    boats …) are placed per type; towns get house clusters, walls, wall towers, gates and
//    quays along the water.
import { Delaunay, polygonClipping } from './vendor/geo.mjs';
import { toM, toLL } from './density.js';
import { NET } from './styles.js';

// ---------------------------------------------------------------- noise & hashing
export function hash(i, j, s = 0) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(s, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = fade(x - i), fy = fade(y - j);
  const a = hash(i, j, s), b = hash(i + 1, j, s), c = hash(i, j + 1, s), d = hash(i + 1, j + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(x, y, s, oct = 3) {
  let v = 0, amp = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { v += vnoise(x * f, y * f, s + o * 17) * amp; n += amp; amp *= 0.5; f *= 2.03; }
  return v / n;
}

// ---------------------------------------------------------------- geometry helpers
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; }
function inRing(x, y, r) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
const inPoly = (x, y, p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h));
function bboxOf(rings) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const [x, y] of r) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}
function centroid(p) {
  const r = p[0]; let A = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; A += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f; }
  return A ? [cx / (3 * A), cy / (3 * A)] : r[0];
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}
function polysOf(f) {
  const g = f.geometry;
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}
function linesOf(f) {
  const g = f.geometry;
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}

/** Bucketed index of polygons (mercator) for point queries. */
class PolyIndex {
  constructor(G) { this.G = G; this.items = []; this.b = new Map(); }
  add(rings, props) {
    const bb = bboxOf(rings), id = this.items.length;
    this.items.push({ rings, props, bb });
    for (let i = Math.floor(bb[0] / this.G); i <= Math.floor(bb[2] / this.G); i++)
      for (let j = Math.floor(bb[1] / this.G); j <= Math.floor(bb[3] / this.G); j++) {
        const k = i + ',' + j; if (!this.b.has(k)) this.b.set(k, []); this.b.get(k).push(id);
      }
  }
  at(x, y) {
    const out = [];
    for (const id of this.b.get(Math.floor(x / this.G) + ',' + Math.floor(y / this.G)) || []) {
      const it = this.items[id];
      if (x < it.bb[0] || x > it.bb[2] || y < it.bb[1] || y > it.bb[3]) continue;
      if (inPoly(x, y, it.rings)) out.push(it.props);
    }
    return out;
  }
  overlapping(bb) {
    const ids = new Set();
    for (let i = Math.floor(bb[0] / this.G); i <= Math.floor(bb[2] / this.G); i++)
      for (let j = Math.floor(bb[1] / this.G); j <= Math.floor(bb[3] / this.G); j++)
        for (const id of this.b.get(i + ',' + j) || []) ids.add(id);
    return [...ids].map((id) => this.items[id]).filter((it) => !(it.bb[2] < bb[0] || it.bb[0] > bb[2] || it.bb[3] < bb[1] || it.bb[1] > bb[3]));
  }
}

/** Bucketed segments for distance queries. */
class SegIndex {
  constructor(G) { this.G = G; this.b = new Map(); this.n = 0; }
  add(a, b, props) {
    const s = [a[0], a[1], b[0], b[1], props];
    this.n++;
    for (let i = Math.floor(Math.min(a[0], b[0]) / this.G); i <= Math.floor(Math.max(a[0], b[0]) / this.G); i++)
      for (let j = Math.floor(Math.min(a[1], b[1]) / this.G); j <= Math.floor(Math.max(a[1], b[1]) / this.G); j++) {
        const k = i + ',' + j; if (!this.b.has(k)) this.b.set(k, []); this.b.get(k).push(s);
      }
  }
  nearest(x, y) {
    let best = Infinity, bp = null;
    const gi = Math.floor(x / this.G), gj = Math.floor(y / this.G);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const s of this.b.get((gi + di) + ',' + (gj + dj)) || []) {
      const d = segDist(x, y, s[0], s[1], s[2], s[3]);
      if (d < best) { best = d; bp = s; }
    }
    return [best, bp];
  }
}

// ---------------------------------------------------------------- DEM
const demCache = new Map();
async function demTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!demCache.has(key)) {
    demCache.set(key, (async () => {
      try {
        const blob = await (await fetch(`${NET.dem}${key}.png`)).blob();
        const bmp = await createImageBitmap(blob);
        const cv = new OffscreenCanvas(256, 256), cx = cv.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        const d = cx.getImageData(0, 0, 256, 256).data, e = new Float32Array(256 * 256);
        for (let i = 0; i < e.length; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        return e;
      } catch { return null; }
    })());
  }
  return demCache.get(key);
}
const WORLD = 2 * Math.PI * 6378137, HALF = WORLD / 2;
export async function demSampler(bb, z) {
  const n = 2 ** z, ts = WORLD / n;
  const tx0 = Math.floor((bb[0] + HALF) / ts), tx1 = Math.floor((bb[2] + HALF) / ts);
  const ty0 = Math.floor((HALF - bb[3]) / ts), ty1 = Math.floor((HALF - bb[1]) / ts);
  const tiles = new Map();
  const jobs = [];
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) jobs.push(demTile(z, x, y).then((e) => tiles.set(x + ',' + y, e)));
  await Promise.all(jobs);
  // bilinear across tile seams; a missing tile falls back to its neighbour's value
  let last = 0;
  const pix = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const e = tiles.get(tx + ',' + ty);
    if (!e) return last;
    return (last = e[(gy - ty * 256) * 256 + (gx - tx * 256)]);
  };
  return (mx, my) => {
    const fx = (mx + HALF) / ts * 256 - 0.5, fy = (HALF - my) / ts * 256 - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const a = pix(x0, y0), b = pix(x0 + 1, y0), c = pix(x0, y0 + 1), d = pix(x0 + 1, y0 + 1);
    return a * (1 - ax) * (1 - ay) + b * ax * (1 - ay) + c * (1 - ax) * ay + d * ax * ay;
  };
}

// ---------------------------------------------------------------- land types
// Each type: texture(s), border kind and scatter recipe. `fieldish` types count as "plain fields".
const CROPS = ['wheat', 'barley', 'rye', 'flax', 'rape', 'green', 'plough', 'fallow', 'cabbage'];
const TYPES = {
  field: { border: 'hedge', fieldish: true },
  pasture: { tex: ['t_pasture_0', 't_pasture_1', 't_pasture_2'], border: 'hedge' },
  paddock: { tex: ['t_paddock'], border: 'fence' },
  meadow: { tex: ['t_meadow_wild'], border: 'hedge' },
  hedgemeadow: { tex: ['t_meadow_hedge'], border: 'hedge' },
  orchard: { tex: ['t_orchard'], border: 'hedge' },
  vineyard: { tex: ['t_vineyard_0', 't_vineyard_1'], border: 'wall' },
  heath: { tex: ['t_heath'], border: null },
  moor: { tex: ['t_moor'], border: null },
  forest: { tex: ['p_forest'], border: null },
  pine: { tex: ['t_pine'], border: null },
  copse: { tex: ['p_grove'], border: null },
  marsh: { tex: ['p_marsh'], border: null },
  reeds: { tex: ['t_reeds'], border: null },
  rocky: { tex: ['p_rock'], border: null },
  scree: { tex: ['t_scree'], border: null },
  snow: { tex: ['p_snow'], border: null },
  highland: { tex: ['t_highland'], border: 'wall' },
  terraces: { tex: ['t_terraces'], border: 'wall' },
  quarry: { tex: ['p_quarry'], border: 'fence' },
  shore: { tex: ['p_sand'], border: null },
  green: { tex: ['t_green'], border: null },
  common: { tex: ['t_common'], border: null },
  graveyard: { tex: ['t_graveyard'], border: 'wall' },
  gardens: { tex: ['t_gardens'], border: 'fence' },
  burgage: { tex: ['t_burgage'], border: 'fence' },
  town: { tex: ['t_town'], border: null },
  market: { tex: ['t_market'], border: null },
  yard: { tex: ['t_yard'], border: 'fence' },
  cloister: { tex: ['t_cloister', 't_herbs'], border: 'wall' },
  herbs: { tex: ['t_herbs'], border: 'fence' },
  tourney: { tex: ['t_tourney'], border: 'fence' },
  quay: { tex: ['t_cobbles_dark'], border: null },
};
const RING = [45, 90, 160, 240, 320]; // settlement radius by tier, ground metres

function pick(r, weights) {
  let t = 0; for (const [, w] of weights) t += w;
  let x = r * t;
  for (const [k, w] of weights) { x -= w; if (x <= 0) return k; }
  return weights[weights.length - 1][0];
}

/**
 * Organic outlines: every Voronoi edge gets two displaced midpoints. The displacement is
 * derived from the edge's two endpoints in a canonical order, so the two cells sharing an
 * edge compute identical points and still meet without gaps.
 */
function wobble(ring, amp) {
  const out = [];
  const q = (v) => Math.round(v[0] * 10) + ':' + Math.round(v[1] * 10);
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    out.push(a);
    const flip = q(a) > q(b);
    const [p0, p1] = flip ? [b, a] : [a, b];
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy);
    if (L < amp * 0.6) continue;
    const nx = -dy / L, ny = dx / L;
    const hk = Math.round(p0[0] * 3 + p1[1] * 7) | 0, hj = Math.round(p0[1] * 5 + p1[0] * 11) | 0;
    const pts = [1 / 3, 2 / 3].map((t, m) => {
      const o = (hash(hk, hj, 191 + m) - 0.5) * Math.min(L * 0.32, amp);
      return [p0[0] + dx * t + nx * o, p0[1] + dy * t + ny * o];
    });
    if (flip) pts.reverse();
    out.push(...pts);
  }
  out.push(ring[ring.length - 1]);
  return out;
}

// ---------------------------------------------------------------- main
export async function computeWorld(map, settle, opts) {
  const t0 = performance.now();
  const zoom = map.getZoom();
  const k = settle.k;
  const b = map.getBounds();
  const [vx0, vy0] = toM([b.getWest(), b.getSouth()]), [vx1, vy1] = toM([b.getEast(), b.getNorth()]);
  const mw = (vx1 - vx0) * 0.12, mh = (vy1 - vy0) * 0.12;
  const BB = [vx0 - mw, vy0 - mh, vx1 + mw, vy1 + mh];
  const S = (zoom >= 15 ? 85 : zoom >= 14 ? 140 : zoom >= 13 ? 250 : zoom >= 12 ? 480 : 950) * k;
  const detail = zoom >= 13.6;
  const stats = {};

  // --- real data indexes
  const G = S * 3;
  const lc = new PolyIndex(G), lu = new PolyIndex(G), park = new PolyIndex(G), water = new PolyIndex(G);
  const shoreSegs = new SegIndex(S * 1.5), roadSegs = new SegIndex(S * 1.5);
  const viewRect = [[[BB[0], BB[1]], [BB[2], BB[1]], [BB[2], BB[3]], [BB[0], BB[3]], [BB[0], BB[1]]]];
  const ovl = (bb) => !(bb[2] < BB[0] || bb[0] > BB[2] || bb[3] < BB[1] || bb[1] > BB[3]);
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'landcover' })) for (const p of polysOf(f)) { const m = p.map((r) => r.map(toM)); if (ovl(bboxOf(m))) lc.add(m, f.properties); }
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'landuse' })) for (const p of polysOf(f)) { const m = p.map((r) => r.map(toM)); if (ovl(bboxOf(m))) lu.add(m, f.properties); }
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'park' })) for (const p of polysOf(f)) { const m = p.map((r) => r.map(toM)); if (ovl(bboxOf(m))) park.add(m, f.properties); }
  let waterPolys = 0;
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'water' })) {
    if (f.properties.brunnel === 'tunnel') continue;
    for (const p of polysOf(f)) {
      let m = p.map((r) => r.map(toM));
      if (!ovl(bboxOf(m))) continue;
      try {
        const cut = polygonClipping.intersection(m, viewRect);
        for (const q of cut) { water.add(q, f.properties); waterPolys++; for (const r of q) for (let i = 1; i < r.length; i++) shoreSegs.add(r[i - 1], r[i], 'shore'); }
      } catch { water.add(m, f.properties); }
    }
  }
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'waterway' })) {
    if (f.properties.brunnel === 'tunnel') continue;
    for (const l of linesOf(f)) { const m = l.map(toM); for (let i = 1; i < m.length; i++) shoreSegs.add(m[i - 1], m[i], f.properties.class); }
  }
  const visibleRoads = opts.roads === 'all' ? null : new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'transportation' })) {
    const c = f.properties.class;
    if (f.properties.brunnel === 'tunnel' || ['rail', 'transit', 'ferry', 'bridge', 'pier'].includes(c)) continue;
    if (visibleRoads && !visibleRoads.has(c)) continue;
    for (const l of linesOf(f)) { const m = l.map(toM); for (let i = 1; i < m.length; i++) roadSegs.add(m[i - 1], m[i], c); }
  }
  for (const line of opts.links?.features?.[0]?.geometry?.coordinates || []) { const m = line.map(toM); for (let i = 1; i < m.length; i++) roadSegs.add(m[i - 1], m[i], 'link'); }
  const isWater = (x, y) => water.at(x, y).length > 0;
  stats.index = `${lc.items.length} landcover, ${lu.items.length} landuse, ${waterPolys} water`;

  // --- DEM
  const dem = await demSampler(BB, zoom >= 13 ? 12 : 10);
  const elevSamples = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 8; j++) elevSamples.push(dem(BB[0] + (BB[2] - BB[0]) * (i + 0.5) / 12, BB[1] + (BB[3] - BB[1]) * (j + 0.5) / 8));
  elevSamples.sort((a, b) => a - b);
  const floor = elevSamples[Math.floor(elevSamples.length * 0.08)];
  const slopeAt = (x, y) => {
    const d = 60 * k;
    const gx = (dem(x + d, y) - dem(x - d, y)) / 120, gy = (dem(x, y + d) - dem(x, y - d)) / 120;
    return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
  };

  // --- settlements & density lookups
  const grid = settle.grid;
  const cellAt = (x, y) => {
    const [u, v] = grid.unrot ? (() => { const cs = Math.cos(grid.theta), sn = Math.sin(grid.theta); return [x * cs + y * sn, -x * sn + y * cs]; })() : [x, y];
    return grid.cells.get(Math.floor(u / grid.S) + ',' + Math.floor(v / grid.S));
  };
  const towns = settle.accepted.map((s) => ({ ...s, R: RING[Math.min(s.t, 4)] * k * (0.85 + 0.3 * hash(Math.round(s.x), Math.round(s.y), 3)) }));
  const nearestTown = (x, y) => {
    let best = null, bd = Infinity;
    for (const t of towns) { const d = Math.hypot(t.x - x, t.y - y) / t.R; if (d < bd) { bd = d; best = t; } }
    return [best, bd];
  };

  // --- coherent randomness: one draw per warped "patch group" of several cells, so
  // neighbouring cells agree and merge into one organic patch
  function groupRand(x, y, size, seed) {
    const wx = x + (fbm(x / (size * 1.3), y / (size * 1.3), seed + 1) - 0.5) * size * 1.6;
    const wy = y + (fbm(x / (size * 1.3), y / (size * 1.3), seed + 2) - 0.5) * size * 1.6;
    return hash(Math.floor(wx / size), Math.floor(wy / size), seed);
  }
  // --- classify a point
  const NA = 1800 * k, NB = 380 * k;
  function classify(x, y) {
    const nA = fbm(x / NA, y / NA, 11), nB = fbm(x / NB, y / NB, 23, 2);
    const h = groupRand(x, y, S * (2.2 + 1.6 * fbm(x / (S * 9), y / (S * 9), 7)), 5);
    const L = lc.at(x, y), U = lu.at(x, y), P = park.at(x, y);
    const has = (arr, cls) => arr.some((p) => p.class === cls);
    const hasSub = (arr, subs) => arr.some((p) => subs.includes(p.subclass));
    const elev = dem(x, y), rel = elev - floor, slope = slopeAt(x, y);
    const [dW, wseg] = shoreSegs.nearest(x, y);
    const dWm = dW / k;
    const c = cellAt(x, y), w = c?.w || 0;
    const [town, tr] = nearestTown(x, y);
    const tier = town?.t ?? -1;
    const ctx = { nA, nB, h, rel, slope, dWm, w, tier, tr };
    let t;
    if (has(U, 'cemetery')) t = 'graveyard';
    else if (has(L, 'ice')) t = 'snow';
    else if (has(L, 'rock') || (rel > 500 && slope > 30)) t = slope > 32 ? 'scree' : 'rocky';
    else if (has(L, 'wood')) t = rel > 250 || slope > 18 || nA > 0.64 ? 'pine' : nB > 0.8 ? 'copse' : 'forest';
    else if (has(L, 'wetland')) t = dWm < 60 ? 'reeds' : 'marsh';
    else if (has(L, 'sand')) t = dWm < 150 ? 'shore' : 'heath';
    else if (P.length || hasSub(L, ['park', 'garden'])) t = tr < 2.2 ? pick(h, [['green', 3], ['gardens', 2], ['copse', 2], ['herbs', 1]]) : pick(h, [['copse', 4], ['meadow', 2], ['green', 1]]);
    else if (U.some((p) => ['industrial', 'garages', 'quarry', 'dam', 'railway'].includes(p.class))) t = nB > 0.58 ? 'quarry' : 'yard';
    else if (U.some((p) => ['commercial', 'retail'].includes(p.class))) t = h < 0.75 ? 'market' : 'yard';
    else if (U.some((p) => ['school', 'college', 'university', 'kindergarten', 'library'].includes(p.class))) t = 'cloister';
    else if (has(U, 'hospital')) t = 'herbs';
    else if (U.some((p) => ['pitch', 'stadium', 'playground', 'track', 'military'].includes(p.class))) t = 'tourney';
    else if (slope > 27) t = rel > 300 ? 'scree' : 'pine';
    else if (rel > 380) t = nA > 0.55 ? 'moor' : 'highland';
    else if (slope > 11 && rel > 60) t = nB > 0.45 ? 'terraces' : 'highland';
    else if (dWm < 18 && w > 0.1 && tr < 2.5) t = 'quay';
    else if (dWm < 40 && w < 0.12) t = nB > 0.5 ? 'reeds' : 'hedgemeadow';
    else if (tr < 1) {
      // inside a settlement
      if (tier >= 3) t = tr < 0.28 ? 'market' : pick(h, [['town', 4], ['burgage', 4], ['gardens', 2], ['yard', 1]]);
      else if (tier === 2) t = tr < 0.3 ? 'green' : pick(h, [['gardens', 4], ['burgage', 2], ['town', 2], ['orchard', 1]]);
      else t = pick(h, [['gardens', 3], ['paddock', 2], ['green', 1]]);
    } else if ((has(L, 'farmland') || hasSub(L, ['farmland', 'farm'])) && tr > 1.3) {
      t = hasSub(L, ['orchard']) ? 'orchard' : hasSub(L, ['vineyard']) ? 'vineyard' : pick(nB, [['field', 6], ['pasture', 3], ['hedgemeadow', 1]]);
    } else if (tr < 2.3 && tier >= 1) {
      // the ring around a settlement
      t = pick(h, tier >= 3
        ? [['gardens', 1.6], ['orchard', 2.5], ['paddock', 2], ['herbs', 1], ['pasture', 2], ['field', 1.5], ['common', 1.5], ['green', 0.8]]
        : [['orchard', 2.5], ['paddock', 2], ['gardens', 1.2], ['pasture', 3], ['field', 2], ['hedgemeadow', 1.5], ['meadow', 1]]);
    } else if (has(L, 'farmland') || hasSub(L, ['farmland', 'farm'])) {
      t = hasSub(L, ['orchard']) ? 'orchard' : hasSub(L, ['vineyard']) ? 'vineyard' : pick(nB, [['field', 6], ['pasture', 3], ['hedgemeadow', 1]]);
    } else if (has(L, 'grass')) {
      t = pick(nB, [['meadow', 3], ['pasture', 3], ['hedgemeadow', 2], ['common', 1], ['heath', nA > 0.6 ? 2 : 0.2]]);
    } else if (w > 0.12) {
      // built-up land between settlements: district character from large-scale noise
      t = nA < 0.38 ? pick(h, [['orchard', 4], ['gardens', 3], ['paddock', 2], ['copse', 1], ['field', 1]])
        : nA < 0.62 ? pick(h, [['pasture', 3], ['field', 2], ['paddock', 2], ['hedgemeadow', 2], ['orchard', 1], ['copse', 1]])
        : pick(h, [['common', 3], ['copse', 3], ['meadow', 2], ['green', 1], ['pasture', 1]]);
    } else if (w > 0.025) {
      t = pick(nB, [['field', 4], ['pasture', 3], ['hedgemeadow', 1.5], ['orchard', 1], ['copse', 1]]);
    } else {
      t = nA > 0.62 ? pick(h, [['heath', 3], ['moor', rel > 150 ? 3 : 0.5], ['copse', 1]])
        : nA < 0.3 ? pick(h, [['copse', 2], ['forest', 2], ['meadow', 1]])
        : pick(nB, [['meadow', 2], ['pasture', 3], ['field', 2], ['hedgemeadow', 1], ['copse', 1]]);
    }
    return { t, ctx };
  }

  // --- texture variant: grouped by a warped coarse grid so a field spans several cells
  function texFor(type, x, y) {
    const wx = x + (fbm(x / (S * 4), y / (S * 4), 41) - 0.5) * S * 3, wy = y + (fbm(x / (S * 4), y / (S * 4), 43) - 0.5) * S * 3;
    const g = S * (2 + hash(Math.floor(x / (S * 6)), Math.floor(y / (S * 6)), 47) * 1.6);
    const gi = Math.floor(wx / g), gj = Math.floor(wy / g);
    const r = hash(gi, gj, 53), r2 = hash(gi, gj, 59);
    if (type === 'field') return { tex: `t_${CROPS[Math.floor(r * CROPS.length)]}_${Math.floor(r2 * 4)}`, group: gi + ':' + gj };
    const list = TYPES[type].tex;
    return { tex: list[Math.floor(r * list.length)], group: gi + ':' + gj };
  }

  // --- seeds
  const seeds = [];
  for (let i = Math.floor(BB[0] / S); i <= Math.floor(BB[2] / S); i++) for (let j = Math.floor(BB[1] / S); j <= Math.floor(BB[3] / S); j++) {
    const cx = (i + 0.5) * S, cy = (j + 0.5) * S;
    const c = cellAt(cx, cy), w = c?.w || 0;
    const [, tr] = nearestTown(cx, cy);
    const n = fbm(cx / (S * 5), cy / (S * 5), 61);
    let count = tr < 1.2 ? 2 : n > 0.7 ? 2 : 1;
    if (w < 0.02 && n < 0.35 && hash(i, j, 67) < 0.45) count = 0; // big wild patches
    for (let q = 0; q < count; q++) seeds.push([i * S + hash(i, j, 71 + q) * S, j * S + hash(i, j, 79 + q) * S]);
  }
  if (seeds.length < 4) return null;
  const del = Delaunay.from(seeds);
  const vor = del.voronoi(BB);

  // --- cells cut out of water, typed per piece
  const pieces = [];
  for (let i = 0; i < seeds.length; i++) {
    const raw = vor.cellPolygon(i);
    if (!raw) continue;
    const cp = wobble(raw, S * 0.45);
    let parts = [[cp]];
    const bb = bboxOf([cp]);
    const ws = water.overlapping(bb);
    if (ws.length) {
      try { parts = polygonClipping.difference([cp], ...ws.map((w) => w.rings)); } catch { /* keep uncut */ }
    }
    for (const p of parts) {
      const a = Math.abs(ringArea(p[0]));
      if (a < (S * S) * 0.01) continue;
      let [cx, cy] = centroid(p);
      if (!inPoly(cx, cy, p)) [cx, cy] = p[0][Math.floor(p[0].length / 2)];
      if (isWater(cx, cy)) continue;
      const { t, ctx } = classify(cx, cy);
      const { tex, group } = texFor(t, cx, cy);
      pieces.push({ seed: i, poly: p, t, tex, group, cx, cy, area: a, ctx, cut: parts.length > 1 || ws.length > 0 });
    }
  }

  // --- features: cells, tints, borders
  const cellFeats = [], borderFeats = [], scatter = [], walls = [], marks = [];
  const tintOf = (p) => {
    const n = fbm(p.cx / (S * 16), p.cy / (S * 16), 83);
    return n < 0.4 ? '#f0d890' : n < 0.62 ? '#6f9a3a' : '#4a6e58';
  };
  for (const p of pieces) {
    cellFeats.push({
      type: 'Feature',
      properties: { t: p.t, tex: p.tex, tint: tintOf(p), ta: 0.04 + 0.08 * fbm(p.cx / (S * 12), p.cy / (S * 12), 89) },
      geometry: { type: 'Polygon', coordinates: p.poly.map((r) => r.map(toLL)) },
    });
  }
  // borders: shared Voronoi edges between pieces of different patches (only uncut cells)
  const bySeed = new Map();
  for (const p of pieces) if (!p.cut) bySeed.set(p.seed, p);
  const key = (p) => p.t + '|' + p.group + '|' + p.tex;
  const hedgeTrees = [];
  for (let i = 0; i < seeds.length; i++) {
    const A = bySeed.get(i); if (!A) continue;
    for (const j of del.neighbors(i)) {
      if (j <= i) continue;
      const B = bySeed.get(j); if (!B || key(A) === key(B)) continue;
      const kind = TYPES[A.t].border && TYPES[B.t].border ? (TYPES[A.t].border === 'wall' || TYPES[B.t].border === 'wall' ? 'wall' : TYPES[A.t].border === 'fence' || TYPES[B.t].border === 'fence' ? 'fence' : 'hedge') : null;
      if (!kind) continue;
      const vk = (v) => v[0].toFixed(2) + ',' + v[1].toFixed(2);
      const inB = new Set(B.poly[0].map(vk));
      const ringA = A.poly[0].slice(0, -1);
      // longest run of consecutive A vertices that B shares (wrapping around)
      let start = ringA.findIndex((v, idx) => !inB.has(vk(v)) && inB.has(vk(ringA[(idx + 1) % ringA.length])));
      if (start < 0) continue;
      const run = [];
      for (let m = 1; m <= ringA.length; m++) { const v = ringA[(start + m) % ringA.length]; if (!inB.has(vk(v))) break; run.push(v); }
      if (run.length < 2) continue;
      borderFeats.push({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: run.map(toLL) } });
      if (kind === 'hedge' && detail) {
        for (let m = 1; m < run.length; m++) {
          const a = run[m - 1], b2 = run[m];
          const len = Math.hypot(b2[0] - a[0], b2[1] - a[1]) / k;
          for (let s2 = 0; s2 < len; s2 += 20) {
            const u = s2 / len, hh = hash(Math.round(a[0] + u * 1000), Math.round(a[1] + s2), 97);
            if (hh < 0.4) hedgeTrees.push([a[0] + (b2[0] - a[0]) * u, a[1] + (b2[1] - a[1]) * u, hh]);
          }
        }
      }
    }
  }

  // --- scatter
  const placed = new SegIndex(20 * k); // reuse as point grid via zero-length segments
  const free = (x, y, r) => placed.nearest(x, y)[0] > r * k;
  const put = (x, y, icon, size = 1, extra = {}) => {
    placed.add([x, y], [x, y], 0);
    scatter.push({ type: 'Feature', properties: { icon, s: size, ...extra }, geometry: { type: 'Point', coordinates: toLL([x, y]) } });
  };
  const roadClear = (x, y, m) => roadSegs.nearest(x, y)[0] > m * k;
  const R4 = (v, n) => Math.floor(((v * 7.31) % 1) * n);
  if (detail) {
    for (const [x, y, hh] of hedgeTrees) if (roadClear(x, y, 6) && !isWater(x, y)) put(x, y, `s_tree_${R4(hh * 2.2, 5)}`, 0.7 + hh * 0.5);
    const recipes = {
      pasture: (r) => r < 0.5 ? `s_sheep_${1 + R4(r * 6, 3)}` : r < 0.75 ? `s_cow_${R4(r * 12, 3)}` : r < 0.85 ? 's_hay_0' : 's_bush_0',
      paddock: (r) => r < 0.6 ? 's_horse' : r < 0.8 ? 's_woodpile' : 's_hay_2',
      field: (r, p) => /wheat|barley|rye|fallow/.test(p.tex) ? `s_hay_${R4(r * 3, 3)}` : null,
      meadow: (r) => r < 0.7 ? `s_flowers_${R4(r * 4.3, 3)}` : r < 0.9 ? 's_bush_1' : 's_tree_1',
      hedgemeadow: (r) => r < 0.5 ? 's_flowers_0' : r < 0.75 ? 's_willow' : 's_bush_0',
      orchard: (r) => r < 0.15 ? 's_hay_1' : null,
      heath: (r) => r < 0.6 ? `s_bush_${r < 0.3 ? 2 : 1}` : r < 0.85 ? `s_rock_${R4(r * 9, 4)}` : 's_sheep_1',
      moor: (r) => r < 0.55 ? `s_rock_${R4(r * 7, 4)}` : r < 0.8 ? 's_sheep_2' : 's_bush_2',
      highland: (r) => r < 0.4 ? `s_rock_${R4(r * 10, 4)}` : r < 0.75 ? `s_sheep_${1 + R4(r * 3.9, 3)}` : 's_cow_1',
      rocky: (r) => `s_rock_${R4(r * 4, 4)}`,
      scree: (r) => `s_rock_${R4(r * 4, 4)}`,
      terraces: (r) => r < 0.3 ? `s_rock_${R4(r * 13, 4)}` : null,
      copse: (r) => r < 0.75 ? `s_tree_${R4(r * 6.6, 5)}` : 's_bush_0',
      forest: (r) => r < 0.12 ? `s_rock_${R4(r * 30, 4)}` : null,
      pine: (r) => r < 0.5 ? `s_pine_${R4(r * 6, 3)}` : r < 0.6 ? `s_rock_${R4(r * 20, 4)}` : null,
      marsh: (r) => r < 0.6 ? `s_reeds_${R4(r * 3.3, 2)}` : 's_willow',
      reeds: (r) => r < 0.85 ? `s_reeds_${R4(r * 2.3, 2)}` : 's_willow',
      common: (r) => r < 0.35 ? 's_sheep_1' : r < 0.6 ? 's_tree_2' : r < 0.75 ? 's_cow_0' : null,
      green: (r) => r < 0.25 ? 's_tree_4' : r < 0.35 ? 's_flowers_0' : null,
      gardens: (r) => r < 0.3 ? 's_bush_0' : r < 0.45 ? 's_woodpile' : r < 0.6 ? 's_tree_2' : null,
      burgage: (r) => r < 0.35 ? 's_tree_2' : r < 0.5 ? 's_woodpile' : null,
      yard: (r) => r < 0.35 ? 's_woodpile' : r < 0.55 ? 'i_anvil' : r < 0.75 ? `s_rock_${R4(r * 5, 4)}` : null,
      quarry: (r) => `s_rock_${R4(r * 4, 4)}`,
      market: (r) => r < 0.55 ? `s_stall_${R4(r * 4, 4)}` : r < 0.75 ? 's_woodpile' : r < 0.85 ? 's_hay_2' : 's_horse',
      graveyard: (r) => r < 0.75 ? `s_grave_${R4(r * 4, 3)}` : r < 0.9 ? 's_tree_0' : 'i_barrow',
      cloister: (r) => r < 0.3 ? 's_tree_2' : null,
      herbs: (r) => r < 0.4 ? 's_flowers_2' : null,
      quay: (r) => r < 0.3 ? 's_woodpile' : null,
      shore: (r) => r < 0.3 ? `s_rock_${R4(r * 13, 4)}` : null,
    };
    const perHa = { pasture: 2.2, paddock: 3, field: 1.4, meadow: 5, hedgemeadow: 2.5, orchard: 0.6, heath: 4, moor: 3, highland: 3, rocky: 6, scree: 9, terraces: 1.5, copse: 9, forest: 0.6, pine: 2, marsh: 5, reeds: 8, common: 2.5, green: 1.5, gardens: 4, burgage: 3, yard: 4, quarry: 6, market: 3.5, graveyard: 10, cloister: 1.5, herbs: 3, quay: 2, shore: 1.5 };
    const zf = Math.min(1.6, Math.max(0.45, (zoom - 13.5) / 1.6)); // fewer symbols when zoomed out
    for (const p of pieces) {
      const rate = perHa[p.t];
      if (!rate || !recipes[p.t]) continue;
      const ha = p.area / (k * k) / 10000;
      let n = Math.round(rate * ha * zf * (0.6 + hash(p.seed, p.t.length, 101) * 0.8));
      const bb = bboxOf(p.poly);
      for (let q = 0, tries = 0; q < n && tries < n * 4; tries++) {
        const x = bb[0] + hash(p.seed, tries, 103) * (bb[2] - bb[0]), y = bb[1] + hash(p.seed, tries, 107) * (bb[3] - bb[1]);
        if (!inPoly(x, y, p.poly)) continue;
        q++;
        const r = hash(p.seed, tries, 109);
        const ic = recipes[p.t](r, p);
        if (!ic || !free(x, y, 7) || !roadClear(x, y, 5)) continue;
        put(x, y, ic, 0.75 + hash(p.seed, tries, 113) * 0.55);
      }
      // one landmark per big special patch
      if (p.t === 'tourney' && ha > 0.4) marks.push(['lm_tourney', p.cx, p.cy]);
      if (p.t === 'market' && ha > 0.8 && hash(p.seed, 1, 127) < 0.5) marks.push(['lm_marketcross', p.cx, p.cy]);
      if (p.t === 'field' && hash(p.seed, 2, 131) < 0.04) marks.push(['lm_windmill', p.cx, p.cy]);
      if (p.t === 'green' && ha > 0.5 && hash(p.seed, 3, 137) < 0.4) marks.push(['lm_well', p.cx, p.cy]);
      if ((p.t === 'heath' || p.t === 'moor' || p.t === 'common') && ha > 1.2 && hash(p.seed, 4, 139) < 0.12) marks.push([hash(p.seed, 5, 1) < 0.5 ? 'lm_stones' : 'lm_ruins', p.cx, p.cy]);
    }
  }

  // --- towns: houses, walls, towers, gates; water life
  const gateHits = [];
  if (detail) {
    for (const t of towns) {
      const cntBase = [1, 5, 14, 70, 100][Math.min(t.t, 4)];
      const n = Math.round(cntBase * (0.8 + 0.4 * hash(Math.round(t.x), 1, 141)));
      for (let q = 0, tries = 0; q < n && tries < n * 6; tries++) {
        const a = hash(Math.round(t.x), tries, 149) * Math.PI * 2, rr = Math.sqrt(hash(Math.round(t.y), tries, 151)) * t.R * (t.t >= 3 ? 0.92 : 0.85);
        const x = t.x + Math.cos(a) * rr, y = t.y + Math.sin(a) * rr;
        if (isWater(x, y) || !roadClear(x, y, 5) || !free(x, y, t.t >= 3 ? 9 : 12)) continue;
        q++;
        put(x, y, `s_house_${Math.floor(hash(Math.round(x), Math.round(y), 157) * 6)}`, 0.85 + hash(q, tries, 163) * 0.35, { house: 1 });
      }
      if (t.t >= 3) {
        // wobbly wall ring, broken where it would cross water
        const N = 48, ring = [];
        for (let i = 0; i <= N; i++) {
          const a = (i % N) / N * Math.PI * 2;
          const rr = t.R * (1 + 0.12 * (fbm(Math.cos(a) * 2 + t.x / 1e4, Math.sin(a) * 2 + t.y / 1e4, 167) - 0.5) * 2);
          ring.push([t.x + Math.cos(a) * rr, t.y + Math.sin(a) * rr]);
        }
        let run = [];
        const flush = () => { if (run.length > 1) walls.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: run.map(toLL) } }); run = []; };
        ring.forEach((v, i) => {
          if (isWater(v[0], v[1])) { flush(); return; }
          run.push(v);
          if (i % 6 === 0 && i < N) marks.push(['lm_walltower', v[0], v[1]]);
          // gate where a visible road crosses
          if (i > 0) {
            const [d, s] = roadSegs.nearest(v[0], v[1]);
            if (s && d < 25 * k && !gateHits.some((g) => Math.hypot(g[0] - v[0], g[1] - v[1]) < t.R * 0.5)) { gateHits.push(v); marks.push(['lm_gate', v[0], v[1]]); }
          }
        });
        flush();
      }
    }
    // water life: quays + boats + cranes in busy places, fishing huts and mills elsewhere
    const seen = new Set();
    for (const p of pieces) {
      if (p.ctx.dWm > 45) continue;
      const g = Math.floor(p.cx / (S * 2.5)) + ',' + Math.floor(p.cy / (S * 2.5));
      if (seen.has(g)) continue;
      seen.add(g);
      const [, seg] = shoreSegs.nearest(p.cx, p.cy);
      if (!seg) continue;
      const mx = (seg[0] + seg[2]) / 2, my = (seg[1] + seg[3]) / 2;
      const nx = -(seg[3] - seg[1]), ny = seg[2] - seg[0], L = Math.hypot(nx, ny) || 1;
      const off = 14 * k;
      const pA = [mx + nx / L * off, my + ny / L * off], pB = [mx - nx / L * off, my - ny / L * off];
      const wet = isWater(...pA) ? pA : isWater(...pB) ? pB : null;
      const busy = p.ctx.w > 0.1 && p.ctx.tr < 3;
      const hh = hash(Math.round(mx), Math.round(my), 173);
      if (busy) {
        if (wet && hh < 0.7) put(wet[0], wet[1], `s_boat_${Math.floor(hh * 4.2) % 3}`, 0.9 + hh * 0.4);
        if (hh < 0.18 && free(mx, my, 20)) marks.push(['lm_dockcrane', mx, my]);
      } else if (p.ctx.tr < 3.5) {
        if (hh < 0.25 && free(p.cx, p.cy, 20) && !isWater(p.cx, p.cy)) marks.push([seg[4] === 'river' || seg[4] === 'stream' ? 'lm_watermill' : 'lm_fishhut', p.cx, p.cy]);
        else if (wet && hh < 0.45) put(wet[0], wet[1], 's_boat_0', 0.8);
      } else if (wet && hh < 0.15) put(wet[0], wet[1], 's_boat_0', 0.75);
    }
  }
  const markFeats = marks.filter(([, x, y]) => !isWater(x, y)).map(([icon, x, y]) => ({ type: 'Feature', properties: { icon }, geometry: { type: 'Point', coordinates: toLL([x, y]) } }));
  // quays: shore segments next to busy town land
  const quays = [];
  if (detail) {
    for (const [, segs] of shoreSegs.b) for (const s of segs) {
      if (s[4] !== 'shore' || s._q) continue;
      s._q = 1;
      const mx = (s[0] + s[2]) / 2, my = (s[1] + s[3]) / 2;
      const c = cellAt(mx, my), [, tr] = nearestTown(mx, my);
      if ((c?.w || 0) > 0.1 && tr < 2.5) quays.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [toLL([s[0], s[1]]), toLL([s[2], s[3]])] } });
    }
  }

  // --- stats: share of plain fields on screen
  let total = 0, fieldA = 0;
  const counts = {};
  for (const p of pieces) {
    if (p.cx < vx0 || p.cx > vx1 || p.cy < vy0 || p.cy > vy1) continue;
    total += p.area; counts[p.t] = (counts[p.t] || 0) + p.area;
    if (TYPES[p.t].fieldish) fieldA += p.area;
  }
  stats.types = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, a]) => `${t} ${Math.round(a / total * 100)}%`).join(', ');
  stats.fields = `${Math.round(fieldA / total * 100)}% plain fields, ${Object.keys(counts).length} land types in view`;
  stats.world = `${seeds.length} seeds → ${pieces.length} patches, ${scatter.length} symbols, ${markFeats.length} landmarks · ${Math.round(performance.now() - t0)} ms`;
  const FC = (f) => ({ type: 'FeatureCollection', features: f });
  return { cells: FC(cellFeats), borders: FC(borderFeats), scatter: FC(scatter), walls: FC(walls), marks: FC(markFeats), quays: FC(quays), stats };
}
