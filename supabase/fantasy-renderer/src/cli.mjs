#!/usr/bin/env node
// Paints a block of tiles to a folder, for checks and for pre-painting an area.
//
//   node src/cli.mjs --at 13.4140,52.5005 --radius 1 --out out/berlin [--quality 0.8] [--workers 6]
//
// Writes <out>/16/x/y.webp, <out>/16/x/y.json (live labels, village names, pixel hash) and, with --z15,
// the z15 parents of complete 2×2 groups. Prints one line per tile and a summary.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { startRenderer, tileOf } from './renderer.mjs';

const { values: a } = parseArgs({
  options: {
    at: { type: 'string' },
    radius: { type: 'string', default: '1' },
    out: { type: 'string', default: 'out/tiles' },
    quality: { type: 'string', default: '0.8' },
    workers: { type: 'string', default: '6' },
    source: { type: 'string', default: process.env.SOURCE_CACHE_DIR ?? '.source' },
    z15: { type: 'boolean', default: false },
  },
});
if (!a.at) throw new Error('--at lng,lat is required');
const [lng, lat] = a.at.split(',').map(Number);
const R = Number(a.radius);
const quality = Number(a.quality);
const { x: cx, y: cy } = tileOf(lng, lat, 16);

const t0 = Date.now();
const r = await startRenderer({ sourceDir: resolve(a.source), workers: Number(a.workers), log: console.error });
console.log(`renderer ready in ${Date.now() - t0} ms (Chromium ${r.chromium})`);

const tiles = [];
for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) tiles.push([cx + dx, cy + dy]);
const painted = new Map();
const t1 = Date.now();
await Promise.all(
  tiles.map(async ([x, y]) => {
    const t = await r.paint(x, y, quality);
    painted.set(`${x}/${y}`, t.webp);
    const dir = join(a.out, '16', String(x));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${y}.webp`), t.webp);
    await writeFile(join(dir, `${y}.json`), JSON.stringify({ rgbaHash: t.rgbaHash, labels: t.labels, names: t.names, dropped: t.dropped, ms: t.ms }));
    console.log(`16/${x}/${y} ${t.ms} ms ${(t.webp.length / 1024).toFixed(0)} KB hash ${t.rgbaHash}${t.names.length ? ` | ${t.names.join(', ')}` : ''}${t.dropped.length ? ` | dropped road names: ${t.dropped.join(', ')}` : ''}`);
  }),
);
const wall = Date.now() - t1;
if (a.z15) {
  const parents = new Set(tiles.map(([x, y]) => `${x >> 1}/${y >> 1}`));
  for (const p of parents) {
    const [px, py] = p.split('/').map(Number);
    const kids = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => painted.get(`${px * 2 + u}/${py * 2 + v}`) ?? null);
    if (kids.some((k) => !k)) continue;
    const webp = await r.downsample(kids, quality);
    await mkdir(join(a.out, '15', String(px)), { recursive: true });
    await writeFile(join(a.out, '15', String(px), `${py}.webp`), webp);
    console.log(`15/${px}/${py} ${(webp.length / 1024).toFixed(0)} KB`);
  }
}
const sizes = [...painted.values()].map((b) => b.length);
console.log(
  `${tiles.length} tiles in ${wall} ms wall (${(wall / tiles.length).toFixed(0)} ms per tile with ${a.workers} workers); ` +
    `WebP q${quality}: mean ${(sizes.reduce((s, v) => s + v, 0) / sizes.length / 1024).toFixed(0)} KB, max ${(Math.max(...sizes) / 1024).toFixed(0)} KB; ` +
    `source tiles: ${r.stats.hit} stored, ${r.stats.miss} fetched`,
);
await r.close();
