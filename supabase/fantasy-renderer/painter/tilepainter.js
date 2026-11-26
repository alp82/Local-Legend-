// The entry point for painting one z16 tile (the server's unit): paintTile(16, x, y) → 1024 × 1024 RGBA
// pixels, plus the tile's labels. Runs wherever OffscreenCanvas, createImageBitmap, DOMMatrix and fetch
// exist (a browser page, a Web Worker, headless Chromium); no DOM, no map view.
//
//   import { loadAssets, paintTile } from './tilepainter.js';
//   await loadAssets(new URL('./sprites5/', import.meta.url));   // once
//   const { pixels, labels } = await paintTile(16, 34322, 22950); // pixels: ImageData 1024 × 1024
//
// A tile's picture is a pure function of (x, y) and the data: the ground is painted for the tile plus a
// margin, the sprites come from the plans of the tile and its eight neighbours, and every decision that
// crosses a tile edge is the world plan's (fmworld.js). Two tiles painted on different machines months apart
// meet without a seam. paintWindow() paints any rectangle of world pixels the same way (the purity check
// uses it to paint a tile from other windows).
import { paintRegion, provide, bake, off, spritesReady, texturesReady } from './painter5.js';
import { withData } from './tiledata.js';
import { KF, HALF } from './fmcore.js';
import { TILE } from './fmworld.js';

export const BAND = 16, TILE_PX = 1024;
const SX = TILE_PX / TILE, PPM = SX * KF;           // canvas px per mercator unit, per map metre
const MARGIN_PX = 160;                               // ≥ 60 map metres: the reach of every blur, band and closing
const PLAN_MARGIN = 60 * KF;                         // a plan's own window (as in chunkworker.js)

/** Fetch and decode the painter's assets (sprites5/bundle.json, its textures and atlas sheets, index.json). */
export async function loadAssets(base) {
  const get = async (u) => { const r = await fetch(new URL(u, base)); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r; };
  const list = await (await get('bundle.json')).json();
  const tex = await Promise.all(list.textures.map(async (n) => [n, await (await get(`tex-${n}.webp`)).arrayBuffer()]));
  await provide({ type: 'tex', tex });
  const [idx, sheets] = await Promise.all([get('index.json').then((r) => r.json()), Promise.all((list.sheets || ['atlas.webp']).map(async (f) => (await get(f)).arrayBuffer()))]);
  await provide({ type: 'atlas', idx, sheets });
  await Promise.all([spritesReady, texturesReady]); // (decoded, and the world plan knows which drawings exist)
}

// the plan of z16 tile (x, y) (x east, y south, as in the tile URL): kept, it never changes
const plans = new Map();
const tileRect = (x, y) => { const i = x - 2 ** 15, j = 2 ** 15 - 1 - y; return [i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE]; };
export function planTile(x, y) {
  const key = x + '/' + y;
  if (!plans.has(key)) { const p = withData(() => paintRegion({ chunk: tileRect(x, y), margin: PLAN_MARGIN, band: BAND, ppm: PPM, planOnly: true })); p.catch(() => plans.delete(key)); plans.set(key, p); if (plans.size > 600) plans.delete(plans.keys().next().value); }
  return plans.get(key);
}

/**
 * Paint a rectangle of z16 world pixels (px0, py0 from the world's top-left corner, w × h px).
 * Returns { canvas, pixels (ImageData), labels (those inside the rectangle), hearts }.
 */
export async function paintWindow(px0, py0, w, h) {
  const rect = [px0 / SX - HALF, HALF - (py0 + h) / SX, (px0 + w) / SX - HALF, HALF - py0 / SX];
  // the plans of every tile the window touches, and one ring round them (sprites reach across edges)
  const tx0 = Math.floor(px0 / TILE_PX) - 1, tx1 = Math.floor((px0 + w - 1) / TILE_PX) + 1, ty0 = Math.floor(py0 / TILE_PX) - 1, ty1 = Math.floor((py0 + h - 1) / TILE_PX) + 1;
  const regs = [];
  for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) regs.push(await planTile(x, y));
  const ps = regs.map((r) => r.plan);
  const reg = await withData(() => paintRegion({ chunk: rect, margin: MARGIN_PX / SX, band: BAND, ppm: PPM, plans: ps }));
  const c = off(w, h), x = c.getContext('2d');
  x.drawImage(reg.ground, -MARGIN_PX, -MARGIN_PX);
  bake(x, ps, rect, SX);
  const inside = (L) => L.wx >= rect[0] && L.wx < rect[2] && L.wy >= rect[1] && L.wy < rect[3];
  return { canvas: c, pixels: x.getImageData(0, 0, w, h), labels: regs.flatMap((r) => r.labels).filter(inside), hearts: regs.flatMap((r) => r.hearts), regs };
}

/** Paint z16 tile (x, y): 1024 × 1024 RGBA pixels and the labels whose spot lies in the tile. */
export async function paintTile(z, x, y) {
  if (z !== BAND) throw new Error('paintTile paints z16 tiles (z15 is made by scaling four of them down)');
  const r = await paintWindow(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
  return { pixels: r.pixels, canvas: r.canvas, labels: r.labels };
}
