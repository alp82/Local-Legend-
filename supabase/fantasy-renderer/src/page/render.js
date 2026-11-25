// Runs in the headless browser. Paints z16 XYZ tiles with the vendored prototype painter,
// driving painter/chunkworker.js exactly as the prototype's chunks.js does, with one change:
// a chunk is an XYZ tile instead of a 320 m square.
//
// Why that is exact: in web mercator metres a z16 tile x spans [(x - 2^15) * TS, ...], and
// chunkworker.js boxes chunk i as [i * CW, (i + 1) * CW]. With CW = TS, chunk i is tile
// x = i + 2^15, and chunk row j is tile row y = 2^15 - 1 - j. At q = 2 a tile is 1024 px,
// the prototype's own resolution at band 16.
const HALF = 20037508.342789244;
const Z = 16;
const TS = (2 * HALF) / 2 ** Z;
const SHIFT = 2 ** (Z - 1);
const CHUNK_PX = 1024;
const MARGIN_M = 60; // chunks.js
const BAND = 16;
const COMP = 'heart';

const params = new URLSearchParams(location.search);
const N = Math.max(1, Number(params.get('workers')) || 4);

const latOfY = (my) => (Math.atan(Math.exp(my / 6378137)) * 2 - Math.PI / 2) * (180 / Math.PI);

/** The chunkworker geometry for tile row y; the latitude scale kF is that of the tile's centre. */
function geometry(y) {
  const myCentre = HALF - (y + 0.5) * TS;
  const lat = latOfY(myCentre);
  const kF = 1 / Math.cos(((Math.round(lat * 2) / 2) * Math.PI) / 180);
  const sx = CHUNK_PX / TS;
  const marginPx = Math.round(MARGIN_M * kF * sx);
  return { kF, q: 2, CW: TS, chunkPx: CHUNK_PX, sx, ppm: sx * kF, marginPx, M: marginPx / sx };
}
const chunkOf = (x, y) => [x - SHIFT, SHIFT - 1 - y];

// ---------------------------------------------------------------- worker pool (as chunks.js)
const get = (u) => fetch(new URL(u, location.href));
const bytes = async (u) => (await get(u)).arrayBuffer();
const list = await (await get('/assets/bundle.json')).json();
const idx = await (await get('/assets/index.json')).json();
const tex = (await Promise.all(list.textures.map(async (n) => [n, await bytes(`/assets/tex-${n}.webp`)]))).filter(([, b]) => b);
const sheets = await Promise.all(list.sheets.map((f) => bytes(`/assets/${f}`)));

const workers = Array.from({ length: N }, () => ({ w: new Worker('/page/tileworker.js', { type: 'module' }), busy: false }));
for (const wk of workers) {
  // each worker decodes its own copy, as in chunks.js
  wk.w.postMessage({ type: 'tex', tex: tex.map(([n, b]) => [n, b.slice(0)]) });
  wk.w.postMessage({ type: 'atlas', idx, sheets: sheets.map((b) => b.slice(0)) });
}
const queue = [];
const waiting = new Map();
let nextId = 1;
for (const wk of workers) {
  wk.w.onmessage = (e) => {
    if (e.data.persist) return;
    const job = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    wk.busy = false;
    if (e.data.error) job.reject(new Error(e.data.error));
    else job.resolve(e.data);
    pump();
  };
  wk.w.onerror = (e) => console.error('worker error', e.message);
}
function pump() {
  for (const wk of workers) {
    if (wk.busy || !queue.length) continue;
    const job = queue.shift();
    wk.busy = true;
    job.id = nextId++;
    waiting.set(job.id, job);
    wk.w.postMessage({ id: job.id, ...job.msg });
  }
}
const run = (msg) => new Promise((resolve, reject) => { queue.push({ msg, resolve, reject }); pump(); });

// A plan is computed with its own tile's geometry, so every tile that draws it gets the same one.
// It comes with the tile's label candidates (tileworker.js).
const plans = new Map();
function plan(x, y) {
  const key = `${x}/${y}`;
  if (!plans.has(key)) {
    const [i, j] = chunkOf(x, y);
    const p = run({ type: 'planLabels', g: geometry(y), band: BAND, comp: COMP, i, j });
    p.catch(() => plans.delete(key));
    plans.set(key, p);
    if (plans.size > 4000) plans.delete(plans.keys().next().value);
  }
  return plans.get(key);
}

// ---------------------------------------------------------------- village names
// The prototype shows each village heart's name as a map label (app.js, layer lm-names):
// Fell SC, 20 px at z16, ink #3a2410, halo rgba(252,240,205,0.85) 1.4 px blurred 0.8 px,
// moved down by 0.4 × (label height + 16 m) (chunks.js compose). Here they are painted at 2x
// into every tile they reach, from the 3×3 neighbourhood, so a name crossing a tile edge
// is drawn in both halves. Road and water names stay live labels in the app.
const FONT = new FontFace('Fell SC', 'url(/assets/fonts/IMFeENsc28P.ttf)');
document.fonts.add(await FONT.load());
const LABEL_PX = 20 * 2;
const CSS_PER_M = (512 * 2 ** BAND) / 40075016.686; // CSS px per mercator metre at z16

function paintNames(ctx, labels, BC, g) {
  const sx = CHUNK_PX / TS;
  ctx.save();
  ctx.font = `${LABEL_PX}px "Fell SC"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const L of labels) {
    const hM = (20 * 1.3) / CSS_PER_M;
    const wy = L.wy - 0.4 * (hM + 16 * g.kF);
    const px = (L.wx - BC[0]) * sx, py = (BC[3] - wy) * sx;
    if (px < -CHUNK_PX * 0.5 || px > CHUNK_PX * 1.5 || py < -60 || py > CHUNK_PX + 60) continue;
    ctx.filter = 'blur(1.6px)';
    ctx.strokeStyle = 'rgba(252,240,205,0.85)';
    ctx.lineWidth = 2 * 1.4 * 2;
    ctx.strokeText(L.name, px, py);
    ctx.filter = 'none';
    ctx.fillStyle = '#3a2410';
    ctx.fillText(L.name, px, py);
  }
  ctx.restore();
}

function toBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Paints z16 tile x/y. Returns { webp (base64), rgbaHash, labels, hearts, ms, tm }.
 * quality: WebP quality 0..1. For checks, opts.edges adds the raw pixels of the outer
 * EDGE_PX columns and rows ({ left, right, top, bottom }, base64 RGBA, before encoding), and
 * opts.plans the nine plans the paint used ({ "x/y": JSON }).
 */
const EDGE_PX = 3;
async function paintTile(x, y, quality, opts = {}) {
  const t0 = performance.now();
  const near = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (a || b) near.push(plan(x + a, y + b));
  const nearRegions = await Promise.all(near);
  const [i, j] = chunkOf(x, y);
  const g = geometry(y);
  const r = await run({ g, band: BAND, comp: COMP, i, j, nearPlans: nearRegions.map((n) => n.plan), persist: false });
  const canvas = new OffscreenCanvas(CHUNK_PX, CHUNK_PX);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(r.bitmap, 0, 0);
  r.bitmap.close();
  const BC = [i * TS, j * TS, (i + 1) * TS, (j + 1) * TS];
  const names = [r.reg.labels, ...nearRegions.map((n) => n.labels)].flat().filter((L) => L.big);
  paintNames(ctx, names, BC, g);
  // A hash of the raw pixels, to compare paints across processes independent of the encoder.
  const px = ctx.getImageData(0, 0, CHUNK_PX, CHUNK_PX).data;
  let h = 2166136261;
  for (let k = 0; k < px.length; k += 1) h = Math.imul(h ^ px[k], 16777619);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  const extra = {};
  if (opts.edges) {
    const strip = (sx0, sy0, w, h) => toBase64(ctx.getImageData(sx0, sy0, w, h).data.buffer);
    extra.edges = {
      left: strip(0, 0, EDGE_PX, CHUNK_PX),
      right: strip(CHUNK_PX - EDGE_PX, 0, EDGE_PX, CHUNK_PX),
      top: strip(0, 0, CHUNK_PX, EDGE_PX),
      bottom: strip(0, CHUNK_PX - EDGE_PX, CHUNK_PX, EDGE_PX),
    };
  }
  if (opts.plans) {
    extra.plans = { [`${x}/${y}`]: JSON.stringify(r.reg.plan) };
    let k = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (a || b) extra.plans[`${x + a}/${y + b}`] = JSON.stringify(nearRegions[k++].plan);
  }
  return {
    ...extra,
    webp: toBase64(await blob.arrayBuffer()),
    rgbaHash: (h >>> 0).toString(16),
    labels: r.reg.labels,
    hearts: r.reg.hearts ?? [],
    ms: Math.round(performance.now() - t0),
    tm: r.reg.tm,
  };
}

/** Scales four z16 children (base64 WebP, order NW NE SW SE; null = missing) into one z15 tile. */
async function downsample(children, quality) {
  const canvas = new OffscreenCanvas(CHUNK_PX, CHUNK_PX);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const half = CHUNK_PX / 2;
  await Promise.all(children.map(async (b64, k) => {
    if (!b64) return;
    const bmp = await createImageBitmap(new Blob([fromBase64(b64)], { type: 'image/webp' }));
    ctx.drawImage(bmp, (k % 2) * half, Math.floor(k / 2) * half, half, half);
    bmp.close();
  }));
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  return toBase64(await blob.arrayBuffer());
}

/**
 * For checks only: one chunk of the prototype's own grid (320 m, geometry from the view's
 * latitude as in chunks.js), so tiles can be compared with what the prototype paints.
 * Returns { png (base64), box (mercator bounds) }.
 */
async function paintProtoChunk(i, j, viewLat) {
  const kF = 1 / Math.cos(((Math.round(viewLat * 2) / 2) * Math.PI) / 180);
  const CW = 320 * kF;
  const chunkPx = Math.round((CW * 2 * 512 * 2 ** BAND) / 40075016.686);
  const sx = chunkPx / CW;
  const marginPx = Math.round(MARGIN_M * kF * sx);
  const g = { kF, q: 2, CW, chunkPx, sx, ppm: sx * kF, marginPx, M: marginPx / sx };
  const nearPlans = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (a || b) nearPlans.push((await run({ type: 'plan', g, band: BAND, comp: COMP, i: i + a, j: j + b })).plan);
  const r = await run({ g, band: BAND, comp: COMP, i, j, nearPlans, persist: false });
  const canvas = new OffscreenCanvas(chunkPx, chunkPx);
  canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { png: toBase64(await blob.arrayBuffer()), box: [i * CW, j * CW, (i + 1) * CW, (j + 1) * CW] };
}

/** For the re-sync check: the plan of tile x/y by chunkworker.js's own 'plan' and by tileworker.js. */
async function comparePlans(x, y) {
  const [i, j] = chunkOf(x, y);
  const msg = { g: geometry(y), band: BAND, comp: COMP, i, j };
  const [a, b] = await Promise.all([run({ type: 'plan', ...msg }), run({ type: 'planLabels', ...msg })]);
  return { chunkworker: JSON.stringify(a.plan), tileworker: JSON.stringify(b.plan), objects: a.plan.length };
}

window.comparePlans = comparePlans;
window.paintProtoChunk = paintProtoChunk;
window.paintTile = paintTile;
window.downsample = downsample;
window.rendererReady = true;
