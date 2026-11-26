// The frozen source store's limits: when it is full, or the day's upstream fetches are used
// up, tiles on known ground still paint and tiles that need new data fail with the reason,
// fast, instead of filling the disk or hammering the tile services. Uses the source data the
// other tests stored for Berlin (run after them, or with network once).
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { startRenderer } from '../src/renderer.mjs';

const sourceDir = resolve(process.env.SOURCE_CACHE_DIR ?? '.source');
const KNOWN = [35209, 21498]; // Berlin, painted by the other tests
const NEW = [40500, 30500]; // central Africa: never fetched

async function withLimits(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const r = await startRenderer({ sourceDir, workers: 1 });
  try {
    await fn(r);
  } finally {
    await r.close();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('a full source store paints known ground and refuses new ground', async () => {
  await withLimits({ SOURCE_MAX_MB: '1' }, async (r) => {
    const known = await r.paint(...KNOWN, 0.75);
    assert.ok(known.webp.length > 30_000, 'the known tile is painted');
    const t0 = Date.now();
    await assert.rejects(r.paint(...NEW, 0.75), /source store full/);
    assert.ok(Date.now() - t0 < 30_000, 'and the new one fails fast');
    const s = await r.sourceStatus();
    assert.match(s.limited, /source store full/);
    assert.ok(s.diskFreeMb > 0, 'the status shows free disk space');
  });
});

test('after the day\'s source fetches, new ground waits for the next day', async () => {
  await withLimits({ SOURCE_FETCHES_PER_DAY: '0' }, async (r) => {
    assert.ok((await r.paint(...KNOWN, 0.75)).webp.length > 30_000, 'the known tile is painted');
    await assert.rejects(r.paint(...NEW, 0.75), /daily source fetch limit reached/);
    assert.equal((await r.sourceStatus()).maxFetchesPerDay, 0);
  });
});
