// The hosted project's upgrade, rehearsed on the LOCAL Supabase stack: the database is reset to
// the migrations the hosted project has (up to 20261126090000), filled the way the live system
// filled it (a player's requests, the renderer user flagged with the earlier name painting
// through the earlier function names into the old bucket), then the later migrations are
// applied (releases, then the rename) and the cut-over's database step is run. Then:
//   - app versions from before the rename keep working (earlier names, old bucket),
//   - the new app works (new names, new bucket),
//   - the worker image from before the rename works until the painter fingerprint is recorded,
//   - the new worker's start-up copy moves every file server-side, the database checks it,
//     and the old app is pointed at the new bucket, with the same bytes and headers.
//
// It resets the local database twice (before, and to all migrations after), so it only runs
// with UPGRADE_TEST=on. Never anything but the local stack.
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { painterFingerprint } from '../src/fingerprint.mjs';
import { copyOldBucket } from '../src/old-bucket.mjs';
import { createSupabase } from '../src/supabase.mjs';

const HOSTED_VERSION = '20261126090000';
const root = new URL('../..', import.meta.url);
let cli = null;
let env = null;
if (process.env.UPGRADE_TEST === 'on') {
  for (const c of ['supabase', 'npx --no-install supabase']) {
    try {
      const out = execSync(`${c} status -o env`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).toString();
      env = Object.fromEntries([...out.matchAll(/^(\w+)="(.*)"$/gm)].map((m) => [m[1], m[2]]));
      if (!env.API_URL?.startsWith('http://127.0.0.1')) env = null;
      if (env) {
        cli = c;
        break;
      }
    } catch {}
  }
}
const skip = env ? false : 'UPGRADE_TEST=on and a running local Supabase stack are needed';
// local only: these commands never get --remote
function local(...args) {
  const [bin, ...pre] = cli.split(' ');
  return execFileSync(bin, [...pre, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 }).toString();
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
/** Rows of a query on the local database (as the SQL editor runs it: no JWT). */
function sql(q) {
  const text = local('db', 'query', q, '-o', 'json');
  if (!/^\s*[[{]/.test(text)) return text; // a command tag such as UPDATE 1
  const out = JSON.parse(text);
  return Array.isArray(out) ? out : out.rows;
}

const BERLIN = [35209, 21498];
const cell = (x, y) => (BigInt(x) * 32n + 16n) * 2097152n + (BigInt(y) * 32n + 16n);
const TILES = [[16, BERLIN[0], BERLIN[1]], [16, BERLIN[0] + 1, BERLIN[1]], [16, BERLIN[0], BERLIN[1] + 1]];
const webp = (seed) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(200 + seed * 37, seed)]);

const renderer = { email: 'fantasy-renderer@renderer.invalid', password: randomUUID() };
const player = { email: `upgrade-test-${randomUUID()}@example.test`, password: randomUUID() };
const files = new Map(); // path -> bytes

before(async () => {
  if (skip) return;
  local('db', 'reset', '--version', HOSTED_VERSION, '--no-seed');

  // The live system before the cut-over.
  const r = await admin('/auth/v1/admin/users', { method: 'POST', body: { ...renderer, email_confirm: true, app_metadata: { fantasy_renderer: true } } });
  renderer.id = r.id;
  const p = await admin('/auth/v1/admin/users', { method: 'POST', body: { ...player, email_confirm: true } });
  player.id = p.id;
  await admin('/rest/v1/claimed_cells', { method: 'POST', body: { user_id: p.id, cell: String(cell(...BERLIN)), first_claimed_at: new Date().toISOString() } });
  await admin('/rest/v1/fantasy_config?id=eq.true', { method: 'PATCH', body: { enabled: true, version: 1, min_request_interval: '0' } });

  const playerRpc = as(await signIn(player.email, player.password));
  const queued = await playerRpc('request_fantasy_tiles', { p_tiles: TILES, p_visible: 3 });
  assert.equal(queued.queued, 3, 'the old app queues tiles before the upgrade');

  // the worker image from before the rename: one-argument lease, old bucket, old flag
  const token = await signIn(renderer.email, renderer.password);
  const leased = await as(token)('lease_fantasy_tiles', { p_limit: 8 });
  assert.equal(leased.length, 3);
  for (const [i, t] of leased.entries()) {
    for (const [ext, type, bytes] of [['webp', 'image/webp', webp(i + 1)], ['json', 'application/json', Buffer.from(JSON.stringify({ i }))]]) {
      const path = `v1/${t.z}/${t.x}/${t.y}.${ext}`;
      await call(`/storage/v1/object/fantasy-tiles/${path}`, {
        method: 'POST', key: env.PUBLISHABLE_KEY, token, body: bytes,
        headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', 'x-upsert': 'true' },
      });
      files.set(path, bytes);
    }
    await as(token)('finish_fantasy_tile', { p_version: 1, p_z: t.z, p_x: t.x, p_y: t.y, p_ok: true, p_bytes: 1000, p_paint_ms: 10 });
  }

  // Then the upgrade: the release migration and the rename, as `supabase db push` applies them.
  local('migration', 'up');
});

after(() => {
  if (skip) return;
  local('db', 'reset'); // leave the local stack with every migration and its seed again
});

test('the upgrade keeps every client working and moves the tiles', { skip }, async () => {
  const playerToken = await signIn(player.email, player.password);
  const app = as(playerToken);
  const publicFile = (bucket, path) => call(`/storage/v1/object/public/${bucket}/${path}`, { raw: true });

  // The data moved along with the rename.
  const [{ n }] = sql("select count(*)::int as n from public.legend_map_tiles where status = 'ready'");
  assert.equal(n, 3, 'the painted tiles are still recorded');

  // The app from before the rename: earlier names, the old bucket.
  let cfg = await app('get_fantasy_config');
  assert.deepEqual(cfg, { enabled: true, version: 1, bucket: 'fantasy-tiles' });
  let req = await app('request_fantasy_tiles', { p_tiles: TILES, p_visible: 3 });
  assert.equal(req.ready.length, 3, 'the old app still gets its ready tiles');
  for (const [path, bytes] of files) {
    const res = await publicFile('fantasy-tiles', path);
    assert.equal(res.status, 200, `old bucket serves ${path}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  }

  // The new app: new names, the new bucket.
  assert.deepEqual(await app('get_legend_map_config'), { enabled: true, version: 1, bucket: 'legend-map-tiles' });
  assert.equal((await app('request_legend_map_tiles', { p_tiles: TILES, p_visible: 3 })).ready.length, 3);

  // The worker image from before the rename still leases (nothing queued now: an empty lease) ...
  const oldWorker = as(await signIn(renderer.email, renderer.password));
  assert.deepEqual(await oldWorker('lease_fantasy_tiles', { p_limit: 8 }), []);
  // ... until the cut-over records the live painter (docs/legend-map-deploy.md, "Rename cut-over").
  const fp = painterFingerprint();
  sql(`update public.legend_map_config set fingerprint = '${fp}' where id`);
  sql('insert into public.legend_map_versions (version, fingerprint, released_at, webp_quality) select version, fingerprint, now(), webp_quality from public.legend_map_config');
  await assert.rejects(oldWorker('lease_fantasy_tiles', { p_limit: 8 }), (e) => e.status === 403 || /predates releases/.test(e.body ?? ''));

  // The new worker, still signed in with the earlier flag and address: copies before painting.
  const sb = createSupabase(env.API_URL, { publishableKey: env.PUBLISHABLE_KEY, ...renderer });
  const logs = [];
  const copy = await copyOldBucket(sb, { log: (m) => logs.push(m) });
  assert.equal(copy.switched, true, logs.join('\n'));
  assert.equal(copy.objects, files.size);
  assert.equal(Number(copy.bytes), [...files.values()].reduce((s, b) => s + b.length, 0), 'the database checked the bytes');
  for (const [path, bytes] of files) {
    const res = await publicFile('legend-map-tiles', path);
    assert.equal(res.status, 200, `new bucket serves ${path}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes, `${path}: same bytes`);
    assert.equal(res.headers.get('content-type'), path.endsWith('.webp') ? 'image/webp' : 'application/json', `${path}: same type`);
    assert.match(res.headers.get('cache-control') ?? '', /max-age=31536000/, `${path}: same caching`);
  }
  assert.equal((await copyOldBucket(sb, { log: () => {} })).already, true, 'a restart copies nothing');
  const begin = await sb.rpc('begin_legend_map_release', { p_fingerprint: fp });
  assert.equal(begin.action, 'current', 'the new worker carries on with version 1');

  // The old app now reads the new bucket; the old one stays readable.
  cfg = await app('get_fantasy_config');
  assert.equal(cfg.bucket, 'legend-map-tiles');
  assert.equal((await publicFile('fantasy-tiles', [...files.keys()][0])).status, 200, 'the old bucket stays readable');

  // The renderer user moves to the new flag and address (the admin API merges app_metadata).
  const moved = await admin(`/auth/v1/admin/users/${renderer.id}`, {
    method: 'PUT', body: { email: 'legend-map-renderer@renderer.invalid', email_confirm: true, app_metadata: { legend_map_renderer: true } },
  });
  assert.equal(moved.app_metadata.legend_map_renderer, true);
  assert.equal(moved.app_metadata.fantasy_renderer, true, 'the earlier flag stays until the compatibility layer goes');
  const sb2 = createSupabase(env.API_URL, { publishableKey: env.PUBLISHABLE_KEY, email: 'legend-map-renderer@renderer.invalid', password: renderer.password });
  assert.deepEqual(await sb2.rpc('lease_legend_map_tiles', { p_limit: 8, p_fingerprint: fp }), []);
  assert.equal((await sb2.rpc('legend_map_status')).version, 1);
  // a new tile goes to the new bucket only
  await sb2.upload('v1/16/1/1.webp', webp(9));
  assert.equal((await publicFile('legend-map-tiles', 'v1/16/1/1.webp')).status, 200);
  assert.notEqual((await publicFile('fantasy-tiles', 'v1/16/1/1.webp')).status, 200);
});
