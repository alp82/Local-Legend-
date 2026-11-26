// The paint queue under parallel calls, through the real API of the LOCAL Supabase stack
// (separate connections, which a pgTAP test can't make): one player's parallel calls can't
// overshoot the per-player cap, and many accounts can't overshoot the global daily limit.
// Skipped when the local stack isn't running. Uses its own tile version and puts the
// configuration back afterwards.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

let env = null;
try {
  const out = execSync('npx supabase status -o env', { cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).toString();
  env = Object.fromEntries([...out.matchAll(/^(\w+)="(.*)"$/gm)].map((m) => [m[1], m[2]]));
  if (!env.API_URL?.startsWith('http://127.0.0.1')) env = null; // never anything but the local stack
} catch {}
const skip = env ? false : 'the local Supabase stack is not running';

const VERSION = 9999;
const BERLIN = [35209, 21498];
const cell = (x, y) => (BigInt(x) * 32n + 16n) * 2097152n + (BigInt(y) * 32n + 16n);

async function call(path, { method = 'GET', key, token, body, headers = {} } = {}) {
  const res = await fetch(`${env.API_URL}${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${token ?? key}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const admin = (path, opts = {}) => call(path, { ...opts, key: env.SERVICE_ROLE_KEY });

let savedConfig;
const players = [];

async function newPlayer() {
  const email = `queue-test-${randomUUID()}@example.test`;
  const password = randomUUID();
  const u = await admin('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const s = await call('/auth/v1/token?grant_type=password', { method: 'POST', key: env.PUBLISHABLE_KEY, token: env.PUBLISHABLE_KEY, body: { email, password } });
  // ground near Berlin, so the distance rule lets its requests through
  await admin('/rest/v1/claimed_cells', { method: 'POST', body: { user_id: u.id, cell: String(cell(...BERLIN)), first_claimed_at: new Date().toISOString() } });
  const p = { id: u.id, token: s.access_token };
  players.push(p);
  return p;
}
const request = (p, tiles) => call('/rest/v1/rpc/request_fantasy_tiles', { method: 'POST', key: env.PUBLISHABLE_KEY, token: p.token, body: { p_tiles: tiles, p_visible: 0 } });
const config = (patch) => admin('/rest/v1/fantasy_config?id=eq.true', { method: 'PATCH', body: patch });
const today = new Date().toISOString().slice(0, 10);
const globalToday = async () => (await admin(`/rest/v1/fantasy_daily?day=eq.${today}&select=tiles`))[0]?.tiles ?? 0;
// distinct tiles within 4 tiles of the claimed land (the distance rule allows about 3 km),
// a block of n per caller k
const near = (idx) => [16, BERLIN[0] - 4 + (idx % 9), BERLIN[1] - 4 + Math.floor(idx / 9)];
const block = (k, n) => Array.from({ length: n }, (_, i) => near(k * n + i));

before(async () => {
  if (skip) return;
  [savedConfig] = await admin('/rest/v1/fantasy_config?select=*');
  await config({ enabled: true, version: VERSION, min_request_interval: '0', max_queue_depth: 100000, global_daily_tiles: 1000000, daily_tiles_per_player: 300, near_player_m: 3000 });
});

after(async () => {
  if (skip) return;
  await config(savedConfig);
  await admin(`/rest/v1/fantasy_tiles?version=eq.${VERSION}`, { method: 'DELETE' });
  for (const p of players) await admin(`/auth/v1/admin/users/${p.id}`, { method: 'DELETE' });
});

test('parallel calls of one player cannot overshoot the per-player cap', { skip }, async () => {
  await config({ daily_tiles_per_player: 10 });
  const p = await newPlayer();
  const answers = await Promise.all(Array.from({ length: 8 }, (_, k) => request(p, block(k, 4))));
  const queued = answers.reduce((s, a) => s + a.queued, 0);
  assert.equal(queued, 10, `exactly the cap was queued (${queued})`);
  const [row] = await admin(`/rest/v1/fantasy_requests?player=eq.${p.id}&select=tiles`);
  assert.equal(row.tiles, 10, 'and counted');
  assert.ok(answers.some((a) => a.reason === 'player'), 'the calls past it were told why');
  await config({ daily_tiles_per_player: 300 });
});

test('many accounts together cannot overshoot the global daily limit', { skip }, async () => {
  const ps = [];
  for (let i = 0; i < 6; i++) ps.push(await newPlayer());
  await config({ global_daily_tiles: (await globalToday()) + 12 });
  const answers = await Promise.all(ps.map((p, k) => request(p, block(k + 8, 4))));
  const queued = answers.reduce((s, a) => s + a.queued, 0);
  assert.equal(queued, 12, `exactly the global room was queued (${queued})`);
  assert.ok(answers.some((a) => a.reason === 'global'), 'the calls past it were told why');
});

test('a z15 tile costs five units against the cap', { skip }, async () => {
  await config({ daily_tiles_per_player: 7, global_daily_tiles: 1000000 });
  const p = await newPlayer();
  const a = await request(p, [[15, BERLIN[0] >> 1, BERLIN[1] >> 1], near(80), [15, (BERLIN[0] >> 1) + 1, BERLIN[1] >> 1]]);
  // 5 + 1 = 6 fits in 7; the second z15 (5 more) doesn't
  assert.equal(a.queued, 2);
  assert.equal(a.reason, 'player');
  const [row] = await admin(`/rest/v1/fantasy_requests?player=eq.${p.id}&select=tiles`);
  assert.equal(row.tiles, 6);
});
