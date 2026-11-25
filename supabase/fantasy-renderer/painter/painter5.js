// PROTOTYPE, throwaway. Round 5: paints the walking-zoom world (z ≥ 14.5) onto one 2D canvas,
// which app.js shows as a MapLibre `canvas` source under the labels and game overlays.
//
// Every object is a painted sprite (sprites5/, made from concept/objects* by tools/sprites5.py,
// plus the game's own UI Assets for the rare special places). Only the ground is painted in
// code: meadow, fields, water, roads and cobbles.
//
// Composition ("village heart", the default): one named village centre per screen-sized area at
// the real densest, most meaningful spot (square, church, town hall, station). A cobbled square
// with a well, the church at the real church, market stalls where real shops cluster, houses
// along the real streets around it with yards behind them; then fields, orchards and gardens in
// the real blocks, thinning to groves and meadow towards the next village. "Open country"
// (opts.comp === 'open') makes the villages fewer and smaller.
//
// Nothing is random: every object comes from real data at that spot and every choice among
// variants is a hash of world coordinates, so the same place always paints the same picture.
import { hash, fbm, demSampler } from './world.js';
import { toM, toLL } from './density.js';

// ---------------------------------------------------------------- painted sprites
const SPR = {}; let SPRIDX = {};
// ImageBitmaps load the same way on the main thread and in a worker
const loadImg = async (url) => { try { const r = await fetch(url); if (!r.ok) return null; return await createImageBitmap(await r.blob()); } catch { return null; } };
// the atlas and the textures come once from the main thread (chunks.js), decoded there, one copy per worker
let provideTex, provideAtlas; const texP = new Promise((r) => { provideTex = r; }), atlasP = new Promise((r) => { provideAtlas = r; });
const decode = (buf) => createImageBitmap(new Blob([buf], { type: 'image/webp' }));
export async function provide(m) {
  if (m.type === 'tex') provideTex({ tex: Object.fromEntries(await Promise.all(m.tex.map(async ([n, b]) => [n, await decode(b)]))) });
  else provideAtlas({ idx: m.idx, sheets: await Promise.all(m.sheets.map(decode)) });
}
const spritesReady = atlasP.then(async ({ idx, sheets }) => {
  SPRIDX = idx;
  for (const [n, m] of Object.entries(idx)) if (m.atlas) { const [x, y, w, h] = m.atlas; SPR[n] = { sheet: sheets[m.sheet || 0], sx: x, sy: y, width: w, height: h }; }
});
// seamless ground textures (concept/textures via tools/sprites5.py), used when present
const TEXTURES = {};
const TEX_METRES = { 'meadow-soft': 32, 'meadow-sunlit': 32, 'meadow-cool': 32, 'wildflower-meadow': 36, pasture: 36, 'wheat-field': 24, 'ploughed-earth': 20, 'vegetable-rows': 18, 'forest-floor': 28, 'cobbled-square': 12, 'dirt-path': 16, 'river-water': 32, 'lake-water': 40, 'shallow-water': 24, sand: 25, rock: 26, snow: 32, scree: 26, 'cobbled-road': 12, 'river-current-painted': 68, 'canal-reflection-painted': 52, 'canal-sun-sweeps': 55, 'river-bright-current': 67, 'meadow-sunlit-gold': 83, 'meadow-sunlit-clover': 89, 'meadow-sunlit-lowland': 86, 'meadow-swales': 70, 'meadow-dry-patches': 68, 'meadow-deep-green': 70, 'paving-herringbone': 16 };
// the meadow textures are tinted once, at load, to the targets' warm meadow (median rgb 158,138,22)
const MEADOWS = new Set(['meadow-sunlit', 'meadow-soft', 'meadow-cool', 'wildflower-meadow', 'pasture']);
// the painted finish has strong light and dark in the grass: every meadow tile gets more local contrast
const CRISP = new Set([...MEADOWS, 'meadow-swales', 'meadow-dry-patches', 'meadow-deep-green', 'river-water', 'lake-water']);
// (their contrast and tint are baked into the WebP files by tools/sprites5.py)
const texturesReady = texP.then(({ tex }) => { Object.assign(TEXTURES, tex); });
// ground width of each sprite in metres at z16 (the targets draw objects about 3× life size)
const SIZE = {
  'thatched-cottage': 34, 'timber-frame-house': 34, 'stone-house': 38, barn: 40, 'long-house': 44, 'tower-house': 24, 'row-houses': 50, farmstead: 50,
  chapel: 40, church: 46, cathedral: 62, monastery: 70, 'market-stalls': 34, well: 13, fountain: 16, windmill: 28, inn: 46, 'town-hall': 50,
  'wooden-bridge': 40, 'stone-bridge': 50,
  'deciduous-oak': 24, 'deciduous-birch': 14, 'deciduous-autumn-maple': 22, 'pine-tall': 12, 'pine-spreading': 22, 'forest-clump': 44, 'forest-clump-2': 44, 'tree-round': 26, 'deciduous-round': 26, 'forest-deciduous-round': 40, 'forest-deciduous-hook': 40, 'forest-deciduous-belt': 42, 'forest-pine-large': 38, 'forest-pine-small': 28, 'bush-hawthorn': 9, 'bush-juniper': 10, 'fence-straight': 14, 'fence-corner': 14, 'hedge-segment': 16, reeds: 6, watermill: 30, 'monument-statue': 9, 'farmstead-yard': 44, 'massif-double-peak': 120, 'massif-plateau': 110, 'massif-ridge': 110, 'snowy-summit': 120, 'cliff-band': 60, 'town-corner-tower': 24, 'town-wall-segment': 36, 'rowhouses-street': 52,
  'orchard-patch': 46, 'crop-field-patch': 54, 'vegetable-garden': 34, haystack: 9,
  'rock-angular': 8, 'rock-flat': 13, 'rock-mossy': 10, 'house-limewash': 34, 'house-stepped-gable': 26, 'house-cross-gable': 38, 'house-hipped-cottage': 36, 'rowhouses-canal': 44, 'low-stone-wall': 22, 'standing-stones': 28, 'graveyard-patch': 42, 'quay-boats': 60, 'sheep-group': 24, 'cow-group': 28, 'horse-paddock': 46, 'flower-garden': 26, 'town-gate': 40, 'rocky-cliff': 44, 'mountain-peak': 110, 'mountain-massif': 140, 'jetty-and-boat': 26,
};
Object.assign(SIZE, { 'church-baroque-onion': 56, 'church-tall-spire': 60, 'church-parish': 42, 'tavern-hanging-sign': 46, 'market-stall-fish': 13, 'market-stall-produce': 13, 'market-stall-textile': 13, 'banner-pole-blue': 8, 'banner-pole-ochre': 8, 'lantern-post-wood': 7, 'lantern-post-stone': 7, 'hedged-planter-long': 18, 'hedged-planter-knot': 14, 'alpine-hut': 26, 'blossom-tree-pink': 20, 'blossom-tree-white': 20, 'columnar-cypress': 9, 'round-tree-beech': 24, 'round-tree-linden': 20, 'round-tree-elm': 26, 'round-tree-young-oak': 15, 'slope-outcrop-shelf': 44, 'slope-outcrop-spur': 36, 'slope-boulder-pair': 22, 'rowing-boat-ne': 11, 'rowing-boat-se': 11, 'rowing-boat-s': 6, 'lily-pads-small': 6, 'lily-pads-large': 9, 'river-foam': 16, 'river-ripple': 16 });
for (const b of ['timber-frame', 'stone-house']) for (const r of ['thatch', 'red-tile', 'grey-slate', 'mossy']) for (const c of ['clear', 'smoke']) SIZE[`${b}-roof-${r}-${c}`] = b === 'timber-frame' ? 34 : 38;
// UI Assets cut-outs (the game's own buildings) for the rare special places
const ASSETS = {};
const assetsReady = Promise.resolve(); // the castle and other UI Assets buildings are in the atlas now

// palette sampled from the target pictures: golden yellow-green meadow, sandy roads, deep canals
const MEADOW = [[150, 156, 40], [166, 160, 36], [182, 166, 46]];
const WHEAT = ['#e2b84a', 'rgba(150,100,30,0.35)'];
const PLOUGH = ['#a8743e', 'rgba(70,40,15,0.45)'];
const WATER = { edge: '#2f7895', deep: '#1f5a7c' };
const ROAD = { fill: '#efbf6c', edge: 'rgba(120,80,30,0.85)' };
const SHOP = new Set(['shop', 'grocery', 'clothing_store', 'bakery', 'jewelry', 'florist', 'butcher', 'shoe', 'gift', 'books', 'alcohol_shop', 'deli', 'ice_cream', 'cafe', 'restaurant', 'fast_food', 'marketplace', 'greengrocer', 'beverages', 'convenience', 'bar', 'pub']);
const shortName = (n) => { let s3 = n.split(/ der | des | zur | - |\(|,/)[0].trim(); if (s3.length > 26) s3 = s3.slice(0, 26).replace(/\s+\S*$/, ''); return s3; };

// a painted grass tile: short strokes in light and dark, made once (stand-in until textures arrive)
let GRASS = null;
function grassTile() {
  if (GRASS) return GRASS;
  const S = 256, c = off(S, S), x = c.getContext('2d');
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2600; i++) {
    const px = rnd() * S, py = rnd() * S, l = 2 + rnd() * 4, a = -1.2 + rnd() * 0.5, light = rnd() < 0.55;
    x.strokeStyle = light ? `rgba(235,225,110,${0.25 + rnd() * 0.3})` : `rgba(90,96,10,${0.2 + rnd() * 0.25})`;
    x.lineWidth = 0.8 + rnd() * 0.8;
    for (const [dx, dy] of [[0, 0], [-S, 0], [S, 0], [0, -S], [0, S]]) { x.beginPath(); x.moveTo(px + dx, py + dy); x.lineTo(px + dx + Math.cos(a) * l, py + dy + Math.sin(a) * l); x.stroke(); }
  }
  GRASS = c; return c;
}
// cobbles: rounded stones in warm sand and grey
let COBBLE = null;
function cobbleTile() {
  if (COBBLE) return COBBLE;
  const S = 128, c = off(S, S), x = c.getContext('2d');
  x.fillStyle = '#b89268'; x.fillRect(0, 0, S, S);
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const st = 13;
  for (let j = 0; j < S / st + 1; j++) for (let i = 0; i < S / st + 1; i++) {
    const cx = i * st + (j % 2) * st / 2 + (rnd() - 0.5) * 3, cy = j * st * 0.8 + (rnd() - 0.5) * 2;
    const v = rnd(), col = v < 0.5 ? '#e2c497' : v < 0.8 ? '#d4b384' : '#c9b8a0';
    for (const [dx, dy] of [[0, 0], [-S, 0], [S, 0], [0, -S], [0, S]]) {
      x.fillStyle = col; x.beginPath(); x.ellipse(cx + dx, cy + dy, st * 0.42, st * 0.33, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(255,245,220,0.35)'; x.beginPath(); x.ellipse(cx + dx - 1.5, cy + dy - 1.5, st * 0.22, st * 0.14, 0, 0, Math.PI * 2); x.fill();
    }
  }
  COBBLE = c; return c;
}

// ---------------------------------------------------------------- geometry
// ---------------------------------------------------------------- geometry
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
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); }
const polysOf = (f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
// geometry converted to mercator once per (cached) feature
const polysM = (f) => f._pm || (f._pm = polysOf(f).map((p) => p.map((r) => r.map(toM))));
const linesM = (f) => f._lm || (f._lm = linesOf(f).map((l) => l.map(toM)));
const linesOf = (f) => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : []);

/** Minimum-area oriented rectangle of a ring (ground metres in, same units out). */
function obb(pts) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const ux = dx / L, uy = dy / L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of pts) { const a = x * ux + y * uy, b = -x * uy + y * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, ux, uy, a0, a1, b0, b1 };
  }
  if (!best) return null;
  const { ux, uy, a0, a1, b0, b1 } = best;
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  let len = a1 - a0, wid = b1 - b0, ang = Math.atan2(uy, ux);
  if (wid > len) { [len, wid] = [wid, len]; ang += Math.PI / 2; }
  return { cx: ca * ux - cb * uy, cy: ca * uy + cb * ux, len, wid, ang };
}

class Index {
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
    for (const id of this.b.get(Math.floor(x / this.G) + ',' + Math.floor(y / this.G)) || []) {
      const it = this.items[id];
      if (x < it.bb[0] || x > it.bb[2] || y < it.bb[1] || y > it.bb[3]) continue;
      if (inPoly(x, y, it.rings)) return it;
    }
    return null;
  }
}

// ---------------------------------------------------------------- canvas helpers
// ---------------------------------------------------------------- canvas helpers
function off(W, H) { if (typeof document === 'undefined') return new OffscreenCanvas(Math.max(1, W), Math.max(1, H)); const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }
function tracePolys(ctx, polys, P) {
  ctx.beginPath();
  for (const p of polys) for (const r of p) r.forEach((v, i) => { const [x, y] = P(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
}
// Fill each polygon on its own: neighbouring tiles deliver overlapping pieces of one polygon
// (the tile buffer), and an even-odd fill over all of them would cancel the overlaps into gaps.
function fillPolys(ctx, polys, P) {
  for (const p of polys) { ctx.beginPath(); for (const r of p) r.forEach((v, i) => { const [x, y] = P(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.fill('evenodd'); }
}
function traceLines(ctx, lines, P) {
  ctx.beginPath();
  for (const l of lines) l.forEach((v, i) => { const [x, y] = P(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
}
/** Soft ground layer: mask drawn sharp, blurred ONCE, then painted through. */
function softLayer(W, H, blur, drawMask, paint) {
  const m0 = off(W, H); drawMask(m0.getContext('2d'));
  const m = off(W, H), c = m.getContext('2d');
  c.filter = `blur(${blur}px)`; c.drawImage(m0, 0, 0); c.filter = 'none';
  c.globalCompositeOperation = 'source-in'; paint(c);
  return m;
}

/** Draw a sprite (a rectangle of the shared sheet) or any image. */
const drawS = (c, im, dx, dy, dw, dh) => (im.sheet ? c.drawImage(im.sheet, im.sx, im.sy, im.width, im.height, dx, dy, dw, dh) : c.drawImage(im, dx, dy, dw, dh));
export { SPR, SPRIDX, ASSETS, spritesReady, texturesReady, assetsReady, off, drawS };
/**
 * Paint one world-anchored chunk. opts: { chunk: [x0,y0,x1,y1] mercator, margin (mercator units),
 * band (zoom band), ppm (canvas px per ground metre), kF, comp, data(layer, bb), planOnly }.
 * Returns the chunk's object plan (objects anchored inside the chunk, in world coordinates),
 * label candidates, and (unless planOnly) the painted ground of chunk + margin.
 */
export async function paintRegion(opts) {
  // the quick first pass paints as soon as the textures are in, with whatever sprites have loaded
  if ((opts.lite || (opts.q || 1) < 0.75) && !opts.planOnly) await texturesReady; else await Promise.all([spritesReady, texturesReady, assetsReady]);
  const t0 = performance.now();
  const planOnly = !!opts.planOnly;
  const zoom = opts.band;
  const BC = opts.chunk, M = opts.margin;
  const BB = [BC[0] - M, BC[1] - M, BC[2] + M, BC[3] + M];
  const [vx0, vy0, vx1, vy1] = BC;
  const kF = opts.kF, k = kF;
  const ppm = opts.ppm, sx = ppm / kF;
  const W = Math.round((BB[2] - BB[0]) * sx), H = Math.round((BB[3] - BB[1]) * sx);
  const q = opts.q || 1, screenW = W, lite = !!opts.lite || q < 0.75; // lite: the quick first pass skips the fine ground detail
  const HB = [BC[0] - 700 * kF, BC[1] - 700 * kF, BC[2] + 700 * kF, BC[3] + 700 * kF]; // composition window
  const [lng, lat] = toLL([(BC[0] + BC[2]) / 2, (BC[1] + BC[3]) / 2]);
  const P = (v) => [(v[0] - BB[0]) * sx, (BB[3] - v[1]) * sx];
  const wxOf = (x) => BB[0] + x / sx, wyOf = (y) => BB[3] - y / sx;
  const inView = (x, y) => x >= vx0 && x < vx1 && y >= vy0 && y < vy1; // inside this chunk
  const inCanvas = (x, y) => x >= BB[0] && x <= BB[2] && y >= BB[1] && y <= BB[3];
  const stats = {};
  const tm = []; let tl = performance.now();
  const T = (l) => { const n = performance.now(); tm.push(`${l} ${Math.round(n - tl)}`); tl = n; };
  const worldPattern = (c2, tile, metres, rot = 0) => { const pat = c2.createPattern(tile, 'repeat'); const s = metres * ppm / tile.width, per = tile.width * s; const ox = -((BB[0] * sx) % per), oy = (BB[3] * sx) % per; const m = new DOMMatrix().translate(ox, oy).rotate(rot * 180 / Math.PI).scale(s); pat.setTransform(m); return pat; };

  // ------------------------------------------------------------ gather real data
  const Q = (layer, bb) => opts.data(layer, bb || BB);
  const G = 150 * kF;
  const wood = new Index(G), park = new Index(G), cemetery = new Index(G), orchard = new Index(G), farm = new Index(G);
  const woodP = [], parkP = [], farmP = [], wetP = [], sandP = [], rockP = [], waterP = [];
  const ovl = (bb) => !(bb[2] < BB[0] || bb[0] > BB[2] || bb[3] < BB[1] || bb[1] > BB[3]);
  for (const f of Q('landcover')) for (const m of polysM(f)) {
    if (!ovl(bboxOf(m))) continue;
    const c = f.properties.class, s = f.properties.subclass;
    if (c === 'wood') { woodP.push(m); wood.add(m, f.properties); }
    else if (c === 'farmland' && s !== 'orchard' && s !== 'vineyard') { farmP.push(m); farm.add(m, f.properties); }
    else if (s === 'orchard' || s === 'vineyard') orchard.add(m, f.properties);
    else if (c === 'grass' && ['park', 'garden', 'recreation_ground', 'village_green'].includes(s)) { parkP.push(m); park.add(m, f.properties); }
    else if (c === 'wetland') wetP.push(m);
    else if (c === 'sand') sandP.push(m);
    else if (c === 'rock') rockP.push(m);
  }
  for (const f of Q('park')) { if (!['park', 'garden'].includes(f.properties.class)) continue; for (const m of polysM(f)) { if (ovl(bboxOf(m))) { parkP.push(m); park.add(m, f.properties); } } }
  for (const f of Q('landuse')) for (const m of polysM(f)) {
    if (!ovl(bboxOf(m))) continue;
    if (f.properties.class === 'cemetery') cemetery.add(m, f.properties);
  }
  for (const f of Q('water')) {
    if (f.properties.brunnel === 'tunnel') continue;
    for (const m of polysM(f)) { if (ovl(bboxOf(m)) && (ringArea(m[0]) / (k * k) > 900 || (['river', 'ocean'].includes(f.properties.class) && ringArea(m[0]) / (k * k) > 40))) { m.still = ['lake', 'pond', 'reservoir', 'basin', 'swimming_pool'].includes(f.properties.class) || f.properties.intermittent; m.river = f.properties.class === 'river'; waterP.push(m); } }
  }
  // the water index reaches 300 m round the chunk: a village heart anchored here must see a canal next door
  const waterIdx = new Index(G); for (const p of waterP) waterIdx.add(p, {});
  { const WB = [BB[0] - 300 * kF, BB[1] - 300 * kF, BB[2] + 300 * kF, BB[3] + 300 * kF], seenW = new Set(waterP);
    for (const f of Q('water', WB)) { if (f.properties.brunnel === 'tunnel') continue; for (const m of polysM(f)) { if (seenW.has(m)) continue; const bb = bboxOf(m); if (bb[2] < WB[0] || bb[0] > WB[2] || bb[3] < WB[1] || bb[1] > WB[3]) continue; if (ringArea(m[0]) / (k * k) > 900 || (['river', 'ocean'].includes(f.properties.class) && ringArea(m[0]) / (k * k) > 40)) waterIdx.add(m, {}); } } }
  T('g-land');
  const riverL = [];
  for (const f of Q('waterway')) { if (f.properties.brunnel === 'tunnel' && !['stream', 'ditch', 'drain'].includes(f.properties.class)) continue; for (const l of linesM(f)) riverL.push({ cls: f.properties.class, pts: l, name: f.properties['name:latin'] || f.properties.name }); }
  const seen = new Set(), bld = [];
  // buildings only as mass: centre and area from the bounding box (no polygon is decoded)
  for (const f of (lite ? [] : opts.data('building', HB, true))) { // (the quick pass composes nothing)
    const m = f.mbb, cx = (m[0] + m[2]) / 2, cy = (m[1] + m[3]) / 2, key = (f.id ?? '') + ':' + Math.round(cx / 4) + ':' + Math.round(cy / 4);
    if (seen.has(key)) continue; seen.add(key);
    bld.push({ cx, cy, area: (m[2] - m[0]) * (m[3] - m[1]) / (kF * kF) * 0.5, key }); // a footprint fills about half its box
  }
  T('g-bld');
  const pois = [], seenP = new Set();
  for (const f of (lite ? [] : Q('poi', HB))) {
    if (f.geometry.type !== 'Point') continue;
    const m = toM(f.geometry.coordinates), key = (f.properties.name || '') + Math.round(m[0] / 5) + ':' + Math.round(m[1] / 5);
    if (seenP.has(key)) continue; seenP.add(key);
    pois.push({ ...f.properties, x: m[0], y: m[1] });
  }
  T('g-poi');
  const places = [];
  for (const f of Q('place', HB)) if (f.geometry.type === 'Point' && f.properties.name) places.push({ name: f.properties['name:latin'] || f.properties.name, cls: f.properties.class, m: toM(f.geometry.coordinates) });
  // roads (needed early: gates, house alignment)
  const MAIN = { motorway: 7, trunk: 6, primary: 5, secondary: 4 }, LANE = {}, MORE = { tertiary: 3.5, minor: 3, service: 2.5 };
  const roads = [], bridges = [], greens = [], minorL = [], trailL = [];
  // roads from a window 250 m wider than the chunk, so every chunk decides the same lanes the same way
  const BBX = [BB[0] - 250 * kF, BB[1] - 250 * kF, BB[2] + 250 * kF, BB[3] + 250 * kF];
  for (const f of Q('transportation', BBX)) {
    const c = f.properties.class; if (f.properties.brunnel === 'tunnel') continue;
    const lines = linesM(f);
    if (f.properties.brunnel === 'bridge' && !['rail', 'transit'].includes(c)) for (const l of lines) bridges.push({ c, pts: l });
    const w = MAIN[c] || (c === 'tertiary' ? 2.6 : 0) || (opts.roads === 'all' ? LANE[c] || MORE[c] : 0);
    if (['minor', 'service', 'tertiary', 'secondary'].includes(c)) for (const l of lines) { l.cls = c; l.service = c === 'service'; minorL.push(l); }
    if (['path', 'track'].includes(c)) for (const l of lines) trailL.push(l);
    for (const l of lines) {
      const closed = l.length > 4 && Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 1;
      const bb = bboxOf([l]);
      if (closed && (bb[2] - bb[0]) / k < 90) { greens.push({ x: (bb[0] + bb[2]) / 2, y: (bb[1] + bb[3]) / 2, r: (bb[2] - bb[0]) / 2 }); continue; } // roundabout → green
      if (w) roads.push({ w, pts: l, main: !!MAIN[c], oneway: f.properties.oneway === 1, c });
      else if (c === 'path' && opts.roads === 'all') roads.push({ w: 1.8, pts: l, foot: true });
    }
  }
  let roadDbg = '';
  // a dual carriageway is one track: drop a oneway line that runs alongside a kept one of its class
  {
    const nMain0 = roads.length;
    const dens = (pts, st) => { const o2 = []; for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / st)); for (let m = 0; m < n; m++) o2.push([ax + (bx - ax) * m / n, ay + (by - ay) * m / n]); } o2.push(pts[pts.length - 1]); return o2; };
    const kept = [];
    for (const r of roads.filter((r2) => r2.oneway)) {
      const ri = roads.indexOf(r);
      const d = dens(r.pts, 12 * kF);
      const near2 = (pt) => kept.some((o2) => o2.c === r.c && o2.d.some((v) => Math.hypot(v[0] - pt[0], v[1] - pt[1]) < 40 * kF));
      // drop a carriageway only when nearly all of it runs beside a kept one (never cut stubs)
      if (d.filter(near2).length >= d.length * 0.85) roads.splice(ri, 1); else kept.push({ c: r.c, d });
    }
    roadDbg = `${nMain0}→${roads.length} road lines after merging dual carriageways`;
  }
  const trailHash = new Set();
  for (const l of trailL) for (let i = 1; i < l.length; i++) { const [ax, ay] = l[i - 1], [bx, by] = l[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (4 * kF))); for (let m = 0; m <= n; m++) trailHash.add(Math.floor((ax + (bx - ax) * m / n) / (8 * kF)) + ',' + Math.floor((ay + (by - ay) * m / n) / (8 * kF))); }
  const nearTrail = (x, y) => { const i = Math.floor(x / (8 * kF)), j = Math.floor(y / (8 * kF)); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (trailHash.has((i + a) + ',' + (j + b))) return true; return false; };
  T('g-roads');
  // the quick pass does not wait for the elevation tiles (flat until the full paint arrives)
  const dem = lite ? () => 0 : await demSampler(BB, 14);
  T('gather');

  // ------------------------------------------------------------ composition
  // Village hearts: one named village centre per screen-sized area, at the real densest spot,
  // snapped to the most meaningful real place nearby (square or market, church, town hall,
  // station). Density sets how big the heart is and how close the next one stands.
  const OPEN = opts.comp === 'open';
  const DG = 20 * kF;
  const gi0 = Math.floor(HB[0] / DG), gj0 = Math.floor(HB[1] / DG);
  const GW = Math.ceil(HB[2] / DG) - gi0 + 1, GH = Math.ceil(HB[3] / DG) - gj0 + 1;
  const raw = new Float32Array(GW * GH);
  for (const bd of bld) { const i = Math.floor(bd.cx / DG) - gi0, j = Math.floor(bd.cy / DG) - gj0; if (i >= 0 && j >= 0 && i < GW && j < GH) raw[j * GW + i] += bd.area / 400; }
  const boxBlur = (src, r) => {
    const a = new Float32Array(src.length), b3 = new Float32Array(src.length);
    for (let j = 0; j < GH; j++) { let s2 = 0; for (let i = -r; i < GW + r; i++) { if (i + r < GW && i + r >= 0) s2 += src[j * GW + i + r]; if (i - r - 1 >= 0 && i - r - 1 < GW) s2 -= src[j * GW + i - r - 1]; if (i >= 0 && i < GW) a[j * GW + i] = s2 / (2 * r + 1); } }
    for (let i = 0; i < GW; i++) { let s2 = 0; for (let j = -r; j < GH + r; j++) { if (j + r < GH && j + r >= 0) s2 += a[(j + r) * GW + i]; if (j - r - 1 >= 0 && j - r - 1 < GH) s2 -= a[(j - r - 1) * GW + i]; if (j >= 0 && j < GH) b3[j * GW + i] = s2 / (2 * r + 1); } }
    return b3;
  };
  const mass = boxBlur(boxBlur(raw, 6), 6);
  const massAt = (x, y) => { const i = Math.floor(x / DG) - gi0, j = Math.floor(y / DG) - gj0; return i < 0 || j < 0 || i >= GW || j >= GH ? 0 : mass[j * GW + i]; };
  // real anchors, by how strongly they make a village centre
  const anchors = [];
  for (const p of pois) {
    const c = p.class, n = p.name || '';
    let pr = 0, kind = null;
    if (c === 'marketplace' || p.subclass === 'marketplace' || /platz|plein|square|piazza|markt/i.test(n) && ['place', 'marketplace', 'attraction'].includes(c)) { pr = 5; kind = 'square'; }
    else if (c === 'place_of_worship' && n && !/projekt|verein|gruppe|wohn|scientology|center|centre|kingdom|gemeinde|mission|zentrum/i.test(n)) { pr = 4; kind = 'church'; }
    else if (c === 'town_hall') { pr = 4; kind = 'hall'; }
    else if (c === 'railway' && /station|bahnhof|centraal|terminal/i.test(n)) { pr = 3; kind = 'station'; }
    if (kind) anchors.push({ ...p, kind, pr });
  }
  const CB = 8, cand = [];
  for (let J = Math.floor(gj0 / CB) * CB; J < gj0 + GH; J += CB) for (let I = Math.floor(gi0 / CB) * CB; I < gi0 + GW; I += CB) {
    let best = -1, bi = 0, bj = 0;
    for (let j = J; j < J + CB; j++) for (let i = I; i < I + CB; i++) { const li = i - gi0, lj = j - gj0; if (li < 0 || lj < 0 || li >= GW || lj >= GH) continue; const v = mass[lj * GW + li]; if (v > best) { best = v; bi = i; bj = j; } }
    if (best > 0.03) cand.push({ x: (bi + 0.5) * DG, y: (bj + 0.5) * DG, m: best });
  }
  // famous real places pull the village heart to themselves: an important church or square nearby
  // counts as extra density
  for (const a of anchors) { if (a.kind !== 'church' && a.kind !== 'square') continue; const imp = a.rank != null ? Math.max(0, (25 - a.rank) / 25) : 0.2; cand.push({ x: a.x, y: a.y, m: massAt(a.x, a.y) * (1.6 + imp * 0.8), anchorFirst: a }); }
  cand.sort((a, b2) => b2.m - a.m);
  if (lite) cand.length = 0; // the quick first pass: ground, water and main roads only
  const tierOf = (m) => (m > 0.4 ? 3 : m > 0.22 ? 2 : m > 0.1 ? 1 : 0);
  const SPACING = OPEN ? [560, 650, 740, 860] : [360, 400, 460, 540];
  const RADIUS = OPEN ? [44, 57, 70, 83] : [58, 78, 96, 112];
  // one village heart per fixed world cell (420 m; 700 m in open country) at its strongest real
  // place, so every screen-sized area has a centre wherever people live; a heart that would crowd
  // a stronger neighbour across a cell border is dropped
  const hearts = [];
  const CELL = (OPEN ? 900 : 480) * kF, MIND = (OPEN ? 600 : 400) * kF, MIND_SMALL = 460 * kF; // round 7: about one heart per phone screen
  const best = new Map();
  // where people are: on main roads, at their crossings and by the water (main road samples every 15 m)
  const mainHash = new Map(); for (const r of roads) if (r.main || r.c === 'tertiary') for (let i = 1; i < r.pts.length; i++) { const [ax, ay] = r.pts[i - 1], [bx, by] = r.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (15 * kF))), a = Math.atan2(by - ay, bx - ax); for (let m = 0; m <= n; m++) { const x = ax + (bx - ax) * m / n, y = ay + (by - ay) * m / n, k3 = Math.floor(x / (40 * kF)) + ',' + Math.floor(y / (40 * kF)); if (!mainHash.has(k3)) mainHash.set(k3, []); mainHash.get(k3).push([x, y, a]); } }
  const placeBonus = (x, y) => {
    const near = []; const i0 = Math.floor(x / (40 * kF)), j0 = Math.floor(y / (40 * kF)); for (let a = -1; a <= 1; a++) for (let b2 = -1; b2 <= 1; b2++) for (const q of mainHash.get((i0 + a) + ',' + (j0 + b2)) || []) if (Math.hypot(q[0] - x, q[1] - y) < 40 * kF) near.push(q[2]);
    let k3 = 1; if (near.length) k3 *= 1.25; if (near.some((a) => near.some((b2) => Math.abs(Math.sin(a - b2)) > 0.5))) k3 *= 1.15;
    if (waterIdx.at(x + 60 * kF, y) || waterIdx.at(x - 60 * kF, y) || waterIdx.at(x, y + 60 * kF) || waterIdx.at(x, y - 60 * kF)) k3 *= 1.35; // the old towns stand on the water
    if (bridges.some((br) => Math.hypot(br.pts[0][0] - x, br.pts[0][1] - y) < 160 * kF)) k3 *= 1.2; // ... by their bridge
    return k3;
  };
  const score = (c0) => { const fx = c0.x / CELL - Math.floor(c0.x / CELL) - 0.5, fy = c0.y / CELL - Math.floor(c0.y / CELL) - 0.5; return c0.m * placeBonus(c0.x, c0.y) * (1 - 0.6 * Math.hypot(fx, fy)); }; // near the cell's middle: an even lattice of villages
  for (const c0 of cand) { if (c0.m < 0.06) continue; const key = Math.floor(c0.x / CELL) + ',' + Math.floor(c0.y / CELL); const b0 = best.get(key); if (!b0 || score(c0) > score(b0)) best.set(key, c0); }
  for (const c0 of [...best.values()].sort((a, b2) => b2.m - a.m)) {
    const t = tierOf(c0.anchorFirst ? c0.m / 1.8 : c0.m), sp = SPACING[3 - t] * kF;
    if (hearts.some((h) => Math.hypot(h.x0 - c0.x, h.y0 - c0.y) < (t <= 1 || h.t <= 1 ? MIND_SMALL : MIND))) continue;
    // snap to the most meaningful real place within reach
    let anchor = c0.anchorFirst || null, as = c0.anchorFirst ? 1e9 : -1;
    for (const a of anchors) { if (c0.anchorFirst) break; const d = Math.hypot(a.x - c0.x, a.y - c0.y); if (d > 190 * kF) continue; const sc = a.pr * 100 - d / kF; if (sc > as) { as = sc; anchor = a; } }
    let x = c0.x, y = c0.y;
    if (anchor) {
      x = anchor.x; y = anchor.y;
      if (anchor.kind === 'church') { // the square opens in front of the church, towards the village
        let dx = c0.x - anchor.x, dy = c0.y - anchor.y, L = Math.hypot(dx, dy); if (L < 10 * kF) { dx = 0.3; dy = -1; L = Math.hypot(dx, dy); }
        x = anchor.x + dx / L * 55 * kF; y = anchor.y + dy / L * 55 * kF;
      }
    }
    if (waterIdx.at(x, y)) { x = c0.x; y = c0.y; if (waterIdx.at(x, y)) continue; }
    hearts.push({ x, y, x0: c0.x, y0: c0.y, sp, m: c0.m, t, R: RADIUS[t] * kF, anchor, key: Math.round(c0.x / DG) + ',' + Math.round(c0.y / DG) });
  }
  // farmsteads: smaller real mass peaks between the hearts
  const steads = [];
  for (const c0 of cand) {
    if (hearts.some((h) => Math.hypot(h.x - c0.x, h.y - c0.y) < h.R * 2.6) || steads.some((s2) => Math.hypot(s2.x - c0.x, s2.y - c0.y) < (OPEN ? 360 : c0.m > 0.2 ? 190 : 300) * kF)) continue;
    if (waterIdx.at(c0.x, c0.y) || wood.at(c0.x, c0.y)) continue;
    steads.push({ x: c0.x, y: c0.y, m: c0.m });
  }
  // names: the nearest real neighbourhood or village label, else the anchor's own name
  const used = new Set();
  for (const h of [...hearts].sort((a, b2) => b2.m - a.m)) {
    let best = null, bd = 650 * kF;
    for (const p of places) { if (used.has(p.name) || !['suburb', 'quarter', 'neighbourhood', 'village', 'town', 'hamlet'].includes(p.cls)) continue; const d = Math.hypot(p.m[0] - h.x, p.m[1] - h.y); if (d < bd) { bd = d; best = p; } }
    if (best) { h.name = best.name; used.add(best.name); }
    else if (h.anchor && h.anchor.name && ((h.anchor.kind === 'church' && /kirche|kerk|church|chapel|kapelle|cathedral|dom\b|basilica|münster|abbey|kloster|st\.|saint|sankt|san |santa |notre|minster/i.test(h.anchor.name)) || (h.anchor.kind === 'square' && /platz|plein|square|piazza|markt|place\b|plaza/i.test(h.anchor.name)))) { h.name = shortName(h.anchor.name); h.nameIsAnchor = true; }
  }
  const nearestHeart = (x, y) => { let best = null, bd = Infinity; for (const h of hearts) { const d = Math.hypot(h.x - x, h.y - y) / h.R; if (d < bd) { bd = d; best = h; } } return [best, bd]; };
  T('compose');

  // ------------------------------------------------------------ world indexes (pure: world coordinates only)
  const canvas = off(planOnly ? 1 : W, planOnly ? 1 : H);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.globalAlpha = 1;
  const smooth = (a, b, v) => Math.max(0, Math.min(1, (v - a) / (b - a)));
  let floor = 600; // a fixed valley base (a chunk's own lowest point made seams between chunks)
  const ROADW = { motorway: 12, trunk: 11, primary: 10, secondary: 9, tertiary: 7, minor: 5.5, service: 4 };
  const MAINC = new Set(['motorway', 'trunk', 'primary', 'secondary']);
  const streets = [...roads.map((r) => ({ pts: r.pts, w: ROADW[r.c] || 10, main: MAINC.has(r.c), cls: r.c })), ...minorL.filter((l) => !l.service).map((l) => ({ pts: l, w: ROADW[l.cls] || 5.5, main: l.cls === 'secondary', cls: l.cls }))];
  // street samples every 4 m in 12 m buckets: the distance from any point to the nearest street edge
  const SG = 12 * kF, sHash = new Map();
  for (const L of streets) for (let i = 1; i < L.pts.length; i++) {
    const [ax, ay] = L.pts[i - 1], [bx, by] = L.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (4 * kF)));
    for (let m = 0; m <= n; m++) { const x = ax + (bx - ax) * m / n, y = ay + (by - ay) * m / n, key = Math.floor(x / SG) + ',' + Math.floor(y / SG); if (!sHash.has(key)) sHash.set(key, []); sHash.get(key).push([x, y, L.w * kF / 2, Math.atan2(by - ay, bx - ax), L.main]); }
  }
  const streetNear = (x, y, r = 40 * kF) => { let best = null, bd = Infinity; const i0 = Math.floor((x - r) / SG), i1 = Math.floor((x + r) / SG), j0 = Math.floor((y - r) / SG), j1 = Math.floor((y + r) / SG); for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const s of sHash.get(i + ',' + j) || []) { const d = Math.hypot(s[0] - x, s[1] - y) - s[2]; if (d < bd) { bd = d; best = s; } } return [bd / kF, best]; };
  // real buildings in 20 m buckets: what stands around a point
  const BG = 20 * kF, bHash = new Map();
  for (const bd of bld) { const key = Math.floor(bd.cx / BG) + ',' + Math.floor(bd.cy / BG); if (!bHash.has(key)) bHash.set(key, []); bHash.get(key).push(bd); }
  const localStats = (x, y, r) => { let nb = 0, area = 0; const i0 = Math.floor((x - r) / BG), i1 = Math.floor((x + r) / BG), j0 = Math.floor((y - r) / BG), j1 = Math.floor((y + r) / BG); for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const bd of bHash.get(i + ',' + j) || []) if (Math.hypot(bd.cx - x, bd.cy - y) < r) { nb++; area += bd.area; } return { nb, area, avg: nb ? area / nb : 0, cover: Math.min(1, area / (Math.PI * (r / kF) ** 2)) }; };
  const onLand = (mx, my, r = 0) => !waterIdx.at(mx, my) && (!r || [0, 1, 2, 3, 4, 5, 6, 7].every((a) => !waterIdx.at(mx + Math.cos(a * 0.785) * r, my + Math.sin(a * 0.785) * r)));
  const H01 = (x, y, s) => hash(Math.round(x / kF), Math.round(y / kF), s);
  // the main street direction at each village heart, and its square: a paved rectangle along it
  for (const h of hearts) {
    let sx2 = 0, sy2 = 0;
    for (let a = 0; a < 16; a++) { const [, s] = streetNear(h.x + Math.cos(a / 16 * 6.283) * 30 * kF, h.y + Math.sin(a / 16 * 6.283) * 30 * kF, 50 * kF); if (s) { const w = s[4] ? 2 : 1; sx2 += Math.cos(2 * s[3]) * w; sy2 += Math.sin(2 * s[3]) * w; } }
    h.ang = Math.atan2(sy2, sx2) / 2; h.pa = (17 + 5 * h.t) * kF; h.pb = (12 + 4 * h.t) * kF; h.plazaR = Math.hypot(h.pa, h.pb) / kF;
  }
  const inPlaza = (h, x, y, pad = 0) => { const c = Math.cos(h.ang), s = Math.sin(h.ang), dx = x - h.x, dy = y - h.y, u = dx * c + dy * s, v = -dx * s + dy * c; return Math.abs(u) < h.pa + pad && Math.abs(v) < h.pb + pad; };
  const core = (x, y) => { const [h, dh] = nearestHeart(x, y); return (h && h.t >= 2 && dh < 2.4) || localStats(x, y, 60 * kF).cover > 0.3; };
  T('index');

  // ------------------------------------------------------------ objects: every one a painted sprite
  const objs = [];
  const TREE = SPR['forest-deciduous-round'] ? 'forest-deciduous-round' : 'forest-clump';
  const zs = Math.pow(2, (16 - zoom) * 0.35);
  const SYM = 1.15; // the targets draw everything over life size
  const sizeOf = (name) => (SIZE[name] || 30) * ppm * zs * SYM;
  const repCount = new Map(), RC = 160 * kF, NOCAP = /-(ew|ns|ne-sw|nw-se)$|^decals|^lily|^river-|^rocky-bank|^gravel-bar|^banner|^lantern|^kerb|^quay|^rowing|^churchyard|^castle|^market-stall|fountain|^well$|^reeds$|^haystack$/;
  const kindOf = (n) => n.replace(/-(40|80|160)-(ew|ns|ne-sw|nw-se)$/, '');
  // a pure world rule: each kind may stand only in about a third of the 160 m world cells (chosen by a hash of
  // kind and cell), once per cell, so any one drawing appears about three times per phone screen at most
  const kindSeed = (k3) => { let h9 = 7; for (let i = 0; i < k3.length; i++) h9 = (h9 * 31 + k3.charCodeAt(i)) % 9973; return 4000 + h9; };
  const capped = (name, x, y) => { if ((NOCAP.test(name) && !/-(40|80|160)-/.test(name)) || (SPRIDX[name] && SPRIDX[name].set)) return false; const k3 = kindOf(name), i0 = Math.floor(x / RC), j0 = Math.floor(y / RC); if (hash(i0, j0, kindSeed(k3)) > (/-(40|80|160)-/.test(name) ? 0.36 : 0.3)) return true; return (repCount.get(k3 + '|' + i0 + ',' + j0) || 0) >= 1; };
  const counted = (name, x, y) => { const key = kindOf(name) + '|' + Math.floor(x / RC) + ',' + Math.floor(y / RC); repCount.set(key, (repCount.get(key) || 0) + 1); };
  const put = (name, x, y, o = {}) => {
    if (lite) return null;
    const img = SPR[name] || ASSETS[name]; if (!img) return null;
    const meta = SPRIDX[name] || { ax: 0.5, ay: 0.9, foot: 0.8 };
    let w = (o.w || sizeOf(name)) * (o.s || 1) * (name === TREE && !o.full ? 0.55 : 1), h = w * img.height / img.width; if (o.ws) w *= o.ws; if (o.hs) h *= o.hs;
    const ob = { t: 'spr', name, img, x, y, w, h, ax: o.ax ?? meta.ax, ay: o.ay ?? meta.ay, foot: meta.foot, flip: !!o.flip, rot: o.rot || 0, shadow: o.shadow ?? 1, z: o.z || 0 };
    objs.push(ob); return ob;
  };
  // ground occupancy (world 4 m cells) so sprites never stack; roads keep their own, narrower clearance
  const OC = 4 * kF, occ = new Set();
  const hitW = (x, y, r) => { for (let i = Math.floor((x - r) / OC); i <= Math.floor((x + r) / OC); i++) for (let j = Math.floor((y - r * 0.6) / OC); j <= Math.floor((y + r * 0.75) / OC); j++) if (occ.has(i + ',' + j)) return true; return false; };
  const freeW = (x, y, r, roadClear = Math.min(r * 0.45, 8 * kF)) => !hitW(x, y, r) && streetNear(x, y)[0] * kF > roadClear && !hearts.some((h) => inPlaza(h, x, y, 4 * kF));
  const takeW = (x, y, r) => { for (let i = Math.floor((x - r) / OC); i <= Math.floor((x + r) / OC); i++) for (let j = Math.floor((y - r * 0.6) / OC); j <= Math.floor((y + r * 0.6) / OC); j++) occ.add(i + ',' + j); };
  const putW = (name, mx, my, o = {}) => { if (!lite && capped(name, mx, my)) return null; const [x, y] = P([mx, my]); const ob = put(name, x, y, o); if (ob) { ob.wx = mx; ob.wy = my; counted(name, mx, my); } return ob; };
  const lots = [], fields = [], paddocks = [];
  // a sprite's footprint must stay on dry land
  const footDry = (mx, my, halfW) => onLand(mx, my, halfW) && onLand(mx, my + halfW * 0.5, halfW * 0.7);
  // regional character: Alpine (onion domes, stone walls), Low Countries (canal houses), North America
  const ALP = lng > 5.5 && lng < 16.5 && lat > 45.5 && lat < 48.3, NA = lng < -50;
  const lowlands = lng > 2 && lng < 15 && lat > 50.5, canalCity = lowlands && riverL.some((r) => r.cls === 'canal');
  const ROOFS = ALP ? ['red-tile', 'grey-slate', 'mossy', 'grey-slate'] : lowlands ? ['grey-slate', 'red-tile', 'mossy', 'thatch'] : NA ? ['grey-slate', 'mossy', 'thatch', 'red-tile'] : ['thatch', 'mossy', 'grey-slate', 'red-tile'];
  // the set-one houses get their roof and chimney variants (the original stays in the mix)
  const roofed = (name, x, y) => {
    const base = name === 'timber-frame-house' ? 'timber-frame' : name === 'stone-house' ? 'stone-house' : null; if (!base) return name;
    const r = H01(x, y, 2101); if (r < 0.45) return name;
    const n2 = `${base}-roof-${ROOFS[Math.floor(H01(x, y, 2103) * ROOFS.length)]}-${H01(x, y, 2105) < 0.3 ? 'smoke' : 'clear'}`;
    return SPR[n2] ? n2 : name;
  };

  // oriented modules: four drawn directions per family; a run takes the nearest and turns by the rest
  const ORI = ['ew', 'ne-sw', 'ns', 'nw-se'];
  const orient = (ang) => { const a = ((ang % Math.PI) + Math.PI) % Math.PI, k2 = Math.round(a / (Math.PI / 4)); return [ORI[k2 % 4], a - k2 * Math.PI / 4]; };
  /** One straight module of a family centred on (mx, my), covering G metres of ground along `ang`. */
  const putMod = (fam, mx, my, ang, G, o = {}) => {
    const [b, res] = orient(ang), name = `${fam}-${b}`, img = SPR[name]; if (!img) return null;
    const ew = SPRIDX[`${fam}-ew`], thick = ew ? G * ew.oh / ew.ow : G * 0.2;
    const w = b === 'ew' ? G : b === 'ns' ? (G + thick * 0.4) * img.width / img.height : (G + thick) * 0.7071;
    const th = o.thick || 1;
    return putW(name, mx, my, { w: w * ppm * (o.k || 1.06), ws: b === 'ns' ? th : 1, hs: b === 'ew' ? th : 1, ax: 0.5, ay: o.ay ?? (b === 'ew' ? 0.6 : 0.5), rot: -res, shadow: 0, z: o.z || 0 });
  };
  /** Modules along a straight edge between two world points (lots, fields, squares). */
  const edgeMods = (fam, x0, y0, x1, y1, Gt, o = {}) => {
    const len = Math.hypot(x1 - x0, y1 - y0) / kF; if (len < 3) return;
    const n = Math.max(1, Math.round(len / Gt)), ang = Math.atan2(y1 - y0, x1 - x0);
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; putMod(fam, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, ang, len / n, o); }
  };
  // points along real lines on a fixed world grid (the same points whichever tile delivered the line)
  const seenMod = new Set();
  const alongW = (pts, step, fn, tag = '', skipAxis = false) => {
    const st = step * 0.85;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy); if (len < 1e-9) continue;
      if (skipAxis && (dx === 0 || dy === 0)) continue; // a tile's clip edge, not a real one
      const hor = Math.abs(dx) >= Math.abs(dy), ta = hor ? ax : ay, tb = hor ? bx : by, lo = Math.min(ta, tb), hi = Math.max(ta, tb);
      const spM = st * len / (hor ? Math.abs(dx) : Math.abs(dy)) / kF;
      for (let kk = Math.ceil(lo / st); kk * st < hi; kk++) {
        const t = (kk * st - ta) / (tb - ta), x = ax + dx * t, y = ay + dy * t;
        const key = tag + Math.round(x / kF) + ',' + Math.round(y / kF); if (seenMod.has(key)) continue; seenMod.add(key);
        fn(x, y, Math.atan2(dy, dx), -dy / len, dx / len, spM, len / kF);
      }
    }
  };
  // the fence of a lot: back and both sides of a rectangle (u along the street, v towards it)
  const lotFence = (fam, cx, cy, nx, ny, r, hd = 0.8 * r) => {
    const C = (u, v) => [cx + u * ny * r - v * nx * hd, cy - u * nx * r - v * ny * hd];
    const a = C(-1, -1), b2 = C(1, -1), c2 = C(1, 1), d2 = C(-1, 1);
    const o3 = { thick: 1.6, k: 1.08 }; edgeMods(fam, a[0], a[1], b2[0], b2[1], 12, o3); edgeMods(fam, b2[0], b2[1], c2[0], c2[1], 12, o3); edgeMods(fam, d2[0], d2[1], a[0], a[1], 12, o3);
  };
  const lotFam = (x, y, town) => { const r = H01(x, y, 2111); return ALP ? (r < 0.4 ? 'stone-wall' : 'fence') : town ? (r < 0.55 ? 'fence' : r < 0.8 ? 'hedge' : 'stone-wall') : (r < 0.75 ? 'fence' : 'hedge'); };

  // is a point in a city core (cached on a 40 m world grid)
  const isCore = new Map(); const coreAt = (x, y) => { const k3 = Math.round(x / (40 * kF)) + ',' + Math.round(y / (40 * kF)); if (!isCore.has(k3)) isCore.set(k3, core(Math.round(x / (40 * kF)) * 40 * kF, Math.round(y / (40 * kF)) * 40 * kF)); return isCore.get(k3); };
  // ---- round 7: code places, it does not compose. One stand-in per village heart (until the painted
  //      set pieces arrive), farmstead compounds between them, scenery on real land use.
  // the castle (UI Assets) only where a real palace or castle stands, in a big heart
  const special = [];
  for (const h of hearts) {
    if (h.t < 2) continue;
    const hall = pois.find((p) => (p.class === 'castle' || (['attraction', 'museum', 'castle'].includes(p.class) && /palace|palais|schloss|paleis/i.test(p.name || ''))) && Math.hypot(p.x - h.x, p.y - h.y) < h.R * 2);
    if (hall) special.push({ h, name: `castle_${h.t === 3 ? 3 : 2}`, label: hall.name, x: hall.x, y: hall.y });
  }
  for (const s3 of special) if (inCanvas(s3.x, s3.y) && SPR[s3.name] && footDry(s3.x, s3.y, 18 * kF) && !hitW(s3.x, s3.y, 18 * kF)) { putW(s3.name, s3.x, s3.y, { w: 62 * ppm * zs, ay: 0.84 }); takeW(s3.x, s3.y, 26 * kF); s3.drawn = true; }
  // real churches: the type by name, region and how built-up the place is
  const churchRe = /kirche|kerk|church|chapel|kapelle|cathedral|dom\b|basilica|münster|abbey|kloster|stift|wallfahrt|st\.|saint|sankt|san |santa |notre|chiesa|igreja|iglesia|minster|priory/i;
  const abbey = (n) => /abbey|kloster|stift|wallfahrt|monastery|priory|abtei/i.test(n);
  const landmark = (n) => abbey(n) || /cathedral|\bdom\b|basilica|münster|kathedrale|minster|st\.? patrick/i.test(n);
  const churchSprite = (c) => {
    const n = c.name;
    if (abbey(n) && SPR.monastery) return 'monastery';
    if (/cathedral|\bdom\b|basilica|münster|kathedrale|minster|st\.? patrick/i.test(n) && SPR.cathedral) return 'cathedral';
    if (/chapel|kapelle|kapel\b/i.test(n)) return SPR['church-parish'] ? 'church-parish' : 'chapel';
    if (ALP && SPR['church-baroque-onion']) return 'church-baroque-onion';
    if (localStats(c.x, c.y, 120 * kF).cover > 0.16 && SPR['church-tall-spire']) return 'church-tall-spire';
    return SPR['church-parish'] ? 'church-parish' : 'chapel';
  };
  const allCh = [];
  for (const p of [...pois].sort((a, b2) => a.x - b2.x || a.y - b2.y)) {
    if (p.class !== 'place_of_worship' || !p.name || !churchRe.test(p.name)) continue;
    if (allCh.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 140 * kF)) continue;
    p.sprite = churchSprite(p); allCh.push(p);
  }
  // a heart's own church is part of it; elsewhere only real landmarks (cathedrals, abbeys) stand alone
  for (const h of hearts) { const c = h.anchor && h.anchor.kind === 'church' ? allCh.find((u) => Math.hypot(u.x - h.anchor.x, u.y - h.anchor.y) < 30 * kF) : allCh.find((u) => Math.hypot(u.x - h.x, u.y - h.y) < h.R * 0.9); if (c) { h.church = c; c.heart = h; } }
  const churches = allCh.filter((c) => inCanvas(c.x, c.y) && (c.heart || (landmark(c.name) && nearestHeart(c.x, c.y)[1] > 1.6)));
  const placeChurch = (c) => {
    const name = c.sprite, hw = sizeOf(name) / ppm * kF * 0.4;
    let at = null;
    for (const [dx, dy] of [[0, 0], [0, -12], [12, 0], [-12, 0], [0, 12], [0, -24], [20, -12], [-20, -12]]) { const x = c.x + dx * kF, y = c.y + dy * kF; if (footDry(x, y, hw) && freeW(x, y, hw * 0.8, 2 * kF)) { at = [x, y]; break; } }
    if (!at) return false;
    if (!c.heart) yardBase(at[0], at[1], 80);
    putW(name, at[0], at[1], { s: /chapel|parish/.test(name) ? 1.1 : 0.92 }); takeW(at[0], at[1], hw * 1.2); c.drawn = true; c.dx = at[0]; c.dy = at[1];
    return true;
  };
  // A. village hearts: one painted set piece per heart (set four), chosen by tier and setting, its anchor
  //    (well, green or market) on the heart, its entrances joined to the real roads
  const pieces = [], ports = [];
  const spImgM = (n) => SPRIDX[n].foot_m[0] * 1.12; // the image spans about 1.12 x the east-west footprint
  const waterSide = (x, y, r) => {
    let best = null, bd = Infinity;
    for (let a = 0; a < 16; a++) { const ca = Math.cos(a / 16 * 6.283), sa = Math.sin(a / 16 * 6.283); for (let d = 15; d <= r; d += 10) if (waterIdx.at(x + ca * d * kF, y + sa * d * kF)) { if (d < bd) { bd = d; best = [ca, sa]; } break; } }
    if (!best) return null;
    return { side: Math.abs(best[0]) > Math.abs(best[1]) ? (best[0] < 0 ? 'west' : 'east') : (best[1] < 0 ? 'south' : 'north'), d: bd, ex: best[0] };
  };
  const pickOf = (list, x, y, seed) => { const l = list.filter((n) => SPR[n] && SPRIDX[n]); return l.length ? l[Math.floor(H01(x, y, seed) * l.length)] : null; };
  /** Put a set piece with its anchor on (x, y); returns the piece or null. */
  const placePiece = (name, x, y, o = {}) => {
    const m = SPRIDX[name]; if (lite || !m || !SPR[name]) return null;
    if (o.unique && pieces.some((p2) => p2.name === name && Math.hypot(p2.x - x, p2.y - y) < 200 * kF)) return null;
    const wM = (o.wM || spImgM(name) * (o.k || 1)), hM = wM * m.h / m.w, flip = !!o.flip, kk = wM / spImgM(name);
    const pc = { name, x, y, wM, hM, flip, m, fw: m.foot_m[0] * kk, fh: m.foot_m[1] * kk };
    // the ground footprint centre, from the anchor's place in the image
    pc.cx = x + ((flip ? -1 : 1) * (0.5 - m.ax)) * wM * kF; pc.cy = y - (0.5 - m.ay) * hM * kF * 0.9;
    if (capped(name, x, y)) return null;
    if (inCanvas(x, y) || inCanvas(pc.cx, pc.cy)) { const ob = putW(name, x, y, { w: wM * ppm, ax: m.ax, ay: m.ay, flip, shadow: 0, z: o.z ?? -0.5 }); if (ob) { ob.box = [pc.fw, pc.fh]; ob.bcx = pc.cx; ob.bcy = pc.cy; } }
    for (let u = -0.5; u <= 0.5; u += 0.1) for (let v = -0.5; v <= 0.5; v += 0.1) takeW(pc.cx + u * pc.fw * kF, pc.cy + v * pc.fh * kF, OC);
    for (const p of m.ports || []) { const px = x + (flip ? -1 : 1) * (p.uv[0] - m.ax) * wM * kF, py = y - (p.uv[1] - m.ay) * hM * kF; ports.push({ x: px, y: py, piece: pc, main: p.role === 'main' }); }
    pieces.push(pc); return pc;
  };
  /** A clump of trees: one painted clump (set five) by size, or single round trees where none is drawn. */
  const paintedClump = (x, y, n, seed, o = {}) => {
    const sizes = n <= 3 ? ['deciduous-trio-round', 'deciduous-trio-hook'] : n <= 5 ? ['deciduous-five-round', 'deciduous-five-hook'] : n <= 9 ? ['deciduous-eight-round', 'deciduous-five-round'] : ['deciduous-dozen-round', 'deciduous-dozen-hook', 'deciduous-eight-round'];
    const nm = pickOf(sizes, x, y, seed);
    if (nm && placePiece(nm, x, y, { z: 0, k: 1.15, flip: H01(x, y, seed + 3) < 0.5 })) return true;
    const pool = ['landmark-silver-birch', 'round-tree-beech', 'landmark-sweet-chestnut', 'round-tree-young-oak', 'landmark-lombardy-poplar', 'round-tree-linden', ALP ? 'landmark-mountain-rowan' : 'bush-hawthorn'];
    for (let t = 0; t < n; t++) { const a = t * 2.3 + H01(x, y, seed) * 6, rr = t ? (7 + t * 2.5) * kF : 0, tx = x + Math.cos(a) * rr, ty = y + Math.sin(a) * rr * 0.8; if (inCanvas(tx, ty) && onLand(tx, ty, 4 * kF)) putW(pool[(Math.floor(H01(x, y, seed + 1) * pool.length) + t * 3) % pool.length], tx, ty, { s: 0.95 + H01(tx, ty, seed + 2) * 0.35, shadow: 0.9, flip: t % 2 === 1 }); }
    takeW(x, y, 22 * kF); return true;
  };
  /** A walled churchyard with yews under a lone landmark. */
  const yardBase = (x, y, wM) => { if (SPR['churchyard-small']) placePiece('churchyard-small', x, y + 4 * kF, { z: -0.7, wM }); };
  for (const s3 of special) if (s3.drawn) yardBase(s3.x, s3.y, 95); // the castle stands on its walled yard
  const HEART_SETS = {
    hamlet: ['hamlet-well-yard', 'hamlet-red-barn', 'hamlet-orchard-crossing', 'hamlet-limewashed'],
    village: ['village-chapel-green', 'village-red-square', 'village-crossroads', 'village-willow-well', 'village-timber-commons'],
    town: ['town-market-limestone', 'town-red-gables', 'town-cobbled-cross', 'town-golden-thatch', 'town-orchard-market'],
    walled: ['walled-town-limestone', 'walled-town-red-roofs', 'walled-town-grey-corner'],
    alpine: ['alpine-chapel-common', 'alpine-red-roof-inn', 'alpine-stone-terrace'],
    canal: ['market-quay', 'red-gable-canal', 'canal-chapel-court', 'quay-workshops'],
  };
  const usedSets = new Map();
  for (const h of [...hearts].sort((a, b2) => a.x - b2.x || a.y - b2.y)) {
    if (!(h.x + 260 * kF >= BB[0] && h.x - 260 * kF <= BB[2] && h.y + 260 * kF >= BB[1] && h.y - 260 * kF <= BB[3])) continue;
    const ws = waterSide(h.x, h.y, canalCity ? 170 : 90);
    let name = null, flip = false;
    const nearUsed = (n) => [...usedSets.entries()].some(([n2, hs]) => n2 === n && hs.some((o) => Math.hypot(o.x - h.x, o.y - h.y) < 1500 * kF));
    const pickH = (list, seed) => { const l = list.filter((n) => SPR[n] && !nearUsed(n)); const l2 = l.length ? l : list.filter((n) => SPR[n]); return l2.length ? l2[Math.floor(H01(h.x0, h.y0, seed) * l2.length)] : null; };
    if (h.anchor && h.anchor.kind === 'church' && abbey(h.anchor.name || '') && SPR['monastery-cloister-garden']) name = 'monastery-cloister-garden';
    else if (ws && (canalCity || (ws.d < 60 && ws.side !== 'north'))) { const fam = pickH(HEART_SETS.canal.filter((f) => SPR[`${f}-water-west`]), 3101); if (fam) { name = ws.side === 'south' ? `${fam}-water-south` : `${fam}-water-west`; flip = ws.side === 'east' || (ws.side === 'north' && ws.ex > 0); } }
    else if (ws && h.t <= 1 && ws.d < 70 && SPR['fishing-hamlet-jetties'] && !canalCity) name = 'fishing-hamlet-jetties';
    if (OPEN) name = pickH(HEART_SETS.hamlet, 3109); // open country: hamlets and farmsteads only
    if (!name) name = ALP ? pickH(HEART_SETS.alpine, 3103) : pickH(h.t >= 3 ? (H01(h.x0, h.y0, 3105) < 0.4 ? HEART_SETS.walled : HEART_SETS.town) : h.t === 2 ? HEART_SETS.town : h.t === 1 ? HEART_SETS.village : HEART_SETS.hamlet, 3107);
    if (!name) continue;
    if (!usedSets.has(name)) usedSets.set(name, []); usedSets.get(name).push(h);
    // dense hearts carry a bigger piece than the village it stands for would need; a hamlet heart a small one
    // never on water: a piece that would touch real water slides away from it (waterside pieces keep their quay side wet)
    const wM0 = OPEN ? 140 : [200, 225, 250, 270][h.t], m0 = SPRIDX[name], kk0 = wM0 / spImgM(name), fw0 = m0.foot_m[0] * kk0, fh0 = m0.foot_m[1] * kk0;
    const wetAt = (x, y) => { let n = 0; for (let u = -0.45; u <= 0.451; u += 0.075) for (let v = -0.45; v <= 0.451; v += 0.09) if (!onLand(x + u * fw0 * kF, y + v * fh0 * kF)) n++; return n; };
    let hx = h.x, hy = h.y;
    if (/water/.test(name) && ws && SPRIDX[name].quay) {
      // put the piece's painted quay line on the real bank: march from the heart towards the water
      const dir = name.endsWith('south') ? [0, -1] : [flip ? 1 : -1, 0], q = SPRIDX[name].quay, qu = (q[0][0] + q[1][0]) / 2, qv = (q[0][1] + q[1][1]) / 2;
      let bx = null; for (let d = 0; d <= 220; d += 3) { const x = h.x + dir[0] * d * kF, y = h.y + dir[1] * d * kF; if (!onLand(x, y)) { bx = [x - dir[0] * 2 * kF, y - dir[1] * 2 * kF]; break; } }
      if (bx) { const hM0 = wM0 * m0.h / m0.w, ox = (flip ? -1 : 1) * (qu - m0.ax) * wM0 * kF, oy = -(qv - m0.ay) * hM0 * kF; if (dir[0]) hx = bx[0] - ox; else hy = bx[1] - oy; }
    }
    if (!/water/.test(name) && wetAt(hx, hy) > 0) {
      let best = null;
      search: for (const d of [20, 40, 60, 80, 110]) for (let a = 0; a < 12; a++) { const x = h.x + Math.cos(a * 0.5236) * d * kF, y = h.y + Math.sin(a * 0.5236) * d * kF; if (!wetAt(x, y)) { best = [x, y]; break search; } }
      if (!best) continue; [hx, hy] = best;
    }
    const pc = placePiece(name, hx, hy, { flip, wM: wM0 });
    if (pc) { h.piece = pc; if (h.church) h.church.drawn = true; h.houses = 0; }
  }
  // round each heart: paddocks, field quilts, orchards and tree clumps on its open ground, as in the targets
  for (const h of hearts) {
    const pc = h.piece; if (!pc || !(h.x + 500 * kF >= BB[0] && h.x - 500 * kF <= BB[2] && h.y + 500 * kF >= BB[1] && h.y - 500 * kF <= BB[3])) continue;
    let n = 0; const want = 3 + Math.floor(H01(h.x0, h.y0, 3171) * 3);
    for (let k3 = 0; k3 < 24 && n < want; k3++) {
      const a = (k3 * 2.39996 + H01(h.x0, h.y0, 3173) * 6.283), r = (pc.fw * 0.5 + 55 + (k3 % 4) * 38) * kF, x = pc.cx + Math.cos(a) * r, y = pc.cy + Math.sin(a) * r * 0.9;
      const kind = H01(x, y, 3175), n2 = kind < 0.3 ? pickOf(['paddock-sheep-shelter', 'paddock-cattle-shelter'].filter((n9) => !pieces.some((p2) => p2.name === n9 && Math.hypot(p2.x - x, p2.y - y) < 600 * kF)), x, y, 3177) : kind < 0.55 ? pickOf(['field-quilt-ribbon', 'field-quilt-kite', 'field-quilt-step', 'field-quilt-hook'], x, y, 3179) : kind < 0.75 ? pickOf(['orchard-block-rows', 'orchard-block-bloom'], x, y, 3181) : null;
      const rr = (n2 ? SPRIDX[n2].foot_m[0] * 0.5 : 18) * kF;
      if (!onLand(x, y, rr) || hitW(x, y, rr * 0.9) || wood.at(x, y) || streetNear(x, y)[0] < rr / kF * 0.45) continue;
      if (n2) { if (placePiece(n2, x, y, { z: -0.6, flip: kind < 0.5 === (H01(x, y, 3183) < 0.5), k: 1.15, unique: true })) n++; continue; }
      paintedClump(x, y, 3 + (k3 % 3) * 2, 3187); n++; continue;
      for (let t = 0; t < 4; t++) { const tx = x + Math.cos(t * 2.3) * (t ? 9 : 0) * kF, ty = y + Math.sin(t * 2.3) * (t ? 7 : 0) * kF; if (inCanvas(tx, ty) && onLand(tx, ty, 4 * kF)) putW(['round-tree-beech', TREE, 'round-tree-young-oak', 'round-tree-elm'][(t + k3) % 4], tx, ty, { s: 1 + H01(tx, ty, 3185) * 0.3, shadow: 0.9, flip: t % 2 === 1 }); }
      takeW(x, y, 20 * kF); n++;
    }
  }
  // landmark churches away from the hearts, where they really are
  for (const c of churches) if (!c.heart && !c.drawn && abbey(c.name)) { if (!(SPR['monastery-cloister-garden'] && footDry(c.x, c.y, 50 * kF) && placePiece('monastery-cloister-garden', c.x, c.y, { wM: 160 }) && (c.drawn = true))) placeChurch(c); } // only abbeys stand alone, as the walled monastery
  T('o-hearts');
  // B. farmstead compounds where real buildings cluster away from the hearts: a painted farmstead with
  //    its yard; now and then a field quilt or a paddock beside it, a watermill on a real stream, a
  //    sawmill at a wood's edge, a vineyard estate on real vineyards
  const compounds = [];
  for (const s2 of steads) {
    if (!(s2.x > BB[0] - 120 * kF && s2.x < BB[2] + 120 * kF && s2.y > BB[1] - 120 * kF && s2.y < BB[3] + 120 * kF) || nearestHeart(s2.x, s2.y)[1] < 1.9 || hearts.some((h) => h.piece && Math.hypot(h.piece.cx - s2.x, h.piece.cy - s2.y) < (h.piece.fw * 0.5 + 60) * kF) || localStats(s2.x, s2.y, 70 * kF).nb < 3) continue;
    if (!footDry(s2.x, s2.y, 30 * kF) || hitW(s2.x, s2.y, 30 * kF)) continue;
    let stream = null; for (const r of riverL) if (['stream', 'river'].includes(r.cls)) for (const v of r.pts) if (Math.hypot(v[0] - s2.x, v[1] - s2.y) < 70 * kF) { stream = v; break; }
    const woodEdge = [0, 1, 2, 3, 4, 5, 6, 7].some((a) => wood.at(s2.x + Math.cos(a * 0.785) * 70 * kF, s2.y + Math.sin(a * 0.785) * 70 * kF));
    const vine = orchard.at(s2.x, s2.y);
    const dense = !OPEN && localStats(s2.x, s2.y, 90 * kF).cover > 0.18; // (open country: farmsteads only)
    const name = dense ? pickOf(['hamlet-well-yard', 'hamlet-red-barn', 'hamlet-orchard-crossing', 'hamlet-limewashed'], s2.x, s2.y, 3119) : vine && SPR['vineyard-estate'] ? 'vineyard-estate' : stream && SPR['watermill-pond-race'] && H01(s2.x, s2.y, 3111) < 0.6 ? 'watermill-pond-race' : woodEdge && SPR['sawmill-wood-edge'] && H01(s2.x, s2.y, 3113) < 0.35 ? 'sawmill-wood-edge' : pickOf(['farmstead-blue-yard', 'farmstead-thatch-paddock', 'farmstead-brick-strip', 'farmstead-longhouse', 'farmstead-orchard-gate'], s2.x, s2.y, 3115);
    if (!name) continue;
    const pc = placePiece(name, s2.x, s2.y, { flip: H01(s2.x, s2.y, 3117) < 0.5 && !/mill|vineyard/.test(name), wM: /^hamlet/.test(name) ? 125 : /mill|vineyard/.test(name) ? 120 : 88, unique: true });
    if (!pc) continue; compounds.push([s2.x, s2.y]);
    // a field quilt or a paddock beside it (on open ground only)
    const extra = H01(s2.x, s2.y, 3119);
    if (extra < 0.55) {
      const n2 = extra < 0.4 ? pickOf(['field-quilt-ribbon', 'field-quilt-kite', 'field-quilt-step', 'field-quilt-hook'], s2.x, s2.y, 3121) : pickOf(['paddock-sheep-shelter', 'paddock-cattle-shelter'], s2.x, s2.y, 3123);
      if (n2) { const side = H01(s2.x, s2.y, 3125) < 0.5 ? -1 : 1, dx = side * (pc.fw / 2 + SPRIDX[n2].foot_m[0] / 2 + 6) * kF, x = pc.cx + dx, y = pc.cy - 8 * kF; const r = SPRIDX[n2].foot_m[0] * 0.45 * kF; if (onLand(x, y, r) && !hitW(x, y, r) && streetNear(x, y)[0] > 8 && !wood.at(x, y)) placePiece(n2, x, y, { z: -0.6, k: 1.3, unique: true }); }
    }
  }
  // the roads that are drawn: main roads everywhere; lanes only in town, round a heart or leading to a
  // compound; short lanes that would end in the meadow are left out
  const inCanvasEdge = (p) => p[0] < BBX[0] + 30 * kF || p[0] > BBX[2] - 30 * kF || p[1] < BBX[1] + 30 * kF || p[1] > BBX[3] - 30 * kF; // a line cut by the window is not a stub
  const lineLen = (pts) => { let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return d / kF; };
  const drawnStreets = streets.filter((L) => {
    if (L.main) return true;
    if (L.cls === 'tertiary' && !coreAt(L.pts[0][0], L.pts[0][1]) && localStats(L.pts[0][0], L.pts[0][1], 60 * kF).nb < 4) return true;
    if (lite) return false;
    const m = L.pts[Math.floor(L.pts.length / 2)], ends = [L.pts[0], L.pts[L.pts.length - 1], m];
    if (ports.some((pt) => L.pts.some((q) => Math.hypot(q[0] - pt.x, q[1] - pt.y) < 30 * kF))) return true; // it leads to a set piece's entrance
    if ((!coreAt(m[0], m[1]) && localStats(m[0], m[1], 60 * kF).nb < 4) || lineLen(L.pts) <= 40) return false; // town and suburb lanes only
    // in a dense grid only every third parallel lane survives (a world-anchored band across its direction)
    const [p0, p1] = [L.pts[0], L.pts[L.pts.length - 1]], a = Math.round(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) / (Math.PI / 18)) * (Math.PI / 18);
    const d = -p0[0] * Math.sin(a) + p0[1] * Math.cos(a);
    return ((Math.floor(d / (90 * kF)) % 3) + 3) % 3 === 0;
  });
  { // a lane whose end touches no other drawn road and that is short is a stub: drop it (twice, for chains)
    for (let pass = 0; pass < 3; pass++) {
      const SG2 = 8 * kF, hs = new Map();
      drawnStreets.forEach((L, id) => { for (let i = 1; i < L.pts.length; i++) { const [ax, ay] = L.pts[i - 1], [bx, by] = L.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (4 * kF))); for (let m = 0; m <= n; m++) { const x = ax + (bx - ax) * m / n, y = ay + (by - ay) * m / n, k3 = Math.floor(x / SG2) + ',' + Math.floor(y / SG2); if (!hs.has(k3)) hs.set(k3, []); hs.get(k3).push([x, y, id]); } } });
      const joined = (p, id) => { const i0 = Math.floor(p[0] / SG2), j0 = Math.floor(p[1] / SG2); for (let a = -1; a <= 1; a++) for (let b2 = -1; b2 <= 1; b2++) for (const q of hs.get((i0 + a) + ',' + (j0 + b2)) || []) if (q[2] !== id && Math.hypot(q[0] - p[0], q[1] - p[1]) < 9 * kF) return true; return false; };
      const keep = drawnStreets.filter((L, id) => (L.main && lineLen(L.pts) >= 200) || [L.pts[0], L.pts[L.pts.length - 1]].every((p) => inCanvasEdge(p) || joined(p, id) || pieces.some((pc) => Math.abs(p[0] - pc.cx) < pc.fw * 0.6 * kF && Math.abs(p[1] - pc.cy) < pc.fh * 0.6 * kF)));
      drawnStreets.length = 0; drawnStreets.push(...keep);
    }
  }
  // C. scenery on real land use, until the painted pieces arrive
  // distance to the nearest DRAWN road (the lanes left out are meadow now and may be covered)
  const DSG = 12 * kF, dHash = new Map();
  for (const L of drawnStreets) for (let i = 1; i < L.pts.length; i++) { const [ax, ay] = L.pts[i - 1], [bx, by] = L.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (4 * kF))); for (let m = 0; m <= n; m++) { const x = ax + (bx - ax) * m / n, y = ay + (by - ay) * m / n, k3 = Math.floor(x / DSG) + ',' + Math.floor(y / DSG); if (!dHash.has(k3)) dHash.set(k3, []); dHash.get(k3).push([x, y, L.w * kF / 2]); } }
  const drawnNear = (x, y) => { let bd = Infinity; const i0 = Math.floor(x / DSG), j0 = Math.floor(y / DSG); for (let a = -3; a <= 3; a++) for (let b2 = -3; b2 <= 3; b2++) for (const q of dHash.get((i0 + a) + ',' + (j0 + b2)) || []) { const d = Math.hypot(q[0] - x, q[1] - y) - q[2]; if (d < bd) bd = d; } return bd / kF; };
  // C2b. every parcel of open land gets a deliberate treatment, chosen from what is really there (a fixed
  //      72 m world grid of parcels; about one in six stays open meadow by choice). The pools name the
  //      painted fillers first (concept/fillers, when present) and the set-four scenery as stand-ins.
  const FILL = {
    garden: ['filler-kitchen-garden', 'filler-allotments', 'orchard-block-bloom', 'orchard-block-rows', 'village-green-pond'],
    pasture: ['filler-sheep-pasture', 'filler-cow-pasture', 'filler-horse-pasture', 'paddock-sheep-shelter', 'paddock-cattle-shelter'],
    field: ['filler-hedged-wheat', 'filler-plough', 'filler-hay-meadow', 'field-quilt-ribbon', 'field-quilt-kite', 'field-quilt-step', 'field-quilt-hook'],
    orchard: ['filler-orchard-rows', 'orchard-block-rows', 'orchard-block-bloom'],
    vine: ['filler-vineyard-rows', 'vineyard-block-long', 'vineyard-block-slope'],
    grave: ['filler-graveyard', 'graveyard-chapel'],
  };
  const fillPick = (cat, x, y, seed) => { const l = FILL[cat].filter((n) => SPR[n] && SPRIDX[n]); if (!l.length) return null; const pre = l.filter((n) => n.startsWith('filler-')); const pool = pre.length ? pre : l; return pool[Math.floor(H01(x, y, seed) * pool.length)]; };
  // a straight-sided block filler (set five) along the street's direction: the longest of 160/80/40 m whose
  // whole rectangle is dry, free and off the roads; turned by the rest of the angle
  const OANG = { ew: 0, 'ne-sw': Math.PI / 4, ns: Math.PI / 2, 'nw-se': 3 * Math.PI / 4 };
  const fstat = { try: 0, ok: 0, land: 0, hit: 0, road: 0, wood: 0, none: 0 };
  const placeFiller = (kinds, x, y, ang, seed, lens = [160, 80, 40]) => {
    fstat.try++;
    const [b, res] = orient(ang), a = OANG[b] + res, ux = Math.cos(a), uy = Math.sin(a);
    // the first kinds are preferred; the rest only when the first has no drawing for this length and direction
    const WT = { 'hedged-wheat': 0.45, 'ploughed-strip': 0.25, 'hay-meadow': 0.55, 'flax-strip': 0.4, 'kitchen-garden': 0.8, 'vegetable-allotments': 0.7, 'beehive-garden': 0.5, 'pond-common': 0.35, 'bowling-green': 0.3, 'bleaching-field': 0.3, 'orchard-rows': 0.8, 'vineyard-rows': 0.2, 'cow-pasture': 0.7, 'sheep-pasture': 0.8, 'horse-paddock': 0.5 };
    const order = [...kinds].map((k1, i2) => [k1, -Math.log(Math.max(1e-6, H01(x, y, seed + i2 * 7))) / (WT[k1] || 0.5)]).sort((p1, p2) => p1[1] - p2[1]).map((p1) => p1[0]);
    for (const L of lens) for (const kind of order) {
      const name = `${kind}-${L}-${b}`, m = SPRIDX[name]; if (!SPR[name] || !m || !m.fill) continue;
      if (pieces.filter((p2) => p2.name === name && Math.hypot(p2.x - x, p2.y - y) < 300 * kF).length >= 2) continue; // never the same strip again and again
      const W2 = m.fill.W, pts = []; for (let u = -0.4; u <= 0.41; u += 0.2) for (let v = -0.36; v <= 0.37; v += 0.36) pts.push([x + (u * L * ux - v * W2 * uy) * kF, y + (u * L * uy + v * W2 * ux) * kF]);
      { let bad = null; for (const [px, py] of pts) { if (!onLand(px, py)) { bad = 'land'; break; } if (hitW(px, py, 3 * kF)) { bad = 'hit'; break; } if (drawnNear(px, py) <= 3) { bad = 'road'; break; } if (wood.at(px, py)) { bad = 'wood'; break; } } if (bad) { fstat[bad]++; continue; } }
      const ob = putW(name, x, y, { w: m.img_m * ppm, ax: m.ax, ay: m.ay, rot: -res, shadow: 0, z: -0.65 });
      if (!ob) continue; // that kind is used up here
      if (ob) { const ex = (Math.abs(L * ux) + Math.abs(W2 * uy)) * 0.8, ey = (Math.abs(L * uy) + Math.abs(W2 * ux)) * 0.8; ob.box = [ex, ey]; ob.bcx = x; ob.bcy = y; }
      for (let u = -0.45; u <= 0.451; u += 0.075) for (let v = -0.42; v <= 0.421; v += 0.21) takeW(x + (u * L * ux - v * W2 * uy) * kF, y + (u * L * uy + v * W2 * ux) * kF, OC * 0.5);
      pieces.push({ name, x, y, cx: x, cy: y, fw: Math.abs(L * ux) + Math.abs(W2 * uy), fh: Math.abs(L * uy) + Math.abs(W2 * ux), filler: true });
      fstat.ok++; return true;
    }
    fstat.none++; return false;
  };
  const FILLK = { field: ['hedged-wheat', 'hay-meadow', 'flax-strip', 'ploughed-strip'], garden: ['kitchen-garden', 'vegetable-allotments', 'beehive-garden', 'pond-common', 'bowling-green', 'bleaching-field'], orchard: ['orchard-rows', 'vineyard-rows'], pasture: ['sheep-pasture', 'cow-pasture', 'horse-paddock', 'hay-meadow'], grave: ['yew-graveyard'], wet: ['reed-osiers'] };
  const clump = (x, y, n, seed) => paintedClump(x, y, n, seed);
  const clumpOld = (x, y, n, seed) => { const pool = ['round-tree-beech', TREE, 'round-tree-young-oak', 'bush-hawthorn', 'round-tree-elm', 'round-tree-linden', 'blossom-tree-white']; for (let t = 0; t < n; t++) { const a = t * 2.3 + H01(x, y, seed) * 6, rr = t ? (7 + t * 2.5) * kF : 0, tx = x + Math.cos(a) * rr, ty = y + Math.sin(a) * rr * 0.8; if (inCanvas(tx, ty) && onLand(tx, ty, 4 * kF)) putW(pool[(Math.floor(H01(x, y, seed + 1) * pool.length) + t * 3) % pool.length], tx, ty, { s: 0.95 + H01(tx, ty, seed + 2) * 0.35, shadow: 0.9, flip: t % 2 === 1 }); } takeW(x, y, 22 * kF); };
  // C1b. parcels line the real streets: block fillers side by side along each street, up to two rows deep,
  //      their kind from what is there (gardens, orchards and pastures near a heart; fields further out)
  if (!lite) for (const L of streets) {
    alongW(L.pts, 94 * kF, (mx, my, ang, nx, ny) => {
      if (!(mx > BB[0] - 100 * kF && mx < BB[2] + 100 * kF && my > BB[1] - 100 * kF && my < BB[3] + 100 * kF)) return;
      for (const sd of [1, -1]) {
        if (H01(mx + sd * 7, my, 3301) < 0.14) continue; // a stretch of open meadow, by choice
        const hidden = !drawnStreets.includes(L);
        for (const row of [0, 1, 2]) {
          const off = (L.w / 2 + (hidden ? 3 : 9) + 19.5 + row * 40) * kF, x = mx + nx * off * sd, y = my + ny * off * sd;
          const [h0, dh] = nearestHeart(x, y); if (h0 && dh < 1.25) break;
          if (wood.at(x, y) || park.at(x, y) || cemetery.at(x, y)) break;
          const r = H01(x, y, 3303), near = h0 && dh < 3.5;
          const cat = orchard.at(x, y) ? 'orchard' : OPEN ? (r < 0.7 ? 'field' : 'pasture') : near ? (r < 0.4 ? 'garden' : r < 0.65 ? 'orchard' : r < 0.85 ? 'pasture' : 'field') : (r < 0.6 ? 'field' : r < 0.8 ? 'pasture' : 'orchard');
          if (!placeFiller(FILLK[cat], x, y, ang, 3305, hidden ? [160, 80, 40] : [80, 40]) && !placeFiller(OPEN ? [...FILLK.field, ...FILLK.pasture] : [...FILLK.field, ...FILLK.pasture, ...FILLK.garden, ...FILLK.orchard], x, y, ang, 3307, [80, 40])) break;
        }
      }
    }, 'pr');
  }
  // C1c. the surviving roads get their edges: tree avenues in town and near the hearts, hedgerows with
  //      standard trees in the country (painted 80 m runs in four directions, with gaps)
  if (!lite && SPR['tree-avenue-ew']) for (const L of drawnStreets) {
    if (['motorway', 'trunk'].includes(L.cls)) continue;
    alongW(L.pts, 88 * kF, (mx, my, ang, nx, ny) => {
      if (!(mx > BB[0] - 100 * kF && mx < BB[2] + 100 * kF && my > BB[1] - 100 * kF && my < BB[3] + 100 * kF) || H01(mx, my, 3311) < 0.35) return;
      const [h0, dh] = nearestHeart(mx, my), town = coreAt(mx, my) || (h0 && dh < 2.6), ux = Math.cos(ang), uy = Math.sin(ang);
      if (town) {
        const pts = []; for (const u of [-36, 0, 36]) for (const sd of [-1, 1]) pts.push([mx + ux * u * kF + nx * (L.w / 2 + 4) * sd * kF, my + uy * u * kF + ny * (L.w / 2 + 4) * sd * kF]);
        if (!pts.every(([x, y]) => onLand(x, y, 2 * kF) && !hitW(x, y, 2 * kF))) return;
        if (putMod('tree-avenue', mx, my, ang, 80, { z: 0.1, ay: 0.5, k: 1 })) for (const [x, y] of pts) takeW(x, y, 4 * kF);
      } else {
        const sd = H01(mx, my, 3313) < 0.5 ? 1 : -1, x = mx + nx * (L.w / 2 + 4) * sd * kF, y = my + ny * (L.w / 2 + 4) * sd * kF;
        const pts = [-36, 0, 36].map((u) => [x + ux * u * kF, y + uy * u * kF]);
        if (!pts.every(([px, py]) => onLand(px, py, 2 * kF) && !hitW(px, py, 2 * kF) && drawnNear(px, py) > 1.5)) return;
        if (putMod('hedge-standard-trees', x, y, ang, 80, { z: 0.05, ay: 0.55, k: 1 })) for (const [px, py] of pts) takeW(px, py, 4 * kF);
      }
    }, 'av');
  }
  // C1. trees along the main roads in the country and along the canals in town, in runs
  for (const L of streets) {
    let last = null;
    alongW(L.pts, 32 * kF, (mx, my, ang, nx, ny) => {
      const [h0, dh] = nearestHeart(mx, my); if (h0 && dh < 1.3) return;
      const city = coreAt(mx, my), canalSide = canalCity && !onLand(mx, my, 22 * kF);
      if (!canalSide && (city || !L.main)) return;
      if (fbm(mx / (110 * kF), my / (110 * kF), 1701) < (canalSide ? 0.56 : 0.6)) return;
      for (const sd of [1, -1]) {
        if (H01(mx + sd, my, 1709) < 0.45) continue;
        const x = mx + nx * (L.w / 2 + 5) * kF * sd, y = my + ny * (L.w / 2 + 5) * kF * sd;
        if (!onLand(x, y, 4 * kF) || wood.at(x, y) || park.at(x, y) || !freeW(x, y, 7 * kF, 2.5 * kF)) continue;
        const pool = canalSide ? ['round-tree-elm', 'round-tree-linden', 'landmark-weeping-willow', 'landmark-black-alder', 'round-tree-beech'] : !canalSide && !L.main ? ['landmark-silver-birch', 'landmark-sweet-chestnut', 'landmark-lombardy-poplar', 'round-tree-young-oak', ALP ? 'landmark-mountain-rowan' : 'round-tree-beech'] : [TREE, 'round-tree-beech', 'round-tree-young-oak'];
        let n2 = pool[Math.floor(H01(x, y, 1703) * pool.length)]; if (n2 === last) n2 = pool[(pool.indexOf(n2) + 1) % pool.length];
        putW(SPR[n2] ? n2 : TREE, x, y, { flip: H01(x, y, 1705) < 0.5, s: 0.95 + H01(x, y, 1707) * 0.3, shadow: 0.7 }); takeW(x, y, 8 * kF); last = n2;
      }
    }, 'st');
  }
  // C2. scattered trees in groups where the world's own pattern puts them; real orchards
  {
    const g = 44 * kF;
    for (let i = Math.floor(BB[0] / g); i <= Math.floor(BB[2] / g); i++) for (let j = Math.floor(BB[1] / g); j <= Math.floor(BB[3] / g); j++) {
      const mx = (i + 0.2 + hash(i, j, 1751) * 0.6) * g, my = (j + 0.2 + hash(i, j, 1753) * 0.6) * g;
      if (!onLand(mx, my, 10 * kF) || wood.at(mx, my) || park.at(mx, my) || cemetery.at(mx, my) || streetNear(mx, my)[0] < 10) continue;
      const [h0, dh] = nearestHeart(mx, my); if (h0 && dh < 1.3) continue;
      if (fbm(mx / (170 * kF), my / (170 * kF), 1731) < 0.66) continue;
      const pine = dem(mx, my) - floor > 120;
      const pool = pine ? ['pine-tall', 'forest-pine-small', 'pine-tall'] : ['round-tree-beech', TREE, 'bush-hawthorn', 'round-tree-young-oak', 'round-tree-elm'];
      if (!pine) { paintedClump(mx, my, 3 + Math.floor(hash(i, j, 1733) * 6), 1745); continue; }
      const nT = 2 + Math.floor(hash(i, j, 1733) * 3);
      for (let t = 0; t < nT; t++) {
        const a = t * 2.4 + hash(i, j, 1735) * 6, rr = t ? (8 + t * 3 + hash(i, j + t, 1743) * 4) * kF : 0, x = mx + Math.cos(a) * rr, y = my + Math.sin(a) * rr * 0.75;
        if (!onLand(x, y, 4 * kF) || !freeW(x, y, 7 * kF)) continue;
        const n2 = pool[(Math.floor(hash(i, j, 1737) * pool.length) + t * 3) % pool.length];
        putW(SPR[n2] ? n2 : TREE, x, y, { flip: hash(i + t, j, 1739) < 0.5, s: 0.95 + hash(i, j + t, 1741) * 0.35, shadow: 0.7 }); takeW(x, y, 7 * kF);
      }
    }
  }
  {
    const g = 72 * kF;
    for (let i = Math.floor(BB[0] / g) - 1; i <= Math.floor(BB[2] / g) + 1; i++) for (let j = Math.floor(BB[1] / g) - 1; j <= Math.floor(BB[3] / g) + 1; j++) {
      const mx = (i + 0.35 + hash(i, j, 3203) * 0.3) * g, my = (j + 0.35 + hash(i, j, 3205) * 0.3) * g;
      if (hash(i, j, 3201) < (OPEN ? 0.1 : 0.17)) continue; // open meadow, chosen
      if (!onLand(mx, my, 22 * kF) || hitW(mx, my, 24 * kF) || wood.at(mx, my) || drawnNear(mx, my) < 14) continue;
      const [h0, dh] = nearestHeart(mx, my), near = h0 && dh < 3.5, r = hash(i, j, 3207);
      let cat;
      if (cemetery.at(mx, my)) cat = 'grave';
      else if (park.at(mx, my)) cat = null;
      else if (orchard.at(mx, my)) cat = orchard.at(mx, my).props?.subclass === 'vineyard' ? 'vine' : 'orchard';
      else if (farm.at(mx, my)) cat = r < 0.75 ? 'field' : 'pasture';
      else if (near) cat = r < 0.4 ? 'garden' : r < 0.65 ? 'pasture' : r < 0.8 ? 'orchard' : null;
      else cat = r < 0.45 ? 'field' : r < 0.75 ? 'pasture' : r < 0.85 ? 'orchard' : null;
      if (cat && FILLK[cat] && !lite) { const [, sm] = streetNear(mx, my, 90 * kF); const ang = sm ? sm[3] : 0; if (placeFiller(FILLK[cat], mx, my, ang, 3221) || placeFiller(cat === 'garden' || cat === 'orchard' ? FILLK.field : cat === 'pasture' ? FILLK.field : FILLK.garden, mx, my, ang, 3223)) continue; }
      const n2 = cat ? fillPick(cat, mx, my, 3209) : null;
      if (n2 && placePiece(n2, mx, my, { z: -0.6, wM: Math.min(SPRIDX[n2].foot_m[0] * 1.12, 88), flip: hash(i, j, 3215) < 0.5, unique: !n2.startsWith('filler-') })) continue;
      clump(mx, my, 3 + Math.floor(hash(i, j, 3217) * 3), 3219);
    }
  }
  // C3. painted scenery on real land use (set four): orchard and vineyard blocks, forest masses on real
  //     woods (single trees only fill what is left), field quilts on real farmland
  for (const it of orchard.items) {
    const g = 70 * kF, vine = it.props && it.props.subclass === 'vineyard';
    for (let i = Math.floor(Math.max(it.bb[0], BB[0]) / g); i <= Math.floor(Math.min(it.bb[2], BB[2]) / g); i++) for (let j = Math.floor(Math.max(it.bb[1], BB[1]) / g); j <= Math.floor(Math.min(it.bb[3], BB[3]) / g); j++) {
      const mx = (i + 0.5) * g, my = (j + 0.5) * g; if (!inPoly(mx, my, it.rings) || hitW(mx, my, 25 * kF)) continue;
      const n2 = pickOf(vine ? ['vineyard-block-slope', 'vineyard-block-long'] : ['orchard-block-rows', 'orchard-block-bloom'], mx, my, 3141);
      if (n2) placePiece(n2, mx, my, { z: -0.6, flip: hash(i, j, 3143) < 0.5, k: 1.3 });
    }
  }
  {
    const g = 82 * kF;
    for (let i = Math.floor(BB[0] / g) - 1; i <= Math.floor(BB[2] / g) + 1; i++) for (let j = Math.floor(BB[1] / g) - 1; j <= Math.floor(BB[3] / g) + 1; j++) {
      const mx = (i + 0.25 + hash(i, j, 3151) * 0.5) * g, my = (j + 0.25 + hash(i, j, 3153) * 0.5) * g;
      if (!wood.at(mx, my) || [[-35, 0], [35, 0], [0, -25], [0, 25]].filter(([a, b2]) => wood.at(mx + a * kF, my + b2 * kF)).length < 3) continue;
      if (!onLand(mx, my, 25 * kF) || hitW(mx, my, 22 * kF)) continue;
      const rel = dem(mx, my) - floor, r = hash(i, j, 3155);
      const fam = rel > 90 ? ['forest-pine-ragged', 'forest-pine-swept', 'forest-pine-pocket'] : r < 0.5 ? ['forest-deciduous-broad', 'forest-deciduous-lobed', 'forest-deciduous-hook'] : ['forest-mixed-broad', 'forest-mixed-bent', 'forest-mixed-pocket'];
      const n2 = pickOf(fam, mx, my, 3157); if (n2) placePiece(n2, mx, my, { z: -0.4, flip: hash(i, j, 3159) < 0.5, k: 1.3 });
    }
  }
  {
    const g = 92 * kF;
    for (let i = Math.floor(BB[0] / g) - 1; i <= Math.floor(BB[2] / g) + 1; i++) for (let j = Math.floor(BB[1] / g) - 1; j <= Math.floor(BB[3] / g) + 1; j++) {
      const mx = (i + 0.3 + hash(i, j, 3161) * 0.4) * g, my = (j + 0.3 + hash(i, j, 3163) * 0.4) * g;
      if (!farm.at(mx, my) || [[-40, 0], [40, 0], [0, -30], [0, 30]].filter(([a, b2]) => farm.at(mx + a * kF, my + b2 * kF)).length < 3) continue;
      if (hitW(mx, my, 32 * kF) || streetNear(mx, my)[0] < 18) continue;
      const n2 = pickOf(['field-quilt-ribbon', 'field-quilt-kite', 'field-quilt-step', 'field-quilt-hook'], mx, my, 3165); if (n2) placePiece(n2, mx, my, { z: -0.6, flip: hash(i, j, 3167) < 0.5, k: 1.3 });
    }
  }
  // real farmland: hedges along its real edges
  if (false) for (const p of farmP) { if (ringArea(p[0]) / (k * k) < 1200) continue; alongW(p[0], 13 * kF, (x, y, ang, nx, ny, sp) => { if (!inCanvas(x, y) || streetNear(x, y)[0] < 3 || hash(Math.round(x / (40 * kF)), Math.round(y / (40 * kF)), 1761) < 0.25) return; putMod(ALP && dem(x, y) > 700 ? 'stone-wall' : 'hedge', x, y, ang, sp * 1.06); }, 'fh', true); }
  T('o-land'); tm.push(`fill ${JSON.stringify(fstat)}`);
  // D. woods: forest masses on a jittered grid, conifers higher up, single trees at the edges
  {
    const g = 32 * kF;
    for (let i = Math.floor(BB[0] / g); i <= Math.floor(BB[2] / g); i++) for (let j = Math.floor(BB[1] / g); j <= Math.floor(BB[3] / g); j++) {
      const mx = (i + 0.2 + hash(i, j, 1101) * 0.6) * g, my = (j + 0.2 + hash(i, j, 1103) * 0.6) * g;
      if (!wood.at(mx, my) || !onLand(mx, my, 8 * kF) || nearTrail(mx, my) || hitW(mx, my, 10 * kF)) continue;
      { const d5 = 15 * kF, sl5 = Math.hypot(dem(mx + d5, my) - dem(mx - d5, my), dem(mx, my + d5) - dem(mx, my - d5)) / (2 * d5 / kF); if (sl5 > 0.62) continue; }
      const rel = dem(mx, my) - floor, edge = [0, 1, 2, 3].some((a) => !wood.at(mx + Math.cos(a * 1.57) * 16 * kF, my + Math.sin(a * 1.57) * 16 * kF));
      const conif = rel > 90 || hash(i, j, 1105) < 0.2;
      if (edge) putW(conif ? 'pine-tall' : ['round-tree-beech', 'deciduous-birch', 'bush-hawthorn', TREE, 'round-tree-elm'][Math.floor(hash(i, j, 1107) * 5)], mx, my, { flip: hash(i, j, 1109) < 0.5, s: 0.9 + hash(i, j, 1111) * 0.3, shadow: 0.7 });
      else if (conif) putW(SPR['forest-pine-large'] ? ['forest-pine-large', 'forest-pine-small', 'forest-pine-large', 'pine-tall'][Math.floor(hash(i, j, 1113) * 4)] : 'pine-tall', mx, my, { flip: hash(i, j, 1117) < 0.5, s: 0.9 + hash(i, j, 1119) * 0.25, shadow: 0.5 });
      else putW(SPR['forest-deciduous-hook'] ? ['forest-deciduous-round', 'forest-deciduous-hook', 'forest-deciduous-belt', 'forest-clump'][Math.floor(hash(i, j, 1115) * 4)] : 'forest-clump', mx, my, { flip: hash(i, j, 1117) < 0.5, s: 0.85 + hash(i, j, 1119) * 0.25, full: true, shadow: 0.5 });
      takeW(mx, my, 12 * kF);
    }
  }
  // parks: shade trees in groups on the lawn, where the park's own pattern clusters them
  {
    const g = 22 * kF;
    for (let i = Math.floor(BB[0] / g); i <= Math.floor(BB[2] / g); i++) for (let j = Math.floor(BB[1] / g); j <= Math.floor(BB[3] / g); j++) {
      const mx = (i + 0.2 + hash(i, j, 1121) * 0.6) * g, my = (j + 0.2 + hash(i, j, 1123) * 0.6) * g;
      if (!park.at(mx, my) || wood.at(mx, my) || !onLand(mx, my, 6 * kF) || fbm(mx / (70 * kF), my / (70 * kF), 1125) < 0.4 || !freeW(mx, my, 8 * kF)) continue;
      if (hash(i, j, 1133) < 0.12 && SPR['flower-garden']) { putW('flower-garden', mx, my, { s: 0.6, shadow: 0 }); takeW(mx, my, 9 * kF); continue; }
      putW(['round-tree-beech', TREE, 'round-tree-linden', 'deciduous-oak', 'round-tree-elm', 'blossom-tree-white'][Math.floor(hash(i, j, 1127) * 6)], mx, my, { flip: hash(i, j, 1129) < 0.5, s: 0.9 + hash(i, j, 1131) * 0.3, shadow: 0.7 }); takeW(mx, my, 9 * kF);
    }
  }
  T('o-woods');
  // E. mountains: pines on the real slopes, outcrops and cliff bands where it is steep, a hut on the
  //    high pastures, real summits
  {
    const rs = 34 * kF, dd = 15 * kF;
    for (let i = Math.floor(BB[0] / rs); i <= Math.floor(BB[2] / rs); i++) for (let j = Math.floor(BB[1] / rs); j <= Math.floor(BB[3] / rs); j++) {
      const mx = (i + 0.25 + hash(i, j, 1201) * 0.5) * rs, my = (j + 0.25 + hash(i, j, 1203) * 0.5) * rs;
      const sl = Math.hypot(dem(mx + dd, my) - dem(mx - dd, my), dem(mx, my + dd) - dem(mx, my - dd)) / (2 * dd / kF);
      if (sl < 0.2 || !onLand(mx, my, 10 * kF) || !freeW(mx, my, 14 * kF)) continue;
      const rel = dem(mx, my) - floor;
      const [hh, dh2] = nearestHeart(mx, my); if (hh && dh2 < 1.6) continue;
      if (sl < 0.5) {
        if (rel > 250 && sl < 0.38 && !wood.at(mx, my) && hash(i, j, 1223) < 0.07 && SPR['alpine-hut']) { putW('alpine-hut', mx, my, { flip: hash(i, j, 1225) < 0.5 }); takeW(mx, my, 16 * kF); continue; }
        if (SPR['pine-group-small'] && placePiece(pickOf(dem(mx, my) > 1100 ? ['larch-group-small', 'larch-group-large', 'pine-group-large'] : ['pine-group-small', 'pine-group-large', 'larch-group-small'], mx, my, 1239), mx, my, { z: -0.2, k: 1.15, flip: hash(i, j, 1215) < 0.5 })) continue;
        { const pp = ['forest-pine-small', 'pine-tall', 'forest-pine-large', 'pine-tall'][Math.floor(hash(i, j, 1227) * 4)]; putW(SPR[pp] ? pp : 'pine-tall', mx, my, { flip: hash(i, j, 1215) < 0.5, s: 0.8 + hash(i, j, 1211) * 0.35, shadow: 0.6 }); if (pp === 'pine-tall' && hash(i, j, 1229) < 0.6) putW('pine-tall', mx + 7 * kF, my - 4 * kF, { s: 0.75, shadow: 0.6, flip: true }); }
        if (hash(i, j, 1217) < 0.35) putW(SPR['slope-boulder-pair'] ? 'slope-boulder-pair' : 'rock-mossy', mx + 2 * kF, my - 12 * kF, { s: 0.7 });
        takeW(mx, my, 14 * kF); continue;
      }
      if (dem(mx, my) > 2000 && SPR['mountain-snow-ridge']) { placePiece('mountain-snow-ridge', mx, my, { z: -0.3 }); continue; }
      if (sl > 0.7 && SPR['crag-large']) { const cn = pickOf(sl > 0.95 ? ['crag-large', 'crag-medium'] : ['crag-medium', 'crag-small', 'outcrop-large'], mx, my, 1233); if (cn && placePiece(cn, mx, my, { z: -0.2, k: 1.2, flip: hash(i, j, 1205) < 0.5 })) continue; }
      if (sl > 0.45 && rel > 120 && SPR['boulder-field-medium'] && hash(i, j, 1235) < 0.45) { const bn = pickOf(['boulder-field-medium', 'boulder-field-small', 'outcrop-small'], mx, my, 1237); if (bn && placePiece(bn, mx, my, { z: -0.3, k: 1.2 })) continue; }
      if (sl > 0.75 && SPR['mountain-limestone-cliff-band']) { placePiece('mountain-limestone-cliff-band', mx, my, { z: -0.3, flip: hash(i, j, 1205) < 0.5 }); continue; }
      if (wood.at(mx, my) && SPR['mountain-forested-slope-band']) { placePiece('mountain-forested-slope-band', mx, my, { z: -0.35, flip: hash(i, j, 1205) < 0.5 }); continue; }
      if (sl > 0.6 && rel > 250 && SPR['mountain-scree-fan'] && hash(i, j, 1231) < 0.5) { placePiece('mountain-scree-fan', mx, my, { z: -0.35, flip: hash(i, j, 1205) < 0.5 }); continue; }
      if (false) putW('', mx, my);
      else { const pool = SPR['slope-outcrop-shelf'] ? ['slope-outcrop-shelf', 'slope-outcrop-spur', 'slope-boulder-pair', 'rock-mossy'] : ['rock-mossy', 'rock-angular', 'rock-flat']; putW(pool[Math.floor(hash(i, j, 1207) * pool.length)], mx, my, { flip: hash(i, j, 1209) < 0.5 }); }
      takeW(mx, my, 18 * kF);
    }
    for (const f of Q('mountain_peak')) {
      if (f.geometry.type !== 'Point') continue;
      const m = toM(f.geometry.coordinates); if (!inCanvas(m[0], m[1])) continue;
      putW((f.properties.ele || 0) > 2000 && SPR['snowy-summit'] ? 'snowy-summit' : 'mountain-peak', m[0], m[1], { s: 1 + Math.min(1, ((f.properties.ele || 1500) - 1500) / 1500) }); takeW(m[0], m[1], 40 * kF);
    }
  }
  // real cemeteries (graves among cypresses), real monuments
  if (SPR['graveyard-patch']) for (const it of cemetery.items) {
    const g = 34 * kF;
    for (let i = Math.floor(it.bb[0] / g); i <= Math.floor(it.bb[2] / g); i++) for (let j = Math.floor(it.bb[1] / g); j <= Math.floor(it.bb[3] / g); j++) {
      const mx = (i + 0.5) * g, my = (j + 0.5) * g; if (!inPoly(mx, my, it.rings) || !freeW(mx, my, 14 * kF)) continue;
      { const [, sm] = streetNear(mx, my, 90 * kF); if (placeFiller(['yew-graveyard'], mx, my, sm ? sm[3] : 0, 1305, [80, 40])) continue; }
      putW('graveyard-patch', mx, my, { flip: hash(i, j, 1301) < 0.5, shadow: 0 }); takeW(mx, my, 16 * kF);
      const x = mx + 14 * kF, y = my + 6 * kF; if (SPR['columnar-cypress'] && hash(i, j, 1303) < 0.6 && freeW(x, y, 3 * kF, 1 * kF)) { putW('columnar-cypress', x, y, { s: 0.9, shadow: 0.6 }); takeW(x, y, 3 * kF); }
    }
  }
  if (false) for (const p of pois) { if (!['monument', 'memorial'].includes(p.class) || !inCanvas(p.x, p.y) || !freeW(p.x, p.y, 5 * kF, 0)) continue; putW('monument-statue', p.x, p.y); takeW(p.x, p.y, 6 * kF); }
  // F. real bridges: the deck is painted from the real geometry (with the roads); a drawn arched bridge
  //    in the nearest of its four directions stands on it when the crossing is close enough to one
  const decks = [], deckHash = new Set();
  for (const br of bridges) {
    const a = br.pts[0], b2 = br.pts[br.pts.length - 1]; let nW = 0;
    for (let m = 1; m < 10; m++) if (waterIdx.at(a[0] + (b2[0] - a[0]) * m / 10, a[1] + (b2[1] - a[1]) * m / 10)) nW++;
    { const Lm = Math.hypot(b2[0] - a[0], b2[1] - a[1]) || 1, ex = (b2[0] - a[0]) / Lm * 6 * kF, ey = (b2[1] - a[1]) / Lm * 6 * kF; if (nW < 3 || !(onLand(a[0], a[1]) || onLand(a[0] - ex, a[1] - ey)) || !(onLand(b2[0], b2[1]) || onLand(b2[0] + ex, b2[1] + ey))) continue; }
    const mid0 = [(a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2];
    { const ext = 8 * kF, Lb = Math.hypot(b2[0] - a[0], b2[1] - a[1]) || 1, ux = (b2[0] - a[0]) / Lb, uy = (b2[1] - a[1]) / Lb; if (drawnNear(a[0] - ux * ext, a[1] - uy * ext) > 6 && drawnNear(a[0], a[1]) > 6) continue; if (drawnNear(b2[0] + ux * ext, b2[1] + uy * ext) > 6 && drawnNear(b2[0], b2[1]) > 6) continue; } // a bridge carries a drawn road at both ends
    if (decks.some((d) => Math.hypot((d.pts[0][0] + d.pts[d.pts.length - 1][0]) / 2 - mid0[0], (d.pts[0][1] + d.pts[d.pts.length - 1][1]) / 2 - mid0[1]) < 40 * kF)) continue; // one crossing, one bridge
    decks.push(br);
    for (let m = 0; m <= 20; m++) { const x = a[0] + (b2[0] - a[0]) * m / 20, y = a[1] + (b2[1] - a[1]) * m / 20; deckHash.add(Math.floor(x / (8 * kF)) + ',' + Math.floor(y / (8 * kF))); }
    const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]) / kF, ang = Math.atan2(b2[1] - a[1], b2[0] - a[0]);
    const [ob, res] = orient(ang);
    if (Math.abs(res) > 0.3 || L < 8) continue;
    const river = riverL.some((r) => r.cls === 'river' && r.pts.some((v) => Math.hypot(v[0] - (a[0] + b2[0]) / 2, v[1] - (a[1] + b2[1]) / 2) < 60 * kF));
    if (br.c === 'track' && !coreAt((a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2)) { if (Math.abs(res) < 0.3 && L < 40 && ob === 'ew') putW('wooden-bridge', (a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2, { w: L * 1.3 * ppm, rot: -res, ay: 0.6, shadow: 0, z: 1 }); continue; }
    if (L <= 32 && !river) putMod('canal-bridge-arch', (a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2, ang, Math.max(14, L * 1.2), { z: 1, ay: 0.55, k: 1 });
    else {
      // a long river bridge: three-arch spans end to end over the whole crossing
      const n = Math.max(1, Math.round(L * 1.08 / 36)), Ls = L * 1.08 / n;
      for (let m = 0; m < n; m++) {
        const t = (m + 0.5) / n, x = a[0] + (b2[0] - a[0]) * (t * 1.08 - 0.04), y = a[1] + (b2[1] - a[1]) * (t * 1.08 - 0.04);
        putMod('river-bridge-multiarch', x, y, ang, Ls, { z: 1, ay: 0.55, k: 1.03 });
        // foam where the piers stand in the current
        if (SPR['river-foam'] && !onLand(x, y, 0)) { const nx = -(b2[1] - a[1]) / (L * kF), ny = (b2[0] - a[0]) / (L * kF), sgn = ny < 0 ? 1 : -1; putW('river-foam', x + nx * sgn * 7 * kF, y + ny * sgn * 7 * kF, { s: 1, shadow: 0, z: 0.5, rot: 0 }); }
      }
    }
  }
  const nearDeck = (x, y) => { const i = Math.floor(x / (8 * kF)), j = Math.floor(y / (8 * kF)); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (deckHash.has((i + a) + ',' + (j + b))) return true; return false; };
  // G. water edges: built stone quays in towns, stony banks in the country, along the real shore; boats
  //    moored at the town quays
  const quayRun = [];
  const bigRiver = !canalCity && riverL.some((r) => r.cls === 'river');
  for (const p of waterP) for (const ring of p) {
    const bb = bboxOf([ring]); if (bb[2] < BB[0] || bb[0] > BB[2] || bb[3] < BB[1] || bb[1] > BB[3]) continue;
    const NEW = !!SPR['quay-soft-ew'], WIDE = !!SPR['quay-mooring-wide-ew'];
    alongW(ring, (WIDE ? 34 : NEW ? 24 : 15) * kF, (x, y, ang, nx, ny, sp, segL) => {
      if (!inCanvas(x, y) || nearDeck(x, y) || segL < (WIDE ? 20 : 9)) return; // short corner cuts get no wall of their own
      const l1 = onLand(x + nx * 4 * kF, y + ny * 4 * kF), l2 = onLand(x - nx * 4 * kF, y - ny * 4 * kF); if (l1 === l2) return;
      const riverHere = !canalCity && (bigRiver || p.river), s = l1 ? 1 : -1, town = canalCity || ((coreAt(x, y) || nearestHeart(x, y)[1] < 2.5) && !riverHere);
      if (town) { quayRun.push([x, y, ang, -nx * s, -ny * s]); return; } // town water: the continuous quay band is painted with the ground
      if (riverHere) { if (H01(x, y, 2211) < 0.06 && SPR['gravel-bar-point']) { const gx = x - nx * s * 9 * kF, gy = y - ny * s * 9 * kF; if (!onLand(gx, gy, 6 * kF) && inCanvas(gx, gy)) putW(H01(x, y, 2213) < 0.5 ? 'gravel-bar-point' : 'gravel-bar-fan', gx, gy, { w: 40 * ppm, ax: 0.5, ay: 0.5, rot: -ang, shadow: 0, z: -0.9 }); } return; } // rivers: a painted stony bank band
      const fam = !NEW ? (town ? 'canal-quay' : 'riverbank-rocky') : town ? (WIDE ? 'quay-mooring-wide' : 'quay-soft') : p.still ? 'bank-reeds' : bigRiver && ALP ? 'bank-rocky' : 'bank-grassy';
      // a real river outside town: painted rocky margins following the bank, a gravel bar now and then
      if (!town && riverHere && SPR['rocky-bank-low']) { const rn = H01(x, y, 2209) < 0.5 ? 'rocky-bank-low' : 'rocky-bank-wide', m4 = SPRIDX[rn]; const bx4 = x + nx * s * 1 * kF, by4 = y + ny * s * 1 * kF; if (inCanvas(bx4, by4) && m4) putW(rn, bx4, by4, { w: m4.foot_m[0] * 1.12 * ppm, ax: 0.5, ay: 0.5, rot: -ang, shadow: 0, z: -1 }); if (H01(x, y, 2211) < 0.08 && SPR['gravel-bar-point']) { const gx = x - nx * s * 9 * kF, gy = y - ny * s * 9 * kF; if (!onLand(gx, gy, 6 * kF)) putW(H01(x, y, 2213) < 0.5 ? 'gravel-bar-point' : 'gravel-bar-fan', gx, gy, { w: 40 * ppm, ax: 0.5, ay: 0.5, rot: -ang, shadow: 0, z: -0.9 }); } return; }
      if (/rocky/.test(fam) && SPR['river-foam'] && bigRiver && H01(x, y, 2207) < 0.12) putW('river-foam', x - nx * s * 5 * kF, y - ny * s * 5 * kF, { s: 0.9, shadow: 0, rot: -orient(ang)[1] - (orient(ang)[0] === 'ew' ? 0 : orient(ang)[0] === 'ns' ? Math.PI / 2 : orient(ang)[0] === 'ne-sw' ? Math.PI / 4 : -Math.PI / 4), z: -0.5 });
      const bx = x + nx * s * 1.2 * kF, by = y + ny * s * 1.2 * kF;
      if (hitW(bx, by, 2 * kF) && !town) return;
      const quay = /quay/.test(fam);
      putMod(fam, bx + nx * s * 0.6 * kF, by + ny * s * 0.6 * kF, ang, sp * 1.1, { z: quay ? 0 : -1, ay: 0.5, thick: NEW ? 1.2 : quay ? 2 : 1.6 });
      if (quay) quayRun.push([x, y, ang, nx * -s, ny * -s]);
    }, 'wq', true);
  }
  const boatCells = new Set();
  if (canalCity) for (const [x, y, ang, wx, wy] of quayRun) {
    if (H01(x, y, 2201) > (canalCity ? 0.1 : 0.05) || boatCells.has(Math.round(x / (45 * kF)) + ',' + Math.round(y / (45 * kF)))) continue;
    boatCells.add(Math.round(x / (45 * kF)) + ',' + Math.round(y / (45 * kF)));
    const bx = x + wx * 4 * kF, by = y + wy * 4 * kF;
    if (onLand(bx, by, 0) || nearDeck(bx, by)) continue;
    const [ob] = orient(ang), bn = ob === 'ns' ? ['rowing-boat-s', 'rowing-boat-s', 'rowing-boat-ne', 'rowing-boat-se'][Math.floor(H01(x, y, 2205) * 4)] : ob === 'ne-sw' ? 'rowing-boat-ne' : ob === 'nw-se' ? 'rowing-boat-se' : (H01(x, y, 2203) < 0.5 ? 'rowing-boat-ne' : 'rowing-boat-se');
    if (SPR[bn]) putW(bn, bx, by, { s: 1, shadow: 0, z: 0, ay: 0.6 });
  }
  // reeds on the wild banks of real rivers and streams; a watermill where a stream passes a village
  if (SPR.reeds) for (const r of riverL) if (['river', 'stream'].includes(r.cls)) for (let i = 1; i < r.pts.length; i++) {
    const [mx, my] = r.pts[i]; const [, dh] = nearestHeart(mx, my); if (dh < 2 || hash(Math.round(mx / kF), Math.round(my / kF), 1601) > 0.3) continue;
    const sd = hash(Math.round(my / kF), 3, 1603) < 0.5 ? 1 : -1, w0 = ({ river: 16, stream: 4 }[r.cls]) / 2 + 2, x = mx + sd * w0 * kF;
    if (freeW(x, my, 4 * kF, 0)) { putW('reeds', x, my, { flip: sd < 0, shadow: 0 }); takeW(x, my, 4 * kF); }
  }
  if (SPR.watermill && !riverL.some((r) => r.cls === 'canal')) for (const h of hearts) {
    let best = null, bd = h.R * 2.2;
    for (const r of riverL) if (['stream', 'river'].includes(r.cls)) for (const v of r.pts) { const d = Math.hypot(v[0] - h.x, v[1] - h.y); if (d < bd && d > h.R * 0.6) { bd = d; best = v; } }
    if (best && footDry(best[0] + 12 * kF, best[1], 10 * kF) && freeW(best[0] + 12 * kF, best[1], 12 * kF)) { putW('watermill', best[0] + 12 * kF, best[1]); takeW(best[0] + 12 * kF, best[1], 16 * kF); }
  }
  T('objects');

  // ------------------------------------------------------------ ground (painted only for the chunk itself)
  // textures through low-resolution masks of world-anchored fields; few full-size passes
  const fieldMask = (fn, s = 24) => {
    if (planOnly) return null;
    const w = Math.ceil(W / s) + 2, h = Math.ceil(H / s) + 2, c = off(w, h), x = c.getContext('2d'), img = x.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) { const v = fn(BB[0] + (xx * s) / sx, BB[3] - (y * s) / sx); img.data[(y * w + xx) * 4 + 3] = Math.max(0, Math.min(255, v * 255)); }
    x.putImageData(img, 0, 0); c.s = s; return c;
  };
  const tmp = planOnly ? null : off(W, H), tx2 = planOnly ? null : tmp.getContext('2d');
  const texThrough = (name, mask, alpha = 1, rot = 0, op = 'source-over') => {
    const tex = TEXTURES[name]; if (!tex || planOnly) return false;
    tx2.globalCompositeOperation = 'copy'; tx2.fillStyle = worldPattern(tx2, tex, TEX_METRES[name], rot); tx2.fillRect(0, 0, W, H);
    if (mask) { tx2.globalCompositeOperation = 'destination-in'; tx2.imageSmoothingEnabled = true; tx2.drawImage(mask, 0, 0, mask.width * (mask.s || 1), mask.height * (mask.s || 1)); }
    ctx.save(); ctx.globalAlpha = alpha; ctx.globalCompositeOperation = op; ctx.drawImage(tmp, 0, 0); ctx.restore();
    return true;
  };
  // soft masks: drawn at low resolution and scaled up smoothly (a canvas blur is slow in a worker)
  const softMask = (draw, featherPx) => { const f = Math.max(2, Math.round(featherPx)); const c = off(Math.ceil(W / f) + 2, Math.ceil(H / f) + 2), x = c.getContext('2d'); x.scale(1 / f, 1 / f); x.fillStyle = '#000'; draw(x); c.s = f; return c; };
  const up = (m) => { const c = off(W, H), x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(m, 0, 0, m.width * m.s, m.height * m.s); return c; };
  const polyMaskC = (polys, featherM) => { if (planOnly) return null; if (featherM) return softMask((x) => fillPolys(x, polys, P), featherM * ppm); const c = off(W, H), x = c.getContext('2d'); x.fillStyle = '#000'; fillPolys(x, polys, P); return c; };
  if (!planOnly) {
    // 1. meadow: three meadow textures blended at large scale, wildflower drifts, alpine coolness
    // the lush swales meadow as the base, the other meadows blended over it at large scale, then
    //    broad sunlit and shaded swathes (light and dark both, never only darker)
    const fm = (sc, seed, a0, a1, amp = 1, s2 = 24) => fieldMask((x, y) => smooth(a0, a1, fbm(x / (sc * kF), y / (sc * kF), seed)) * amp, s2);
    // round 7: calm. One meadow base, a second blended in very broad drifts, gentle large light and
    //    shade, then a grade towards the paint-overs (softer, warmer, less saturated)
    if (TEXTURES['meadow-sunlit-lowland']) {
      // round 8: the sunlit meadows (set five), blended at very large scale
      texThrough('meadow-sunlit-lowland', null);
      texThrough('meadow-sunlit-gold', fm(340, 519, 0.42, 0.64, 0.75), 1);
      texThrough('meadow-sunlit-clover', fm(300, 529, 0.55, 0.75, 0.6), 1);
    } else {
      if (!texThrough('meadow-swales', null)) texThrough('meadow-sunlit', null);
      texThrough('meadow-sunlit', fm(320, 519, 0.4, 0.62, 0.55), 1);
      texThrough('meadow-dry-patches', fm(380, 529, 0.6, 0.78, 0.3), 1);
    }
    const wash = (rgb, mask, op) => { if (!mask) return; tx2.globalCompositeOperation = 'copy'; tx2.fillStyle = rgb; tx2.fillRect(0, 0, W, H); tx2.globalCompositeOperation = 'destination-in'; tx2.drawImage(mask, 0, 0, mask.width * mask.s, mask.height * mask.s); ctx.save(); ctx.globalCompositeOperation = op; ctx.drawImage(tmp, 0, 0); ctx.restore(); };
    wash('rgb(120,104,40)', fm(240, 531, 0.4, 0.72, 0.95, 32), 'screen');
    wash('rgb(165,152,112)', fm(300, 527, 0.5, 0.2, 0.6, 32), 'multiply');
    // warm golden grade, towards the targets (green/red about 0.9, little blue)
    { ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgb(255,236,150)'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = 'rgb(26,20,0)'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    // the meadow overlays (set five): flower drifts, cloud shadows, damp grass, large and soft, on a world grid
    if (!lite && SPR['overlay-flower-drift']) { const g = 130 * kF; for (let i = Math.floor(BB[0] / g) - 1; i <= Math.floor(BB[2] / g) + 1; i++) for (let j = Math.floor(BB[1] / g) - 1; j <= Math.floor(BB[3] / g) + 1; j++) { const r = hash(i, j, 3401), n = r < 0.4 ? 'overlay-flower-drift' : r < 0.5 ? 'overlay-damp-grass' : null; if (!n || !SPR[n] || !SPRIDX[n]) continue; const [px, py] = P([(i + 0.2 + hash(i, j, 3403) * 0.6) * g, (j + 0.2 + hash(i, j, 3405) * 0.6) * g]), w = SPRIDX[n].foot_m[0] * 1.12 * ppm, h = w * SPR[n].height / SPR[n].width; ctx.save(); ctx.globalAlpha = n === 'overlay-cloud-shadow' ? 0.28 : n === 'overlay-damp-grass' ? 0.35 : 0.7; drawS(ctx, SPR[n], px - w / 2, py - h / 2, w, h); ctx.restore(); } }
    if (dem((BB[0] + BB[2]) / 2, (BB[1] + BB[3]) / 2) - floor > 80) texThrough('meadow-cool', fieldMask((x, y) => smooth(150, 450, dem(x, y) - floor) * 0.25));
    // under every painted piece the meadow turns softly towards the piece's own grass, so its painted
    //    ground fades in without a pad or a halo
    for (const pc of pieces) { if (pc.filler) continue; const [cx, cy] = P([pc.cx, pc.cy]), rx = pc.fw * 0.75 * ppm, ry = pc.fh * 0.75 * ppm; ctx.save(); ctx.translate(cx, cy); ctx.scale(1, ry / rx); const gr = ctx.createRadialGradient(0, 0, rx * 0.35, 0, 0, rx); gr.addColorStop(0, 'rgba(166,148,42,0.6)'); gr.addColorStop(1, 'rgba(166,148,42,0)'); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    T('meadow');
    // 2. real ground layers
    if (parkP.length) texThrough(TEXTURES['meadow-deep-green'] ? 'meadow-deep-green' : 'pasture', polyMaskC(parkP, 8), 0.35);
    if (sandP.length) texThrough('sand', polyMaskC(sandP, 2), 0.9);
    // forest floor only under the trees actually drawn (a dark patch always has its wood)
    { const fo = []; if (fo.length) { const c2 = softMask((x) => { for (const o of fo) { x.beginPath(); x.ellipse(o.x, o.y - o.h * 0.25, o.w * 0.42, o.h * 0.34, 0, 0, Math.PI * 2); x.fill(); } }, 4 * ppm); texThrough('forest-floor', c2, 0.55); } }
    {
      const dd = 15 * kF, slopeAt = (x, y) => Math.hypot(dem(x + dd, y) - dem(x - dd, y), dem(x, y + dd) - dem(x, y - dd)) / (2 * dd / kF);
      let steep = rockP.length > 0; for (let i = 0; i < 6 && !steep; i++) for (let j = 0; j < 6 && !steep; j++) if (slopeAt(BB[0] + (BB[2] - BB[0]) * (i + 0.5) / 6, BB[1] + (BB[3] - BB[1]) * (j + 0.5) / 6) > 0.4) steep = true;
      if (steep) {
        const m = fieldMask((x, y) => smooth(0.62, 0.9, slopeAt(x, y)), 16);
        texThrough('rock', m, 0.55);
        texThrough('scree', fieldMask((x, y) => smooth(0.42, 0.6, slopeAt(x, y)) * (1 - smooth(0.62, 0.8, slopeAt(x, y)))), 0.9);
        if (rockP.length) texThrough('rock', polyMaskC(rockP, 2), 0.9);
      }
      if (dem((BB[0] + BB[2]) / 2, (BB[1] + BB[3]) / 2) > 1700) texThrough('snow', fieldMask((x, y) => smooth(1900, 2100, dem(x, y)), 16), 0.95);
    }
    // 3. fields (real farmland and the villages' own parcels), paddocks and lots: shaped patches
    //    with a soil rim and a hedge edge, no drop shadow
    const patch = (pts, texName, ang, edge) => {
      const path = () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
      ctx.save(); ctx.lineJoin = 'round';
      path(); ctx.fillStyle = TEXTURES[texName] ? worldPattern(ctx, TEXTURES[texName], TEX_METRES[texName], ang) : '#b89a50'; ctx.fill();
      path(); ctx.strokeStyle = TEXTURES['dirt-path'] ? worldPattern(ctx, TEXTURES['dirt-path'], 16) : 'rgba(120,96,48,0.9)'; ctx.lineWidth = 2.6 * ppm; ctx.stroke();
      path(); ctx.strokeStyle = 'rgba(100,74,36,0.45)'; ctx.lineWidth = 0.5 * ppm; ctx.stroke();
      ctx.restore();
    };
    // big real farmland is worked in strips along its long axis (world-anchored strips, each its own crop)
    const strips = (ring, o2) => {
      const ca = Math.cos(o2.ang), sa = Math.sin(o2.ang), SW = 34 * kF;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity; for (const [x, y] of ring) { const u = x * ca + y * sa, v = -x * sa + y * ca; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const kinds = ['wheat-field', 'ploughed-earth', 'pasture', 'vegetable-rows', 'wheat-field', 'pasture'];
      ctx.save(); ctx.beginPath(); ring.map(P).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.clip();
      for (let kk = Math.floor(v0 / SW); kk * SW < v1; kk++) {
        const tn = kinds[Math.floor(hash(kk, 7, 67) * kinds.length)];
        const pts = [[u0, kk * SW], [u1, kk * SW], [u1, (kk + 1) * SW], [u0, (kk + 1) * SW]].map(([u, v]) => P([u * ca - v * sa, u * sa + v * ca]));
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
        ctx.fillStyle = TEXTURES[tn] ? worldPattern(ctx, TEXTURES[tn], TEX_METRES[tn], -o2.ang) : '#b89a50'; ctx.fill();
        ctx.strokeStyle = 'rgba(120,92,48,0.6)'; ctx.lineWidth = 1.6 * ppm; ctx.stroke();
      }
      ctx.restore();
      ctx.save(); ctx.beginPath(); ring.map(P).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.strokeStyle = TEXTURES['dirt-path'] ? worldPattern(ctx, TEXTURES['dirt-path'], 16) : '#9a7a48'; ctx.lineWidth = 2.6 * ppm; ctx.stroke(); ctx.restore();
    };
    for (const p of farmP) { const o2 = obb(p[0]); const area = ringArea(p[0]) / (k * k); if (area < 1200) continue; if (area > 20000 && o2) { const pm = polyMaskC([p], 14); texThrough('meadow-dry-patches', pm, 0.4); continue; } const hf = hash(Math.round(p[0][0][0] / kF), Math.round(p[0][0][1] / kF), 63); patch(p[0].map(P), hf < 0.45 ? 'wheat-field' : hf < 0.75 ? 'ploughed-earth' : 'vegetable-rows', o2 ? -o2.ang : 0, 'hedge'); }
    for (const f of fields) patch(f.corners.map(P), f.kind, -f.ang, 'hedge');
    for (const pd of paddocks) { patch(pd.corners.map(P), 'pasture', 0, 'hedge'); }
    // lots: a yard or garden patch behind each house and a short path to its street
    for (const L of lots) {
      if (L.bx !== null && L.pts) {
        const tn = L.kind === 'veg' ? 'vegetable-rows' : L.kind === 'yard' ? 'dirt-path' : 'meadow-deep-green';
        ctx.save(); ctx.beginPath(); L.pts.map(P).forEach(([px, py], i2) => (i2 ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath();
        ctx.fillStyle = TEXTURES[tn] ? worldPattern(ctx, TEXTURES[tn], TEX_METRES[tn]) : '#9a8a50'; ctx.globalAlpha = L.kind === 'veg' ? 0.9 : L.kind === 'yard' ? 0.6 : 0.4; ctx.fill(); ctx.restore();
      } else if (L.bx !== null) {
        const [x, y] = P([L.bx, L.by]), r = L.r * sx;
        const tn = L.kind === 'veg' ? 'vegetable-rows' : L.kind === 'yard' ? 'dirt-path' : 'meadow-deep-green';
        const ca3 = Math.cos(L.ang), sa3 = Math.sin(L.ang), pts = [[-1, -0.8], [1, -0.8], [1, 0.8], [-1, 0.8]].map(([u, v]) => P([L.bx + (u * sa3 - v * ca3) * L.r, L.by + (-u * ca3 - v * sa3) * L.r]));
        ctx.save(); ctx.beginPath(); pts.forEach(([px, py], i2) => (i2 ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath();
        ctx.fillStyle = TEXTURES[tn] ? worldPattern(ctx, TEXTURES[tn], TEX_METRES[tn], L.ang) : '#9a8a50'; ctx.globalAlpha = L.kind === 'yard' ? 0.75 : L.kind === 'veg' ? 0.95 : 0.6; ctx.fill(); ctx.restore();
      }
      if (L.sx !== null) {
        const [x0, y0] = P([L.x, L.y]), [x1, y1] = P([L.sx, L.sy]);
        ctx.save(); ctx.strokeStyle = TEXTURES['dirt-path'] ? worldPattern(ctx, TEXTURES['dirt-path'], TEX_METRES['dirt-path']) : '#d8b070'; ctx.lineWidth = 3 * ppm; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.restore();
      }
    }
    // ground decals: flowers, tufts, clover, pebbles and leaf litter in drifts the world's own pattern
    //    lays out (one kind per drift), never on roads, water or under buildings
    if (!lite) {
      const g = 8.5 * kF;
      for (let i = Math.floor(BB[0] / g); i <= Math.floor(BB[2] / g); i++) for (let j = Math.floor(BB[1] / g); j <= Math.floor(BB[3] / g); j++) {
        const mx = (i + hash(i, j, 2301)) * g, my = (j + hash(i, j, 2303)) * g;
        const drift = fbm(mx / (60 * kF), my / (60 * kF), 2305); if (hash(i, j, 2307) > (drift - 0.42) * 1.4) continue;
        if (!onLand(mx, my, 3 * kF) || hitW(mx, my, 3 * kF) || farm.at(mx, my) || hearts.some((h) => inPlaza(h, mx, my, 3 * kF))) continue;
        const [sd] = streetNear(mx, my, 20 * kF); if (sd < 2) continue;
        const kindN = fbm(mx / (90 * kF), my / (90 * kF), 2309);
        let n2;
        if (wood.at(mx, my) || nearTrail(mx, my)) n2 = 'decals-leaf-litter';
        else if (sd < 5) continue;
        else n2 = ['decals-flower-ivory', 'decals-flower-pink', 'decals-flower-ivory', 'decals-grass-tufts-light'][Math.floor(kindN * 3.99)];
        const im = SPR[n2], meta = SPRIDX[n2]; if (!im || !meta) continue;
        const wM = { 'decals-flower-ivory': 4, 'decals-flower-pink': 4, 'decals-flower-lavender': 4, 'decals-grass-tufts-light': 4, 'decals-grass-tufts-dark': 5, 'decals-pebbles': 5, 'decals-clover': 4, 'decals-leaf-litter': 6 }[n2] * 1.1 * (0.8 + hash(i, j, 2317) * 0.4);
        const [x, y] = P([mx, my]), w = wM * ppm, h = w * im.height / im.width;
        ctx.save(); ctx.globalAlpha = 0.75; ctx.translate(x, y); if (hash(i, j, 2319) < 0.5) ctx.scale(-1, 1); drawS(ctx, im, -w / 2, -h / 2, w, h); ctx.restore();
      }
    }
    // flowers and tufts at the foot of every house, as in the painted finish
    if (!lite) for (const o of objs) {
      if (!/-roof-|house|cottage|row-|tavern|inn$|church|chapel|limewash|gable/.test(o.name)) continue;
      for (const sd of [-1, 1]) {
        const hx = hash(Math.round(o.x), Math.round(o.y) + sd, 2321), n2 = hx < 0.4 ? 'decals-flower-pink' : hx < 0.7 ? 'decals-flower-ivory' : 'decals-grass-tufts-dark';
        const im = SPR[n2]; if (!im) continue;
        const w = o.w * 0.26, h = w * im.height / im.width, x = o.x + sd * o.w * (0.3 + hx * 0.08), y = o.y - o.h * 0.02;
        drawS(ctx, im, x - w / 2, y - h * 0.75, w, h);
      }
    }
    T('ground');
  }
  // 4. water: textured; stone quays in towns, sand or scree banks outside; shallows along every shore
  if (!planOnly && (waterP.length || riverL.length)) {
    const wm = off(W, H), wmc = wm.getContext('2d');
    wmc.fillStyle = '#000'; fillPolys(wmc, waterP, P);
    wmc.strokeStyle = '#000'; wmc.lineCap = 'round'; wmc.lineJoin = 'round';
    for (const r of riverL) { if (['ditch', 'drain'].includes(r.cls) || (r.cls === 'stream' && lineLen(r.pts) < 120)) continue; const wR = { river: 16, canal: 12, stream: 4, ditch: 2.5, drain: 2.5 }[r.cls] || 3; wmc.lineWidth = Math.max(1.5, wR * ppm); traceLines(wmc, [r.pts], P); wmc.stroke(); }
    if (bridges.length && waterP.length) {
      const c2 = Math.max(2, Math.round(2 * ppm)), w3 = Math.ceil(W / c2), h3 = Math.ceil(H / c2);
      const mc = off(w3, h3), m3 = mc.getContext('2d'); m3.scale(1 / c2, 1 / c2); m3.fillStyle = '#000'; fillPolys(m3, waterP, P);
      const src = m3.getImageData(0, 0, w3, h3).data, A0 = new Uint8Array(w3 * h3);
      for (let i = 0; i < w3 * h3; i++) A0[i] = src[i * 4 + 3] > 127 ? 1 : 0;
      const r = Math.max(1, Math.round(17 * ppm / c2));
      const pass = (a, horiz, isMax) => { const o2 = new Uint8Array(a.length); for (let y = 0; y < h3; y++) for (let x = 0; x < w3; x++) { let v = isMax ? 0 : 1; for (let d = -r; d <= r; d++) { const xx = horiz ? x + d : x, yy = horiz ? y : y + d; const ins = xx >= 0 && yy >= 0 && xx < w3 && yy < h3; const u = ins ? a[yy * w3 + xx] : a[y * w3 + x]; if (isMax ? u : !u) { v = isMax ? 1 : 0; break; } } o2[y * w3 + x] = v; } return o2; };
      const closed = pass(pass(pass(pass(A0, true, true), false, true), true, false), false, false);
      const gi = m3.createImageData(w3, h3); let nGap = 0;
      for (let i = 0; i < w3 * h3; i++) if (closed[i] && !A0[i]) { gi.data[i * 4 + 3] = 255; nGap++; }
      if (nGap) { const gc = off(w3, h3); gc.getContext('2d').putImageData(gi, 0, 0); wmc.imageSmoothingEnabled = true; wmc.drawImage(gc, 0, 0, w3 * c2, h3 * c2); wmc.drawImage(gc, 0, 0, w3 * c2, h3 * c2); }
    }
    const townish = hearts.some((h) => h.t >= 1 && Math.hypot(h.x - (BB[0] + BB[2]) / 2, h.y - (BB[1] + BB[3]) / 2) < h.R * 5) || riverL.some((r) => r.cls === 'canal');
    const bankW = (townish ? 4.5 : 5) * ppm;
    const bk = off(W, H), bkc = bk.getContext('2d');
    for (let a = 0; a < 12; a++) bkc.drawImage(wm, Math.cos(a / 12 * Math.PI * 2) * bankW, Math.sin(a / 12 * Math.PI * 2) * bankW);
    bkc.globalCompositeOperation = 'source-in';
    if (townish && TEXTURES['cobbled-square']) { bkc.fillStyle = worldPattern(bkc, TEXTURES['cobbled-square'], 6); bkc.fillRect(0, 0, W, H); bkc.globalCompositeOperation = 'source-atop'; bkc.fillStyle = 'rgba(214,196,160,0.35)'; bkc.fillRect(0, 0, W, H); }
    else { const tn = waterP.some((m2) => m2.river) || dem((BB[0] + BB[2]) / 2, (BB[1] + BB[3]) / 2) > 400 ? 'scree' : 'sand'; bkc.fillStyle = TEXTURES[tn] ? worldPattern(bkc, TEXTURES[tn], TEX_METRES[tn]) : '#b8a070'; bkc.fillRect(0, 0, W, H); }
    ctx.drawImage(bk, 0, 0);
    // the quay's cap: a light stone line along its land edge (continuous, it follows the real bank)
    if (townish) { const cap = off(W, H), cx2 = cap.getContext('2d'); for (let a = 0; a < 12; a++) cx2.drawImage(wm, Math.cos(a / 12 * Math.PI * 2) * (bankW + 0.9 * ppm), Math.sin(a / 12 * Math.PI * 2) * (bankW + 0.9 * ppm)); cx2.globalCompositeOperation = 'destination-out'; cx2.drawImage(bk, 0, 0); cx2.drawImage(wm, 0, 0); cx2.globalCompositeOperation = 'source-in'; cx2.fillStyle = 'rgba(236,224,196,0.9)'; cx2.fillRect(0, 0, W, H); ctx.drawImage(cap, 0, 0); }
    const wc = off(W, H), w2 = wc.getContext('2d');
    w2.drawImage(wm, 0, 0); w2.globalCompositeOperation = 'source-in';
    let flow = 0; { let fx = 0, fy = 0; for (const r of riverL) if (r.cls === 'river') for (let i = 1; i < r.pts.length; i++) { const dx = r.pts[i][0] - r.pts[i - 1][0], dy = r.pts[i][1] - r.pts[i - 1][1], L = Math.hypot(dx, dy); if (!L) continue; const a = Math.atan2(dy, dx); fx += Math.cos(2 * a) * L; fy += Math.sin(2 * a) * L; } flow = Math.atan2(fy, fx) / 2; }
    const wTex = canalCity && TEXTURES['canal-sun-sweeps'] ? 'canal-sun-sweeps' : !canalCity && TEXTURES['river-bright-current'] ? 'river-bright-current' : canalCity && TEXTURES['canal-reflection-painted'] ? 'canal-reflection-painted' : TEXTURES['river-current-painted'] ? 'river-current-painted' : 'river-water';
    w2.fillStyle = TEXTURES[wTex] ? worldPattern(w2, TEXTURES[wTex], TEX_METRES[wTex], /river/.test(wTex) ? -flow : 0) : WATER.edge; w2.fillRect(0, 0, W, H);
    if (TEXTURES['lake-water'] && waterP.some((m) => m.still)) { const lm2 = off(W, H), l2 = lm2.getContext('2d'); l2.fillStyle = '#000'; fillPolys(l2, waterP.filter((m) => m.still), P); l2.globalCompositeOperation = 'source-in'; l2.fillStyle = TEXTURES['canal-reflection-painted'] ? worldPattern(l2, TEXTURES['canal-reflection-painted'], 52) : worldPattern(l2, TEXTURES['lake-water'], TEX_METRES['lake-water']); l2.fillRect(0, 0, W, H); w2.globalCompositeOperation = 'source-atop'; w2.drawImage(lm2, 0, 0); }
    // shallows: a lighter band along every shore, and a crisp dark line at the waterline
    const rim = off(W, H), r5 = rim.getContext('2d'); r5.fillStyle = '#000'; r5.fillRect(0, 0, W, H); r5.globalCompositeOperation = 'destination-out'; r5.drawImage(wm, 0, 0);
    const sh = up(softMask((x) => x.drawImage(rim, 0, 0), Math.max(2, 2.5 * ppm))), s6 = sh.getContext('2d'); s6.globalCompositeOperation = 'source-in'; s6.fillStyle = TEXTURES['shallow-water'] ? worldPattern(s6, TEXTURES['shallow-water'], TEX_METRES['shallow-water']) : 'rgba(70,140,150,1)'; s6.fillRect(0, 0, W, H);
    w2.globalCompositeOperation = 'source-atop'; w2.globalAlpha = 0.95; w2.drawImage(sh, 0, 0); w2.globalAlpha = 1;
    if (!TEXTURES['river-current-painted']) { w2.save(); w2.globalCompositeOperation = 'screen'; w2.fillStyle = riverL.some((r) => r.cls === 'canal') ? 'rgba(20,46,60,1)' : 'rgba(26,74,70,1)'; w2.fillRect(0, 0, W, H); w2.restore(); w2.globalCompositeOperation = 'destination-in'; w2.drawImage(wm, 0, 0); w2.globalCompositeOperation = 'source-over'; }
    // lily pads on still town water, a few glints
    if (townish) {
      const g = 6 * kF;
      for (let i = Math.floor(BB[0] / g); i <= Math.floor(BB[2] / g); i++) for (let j = Math.floor(BB[1] / g); j <= Math.floor(BB[3] / g); j++) {
        if (hash(i, j, 631) > 0.07) continue;
        const mx = (i + hash(i, j, 633)) * g, my = (j + hash(i, j, 635)) * g;
        if (!waterIdx.at(mx, my) || [0, 1, 2, 3].every((a) => waterIdx.at(mx + Math.cos(a * 1.57) * 5 * kF, my + Math.sin(a * 1.57) * 5 * kF))) continue;
        const ln2 = hash(i, j, 637) < 0.6 ? 'lily-pads-small' : 'lily-pads-large', im = SPR[ln2]; if (!im) continue;
        const [x, y] = P([mx, my]), wl = (ln2 === 'lily-pads-small' ? 3 : 5) * 2.2 * ppm, hl = wl * im.height / im.width; drawS(w2, im, x - wl / 2, y - hl / 2, wl, hl);
      }
    }
    // ripples on running water, deeper tone in the middle of wide water
    if (SPR['river-ripple'] && !lite && !TEXTURES['river-current-painted']) for (const r of riverL) if (r.cls === 'river' || r.cls === 'canal') alongW(r.pts, 16 * kF, (x0, y0, ang) => { if (hash(Math.round(x0 / kF), Math.round(y0 / kF), 641) > 0.8 || !waterIdx.at(x0, y0)) return; const [x, y] = P([x0, y0]), im = SPR['river-ripple'], wr = 8 * 1.6 * ppm, hr = wr * im.height / im.width; w2.save(); w2.globalAlpha = 0.7; w2.translate(x, y); w2.rotate(-ang); drawS(w2, im, -wr / 2, -hr / 2, wr, hr); w2.restore(); }, 'rp');
    { const dc = up(softMask((x) => x.drawImage(rim, 0, 0), 6 * ppm)); w2.save(); w2.globalCompositeOperation = 'source-atop'; w2.globalAlpha = 1; const dm = off(W, H), dmc = dm.getContext('2d'); dmc.fillStyle = TEXTURES['river-current-painted'] ? 'rgba(8,40,60,0.16)' : 'rgba(8,60,70,0.22)'; dmc.fillRect(0, 0, W, H); dmc.globalCompositeOperation = 'destination-out'; dmc.drawImage(dc, 0, 0); w2.drawImage(dm, 0, 0); w2.restore(); }
    ctx.drawImage(wc, 0, 0);
    ctx.save(); ctx.globalCompositeOperation = 'source-over'; const ln = off(W, H), l5 = ln.getContext('2d'); l5.drawImage(rim, 0, 0); l5.globalCompositeOperation = 'destination-out'; for (let a = 0; a < 8; a++) l5.drawImage(rim, Math.cos(a * 0.785) * 0.9 * ppm, Math.sin(a * 0.785) * 0.9 * ppm); l5.globalCompositeOperation = 'source-in'; l5.fillStyle = 'rgba(40,50,40,0.55)'; l5.fillRect(0, 0, W, H); ctx.drawImage(ln, 0, 0); ctx.restore();
    T('water');
  }
  // 5. roads and paths: textured, with a defined, slightly irregular edge; cobbled through the villages
  if (!planOnly) {
    const segs = (c2, wf, extra) => { for (const L of drawnStreets) for (let i = 1; i < L.pts.length; i++) { const [ax, ay] = L.pts[i - 1], [bx, by] = L.pts[i]; const v = 0.86 + 0.28 * fbm((ax + bx) / (70 * kF), (ay + by) / (70 * kF), 891); c2.lineWidth = Math.max(1.5, L.w * ppm * v * wf + extra); const [x0, y0] = P(L.pts[i - 1]), [x1, y1] = P(L.pts[i]); c2.beginPath(); c2.moveTo(x0, y0); c2.lineTo(x1, y1); c2.stroke(); } };
    const rc = off(W, H), r2 = rc.getContext('2d'); r2.lineCap = 'round'; r2.lineJoin = 'round';
    r2.strokeStyle = 'rgba(126,94,48,0.22)'; segs(r2, 1, 2.2 * ppm);
    r2.strokeStyle = 'rgba(214,186,130,0.6)'; segs(r2, 1, 0.9 * ppm); // a pale worn verge, the edge stones of the painted finish
    r2.strokeStyle = TEXTURES['dirt-path'] ? worldPattern(r2, TEXTURES['dirt-path'], TEX_METRES['dirt-path']) : ROAD.fill; segs(r2, 1, 0);
    { r2.save(); r2.globalCompositeOperation = 'source-atop'; r2.fillStyle = 'rgba(238,210,150,0.32)'; r2.fillRect(0, 0, W, H); r2.restore(); } // a lighter sand, as in the paint-overs
    // cobbles through the village hearts: clip to each heart's round of streets
    if (TEXTURES['cobbled-road'] && hearts.some((h) => !h.piece)) {
      r2.save(); r2.beginPath(); for (const h of hearts) { if (h.piece) continue; const [px, py] = P([h.x, h.y]); r2.moveTo(px + h.R * 0.9 * sx, py); r2.arc(px, py, h.R * 0.9 * sx, 0, Math.PI * 2); } r2.clip();
      r2.strokeStyle = worldPattern(r2, TEXTURES['cobbled-road'], 8); segs(r2, 0.92, -0.4 * ppm);
      r2.globalCompositeOperation = 'source-atop'; r2.fillStyle = 'rgba(226,166,86,0.6)'; r2.fillRect(0, 0, W, H); r2.restore();
    }
    // a set piece has its own lanes: the real roads fade out under it ...
    for (const pc of pieces) { if (!/^(hamlet|village|town|walled|alpine|market|red-gable|canal|quay-workshops|farmstead|monastery|watermill|sawmill|vineyard-estate|fishing)/.test(pc.name)) continue; const [cx, cy] = P([pc.cx, pc.cy]), rx = pc.fw * 0.42 * ppm, ry = pc.fh * 0.4 * ppm; r2.save(); r2.globalCompositeOperation = 'destination-out'; r2.translate(cx, cy); r2.scale(1, ry / rx); const gr = r2.createRadialGradient(0, 0, rx * 0.55, 0, 0, rx); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); r2.fillStyle = gr; r2.beginPath(); r2.arc(0, 0, rx, 0, Math.PI * 2); r2.fill(); r2.restore(); }
    // ... and each of its entrances is joined to the nearest drawn road by a short lane
    { r2.save(); r2.lineCap = 'round'; r2.lineJoin = 'round';
      for (const pt of ports) { const [, sm] = streetNear(pt.x, pt.y, 90 * kF); if (!sm || Math.hypot(sm[0] - pt.x, sm[1] - pt.y) / kF > 85 || (pt.piece && Math.hypot(sm[0] - pt.piece.cx, sm[1] - pt.piece.cy) < Math.hypot(pt.x - pt.piece.cx, pt.y - pt.piece.cy) * 0.8)) continue; const [x0, y0] = P([pt.x, pt.y]), [x1, y1] = P([sm[0], sm[1]]); r2.strokeStyle = 'rgba(126,94,48,0.45)'; r2.lineWidth = (pt.main ? 5.2 : 4) * ppm; r2.beginPath(); r2.moveTo(x0, y0); r2.lineTo(x1, y1); r2.stroke(); r2.strokeStyle = TEXTURES['dirt-path'] ? worldPattern(r2, TEXTURES['dirt-path'], TEX_METRES['dirt-path']) : ROAD.fill; r2.lineWidth = (pt.main ? 4 : 3) * ppm; r2.stroke(); }
      r2.restore(); }
    ctx.drawImage(rc, 0, 0);
    // bridge decks from the real bridge geometry: a stone deck with parapets over the water
    for (const br of decks) {
      // the road carries on over the water between two stone parapets, with its shadow on the water
      const w0 = ((ROADW[br.c] || 4) + 1) * ppm;
      ctx.save(); ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(10,30,40,0.4)'; ctx.lineWidth = w0 + 3 * ppm; ctx.translate(0.8 * ppm, 2.2 * ppm); traceLines(ctx, [br.pts], P); ctx.stroke(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      traceLines(ctx, [br.pts], P);
      ctx.strokeStyle = '#7d6440'; ctx.lineWidth = w0 + 2.2 * ppm; ctx.stroke();
      ctx.strokeStyle = TEXTURES['cobbled-road'] ? worldPattern(ctx, TEXTURES['cobbled-road'], 6) : '#e6d2a6'; ctx.lineWidth = w0 + 1.4 * ppm; ctx.stroke();
      ctx.strokeStyle = 'rgba(240,222,180,0.55)'; ctx.stroke();
      ctx.strokeStyle = TEXTURES['dirt-path'] ? worldPattern(ctx, TEXTURES['dirt-path'], TEX_METRES['dirt-path']) : ROAD.fill; ctx.lineWidth = w0 - 0.4 * ppm; ctx.stroke();
      ctx.restore();
    }
    // the village squares: paving with a clear kerb on the village's own axis
    for (const h of hearts) {
      if (h.piece || !(h.x + h.R >= BB[0] && h.x - h.R <= BB[2] && h.y + h.R >= BB[1] && h.y - h.R <= BB[3])) continue;
      const ca = Math.cos(h.ang), sa = Math.sin(h.ang), rr = Math.min(h.pa, h.pb) * 0.35, pts = [];
      const corner = (cu, cv, a0) => { for (let k3 = 0; k3 <= 4; k3++) { const an = a0 + k3 / 4 * Math.PI / 2; pts.push([cu + Math.cos(an) * rr, cv + Math.sin(an) * rr]); } };
      corner(h.pa - rr, h.pb - rr, 0); corner(-h.pa + rr, h.pb - rr, Math.PI / 2); corner(-h.pa + rr, -h.pb + rr, Math.PI); corner(h.pa - rr, -h.pb + rr, Math.PI * 1.5);
      const cp = pts.map(([u, v]) => P([h.x + u * ca - v * sa, h.y + u * sa + v * ca]));
      const path = () => { ctx.beginPath(); cp.forEach(([x, y], i2) => (i2 ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
      ctx.save(); ctx.lineJoin = 'round';
      path(); ctx.strokeStyle = 'rgba(150,120,80,0.55)'; ctx.lineWidth = 1.6 * ppm; ctx.stroke();
      path(); ctx.fillStyle = TEXTURES['cobbled-square'] ? worldPattern(ctx, TEXTURES['cobbled-square'], 9, h.ang) : TEXTURES['paving-herringbone'] ? worldPattern(ctx, TEXTURES['paving-herringbone'], 16, h.ang) : TEXTURES['cobbled-square'] ? worldPattern(ctx, TEXTURES['cobbled-square'], 22) : '#cdb08a'; ctx.fill();
      // radial paving round the fountain: rings of dressed stone
      { const [cx, cy] = P([h.x, h.y - h.pb * 0.1]); ctx.save(); path(); ctx.clip(); for (const [rM, wM2] of [[Math.min(h.pa, h.pb) * 0.9 / kF, 2.4], [Math.min(h.pa, h.pb) * 0.55 / kF, 1.8]]) { ctx.beginPath(); ctx.ellipse(cx, cy, rM * ppm * 1.15, rM * ppm * 0.9, 0, 0, Math.PI * 2); ctx.strokeStyle = TEXTURES['paving-herringbone'] ? worldPattern(ctx, TEXTURES['paving-herringbone'], 7) : '#d8c098'; ctx.lineWidth = wM2 * 1.6 * ppm; ctx.stroke(); ctx.strokeStyle = 'rgba(110,84,50,0.45)'; ctx.lineWidth = 0.35 * ppm; ctx.stroke(); } ctx.restore(); }
      path(); ctx.strokeStyle = 'rgba(236,212,166,0.9)'; ctx.lineWidth = 0.8 * ppm; ctx.stroke();
      ctx.restore();
    }
    T('roads');
  }

  // ------------------------------------------------------------ outputs: the plan and the ground
  const houseNames = new Set(['thatched-cottage', 'timber-frame-house', 'stone-house', 'barn', 'long-house', 'tower-house', 'rowhouses-street', 'rowhouses-canal', 'house-limewash', 'house-stepped-gable', 'house-cross-gable', 'house-hipped-cottage', 'farmstead-yard']);
  const solid = (n) => !/deciduous|pine|forest|garden|haystack|rock|patch|sheep|cow|bush|fence|hedge|reeds|well|fountain|market|statue|tree|cypress|planter|banner|lantern|kerb|quay|riverbank|wall-|boat|foam|lily|decal|slope|bridge/.test(n);
  const plan = [];
  for (const o of objs) {
    const wx = wxOf(o.x), wy = wyOf(o.y); if (!inView(wx, wy)) continue;
    plan.push({ name: o.name, wx, wy, w: o.w / ppm, h: o.h / ppm, ax: o.ax, ay: o.ay, foot: o.foot, flip: o.flip, rot: o.rot, shadow: o.shadow, z: o.z, house: houseNames.has(o.name) || /-roof-|row-/.test(o.name), solid: !!o.box || /bridge/.test(o.name) || (solid(o.name) && !/^(forest|field-quilt|orchard-block|vineyard-block|paddock|mountain|bank|quay-soft)/.test(o.name)), ...(o.box ? { bw: o.box[0] * (o.name.includes('-ew') || o.name.includes('-ns') || o.name.includes('-ne-sw') || o.name.includes('-nw-se') ? 0.8 : 1), bh: o.box[1] * 0.9, bx: o.bcx, by: o.bcy } : {}) });
  }
  for (const h of hearts) if (!h.piece && inView(h.x, h.y)) plan.push({ name: 'plaza', wx: h.x, wy: h.y, w: 2 * h.pa / kF, h: 2 * h.pb / kF, ax: 0.5, ay: 0.5, foot: 1, flip: false, rot: 0, shadow: 0, z: 0, house: false, solid: true });
  const labels = [];
  const goodName = (n) => n && n.length >= 3 && !/^[A-Z0-9 .&-]+$/.test(n);
  // one label per heart, in clear meadow beside its piece: off every road, piece, filler and water
  const clearAt = (x, y, wM, hM) => { for (let u = -0.5; u <= 0.51; u += 0.25) for (let v = -0.5; v <= 0.51; v += 0.5) { const px = x + u * wM * kF, py = y + v * hM * kF; if (!onLand(px, py) || drawnNear(px, py) < 3 || pieces.some((pc) => Math.abs(px - pc.cx) < pc.fw * 0.5 * kF && Math.abs(py - pc.cy) < pc.fh * 0.5 * kF)) return false; } return true; };
  for (const h of hearts) {
    if (!goodName(h.name) || !inView(h.x, h.y)) continue;
    if (!h.piece) { labels.push({ name: h.name, wx: h.x, wy: h.y, big: true, pr: 3 }); continue; }
    const pc = h.piece, lw = Math.min(26, h.name.length) * 10.5 * Math.pow(2, 16 - zoom), lh = 22 * Math.pow(2, 16 - zoom);
    const cands = [[0, -(pc.fh / 2 + lh / 2 + 6)], [0, -(pc.fh / 2 + lh / 2 + 26)], [pc.fw / 2 + lw / 2 + 8, 0], [-(pc.fw / 2 + lw / 2 + 8), 0], [0, -(pc.fh / 2 + lh / 2 + 50)], [pc.fw / 2 + lw / 2 + 8, -pc.fh / 3], [-(pc.fw / 2 + lw / 2 + 8), -pc.fh / 3]];
    let at = null; for (const [dx, dy] of cands) { const x = pc.cx + dx * kF, y = pc.cy + dy * kF; if (clearAt(x, y, lw, lh)) { at = [x, y]; break; } }
    if (!at) at = [pc.cx + cands[0][0] * kF, pc.cy + cands[0][1] * kF];
    labels.push({ name: h.name, wx: at[0], wy: at[1], big: true, pr: 3, fixed: 1 });
  }
  for (const h of hearts) if (h.church && h.church.drawn && !h.nameIsAnchor && goodName(h.church.name) && inView(h.church.x, h.church.y)) labels.push({ name: shortName(h.church.name), wx: h.church.dx, wy: h.church.dy, big: false, pr: 2 });
  for (const s2 of special) if (s2.drawn && s2.label && goodName(s2.label) && inView(s2.x, s2.y)) labels.push({ name: shortName(s2.label), wx: s2.x, wy: s2.y, big: false, pr: 1 });
  // names along real canals, rivers and main roads: candidates on a fixed world grid along each line,
  // turned with it; the view keeps a few that fit fully on screen and off the buildings
  { const named = [...riverL.filter((r) => r.name && ['canal', 'river'].includes(r.cls)).map((r) => ({ name: r.name, pts: r.pts, water: 1 })),
      ...Q('transportation_name').filter((f) => ['primary', 'secondary', 'tertiary', 'trunk'].includes(f.properties.class) && (f.properties['name:latin'] || f.properties.name)).flatMap((f) => linesM(f).map((l) => ({ name: f.properties['name:latin'] || f.properties.name, pts: l, water: 0 })))];
    for (const n of named) alongW(n.pts, 90 * kF, (x, y, ang) => { if (!inView(x, y)) return; let deg = -ang * 180 / Math.PI; while (deg > 90) deg -= 180; while (deg < -90) deg += 180; labels.push({ name: shortName(n.name), wx: x, wy: y, big: false, line: 1, water: n.water, rot: deg, pr: n.water ? 0.6 : 0.4 }); }, 'nl' + n.name); }
  // for the acceptance checks: road ends that join nothing (not at another road, a piece or the window edge)
  const stubs = [];
  { const SG2 = 8 * kF, hs = new Map();
    drawnStreets.forEach((L, id) => { for (let i = 1; i < L.pts.length; i++) { const [ax, ay] = L.pts[i - 1], [bx, by] = L.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (4 * kF))); for (let m = 0; m <= n; m++) { const x = ax + (bx - ax) * m / n, y = ay + (by - ay) * m / n, k3 = Math.floor(x / SG2) + ',' + Math.floor(y / SG2); if (!hs.has(k3)) hs.set(k3, []); hs.get(k3).push([x, y, id]); } } });
    const joined = (p, id) => { const i0 = Math.floor(p[0] / SG2), j0 = Math.floor(p[1] / SG2); for (let a = -1; a <= 1; a++) for (let b2 = -1; b2 <= 1; b2++) for (const q of hs.get((i0 + a) + ',' + (j0 + b2)) || []) if (q[2] !== id && Math.hypot(q[0] - p[0], q[1] - p[1]) < 9 * kF) return true; return false; };
    const inPiece = (p) => pieces.some((pc) => Math.abs(p[0] - pc.cx) < pc.fw * 0.6 * kF && Math.abs(p[1] - pc.cy) < pc.fh * 0.6 * kF);
    const onWater = (p) => !onLand(p[0], p[1], 6 * kF);
    drawnStreets.forEach((L, id) => { for (const p of [L.pts[0], L.pts[L.pts.length - 1]]) if (inView(p[0], p[1]) && !joined(p, id) && !inPiece(p) && !onWater(p)) stubs.push([p[0], p[1], L.cls || (L.main ? 'main' : '?'), Math.round(lineLen(L.pts))]); }); }
  const heartsOut = hearts.map((h) => ({ name: h.name || '', x: h.piece ? h.piece.cx : h.x, y: h.piece ? h.piece.cy : h.y, fw: h.piece ? h.piece.fw : 0, fh: h.piece ? h.piece.fh : 0, t: h.t }));
  const heartInfo = hearts.filter((h) => inView(h.x, h.y)).map((h) => `${h.name || '?'} (tier ${h.t}, ${h.houses || 0} houses${h.anchor ? ', at ' + h.anchor.kind : ''})`);
  if (!planOnly) {
    // gentle relief where the real slope is steep (world-anchored, so chunks meet without seams)
    const s4 = 16, w = Math.ceil(W / s4) + 1, h = Math.ceil(H / s4) + 1;
    const rc = off(w, h), r4 = rc.getContext('2d'), img = r4.createImageData(w, h); const dd = 20 * kF; let any = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const mx = BB[0] + (x * s4) / sx, my = BB[3] - (y * s4) / sx;
      const gx = (dem(mx + dd, my) - dem(mx - dd, my)) / (2 * dd / kF), gy = (dem(mx, my + dd) - dem(mx, my - dd)) / (2 * dd / kF);
      const lit = Math.max(-1, Math.min(1, (gx - gy) * 0.7071 * 2.4)), o4 = (y * w + x) * 4;
      if (lit < 0) { img.data[o4] = 40; img.data[o4 + 1] = 40; img.data[o4 + 2] = 70; img.data[o4 + 3] = Math.max(0, -lit - 0.4) * 36; }
      else { img.data[o4] = 255; img.data[o4 + 1] = 230; img.data[o4 + 2] = 160; img.data[o4 + 3] = Math.max(0, lit - 0.3) * 34; }
      if (Math.abs(lit) > 0.25) any = true;
    }
    if (any) { r4.putImageData(img, 0, 0); ctx.save(); ctx.imageSmoothingEnabled = true; ctx.drawImage(rc, 0, 0, w * s4, h * s4); ctx.restore(); }
  }
  const roadsOut = drawnStreets.filter((L) => { const b = L.bb || (L.bb = bboxOf([L.pts])); return b[2] >= vx0 - 20 * kF && b[0] <= vx1 + 20 * kF && b[3] >= vy0 - 20 * kF && b[1] <= vy1 + 20 * kF; }).map((L) => L.pts.map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]));
  return { plan, labels, heartInfo, stubs, hearts: heartsOut, roads: roadsOut, chunk: [vx0, vy0, vx1, vy1], steads: steads.filter((s2) => inView(s2.x, s2.y)).length, ground: planOnly ? null : canvas, BB, W, H, ms: Math.round(performance.now() - t0), tm: tm.join(', '), roadDbg };
}
