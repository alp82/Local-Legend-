// A painter worker: the vendored painter's entry point (painter/tilepainter.js), unchanged, in a
// Web Worker of the headless browser. Each paint is exactly paintTile(16, x, y): the tile plus
// its fixed margin, never another window (the painter's rule: a different canvas window
// rounds differently).
//
// On top of the painter's pixels this adds the village names, painted in the prototype's label
// style from the labels of the tile and its eight neighbours, so a name across an edge is in
// both tiles. It returns the tile's road and water names for the app's live labels, keeping a
// road name only where a road the painter drew runs under its spot.
//
// Message { id, x, y, quality, opts } → { id, webp (ArrayBuffer), rgbaHash, labels, hearts, ms,
// edges?, plans? }. opts.edges: the raw outer EDGE_PX columns and rows; opts.plans: the nine
// plans the tile was drawn from (for test/neighbours.test.mjs).
import { NET } from '/painter/fmcore.js';
import { drawnNear } from '/painter/fmworld.js';
import { withData } from '/painter/tiledata.js';
import { loadAssets, paintTile, planTile } from '/painter/tilepainter.js';

NET.ofm = self.location.origin + '/ofm/';
NET.dem = self.location.origin + '/dem/';
// CPU canvases, as the painter's handover asks (tools/tileworker.js in the prototype)
{
  const gc = OffscreenCanvas.prototype.getContext;
  OffscreenCanvas.prototype.getContext = function (t, o) {
    return gc.call(this, t, t === '2d' ? { willReadFrequently: true, ...(o || {}) } : o);
  };
}

const PX = 1024;
const EDGE_PX = 3;
const HALF = 20037508.342789244;
const TS = (2 * HALF) / 2 ** 16;
/** A road name stays only this close (map metres) to a road the painter drew. */
const ON_ROAD_M = 4;

const ready = (async () => {
  await loadAssets(new URL('/assets/', self.location.origin));
  self.fonts.add(await new FontFace('Fell SC', 'url(/assets/fonts/IMFeENsc28P.ttf)').load());
})();

// ---------------------------------------------------------------- village names
// The prototype's viewer shows each heart's name as a map symbol (app.js, layer lm-names):
// Fell SC, 20 px at z16, centred on its fixed spot, ink #3a2410, halo rgba(252,240,205,0.85)
// 1.4 px blurred 0.8 px. Painted here at 2x.
function paintNames(ctx, labels, x, y) {
  const x0 = x * TS - HALF, y1 = HALF - y * TS, sx = PX / TS;
  ctx.save();
  ctx.font = '40px "Fell SC"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const L of labels) {
    const px = (L.wx - x0) * sx, py = (y1 - L.wy) * sx;
    if (px < -PX * 0.5 || px > PX * 1.5 || py < -60 || py > PX + 60) continue;
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

async function paint({ x, y, quality, opts = {} }) {
  await ready;
  const t0 = performance.now();
  const r = await paintTile(16, x, y);
  const near = [];
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) near.push({ key: `${x + a}/${y + b}`, reg: await planTile(x + a, y + b) });
  const ctx = r.canvas.getContext('2d');
  paintNames(ctx, near.flatMap((n) => n.reg.labels).filter((L) => L.big), x, y);

  const px = ctx.getImageData(0, 0, PX, PX).data;
  let h = 2166136261;
  for (let k = 0; k < px.length; k++) h = Math.imul(h ^ px[k], 16777619);
  const webp = await (await r.canvas.convertToBlob({ type: 'image/webp', quality })).arrayBuffer();

  // Live labels for the app: water names, and road names on roads the painter kept.
  const lines = await withData(() => r.labels.filter((L) => L.line && (L.water || drawnNear(L.wx, L.wy) <= ON_ROAD_M)));
  const out = {
    webp,
    rgbaHash: (h >>> 0).toString(16),
    labels: lines.map(({ name, wx, wy, rot, water }) => ({ name, wx, wy, rot: rot || 0, water: water ? 1 : 0 })),
    names: r.labels.filter((L) => L.big).map((L) => L.name),
    dropped: r.labels.filter((L) => L.line && !lines.includes(L)).map((L) => L.name),
    ms: Math.round(performance.now() - t0),
  };
  if (opts.edges) {
    const strip = (sx0, sy0, w, hh) => ctx.getImageData(sx0, sy0, w, hh).data.buffer;
    out.edges = { left: strip(0, 0, EDGE_PX, PX), right: strip(PX - EDGE_PX, 0, EDGE_PX, PX), top: strip(0, 0, PX, EDGE_PX), bottom: strip(0, PX - EDGE_PX, PX, EDGE_PX) };
  }
  if (opts.plans) out.plans = Object.fromEntries(near.map((n) => [n.key, JSON.stringify(n.reg.plan)]));
  return out;
}

self.onmessage = async (e) => {
  const { id } = e.data;
  try {
    const out = await paint(e.data);
    self.postMessage({ id, ...out }, [out.webp]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
