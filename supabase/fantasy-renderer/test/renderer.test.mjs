// The renderer end to end, in headless Chromium, with the vendored painter's paintTile. Needs the network the first time (source
// tiles are then kept in .source/). Slow: about 10 s.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { startRenderer } from '../src/renderer.mjs';

const sourceDir = resolve(process.env.SOURCE_CACHE_DIR ?? '.source');
let a;
before(async () => {
  a = await startRenderer({ sourceDir, workers: 3 });
});
after(() => a?.close());

const md5 = (b) => createHash('md5').update(b).digest('hex');

test('the same tile gives the same pixels in another browser, in any order', async () => {
  const b = await startRenderer({ sourceDir, workers: 1 });
  try {
    const first = await a.paint(35209, 21498, 0.8);
    await b.paint(35210, 21499, 0.8); // b's caches hold other tiles first
    const second = await b.paint(35209, 21498, 0.8);
    assert.equal(second.rgbaHash, first.rgbaHash);
    assert.equal(md5(second.webp), md5(first.webp));
  } finally {
    await b.close();
  }
});

test('a tile is a 1024 px WebP of plausible size, and z15 is made from four children', async () => {
  const kids = await Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => a.paint(35208 + u, 21498 + v, 0.8)));
  for (const k of kids) {
    assert.equal(k.webp.subarray(0, 4).toString(), 'RIFF');
    assert.equal(k.webp.subarray(8, 12).toString(), 'WEBP');
    assert.ok(k.webp.length > 30_000 && k.webp.length < 400_000, `size ${k.webp.length}`);
  }
  const z15 = await a.downsample(kids.map((k) => k.webp), 0.8);
  assert.equal(z15.subarray(8, 12).toString(), 'WEBP');
  // VP8/VP8L/VP8X headers all carry the canvas size; read it from a decode in the page instead
  const size = await a.page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/webp' }));
    return [bmp.width, bmp.height];
  }, z15.toString('base64'));
  assert.deepEqual(size, [1024, 1024]);
});

test('after release() the browser is gone, and the next paint brings it back with the same pixels', async () => {
  const r = await startRenderer({ sourceDir, workers: 1 });
  try {
    const before = await r.paint(35209, 21498, 0.8);
    const pid = r.page.context().browser().process?.()?.pid;
    assert.equal(await r.release(), true);
    assert.equal(r.awake, false);
    if (pid) assert.throws(() => process.kill(pid, 0), 'the Chromium process has exited');
    const after = await r.paint(35209, 21498, 0.8);
    assert.equal(r.awake, true);
    assert.equal(after.rgbaHash, before.rgbaHash);
    assert.equal(md5(after.webp), md5(before.webp));
    // a z15 job right after a release also wakes it
    assert.equal(await r.release(), true);
    const z15 = await r.downsample([before.webp, after.webp, null, null], 0.8);
    assert.equal(z15.subarray(8, 12).toString(), 'WEBP');
  } finally {
    await r.close();
  }
});
