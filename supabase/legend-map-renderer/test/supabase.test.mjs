// The worker's Storage calls (src/supabase.mjs) against a fake fetch: while the compatibility
// layer of the rename exists, every file goes to the new bucket and then the old one, with the
// same type and caching, and a failed second write fails the upload (so the tile is retried).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createSupabase } from '../src/supabase.mjs';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeFetch(status = () => 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const s = status(String(url));
    return new Response(s === 200 ? '{}' : 'nope', { status: s });
  };
  return calls;
}
const sb = () => createSupabase('http://127.0.0.1:54321', { secretKey: 'sb_secret_test' });

test('a file goes to the new bucket, then to the old one, the same way', async () => {
  const calls = fakeFetch();
  await sb().upload('v1/16/5/6.json', Buffer.from('{}'), 'application/json');
  assert.deepEqual(calls.map((c) => c.url), [
    'http://127.0.0.1:54321/storage/v1/object/legend-map-tiles/v1/16/5/6.json',
    'http://127.0.0.1:54321/storage/v1/object/fantasy-tiles/v1/16/5/6.json',
  ]);
  for (const c of calls) {
    assert.equal(c.method, 'POST');
    assert.equal(c.headers['content-type'], 'application/json');
    assert.equal(c.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(c.headers['x-upsert'], 'true');
  }
});

test('a failed write to the old bucket fails the upload', async () => {
  fakeFetch((url) => (url.includes('/fantasy-tiles/') ? 403 : 200));
  await assert.rejects(sb().upload('v1/16/5/6.webp', Buffer.from('x')), /upload fantasy-tiles\/v1\/16\/5\/6\.webp: HTTP 403/);
});

test('the copy is server-side, from the old bucket to the same path in the new one', async () => {
  const calls = fakeFetch();
  await sb().copyFrom('fantasy-tiles', 'v1/15/2/3.webp');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:54321/storage/v1/object/copy');
  assert.deepEqual(JSON.parse(calls[0].body), {
    bucketId: 'fantasy-tiles', sourceKey: 'v1/15/2/3.webp', destinationBucket: 'legend-map-tiles', destinationKey: 'v1/15/2/3.webp',
  });
});
