// Runs in the headless browser: a pool of painter workers (tileworker.js), each painting whole
// z16 tiles with the vendored painter's paintTile, and the z15 downsampling.
const params = new URLSearchParams(location.search);
const N = Math.max(1, Number(params.get('workers')) || 4);
const PX = 1024;

const workers = Array.from({ length: N }, () => ({ w: new Worker('/page/tileworker.js', { type: 'module' }), busy: false }));
const queue = [];
const waiting = new Map();
let nextId = 1;
for (const wk of workers) {
  wk.w.onmessage = (e) => {
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

function toBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Paints z16 tile x/y. Returns { webp (base64), rgbaHash, labels, names, dropped, ms } and, with
 * opts.edges / opts.plans, the raw edge pixels (base64 RGBA) and the nine plans used.
 */
async function paintTile(x, y, quality, opts = {}) {
  const r = await run({ x, y, quality, opts });
  const out = { ...r, webp: toBase64(r.webp) };
  delete out.id;
  if (r.edges) out.edges = Object.fromEntries(Object.entries(r.edges).map(([k, v]) => [k, toBase64(v)]));
  return out;
}

/** Scales four z16 children (base64 WebP, order NW NE SW SE; null = missing) into one z15 tile. */
async function downsample(children, quality) {
  const canvas = new OffscreenCanvas(PX, PX);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const half = PX / 2;
  await Promise.all(children.map(async (b64, k) => {
    if (!b64) return;
    const bmp = await createImageBitmap(new Blob([fromBase64(b64)], { type: 'image/webp' }));
    ctx.drawImage(bmp, (k % 2) * half, Math.floor(k / 2) * half, half, half);
    bmp.close();
  }));
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  return toBase64(await blob.arrayBuffer());
}

window.paintTile = paintTile;
window.downsample = downsample;
window.rendererReady = true;
