// The hosted project's upgrade, rehearsed in a THROWAWAY local Supabase stack
// (test/upgrade-throwaway.sh makes one and deletes it afterwards):
//   1. Only the migrations the hosted project has (up to 20261126090000), filled the way the
//      live system filled it: a player's requests, and the renderer user flagged with the
//      earlier name painting through the earlier function names into the old bucket. Plus
//      1,100 more old files (several pages of the copy) and one the copy can't take.
//   2. The release migration, then the rename while another transaction holds a lock on
//      storage.objects: it must give up within seconds and change nothing, and the earlier
//      names keep answering. Then the rename again, as the runbook says.
//   3. The cut-over's database step. Then app versions from before the rename, the new app,
//      the old worker (refused once the painter fingerprint is recorded), the new worker's
//      start-up copy (stopping when it makes no progress, then complete, checked by the
//      database, same bytes and headers), and the second write to the old bucket.
//
// It resets the database it runs against, so it refuses anything but a throwaway project:
// UPGRADE_TEST=on and UPGRADE_WORKDIR (a folder with a supabase/ project whose project_id isn't
// this repository's) are required.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { painterFingerprint } from '../src/fingerprint.mjs';
import { copyOldBucket } from '../src/old-bucket.mjs';
import { createSupabase } from '../src/supabase.mjs';

const HOSTED_VERSION = '20261126090000';
const RELEASES = '20261126150000_fantasy_releases.sql';
const RENAME = '20261126200000_legend_map_rename.sql';
const repoSupabase = fileURLToPath(new URL('../..', import.meta.url));
const projectId = (dir) => readFileSync(join(dir, 'config.toml'), 'utf8').match(/^project_id = "(.*)"$/m)?.[1];

const work = process.env.UPGRADE_WORKDIR ? resolve(process.env.UPGRADE_WORKDIR) : null;
let skip = false;
if (process.env.UPGRADE_TEST !== 'on') skip = 'UPGRADE_TEST=on is needed (use test/upgrade-throwaway.sh)';
else if (!work || !existsSync(join(work, 'supabase/config.toml'))) skip = 'UPGRADE_WORKDIR must name a throwaway project (use test/upgrade-throwaway.sh)';
else if (resolve(work, 'supabase') === resolve(repoSupabase) || projectId(join(work, 'supabase')) === projectId(repoSupabase)) {
  throw new Error(`refusing to run: ${work} is this repository's own Supabase project, not a throwaway one`);
}

const cli = (() => {
  try {
    execFileSync('supabase', ['--version'], { stdio: 'ignore' });
    return ['supabase'];
  } catch {
    return ['npx', '--no-install', 'supabase'];
  }
})();
/** The throwaway stack only: every command gets --workdir, none gets --remote. */
function local(...args) {
  return execFileSync(cli[0], [...cli.slice(1), ...args, '--workdir', work], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 }).toString();
}
let env = null;
if (!skip) {
  env = Object.fromEntries([...local('status', '-o', 'env').matchAll(/^(\w+)="(.*)"$/gm)].map((m) => [m[1], m[2]]));
  if (!env.API_URL?.startsWith('http://127.0.0.1:') || env.API_URL.endsWith(':54321')) throw new Error(`refusing to run against ${env.API_URL}`);
}

async function call(path, { method = 'GET', key, token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${env.API_URL}${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${token ?? key}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  if (raw) return res;
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`), { status: res.status, body: text });
  return text ? JSON.parse(text) : null;
}
const admin = (path, opts = {}) => call(path, { ...opts, key: env.SERVICE_ROLE_KEY });
const signIn = async (email, password) =>
  (await call('/auth/v1/token?grant_type=password', { method: 'POST', key: env.PUBLISHABLE_KEY, token: env.PUBLISHABLE_KEY, body: { email, password } })).access_token;
const as = (token) => (fn, body = {}) => call(`/rest/v1/rpc/${fn}`, { method: 'POST', key: env.PUBLISHABLE_KEY, token, body });
const publicFile = (bucket, path) => call(`/storage/v1/object/public/${bucket}/${path}`, { raw: true });
/** Rows of a query (as the SQL editor runs it: no JWT), or the command tag. */
function sql(q) {
  const text = local('db', 'query', q, '-o', 'json');
  if (!/^\s*[[{]/.test(text)) return text;
  const out = JSON.parse(text);
  return Array.isArray(out) ? out : out.rows;
}
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

const BERLIN = [35209, 21498];
const cell = (x, y) => (BigInt(x) * 32n + 16n) * 2097152n + (BigInt(y) * 32n + 16n);
const TILES = [[16, BERLIN[0], BERLIN[1]], [16, BERLIN[0] + 1, BERLIN[1]], [16, BERLIN[0], BERLIN[1] + 1]];
const webp = (seed) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(200 + (seed % 500) * 7, seed % 256)]);
const CACHE = 'public, max-age=31536000, immutable';
const EXTRA = 1100;
const ODD = 'v1/16/notatile.json'; // stored with the secret key; the new bucket's policies refuse the name

const renderer = { email: 'fantasy-renderer@renderer.invalid', password: randomUUID() };
const player = { email: `upgrade-test-${randomUUID()}@example.test`, password: randomUUID() };
const painted = new Map(); // path -> bytes, painted by the old worker
const migrations = join(work ?? '.', 'supabase/migrations');
const later = join(work ?? '.', 'later-migrations');
let lockTest;

before(async () => {
  if (skip) return;
  // 1. The hosted project's migrations only.
  mkdirSync(later, { recursive: true });
  for (const f of readdirSync(migrations)) if (f.slice(0, 14) > HOSTED_VERSION) renameSync(join(migrations, f), join(later, f));
  // the two the hosted project lacked on November 26, 2026; any newer ones are applied at the end, on top
  assert.deepEqual(readdirSync(later).sort().slice(0, 2), [RELEASES, RENAME], 'the release and rename migrations come first');
  local('db', 'reset', '--no-seed');

  const r = await admin('/auth/v1/admin/users', { method: 'POST', body: { ...renderer, email_confirm: true, app_metadata: { fantasy_renderer: true } } });
  renderer.id = r.id;
  const p = await admin('/auth/v1/admin/users', { method: 'POST', body: { ...player, email_confirm: true } });
  await admin('/rest/v1/claimed_cells', { method: 'POST', body: { user_id: p.id, cell: String(cell(...BERLIN)), first_claimed_at: new Date().toISOString() } });
  await admin('/rest/v1/fantasy_config?id=eq.true', { method: 'PATCH', body: { enabled: true, version: 1, min_request_interval: '0' } });

  const queued = await as(await signIn(player.email, player.password))('request_fantasy_tiles', { p_tiles: TILES, p_visible: 3 });
  assert.equal(queued.queued, 3, 'the old app queues tiles before the upgrade');

  // the worker image from before the rename: one-argument lease, old bucket, old flag
  const token = await signIn(renderer.email, renderer.password);
  const leased = await as(token)('lease_fantasy_tiles', { p_limit: 8 });
  assert.equal(leased.length, 3);
  for (const [i, t] of leased.entries()) {
    for (const [ext, type, bytes] of [['webp', 'image/webp', webp(i + 1)], ['json', 'application/json', Buffer.from(JSON.stringify({ i }))]]) {
      const path = `v1/${t.z}/${t.x}/${t.y}.${ext}`;
      await call(`/storage/v1/object/fantasy-tiles/${path}`, {
        method: 'POST', key: env.PUBLISHABLE_KEY, token, body: bytes, headers: { 'content-type': type, 'cache-control': CACHE, 'x-upsert': 'true' },
      });
      painted.set(path, bytes);
    }
    await as(token)('finish_fantasy_tile', { p_version: 1, p_z: t.z, p_x: t.x, p_y: t.y, p_ok: true, p_bytes: 1000, p_paint_ms: 10 });
  }
  // more old files: the copy then takes several pages of 500
  await pool(Array.from({ length: EXTRA }, (_, i) => i), 16, (i) =>
    admin(`/storage/v1/object/fantasy-tiles/v1/16/${40000 + i}/20000.webp`, {
      method: 'POST', body: webp(i), headers: { 'content-type': 'image/webp', 'cache-control': CACHE, 'x-upsert': 'true' },
    }),
  );
  await admin(`/storage/v1/object/fantasy-tiles/${ODD}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-upsert': 'true' } });

  // 2. The release migration, then the rename against a held lock, then the rename again.
  renameSync(join(later, RELEASES), join(migrations, RELEASES));
  local('migration', 'up');
  renameSync(join(later, RENAME), join(migrations, RENAME));
  const holder = spawn('docker', ['exec', `supabase_db_${projectId(join(work, 'supabase'))}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-c', 'begin; select count(*) from storage.objects; select pg_sleep(15); commit;'], { stdio: 'ignore' });
  const held = new Promise((res) => holder.on('exit', res));
  await new Promise((res) => setTimeout(res, 2000));
  const t0 = Date.now();
  let error = null;
  try {
    local('migration', 'up');
  } catch (e) {
    error = `${e.stderr ?? ''}${e.stdout ?? ''}${e.message}`;
  }
  lockTest = { error, seconds: (Date.now() - t0) / 1000 };
  lockTest.oldConfigWhileFailed = await as(await signIn(player.email, player.password))('get_fantasy_config');
  lockTest.renamedWhileFailed = sql("select to_regclass('public.legend_map_config') is not null as renamed")[0].renamed;
  await held;
  local('migration', 'up');
});

test('the upgrade keeps every client working and moves the tiles', { skip }, async () => {
  // The rename gives up on a held lock instead of waiting, and changes nothing.
  assert.ok(lockTest.error, 'the rename failed while storage.objects was locked');
  assert.match(lockTest.error, /lock timeout/);
  assert.ok(lockTest.seconds < 12, `it gave up after ${lockTest.seconds} s, before the lock was released`);
  assert.equal(lockTest.renamedWhileFailed, false, 'nothing of the rename was applied');
  assert.equal(lockTest.oldConfigWhileFailed.bucket, 'fantasy-tiles', 'the earlier names kept answering');

  const app = as(await signIn(player.email, player.password));
  const [{ n }] = sql("select count(*)::int as n from public.legend_map_tiles where status = 'ready'");
  assert.equal(n, 3, 'the painted tiles are still recorded');

  // Before the copy both config calls name the old bucket, which holds every tile.
  assert.deepEqual(await app('get_fantasy_config'), { enabled: true, version: 1, bucket: 'fantasy-tiles' });
  assert.deepEqual(await app('get_legend_map_config'), { enabled: true, version: 1, bucket: 'fantasy-tiles' });
  assert.equal((await app('request_fantasy_tiles', { p_tiles: TILES, p_visible: 3 })).ready.length, 3, 'the old app still gets its ready tiles');
  assert.equal((await app('request_legend_map_tiles', { p_tiles: TILES, p_visible: 3 })).ready.length, 3, 'and so does the new one');
  for (const [path, bytes] of painted) {
    const res = await publicFile('fantasy-tiles', path);
    assert.equal(res.status, 200, `old bucket serves ${path}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  }

  // The old worker still leases (nothing queued: an empty lease) until the cut-over records the painter.
  const oldWorker = as(await signIn(renderer.email, renderer.password));
  assert.deepEqual(await oldWorker('lease_fantasy_tiles', { p_limit: 8 }), []);
  const fp = painterFingerprint();
  sql(`update public.legend_map_config set fingerprint = '${fp}' where id`);
  sql('insert into public.legend_map_versions (version, fingerprint, released_at, webp_quality) select version, fingerprint, now(), webp_quality from public.legend_map_config');
  await assert.rejects(oldWorker('lease_fantasy_tiles', { p_limit: 8 }), (e) => /predates releases/.test(e.body ?? ''));

  // The new worker, still with the earlier flag and address. A file it can't copy stops it ...
  const sb = createSupabase(env.API_URL, { publishableKey: env.PUBLISHABLE_KEY, ...renderer });
  await assert.rejects(copyOldBucket(sb, { log: () => {} }), new RegExp(`made no progress \\(1 failed\\): ${ODD}`));
  assert.equal((await app('get_fantasy_config')).bucket, 'fantasy-tiles', 'nothing switched');
  const [{ copied }] = sql("select count(*)::int as copied from storage.objects where bucket_id = 'legend-map-tiles'");
  assert.equal(copied, painted.size + EXTRA, 'everything else was copied, over several pages');

  // ... until it's gone; then the copy completes and the database checks it.
  await admin('/storage/v1/object/fantasy-tiles', { method: 'DELETE', body: { prefixes: [ODD] } });
  const logs = [];
  const copy = await copyOldBucket(sb, { log: (m) => logs.push(m) });
  assert.equal(copy.switched, true, logs.join('\n'));
  assert.equal(copy.objects, painted.size + EXTRA);
  const [sums] = sql("select sum((metadata->>'size')::bigint)::text as bytes from storage.objects where bucket_id = 'fantasy-tiles'");
  assert.equal(String(copy.bytes), sums.bytes, 'the database checked the bytes');
  const [meta] = sql(`select count(*)::int as files,
      count(*) filter (where n.metadata->>'mimetype' = o.metadata->>'mimetype' and n.metadata->>'cacheControl' = o.metadata->>'cacheControl')::int as same_headers,
      count(*) filter (where n.metadata->>'eTag' = o.metadata->>'eTag')::int as same_etag
    from storage.objects o join storage.objects n on n.bucket_id = 'legend-map-tiles' and n.name = o.name where o.bucket_id = 'fantasy-tiles'`);
  assert.equal(meta.same_headers, meta.files, 'every copy keeps its content type and cache control');
  console.log(`# eTag kept by the local backend's copy: ${meta.same_etag} of ${meta.files}`);
  for (const [path, bytes] of painted) {
    const res = await publicFile('legend-map-tiles', path);
    assert.equal(res.status, 200, `new bucket serves ${path}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes, `${path}: same bytes`);
    assert.equal(res.headers.get('content-type'), path.endsWith('.webp') ? 'image/webp' : 'application/json', `${path}: same type`);
    assert.match(res.headers.get('cache-control') ?? '', /max-age=31536000/, `${path}: same caching`);
  }
  assert.equal((await copyOldBucket(sb, { log: () => {} })).already, true, 'a restart copies nothing');
  assert.equal((await sb.rpc('begin_legend_map_release', { p_fingerprint: fp })).action, 'current', 'the new worker carries on with version 1');

  // Both config calls now name the new bucket; the old one stays readable.
  assert.equal((await app('get_fantasy_config')).bucket, 'legend-map-tiles');
  assert.equal((await app('get_legend_map_config')).bucket, 'legend-map-tiles');
  assert.equal((await publicFile('fantasy-tiles', [...painted.keys()][0])).status, 200, 'the old bucket stays readable');

  // The renderer user moves to the new flag and address (the admin API merges app_metadata).
  const moved = await admin(`/auth/v1/admin/users/${renderer.id}`, {
    method: 'PUT', body: { email: 'legend-map-renderer@renderer.invalid', email_confirm: true, app_metadata: { legend_map_renderer: true } },
  });
  assert.equal(moved.app_metadata.legend_map_renderer, true);
  assert.equal(moved.app_metadata.fantasy_renderer, true, 'the earlier flag stays until the compatibility layer goes');
  const sb2 = createSupabase(env.API_URL, { publishableKey: env.PUBLISHABLE_KEY, email: 'legend-map-renderer@renderer.invalid', password: renderer.password });
  assert.deepEqual(await sb2.rpc('lease_legend_map_tiles', { p_limit: 8, p_fingerprint: fp }), []);
  assert.equal((await sb2.rpc('legend_map_status')).version, 1);

  // A new file goes to both buckets: an app still open on the old bucket sees it too.
  const fresh = webp(9);
  await sb2.upload('v1/16/1/1.webp', fresh);
  for (const bucket of ['legend-map-tiles', 'fantasy-tiles']) {
    const res = await publicFile(bucket, 'v1/16/1/1.webp');
    assert.equal(res.status, 200, `${bucket} has the new file`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fresh);
  }

  // Migrations added since the rename apply on top of the upgraded state, with its data.
  const newer = readdirSync(later).sort();
  for (const f of newer) renameSync(join(later, f), join(migrations, f));
  if (newer.length) local('migration', 'up');
  assert.deepEqual(readdirSync(later), [], `and the newer migrations applied too (${newer.join(', ') || 'none'})`);
});
