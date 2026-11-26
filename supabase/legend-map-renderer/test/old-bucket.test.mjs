// The start-up copy of the old bucket (src/old-bucket.mjs) against a fake Supabase: it copies
// what the database lists until nothing is left, retries failures, stops when it makes no
// progress, and only accepts the database's check of the copy.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { copyOldBucket, OLD_BUCKET } from '../src/old-bucket.mjs';

function fake({ old, failing = new Set(), failOnce = new Set(), already = false }) {
  const copied = new Set();
  const calls = [];
  return {
    copied,
    calls,
    async rpc(fn) {
      calls.push(fn);
      if (fn === 'legend_map_bucket_copy_candidates') return already ? [] : old.filter((n) => !copied.has(n)).slice(0, 500).map((name) => ({ name }));
      if (fn === 'finish_legend_map_bucket_copy') {
        if (already) return { switched: false, already: true };
        const n = old.filter((x) => copied.has(x)).length;
        return n === old.length ? { switched: true, objects: old.length, bytes: old.length * 1000, copied: n } : { switched: false, objects: old.length, bytes: 0, copied: n };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    async copyFrom(bucket, name) {
      assert.equal(bucket, OLD_BUCKET);
      if (failing.has(name)) throw new Error('HTTP 500');
      if (failOnce.delete(name)) throw new Error('HTTP 503');
      copied.add(name);
    },
  };
}
const names = (n) => Array.from({ length: n }, (_, i) => `v1/16/${i}/0.webp`);
const quiet = { log: () => {} };

test('copies every listed file, in rounds, then has the database check it', async () => {
  const sb = fake({ old: names(1203) });
  const r = await copyOldBucket(sb, quiet);
  assert.equal(sb.copied.size, 1203);
  assert.deepEqual(r, { switched: true, objects: 1203, bytes: 1203000, copied: 1203 });
  assert.equal(sb.calls.filter((c) => c === 'legend_map_bucket_copy_candidates').length, 4); // 500, 500, 203, none
});

test('retries a file that failed once', async () => {
  const sb = fake({ old: names(10), failOnce: new Set(['v1/16/3/0.webp']) });
  assert.equal((await copyOldBucket(sb, quiet)).switched, true);
  assert.equal(sb.copied.size, 10);
});

test('stops when only files that cannot be copied are left', async () => {
  const sb = fake({ old: names(10), failing: new Set(['v1/16/3/0.webp']) });
  await assert.rejects(copyOldBucket(sb, quiet), /made no progress \(1 failed\): v1\/16\/3\/0\.webp: HTTP 500/);
  assert.ok(!sb.calls.includes('finish_legend_map_bucket_copy'), 'never asks for the switch');
});

test('does nothing once the copy has been checked', async () => {
  const sb = fake({ old: names(5), already: true });
  assert.deepEqual(await copyOldBucket(sb, quiet), { switched: false, already: true });
  assert.equal(sb.copied.size, 0);
});

test('refuses to go on when the database finds the copy incomplete', async () => {
  const sb = fake({ old: names(3) });
  sb.rpc = (orig => async (fn) => (fn === 'legend_map_bucket_copy_candidates' ? [] : orig(fn)))(sb.rpc.bind(sb));
  await assert.rejects(copyOldBucket(sb, quiet), /incomplete: 0 of 3 files/);
});
