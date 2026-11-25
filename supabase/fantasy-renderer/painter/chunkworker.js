// PROTOTYPE, throwaway. A chunk painter running in a Web Worker (OffscreenCanvas): several of
// these paint chunks in parallel while the main thread only composes finished chunks.
import { paintRegion, SPR, ASSETS, spritesReady, texturesReady, assetsReady, off, provide, drawS } from './painter5.js';
import { ensure, features } from './tiledata.js';
import { NET } from './styles.js';

NET.ofm = self.location.origin + '/ofm/';
NET.dem = self.location.origin + '/dem/';
// worker canvases stay on the CPU: painting many small layers and handing over the result is faster
// there than through the GPU process (each flush and readback costs tens of milliseconds)
if (new URLSearchParams(self.location.search).get("cpu") !== "0") { const gc = OffscreenCanvas.prototype.getContext; OffscreenCanvas.prototype.getContext = function (t, o) { return gc.call(this, t, t === '2d' ? { willReadFrequently: true, ...(o || {}) } : o); }; }
const plans = new Map();
// one soft shadow, made once: a radial falloff stands in for a blurred ellipse (no canvas blur per chunk)
const SHADOW = (() => { const c = off(128, 128), x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(40,36,8,1)'); gr.addColorStop(0.45, 'rgba(40,36,8,0.95)'); gr.addColorStop(0.75, 'rgba(40,36,8,0.45)'); gr.addColorStop(1, 'rgba(40,36,8,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128); return c; })();
const touch = (key, val) => { plans.delete(key); plans.set(key, val); if (plans.size > 400) plans.delete(plans.keys().next().value); };
const box = (g, i, j) => [i * g.CW, j * g.CW, (i + 1) * g.CW, (j + 1) * g.CW];

async function region(g, band, comp, i, j, planOnly) {
  const BC = box(g, i, j);
  const te = performance.now();
  await ensure([BC[0] - 760 * g.kF, BC[1] - 760 * g.kF, BC[2] + 760 * g.kF, BC[3] + 760 * g.kF]);
  self.__ens = Math.round(performance.now() - te);
  return paintRegion({ chunk: BC, margin: g.M, band, ppm: g.ppm, kF: g.kF, q: g.q, lite: !!g.lite, comp, data: features, planOnly });
}
function plan(g, band, comp, i, j) {
  const key = `${band}|${comp}|${i}|${j}`;
  if (!plans.has(key)) touch(key, region(g, band, comp, i, j, true).then((r) => ({ plan: r.plan })));
  return plans.get(key);
}
const tBoot = performance.now();
async function chunk({ g, band, comp, i, j, nearPlans }) {
  // the tiles are fetched and decoded while the sprites and textures are still loading
  const t0 = performance.now(); let ready = 0; Promise.all([spritesReady, texturesReady, assetsReady]).then(() => { ready = Math.round(performance.now() - t0); });
  const sinceBoot = Math.round(t0 - tBoot);
  const reg = await region(g, band, comp, i, j, false);
  const t1 = performance.now();
  // the neighbours' plans come from the main thread (computed once, shared by all workers)
  const ps = [{ plan: reg.plan }, ...(nearPlans || []).map((p) => ({ plan: p }))];
  const c = off(g.chunkPx, g.chunkPx), x = c.getContext('2d');
  x.drawImage(reg.ground, -g.marginPx, -g.marginPx);
  const BC = box(g, i, j), Px = (wx) => (wx - BC[0]) * g.sx, Py = (wy) => (BC[3] - wy) * g.sx;
  const objs = [];
  for (const p of ps) for (const o of p.plan) {
    const w = o.w * g.ppm, h = o.h * g.ppm, px = Px(o.wx), py = Py(o.wy);
    if (px + w < 0 || px - w > g.chunkPx || py - h > g.chunkPx || py + h < 0) continue;
    objs.push({ ...o, px, py, wp: w, hp: h });
  }
  // soft contact shadows, then the sprites in ground order
  const s2 = x; x.save();
  // soft cast shadows towards the lower right (light from the upper left), longer for trees
  const miss = new Set(); for (const o of objs) if (!(SPR[o.name] || ASSETS[o.name]) && o.name !== 'plaza') miss.add(o.name); if (miss.size) console.error('missing sprites', [...miss].join(','));
  for (const o of objs) { if (!o.shadow || o.rot || !(SPR[o.name] || ASSETS[o.name])) continue; const tree = /deciduous|(^|-)pine|(^|-)forest|bush|tree|cypress/.test(o.name), rx = o.wp * o.foot * (tree ? 0.62 : 0.5), ry = rx * (tree ? 0.4 : 0.38); s2.globalAlpha = (tree ? 0.4 : 0.34) * o.shadow; const cx = o.px + rx * (tree ? 0.55 : 0.2), cy = o.py + ry * (tree ? 0.35 : 0.2); s2.drawImage(SHADOW, cx - rx * 1.35, cy - ry * 1.35, rx * 2.7, ry * 2.7); }
  x.restore();
  objs.sort((a, b) => (a.z - b.z) || (b.wy - a.wy) || (a.wx - b.wx));
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  for (const o of objs) {
    const img = SPR[o.name] || ASSETS[o.name]; if (!img) continue; // (a quick pass may come before the atlas)
    x.save(); x.translate(o.px, o.py); if (o.rot) x.rotate(o.rot); if (o.flip) x.scale(-1, 1);
    drawS(x, img, -o.wp * o.ax, -o.hp * o.ay, o.wp, o.hp); x.restore();
  }
  const t2 = performance.now();
  const bitmap = await createImageBitmap(c);
  const tmx = `ready ${ready} (boot+${sinceBoot}), ensure ${self.__ens}, ${reg.tm}, bake ${Math.round(t2 - t1)}, bitmap ${Math.round(performance.now() - t2)}, nobj ${objs.length}`;
  return { bitmap, canvas: c, reg: { plan: reg.plan, labels: reg.labels, heartInfo: reg.heartInfo, stubs: reg.stubs, hearts: reg.hearts, roads: reg.roads, chunk: reg.chunk, ms: Math.round(performance.now() - t0), tm: tmx } };
}
self.onmessage = async (e) => {
  if (e.data.type === 'tex' || e.data.type === 'atlas') { provide(e.data); return; }
  const { id } = e.data;
  try {
    if (e.data.type === 'plan') { const t0 = performance.now(); const r = await region(e.data.g, e.data.band, e.data.comp, e.data.i, e.data.j, true); self.postMessage({ id, plan: r.plan, ms: Math.round(performance.now() - t0) }); return; }
    const r = await chunk(e.data); self.postMessage({ id, bitmap: r.bitmap, reg: r.reg }, [r.bitmap]);
    // then store it for the next visit (WebP), after the picture is already on its way
    if (e.data.persist) { const blob = await r.canvas.convertToBlob({ type: 'image/webp', quality: 0.9 }); self.postMessage({ persist: true, key: e.data.key, blob, reg: r.reg }); }
  }
  catch (err) { self.postMessage({ id, error: String(err && err.stack || err) }); }
};
