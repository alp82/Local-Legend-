// Tile arithmetic: XYZ tiles at z16 must coincide with the painter's chunks (CW = tile width).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lngLatOf, tileBounds, tileOf } from '../src/renderer.mjs';

const HALF = 20037508.342789244;
const TS = (2 * HALF) / 2 ** 16;

test('a z16 tile is the chunk i = x - 2^15, j = 2^15 - 1 - y', () => {
  for (const [x, y] of [[35209, 21498], [0, 0], [65535, 65535], [19295, 24639]]) {
    const [x0, y0, x1, y1] = tileBounds(x, y, 16);
    const i = x - 2 ** 15, j = 2 ** 15 - 1 - y;
    assert.ok(Math.abs(x0 - i * TS) < 1e-6 && Math.abs(x1 - (i + 1) * TS) < 1e-6);
    assert.ok(Math.abs(y0 - j * TS) < 1e-6 && Math.abs(y1 - (j + 1) * TS) < 1e-6);
  }
});

test('tileOf finds the tile under a point, and lngLatOf inverts mercator', () => {
  assert.deepEqual(tileOf(13.4140, 52.5005, 16), { x: 35209, y: 21498 });
  const [x0, y0, x1, y1] = tileBounds(35210, 21498, 16);
  const [lng, lat] = lngLatOf((x0 + x1) / 2, (y0 + y1) / 2);
  assert.deepEqual(tileOf(lng, lat, 16), { x: 35210, y: 21498 });
});
