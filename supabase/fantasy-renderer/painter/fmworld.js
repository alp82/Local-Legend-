// The world plan: every decision that more than one tile can see, made once per fixed world cell from a
// fixed window of real data, so every tile, chunk or view that asks gets the same answer.
//
// - Point queries (water, wood, buildings, streets) read per-z14-data-tile indexes. A point's answer
//   depends only on the data tiles round that point, never on who asks.
// - Village hearts are decided on a fixed 480 m world grid, farmstead compounds on the 160 m block grid,
//   road survival per real road piece, bridges per real bridge. Where the old greedy passes said "first
//   come first served", the rule is now "the stronger one wins" (by building mass, then position), written
//   as a recursion over the stronger neighbours. That is the greedy result itself, computed locally.
// - Everything is memoised; a result is stored only after it was computed from complete data
//   (tiledata.js throws NeedTiles instead of answering from a partial window), and recomputing anything
//   gives the same value, so cache order and cache eviction never change a picture.
//
// Distances are map metres × KF (one global constant, fmcore.js).
import { KF, WORLD, HALF, hash, toLL, toM, H01, Index, inPoly, bboxOf, ringArea, polysM, linesM, lineLen, distToLine } from './fmcore.js';
import { tileFeatures, TS14 } from './tiledata.js';

// ---------------------------------------------------------------- the world grid
export const TILE = WORLD / 2 ** 16;  // a z16 tile: the chunk, the plan cell and the server's paint unit
export const DG = 20 * KF;            // building-mass grid
export const HN = 24, BN = 8;         // a heart cell is 24 × 24 mass cells (480 m), a block 8 × 8 (160 m)
export const HCELL = HN * DG, BLOCK = BN * DG;
export const RC = TILE / 3;           // repeat-rule cells: three per tile side, so a cell never spans two plans
export const LCELL = HCELL;           // one label per name per 480 m cell
const BUF = 120;                      // how far a data tile's clipped geometry reaches past its edge (mercator)
const gIdx = (v) => Math.floor(v / DG);
const hIdx = (v) => Math.floor(gIdx(v) / HN), bIdx = (v) => Math.floor(gIdx(v) / BN);

// the sprite index (sizes, footprints, entrances) and which sprites exist: set by painter5.js once the atlas is in
let IDX = {}, HAS = () => false;
export function setAtlas(idx, has) { IDX = idx; HAS = has; }

const memo = (fn, max = 40000) => {
  const m = new Map();
  const f = (...a) => { const key = a.join('|'); if (m.has(key)) return m.get(key); const v = fn(...a); m.set(key, v); if (m.size > max) m.delete(m.keys().next().value); return v; };
  return f;
};
const perTile = (build) => memo((tx, ty) => build(tx, ty), 300);

// ---------------------------------------------------------------- data tiles round a point or box
const tileBox = (tx, ty) => [tx * TS14 - HALF, HALF - (ty + 1) * TS14, (tx + 1) * TS14 - HALF, HALF - ty * TS14];
function tilesIn(bb) {
  const out = [], x0 = Math.floor((bb[0] + HALF) / TS14), x1 = Math.floor((bb[2] + HALF) / TS14), y0 = Math.floor((HALF - bb[3]) / TS14), y1 = Math.floor((HALF - bb[1]) / TS14);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}
const around = (x, y, r) => tilesIn([x - r - BUF, y - r - BUF, x + r + BUF, y + r + BUF]);
const inside = (x, y, b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3];
const push = (m, k, v) => { let L = m.get(k); if (!L) m.set(k, (L = [])); L.push(v); };
/** Points every `step` along a polyline (fn(x, y, angle)). */
function sample(pts, step, fn) {
  for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step)), a = Math.atan2(by - ay, bx - ax); for (let m = 0; m <= n; m++) fn(ax + (bx - ax) * m / n, ay + (by - ay) * m / n, a); }
}

// ---------------------------------------------------------------- regions of the world
export const lowlandsAt = (x, y) => { const [lng, lat] = toLL([x, y]); return lng > 2 && lng < 15 && lat > 50.5; };
export const alpineAt = (x, y) => { const [lng, lat] = toLL([x, y]); return lng > 5.5 && lng < 16.5 && lat > 45.5 && lat < 48.3; };
export const americaAt = (x) => toLL([x, 0])[0] < -50;

// ---------------------------------------------------------------- water, land cover
const STILL = new Set(['lake', 'pond', 'reservoir', 'basin', 'swimming_pool']);
/** Is a water polygon big enough to paint (the same rule everywhere). */
export const waterKeeps = (m, cls) => { const a = ringArea(m[0]) / (KF * KF); return a > 900 || (['river', 'ocean'].includes(cls) && a > 40); };
const waterOf = perTile((tx, ty) => {
  const idx = new Index(150 * KF);
  for (const f of tileFeatures('water', tx, ty)) {
    if (f.properties.brunnel === 'tunnel') continue;
    for (const m of polysM(f)) if (waterKeeps(m, f.properties.class)) { m.still = STILL.has(f.properties.class) || !!f.properties.intermittent; m.river = f.properties.class === 'river'; idx.add(m, f.properties); }
  }
  return idx;
});
/** The water polygon under a point, or null. */
export function waterPolyAt(x, y) { for (const [tx, ty] of around(x, y, 0)) { const it = waterOf(tx, ty).at(x, y); if (it) return it; } return null; }
export const waterAt = (x, y) => !!waterPolyAt(x, y);
export const onLand = (x, y, r = 0) => !waterAt(x, y) && (!r || [0, 1, 2, 3, 4, 5, 6, 7].every((a) => !waterAt(x + Math.cos(a * 0.785) * r, y + Math.sin(a * 0.785) * r)));
export const footDry = (x, y, halfW) => onLand(x, y, halfW) && onLand(x, y + halfW * 0.5, halfW * 0.7);

const landOf = perTile((tx, ty) => {
  const G = 150 * KF, L = { wood: new Index(G), park: new Index(G), cemetery: new Index(G), orchard: new Index(G), farm: new Index(G) };
  for (const f of tileFeatures('landcover', tx, ty)) for (const m of polysM(f)) {
    const c = f.properties.class, s = f.properties.subclass;
    if (c === 'wood') L.wood.add(m, f.properties);
    else if (c === 'farmland' && s !== 'orchard' && s !== 'vineyard') L.farm.add(m, f.properties);
    else if (s === 'orchard' || s === 'vineyard') L.orchard.add(m, f.properties);
    else if (c === 'grass' && ['park', 'garden', 'recreation_ground', 'village_green'].includes(s)) L.park.add(m, f.properties);
  }
  for (const f of tileFeatures('park', tx, ty)) if (['park', 'garden'].includes(f.properties.class)) for (const m of polysM(f)) L.park.add(m, f.properties);
  for (const f of tileFeatures('landuse', tx, ty)) if (f.properties.class === 'cemetery') for (const m of polysM(f)) L.cemetery.add(m, f.properties);
  return L;
});
const landAt = (kind) => (x, y) => { for (const [tx, ty] of around(x, y, 0)) { const it = landOf(tx, ty)[kind].at(x, y); if (it) return it; } return null; };
export const woodAt = landAt('wood'), parkAt = landAt('park'), cemeteryAt = landAt('cemetery'), orchardAt = landAt('orchard'), farmAt = landAt('farm');

// ---------------------------------------------------------------- buildings (as mass: centre and area)
// Each building counts in the data tile that holds the centre of its box, so it counts once.
const bldOf = perTile((tx, ty) => {
  const b = tileBox(tx, ty), cells = new Map();
  for (const f of tileFeatures('building', tx, ty, true)) {
    const m = f.mbb, cx = (m[0] + m[2]) / 2, cy = (m[1] + m[3]) / 2; if (!inside(cx, cy, b)) continue;
    push(cells, gIdx(cx) + ',' + gIdx(cy), [cx, cy, (m[2] - m[0]) * (m[3] - m[1]) / (KF * KF) * 0.5]); // a footprint fills about half its box
  }
  return cells;
});
function forBld(bb, fn) {
  for (const [tx, ty] of tilesIn(bb)) { const cells = bldOf(tx, ty); for (let i = gIdx(bb[0]); i <= gIdx(bb[2]); i++) for (let j = gIdx(bb[1]); j <= gIdx(bb[3]); j++) for (const b of cells.get(i + ',' + j) || []) fn(b); }
}
/** Real buildings within r of a point: count, area, mean size and the share of ground they cover. */
export function localStats(x, y, r) {
  let nb = 0, area = 0;
  forBld([x - r, y - r, x + r, y + r], (b) => { if (Math.hypot(b[0] - x, b[1] - y) < r) { nb++; area += b[2]; } });
  return { nb, area, avg: nb ? area / nb : 0, cover: Math.min(1, area / (Math.PI * (r / KF) ** 2)) };
}

// ---------------------------------------------------------------- points of interest and places
const poisOf = perTile((tx, ty) => {
  const b = tileBox(tx, ty), out = [];
  for (const f of tileFeatures('poi', tx, ty)) { if (f.geometry.type !== 'Point') continue; const [x, y] = toM(f.geometry.coordinates); if (inside(x, y, b)) out.push({ ...f.properties, x, y }); }
  return out;
});
export function poisIn(bb) { const out = []; for (const [tx, ty] of tilesIn(bb)) for (const p of poisOf(tx, ty)) if (inside(p.x, p.y, bb)) out.push(p); return out; }
const placesOf = perTile((tx, ty) => {
  const b = tileBox(tx, ty), out = [];
  for (const f of tileFeatures('place', tx, ty)) { if (f.geometry.type !== 'Point' || !f.properties.name) continue; const m = toM(f.geometry.coordinates); if (inside(m[0], m[1], b)) out.push({ name: f.properties['name:latin'] || f.properties.name, cls: f.properties.class, m }); }
  return out;
});
const placesIn = (bb) => { const out = []; for (const [tx, ty] of tilesIn(bb)) for (const p of placesOf(tx, ty)) if (inside(p.m[0], p.m[1], bb)) out.push(p); return out; };
const anchorOf = (p) => {
  const c = p.class, n = p.name || '';
  if (c === 'marketplace' || p.subclass === 'marketplace' || (/platz|plein|square|piazza|markt/i.test(n) && ['place', 'marketplace', 'attraction'].includes(c))) return { ...p, kind: 'square', pr: 5 };
  if (c === 'place_of_worship' && n && !/projekt|verein|gruppe|wohn|scientology|center|centre|kingdom|gemeinde|mission|zentrum/i.test(n)) return { ...p, kind: 'church', pr: 4 };
  if (c === 'town_hall') return { ...p, kind: 'hall', pr: 4 };
  if (c === 'railway' && /station|bahnhof|centraal|terminal/i.test(n)) return { ...p, kind: 'station', pr: 3 };
  return null;
};
const anchorsIn = (bb) => poisIn(bb).map(anchorOf).filter(Boolean);
export const churchRe = /kirche|kerk|church|chapel|kapelle|cathedral|dom\b|basilica|münster|abbey|kloster|stift|wallfahrt|st\.|saint|sankt|san |santa |notre|chiesa|igreja|iglesia|minster|priory/i;
export const abbeyName = (n) => /abbey|kloster|stift|wallfahrt|monastery|priory|abtei/i.test(n);

// ---------------------------------------------------------------- waterways
const waterwaysOf = perTile((tx, ty) => {
  const out = [];
  for (const f of tileFeatures('waterway', tx, ty)) { if (f.properties.brunnel === 'tunnel' && !['stream', 'ditch', 'drain'].includes(f.properties.class)) continue; for (const l of linesM(f)) out.push({ cls: f.properties.class, pts: l, name: f.properties['name:latin'] || f.properties.name, bb: bboxOf([l]) }); }
  return out;
});
export function waterwaysIn(bb) { const out = []; for (const [tx, ty] of tilesIn([bb[0] - BUF, bb[1] - BUF, bb[2] + BUF, bb[3] + BUF])) for (const w of waterwaysOf(tx, ty)) if (w.bb[2] >= bb[0] && w.bb[0] <= bb[2] && w.bb[3] >= bb[1] && w.bb[1] <= bb[3]) out.push(w); return out; }
const nearLine = (cls, r) => (x, y) => waterwaysIn([x - r, y - r, x + r, y + r]).some((w) => cls.includes(w.cls) && distToLine(x, y, w.pts) < r);
const canalNear = nearLine(['canal'], 300 * KF);
/** Canal-city water (the Low Countries' canal rings): cached on a 40 m world grid. */
export const canalish = memo((i, j) => { const x = i * 40 * KF, y = j * 40 * KF; return lowlandsAt(x, y) && canalNear(x, y); });
export const canalAt = (x, y) => canalish(Math.round(x / (40 * KF)), Math.round(y / (40 * KF)));
const riverNear = nearLine(['river'], 150 * KF);
export const riverAt = memo((i, j) => riverNear(i * 40 * KF, j * 40 * KF));
export const riverish = (x, y) => riverAt(Math.round(x / (40 * KF)), Math.round(y / (40 * KF)));

// ---------------------------------------------------------------- streets
const STREET = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']);
export const MAINC = new Set(['motorway', 'trunk', 'primary', 'secondary']);
export const ROADW = { motorway: 12, trunk: 11, primary: 10, secondary: 9, tertiary: 7, minor: 5.5, service: 4 };
/** The road pieces of one data tile (each real line as the tile delivers it, with a stable key). */
const piecesOf = perTile((tx, ty) => {
  const out = [];
  tileFeatures('transportation', tx, ty).forEach((f, fi) => {
    const c = f.properties.class; if (f.properties.brunnel === 'tunnel' || !STREET.has(c)) return;
    linesM(f).forEach((pts, li) => { if (pts.length < 2) return; out.push({ key: `${tx}/${ty}/${fi}/${li}`, cls: c, pts, main: MAINC.has(c), oneway: f.properties.oneway === 1, w: ROADW[c], bb: bboxOf([pts]), len: lineLen(pts) }); });
  });
  return out;
});
const bridgesOf = perTile((tx, ty) => {
  const out = [];
  tileFeatures('transportation', tx, ty).forEach((f, fi) => { const c = f.properties.class; if (f.properties.brunnel !== 'bridge' || ['rail', 'transit'].includes(c)) return; linesM(f).forEach((pts, li) => { if (pts.length >= 2) out.push({ key: `${tx}/${ty}/${fi}/${li}`, c, pts, bb: bboxOf([pts]) }); }); });
  return out;
});
const ovl = (a, b) => a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];
export function piecesIn(bb) { const out = []; for (const [tx, ty] of tilesIn([bb[0] - BUF, bb[1] - BUF, bb[2] + BUF, bb[3] + BUF])) for (const p of piecesOf(tx, ty)) if (ovl(p.bb, bb)) out.push(p); return out; }
export function bridgesIn(bb) { const out = []; for (const [tx, ty] of tilesIn([bb[0] - BUF, bb[1] - BUF, bb[2] + BUF, bb[3] + BUF])) for (const p of bridgesOf(tx, ty)) if (ovl(p.bb, bb)) out.push(p); return out; }
const dens = (pts, st) => { const o = []; sample(pts, st, (x, y) => o.push([x, y])); return o; };
/** A dual carriageway is one track: a oneway main line that runs beside a stronger (earlier keyed) one of its class. */
const mergedAway = memo((key) => {
  const P = pieceByKey(key);
  if (!P.oneway || !['motorway', 'trunk', 'primary'].includes(P.cls)) return false;
  const r = 40 * KF, others = piecesIn([P.bb[0] - r, P.bb[1] - r, P.bb[2] + r, P.bb[3] + r]).filter((Q) => Q.oneway && Q.cls === P.cls && Q.key < P.key && Q.key !== P.key && !mergedAway(Q.key));
  if (!others.length) return false;
  const d = dens(P.pts, 12 * KF);
  return d.filter(([x, y]) => others.some((Q) => distToLine(x, y, Q.pts) < r)).length >= d.length * 0.85;
});
const pieceByKey = (key) => { const [tx, ty] = key.split('/').map(Number); return piecesOf(tx, ty).find((p) => p.key === key); };
export const streetsIn = (bb) => piecesIn(bb).filter((P) => !mergedAway(P.key));
// street samples every 4 m in 12 m buckets, per data tile: the distance from a point to the nearest street edge
const SG = 12 * KF;
const streetHashOf = perTile((tx, ty) => { const h = new Map(); for (const P of piecesOf(tx, ty)) { if (mergedAway(P.key)) continue; sample(P.pts, 4 * KF, (x, y, a) => push(h, Math.floor(x / SG) + ',' + Math.floor(y / SG), [x, y, P.w * KF / 2, a, P.main])); } return h; });
export function streetNear(x, y, r = 40 * KF) {
  let best = null, bd = Infinity;
  for (const [tx, ty] of around(x, y, r)) { const h = streetHashOf(tx, ty); for (let i = Math.floor((x - r) / SG); i <= Math.floor((x + r) / SG); i++) for (let j = Math.floor((y - r) / SG); j <= Math.floor((y + r) / SG); j++) for (const s of h.get(i + ',' + j) || []) { const d = Math.hypot(s[0] - x, s[1] - y) - s[2]; if (d < bd) { bd = d; best = s; } } }
  return [bd / KF, best];
}
// main roads (and tertiary) every 15 m in 40 m buckets: where people are
const MG = 40 * KF;
const mainHashOf = perTile((tx, ty) => { const h = new Map(); for (const P of piecesOf(tx, ty)) { if (!(P.main || P.cls === 'tertiary') || mergedAway(P.key)) continue; sample(P.pts, 15 * KF, (x, y, a) => push(h, Math.floor(x / MG) + ',' + Math.floor(y / MG), [x, y, a])); } return h; });

// ---------------------------------------------------------------- building mass and village hearts
function boxBlur(src, GW, GH, r) {
  const a = new Float32Array(src.length), b3 = new Float32Array(src.length);
  for (let j = 0; j < GH; j++) { let s2 = 0; for (let i = -r; i < GW + r; i++) { if (i + r < GW && i + r >= 0) s2 += src[j * GW + i + r]; if (i - r - 1 >= 0 && i - r - 1 < GW) s2 -= src[j * GW + i - r - 1]; if (i >= 0 && i < GW) a[j * GW + i] = s2 / (2 * r + 1); } }
  for (let i = 0; i < GW; i++) { let s2 = 0; for (let j = -r; j < GH + r; j++) { if (j + r < GH && j + r >= 0) s2 += a[(j + r) * GW + i]; if (j - r - 1 >= 0 && j - r - 1 < GH) s2 -= a[(j - r - 1) * GW + i]; if (j >= 0 && j < GH) b3[j * GW + i] = s2 / (2 * r + 1); } }
  return b3;
}
/** Building mass of one heart cell on its 20 m grid: real building area, blurred twice over 13 cells (reach 240 m). */
const massCell = memo((I, J) => {
  const P = 14, GW = HN + 2 * P, gi0 = I * HN - P, gj0 = J * HN - P, raw = new Float32Array(GW * GW);
  forBld([gi0 * DG, gj0 * DG, (gi0 + GW) * DG - 1e-6, (gj0 + GW) * DG - 1e-6], (b) => { const i = gIdx(b[0]) - gi0, j = gIdx(b[1]) - gj0; if (i >= 0 && j >= 0 && i < GW && j < GW) raw[j * GW + i] += b[2] / 400; });
  const m = boxBlur(boxBlur(raw, GW, GW, 6), GW, GW, 6), out = new Float32Array(HN * HN);
  for (let j = 0; j < HN; j++) for (let i = 0; i < HN; i++) out[j * HN + i] = m[(j + P) * GW + i + P];
  return out;
});
export const massAt = (x, y) => { const gi = gIdx(x), gj = gIdx(y), I = Math.floor(gi / HN), J = Math.floor(gj / HN); return massCell(I, J)[(gj - J * HN) * HN + (gi - I * HN)]; };
/** The strongest mass cell of one 160 m block (a candidate for a heart or a farmstead), or null. */
const blockPeak = memo((bi, bj) => {
  const I = Math.floor(bi * BN / HN), J = Math.floor(bj * BN / HN), M = massCell(I, J), oi = bi * BN - I * HN, oj = bj * BN - J * HN;
  let best = -1, x = 0, y = 0;
  for (let j = oj; j < oj + BN; j++) for (let i = oi; i < oi + BN; i++) { const v = M[j * HN + i]; if (v > best) { best = v; x = i; y = j; } }
  return best > 0.03 ? { x: (I * HN + x + 0.5) * DG, y: (J * HN + y + 0.5) * DG, m: best } : null;
});
const placeBonus = (x, y) => {
  const near = [], i0 = Math.floor(x / MG), j0 = Math.floor(y / MG);
  for (const [tx, ty] of around(x, y, 80 * KF)) { const h = mainHashOf(tx, ty); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const q of h.get((i0 + a) + ',' + (j0 + b)) || []) if (Math.hypot(q[0] - x, q[1] - y) < 40 * KF) near.push(q[2]); }
  let k3 = 1; if (near.length) k3 *= 1.25; if (near.some((a) => near.some((b) => Math.abs(Math.sin(a - b)) > 0.5))) k3 *= 1.15;
  if (waterAt(x + 60 * KF, y) || waterAt(x - 60 * KF, y) || waterAt(x, y + 60 * KF) || waterAt(x, y - 60 * KF)) k3 *= 1.35; // the old towns stand on the water
  if (bridgesIn([x - 160 * KF, y - 160 * KF, x + 160 * KF, y + 160 * KF]).some((br) => Math.hypot(br.pts[0][0] - x, br.pts[0][1] - y) < 160 * KF)) k3 *= 1.2; // ... by their bridge
  return k3;
};
const cellBox = (I, J) => [I * HCELL, J * HCELL, (I + 1) * HCELL, (J + 1) * HCELL];
const inCell = (x, y, I, J) => hIdx(x) === I && hIdx(y) === J;
const stronger = (a, b) => a.m > b.m || (a.m === b.m && (a.x < b.x || (a.x === b.x && a.y < b.y)));
export const tierOf = (m) => (m > 0.4 ? 3 : m > 0.22 ? 2 : m > 0.1 ? 1 : 0);
const SPACING = [360, 400, 460, 540], RADIUS = [58, 78, 96, 112];
const MIND = 400 * KF, MIND_SMALL = 460 * KF;
/** The best place for a village heart in one 480 m cell: the densest real spot (or an important church or
 *  square), weighted towards main roads, water and bridges and towards the cell's middle. */
const heartRaw = memo((I, J) => {
  const cand = [];
  for (let b = 0; b < 3; b++) for (let a = 0; a < 3; a++) { const p = blockPeak(I * 3 + a, J * 3 + b); if (p) cand.push(p); }
  for (const a of anchorsIn(cellBox(I, J))) { if ((a.kind !== 'church' && a.kind !== 'square') || !inCell(a.x, a.y, I, J)) continue; const imp = a.rank != null ? Math.max(0, (25 - a.rank) / 25) : 0.2; cand.push({ x: a.x, y: a.y, m: massAt(a.x, a.y) * (1.6 + imp * 0.8), anchorFirst: a }); }
  const score = (c) => { const fx = (gIdx(c.x) - I * HN + 0.5) / HN - 0.5, fy = (gIdx(c.y) - J * HN + 0.5) / HN - 0.5; return c.m * placeBonus(c.x, c.y) * (1 - 0.6 * Math.hypot(fx, fy)); };
  let best = null, bs = -1;
  for (const c of cand) { if (c.m < 0.06) continue; const s = score(c); if (s > bs || (s === bs && stronger(c, best))) { bs = s; best = c; } }
  return best;
});
const rawTier = (c) => tierOf(c.anchorFirst ? c.m / 1.8 : c.m);
/** Is the cell's candidate a heart (no stronger heart crowds it), and where exactly it stands. */
const heartPos = memo((I, J) => {
  const c0 = heartRaw(I, J); if (!c0) return null;
  const t = rawTier(c0);
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
    if (!a && !b) continue; const n = heartRaw(I + a, J + b); if (!n || !stronger(n, c0)) continue;
    if (Math.hypot(n.x - c0.x, n.y - c0.y) < (t <= 1 || rawTier(n) <= 1 ? MIND_SMALL : MIND) && heartPos(I + a, J + b)) return null;
  }
  // snap to the most meaningful real place within reach
  let anchor = c0.anchorFirst || null, as = -1;
  if (!anchor) for (const a of anchorsIn([c0.x - 190 * KF, c0.y - 190 * KF, c0.x + 190 * KF, c0.y + 190 * KF])) { const d = Math.hypot(a.x - c0.x, a.y - c0.y); if (d > 190 * KF) continue; const sc = a.pr * 100 - d / KF; if (sc > as || (sc === as && (a.x < anchor.x || (a.x === anchor.x && a.y < anchor.y)))) { as = sc; anchor = a; } }
  let x = c0.x, y = c0.y;
  if (anchor) {
    x = anchor.x; y = anchor.y;
    if (anchor.kind === 'church') { // the square opens in front of the church, towards the village
      let dx = c0.x - anchor.x, dy = c0.y - anchor.y, L = Math.hypot(dx, dy); if (L < 10 * KF) { dx = 0.3; dy = -1; L = Math.hypot(dx, dy); }
      x = anchor.x + dx / L * 55 * KF; y = anchor.y + dy / L * 55 * KF;
    }
  }
  if (waterAt(x, y)) { x = c0.x; y = c0.y; if (waterAt(x, y)) return null; }
  return { x, y, x0: c0.x, y0: c0.y, m: c0.m, t, anchor };
});
/** Hearts whose cells lie within `cells` of cell (I, J), each with its cell. */
const heartsAround = (I, J, cells) => { const out = []; for (let b = -cells; b <= cells; b++) for (let a = -cells; a <= cells; a++) { const p = heartPos(I + a, J + b); if (p) out.push([I + a, J + b, p]); } return out; };
const HEART_SETS = {
  hamlet: ['hamlet-well-yard', 'hamlet-red-barn', 'hamlet-orchard-crossing', 'hamlet-limewashed'],
  village: ['village-chapel-green', 'village-red-square', 'village-crossroads', 'village-willow-well', 'village-timber-commons'],
  town: ['town-market-limestone', 'town-red-gables', 'town-cobbled-cross', 'town-golden-thatch', 'town-orchard-market'],
  walled: ['walled-town-limestone', 'walled-town-red-roofs', 'walled-town-grey-corner'],
  alpine: ['alpine-chapel-common', 'alpine-red-roof-inn', 'alpine-stone-terrace'],
  canal: ['market-quay', 'red-gable-canal', 'canal-chapel-court', 'quay-workshops'],
};
const spImgM = (n) => IDX[n].foot_m[0] * 1.12; // the image spans about 1.12 × the east-west footprint
/** A set piece's footprint and entrances with its anchor on (x, y). */
export function pieceGeom(name, x, y, o = {}) {
  const m = IDX[name], wM = o.wM || spImgM(name) * (o.k || 1), hM = wM * m.h / m.w, flip = !!o.flip, kk = wM / spImgM(name);
  const pc = { name, x, y, wM, hM, flip, fw: m.foot_m[0] * kk, fh: m.foot_m[1] * kk, z: o.z ?? -0.5 };
  pc.cx = x + ((flip ? -1 : 1) * (0.5 - m.ax)) * wM * KF; pc.cy = y - (0.5 - m.ay) * hM * KF * 0.9;
  pc.ports = (m.ports || []).map((p) => ({ x: x + (flip ? -1 : 1) * (p.uv[0] - m.ax) * wM * KF, y: y - (p.uv[1] - m.ay) * hM * KF, main: p.role === 'main' }));
  return pc;
}
const waterSide = (x, y, r) => {
  let best = null, bd = Infinity;
  for (let a = 0; a < 16; a++) { const ca = Math.cos(a / 16 * 6.283), sa = Math.sin(a / 16 * 6.283); for (let d = 15; d <= r; d += 10) if (waterAt(x + ca * d * KF, y + sa * d * KF)) { if (d < bd) { bd = d; best = [ca, sa]; } break; } }
  if (!best) return null;
  return { side: Math.abs(best[0]) > Math.abs(best[1]) ? (best[0] < 0 ? 'west' : 'east') : (best[1] < 0 ? 'south' : 'north'), d: bd, ex: best[0] };
};
const shortName = (n) => { let s3 = n.split(/ der | des | zur | - |\(|,/)[0].trim(); if (s3.length > 26) s3 = s3.slice(0, 26).replace(/\s+\S*$/, ''); return s3; };
export { shortName };
/** The heart of cell (I, J): where it stands, its tier, name, church, set piece (name, size, flip, footprint,
 *  entrances), square axis. Null when the cell has none. */
export const heartAt = memo((I, J) => {
  const p = heartPos(I, J); if (!p) return null;
  const h = { ...p, I, J, key: I + ',' + J, R: RADIUS[p.t] * KF, sp: SPACING[3 - p.t] * KF };
  // the main street direction at the heart, and its square along it
  let sx2 = 0, sy2 = 0;
  for (let a = 0; a < 16; a++) { const [, s] = streetNear(h.x + Math.cos(a / 16 * 6.283) * 30 * KF, h.y + Math.sin(a / 16 * 6.283) * 30 * KF, 50 * KF); if (s) { const w = s[4] ? 2 : 1; sx2 += Math.cos(2 * s[3]) * w; sy2 += Math.sin(2 * s[3]) * w; } }
  h.ang = Math.atan2(sy2, sx2) / 2; h.pa = (17 + 5 * h.t) * KF; h.pb = (12 + 4 * h.t) * KF;
  // its own church
  const churches = poisIn([h.x - 120 * KF, h.y - 120 * KF, h.x + 120 * KF, h.y + 120 * KF]).filter((c) => c.class === 'place_of_worship' && c.name && churchRe.test(c.name));
  const nearest = (L, x, y, r) => { let best = null, bd = r; for (const c of L) { const d = Math.hypot(c.x - x, c.y - y); if (d < bd || (d === bd && best && c.x < best.x)) { bd = d; best = c; } } return best; };
  h.church = h.anchor && h.anchor.kind === 'church' ? nearest(churches, h.anchor.x, h.anchor.y, 30 * KF) : nearest(churches, h.x, h.y, h.R * 0.9);
  // a palace or castle in a big heart
  if (h.t >= 2) { const hall = poisIn([h.x - h.R * 2, h.y - h.R * 2, h.x + h.R * 2, h.y + h.R * 2]).filter((q) => (q.class === 'castle' || (['attraction', 'museum', 'castle'].includes(q.class) && /palace|palais|schloss|paleis/i.test(q.name || ''))) && Math.hypot(q.x - h.x, q.y - h.y) < h.R * 2).sort((a, b) => a.x - b.x || a.y - b.y)[0]; if (hall) h.castle = { name: `castle_${h.t === 3 ? 3 : 2}`, label: hall.name, x: hall.x, y: hall.y }; }
  // name: the nearest real neighbourhood or village label that no stronger heart nearby has taken
  const used = new Set();
  for (const [a, b, q] of heartsAround(I, J, 3)) if ((a !== I || b !== J) && stronger(q, p) && Math.hypot(q.x - h.x, q.y - h.y) < 1300 * KF) { const n = heartAt(a, b).name; if (n && !heartAt(a, b).nameIsAnchor) used.add(n); }
  let best = null, bd = 650 * KF;
  for (const pl of placesIn([h.x - bd, h.y - bd, h.x + bd, h.y + bd])) { if (used.has(pl.name) || !['suburb', 'quarter', 'neighbourhood', 'village', 'town', 'hamlet'].includes(pl.cls)) continue; const d = Math.hypot(pl.m[0] - h.x, pl.m[1] - h.y); if (d < bd || (d === bd && best && pl.name < best.name)) { bd = d; best = pl; } }
  if (best) h.name = best.name;
  else if (h.anchor && h.anchor.name && ((h.anchor.kind === 'church' && /kirche|kerk|church|chapel|kapelle|cathedral|dom\b|basilica|münster|abbey|kloster|st\.|saint|sankt|san |santa |notre|minster/i.test(h.anchor.name)) || (h.anchor.kind === 'square' && /platz|plein|square|piazza|markt|place\b|plaza/i.test(h.anchor.name)))) { h.name = shortName(h.anchor.name); h.nameIsAnchor = true; }
  // the set piece: by tier and setting, never the same drawing as a stronger heart within 1.5 km
  const canal = canalAt(h.x, h.y), ALP = alpineAt(h.x, h.y);
  const takenNear = new Set();
  for (const [a, b, q] of heartsAround(I, J, 4)) if ((a !== I || b !== J) && stronger(q, p) && Math.hypot(q.x - h.x, q.y - h.y) < 1500 * KF) { const pc = heartAt(a, b).piece; if (pc) takenNear.add(pc.name); }
  const ws = waterSide(h.x, h.y, canal ? 170 : 90); h.ws = ws;
  let name = null, flip = false;
  const pickH = (list, seed) => { const l = list.filter((n) => HAS(n) && !takenNear.has(n)); const l2 = l.length ? l : list.filter((n) => HAS(n)); return l2.length ? l2[Math.floor(H01(h.x0, h.y0, seed) * l2.length)] : null; };
  if (h.anchor && h.anchor.kind === 'church' && abbeyName(h.anchor.name || '') && HAS('monastery-cloister-garden')) name = 'monastery-cloister-garden';
  else if (ws && (canal || (ws.d < 60 && ws.side !== 'north'))) {
    const fams = HEART_SETS.canal.filter((f) => HAS(`${f}-water-west`) && HAS(`${f}-water-south`)), free = fams.filter((f) => !takenNear.has(`${f}-water-west`) && !takenNear.has(`${f}-water-south`)), fl = free.length ? free : fams;
    const fam = fl.length ? fl[Math.floor(H01(h.x0, h.y0, 3101) * fl.length)] : null;
    if (fam) { name = ws.side === 'south' ? `${fam}-water-south` : `${fam}-water-west`; flip = ws.side === 'east' || (ws.side === 'north' && ws.ex > 0); }
  } else if (ws && h.t <= 1 && ws.d < 70 && HAS('fishing-hamlet-jetties') && !canal) name = 'fishing-hamlet-jetties';
  if (!name) name = ALP ? pickH(HEART_SETS.alpine, 3103) : pickH(h.t >= 3 ? (H01(h.x0, h.y0, 3105) < 0.4 ? HEART_SETS.walled : HEART_SETS.town) : h.t === 2 ? HEART_SETS.town : h.t === 1 ? HEART_SETS.village : HEART_SETS.hamlet, 3107);
  if (name) {
    // dense hearts carry a bigger piece; never on water: a piece that would touch real water slides away from it
    // (a waterside piece puts its painted quay line on the real bank instead)
    const wM0 = [200, 225, 250, 270][h.t], m0 = IDX[name], kk0 = wM0 / spImgM(name), fw0 = m0.foot_m[0] * kk0, fh0 = m0.foot_m[1] * kk0;
    const wetAt = (x, y) => { let n = 0; for (let u = -0.45; u <= 0.451; u += 0.075) for (let v = -0.45; v <= 0.451; v += 0.09) if (!onLand(x + u * fw0 * KF, y + v * fh0 * KF)) n++; return n; };
    let hx = h.x, hy = h.y, ok = true;
    if (/water/.test(name) && ws && m0.quay) {
      const dir = name.endsWith('south') ? [0, -1] : [flip ? 1 : -1, 0], q = m0.quay, qu = (q[0][0] + q[1][0]) / 2, qv = (q[0][1] + q[1][1]) / 2;
      let bx = null; for (let d = 0; d <= 220; d += 3) { const x = h.x + dir[0] * d * KF, y = h.y + dir[1] * d * KF; if (!onLand(x, y)) { bx = [x - dir[0] * 2 * KF, y - dir[1] * 2 * KF]; break; } }
      if (bx) { const hM0 = wM0 * m0.h / m0.w, ox = (flip ? -1 : 1) * (qu - m0.ax) * wM0 * KF, oy = -(qv - m0.ay) * hM0 * KF; if (dir[0]) hx = bx[0] - ox; else hy = bx[1] - oy; }
    }
    if (!/water/.test(name) && wetAt(hx, hy) > 0) {
      let best2 = null;
      search: for (const d of [20, 40, 60, 80, 110]) for (let a = 0; a < 12; a++) { const x = h.x + Math.cos(a * 0.5236) * d * KF, y = h.y + Math.sin(a * 0.5236) * d * KF; if (!wetAt(x, y)) { best2 = [x, y]; break search; } }
      if (best2) [hx, hy] = best2; else ok = false;
    }
    if (ok) h.piece = pieceGeom(name, hx, hy, { flip, wM: wM0 });
  }
  return h;
});
/** All hearts whose cells overlap a box (expanded by `pad`). */
export function heartsIn(bb, pad = 0) { const out = []; for (let J = hIdx(bb[1] - pad); J <= hIdx(bb[3] + pad); J++) for (let I = hIdx(bb[0] - pad); I <= hIdx(bb[2] + pad); I++) { const h = heartAt(I, J); if (h) out.push(h); } return out; }
/** Where the hearts stand round a box (position, tier and radius only: no name or piece needed). */
export function heartSpotsIn(bb, pad = 0) { const out = []; for (let J = hIdx(bb[1] - pad); J <= hIdx(bb[3] + pad); J++) for (let I = hIdx(bb[0] - pad); I <= hIdx(bb[2] + pad); I++) { const p = heartPos(I, J); if (p) out.push({ ...p, key: I + ',' + J, R: RADIUS[p.t] * KF }); } return out; }
/** The heart nearest a point, measured in heart radii: [heart spot, distance / R]. */
export function nearestHeart(x, y) {
  let best = null, bd = Infinity;
  for (const h of heartSpotsIn([x, y, x, y], 2 * HCELL)) { const d = Math.hypot(h.x - x, h.y - y) / h.R; if (d < bd || (d === bd && h.key < best.key)) { bd = d; best = h; } }
  return [best, bd];
}
/** A city core: a big heart close by or ground well covered with buildings (cached on a 40 m world grid). */
const coreG = memo((i, j) => { const x = i * 40 * KF, y = j * 40 * KF, [h, dh] = nearestHeart(x, y); return (h && h.t >= 2 && dh < 2.4) || localStats(x, y, 60 * KF).cover > 0.3; });
export const coreAt = (x, y) => coreG(Math.round(x / (40 * KF)), Math.round(y / (40 * KF)));

// ---------------------------------------------------------------- farmstead compounds (160 m blocks)
/** A farmstead stands at a block's mass peak away from the hearts, unless a stronger one is too close. */
const steadOK = memo((bi, bj) => {
  const c0 = blockPeak(bi, bj); if (!c0) return false;
  if (heartSpotsIn([c0.x, c0.y, c0.x, c0.y], HCELL).some((h) => Math.hypot(h.x - c0.x, h.y - c0.y) < h.R * 2.6)) return false;
  if (waterAt(c0.x, c0.y) || woodAt(c0.x, c0.y)) return false;
  const D = (c0.m > 0.2 ? 190 : 300) * KF;
  for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) { if (!a && !b) continue; const n = blockPeak(bi + a, bj + b); if (n && stronger(n, c0) && Math.hypot(n.x - c0.x, n.y - c0.y) < D && steadOK(bi + a, bj + b)) return false; }
  return true;
});
const QUILTS = ['field-quilt-ribbon', 'field-quilt-kite', 'field-quilt-step', 'field-quilt-hook'], PADDOCKS = ['paddock-sheep-shelter', 'paddock-cattle-shelter'];
const pickOf = (list, x, y, seed) => { const l = list.filter((n) => HAS(n) && IDX[n]); return l.length ? l[Math.floor(H01(x, y, seed) * l.length)] : null; };
export { pickOf };
const boxHit = (pc, x0, y0, x1, y1) => { const hw = pc.fw * 0.5 * KF, hh = pc.fh * 0.5 * KF; return x1 > pc.cx - hw && x0 < pc.cx + hw && y1 > pc.cy - hh && y0 < pc.cy + hh; };
const kindSeed = (k3) => { let h9 = 7; for (let i = 0; i < k3.length; i++) h9 = (h9 * 31 + k3.charCodeAt(i)) % 9973; return 4000 + h9; };
/** The world repeat rule's hash half: a kind may stand only in about a third of the repeat cells. */
export const kindAllowed = (name, x, y, share = 0.3) => hash(Math.floor(x / RC), Math.floor(y / RC), kindSeed(name.replace(/-(40|80|160)-(ew|ns|ne-sw|nw-se)$/, ''))) <= share;
/** The compound of block (bi, bj): its set piece (and a field quilt or paddock beside it), or null. */
export const compoundAt = memo((bi, bj) => {
  if (!steadOK(bi, bj)) return null;
  const s2 = blockPeak(bi, bj), x = s2.x, y = s2.y;
  const hearts = heartsIn([x, y, x, y], 2 * HCELL);
  const [, dh] = nearestHeart(x, y);
  if (dh < 1.9 || hearts.some((h) => h.piece && Math.hypot(h.piece.cx - x, h.piece.cy - y) < (h.piece.fw * 0.5 + 60) * KF) || localStats(x, y, 70 * KF).nb < 3) return null;
  // what stronger compounds nearby already stand on
  const others = []; for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) { if (!a && !b) continue; const n = blockPeak(bi + a, bj + b); if (n && stronger(n, s2)) { const c = compoundAt(bi + a, bj + b); if (c) others.push(...c.pieces); } }
  const taken = [...hearts.filter((h) => h.piece).map((h) => h.piece), ...others];
  const hitAny = (px, py, r) => taken.some((pc) => boxHit(pc, px - r, py - r * 0.6, px + r, py + r * 0.75));
  if (!footDry(x, y, 30 * KF) || hitAny(x, y, 30 * KF)) return null;
  const stream = waterwaysIn([x - 70 * KF, y - 70 * KF, x + 70 * KF, y + 70 * KF]).some((r) => ['stream', 'river'].includes(r.cls) && r.pts.some((v) => Math.hypot(v[0] - x, v[1] - y) < 70 * KF));
  const woodEdge = [0, 1, 2, 3, 4, 5, 6, 7].some((a) => woodAt(x + Math.cos(a * 0.785) * 70 * KF, y + Math.sin(a * 0.785) * 70 * KF));
  const vine = orchardAt(x, y), dense = localStats(x, y, 90 * KF).cover > 0.18;
  const name = dense ? pickOf(HEART_SETS.hamlet, x, y, 3119) : vine && HAS('vineyard-estate') ? 'vineyard-estate' : stream && HAS('watermill-pond-race') && H01(x, y, 3111) < 0.6 ? 'watermill-pond-race' : woodEdge && HAS('sawmill-wood-edge') && H01(x, y, 3113) < 0.35 ? 'sawmill-wood-edge' : pickOf(['farmstead-blue-yard', 'farmstead-thatch-paddock', 'farmstead-brick-strip', 'farmstead-longhouse', 'farmstead-orchard-gate'], x, y, 3115);
  if (!name || others.some((o) => o.name === name && Math.hypot(o.x - x, o.y - y) < 200 * KF)) return null;
  const pc = pieceGeom(name, x, y, { flip: H01(x, y, 3117) < 0.5 && !/mill|vineyard/.test(name), wM: /^hamlet/.test(name) ? 125 : /mill|vineyard/.test(name) ? 120 : 88 });
  const c = { x, y, m: s2.m, piece: pc, pieces: [pc], key: bi + ',' + bj };
  // a field quilt or a paddock beside it, on open ground
  const extra = H01(x, y, 3119);
  if (extra < 0.55) {
    const n2 = extra < 0.4 ? pickOf(QUILTS, x, y, 3121) : pickOf(PADDOCKS, x, y, 3123);
    if (n2) {
      const side = H01(x, y, 3125) < 0.5 ? -1 : 1, ex = pc.cx + side * (pc.fw / 2 + IDX[n2].foot_m[0] / 2 + 6) * KF, ey = pc.cy - 8 * KF, r = IDX[n2].foot_m[0] * 0.45 * KF;
      if (onLand(ex, ey, r) && !hitAny(ex, ey, r) && !boxHit(pc, ex - r, ey - r * 0.6, ex + r, ey + r * 0.75) && streetNear(ex, ey)[0] > 8 && !woodAt(ex, ey) && kindAllowed(n2, ex, ey)) { const e = pieceGeom(n2, ex, ey, { k: 1.3, z: -0.6 }); e.extra = true; c.pieces.push(e); }
    }
  }
  return c;
});
export function compoundsIn(bb, pad = 0) { const out = []; for (let bj = bIdx(bb[1] - pad); bj <= bIdx(bb[3] + pad); bj++) for (let bi = bIdx(bb[0] - pad); bi <= bIdx(bb[2] + pad); bi++) { const c = compoundAt(bi, bj); if (c) out.push(c); } return out; }

// ---------------------------------------------------------------- lone abbeys (a real monastery away from the hearts)
const churchFirst = memo((x, y) => {
  // a church counts unless a church west of it (or south, at equal x) within 140 m counts
  for (const c of poisIn([x - 140 * KF, y - 140 * KF, x + 140 * KF, y + 140 * KF])) { if (c.class !== 'place_of_worship' || !c.name || !churchRe.test(c.name) || (c.x === x && c.y === y)) continue; if ((c.x < x || (c.x === x && c.y < y)) && Math.hypot(c.x - x, c.y - y) < 140 * KF && churchFirst(c.x, c.y)) return false; }
  return true;
});
/** Abbeys standing alone: the walled monastery piece on its real place, when there is room. */
export function abbeysIn(bb) {
  const out = [];
  for (const c of poisIn(bb)) {
    if (c.class !== 'place_of_worship' || !c.name || !churchRe.test(c.name) || !abbeyName(c.name) || !churchFirst(c.x, c.y)) continue;
    const [, dh] = nearestHeart(c.x, c.y);
    if (heartsIn([c.x, c.y, c.x, c.y], HCELL).some((h2) => h2.church && h2.church.x === c.x && h2.church.y === c.y) || dh <= 1.6) continue;
    const pc = HAS('monastery-cloister-garden') && footDry(c.x, c.y, 50 * KF) ? pieceGeom('monastery-cloister-garden', c.x, c.y, { wM: 160 }) : null;
    out.push({ church: c, piece: pc });
  }
  return out;
}

// ---------------------------------------------------------------- the canonical pieces near a box
/** Every set piece the world plan puts near a box: hearts, compounds (and their quilts), lone abbeys. */
export function canonPieces(bb) {
  const pad = 200 * KF, out = [];
  for (const h of heartsIn(bb, pad)) if (h.piece) out.push(h.piece);
  for (const c of compoundsIn(bb, pad)) out.push(...c.pieces);
  for (const a of abbeysIn([bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad])) if (a.piece) out.push(a.piece);
  return out;
}

// ---------------------------------------------------------------- which roads are drawn
// Main roads everywhere; tertiary roads in the country; lanes in town (every third parallel one), round a
// heart or leading to a set piece's entrance. A lane whose end meets no other drawn road and no set piece is
// a stub and is left out (three rounds, so chains of stubs go too). A main road that ends in the meadow is
// followed one step by the real lane it runs on into. Each rule reads only the piece and the world round it.
const SET_PIECE = /^(hamlet|village|town|walled|alpine|market|red-gable|canal|quay-workshops|farmstead|monastery|watermill|sawmill|vineyard-estate|fishing)/;
export { SET_PIECE };
const roadBase = memo((key) => {
  const P = pieceByKey(key);
  if (mergedAway(key)) return false;
  if (P.main) return true;
  const p0 = P.pts[0];
  if (P.cls === 'tertiary' && !coreAt(p0[0], p0[1]) && localStats(p0[0], p0[1], 60 * KF).nb < 4) return true;
  const ports = canonPieces(P.bb).flatMap((pc) => pc.ports || []);
  if (ports.some((pt) => P.pts.some((q) => Math.hypot(q[0] - pt.x, q[1] - pt.y) < 30 * KF))) return true; // it leads to a set piece's entrance
  const m = P.pts[Math.floor(P.pts.length / 2)];
  if ((!coreAt(m[0], m[1]) && localStats(m[0], m[1], 60 * KF).nb < 4) || P.len <= 40) return false; // town and suburb lanes only
  // in a dense grid only every third parallel lane survives (a world-anchored band across its direction)
  const p1 = P.pts[P.pts.length - 1], a = Math.round(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) / (Math.PI / 18)) * (Math.PI / 18);
  const d = -p0[0] * Math.sin(a) + p0[1] * Math.cos(a);
  return ((Math.floor(d / (90 * KF)) % 3) + 3) % 3 === 0;
});
const inSetPiece = (E) => canonPieces([E[0], E[1], E[0], E[1]]).some((pc) => SET_PIECE.test(pc.name) && Math.abs(E[0] - pc.cx) < pc.fw * 0.45 * KF && Math.abs(E[1] - pc.cy) < pc.fh * 0.45 * KF);
const JOIN = 9 * KF;
/** Does road piece Q really meet piece P at P's end E? Q must pass within 9 m of E and lead somewhere P does not
 *  go (the same road delivered again by the neighbouring data tile, lying on P, joins nothing). */
const meets = (Q, E, P) => {
  if (Q.key === P.key || distToLine(E[0], E[1], Q.pts) >= JOIN) return false;
  let away = false; sample(Q.pts, 3 * KF, (x, y) => { if (!away && Math.hypot(x - E[0], y - E[1]) < 25 * KF && distToLine(x, y, P.pts) > 3 * KF) away = true; });
  return away;
};
const joined = (E, P, test) => piecesIn([E[0] - JOIN, E[1] - JOIN, E[0] + JOIN, E[1] + JOIN]).some((Q) => meets(Q, E, P) && test(Q.key));
const roadKeep = memo((key, d) => {
  if (!roadBase(key)) return false;
  if (d === 0) return true;
  const P = pieceByKey(key);
  if (P.main && P.len >= 200) return true;
  return [P.pts[0], P.pts[P.pts.length - 1]].every((E) => joined(E, P, (k2) => roadKeep(k2, d - 1)) || inSetPiece(E));
});
const kept = (key) => roadKeep(key, 3);
/** A kept through road (main or tertiary) that ends in the meadow (or at a bank) is led on along the real lanes it runs into (at each junction the
 *  lowest-keyed lane), until the chain meets a drawn road or a set piece; within 400 m, or not at all. The chains
 *  are found per heart cell (the cell holding the main road's end). */
const contChains = memo((I, J) => {
  const b = cellBox(I, J), keys = [];
  const nearAt = (E) => piecesIn([E[0] - JOIN, E[1] - JOIN, E[0] + JOIN, E[1] + JOIN]);
  for (const P of piecesIn(b)) {
    if (!(P.main || P.cls === 'tertiary') || !kept(P.key)) continue; // (a through road: main or tertiary)
    for (const E0 of [P.pts[0], P.pts[P.pts.length - 1]]) {
      if (!inside(E0[0], E0[1], b) || inSetPiece(E0) || nearAt(E0).some((Q) => kept(Q.key) && meets(Q, E0, P))) continue;
      // the shortest chain of lanes (at most 8, 400 m) from this end to a drawn road or a set piece
      let queue = [{ E: E0, cur: P, path: [], len: 0 }], found = null; const seen = new Set([P.key]);
      for (let it = 0; queue.length && it < 300 && !found; it++) {
        queue.sort((a, c) => a.len - c.len || (a.path.join() < c.path.join() ? -1 : 1));
        const st = queue.shift();
        for (const nx of nearAt(st.E).filter((Q) => !seen.has(Q.key) && !kept(Q.key) && Q.pts.some((q) => Math.hypot(q[0] - st.E[0], q[1] - st.E[1]) < JOIN)).sort((a, c) => (a.key < c.key ? -1 : 1))) {
          seen.add(nx.key);
          const a0 = nx.pts[0], a1 = nx.pts[nx.pts.length - 1], E = Math.hypot(a0[0] - st.E[0], a0[1] - st.E[1]) > Math.hypot(a1[0] - st.E[0], a1[1] - st.E[1]) ? a0 : a1;
          const path = [...st.path, nx.key], len = st.len + nx.len;
          if (inSetPiece(E) || nearAt(E).some((Q) => Q.key !== P.key && kept(Q.key) && meets(Q, E, nx))) { found = path; break; }
          if (path.length < 8 && len < 400) queue.push({ E, cur: nx, path, len });
        }
      }
      if (found) keys.push(...found);
    }
  }
  return keys;
});
const roadCont = memo((key) => {
  if (kept(key)) return false;
  const Q = pieceByKey(key), r = 420 * KF;
  for (let J = hIdx(Q.bb[1] - r); J <= hIdx(Q.bb[3] + r); J++) for (let I = hIdx(Q.bb[0] - r); I <= hIdx(Q.bb[2] + r); I++) if (contChains(I, J).includes(key)) return true;
  return false;
});
export const roadDrawn = (key) => kept(key) || roadCont(key);
/** A drawn road that stops in the meadow just short of a set piece is led on to the piece's nearest entrance:
 *  [end, entrance, half width] per such end, decided per heart cell (the cell holding the end). */
const endLinks = memo((I, J) => {
  const b = cellBox(I, J), out = [];
  for (const P of piecesIn(b)) {
    if (!roadDrawn(P.key)) continue;
    for (const E of [P.pts[0], P.pts[P.pts.length - 1]]) {
      if (!inside(E[0], E[1], b) || inSetPiece(E)) continue;
      if (piecesIn([E[0] - JOIN, E[1] - JOIN, E[0] + JOIN, E[1] + JOIN]).some((Q) => roadDrawn(Q.key) && meets(Q, E, P))) continue;
      let best = null, bd = 90 * KF;
      for (const pc of canonPieces([E[0] - bd, E[1] - bd, E[0] + bd, E[1] + bd])) if (SET_PIECE.test(pc.name)) for (const pt of pc.ports) { const d = Math.hypot(pt.x - E[0], pt.y - E[1]); if (d < bd || (d === bd && best && pt.x < best.x)) { bd = d; best = pt; } }
      if (best) out.push({ key: P.key + '>' + (E === P.pts[0] ? 0 : 1), pts: [E, [best.x, best.y]], cls: P.cls, main: P.main });
    }
  }
  return out;
});
export const endLinksIn = (bb) => labelCellsIn(bb).flatMap(([I, J]) => endLinks(I, J));
/** The drawn roads near a box. */
export const drawnIn = (bb) => piecesIn(bb).filter((P) => roadDrawn(P.key));
// drawn-road samples per heart cell (4 m apart in 12 m buckets): the distance to the nearest drawn road
const DSG = 12 * KF;
const drawnCell = memo((I, J) => {
  const b = cellBox(I, J), h = new Map();
  for (const P of drawnIn(b)) sample(P.pts, 4 * KF, (x, y) => { if (inside(x, y, b)) push(h, Math.floor(x / DSG) + ',' + Math.floor(y / DSG), [x, y, P.w * KF / 2]); });
  return h;
}, 4000);
function forDrawn(x, y, cells, fn) {
  const i0 = Math.floor(x / DSG), j0 = Math.floor(y / DSG);
  for (let J = hIdx((j0 - cells) * DSG); J <= hIdx((j0 + cells + 1) * DSG); J++) for (let I = hIdx((i0 - cells) * DSG); I <= hIdx((i0 + cells + 1) * DSG); I++) {
    const h = drawnCell(I, J); for (let a = -cells; a <= cells; a++) for (let b = -cells; b <= cells; b++) for (const q of h.get((i0 + a) + ',' + (j0 + b)) || []) fn(q);
  }
}
/** Distance (map metres) from a point to the edge of the nearest drawn road within about 40 m (else Infinity). */
export function drawnNear(x, y) { let bd = Infinity; forDrawn(x, y, 3, (q) => { const d = Math.hypot(q[0] - x, q[1] - y) - q[2]; if (d < bd) bd = d; }); return bd / KF; }
/** The nearest drawn-road sample within about 100 m: [x, y, half width] or null. */
export function nearestDrawn(x, y) { let best = null, bd = Infinity; forDrawn(x, y, 8, (q) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd || (d === bd && (q[0] < best[0] || (q[0] === best[0] && q[1] < best[1])))) { bd = d; best = q; } }); return best; }

// ---------------------------------------------------------------- bridges
const deckQualifies = memo((key) => {
  const [tx, ty] = key.split('/').map(Number), br = bridgesOf(tx, ty).find((b) => b.key === key);
  const a = br.pts[0], b2 = br.pts[br.pts.length - 1]; let nW = 0;
  for (let m = 1; m < 10; m++) if (waterAt(a[0] + (b2[0] - a[0]) * m / 10, a[1] + (b2[1] - a[1]) * m / 10)) nW++;
  const Lm = Math.hypot(b2[0] - a[0], b2[1] - a[1]) || 1, ux = (b2[0] - a[0]) / Lm, uy = (b2[1] - a[1]) / Lm, ex = ux * 6 * KF, ey = uy * 6 * KF;
  if (nW < 3 || !(onLand(a[0], a[1]) || onLand(a[0] - ex, a[1] - ey)) || !(onLand(b2[0], b2[1]) || onLand(b2[0] + ex, b2[1] + ey))) return false;
  const ext = 8 * KF; // a bridge carries a drawn road at both ends
  if (drawnNear(a[0] - ux * ext, a[1] - uy * ext) > 6 && drawnNear(a[0], a[1]) > 6) return false;
  if (drawnNear(b2[0] + ux * ext, b2[1] + uy * ext) > 6 && drawnNear(b2[0], b2[1]) > 6) return false;
  return true;
});
const mid = (br) => [(br.pts[0][0] + br.pts[br.pts.length - 1][0]) / 2, (br.pts[0][1] + br.pts[br.pts.length - 1][1]) / 2];
/** One crossing, one bridge: a qualifying bridge is drawn unless a lower-keyed drawn one is within 40 m. */
const deckOK = memo((key) => {
  if (!deckQualifies(key)) return false;
  const [tx, ty] = key.split('/').map(Number), br = bridgesOf(tx, ty).find((b) => b.key === key), m0 = mid(br), r = 40 * KF;
  return !bridgesIn([m0[0] - r, m0[1] - r, m0[0] + r, m0[1] + r]).some((b2) => b2.key < key && Math.hypot(mid(b2)[0] - m0[0], mid(b2)[1] - m0[1]) < r && deckOK(b2.key));
});
export const decksIn = (bb) => bridgesIn(bb).filter((b) => deckOK(b.key));

// ---------------------------------------------------------------- town water
/** Town water (stone quays, cobbled banks, lilies): canal cities, city cores and round the hearts. */
const townG = memo((i, j) => { const x = i * 40 * KF, y = j * 40 * KF; return canalAt(x, y) || coreAt(x, y) || nearestHeart(x, y)[1] < 3; });
export const townWaterAt = (x, y) => townG(Math.round(x / (40 * KF)), Math.round(y / (40 * KF)));

// ---------------------------------------------------------------- labels
/** The spot for a heart's name: in clear meadow beside its piece, off every drawn road, set piece and water. */
export const heartLabel = memo((I, J, band) => {
  const h = heartAt(I, J); if (!h || !h.name || !goodName(h.name)) return null;
  if (!h.piece) return { name: h.name, wx: h.x, wy: h.y, big: true, pr: 3, fixed: 1 };
  const pc = h.piece, lw = Math.min(26, h.name.length) * 10.5 * Math.pow(2, 16 - band), lh = 22 * Math.pow(2, 16 - band);
  const pcs = canonPieces([pc.cx - 400 * KF, pc.cy - 400 * KF, pc.cx + 400 * KF, pc.cy + 400 * KF]);
  const clearAt = (x, y) => { for (let u = -0.5; u <= 0.51; u += 0.25) for (let v = -0.5; v <= 0.51; v += 0.5) { const px = x + u * lw * KF, py = y + v * lh * KF; if (!onLand(px, py) || drawnNear(px, py) < 3 || pcs.some((q) => Math.abs(px - q.cx) < q.fw * 0.5 * KF && Math.abs(py - q.cy) < q.fh * 0.5 * KF)) return false; } return true; };
  const cands = [[0, -(pc.fh / 2 + lh / 2 + 6)], [0, -(pc.fh / 2 + lh / 2 + 26)], [pc.fw / 2 + lw / 2 + 8, 0], [-(pc.fw / 2 + lw / 2 + 8), 0], [0, -(pc.fh / 2 + lh / 2 + 50)], [pc.fw / 2 + lw / 2 + 8, -pc.fh / 3], [-(pc.fw / 2 + lw / 2 + 8), -pc.fh / 3]];
  let at = null; for (const [dx, dy] of cands) { const x = pc.cx + dx * KF, y = pc.cy + dy * KF; if (clearAt(x, y)) { at = [x, y]; break; } }
  if (!at) at = [pc.cx + cands[0][0] * KF, pc.cy + cands[0][1] * KF];
  return { name: h.name, wx: at[0], wy: at[1], big: true, pr: 3, fixed: 1 };
});
export const goodName = (n) => n && n.length >= 3 && !/^[A-Z0-9 .&-]+$/.test(n);
/** Names along real canals, rivers and main roads: per name, one label per 480 m world cell, at the point of
 *  its 90 m world grid nearest the cell's middle, turned with the line. */
export const lineLabels = memo((I, J) => {
  const b = cellBox(I, J), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, best = new Map();
  const named = [...waterwaysIn(b).filter((r) => r.name && ['canal', 'river'].includes(r.cls)).map((r) => ({ name: r.name, pts: r.pts, water: 1 }))];
  for (const [tx, ty] of tilesIn([b[0] - BUF, b[1] - BUF, b[2] + BUF, b[3] + BUF])) for (const f of tileFeatures('transportation_name', tx, ty)) {
    if (!['primary', 'secondary', 'tertiary', 'trunk'].includes(f.properties.class) || !(f.properties['name:latin'] || f.properties.name)) continue;
    for (const l of linesM(f)) named.push({ name: f.properties['name:latin'] || f.properties.name, pts: l, water: 0 });
  }
  const st = 90 * KF * 0.85, pcs = canonPieces(b), onPiece = (x, y) => pcs.some((q) => Math.abs(x - q.cx) < (q.fw * 0.5 + 12) * KF && Math.abs(y - q.cy) < (q.fh * 0.5 + 8) * KF);
  for (const n of named) for (let i = 1; i < n.pts.length; i++) {
    const [ax, ay] = n.pts[i - 1], [bx, by] = n.pts[i], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy); if (len < 1e-9) continue;
    const hor = Math.abs(dx) >= Math.abs(dy), ta = hor ? ax : ay, tb = hor ? bx : by, lo = Math.min(ta, tb), hi = Math.max(ta, tb);
    for (let kk = Math.ceil(lo / st); kk * st < hi; kk++) {
      const t = (kk * st - ta) / (tb - ta), x = ax + dx * t, y = ay + dy * t; if (!inside(x, y, b) || onPiece(x, y)) continue; // (never over a set piece)
      const nm = shortName(n.name), d = Math.hypot(x - cx, y - cy), o = best.get(nm);
      let deg = -Math.atan2(dy, dx) * 180 / Math.PI; while (deg > 90) deg -= 180; while (deg < -90) deg += 180;
      const rx = Math.round(x * 10) / 10, ry = Math.round(y * 10) / 10;
      if (!o || d < o.d || (d === o.d && (rx < o.wx || (rx === o.wx && ry < o.wy)))) best.set(nm, { name: nm, wx: rx, wy: ry, rot: Math.round(deg * 10) / 10, line: 1, water: n.water, big: false, pr: n.water ? 0.6 : 0.4, fixed: 1, d });
    }
  }
  return [...best.values()].map(({ d, ...l }) => l);
});
export const labelCellsIn = (bb) => { const out = []; for (let J = hIdx(bb[1]); J <= hIdx(bb[3]); J++) for (let I = hIdx(bb[0]); I <= hIdx(bb[2]); I++) out.push([I, J]); return out; };
