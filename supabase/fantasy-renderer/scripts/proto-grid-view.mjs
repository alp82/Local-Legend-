#!/usr/bin/env node
// For checks only: paints the prototype's own 320 m chunks around a mercator point with the
// vendored painter and writes a phone view (780x1688 px, z16 at 2x), to tell differences
// caused by the XYZ tile grid apart from differences in the prototype itself.
//   node scripts/proto-grid-view.mjs <mx> <my> <out.png>
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { lngLatOf } from '../src/renderer.mjs';

const [mx, my, out] = process.argv.slice(2).map((v, k) => (k < 2 ? Number(v) : v));
const lat = lngLatOf(mx, my)[1];
const kF = 1 / Math.cos(((Math.round(lat * 2) / 2) * Math.PI) / 180);
const CW = 320 * kF;
const PX = (2 * 20037508.342789244) / 2 ** 16 / 1024; // metres per output pixel
const W = 780, H = 1688;
const x0 = mx - (W / 2) * PX, y1 = my + (H / 2) * PX, x1 = mx + (W / 2) * PX, y0 = my - (H / 2) * PX;
const server = await startServer({ sourceDir: resolve('.source') });
const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage();
await page.goto(`${server.url}/page/render.html?workers=8`);
await page.waitForFunction(() => window.rendererReady === true);
const jobs = [];
for (let i = Math.floor(x0 / CW); i <= Math.floor(x1 / CW); i++)
  for (let j = Math.floor(y0 / CW); j <= Math.floor(y1 / CW); j++) jobs.push(page.evaluate(([a, b, l]) => window.paintProtoChunk(a, b, l), [i, j, lat]));
const chunks = await Promise.all(jobs);
await mkdir('out/proto-grid', { recursive: true });
const parts = [];
for (const [k, c] of chunks.entries()) {
  const f = `out/proto-grid/c${k}.png`;
  await writeFile(f, Buffer.from(c.png, 'base64'));
  parts.push({ f, left: Math.round((c.box[0] - x0) / PX), top: Math.round((y1 - c.box[3]) / PX), size: Math.round(CW / PX) });
}
await writeFile('out/proto-grid/parts.json', JSON.stringify({ W, H, parts, out }));
await browser.close();
await server.close();
console.log(`${chunks.length} chunks; compose with scripts/compose-parts.py`);
