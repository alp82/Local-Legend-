#!/usr/bin/env node
// The largest width (px) each sprite is drawn at when a z16 tile is painted at 1024 px, over 5 × 5 tiles round
// each of six places. art/tools/sprites5.py packs every sprite at least that large, so nothing is drawn above its
// atlas size. Runs the painter in the renderer's own headless Chromium, with its frozen source data.
//
//   node art/tools/drawn-sizes.mjs      (from supabase/legend-map-renderer) → art/meta/drawn-max.json
//
// Run it after a painter change that can draw sprites larger (new scales, new pieces), then rebuild the atlases.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { startRenderer, tileOf } from '../../src/renderer.mjs';

const PLACES = {
  manhattan: [-73.97815, 40.7593],
  berlin: [13.414, 52.5005],
  amsterdam: [4.8839, 52.37335],
  innsbruck: [11.3924, 47.2699],
  village: [11.1838, 47.9741],
  suburb: [-118.556, 34.414],
};
const R = 6378137, HALF = Math.PI * R, T = (2 * HALF) / 65536, PPM = (1024 / T) * 1.4;

const renderer = await startRenderer({ sourceDir: resolve(process.env.SOURCE_CACHE_DIR || '.source'), workers: 1 });
const max = {};
try {
  for (const [place, ll] of Object.entries(PLACES)) {
    const { x: tx, y: ty } = tileOf(ll[0], ll[1], 16);
    // a module worker of its own: the painter's planTile over 5 × 5 tiles, with the renderer's data URLs
    const plans = await renderer.page.evaluate(async ([tx, ty]) => {
      const src = `
        import { loadAssets, planTile } from '${location.origin}/painter/tilepainter.js';
        import { NET } from '${location.origin}/painter/fmcore.js';
        NET.ofm = '${location.origin}/ofm/'; NET.dem = '${location.origin}/dem/';
        const gc = OffscreenCanvas.prototype.getContext;
        OffscreenCanvas.prototype.getContext = function (t, o) { return gc.call(this, t, t === '2d' ? { willReadFrequently: true, ...(o || {}) } : o); };
        await loadAssets(new URL('${location.origin}/assets/'));
        const out = [];
        for (let a = -2; a <= 2; a++) for (let d = -2; d <= 2; d++) {
          const r = await planTile(${tx} + a, ${ty} + d);
          for (const o of r.plan) out.push([o.name, o.w]);
        }
        postMessage(out);`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
      return await new Promise((ok, fail) => {
        w.onmessage = (e) => { ok(e.data); w.terminate(); };
        w.onerror = (e) => fail(new Error(e.message));
      });
    }, [tx, ty]);
    for (const [n, w] of plans) max[n] = Math.max(max[n] || 0, Math.ceil(w * PPM));
    console.log(`${place}: ${plans.length} drawn sprites`);
  }
} finally {
  await renderer.close();
}
const out = new URL('../meta/drawn-max.json', import.meta.url);
writeFileSync(out, JSON.stringify(Object.fromEntries(Object.entries(max).sort()), null, 0));
console.log(Object.keys(max).length, 'sprites measured →', out.pathname);
