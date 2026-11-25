// The fantasy map painter (the approved "village heart" look). Paints the walking-zoom world onto 2D
// canvases: the ground of a region (meadow, fields, water, roads, cobbles, painted in code through
// seamless textures) and the plan of a z16 tile (every object a painted sprite, anchored in that tile).
//
// Purity: every decision is a function of the real world (fmworld.js) or of the tile whose plan it is,
// never of the view or of which window asked. The ground of any region is the same, pixel for pixel,
// as the same world pixels painted as part of any other region: grids, textures and masks are anchored
// to the world pixel lattice, and every decision that crosses a tile edge (hearts, compounds, roads,
// bridges, water style) is made once by the world plan.
//
// Nothing is random: every object comes from real data at that spot and every choice among variants is a
// hash of world coordinates.
import { hash, fbm, demSampler, toM, KF, H01, inPoly, ringArea, polysM, linesM, lineLen, obb, bboxOf } from './fmcore.js';
import * as WD from './fmworld.js';
import { features } from './tiledata.js';

// ---------------------------------------------------------------- painted sprites
const SPR = {}; let SPRIDX = {};
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
  WD.setAtlas(SPRIDX, (n) => !!SPR[n]); // the world plan picks set pieces from what the atlas holds
});
// seamless ground textures (concept/textures via tools/sprites5.py), used when present
const TEXTURES = {};
const TEX_METRES = { 'meadow-soft': 32, 'meadow-sunlit': 32, 'meadow-cool': 32, 'wildflower-meadow': 36, pasture: 36, 'wheat-field': 24, 'ploughed-earth': 20, 'vegetable-rows': 18, 'forest-floor': 28, 'cobbled-square': 12, 'dirt-path': 16, 'river-water': 32, 'lake-water': 40, 'shallow-water': 24, sand: 25, rock: 26, snow: 32, scree: 26, 'cobbled-road': 12, 'river-current-painted': 68, 'canal-reflection-painted': 52, 'canal-sun-sweeps': 55, 'river-bright-current': 67, 'meadow-sunlit-gold': 83, 'meadow-sunlit-clover': 89, 'meadow-sunlit-lowland': 86, 'meadow-swales': 70, 'meadow-dry-patches': 68, 'meadow-deep-green': 70, 'paving-herringbone': 16 };
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



// fallback colours (used only if a texture is missing)
const WATER = { edge: '#2f7895' };
const ROAD = { fill: '#efbf6c' };

// ---------------------------------------------------------------- canvas helpers
// ---------------------------------------------------------------- canvas helpers
function off(W, H) { if (typeof document === 'undefined') return new OffscreenCanvas(Math.max(1, W), Math.max(1, H)); const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }
// Fill each polygon on its own: neighbouring tiles deliver overlapping pieces of one polygon
// (the tile buffer), and an even-odd fill over all of them would cancel the overlaps into gaps.
function fillPolys(ctx, polys, P) {
  for (const p of polys) { ctx.beginPath(); for (const r of p) r.forEach((v, i) => { const [x, y] = P(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.fill('evenodd'); }
}
function traceLines(ctx, lines, P) {
  ctx.beginPath();
  for (const l of lines) l.forEach((v, i) => { const [x, y] = P(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
}

/** Draw a sprite (a rectangle of the shared sheet) or any image. */
const drawS = (c, im, dx, dy, dw, dh) => (im.sheet ? c.drawImage(im.sheet, im.sx, im.sy, im.width, im.height, dx, dy, dw, dh) : c.drawImage(im, dx, dy, dw, dh));
export { SPR, SPRIDX, ASSETS, spritesReady, texturesReady, assetsReady, off, drawS };
const SETTLEMENT = WD.SET_PIECE;
/**
 * Paint a region, or plan a tile. opts: { chunk: [x0,y0,x1,y1] mercator (on the world pixel lattice),
 * margin (mercator), band (zoom band), ppm (canvas px per map metre), planOnly, plans }.
 * - planOnly: the tile's object plan (sprites anchored inside `chunk`), its labels and debug output.
 * - otherwise: the painted ground of chunk + margin; `plans` are the plans of the tiles round it
 *   (their pieces get a soft wash, their houses flowers, and the ground decals keep off them).
 * Data tiles must be loaded (call through tiledata.withData, which loads what is missing and retries).
 */
export async function paintRegion(opts) {
  await Promise.all([spritesReady, texturesReady, assetsReady]);
  const t0 = performance.now();
  const planOnly = !!opts.planOnly;
  const zoom = opts.band;
  const BC = opts.chunk, M = opts.margin;
  const BB = [BC[0] - M, BC[1] - M, BC[2] + M, BC[3] + M];
  const [vx0, vy0, vx1, vy1] = BC;
  const kF = KF, k = KF;
  const ppm = opts.ppm, sx = ppm / kF;
  const W = Math.round((BB[2] - BB[0]) * sx), H = Math.round((BB[3] - BB[1]) * sx);
  // the canvas origin on the world pixel lattice (x right, y down from mercator 0)
  const GX = Math.round(BB[0] * sx), GY = Math.round(-BB[3] * sx);
  // world → canvas, snapped to 1/64 px of the world lattice: the same world point gets the same sub-pixel
  // position in every region, so every edge rasterises the same way
  const P = (v) => [Math.round(v[0] * sx * 64) / 64 - GX, Math.round(-v[1] * sx * 64) / 64 - GY];
  const q64 = (v) => Math.round(v * 64) / 64; // canvas offsets and sizes on the same 1/64 px grid
  const wxOf = (x) => BB[0] + x / sx, wyOf = (y) => BB[3] - y / sx;
  const inView = (x, y) => x >= vx0 && x < vx1 && y >= vy0 && y < vy1; // inside this chunk
  const inCanvas = (x, y) => x >= BB[0] && x <= BB[2] && y >= BB[1] && y <= BB[3];
  const tm = []; let tl = performance.now();
  const T = (l) => { const n = performance.now(); tm.push(`${l} ${Math.round(n - tl)}`); tl = n; };
  /** A texture repeated on the world lattice: the same texel lands on the same world pixel in every region.
   *  The repeat is a whole number of pixels, so every region's pattern origin is a whole pixel away from every
   *  other's; a turned texture is anchored at a world point of the thing it fills (`at`). */
  const worldPattern = (c2, tile, metres, rot = 0, at = null) => {
    const pat = c2.createPattern(tile, 'repeat'), per = Math.max(1, Math.round(metres * ppm)), s = per / tile.width;
    let tx, ty;
    if (rot) { const [ax, ay] = at || [0, 0]; tx = Math.round(ax * sx) - GX; ty = Math.round(-ay * sx) - GY; }
    else { tx = Math.round(GX / per) * per - GX; ty = Math.round(GY / per) * per - GY; }
    pat.setTransform(new DOMMatrix().translate(tx, ty).rotate(rot * 180 / Math.PI).scale(s));
    return pat;
  };

  // ------------------------------------------------------------ the real data over the region (for drawing)
  const Q = (layer, bb) => features(layer, bb || BB);
  const QB = [BB[0] - 120, BB[1] - 120, BB[2] + 120, BB[3] + 120]; // + the data tiles' clip buffer: every piece over the region
  const woodP = [], parkP = [], farmP = [], wetP = [], sandP = [], rockP = [], waterP = [], orchItems = [], cemItems = [];
  const ovl = (bb) => !(bb[2] < BB[0] || bb[0] > BB[2] || bb[3] < BB[1] || bb[1] > BB[3]);
  for (const f of Q('landcover', QB)) for (const m of polysM(f)) {
    const bb = bboxOf(m); if (!ovl(bb)) continue;
    const c = f.properties.class, s = f.properties.subclass;
    if (c === 'wood') woodP.push(m);
    else if (c === 'farmland' && s !== 'orchard' && s !== 'vineyard') farmP.push(m);
    else if (s === 'orchard' || s === 'vineyard') orchItems.push({ rings: m, props: f.properties, bb });
    else if (c === 'grass' && ['park', 'garden', 'recreation_ground', 'village_green'].includes(s)) parkP.push(m);
    else if (c === 'wetland') wetP.push(m);
    else if (c === 'sand') sandP.push(m);
    else if (c === 'rock') rockP.push(m);
  }
  for (const f of Q('park', QB)) { if (!['park', 'garden'].includes(f.properties.class)) continue; for (const m of polysM(f)) if (ovl(bboxOf(m))) parkP.push(m); }
  for (const f of Q('landuse', QB)) for (const m of polysM(f)) { const bb = bboxOf(m); if (ovl(bb) && f.properties.class === 'cemetery') cemItems.push({ rings: m, props: f.properties, bb }); }
  for (const f of Q('water', QB)) {
    if (f.properties.brunnel === 'tunnel') continue;
    for (const m of polysM(f)) if (ovl(bboxOf(m)) && WD.waterKeeps(m, f.properties.class)) { m.still = ['lake', 'pond', 'reservoir', 'basin', 'swimming_pool'].includes(f.properties.class) || !!f.properties.intermittent; m.river = f.properties.class === 'river'; waterP.push(m); }
  }
  const riverL = WD.waterwaysIn(BB);
  T('g-land');
  // roads: the street pieces over a window 250 m wider than the region, and which of them the world plan draws
  const BBX = [BB[0] - 250 * kF, BB[1] - 250 * kF, BB[2] + 250 * kF, BB[3] + 250 * kF];
  const ROADW = WD.ROADW;
  const asStreet = (L) => ({ pts: L.pts, w: ROADW[L.cls] || 10, main: L.main, cls: L.cls, key: L.key });
  const streets = WD.streetsIn(BBX).map(asStreet);
  const drawnStreets = WD.drawnIn(BBX).map(asStreet), drawnKeys = new Set(drawnStreets.map((L) => L.key));
  for (const L of WD.endLinksIn(BBX)) drawnStreets.push(asStreet(L)); // (a road led on to a set piece's entrance)
  const decks = WD.decksIn(BBX);
  const trailL = [];
  for (const f of Q('transportation', BBX)) if (['path', 'track'].includes(f.properties.class) && f.properties.brunnel !== 'tunnel') for (const l of linesM(f)) trailL.push(l);
  const trailHash = new Set();
  for (const l of trailL) for (let i = 1; i < l.length; i++) { const [ax, ay] = l[i - 1], [bx, by] = l[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (4 * kF))); for (let m = 0; m <= n; m++) trailHash.add(Math.floor((ax + (bx - ax) * m / n) / (8 * kF)) + ',' + Math.floor((ay + (by - ay) * m / n) / (8 * kF))); }
  const nearTrail = (x, y) => { const i = Math.floor(x / (8 * kF)), j = Math.floor(y / (8 * kF)); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (trailHash.has((i + a) + ',' + (j + b))) return true; return false; };
  T('g-roads');
  const dem = await demSampler([BB[0] - 260 * kF, BB[1] - 260 * kF, BB[2] + 260 * kF, BB[3] + 260 * kF], 14);
  T('gather');

  // ------------------------------------------------------------ the world plan round the region
  // village hearts, farmstead compounds and lone abbeys come from the world plan (fmworld.js): the same for
  // every tile that can see them
  const hearts = WD.heartsIn(BB, 700 * kF);
  const compoundsW = WD.compoundsIn(BB, 300 * kF);
  const abbeysW = WD.abbeysIn([BB[0] - 200 * kF, BB[1] - 200 * kF, BB[2] + 200 * kF, BB[3] + 200 * kF]);
  const canon = WD.canonPieces(BB);
  const nearestHeart = WD.nearestHeart;
  T('compose');

  // ------------------------------------------------------------ world indexes (pure: world coordinates only)
  const canvas = off(planOnly ? 1 : W, planOnly ? 1 : H);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.globalAlpha = 1;
  const smooth = (a, b, v) => Math.max(0, Math.min(1, (v - a) / (b - a)));
  let floor = 600; // a fixed valley base (a chunk's own lowest point made seams between chunks)
  // point queries of the world (fmworld.js): water, buildings, streets, city cores
  const streetNear = WD.streetNear, localStats = WD.localStats, onLand = WD.onLand, coreAt = WD.coreAt;
  const inPlaza = (h, x, y, pad = 0) => { const c = Math.cos(h.ang), s = Math.sin(h.ang), dx = x - h.x, dy = y - h.y, u = dx * c + dy * s, v = -dx * s + dy * c; return Math.abs(u) < h.pa + pad && Math.abs(v) < h.pb + pad; };
  T('index');

  // ------------------------------------------------------------ objects: every one a painted sprite
  // (only when planning a tile; the ground reads the finished plans of the tiles round it)
  const objs = [], pieces = [], ports = [], special = [], lots = [], fields = [], paddocks = [];
  const ALP = WD.alpineAt((BC[0] + BC[2]) / 2, (BC[1] + BC[3]) / 2);
  const canalAt = WD.canalAt, drawnNear = WD.drawnNear;
  const SYM = 1.15; // the targets draw everything over life size
  const zs = Math.pow(2, (16 - zoom) * 0.35);
  const sizeOf = (name) => (SIZE[name] || 30) * ppm * zs * SYM;
  const deckHash = new Set();
  for (const br of decks) { const a = br.pts[0], b2 = br.pts[br.pts.length - 1]; for (let m = 0; m <= 20; m++) { const x = a[0] + (b2[0] - a[0]) * m / 20, y = a[1] + (b2[1] - a[1]) * m / 20; deckHash.add(Math.floor(x / (8 * kF)) + ',' + Math.floor(y / (8 * kF))); } }
  const nearDeck = (x, y) => { const i = Math.floor(x / (8 * kF)), j = Math.floor(y / (8 * kF)); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (deckHash.has((i + a) + ',' + (j + b))) return true; return false; };
  if (planOnly) {
  const TREE = SPR['forest-deciduous-round'] ? 'forest-deciduous-round' : 'forest-clump';
  const repCount = new Map(), RC = WD.RC, NOCAP = /-(ew|ns|ne-sw|nw-se)$|^decals|^lily|^river-|^rocky-bank|^gravel-bar|^banner|^lantern|^kerb|^quay|^rowing|^churchyard|^castle|^market-stall|fountain|^well$|^reeds$|^haystack$/;
  const kindOf = (n) => n.replace(/-(40|80|160)-(ew|ns|ne-sw|nw-se)$/, '');
  // a pure world rule: each kind may stand only in about a third of the 160 m world cells (chosen by a hash of
  // kind and cell), once per cell, so any one drawing appears about three times per phone screen at most
  const kindSeed = (k3) => { let h9 = 7; for (let i = 0; i < k3.length; i++) h9 = (h9 * 31 + k3.charCodeAt(i)) % 9973; return 4000 + h9; };
  const capped = (name, x, y) => { if ((NOCAP.test(name) && !/-(40|80|160)-/.test(name)) || (SPRIDX[name] && SPRIDX[name].set)) return false; const k3 = kindOf(name), i0 = Math.floor(x / RC), j0 = Math.floor(y / RC); if (hash(i0, j0, kindSeed(k3)) > (/-(40|80|160)-/.test(name) ? 0.36 : 0.3)) return true; return (repCount.get(k3 + '|' + i0 + ',' + j0) || 0) >= 1; };
  const counted = (name, x, y) => { const key = kindOf(name) + '|' + Math.floor(x / RC) + ',' + Math.floor(y / RC); repCount.set(key, (repCount.get(key) || 0) + 1); };
  const put = (name, x, y, o = {}) => {
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
  const putW = (name, mx, my, o = {}) => { if (capped(name, mx, my)) return null; const [x, y] = P([mx, my]); const ob = put(name, x, y, o); if (ob) { ob.wx = mx; ob.wy = my; counted(name, mx, my); } return ob; };
  // a sprite's footprint must stay on dry land
  const footDry = WD.footDry;

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

  // ---- round 7: code places, it does not compose. One stand-in per village heart (until the painted
  //      set pieces arrive), farmstead compounds between them, scenery on real land use.
  // the castle (UI Assets) only where a real palace or castle stands, in a big heart (the world plan finds it)
  for (const h of hearts) if (h.castle) special.push({ h, ...h.castle });
  for (const s3 of special) if (inCanvas(s3.x, s3.y) && SPR[s3.name] && footDry(s3.x, s3.y, 18 * kF) && !hitW(s3.x, s3.y, 18 * kF)) { putW(s3.name, s3.x, s3.y, { w: 62 * ppm * zs, ay: 0.84 }); takeW(s3.x, s3.y, 26 * kF); s3.drawn = true; }
  // real churches: the type by name, region and how built-up the place is
  const abbey = WD.abbeyName;
  const churchSprite = (c) => {
    const n = c.name;
    if (abbey(n) && SPR.monastery) return 'monastery';
    if (/cathedral|\bdom\b|basilica|münster|kathedrale|minster|st\.? patrick/i.test(n) && SPR.cathedral) return 'cathedral';
    if (/chapel|kapelle|kapel\b/i.test(n)) return SPR['church-parish'] ? 'church-parish' : 'chapel';
    if (ALP && SPR['church-baroque-onion']) return 'church-baroque-onion';
    if (localStats(c.x, c.y, 120 * kF).cover > 0.16 && SPR['church-tall-spire']) return 'church-tall-spire';
    return SPR['church-parish'] ? 'church-parish' : 'chapel';
  };
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
  const spImgM = (n) => SPRIDX[n].foot_m[0] * 1.12; // the image spans about 1.12 x the east-west footprint
  const pickOf = (list, x, y, seed) => { const l = list.filter((n) => SPR[n] && SPRIDX[n]); return l.length ? l[Math.floor(H01(x, y, seed) * l.length)] : null; };
  /** Put a set piece with its anchor on (x, y); returns the piece or null. */
  const placePiece = (name, x, y, o = {}) => {
    const m = SPRIDX[name]; if (!m || !SPR[name]) return null;
    if (o.unique && pieces.some((p2) => p2.name === name && Math.hypot(p2.x - x, p2.y - y) < 200 * kF)) return null;
    const wM = (o.wM || spImgM(name) * (o.k || 1)), hM = wM * m.h / m.w, flip = !!o.flip, kk = wM / spImgM(name);
    const pc = { name, x, y, wM, hM, flip, m, fw: m.foot_m[0] * kk, fh: m.foot_m[1] * kk };
    // the ground footprint centre, from the anchor's place in the image
    pc.cx = x + ((flip ? -1 : 1) * (0.5 - m.ax)) * wM * kF; pc.cy = y - (0.5 - m.ay) * hM * kF * 0.9;
    if (!o.canon && capped(name, x, y)) return null; // (the world plan's pieces are already decided)
    if (inCanvas(x, y) || inCanvas(pc.cx, pc.cy)) { const ob = putW(name, x, y, { w: wM * ppm, ax: m.ax, ay: m.ay, flip, shadow: 0, z: o.z ?? -0.5 }); if (ob) { ob.box = [pc.fw, pc.fh]; ob.bcx = pc.cx; ob.bcy = pc.cy; ob.pc = { cx: pc.cx, cy: pc.cy, fw: pc.fw, fh: pc.fh, filler: false }; } }
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
  // A. the world plan's set pieces: hearts, farmstead compounds (with their quilts) and lone abbeys; the
  //    hearts' name spots stay clear of everything else
  for (const h of hearts) { const L = WD.heartLabel(h.I, h.J, zoom); if (L && h.piece) { const lw = Math.min(26, L.name.length) * 10.5 * Math.pow(2, 16 - zoom) * kF, lh = 22 * Math.pow(2, 16 - zoom) * kF; for (let u = -0.5; u <= 0.51; u += 0.1) for (let v = -0.5; v <= 0.51; v += 0.25) takeW(L.wx + u * lw, L.wy + v * lh, OC); } }
  for (const h of hearts) if (h.piece) { const pc = h.piece; placePiece(pc.name, pc.x, pc.y, { flip: pc.flip, wM: pc.wM, canon: true }); }
  for (const c of compoundsW) for (const pc of c.pieces) placePiece(pc.name, pc.x, pc.y, { flip: pc.flip, wM: pc.wM, z: pc.z, canon: true });
  for (const a of abbeysW) { if (a.piece) placePiece(a.piece.name, a.piece.x, a.piece.y, { wM: a.piece.wM, canon: true }); else if (inCanvas(a.church.x, a.church.y)) placeChurch({ ...a.church, sprite: churchSprite(a.church) }); }
  // round each heart: paddocks, field quilts, orchards and tree clumps on its open ground, as in the targets
  for (const h of hearts) {
    const pc = h.piece; if (!pc || !(h.x + 500 * kF >= BB[0] && h.x - 500 * kF <= BB[2] && h.y + 500 * kF >= BB[1] && h.y - 500 * kF <= BB[3])) continue;
    let n = 0; const want = 3 + Math.floor(H01(h.x0, h.y0, 3171) * 3);
    for (let k3 = 0; k3 < 24 && n < want; k3++) {
      const a = (k3 * 2.39996 + H01(h.x0, h.y0, 3173) * 6.283), r = (pc.fw * 0.5 + 55 + (k3 % 4) * 38) * kF, x = pc.cx + Math.cos(a) * r, y = pc.cy + Math.sin(a) * r * 0.9;
      const kind = H01(x, y, 3175), n2 = kind < 0.3 ? pickOf(['paddock-sheep-shelter', 'paddock-cattle-shelter'].filter((n9) => !pieces.some((p2) => p2.name === n9 && Math.hypot(p2.x - x, p2.y - y) < 600 * kF)), x, y, 3177) : kind < 0.55 ? pickOf(['field-quilt-ribbon', 'field-quilt-kite', 'field-quilt-step', 'field-quilt-hook'], x, y, 3179) : kind < 0.75 ? pickOf(['orchard-block-rows', 'orchard-block-bloom'], x, y, 3181) : null;
      const rr = (n2 ? SPRIDX[n2].foot_m[0] * 0.5 : 18) * kF;
      if (!onLand(x, y, rr) || hitW(x, y, rr * 0.9) || WD.woodAt(x, y) || streetNear(x, y)[0] < rr / kF * 0.45) continue;
      if (n2) { if (placePiece(n2, x, y, { z: -0.6, flip: kind < 0.5 === (H01(x, y, 3183) < 0.5), k: 1.15, unique: true })) n++; continue; }
      paintedClump(x, y, 3 + (k3 % 3) * 2, 3187); n++; continue;
      for (let t = 0; t < 4; t++) { const tx = x + Math.cos(t * 2.3) * (t ? 9 : 0) * kF, ty = y + Math.sin(t * 2.3) * (t ? 7 : 0) * kF; if (inCanvas(tx, ty) && onLand(tx, ty, 4 * kF)) putW(['round-tree-beech', TREE, 'round-tree-young-oak', 'round-tree-elm'][(t + k3) % 4], tx, ty, { s: 1 + H01(tx, ty, 3185) * 0.3, shadow: 0.9, flip: t % 2 === 1 }); }
      takeW(x, y, 20 * kF); n++;
    }
  }
  T('o-hearts');
  // C. scenery on real land use, until the painted pieces arrive
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
      { let bad = null; for (const [px, py] of pts) { if (!onLand(px, py)) { bad = 'land'; break; } if (hitW(px, py, 3 * kF)) { bad = 'hit'; break; } if (drawnNear(px, py) <= 3) { bad = 'road'; break; } if (WD.woodAt(px, py)) { bad = 'wood'; break; } } if (bad) { fstat[bad]++; continue; } }
      const ob = putW(name, x, y, { w: m.img_m * ppm, ax: m.ax, ay: m.ay, rot: -res, shadow: 0, z: -0.65 });
      if (!ob) continue; // that kind is used up here
      if (ob) { const ex = (Math.abs(L * ux) + Math.abs(W2 * uy)) * 0.8, ey = (Math.abs(L * uy) + Math.abs(W2 * ux)) * 0.8; ob.box = [ex, ey]; ob.bcx = x; ob.bcy = y; ob.pc = { cx: x, cy: y, fw: Math.abs(L * ux) + Math.abs(W2 * uy), fh: Math.abs(L * uy) + Math.abs(W2 * ux), filler: true }; }
      for (let u = -0.45; u <= 0.451; u += 0.075) for (let v = -0.42; v <= 0.421; v += 0.21) takeW(x + (u * L * ux - v * W2 * uy) * kF, y + (u * L * uy + v * W2 * ux) * kF, OC * 0.5);
      pieces.push({ name, x, y, cx: x, cy: y, fw: Math.abs(L * ux) + Math.abs(W2 * uy), fh: Math.abs(L * uy) + Math.abs(W2 * ux), filler: true });
      fstat.ok++; return true;
    }
    fstat.none++; return false;
  };
  const FILLK = { field: ['hedged-wheat', 'hay-meadow', 'flax-strip', 'ploughed-strip'], garden: ['kitchen-garden', 'vegetable-allotments', 'beehive-garden', 'pond-common', 'bowling-green', 'bleaching-field'], orchard: ['orchard-rows', 'vineyard-rows'], pasture: ['sheep-pasture', 'cow-pasture', 'horse-paddock', 'hay-meadow'], grave: ['yew-graveyard'], wet: ['reed-osiers'] };
  const clump = (x, y, n, seed) => paintedClump(x, y, n, seed);
  // C1b. parcels line the real streets: block fillers side by side along each street, up to two rows deep,
  //      their kind from what is there (gardens, orchards and pastures near a heart; fields further out)
  for (const L of streets) {
    alongW(L.pts, 94 * kF, (mx, my, ang, nx, ny) => {
      if (!(mx > BB[0] - 100 * kF && mx < BB[2] + 100 * kF && my > BB[1] - 100 * kF && my < BB[3] + 100 * kF)) return;
      for (const sd of [1, -1]) {
        if (H01(mx + sd * 7, my, 3301) < 0.14) continue; // a stretch of open meadow, by choice
        const hidden = !drawnKeys.has(L.key);
        for (const row of [0, 1, 2]) {
          const off = (L.w / 2 + (hidden ? 3 : 9) + 19.5 + row * 40) * kF, x = mx + nx * off * sd, y = my + ny * off * sd;
          const [h0, dh] = nearestHeart(x, y); if (h0 && dh < 1.25) break;
          if (WD.woodAt(x, y) || WD.parkAt(x, y) || WD.cemeteryAt(x, y)) break;
          const r = H01(x, y, 3303), near = h0 && dh < 3.5;
          const cat = WD.orchardAt(x, y) ? 'orchard' : near ? (r < 0.4 ? 'garden' : r < 0.65 ? 'orchard' : r < 0.85 ? 'pasture' : 'field') : (r < 0.6 ? 'field' : r < 0.8 ? 'pasture' : 'orchard');
          if (!placeFiller(FILLK[cat], x, y, ang, 3305, hidden ? [160, 80, 40] : [80, 40]) && !placeFiller([...FILLK.field, ...FILLK.pasture, ...FILLK.garden, ...FILLK.orchard], x, y, ang, 3307, [80, 40])) break;
        }
      }
    }, 'pr');
  }
  // C1c. the surviving roads get their edges: tree avenues in town and near the hearts, hedgerows with
  //      standard trees in the country (painted 80 m runs in four directions, with gaps)
  if (SPR['tree-avenue-ew']) for (const L of drawnStreets) {
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
      const city = coreAt(mx, my), canalSide = canalAt(mx, my) && !onLand(mx, my, 22 * kF);
      if (!canalSide && (city || !L.main)) return;
      if (fbm(mx / (110 * kF), my / (110 * kF), 1701) < (canalSide ? 0.56 : 0.6)) return;
      for (const sd of [1, -1]) {
        if (H01(mx + sd, my, 1709) < 0.45) continue;
        const x = mx + nx * (L.w / 2 + 5) * kF * sd, y = my + ny * (L.w / 2 + 5) * kF * sd;
        if (!onLand(x, y, 4 * kF) || WD.woodAt(x, y) || WD.parkAt(x, y) || !freeW(x, y, 7 * kF, 2.5 * kF)) continue;
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
      if (!onLand(mx, my, 10 * kF) || WD.woodAt(mx, my) || WD.parkAt(mx, my) || WD.cemeteryAt(mx, my) || streetNear(mx, my)[0] < 10) continue;
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
      if (hash(i, j, 3201) < 0.17) continue; // open meadow, chosen
      if (!onLand(mx, my, 22 * kF) || hitW(mx, my, 24 * kF) || WD.woodAt(mx, my) || drawnNear(mx, my) < 14) continue;
      const [h0, dh] = nearestHeart(mx, my), near = h0 && dh < 3.5, r = hash(i, j, 3207);
      let cat;
      if (WD.cemeteryAt(mx, my)) cat = 'grave';
      else if (WD.parkAt(mx, my)) cat = null;
      else if (WD.orchardAt(mx, my)) cat = WD.orchardAt(mx, my).props?.subclass === 'vineyard' ? 'vine' : 'orchard';
      else if (WD.farmAt(mx, my)) cat = r < 0.75 ? 'field' : 'pasture';
      else if (near) cat = r < 0.4 ? 'garden' : r < 0.65 ? 'pasture' : r < 0.8 ? 'orchard' : null;
      else cat = r < 0.45 ? 'field' : r < 0.75 ? 'pasture' : r < 0.85 ? 'orchard' : null;
      if (cat && FILLK[cat]) { const [, sm] = streetNear(mx, my, 90 * kF); const ang = sm ? sm[3] : 0; if (placeFiller(FILLK[cat], mx, my, ang, 3221) || placeFiller(cat === 'garden' || cat === 'orchard' ? FILLK.field : cat === 'pasture' ? FILLK.field : FILLK.garden, mx, my, ang, 3223)) continue; }
      const n2 = cat ? fillPick(cat, mx, my, 3209) : null;
      if (n2 && placePiece(n2, mx, my, { z: -0.6, wM: Math.min(SPRIDX[n2].foot_m[0] * 1.12, 88), flip: hash(i, j, 3215) < 0.5, unique: !n2.startsWith('filler-') })) continue;
      clump(mx, my, 3 + Math.floor(hash(i, j, 3217) * 3), 3219);
    }
  }
  // C3. painted scenery on real land use (set four): orchard and vineyard blocks, forest masses on real
  //     woods (single trees only fill what is left), field quilts on real farmland
  for (const it of orchItems) {
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
      if (!WD.woodAt(mx, my) || [[-35, 0], [35, 0], [0, -25], [0, 25]].filter(([a, b2]) => WD.woodAt(mx + a * kF, my + b2 * kF)).length < 3) continue;
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
      if (!WD.farmAt(mx, my) || [[-40, 0], [40, 0], [0, -30], [0, 30]].filter(([a, b2]) => WD.farmAt(mx + a * kF, my + b2 * kF)).length < 3) continue;
      if (hitW(mx, my, 32 * kF) || streetNear(mx, my)[0] < 18) continue;
      const n2 = pickOf(['field-quilt-ribbon', 'field-quilt-kite', 'field-quilt-step', 'field-quilt-hook'], mx, my, 3165); if (n2) placePiece(n2, mx, my, { z: -0.6, flip: hash(i, j, 3167) < 0.5, k: 1.3 });
    }
  }
  T('o-land'); tm.push(`fill ${JSON.stringify(fstat)}`);
  // D. woods: forest masses on a jittered grid, conifers higher up, single trees at the edges
  {
    const g = 32 * kF;
    for (let i = Math.floor(BB[0] / g); i <= Math.floor(BB[2] / g); i++) for (let j = Math.floor(BB[1] / g); j <= Math.floor(BB[3] / g); j++) {
      const mx = (i + 0.2 + hash(i, j, 1101) * 0.6) * g, my = (j + 0.2 + hash(i, j, 1103) * 0.6) * g;
      if (!WD.woodAt(mx, my) || !onLand(mx, my, 8 * kF) || nearTrail(mx, my) || hitW(mx, my, 10 * kF)) continue;
      { const d5 = 15 * kF, sl5 = Math.hypot(dem(mx + d5, my) - dem(mx - d5, my), dem(mx, my + d5) - dem(mx, my - d5)) / (2 * d5 / kF); if (sl5 > 0.62) continue; }
      const rel = dem(mx, my) - floor, edge = [0, 1, 2, 3].some((a) => !WD.woodAt(mx + Math.cos(a * 1.57) * 16 * kF, my + Math.sin(a * 1.57) * 16 * kF));
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
      if (!WD.parkAt(mx, my) || WD.woodAt(mx, my) || !onLand(mx, my, 6 * kF) || fbm(mx / (70 * kF), my / (70 * kF), 1125) < 0.4 || !freeW(mx, my, 8 * kF)) continue;
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
        if (rel > 250 && sl < 0.38 && !WD.woodAt(mx, my) && hash(i, j, 1223) < 0.07 && SPR['alpine-hut']) { putW('alpine-hut', mx, my, { flip: hash(i, j, 1225) < 0.5 }); takeW(mx, my, 16 * kF); continue; }
        if (SPR['pine-group-small'] && placePiece(pickOf(dem(mx, my) > 1100 ? ['larch-group-small', 'larch-group-large', 'pine-group-large'] : ['pine-group-small', 'pine-group-large', 'larch-group-small'], mx, my, 1239), mx, my, { z: -0.2, k: 1.15, flip: hash(i, j, 1215) < 0.5 })) continue;
        { const pp = ['forest-pine-small', 'pine-tall', 'forest-pine-large', 'pine-tall'][Math.floor(hash(i, j, 1227) * 4)]; putW(SPR[pp] ? pp : 'pine-tall', mx, my, { flip: hash(i, j, 1215) < 0.5, s: 0.8 + hash(i, j, 1211) * 0.35, shadow: 0.6 }); if (pp === 'pine-tall' && hash(i, j, 1229) < 0.6) putW('pine-tall', mx + 7 * kF, my - 4 * kF, { s: 0.75, shadow: 0.6, flip: true }); }
        if (hash(i, j, 1217) < 0.35) putW(SPR['slope-boulder-pair'] ? 'slope-boulder-pair' : 'rock-mossy', mx + 2 * kF, my - 12 * kF, { s: 0.7 });
        takeW(mx, my, 14 * kF); continue;
      }
      if (dem(mx, my) > 2000 && SPR['mountain-snow-ridge']) { placePiece('mountain-snow-ridge', mx, my, { z: -0.3 }); continue; }
      if (sl > 0.7 && SPR['crag-large']) { const cn = pickOf(sl > 0.95 ? ['crag-large', 'crag-medium'] : ['crag-medium', 'crag-small', 'outcrop-large'], mx, my, 1233); if (cn && placePiece(cn, mx, my, { z: -0.2, k: 1.2, flip: hash(i, j, 1205) < 0.5 })) continue; }
      if (sl > 0.45 && rel > 120 && SPR['boulder-field-medium'] && hash(i, j, 1235) < 0.45) { const bn = pickOf(['boulder-field-medium', 'boulder-field-small', 'outcrop-small'], mx, my, 1237); if (bn && placePiece(bn, mx, my, { z: -0.3, k: 1.2 })) continue; }
      if (sl > 0.75 && SPR['mountain-limestone-cliff-band']) { placePiece('mountain-limestone-cliff-band', mx, my, { z: -0.3, flip: hash(i, j, 1205) < 0.5 }); continue; }
      if (WD.woodAt(mx, my) && SPR['mountain-forested-slope-band']) { placePiece('mountain-forested-slope-band', mx, my, { z: -0.35, flip: hash(i, j, 1205) < 0.5 }); continue; }
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
  if (SPR['graveyard-patch']) for (const it of cemItems) {
    const g = 34 * kF;
    for (let i = Math.floor(it.bb[0] / g); i <= Math.floor(it.bb[2] / g); i++) for (let j = Math.floor(it.bb[1] / g); j <= Math.floor(it.bb[3] / g); j++) {
      const mx = (i + 0.5) * g, my = (j + 0.5) * g; if (!inPoly(mx, my, it.rings) || !freeW(mx, my, 14 * kF)) continue;
      { const [, sm] = streetNear(mx, my, 90 * kF); if (placeFiller(['yew-graveyard'], mx, my, sm ? sm[3] : 0, 1305, [80, 40])) continue; }
      putW('graveyard-patch', mx, my, { flip: hash(i, j, 1301) < 0.5, shadow: 0 }); takeW(mx, my, 16 * kF);
      const x = mx + 14 * kF, y = my + 6 * kF; if (SPR['columnar-cypress'] && hash(i, j, 1303) < 0.6 && freeW(x, y, 3 * kF, 1 * kF)) { putW('columnar-cypress', x, y, { s: 0.9, shadow: 0.6 }); takeW(x, y, 3 * kF); }
    }
  }
  // F. real bridges: the deck is painted from the real geometry (with the roads); a drawn arched bridge
  //    in the nearest of its four directions stands on it when the crossing is close enough to one
  //    (which bridges get a deck is the world plan's: water under them, land and a drawn road at both ends)
  for (const br of decks) {
    const a = br.pts[0], b2 = br.pts[br.pts.length - 1];
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
  // G. water edges: built stone quays in towns, stony banks in the country, along the real shore; boats
  //    moored at the town quays
  const quayRun = [];
  for (const p of waterP) for (const ring of p) {
    const bb = bboxOf([ring]); if (bb[2] < BB[0] || bb[0] > BB[2] || bb[3] < BB[1] || bb[1] > BB[3]) continue;
    const NEW = !!SPR['quay-soft-ew'], WIDE = !!SPR['quay-mooring-wide-ew'];
    alongW(ring, (WIDE ? 34 : NEW ? 24 : 15) * kF, (x, y, ang, nx, ny, sp, segL) => {
      if (!inCanvas(x, y) || nearDeck(x, y) || segL < (WIDE ? 20 : 9)) return; // short corner cuts get no wall of their own
      const l1 = onLand(x + nx * 4 * kF, y + ny * 4 * kF), l2 = onLand(x - nx * 4 * kF, y - ny * 4 * kF); if (l1 === l2) return;
      const canal = canalAt(x, y), bigRiver = !canal && WD.riverish(x, y), riverHere = bigRiver || (!canal && p.river), s = l1 ? 1 : -1, town = canal || ((coreAt(x, y) || nearestHeart(x, y)[1] < 2.5) && !riverHere);
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
  for (const [x, y, ang, wx, wy] of quayRun) {
    if (!canalAt(x, y) || H01(x, y, 2201) > 0.1 || boatCells.has(Math.round(x / (45 * kF)) + ',' + Math.round(y / (45 * kF)))) continue;
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
  if (SPR.watermill) for (const h of hearts) {
    if (canalAt(h.x, h.y)) continue;
    let best = null, bd = h.R * 2.2;
    for (const r of riverL) if (['stream', 'river'].includes(r.cls)) for (const v of r.pts) { const d = Math.hypot(v[0] - h.x, v[1] - h.y); if (d < bd && d > h.R * 0.6) { bd = d; best = v; } }
    if (best && footDry(best[0] + 12 * kF, best[1], 10 * kF) && freeW(best[0] + 12 * kF, best[1], 12 * kF)) { putW('watermill', best[0] + 12 * kF, best[1]); takeW(best[0] + 12 * kF, best[1], 16 * kF); }
  }
  T('objects');
  } // (planning)

  // ------------------------------------------------------------ ground (painted only for the chunk itself)
  // textures through low-resolution masks of world-anchored fields; few full-size passes
  // low-resolution grids on the world pixel lattice: cell u of a grid with step s covers world pixels
  // [(g0 + u)·s, (g0 + u + 1)·s), whichever region paints it
  const lattice = (s) => { const gx0 = Math.floor(GX / s), gy0 = Math.floor(GY / s), ox = gx0 * s - GX, oy = gy0 * s - GY; return { gx0, gy0, ox, oy, w: Math.ceil((W - ox) / s) + 2, h: Math.ceil((H - oy) / s) + 2 }; };
  const fieldMask = (fn, s = 24) => {
    if (planOnly) return null;
    const L = lattice(s), c = off(L.w, L.h), x = c.getContext('2d'), img = x.createImageData(L.w, L.h);
    for (let y = 0; y < L.h; y++) for (let xx = 0; xx < L.w; xx++) { const v = fn(((L.gx0 + xx) * s) / sx, -((L.gy0 + y) * s) / sx); img.data[(y * L.w + xx) * 4 + 3] = Math.max(0, Math.min(255, v * 255)); }
    x.putImageData(img, 0, 0); c.s = s; c.ox = L.ox; c.oy = L.oy; return c;
  };
  const drawMask = (c2, m) => c2.drawImage(m, m.ox || 0, m.oy || 0, m.width * (m.s || 1), m.height * (m.s || 1));
  const tmp = planOnly ? null : off(W, H), tx2 = planOnly ? null : tmp.getContext('2d');
  const texThrough = (name, mask, alpha = 1, rot = 0, op = 'source-over') => {
    const tex = TEXTURES[name]; if (!tex || planOnly) return false;
    tx2.globalCompositeOperation = 'copy'; tx2.fillStyle = worldPattern(tx2, tex, TEX_METRES[name], rot); tx2.fillRect(0, 0, W, H);
    if (mask) { tx2.globalCompositeOperation = 'destination-in'; tx2.imageSmoothingEnabled = true; drawMask(tx2, mask); }
    ctx.save(); ctx.globalAlpha = alpha; ctx.globalCompositeOperation = op; ctx.drawImage(tmp, 0, 0); ctx.restore();
    return true;
  };
  // soft masks: drawn at low resolution on the world lattice and scaled up smoothly
  const softMask = (draw, featherPx) => { const f = Math.max(2, Math.round(featherPx)), L = lattice(f); const c = off(L.w, L.h), x = c.getContext('2d'); x.scale(1 / f, 1 / f); x.translate(-L.ox, -L.oy); x.fillStyle = '#000'; draw(x); c.s = f; c.ox = L.ox; c.oy = L.oy; return c; };
  const up = (m) => { const c = off(W, H), x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; drawMask(x, m); return c; };
  const polyMaskC = (polys, featherM) => { if (planOnly) return null; if (featherM) return softMask((x) => fillPolys(x, polys, P), featherM * ppm); const c = off(W, H), x = c.getContext('2d'); x.fillStyle = '#000'; fillPolys(x, polys, P); return c; };
  // what the plans of the tiles round the region put down: pieces get a soft wash, houses flowers, and the
  // ground decals keep off everything (4 m world cells)
  const plansAll = planOnly ? [] : (opts.plans || []).flat().sort((a, b) => (b.wy - a.wy) || (a.wx - b.wx) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // (a fixed order, whatever order the plans came in)
  const planPieces = plansAll.filter((o) => o.pc && !o.pc.filler).map((o) => o.pc);
  const OC4 = 4 * kF, occP = new Set();
  const takeP = (x0, y0, x1, y1) => { for (let i = Math.floor(x0 / OC4); i <= Math.floor(x1 / OC4); i++) for (let j = Math.floor(y0 / OC4); j <= Math.floor(y1 / OC4); j++) occP.add(i + ',' + j); };
  for (const o of plansAll) { if (o.pc) takeP(o.pc.cx - o.pc.fw * 0.45 * kF, o.pc.cy - o.pc.fh * 0.45 * kF, o.pc.cx + o.pc.fw * 0.45 * kF, o.pc.cy + o.pc.fh * 0.45 * kF); else if (o.name !== 'plaza') { const r = Math.max(2, Math.min(20, o.w * 0.35)) * kF; takeP(o.wx - r, o.wy - r * 0.6, o.wx + r, o.wy + r * 0.6); } }
  const hitP = (x, y, r) => { for (let i = Math.floor((x - r) / OC4); i <= Math.floor((x + r) / OC4); i++) for (let j = Math.floor((y - r * 0.6) / OC4); j <= Math.floor((y + r * 0.75) / OC4); j++) if (occP.has(i + ',' + j)) return true; return false; };
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
    const wash = (rgb, mask, op) => { if (!mask) return; tx2.globalCompositeOperation = 'copy'; tx2.fillStyle = rgb; tx2.fillRect(0, 0, W, H); tx2.globalCompositeOperation = 'destination-in'; drawMask(tx2, mask); ctx.save(); ctx.globalCompositeOperation = op; ctx.drawImage(tmp, 0, 0); ctx.restore(); };
    wash('rgb(120,104,40)', fm(240, 531, 0.4, 0.72, 0.95, 32), 'screen');
    wash('rgb(165,152,112)', fm(300, 527, 0.5, 0.2, 0.6, 32), 'multiply');
    // warm golden grade, towards the targets (green/red about 0.9, little blue)
    { ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgb(255,236,150)'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = 'rgb(26,20,0)'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    // the meadow overlays (set five): flower drifts, cloud shadows, damp grass, large and soft, on a world grid
    if (SPR['overlay-flower-drift']) { const g = 130 * kF; for (let i = Math.floor(BB[0] / g) - 1; i <= Math.floor(BB[2] / g) + 1; i++) for (let j = Math.floor(BB[1] / g) - 1; j <= Math.floor(BB[3] / g) + 1; j++) { const r = hash(i, j, 3401), n = r < 0.4 ? 'overlay-flower-drift' : r < 0.5 ? 'overlay-damp-grass' : null; if (!n || !SPR[n] || !SPRIDX[n]) continue; const [px, py] = P([(i + 0.2 + hash(i, j, 3403) * 0.6) * g, (j + 0.2 + hash(i, j, 3405) * 0.6) * g]), w = q64(SPRIDX[n].foot_m[0] * 1.12 * ppm), h = q64(w * SPR[n].height / SPR[n].width); ctx.save(); ctx.globalAlpha = n === 'overlay-cloud-shadow' ? 0.28 : n === 'overlay-damp-grass' ? 0.35 : 0.7; drawS(ctx, SPR[n], q64(px - w / 2), q64(py - h / 2), w, h); ctx.restore(); } }
    texThrough('meadow-cool', fieldMask((x, y) => smooth(150, 450, dem(x, y) - floor) * 0.25)); // (zero below the valley floor + 150 m)
    // under every painted piece the meadow turns softly towards the piece's own grass, so its painted
    //    ground fades in without a pad or a halo
    for (const pc of planPieces) { const [cx, cy] = P([pc.cx, pc.cy]), rx = pc.fw * 0.75 * ppm, ry = pc.fh * 0.75 * ppm; ctx.save(); ctx.translate(cx, cy); ctx.scale(1, ry / rx); const gr = ctx.createRadialGradient(0, 0, rx * 0.35, 0, 0, rx); gr.addColorStop(0, 'rgba(166,148,42,0.6)'); gr.addColorStop(1, 'rgba(166,148,42,0)'); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    T('meadow');
    // 2. real ground layers
    if (parkP.length) texThrough(TEXTURES['meadow-deep-green'] ? 'meadow-deep-green' : 'pasture', polyMaskC(parkP, 8), 0.35);
    if (sandP.length) texThrough('sand', polyMaskC(sandP, 2), 0.9);
    // forest floor only under the trees actually drawn (a dark patch always has its wood)
    { const fo = []; if (fo.length) { const c2 = softMask((x) => { for (const o of fo) { x.beginPath(); x.ellipse(o.x, o.y - o.h * 0.25, o.w * 0.42, o.h * 0.34, 0, 0, Math.PI * 2); x.fill(); } }, 4 * ppm); texThrough('forest-floor', c2, 0.55); } }
    {
      // slope over 80 m: an embankment on the valley floor is not a mountainside
      const dd = 40 * kF, slopeAt = (x, y) => Math.hypot(dem(x + dd, y) - dem(x - dd, y), dem(x, y + dd) - dem(x, y - dd)) / (2 * dd / kF);
      { // (every pixel decides for itself; a flat region simply gets empty masks)
        // ... and it must hold over 320 m: a mountainside does, an embankment or a quarry edge does not
        const D2 = 160 * kF, held = (x, y) => smooth(0.22, 0.32, Math.hypot(dem(x + D2, y) - dem(x - D2, y), dem(x, y + D2) - dem(x, y - D2)) / (2 * D2 / kF));
        const m = fieldMask((x, y) => smooth(0.62, 0.9, slopeAt(x, y)) * held(x, y), 16);
        texThrough('rock', m, 0.55);
        texThrough('scree', fieldMask((x, y) => smooth(0.42, 0.6, slopeAt(x, y)) * (1 - smooth(0.62, 0.8, slopeAt(x, y))) * held(x, y)), 0.9);
        if (rockP.length) texThrough('rock', polyMaskC(rockP, 2), 0.9);
      }
      texThrough('snow', fieldMask((x, y) => smooth(1900, 2100, dem(x, y)), 16), 0.95);
    }
    // 3. fields (real farmland and the villages' own parcels), paddocks and lots: shaped patches
    //    with a soil rim and a hedge edge, no drop shadow
    const patch = (pts, texName, ang, edge, at) => {
      const path = () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
      ctx.save(); ctx.lineJoin = 'round';
      path(); ctx.fillStyle = TEXTURES[texName] ? worldPattern(ctx, TEXTURES[texName], TEX_METRES[texName], ang, at) : '#b89a50'; ctx.fill();
      path(); ctx.strokeStyle = TEXTURES['dirt-path'] ? worldPattern(ctx, TEXTURES['dirt-path'], 16) : 'rgba(120,96,48,0.9)'; ctx.lineWidth = 2.6 * ppm; ctx.stroke();
      path(); ctx.strokeStyle = 'rgba(100,74,36,0.45)'; ctx.lineWidth = 0.5 * ppm; ctx.stroke();
      ctx.restore();
    };
    for (const p of farmP) { const o2 = obb(p[0]); const area = ringArea(p[0]) / (k * k); if (area < 1200) continue; if (area > 20000 && o2) { const pm = polyMaskC([p], 14); texThrough('meadow-dry-patches', pm, 0.4); continue; } const hf = hash(Math.round(p[0][0][0] / kF), Math.round(p[0][0][1] / kF), 63); patch(p[0].map(P), hf < 0.45 ? 'wheat-field' : hf < 0.75 ? 'ploughed-earth' : 'vegetable-rows', o2 ? -o2.ang : 0, 'hedge', p[0][0]); }
    for (const f of fields) patch(f.corners.map(P), f.kind, -f.ang, 'hedge', f.corners[0]);
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
        ctx.fillStyle = TEXTURES[tn] ? worldPattern(ctx, TEXTURES[tn], TEX_METRES[tn], L.ang, [L.bx, L.by]) : '#9a8a50'; ctx.globalAlpha = L.kind === 'yard' ? 0.75 : L.kind === 'veg' ? 0.95 : 0.6; ctx.fill(); ctx.restore();
      }
      if (L.sx !== null) {
        const [x0, y0] = P([L.x, L.y]), [x1, y1] = P([L.sx, L.sy]);
        ctx.save(); ctx.strokeStyle = TEXTURES['dirt-path'] ? worldPattern(ctx, TEXTURES['dirt-path'], TEX_METRES['dirt-path']) : '#d8b070'; ctx.lineWidth = 3 * ppm; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.restore();
      }
    }
    // ground decals: flowers, tufts, clover, pebbles and leaf litter in drifts the world's own pattern
    //    lays out (one kind per drift), never on roads, water or under buildings
    {
      const g = 8.5 * kF;
      for (let i = Math.floor(BB[0] / g); i <= Math.floor(BB[2] / g); i++) for (let j = Math.floor(BB[1] / g); j <= Math.floor(BB[3] / g); j++) {
        const mx = (i + hash(i, j, 2301)) * g, my = (j + hash(i, j, 2303)) * g;
        const drift = fbm(mx / (60 * kF), my / (60 * kF), 2305); if (hash(i, j, 2307) > (drift - 0.42) * 1.4) continue;
        if (!onLand(mx, my, 3 * kF) || hitP(mx, my, 3 * kF) || WD.farmAt(mx, my) || hearts.some((h) => inPlaza(h, mx, my, 3 * kF))) continue;
        const [sd] = streetNear(mx, my, 20 * kF); if (sd < 2) continue;
        const kindN = fbm(mx / (90 * kF), my / (90 * kF), 2309);
        let n2;
        if (WD.woodAt(mx, my) || nearTrail(mx, my)) n2 = 'decals-leaf-litter';
        else if (sd < 5) continue;
        else n2 = ['decals-flower-ivory', 'decals-flower-pink', 'decals-flower-ivory', 'decals-grass-tufts-light'][Math.floor(kindN * 3.99)];
        const im = SPR[n2], meta = SPRIDX[n2]; if (!im || !meta) continue;
        const wM = { 'decals-flower-ivory': 4, 'decals-flower-pink': 4, 'decals-flower-lavender': 4, 'decals-grass-tufts-light': 4, 'decals-grass-tufts-dark': 5, 'decals-pebbles': 5, 'decals-clover': 4, 'decals-leaf-litter': 6 }[n2] * 1.1 * (0.8 + hash(i, j, 2317) * 0.4);
        const [x, y] = P([mx, my]), w = q64(wM * ppm), h = q64(w * im.height / im.width);
        ctx.save(); ctx.globalAlpha = 0.75; ctx.translate(x, y); if (hash(i, j, 2319) < 0.5) ctx.scale(-1, 1); drawS(ctx, im, q64(-w / 2), q64(-h / 2), w, h); ctx.restore();
      }
    }
    // flowers and tufts at the foot of every house, as in the painted finish
    for (const o0 of plansAll) {
      if (!/-roof-|house|cottage|row-|tavern|inn$|church|chapel|limewash|gable/.test(o0.name) || o0.pc) continue;
      const [ox0, oy0] = P([o0.wx, o0.wy]), o = { x: ox0, y: oy0, w: o0.w * ppm, h: o0.h * ppm };
      for (const sd of [-1, 1]) {
        const hx = hash(Math.round(o0.wx / kF), Math.round(o0.wy / kF) + sd, 2321), n2 = hx < 0.4 ? 'decals-flower-pink' : hx < 0.7 ? 'decals-flower-ivory' : 'decals-grass-tufts-dark';
        const im = SPR[n2]; if (!im) continue;
        const w = q64(o.w * 0.26), h = q64(w * im.height / im.width), x = o.x + sd * o.w * (0.3 + hx * 0.08), y = o.y - o.h * 0.02;
        drawS(ctx, im, q64(x - w / 2), q64(y - h * 0.75), w, h);
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
    if (waterP.length) {
      // close the gaps the data leaves in the water under bridges (cut polygons): a morphological closing on a
      // world-lattice grid, kept only within 40 m of a real bridge
      const c2 = Math.max(2, Math.round(2 * ppm)), L = lattice(c2), w3 = L.w, h3 = L.h;
      const mc = off(w3, h3), m3 = mc.getContext('2d'); m3.scale(1 / c2, 1 / c2); m3.translate(-L.ox, -L.oy); m3.fillStyle = '#000'; fillPolys(m3, waterP, P);
      const src = m3.getImageData(0, 0, w3, h3).data, A0 = new Uint8Array(w3 * h3);
      for (let i = 0; i < w3 * h3; i++) A0[i] = src[i * 4 + 3] > 127 ? 1 : 0;
      const r = Math.max(1, Math.round(17 * ppm / c2));
      const pass = (a, horiz, isMax) => { const o2 = new Uint8Array(a.length); for (let y = 0; y < h3; y++) for (let x = 0; x < w3; x++) { let v = isMax ? 0 : 1; for (let d = -r; d <= r; d++) { const xx = horiz ? x + d : x, yy = horiz ? y : y + d; const ins = xx >= 0 && yy >= 0 && xx < w3 && yy < h3; const u = ins ? a[yy * w3 + xx] : a[y * w3 + x]; if (isMax ? u : !u) { v = isMax ? 1 : 0; break; } } o2[y * w3 + x] = v; } return o2; };
      const closed = pass(pass(pass(pass(A0, true, true), false, true), true, false), false, false);
      const BG8 = 8 * kF, brCells = new Set();
      for (const br of WD.bridgesIn(BBX)) for (let i = 1; i < br.pts.length; i++) { const [ax, ay] = br.pts[i - 1], [bx, by] = br.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (4 * kF))); for (let m = 0; m <= n; m++) brCells.add(Math.floor((ax + (bx - ax) * m / n) / BG8) + ',' + Math.floor((ay + (by - ay) * m / n) / BG8)); }
      const nearBridge = (x, y) => { const i0 = Math.floor(x / BG8), j0 = Math.floor(y / BG8); for (let a = -5; a <= 5; a++) for (let b = -5; b <= 5; b++) if (brCells.has((i0 + a) + ',' + (j0 + b))) return true; return false; };
      const gi = m3.createImageData(w3, h3); let nGap = 0;
      for (let i = 0; i < w3 * h3; i++) if (closed[i] && !A0[i]) { const u = i % w3, v = Math.floor(i / w3); if (!nearBridge(((L.gx0 + u + 0.5) * c2) / sx, -((L.gy0 + v + 0.5) * c2) / sx)) continue; gi.data[i * 4 + 3] = 255; nGap++; }
      if (nGap) { const gc = off(w3, h3); gc.getContext('2d').putImageData(gi, 0, 0); gc.s = c2; gc.ox = L.ox; gc.oy = L.oy; wmc.imageSmoothingEnabled = true; drawMask(wmc, gc); drawMask(wmc, gc); }
    }
    // the water's character, per pixel from the world plan: town water (cobbled banks, a stone cap), canal
    // water (the canal texture), river banks and mountain banks (scree), elsewhere sand
    const townM = fieldMask((x, y) => (WD.townWaterAt(x, y) ? 1 : 0), 16), canalM = fieldMask((x, y) => (WD.canalAt(x, y) ? 1 : 0), 16), highM = fieldMask((x, y) => smooth(380, 420, dem(x, y)), 16);
    const ring = (src, wpx) => { const c = off(W, H), x = c.getContext('2d'); for (let a = 0; a < 12; a++) x.drawImage(src, Math.cos(a / 12 * Math.PI * 2) * wpx, Math.sin(a / 12 * Math.PI * 2) * wpx); return c; };
    const masked = (c, m, op) => { const x = c.getContext('2d'); x.save(); x.globalCompositeOperation = op; x.imageSmoothingEnabled = true; drawMask(x, m); x.restore(); return c; };
    { // country banks
      const bk = ring(wm, 5 * ppm), bkc = bk.getContext('2d');
      const wr = off(W, H), wrc = wr.getContext('2d'); wrc.fillStyle = '#000'; fillPolys(wrc, waterP.filter((m2) => m2.river), P); wrc.strokeStyle = '#000'; wrc.lineCap = 'round'; for (const r of riverL) if (r.cls === 'river') { wrc.lineWidth = 16 * ppm; traceLines(wrc, [r.pts], P); wrc.stroke(); }
      const scree = ring(wr, 5 * ppm), sc = scree.getContext('2d'); sc.globalCompositeOperation = 'destination-in'; sc.drawImage(bk, 0, 0);
      const hi = masked(ring(wm, 5 * ppm), highM, 'destination-in'); sc.globalCompositeOperation = 'source-over'; sc.drawImage(hi, 0, 0);
      bkc.globalCompositeOperation = 'source-in'; bkc.fillStyle = TEXTURES.sand ? worldPattern(bkc, TEXTURES.sand, TEX_METRES.sand) : '#b8a070'; bkc.fillRect(0, 0, W, H);
      sc.globalCompositeOperation = 'source-in'; sc.fillStyle = TEXTURES.scree ? worldPattern(sc, TEXTURES.scree, TEX_METRES.scree) : '#a89a80'; sc.fillRect(0, 0, W, H);
      bkc.globalCompositeOperation = 'source-atop'; bkc.drawImage(scree, 0, 0);
      ctx.drawImage(masked(bk, townM, 'destination-out'), 0, 0);
    }
    const bankW = 4.5 * ppm;
    { // town banks: cobbles, and the quay's cap, a light stone line along its land edge
      const bk = ring(wm, bankW), bkc = bk.getContext('2d'); bkc.globalCompositeOperation = 'source-in';
      bkc.fillStyle = TEXTURES['cobbled-square'] ? worldPattern(bkc, TEXTURES['cobbled-square'], 6) : '#c8b48a'; bkc.fillRect(0, 0, W, H); bkc.globalCompositeOperation = 'source-atop'; bkc.fillStyle = 'rgba(214,196,160,0.35)'; bkc.fillRect(0, 0, W, H);
      const cap = ring(wm, bankW + 0.9 * ppm), cx2 = cap.getContext('2d'); cx2.globalCompositeOperation = 'destination-out'; cx2.drawImage(bk, 0, 0); cx2.drawImage(wm, 0, 0); cx2.globalCompositeOperation = 'source-in'; cx2.fillStyle = 'rgba(236,224,196,0.9)'; cx2.fillRect(0, 0, W, H);
      ctx.drawImage(masked(bk, townM, 'destination-in'), 0, 0); ctx.drawImage(masked(cap, townM, 'destination-in'), 0, 0);
    }
    const wc = off(W, H), w2 = wc.getContext('2d');
    w2.drawImage(wm, 0, 0); w2.globalCompositeOperation = 'source-in';
    const wTex = TEXTURES['river-bright-current'] ? 'river-bright-current' : TEXTURES['river-current-painted'] ? 'river-current-painted' : 'river-water';
    w2.fillStyle = TEXTURES[wTex] ? worldPattern(w2, TEXTURES[wTex], TEX_METRES[wTex]) : WATER.edge; w2.fillRect(0, 0, W, H);
    { const cTex = TEXTURES['canal-sun-sweeps'] ? 'canal-sun-sweeps' : 'canal-reflection-painted'; if (TEXTURES[cTex]) { const cc = off(W, H), c3 = cc.getContext('2d'); c3.fillStyle = worldPattern(c3, TEXTURES[cTex], TEX_METRES[cTex]); c3.fillRect(0, 0, W, H); masked(cc, canalM, 'destination-in'); w2.globalCompositeOperation = 'source-atop'; w2.drawImage(cc, 0, 0); } }
    if (TEXTURES['lake-water'] && waterP.some((m) => m.still)) { const lm2 = off(W, H), l2 = lm2.getContext('2d'); l2.fillStyle = '#000'; fillPolys(l2, waterP.filter((m) => m.still), P); l2.globalCompositeOperation = 'source-in'; l2.fillStyle = TEXTURES['canal-reflection-painted'] ? worldPattern(l2, TEXTURES['canal-reflection-painted'], 52) : worldPattern(l2, TEXTURES['lake-water'], TEX_METRES['lake-water']); l2.fillRect(0, 0, W, H); w2.globalCompositeOperation = 'source-atop'; w2.drawImage(lm2, 0, 0); }
    // shallows: a lighter band along every shore, and a crisp dark line at the waterline
    const rim = off(W, H), r5 = rim.getContext('2d'); r5.fillStyle = '#000'; r5.fillRect(0, 0, W, H); r5.globalCompositeOperation = 'destination-out'; r5.drawImage(wm, 0, 0);
    const sh = up(softMask((x) => x.drawImage(rim, 0, 0), Math.max(2, 2.5 * ppm))), s6 = sh.getContext('2d'); s6.globalCompositeOperation = 'source-in'; s6.fillStyle = TEXTURES['shallow-water'] ? worldPattern(s6, TEXTURES['shallow-water'], TEX_METRES['shallow-water']) : 'rgba(70,140,150,1)'; s6.fillRect(0, 0, W, H);
    w2.globalCompositeOperation = 'source-atop'; w2.globalAlpha = 0.95; w2.drawImage(sh, 0, 0); w2.globalAlpha = 1;
    if (!TEXTURES['river-current-painted']) { w2.save(); w2.globalCompositeOperation = 'screen'; w2.fillStyle = 'rgba(26,74,70,1)'; w2.fillRect(0, 0, W, H); w2.restore(); w2.globalCompositeOperation = 'destination-in'; w2.drawImage(wm, 0, 0); w2.globalCompositeOperation = 'source-over'; }
    // lily pads on still town water, a few glints
    {
      const g = 6 * kF;
      for (let i = Math.floor(BB[0] / g); i <= Math.floor(BB[2] / g); i++) for (let j = Math.floor(BB[1] / g); j <= Math.floor(BB[3] / g); j++) {
        if (hash(i, j, 631) > 0.07) continue;
        const mx = (i + hash(i, j, 633)) * g, my = (j + hash(i, j, 635)) * g;
        if (!WD.waterAt(mx, my) || !WD.townWaterAt(mx, my) || [0, 1, 2, 3].every((a) => WD.waterAt(mx + Math.cos(a * 1.57) * 5 * kF, my + Math.sin(a * 1.57) * 5 * kF))) continue;
        const ln2 = hash(i, j, 637) < 0.6 ? 'lily-pads-small' : 'lily-pads-large', im = SPR[ln2]; if (!im) continue;
        const [x, y] = P([mx, my]), wl = q64((ln2 === 'lily-pads-small' ? 3 : 5) * 2.2 * ppm), hl = q64(wl * im.height / im.width); drawS(w2, im, q64(x - wl / 2), q64(y - hl / 2), wl, hl);
      }
    }
    // ripples on running water, deeper tone in the middle of wide water
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
    // a set piece has its own lanes: the real roads go under its body and stay whole up to its walls (a soft fade
    // further out left a ghost of the road in the meadow) ...
    for (const pc of canon) { if (!SETTLEMENT.test(pc.name)) continue; const [cx, cy] = P([pc.cx, pc.cy]), rx = pc.fw * 0.4 * ppm, ry = pc.fh * 0.38 * ppm; r2.save(); r2.globalCompositeOperation = 'destination-out'; r2.translate(cx, cy); r2.scale(1, ry / rx); const gr = r2.createRadialGradient(0, 0, rx * 0.8, 0, 0, rx); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); r2.fillStyle = gr; r2.beginPath(); r2.arc(0, 0, rx, 0, Math.PI * 2); r2.fill(); r2.restore(); }
    // ... and each of its entrances is joined to the nearest drawn road by a short lane
    { r2.save(); r2.lineCap = 'round'; r2.lineJoin = 'round';
      const nearestDrawn = WD.nearestDrawn;
      for (const pc0 of canon) for (const pt0 of pc0.ports) { const pt = { ...pt0, piece: pc0 }; const sm = nearestDrawn(pt.x, pt.y); if (!sm || Math.hypot(sm[0] - pt.x, sm[1] - pt.y) / kF > 85 || (pt.piece && Math.hypot(sm[0] - pt.piece.cx, sm[1] - pt.piece.cy) < Math.hypot(pt.x - pt.piece.cx, pt.y - pt.piece.cy) * 0.8)) continue; const [x0, y0] = P([pt.x, pt.y]), [x1, y1] = P([sm[0], sm[1]]); r2.strokeStyle = 'rgba(126,94,48,0.45)'; r2.lineWidth = (pt.main ? 5.2 : 4) * ppm; r2.beginPath(); r2.moveTo(x0, y0); r2.lineTo(x1, y1); r2.stroke(); r2.strokeStyle = TEXTURES['dirt-path'] ? worldPattern(r2, TEXTURES['dirt-path'], TEX_METRES['dirt-path']) : ROAD.fill; r2.lineWidth = (pt.main ? 4 : 3) * ppm; r2.stroke(); }
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
      path(); ctx.fillStyle = TEXTURES['cobbled-square'] ? worldPattern(ctx, TEXTURES['cobbled-square'], 9, h.ang, [h.x, h.y]) : TEXTURES['paving-herringbone'] ? worldPattern(ctx, TEXTURES['paving-herringbone'], 16, h.ang, [h.x, h.y]) : TEXTURES['cobbled-square'] ? worldPattern(ctx, TEXTURES['cobbled-square'], 22) : '#cdb08a'; ctx.fill();
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
    plan.push({ name: o.name, wx, wy, w: o.w / ppm, h: o.h / ppm, ax: o.ax, ay: o.ay, foot: o.foot, flip: o.flip, rot: o.rot, shadow: o.shadow, z: o.z, house: houseNames.has(o.name) || /-roof-|row-/.test(o.name), solid: !!o.box || /bridge/.test(o.name) || (solid(o.name) && !/^(forest|field-quilt|orchard-block|vineyard-block|paddock|mountain|bank|quay-soft)/.test(o.name)), ...(o.box ? { bw: o.box[0] * (o.name.includes('-ew') || o.name.includes('-ns') || o.name.includes('-ne-sw') || o.name.includes('-nw-se') ? 0.8 : 1), bh: o.box[1] * 0.9, bx: o.bcx, by: o.bcy } : {}), ...(o.pc ? { pc: o.pc } : {}) });
  }
  for (const h of hearts) if (!h.piece && inView(h.x, h.y)) plan.push({ name: 'plaza', wx: h.x, wy: h.y, w: 2 * h.pa / kF, h: 2 * h.pb / kF, ax: 0.5, ay: 0.5, foot: 1, flip: false, rot: 0, shadow: 0, z: 0, house: false, solid: true });
  // labels, each at a spot the world plan fixes: a heart's name beside its piece, a castle's at the castle,
  // names along canals, rivers and main roads once per name per 480 m world cell. A tile carries the labels
  // whose spot lies inside it.
  const labels = [];
  if (planOnly) {
    for (const h of hearts) { if (!inView(h.x, h.y)) continue; const L = WD.heartLabel(h.I, h.J, zoom); if (L) labels.push(L); }
    for (const s2 of special) if (s2.drawn && s2.label && WD.goodName(s2.label) && inView(s2.x, s2.y)) labels.push({ name: WD.shortName(s2.label), wx: s2.x, wy: s2.y, big: false, pr: 1, fixed: 1 });
    for (const [I, J] of WD.labelCellsIn(BC)) for (const L of WD.lineLabels(I, J)) if (inView(L.wx, L.wy)) labels.push(L);
  }
  // for the acceptance checks: road ends that join nothing (not at another drawn road, a set piece or water)
  const stubs = [];
  { const SG2 = 8 * kF, hs = new Map();
    drawnStreets.forEach((L, id) => { for (let i = 1; i < L.pts.length; i++) { const [ax, ay] = L.pts[i - 1], [bx, by] = L.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (4 * kF))); for (let m = 0; m <= n; m++) { const x = ax + (bx - ax) * m / n, y = ay + (by - ay) * m / n, k3 = Math.floor(x / SG2) + ',' + Math.floor(y / SG2); if (!hs.has(k3)) hs.set(k3, []); hs.get(k3).push([x, y, id]); } } });
    const joined = (p, id) => { const i0 = Math.floor(p[0] / SG2), j0 = Math.floor(p[1] / SG2); for (let a = -1; a <= 1; a++) for (let b2 = -1; b2 <= 1; b2++) for (const q of hs.get((i0 + a) + ',' + (j0 + b2)) || []) if (q[2] !== id && Math.hypot(q[0] - p[0], q[1] - p[1]) < 9 * kF) return true; return false; };
    const inPiece = (p) => canon.some((pc) => Math.abs(p[0] - pc.cx) < pc.fw * 0.45 * kF && Math.abs(p[1] - pc.cy) < pc.fh * 0.45 * kF);
    const onWater = (p) => !onLand(p[0], p[1], 6 * kF);
    drawnStreets.forEach((L, id) => { for (const p of [L.pts[0], L.pts[L.pts.length - 1]]) if (inView(p[0], p[1]) && !joined(p, id) && !inPiece(p) && !onWater(p)) stubs.push([p[0], p[1], L.cls || (L.main ? 'main' : '?'), Math.round(lineLen(L.pts))]); }); }
  // what this tile sees of the world plan (the purity checks compare it between tiles)
  const heartsOut = hearts.map((h) => { const L = WD.heartLabel(h.I, h.J, zoom); return { key: h.key, name: h.name || '', x: h.piece ? h.piece.cx : h.x, y: h.piece ? h.piece.cy : h.y, fw: h.piece ? h.piece.fw : 0, fh: h.piece ? h.piece.fh : 0, t: h.t, piece: h.piece ? h.piece.name : '', at: h.piece ? [h.piece.x, h.piece.y, h.piece.wM, h.piece.flip] : [h.x, h.y], label: L ? [L.wx, L.wy] : null }; });
  const heartInfo = hearts.filter((h) => inView(h.x, h.y)).map((h) => `${h.name || '?'} (tier ${h.t}, ${h.piece ? h.piece.name : 'no piece'}${h.anchor ? ', at ' + h.anchor.kind : ''}, canal water ${WD.canalAt(h.x, h.y)}, water ${h.ws ? h.ws.side + ' ' + h.ws.d + ' m' : 'none'})`);
  if (!planOnly) {
    // gentle relief where the real slope is steep (on the world lattice, so regions meet without seams)
    const s4 = 16, L = lattice(s4), w = L.w, h = L.h;
    const rc = off(w, h), r4 = rc.getContext('2d'), img = r4.createImageData(w, h); const dd = 20 * kF; let any = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const mx = ((L.gx0 + x) * s4) / sx, my = -((L.gy0 + y) * s4) / sx;
      const gx = (dem(mx + dd, my) - dem(mx - dd, my)) / (2 * dd / kF), gy = (dem(mx, my + dd) - dem(mx, my - dd)) / (2 * dd / kF);
      const lit = Math.max(-1, Math.min(1, (gx - gy) * 0.7071 * 2.4)), o4 = (y * w + x) * 4;
      if (lit < 0) { img.data[o4] = 40; img.data[o4 + 1] = 40; img.data[o4 + 2] = 70; img.data[o4 + 3] = Math.max(0, -lit - 0.4) * 36; }
      else { img.data[o4] = 255; img.data[o4 + 1] = 230; img.data[o4 + 2] = 160; img.data[o4 + 3] = Math.max(0, lit - 0.3) * 34; }
      if (img.data[o4 + 3] > 0) any = true;
    }
    if (any) { r4.putImageData(img, 0, 0); rc.s = s4; rc.ox = L.ox; rc.oy = L.oy; ctx.save(); ctx.imageSmoothingEnabled = true; drawMask(ctx, rc); ctx.restore(); }
  }
  const nearBC = (b) => b[2] >= vx0 - 20 * kF && b[0] <= vx1 + 20 * kF && b[3] >= vy0 - 20 * kF && b[1] <= vy1 + 20 * kF;
  const roadsNear = drawnStreets.filter((L) => nearBC(L.bb || (L.bb = bboxOf([L.pts]))));
  const roadsOut = roadsNear.map((L) => L.pts.map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]));
  // the world plan as this tile sees it, for the purity checks: road survival, compounds, line labels
  const seen = planOnly ? { roads: streets.filter((L) => nearBC(L.bb || (L.bb = bboxOf([L.pts])))).map((L) => [L.key, drawnKeys.has(L.key) ? 1 : 0]).sort(), compounds: compoundsW.map((c) => [c.key, c.pieces.map((q) => [q.name, Math.round(q.x * 100) / 100, Math.round(q.y * 100) / 100, q.flip ? 1 : 0])]), decks: decks.map((d) => d.key).sort(), lineLabels: WD.labelCellsIn(BB).map(([I, J]) => [I + ',' + J, WD.lineLabels(I, J)]) } : null;
  return { plan, labels, heartInfo, stubs, hearts: heartsOut, roads: roadsOut, roadKeys: roadsNear.map((L) => L.key).sort(), seen, chunk: [vx0, vy0, vx1, vy1], steads: compoundsW.filter((c) => inView(c.x, c.y)).length, ground: planOnly ? null : canvas, BB, W, H, ms: Math.round(performance.now() - t0), tm: tm.join(', ') };
}

// ---------------------------------------------------------------- the sprite bake
// one soft shadow, made once: a radial falloff stands in for a blurred ellipse
let SHADOW = null;
const shadowImg = () => SHADOW || (SHADOW = (() => { const c = off(128, 128), x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(40,36,8,1)'); gr.addColorStop(0.45, 'rgba(40,36,8,0.95)'); gr.addColorStop(0.75, 'rgba(40,36,8,0.45)'); gr.addColorStop(1, 'rgba(40,36,8,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128); return c; })());
/**
 * Draw the sprites of `plans` (arrays of plan entries, world-anchored) onto a canvas showing the mercator
 * rect `rect` at `sx` canvas px per mercator unit: soft contact shadows first, then the sprites in ground
 * order (a total order, so the result never depends on the order the plans come in).
 */
export function bake(x, plans, rect, sx) {
  const ppm = sx * KF, Wp = (rect[2] - rect[0]) * sx, Hp = (rect[3] - rect[1]) * sx, GX = Math.round(rect[0] * sx), GY = Math.round(-rect[3] * sx);
  const Px = (wx) => Math.round(wx * sx * 64) / 64 - GX, Py = (wy) => Math.round(-wy * sx * 64) / 64 - GY;
  const objs = [];
  for (const p of plans) for (const o of p) {
    if (o.name === 'plaza') continue;
    const w = Math.round(o.w * ppm * 64) / 64, h = Math.round(o.h * ppm * 64) / 64, px = Px(o.wx), py = Py(o.wy);
    if (px + w < 0 || px - w > Wp || py - h > Hp || py + h < 0) continue;
    objs.push({ ...o, px, py, wp: w, hp: h });
  }
  const miss = new Set(); for (const o of objs) if (!(SPR[o.name] || ASSETS[o.name])) miss.add(o.name); if (miss.size) console.error('missing sprites', [...miss].join(','));
  objs.sort((a, b) => (a.z - b.z) || (b.wy - a.wy) || (a.wx - b.wx) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.w - b.w) || ((a.rot || 0) - (b.rot || 0)));
  // soft cast shadows towards the lower right (light from the upper left), longer for trees
  x.save();
  for (const o of objs) { if (!o.shadow || o.rot || !(SPR[o.name] || ASSETS[o.name])) continue; const tree = /deciduous|(^|-)pine|(^|-)forest|bush|tree|cypress/.test(o.name), rx = o.wp * o.foot * (tree ? 0.62 : 0.5), ry = rx * (tree ? 0.4 : 0.38); x.globalAlpha = (tree ? 0.4 : 0.34) * o.shadow; const cx = o.px + rx * (tree ? 0.55 : 0.2), cy = o.py + ry * (tree ? 0.35 : 0.2), q = (v) => Math.round(v * 64) / 64; x.drawImage(shadowImg(), q(cx - rx * 1.35), q(cy - ry * 1.35), q(rx * 2.7), q(ry * 2.7)); }
  x.restore();
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  for (const o of objs) {
    const img = SPR[o.name] || ASSETS[o.name]; if (!img) continue;
    x.save(); x.translate(o.px, o.py); if (o.rot) x.rotate(o.rot); if (o.flip) x.scale(-1, 1);
    drawS(x, img, Math.round(-o.wp * o.ax * 64) / 64, Math.round(-o.hp * o.ay * 64) / 64, o.wp, o.hp); x.restore();
  }
}
