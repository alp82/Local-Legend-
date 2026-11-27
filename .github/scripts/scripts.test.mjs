// Tests for the deploy pipeline's scripts: node --test .github/scripts/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCK_TIMEOUT, parseNameStatus, plan } from './plan.mjs';
import { gate } from './runtime-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const tree = (files = {}) => ({
  migrations: Object.keys(files).filter((p) => p.startsWith('supabase/migrations/')).map((p) => p.split('/').pop()),
  functions: ['detours', 'sites', 'terrain'],
  read: (p) => files[p],
});

test('the gate publishes only when both platforms match a tester build', () => {
  const installed = { android: [A], ios: [B] };
  assert.equal(gate({ android: A, ios: B }, installed).ok, true);
  const native = gate({ android: 'c'.repeat(40), ios: B }, installed);
  assert.equal(native.ok, false);
  assert.match(native.lines[0], /android: c{40} matches no tester build .* make and distribute a new build first/);
  assert.equal(gate({ android: A, ios: '' }, installed).ok, false, 'a missing fingerprint never publishes');
  assert.equal(gate({ android: A, ios: B }, { android: [A] }).ok, false, 'a platform with no recorded build never publishes');
});

test('lock_timeout must be set by a statement, not mentioned in a comment', () => {
  assert.ok(LOCK_TIMEOUT.test("-- note\nset lock_timeout = '3s';\nalter table x add y int;"));
  assert.ok(LOCK_TIMEOUT.test("SET LOCAL lock_timeout TO '5s';"));
  assert.ok(!LOCK_TIMEOUT.test("-- set lock_timeout = '3s';\nalter table x add y int;"));
  assert.ok(!LOCK_TIMEOUT.test('alter table x add y int;'));
});

test('the plan: added migrations, functions by folder, the painter, the app', () => {
  const files = {
    'supabase/migrations/20261125210000_fantasy_tiles.sql': 'create table t();', // before the baseline: exempt
    'supabase/migrations/20261201000000_new.sql': "set lock_timeout = '3s';\nselect 1;",
  };
  const p = plan(parseNameStatus([
    'A\tsupabase/migrations/20261201000000_new.sql',
    'M\tsupabase/functions/sites/index.ts',
    'M\tsupabase/legend-map-renderer/src/worker.mjs',
    'M\tmobile/src/app/debug.tsx',
    'M\tdocs/deploy.md',
  ].join('\n')), tree(files));
  assert.deepEqual(p, { migrations: true, added_migrations: ['20261201000000_new.sql'], functions: ['sites'], painter: true, mobile: true, refused: [] });
});

test('a shared function file or the config redeploys every function; docs deploy nothing', () => {
  assert.deepEqual(plan(parseNameStatus('M\tsupabase/functions/_shared/openfreemap.ts'), tree()).functions, ['detours', 'sites', 'terrain']);
  assert.deepEqual(plan(parseNameStatus('M\tsupabase/config.toml'), tree()).functions, ['detours', 'sites', 'terrain']);
  assert.deepEqual(plan(parseNameStatus('M\tdocs/x.md\nM\tREADME.md'), tree()),
    { migrations: false, added_migrations: [], functions: [], painter: false, mobile: false, refused: [] });
});

test('a modified, renamed or deleted migration is refused, and so is one without lock_timeout', () => {
  const files = { 'supabase/migrations/20261201000000_new.sql': 'alter table x add y int;' };
  const p = plan(parseNameStatus([
    'M\tsupabase/migrations/20261126200000_legend_map_rename.sql',
    'D\tsupabase/migrations/20261125210000_fantasy_tiles.sql',
    'R100\tsupabase/migrations/20261126150000_fantasy_releases.sql\tsupabase/migrations/20261126150001_x.sql',
    'A\tsupabase/migrations/20261201000000_new.sql',
  ].join('\n')), tree(files));
  assert.equal(p.migrations, true);
  assert.equal(p.refused.length, 4);
  assert.match(p.refused.join('\n'), /20261126200000_legend_map_rename\.sql: modified/);
  assert.match(p.refused.join('\n'), /20261125210000_fantasy_tiles\.sql: deleted/);
  assert.match(p.refused.join('\n'), /20261126150000_fantasy_releases\.sql: renamed/);
  assert.match(p.refused.join('\n'), /20261201000000_new\.sql: no "set lock_timeout/);
});

test('plan.mjs on a real repository: outputs, and exit 1 on a modified migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
  git('init', '-q');
  git('config', 'user.email', 't@example.test');
  git('config', 'user.name', 't');
  write('supabase/migrations/20261125210000_old.sql', 'create table t();');
  write('supabase/functions/sites/index.ts', 'export {};');
  write('supabase/functions/_shared/x.ts', 'export {};');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  write('supabase/migrations/20261201000000_new.sql', "set lock_timeout = '3s';\nselect 1;");
  write('supabase/functions/sites/index.ts', 'export const x = 1;');
  git('add', '-A');
  git('commit', '-qm', 'good');
  const good = git('rev-parse', 'HEAD');
  const out = join(dir, 'out.txt');
  writeFileSync(out, '');
  execFileSync('node', [join(here, 'plan.mjs'), base, good], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out }, stdio: 'pipe' });
  const outputs = Object.fromEntries(execFileSync('cat', [out], { encoding: 'utf8' }).trim().split('\n').map((l) => l.split('=')));
  assert.deepEqual(outputs, { migrations: 'true', added_migrations: '20261201000000_new.sql', functions: 'sites', painter: 'false', mobile: 'false' });

  write('supabase/migrations/20261125210000_old.sql', 'create table t(); -- edited');
  git('commit', '-qam', 'bad');
  const bad = git('rev-parse', 'HEAD');
  assert.throws(() => execFileSync('node', [join(here, 'plan.mjs'), base, bad], { cwd: dir, stdio: 'pipe' }), (e) =>
    e.status === 1 && /20261125210000_old\.sql: modified/.test(e.stderr.toString()));
});

test('the repository itself passes the migration rules', () => {
  const root = join(here, '../..');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('node', [join(here, 'plan.mjs'), head, head], { cwd: root, stdio: 'pipe' });
});
