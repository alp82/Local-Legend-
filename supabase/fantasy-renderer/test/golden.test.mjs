// Golden tiles: a fixed 2 × 2 block of z16 tiles (a Bavarian village, Andechs) and its z15 parent, painted from
// frozen source data in test/fixtures/golden-source (3.7 MB, no network), compared by hash with test/golden.json.
//
// This is what proves the painter fingerprint (src/fingerprint.mjs):
// - fingerprint unchanged → the tiles must paint exactly the recorded bytes. If they don't, either something
//   outside the fingerprint's inputs changed the pixels (add it to src/fingerprint.mjs) or painting isn't
//   deterministic any more;
// - fingerprint changed → the recorded hashes are for another painter. Record them again:
//     npm run golden:update
//   and commit test/golden.json with the change, so the review shows which tiles changed.
//
// Run it in the pinned Chromium: Playwright 1.65.1 here, or the worker image in CI. Pixels from another
// Chromium build differ, and the fingerprint covers the build (Playwright version and base image).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { painterFingerprint } from '../src/fingerprint.mjs';
import { labelJson } from '../src/paint-output.mjs';
import { startRenderer } from '../src/renderer.mjs';

const GOLDEN = new URL('./golden.json', import.meta.url);
const FIXTURE = new URL('./fixtures/golden-source/', import.meta.url);
const QUALITY = 0.75;
const Z15 = [17401, 11394];
const CHILDREN = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [Z15[0] * 2 + u, Z15[1] * 2 + v]); // NW NE SW SE
const md5 = (b) => createHash('md5').update(b).digest('hex');

async function paintGolden() {
  // a writable copy (the store writes its counters); no fetching: every source tile must be in the fixture
  const dir = mkdtempSync(join(tmpdir(), 'golden-source-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const env = { ...process.env };
  process.env.SOURCE_FETCHES_PER_DAY = '0';
  process.env.SOURCE_PREFETCH_KM = '0';
  const r = await startRenderer({ sourceDir: dir, workers: 1 });
  try {
    const tiles = {};
    const webps = [];
    for (const [x, y] of CHILDREN) {
      const t = await r.paint(x, y, QUALITY);
      tiles[`16/${x}/${y}`] = { rgba: t.rgbaHash, webp: md5(t.webp), labels: md5(labelJson(t.labels)) };
      webps.push(t.webp);
    }
    tiles[`15/${Z15[0]}/${Z15[1]}`] = { webp: md5(await r.downsample(webps, QUALITY)) };
    return { chromium: r.chromium, tiles };
  } finally {
    await r.close();
    process.env.SOURCE_FETCHES_PER_DAY = env.SOURCE_FETCHES_PER_DAY ?? '';
    process.env.SOURCE_PREFETCH_KM = env.SOURCE_PREFETCH_KM ?? '';
    if (!env.SOURCE_FETCHES_PER_DAY) delete process.env.SOURCE_FETCHES_PER_DAY;
    if (!env.SOURCE_PREFETCH_KM) delete process.env.SOURCE_PREFETCH_KM;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('golden tiles: the same painter fingerprint paints the same bytes', { timeout: 600_000 }, async () => {
  const fingerprint = painterFingerprint();
  const painted = await paintGolden();
  if (process.env.GOLDEN_UPDATE === '1') {
    writeFileSync(GOLDEN, JSON.stringify({ fingerprint, chromium: painted.chromium, quality: QUALITY, tiles: painted.tiles }, null, 2) + '\n');
    console.log(`recorded test/golden.json for painter ${fingerprint}`);
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.equal(
    fingerprint,
    golden.fingerprint,
    `the painter fingerprint changed (${golden.fingerprint} → ${fingerprint}). If that's intended, record the new golden tiles: npm run golden:update`,
  );
  assert.equal(painted.chromium, golden.chromium, 'another Chromium build than the one the golden tiles were painted with');
  assert.deepEqual(
    painted.tiles,
    golden.tiles,
    'the golden tiles changed although the painter fingerprint did not: something outside src/fingerprint.mjs changes pixels, or painting is no longer deterministic',
  );
});
