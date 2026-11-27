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
import { KF, WORLD, HALF, hash, toLL, toM, H01, Index, bboxOf, ringArea, polysM, linesM, lineLen, distToLine, demAt } from './fmcore.js';
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
let IDX = null, HASF = null;
export function setAtlas(idx, has) { IDX = idx; HASF = has; }
// the world plan picks drawings from the atlas: asking before it is in would cache a plan without them
const HAS = (n) => { if (!HASF) throw new Error('fmworld: the atlas is not loaded yet (await spritesReady)'); return HASF(n); };

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

// ---------------------------------------------------------------- terrain
// The valley floor at a point: the lowest ground (sea level at least) within 1.5 km, taken on a fixed
// 400 m world grid and blended between its nodes. Height over the valley floor says "mountain" the same
// way in Innsbruck (575 m) and in a high valley; no window's own lowest point is ever used.
const VG = 400 * KF;
const floorNode = memo((i, j) => { const x0 = i * VG, y0 = j * VG, st = 250 * KF; let m = Infinity; for (let a = -6; a <= 6; a++) for (let b = -6; b <= 6; b++) { const v = Math.max(0, demAt(x0 + a * st, y0 + b * st)); if (v < m) m = v; } return m; });
export function valleyFloor(x, y) { const fx = x / VG, fy = y / VG, i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j; return floorNode(i, j) * (1 - ax) * (1 - ay) + floorNode(i + 1, j) * ax * (1 - ay) + floorNode(i, j + 1) * (1 - ax) * ay + floorNode(i + 1, j + 1) * ax * ay; }
/** Height (m) over the valley floor. */
export const relHeight = (x, y) => demAt(x, y) - valleyFloor(x, y);
/** Slope (rise over run) measured across ±d map metres. */
export const slopeAt = (x, y, d = 40) => { const D = d * KF; return Math.hypot(demAt(x + D, y) - demAt(x - D, y), demAt(x, y + D) - demAt(x, y - D)) / (2 * d); };
/** Mountain ground, where real woods and slopes take priority over fields: steeper than 0.22 over 80 m, or
 *  more than 120 m over the valley floor (cached on a 20 m world grid). */
const mountG = memo((i, j) => { const x = (i + 0.5) * 20 * KF, y = (j + 0.5) * 20 * KF; return slopeAt(x, y) > 0.22 || relHeight(x, y) > 120; });
export const mountainAt = (x, y) => mountG(Math.floor(x / (20 * KF)), Math.floor(y / (20 * KF)));
/** May a field, allotment, paddock or orchard filler stand here: not on real wood, not on mountain ground. */
export const fieldGround = (x, y) => !woodAt(x, y) && !mountainAt(x, y);

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
// line pieces in 100 m buckets per data tile, so a query near a point reads only the pieces there
const PG = 100 * KF;
const bucketed = (list) => { const m = new Map(); for (const p of list) for (let i = Math.floor(p.bb[0] / PG); i <= Math.floor(p.bb[2] / PG); i++) for (let j = Math.floor(p.bb[1] / PG); j <= Math.floor(p.bb[3] / PG); j++) push(m, i + ',' + j, p); return m; };
const pieceGrid = perTile((tx, ty) => bucketed(piecesOf(tx, ty))), bridgeGrid = perTile((tx, ty) => bucketed(bridgesOf(tx, ty)));
const fromGrid = (grid, bb) => { const seen = new Set(), out = []; for (const [tx, ty] of tilesIn([bb[0] - BUF, bb[1] - BUF, bb[2] + BUF, bb[3] + BUF])) { const g = grid(tx, ty); for (let i = Math.floor(bb[0] / PG); i <= Math.floor(bb[2] / PG); i++) for (let j = Math.floor(bb[1] / PG); j <= Math.floor(bb[3] / PG); j++) for (const p of g.get(i + ',' + j) || []) if (!seen.has(p.key) && ovl(p.bb, bb)) { seen.add(p.key); out.push(p); } } return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); };
/** The road pieces whose box meets a box (in key order). */
export const piecesIn = (bb) => fromGrid(pieceGrid, bb);
export const bridgesIn = (bb) => fromGrid(bridgeGrid, bb);
const dens = (pts, st) => { const o = []; sample(pts, st, (x, y) => o.push([x, y])); return o; };
/** A dual carriageway is one track: a oneway main line that runs beside a stronger (earlier keyed) one of its class. */
const mergedAway = memo((key) => {
  const P = pieceByKey(key);
  if (!P.oneway || !['motorway', 'trunk', 'primary'].includes(P.cls)) return false;
  if (P.len < 80) { // a short link is a second carriageway only where it continues a long one that is (it is not one by itself)
    const r = JOIN; return [P.pts[0], P.pts[P.pts.length - 1]].some((E) => piecesIn([E[0] - r, E[1] - r, E[0] + r, E[1] + r]).some((Q) => Q.key !== P.key && Q.oneway && Q.cls === P.cls && Q.len >= 80 && [Q.pts[0], Q.pts[Q.pts.length - 1]].some((F) => Math.hypot(F[0] - E[0], F[1] - E[1]) < 2 * KF) && mergedAway(Q.key)));
  }
  const r = 40 * KF, others = piecesIn([P.bb[0] - r, P.bb[1] - r, P.bb[2] + r, P.bb[3] + r]).filter((Q) => Q.oneway && Q.cls === P.cls && Q.len >= 80 && Q.key < P.key && !mergedAway(Q.key)); // (long carriageways only: no cycle with the short links)
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
const shortName = (n) => { let s3 = n.split(/ der | des | zur | - |\(|,/)[0].trim(); if (s3.length > 26 && /\s/.test(s3.slice(0, 27))) s3 = s3.slice(0, 27).replace(/\s+\S*$/, ''); return s3; }; // (cut at a word, never inside one)
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
  // name: always one, and never a name a stronger heart within 1.5 km already carries. In order: the nearest
  // real neighbourhood or village label within 650 m; the suburb or quarter within 2 km; the nearest named
  // square, church or station within 400 m; the nearest named main street within 300 m; the nearest place within 2 km
  // with the side the heart lies on
  const used = new Set();
  for (const [a, b, q] of heartsAround(I, J, 4)) if ((a !== I || b !== J) && stronger(q, p) && Math.hypot(q.x - h.x, q.y - h.y) < 1500 * KF) { const n = heartAt(a, b).name; if (n) used.add(n); }
  const nearestOf = (list, r, key) => { let best = null, bd = r * KF; for (const it of list) { const n = key(it); if (!n || used.has(n) || !goodName(n)) continue; const [x, y] = it.m || [it.x, it.y], d = Math.hypot(x - h.x, y - h.y); if (d < bd || (d === bd && best && n < key(best))) { bd = d; best = it; } } return best && key(best); };
  const box = (r) => [h.x - r * KF, h.y - r * KF, h.x + r * KF, h.y + r * KF];
  const HOOD = ['suburb', 'quarter', 'neighbourhood', 'village', 'town', 'hamlet'];
  const plainAnchor = h.anchor && h.anchor.name && ((h.anchor.kind === 'church' && churchRe.test(h.anchor.name)) || (h.anchor.kind === 'square' && /platz|plein|square|piazza|markt|place\b|plaza/i.test(h.anchor.name))) ? shortName(h.anchor.name) : null;
  h.name = nearestOf(placesIn(box(650)).filter((pl) => HOOD.includes(pl.cls)), 650, (pl) => pl.name);
  if (!h.name && plainAnchor && !used.has(plainAnchor)) { h.name = plainAnchor; h.nameIsAnchor = true; }
  if (!h.name) h.name = nearestOf(placesIn(box(2000)).filter((pl) => ['suburb', 'quarter', 'neighbourhood'].includes(pl.cls)), 2000, (pl) => pl.name);
  if (!h.name) { h.name = nearestOf(anchorsIn(box(400)).filter((q) => q.kind !== 'hall'), 400, (q) => q.name && shortName(q.name)); if (h.name) h.nameIsAnchor = true; }
  if (!h.name) { const streets = []; for (const [tx, ty] of tilesIn([...box(300)])) for (const f of tileFeatures('transportation_name', tx, ty)) { const n = f.properties['name:latin'] || f.properties.name; if (!n || !['primary', 'secondary', 'tertiary', 'trunk', 'minor'].includes(f.properties.class)) continue; for (const l of linesM(f)) { let bd = Infinity, bp = null; for (const v of l) { const d = Math.hypot(v[0] - h.x, v[1] - h.y); if (d < bd) { bd = d; bp = v; } } streets.push({ name: n, x: bp[0], y: bp[1] }); } } h.name = nearestOf(streets, 300, (q) => shortName(q.name)); }
  if (!h.name) { // the nearest place within 2 km with the heart's side of it: "North Luisenstadt"
    const all = placesIn(box(2000)).sort((a, c) => Math.hypot(a.m[0] - h.x, a.m[1] - h.y) - Math.hypot(c.m[0] - h.x, c.m[1] - h.y) || (a.name < c.name ? -1 : 1));
    for (const pl of all) { const a = Math.atan2(h.y - pl.m[1], h.x - pl.m[0]), side = ['East', 'North', 'West', 'South'][((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4], n = `${side} ${pl.name}`; if (!used.has(n)) { h.name = n; break; } }
  }
  if (!h.name) h.name = `Hearth ${((I * 31 + J * 17) % 97 + 97) % 97 + 3}`; // (no real name within 2 km at all)
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
// - The backbone always: real main roads (motorway to secondary) and tertiary roads.
// - Every painted entrance of every heart, hamlet, compound and abbey is joined to the backbone by the
//   shortest way along real streets (up to 2 km); where no backbone is in reach, to the nearest other
//   heart's entrance (the link between two hearts).
// - Lanes round a heart (within 1.6 of its radius) and round a compound (110 m), as in the approved look.
// - In a city core, minor streets on the every-third band only: the thinning of regular street grids.
// - A road may end only at a set piece, a junction or a bridge over water: a lane that ends in the meadow is
//   led on along the shortest chain of real lanes (up to 400 m) to the drawn network, and only a lane that
//   cannot be connected is left out (three rounds, so chains of such lanes go too). Every rule reads only
//   the piece and the world round it.
const SET_PIECE = /^(hamlet|village|town|walled|alpine|market|red-gable|canal|quay-workshops|farmstead|monastery|watermill|sawmill|vineyard-estate|fishing)/;
export { SET_PIECE };
const backbone = (key) => { const P = pieceByKey(key); return !mergedAway(key) && (P.main || P.cls === 'tertiary'); };
const inSetPiece = (E) => canonPieces([E[0], E[1], E[0], E[1]]).some((pc) => SET_PIECE.test(pc.name) && Math.abs(E[0] - pc.cx) < pc.fw * 0.45 * KF && Math.abs(E[1] - pc.cy) < pc.fh * 0.45 * KF);
const JOIN = 9 * KF;
/** Does road piece Q really meet piece P at P's end E? Q must pass within 9 m of E and lead somewhere P does not
 *  go (the same road delivered again by the neighbouring data tile, lying on P, joins nothing). */
const near25 = (pts, E, r) => { const out = []; for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i]; if (Math.min(ax, bx) - r > E[0] || Math.max(ax, bx) + r < E[0] || Math.min(ay, by) - r > E[1] || Math.max(ay, by) + r < E[1]) continue; out.push([pts[i - 1], pts[i]]); } return out; };
const meets = (Q, E, P) => {
  if (Q.key === P.key || distToLine(E[0], E[1], Q.pts) >= JOIN) return false;
  const R25 = 25 * KF, qs = near25(Q.pts, E, R25), ps = near25(P.pts, E, R25 + 4 * KF).flat();
  let away = false;
  for (const [a, b] of qs) { sample([a, b], 3 * KF, (x, y) => { if (away || Math.hypot(x - E[0], y - E[1]) >= R25) return; let d = Infinity; for (let i = 0; i < ps.length; i += 2) d = Math.min(d, distToLine(x, y, [ps[i], ps[i + 1]])); if (d > 3 * KF) away = true; }); if (away) break; }
  return away;
};
const ends = (P) => [P.pts[0], P.pts[P.pts.length - 1]];
/** The street pieces that cross or touch piece P (a shared vertex, or an end of one on the other). */
const adjacent = memo((key) => {
  const P = pieceByKey(key), r = JOIN;
  return piecesIn([P.bb[0] - r, P.bb[1] - r, P.bb[2] + r, P.bb[3] + r]).filter((Q) => Q.key !== key && !mergedAway(Q.key) && (
    ends(Q).some((E) => distToLine(E[0], E[1], P.pts) < JOIN && meets(P, E, Q)) || ends(P).some((E) => distToLine(E[0], E[1], Q.pts) < JOIN && meets(Q, E, P)) ||
    Q.pts.some((q) => P.pts.some((p) => Math.abs(p[0] - q[0]) < 2 * KF && Math.abs(p[1] - q[1]) < 2 * KF)))).map((Q) => Q.key).sort();
}, 60000);
/** The shortest way along real streets from a point to a piece passing `target` (Dijkstra over whole pieces,
 *  ties by key): the keys of the pieces on the way (the target piece excluded), or null. */
function streetWay(x, y, target, maxLen, startR = 60 * KF) {
  const dist = new Map(), prev = new Map(), open = [];
  for (const P of piecesIn([x - startR, y - startR, x + startR, y + startR])) { if (mergedAway(P.key)) continue; const d = distToLine(x, y, P.pts) / KF; if (d < startR / KF) { dist.set(P.key, d + P.len); open.push(P.key); } }
  const done = new Set();
  for (let it = 0; open.length && it < 1500; it++) {
    open.sort((a, b) => dist.get(a) - dist.get(b) || (a < b ? -1 : 1));
    const k = open.shift(); if (done.has(k)) continue; done.add(k);
    if (target(k)) { const way = []; let c = prev.get(k); while (c) { way.push(c); c = prev.get(c); } way.reached = k; return way; } // (way: from the piece next to the target back to the first piece)
    const dk = dist.get(k);
    for (const q of adjacent(k)) { if (done.has(q)) continue; const Q = pieceByKey(q), nd = dk + (target(q) ? 0 : Q.len); if (nd > maxLen) continue; if (!dist.has(q) || nd < dist.get(q)) { dist.set(q, nd); prev.set(q, k); open.push(q); } }
  }
  return null;
}
/** The ways from the entrances of every set piece anchored in heart cell (I, J). */
const portWays = memo((I, J) => {
  const b = cellBox(I, J), keys = [], pcs = [], trims = [];
  const h = heartAt(I, J); if (h && h.piece) pcs.push(h.piece);
  for (let bj = J * 3; bj < J * 3 + 3; bj++) for (let bi = I * 3; bi < I * 3 + 3; bi++) { const c = compoundAt(bi, bj); if (c) pcs.push(c.piece); }
  for (const a of abbeysIn(b)) if (a.piece) pcs.push(a.piece);
  for (const pc of pcs) for (const pt of pc.ports) {
    if (inSetPiece([pt.x, pt.y]) && !boxHit(pc, pt.x - 1, pt.y - 1, pt.x + 1, pt.y + 1)) continue; // (an entrance inside another piece)
    let way = streetWay(pt.x, pt.y, backbone, 2000);
    if (!way) { // no backbone in reach: the way to the nearest other heart's entrances
      const others = heartSpotsIn([pt.x, pt.y, pt.x, pt.y], 3 * HCELL).filter((q) => q.key !== I + ',' + J).sort((a, c) => Math.hypot(a.x - pt.x, a.y - pt.y) - Math.hypot(c.x - pt.x, c.y - pt.y) || (a.key < c.key ? -1 : 1));
      const o = others[0] && heartAt(...others[0].key.split(',').map(Number));
      if (o && o.piece) { const tp = o.piece.ports; way = streetWay(pt.x, pt.y, (k) => { const Q = pieceByKey(k); return tp.some((t) => distToLine(t.x, t.y, Q.pts) < 60 * KF); }, 2000); }
    }
    if (way) { keys.push(...way); if (way.length) { const first = way[way.length - 1], next = way.length >= 2 ? way[way.length - 2] : way.reached; trims.push([first, pt.x, pt.y, next]); } }
  }
  return { keys: [...new Set(keys)], trims };
});
const onPortWay = memo((key) => { const P = pieceByKey(key), r = 2100 * KF; for (let J = hIdx(P.bb[1] - r); J <= hIdx(P.bb[3] + r); J++) for (let I = hIdx(P.bb[0] - r); I <= hIdx(P.bb[2] + r); I++) if (portWays(I, J).keys.includes(key)) return true; return false; });
/** The first lane of an entrance's way is drawn from the point nearest the entrance on, towards the rest of the way
 *  (a long lane running past a farmstead does not dangle beyond it); used whole by any other way or rule. */
const trimOf = memo((key) => {
  const P = pieceByKey(key), r = 2100 * KF, cuts = [];
  for (let J = hIdx(P.bb[1] - r); J <= hIdx(P.bb[3] + r); J++) for (let I = hIdx(P.bb[0] - r); I <= hIdx(P.bb[2] + r); I++) { const w = portWays(I, J); if (!w.keys.includes(key)) continue; const t = w.trims.filter((c) => c[0] === key); if (!t.length) return null; cuts.push(...t); } // (a middle lane of some way: whole)
  if (!cuts.length) return null;
  const pts = P.pts, at = (x, y) => { let bi = 1, bt = 0, bd = Infinity; for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0, d = Math.hypot(ax + dx * t - x, ay + dy * t - y); if (d < bd) { bd = d; bi = i; bt = t; } } return [bi, bt]; };
  const dirs = cuts.map(([, x, y, next]) => { const N = pieceByKey(next); return [at(x, y), distToLine(pts[pts.length - 1][0], pts[pts.length - 1][1], N.pts) < distToLine(pts[0][0], pts[0][1], N.pts)]; });
  if (!dirs.every((d) => d[1] === dirs[0][1])) return null; // ways leave towards both ends: whole
  const toEnd = dirs[0][1], pos = (d) => d[0][0] + d[0][1], [bi, bt] = dirs.reduce((m, d) => ((toEnd ? pos(d) < pos(m) : pos(d) > pos(m)) ? d : m))[0];
  const free = toEnd ? pts[0] : pts[pts.length - 1]; // the end the cut leaves out: only cut when nothing meets it there
  if (inSetPiece(free) || near(free).some((Q) => roadDrawn(Q.key) && meets(Q, free, P))) return null;
  const cut = [pts[bi - 1][0] + (pts[bi][0] - pts[bi - 1][0]) * bt, pts[bi - 1][1] + (pts[bi][1] - pts[bi - 1][1]) * bt];
  return toEnd ? [cut, ...pts.slice(bi)] : [...pts.slice(0, bi), cut];
});
/** The lanes the look keeps by themselves: round hearts and compounds, and the every-third band in a city core. */
const laneBase = memo((key) => {
  const P = pieceByKey(key); if (mergedAway(key)) return false;
  const m = P.pts[Math.floor(P.pts.length / 2)], pts3 = [...ends(P), m];
  if (pts3.some(([x, y]) => nearestHeart(x, y)[1] < 1.6)) return true;
  if (pts3.some(([x, y]) => compoundsIn([x, y, x, y], 120 * KF).some((c) => Math.hypot(c.x - x, c.y - y) < 110 * KF))) return true;
  if (!coreAt(m[0], m[1]) || P.len <= 40) return false;
  const [p0, p1] = ends(P), a = Math.round(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) / (Math.PI / 18)) * (Math.PI / 18);
  const d = -p0[0] * Math.sin(a) + p0[1] * Math.cos(a);
  return ((Math.floor(d / (90 * KF)) % 3) + 3) % 3 === 0;
});
const fixed = (key) => backbone(key) || onPortWay(key); // never left out
const base = (key) => fixed(key) || laneBase(key);
const near = (E) => piecesIn([E[0] - JOIN, E[1] - JOIN, E[0] + JOIN, E[1] + JOIN]);
/** Chains that connect the free ends of the drawn pieces in heart cell (I, J) to the network. */
const chainsCell = memo((I, J) => {
  const b = cellBox(I, J), keys = [];
  for (const P of piecesIn(b)) {
    if (!base(P.key)) continue;
    for (const E of ends(P)) {
      if (!inside(E[0], E[1], b) || inSetPiece(E) || near(E).some((Q) => base(Q.key) && meets(Q, E, P))) continue;
      const way = streetWay(E[0], E[1], (k) => k !== P.key && base(k), 400, JOIN);
      if (way) keys.push(...way.filter((k) => k !== P.key));
    }
  }
  return [...new Set(keys)];
});
const onChain = memo((key) => { const P = pieceByKey(key), r = 560 * KF; for (let J = hIdx(P.bb[1] - r); J <= hIdx(P.bb[3] + r); J++) for (let I = hIdx(P.bb[0] - r); I <= hIdx(P.bb[2] + r); I++) if (chainsCell(I, J).includes(key)) return true; return false; });
const roadKeep = memo((key, d) => {
  if (fixed(key)) return true;
  if (!base(key) && !onChain(key)) return false;
  if (d === 0) return true;
  const P = pieceByKey(key);
  return ends(P).every((E) => inSetPiece(E) || near(E).some((Q) => meets(Q, E, P) && roadKeep(Q.key, d - 1)));
}); // (eight rounds: a lane cannot outlive the lanes it hangs on)
export const roadDrawn = (key) => !mergedAway(key) && roadKeep(key, 8);
/** A drawn road that stops in the meadow just short of a set piece is led on to the piece's nearest entrance (and a
 *  gap in the data between two drawn roads' ends is closed):
 *  [end, entrance, half width] per such end, decided per heart cell (the cell holding the end). */
const endLinks = memo((I, J) => {
  const b = cellBox(I, J), out = [];
  for (const P of piecesIn(b)) {
    if (!roadDrawn(P.key)) continue;
    for (const E of [P.pts[0], P.pts[P.pts.length - 1]]) {
      if (!inside(E[0], E[1], b) || inSetPiece(E)) continue;
      if (piecesIn([E[0] - JOIN, E[1] - JOIN, E[0] + JOIN, E[1] + JOIN]).some((Q) => roadDrawn(Q.key) && meets(Q, E, P))) continue;
      // a gap in the data (a tunnel section left out): another drawn road's end within 30 m is joined to it
      // (decided from the lower-keyed end, so once)
      const G30 = 30 * KF; let gap = null, gd = G30;
      for (const Q of piecesIn([E[0] - G30, E[1] - G30, E[0] + G30, E[1] + G30])) { if (Q.key === P.key || !roadDrawn(Q.key)) continue; for (const F of [Q.pts[0], Q.pts[Q.pts.length - 1]]) { const d = Math.hypot(F[0] - E[0], F[1] - E[1]); if (d < gd && d > 0.5 * KF) { gd = d; gap = [Q, F]; } } }
      if (gap) { const [Q, F] = gap, fFree = !inSetPiece(F) && !piecesIn([F[0] - JOIN, F[1] - JOIN, F[0] + JOIN, F[1] + JOIN]).some((R) => roadDrawn(R.key) && meets(R, F, Q)); if (P.key < Q.key || !fFree) out.push({ key: P.key + '>' + Q.key, pts: [E, F], cls: P.cls, main: P.main }); continue; }
      let best = null, bd = 90 * KF;
      for (const pc of canonPieces([E[0] - bd, E[1] - bd, E[0] + bd, E[1] + bd])) if (SET_PIECE.test(pc.name)) for (const pt of pc.ports) { const d = Math.hypot(pt.x - E[0], pt.y - E[1]); if (d < bd || (d === bd && best && pt.x < best.x)) { bd = d; best = pt; } }
      if (best) out.push({ key: P.key + '>' + (E === P.pts[0] ? 0 : 1), pts: [E, [best.x, best.y]], cls: P.cls, main: P.main });
    }
  }
  return out;
});
export const endLinksIn = (bb) => labelCellsIn(bb).flatMap(([I, J]) => endLinks(I, J));
/** The drawn roads near a box. */
export const drawnIn = (bb) => piecesIn(bb).filter((P) => roadDrawn(P.key)).map((P) => { if (backbone(P.key) || !onPortWay(P.key)) return P; const t = trimOf(P.key); return t ? { ...P, pts: t, bb: bboxOf([t]), len: lineLen(t) } : P; });
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
/** The spot for a heart's name: below its piece where that is clear of water and set pieces (a road may run under
 *  it, as in the approved look), else beside it. */
export const heartLabel = memo((I, J, band) => {
  const h = heartAt(I, J); if (!h || !h.name || !goodName(h.name)) return null;
  if (!h.piece) return { name: h.name, wx: h.x, wy: h.y, big: true, pr: 3, fixed: 1 };
  const pc = h.piece, lw = Math.min(26, h.name.length) * 10.5 * Math.pow(2, 16 - band), lh = 22 * Math.pow(2, 16 - band);
  const pcs = canonPieces([pc.cx - 400 * KF, pc.cy - 400 * KF, pc.cx + 400 * KF, pc.cy + 400 * KF]);
  const clearAt = (x, y) => { for (let u = -0.5; u <= 0.51; u += 0.25) for (let v = -0.5; v <= 0.51; v += 0.5) { const px = x + u * lw * KF, py = y + v * lh * KF; if (!onLand(px, py) || pcs.some((q) => Math.abs(px - q.cx) < q.fw * 0.5 * KF && Math.abs(py - q.cy) < q.fh * 0.5 * KF)) return false; } return true; };
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

// ---------------------------------------------------------------- ground pieces: fillers, quilts, paddocks, orchards
// Every field, garden, pasture, orchard and paddock (the block fillers of set five and the set-four ground
// pieces) is decided here, once, at a world anchor. The candidates, best first:
//   1. round each heart: paddocks, field quilts, orchards and tree clumps on its open ground;
//   2. parcels lining every drawn road, two rows deep, turned with the road;
//   3. field quilts on real farmland and orchard or vineyard blocks on real orchards;
//   4. a 72 m grid over the open land near the drawn roads, turned with the nearest road.
// A candidate stands unless it would cover water, a drawn road, real wood, mountain ground, a set piece or a
// heart's name, or overlap a better candidate that stands. Better: the earlier class, then a hash of the anchor
// (a random order keeps every such chain short). So two ground pieces never overlap, also across tile edges.
const ORI = ['ew', 'ne-sw', 'ns', 'nw-se'], OANG = { ew: 0, 'ne-sw': Math.PI / 4, ns: Math.PI / 2, 'nw-se': 3 * Math.PI / 4 };
export const orient = (ang) => { const a = ((ang % Math.PI) + Math.PI) % Math.PI, k2 = Math.round(a / (Math.PI / 4)); return [ORI[k2 % 4], a - k2 * Math.PI / 4]; };
const FILLK = { field: ['hedged-wheat', 'hay-meadow', 'flax-strip', 'ploughed-strip'], garden: ['kitchen-garden', 'vegetable-allotments', 'beehive-garden', 'pond-common', 'bowling-green', 'bleaching-field'], orchard: ['orchard-rows', 'vineyard-rows'], pasture: ['sheep-pasture', 'cow-pasture', 'horse-paddock', 'hay-meadow'] };
const WT = { 'hedged-wheat': 0.45, 'ploughed-strip': 0.25, 'hay-meadow': 0.55, 'flax-strip': 0.4, 'kitchen-garden': 0.8, 'vegetable-allotments': 0.7, 'beehive-garden': 0.5, 'pond-common': 0.35, 'bowling-green': 0.3, 'bleaching-field': 0.3, 'orchard-rows': 0.8, 'vineyard-rows': 0.2, 'cow-pasture': 0.7, 'sheep-pasture': 0.8, 'horse-paddock': 0.5 };
/** Oriented rectangles: { cx, cy, ux, uy, hl, hw } (half length along u, half width), mercator. */
const obbHit = (A, B, gap) => {
  for (const [ax, ay] of [[A.ux, A.uy], [-A.uy, A.ux], [B.ux, B.uy], [-B.uy, B.ux]]) {
    const ra = Math.abs(A.hl * (A.ux * ax + A.uy * ay)) + Math.abs(A.hw * (-A.uy * ax + A.ux * ay)), rb = Math.abs(B.hl * (B.ux * ax + B.uy * ay)) + Math.abs(B.hw * (-B.uy * ax + B.ux * ay));
    if (Math.abs((B.cx - A.cx) * ax + (B.cy - A.cy) * ay) > ra + rb + gap) return false;
  }
  return true;
};
const boxOf = (pc) => ({ cx: pc.cx, cy: pc.cy, ux: 1, uy: 0, hl: pc.fw * 0.5 * KF, hw: pc.fh * 0.5 * KF });
/** The variants a candidate may take, best first: [{ name, x, y, box, sprite: { wM, ax, ay, rot, flip, z }, filler }]. */
function fillerVariants(kinds, x, y, ang, seed, lens = [160, 80, 40]) {
  const [b, res] = orient(ang), a = OANG[b] + res, ux = Math.cos(a), uy = Math.sin(a), out = [];
  const order = kinds.map((k1, i2) => [k1, -Math.log(Math.max(1e-6, H01(x, y, seed + i2 * 7))) / (WT[k1] || 0.5)]).sort((p1, p2) => p1[1] - p2[1]).map((p1) => p1[0]);
  for (const L of lens) for (const kind of order) {
    const name = `${kind}-${L}-${b}`, m = IDX[name]; if (!HAS(name) || !m || !m.fill) continue;
    out.push({ name, kind, x, y, filler: true, box: { cx: x, cy: y, ux, uy, hl: L / 2 * KF, hw: m.fill.W / 2 * KF }, sprite: { wM: m.img_m, ax: m.ax, ay: m.ay, rot: -res, flip: false, z: -0.65 } });
  }
  return out;
}
const pieceVariant = (name, x, y, o = {}) => { if (!HAS(name) || !IDX[name]) return null; const pc = pieceGeom(name, x, y, o); return { name, kind: name, x, y, filler: false, box: boxOf(pc), sprite: { wM: pc.wM, ax: IDX[name].ax, ay: IDX[name].ay, rot: 0, flip: !!o.flip, z: o.z ?? -0.6 } }; };
const CLUMPS = (n) => (n <= 3 ? ['deciduous-trio-round', 'deciduous-trio-hook'] : n <= 5 ? ['deciduous-five-round', 'deciduous-five-hook'] : n <= 9 ? ['deciduous-eight-round', 'deciduous-five-round'] : ['deciduous-dozen-round', 'deciduous-dozen-hook', 'deciduous-eight-round']);
/** The heart's name spot as a box (ground pieces keep off it). */
const labelBox = (I, J) => { const L = heartLabel(I, J, 16); if (!L || !heartAt(I, J).piece) return null; return { cx: L.wx, cy: L.wy, ux: 1, uy: 0, hl: Math.min(26, L.name.length) * 10.5 / 2 * KF, hw: 11 * KF }; };
/** What a ground piece may never cover: set pieces and the hearts' name spots round a point. */
const obstacles = memo((bi, bj) => {
  const b = [bi * BLOCK, bj * BLOCK, (bi + 1) * BLOCK, (bj + 1) * BLOCK], out = canonPieces(b).filter((pc) => !pc.extra).map(boxOf);
  for (const h of heartsIn(b, 400 * KF)) { const L = labelBox(h.I, h.J); if (L) out.push(L); }
  return out;
}, 8000);
/** The candidates anchored in 160 m block (bi, bj). */
const groundCands = memo((bi, bj) => {
  const b = [bi * BLOCK, bj * BLOCK, (bi + 1) * BLOCK, (bj + 1) * BLOCK], out = [];
  const add = (cls, id, x, y, variants, extra = {}) => { if (inside(x, y, b) && variants.length) out.push({ id: cls + ':' + id, cls, pr: cls + (extra.row ? 0.5 : 0) + hash(Math.round(x / KF), Math.round(y / KF), 5101 + cls) * (cls === 2 ? 0.5 : 1), x, y, variants, ...extra }); }; // (a second row after every first row)
  // 1. round each heart (the heart's own cell decides, its items anchored wherever they fall)
  for (const h of heartsIn(b, 500 * KF)) {
    const pc = h.piece; if (!pc) continue;
    for (let k3 = 0; k3 < 24; k3++) {
      const a = (k3 * 2.39996 + H01(h.x0, h.y0, 3173) * 6.283), r = (pc.fw * 0.5 + 55 + (k3 % 4) * 38) * KF, x = pc.cx + Math.cos(a) * r, y = pc.cy + Math.sin(a) * r * 0.9;
      if (!inside(x, y, b)) continue;
      const kind = H01(x, y, 3175), n2 = kind < 0.3 ? pickOf(PADDOCKS, x, y, 3177) : kind < 0.55 ? pickOf(QUILTS, x, y, 3179) : kind < 0.75 ? pickOf(['orchard-block-rows', 'orchard-block-bloom'], x, y, 3181) : pickOf(CLUMPS(3 + (k3 % 3) * 2), x, y, 3187);
      const v = n2 && pieceVariant(n2, x, y, { z: -0.6, flip: /^deciduous/.test(n2) ? H01(x, y, 3190) < 0.5 : kind < 0.5 === (H01(x, y, 3183) < 0.5), k: 1.15 });
      if (v) add(1, `${h.key}/${k3}`, x, y, [v], { heart: h.key, k3, field: !/^deciduous/.test(n2) });
    }
  }
  // 2. parcels along the drawn roads (points on the world grid along each road, as alongW)
  const st = 94 * KF * 0.85, pad = 120 * KF;
  for (const P of drawnIn([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad])) {
    if (['motorway', 'trunk'].includes(P.cls)) continue;
    for (let i = 1; i < P.pts.length; i++) {
      const [ax, ay] = P.pts[i - 1], [bx, by] = P.pts[i], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy); if (len < 1e-9) continue;
      const hor = Math.abs(dx) >= Math.abs(dy), ta = hor ? ax : ay, tb = hor ? bx : by, lo = Math.min(ta, tb), hi = Math.max(ta, tb), nx = -dy / len, ny = dx / len, ang = Math.atan2(dy, dx);
      for (let kk = Math.ceil(lo / st); kk * st < hi; kk++) {
        const t = (kk * st - ta) / (tb - ta), mx = ax + dx * t, my = ay + dy * t;
        for (const sd of [1, -1]) {
          if (H01(mx + sd * 7, my, 3301) < 0.14) continue; // a stretch of open meadow, by choice
          for (const row of [0, 1]) {
            const off = (P.w / 2 + 9 + 19.5 + row * 40) * KF, x = mx + nx * off * sd, y = my + ny * off * sd, off0 = (P.w / 2 + 9 + 19.5) * KF;
            const [h0, dh] = nearestHeart(x, y), r = H01(x, y, 3303), nearH = h0 && dh < 3.5;
            const cat = orchardAt(x, y) ? 'orchard' : nearH ? (r < 0.4 ? 'garden' : r < 0.65 ? 'orchard' : r < 0.85 ? 'pasture' : 'field') : (r < 0.6 ? 'field' : r < 0.8 ? 'pasture' : 'orchard');
            const vs = [...fillerVariants(FILLK[cat], x, y, ang, 3305, [160, 80, 40]), ...fillerVariants([...FILLK.field, ...FILLK.pasture], x, y, ang, 3307, [80, 40])];
            add(2, `${Math.round(x / KF)},${Math.round(y / KF)}`, x, y, vs, { row, nearHeart: dh, parent: row ? [mx + nx * off0 * sd, my + ny * off0 * sd] : null });
          }
        }
      }
    }
  }
  // 3. field quilts on real farmland, orchard and vineyard blocks on real orchards
  { const g = 92 * KF; for (let i = Math.floor(b[0] / g) - 1; i <= Math.floor(b[2] / g) + 1; i++) for (let j = Math.floor(b[1] / g) - 1; j <= Math.floor(b[3] / g) + 1; j++) {
    const x = (i + 0.3 + hash(i, j, 3161) * 0.4) * g, y = (j + 0.3 + hash(i, j, 3163) * 0.4) * g; if (!inside(x, y, b) || !farmAt(x, y)) continue;
    if ([[-40, 0], [40, 0], [0, -30], [0, 30]].filter(([a2, b2]) => farmAt(x + a2 * KF, y + b2 * KF)).length < 3) continue;
    const n2 = pickOf(QUILTS, x, y, 3165), v = n2 && pieceVariant(n2, x, y, { flip: hash(i, j, 3167) < 0.5, k: 1.3 }); if (v) add(3, `q${i},${j}`, x, y, [v], { field: true });
  } }
  { const g = 70 * KF; for (let i = Math.floor(b[0] / g); i <= Math.floor(b[2] / g); i++) for (let j = Math.floor(b[1] / g); j <= Math.floor(b[3] / g); j++) {
    const x = (i + 0.5) * g, y = (j + 0.5) * g, it = orchardAt(x, y); if (!inside(x, y, b) || !it) continue;
    const n2 = pickOf(it.props && it.props.subclass === 'vineyard' ? ['vineyard-block-slope', 'vineyard-block-long'] : ['orchard-block-rows', 'orchard-block-bloom'], x, y, 3141), v = n2 && pieceVariant(n2, x, y, { flip: hash(i, j, 3143) < 0.5, k: 1.3 }); if (v) add(3, `o${i},${j}`, x, y, [v], { field: true });
  } }
  // 4. the open-land grid near the drawn roads
  { const g = 72 * KF; for (let i = Math.floor(b[0] / g) - 1; i <= Math.floor(b[2] / g) + 1; i++) for (let j = Math.floor(b[1] / g) - 1; j <= Math.floor(b[3] / g) + 1; j++) {
    const x = (i + 0.35 + hash(i, j, 3203) * 0.3) * g, y = (j + 0.35 + hash(i, j, 3205) * 0.3) * g; if (!inside(x, y, b) || hash(i, j, 3201) < 0.17) continue; // (about one in six stays open meadow, by choice)
    const near = nearestDrawn(x, y); if (!near || drawnNear(x, y) < 14) continue;
    const [h0, dh] = nearestHeart(x, y), nearH = h0 && dh < 3.5, r = hash(i, j, 3207);
    let cat;
    if (cemeteryAt(x, y) || parkAt(x, y)) cat = null;
    else if (orchardAt(x, y)) cat = 'orchard';
    else if (farmAt(x, y)) cat = r < 0.75 ? 'field' : 'pasture';
    else if (nearH) cat = r < 0.4 ? 'garden' : r < 0.65 ? 'pasture' : r < 0.8 ? 'orchard' : null;
    else cat = r < 0.45 ? 'field' : r < 0.75 ? 'pasture' : r < 0.85 ? 'orchard' : null;
    if (!cat) continue;
    const [, sm] = streetNear(x, y, 90 * KF), ang = sm ? sm[3] : 0;
    add(4, `g${i},${j}`, x, y, [...fillerVariants(FILLK[cat], x, y, ang, 3221), ...fillerVariants(cat === 'garden' || cat === 'orchard' || cat === 'pasture' ? FILLK.field : FILLK.garden, x, y, ang, 3223)], { grid: [i, j] });
  } }
  return out;
}, 6000);
/** Static tests of a footprint: dry, off the drawn roads, on open ground (not wood, not mountain ground for fields). */
function groundOK(v, field) {
  const B = v.box;
  for (const [u, w] of [[0, 0], [-0.42, -0.36], [0.42, -0.36], [-0.42, 0.36], [0.42, 0.36], [-0.21, 0], [0.21, 0], [0, -0.36], [0, 0.36]]) {
    const x = B.cx + u * 2 * B.hl * B.ux - w * 2 * B.hw * B.uy, y = B.cy + u * 2 * B.hl * B.uy + w * 2 * B.hw * B.ux;
    if (!onLand(x, y) || drawnNear(x, y) <= 3 || woodAt(x, y) || (field && mountainAt(x, y))) return false;
  }
  const ob = []; for (let bj = bIdx(B.cy) - 2; bj <= bIdx(B.cy) + 2; bj++) for (let bi = bIdx(B.cx) - 2; bi <= bIdx(B.cx) + 2; bi++) ob.push(...obstacles(bi, bj));
  return !ob.some((O) => obbHit(O, B, 2 * KF));
}
// Ground cells: 320 m squares (2 × 2 blocks) in a fixed four-colour checkerboard. A cell decides its candidates
// best first, keeping clear of what it has taken and of what its lower-coloured neighbours took; a
// higher-coloured neighbour keeps clear of it in turn. Two cells of one colour are a whole cell apart, more than
// any ground piece reaches, so nothing overlaps, and the chain of cells a decision depends on is at most four long.
const GN = 2; // blocks per ground cell side
const gcIdx = (v) => Math.floor(bIdx(v) / GN);
const colour = (I, J) => (((I % 2) + 2) % 2) + 2 * (((J % 2) + 2) % 2);
const groundCell = memo((I, J) => {
  const col = colour(I, J), fixedN = [];
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if ((a || b) && colour(I + a, J + b) < col) fixedN.push(...groundCell(I + a, J + b));
  const cands = []; for (let bj = J * GN; bj < J * GN + GN; bj++) for (let bi = I * GN; bi < I * GN + GN; bi++) cands.push(...groundCands(bi, bj));
  cands.sort((c, d) => c.pr - d.pr || (c.id < d.id ? -1 : 1));
  const acc = [], perHeart = new Map();
  for (const w of fixedN) if (w.heart) perHeart.set(w.heart, (perHeart.get(w.heart) || 0) + 1);
  for (const c of cands) {
    if (c.cls === 2 && c.nearHeart < 1.25) continue;
    if (c.cls === 1) { const h = heartAt(...c.heart.split(',').map(Number)), want = 3 + Math.floor(H01(h.x0, h.y0, 3171) * 3); if ((perHeart.get(c.heart) || 0) >= want) continue; }
    const near = [...fixedN, ...acc].filter((w) => Math.hypot(w.x - c.x, w.y - c.y) < 640 * KF);
    for (const v of c.variants) {
      if (!groundOK(v, c.field !== false && (c.cls !== 1 || c.field))) continue;
      if (c.cls === 1 && streetNear(c.x, c.y)[0] < (v.box.hl / KF) * 0.45) continue;
      if (near.some((w) => obbHit(w.box, v.box, 2 * KF))) continue;
      if (near.filter((w) => w.name === v.name && Math.hypot(w.x - v.x, w.y - v.y) < 300 * KF).length >= (v.filler ? 2 : 1)) continue; // never the same drawing again and again
      if (/^paddock/.test(v.name) && near.some((w) => w.name === v.name && Math.hypot(w.x - v.x, w.y - v.y) < 600 * KF)) continue;
      if (v.filler) { if (!kindAllowed(v.name, v.x, v.y, 0.36)) continue; const cell = Math.floor(v.x / RC) + ',' + Math.floor(v.y / RC); if (near.some((w) => w.filler && w.kind === v.kind && Math.floor(w.x / RC) + ',' + Math.floor(w.y / RC) === cell)) continue; }
      acc.push({ ...v, id: c.id, cls: c.cls, heart: c.heart }); if (c.heart) perHeart.set(c.heart, (perHeart.get(c.heart) || 0) + 1);
      break;
    }
  }
  return acc;
}, 3000);
/** The ground pieces that stand with their anchors in a box. */
export function groundIn(bb) { const out = []; for (let J = gcIdx(bb[1]); J <= gcIdx(bb[3]); J++) for (let I = gcIdx(bb[0]); I <= gcIdx(bb[2]); I++) for (const v of groundCell(I, J)) if (v.x >= bb[0] && v.x <= bb[2] && v.y >= bb[1] && v.y <= bb[3]) out.push(v); return out; }
/** Was grid candidate (i, j) of the open-land grid taken by a ground piece (the plan puts a clump where not). */
export const gridTaken = (i, j) => { const g = 72 * KF, x = (i + 0.35 + hash(i, j, 3203) * 0.3) * g, y = (j + 0.35 + hash(i, j, 3205) * 0.3) * g; return groundCell(gcIdx(x), gcIdx(y)).some((v) => v.id === `4:g${i},${j}`); };
/** Why a road piece is drawn or not (for checks and debugging). */
export const roadWhy = (key) => ({ trim: trimOf(key) && trimOf(key).length, backbone: backbone(key), merged: mergedAway(key), portWay: onPortWay(key), lane: laneBase(key), chain: onChain(key), keep: [0, 1, 2, 3].map((d) => roadKeep(key, d)) });
