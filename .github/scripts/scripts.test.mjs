// Tests for the deploy pipeline's scripts: node --test .github/scripts/scripts.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMPONENT_JOBS, isAncestor, lastDeployed } from './deployed.mjs';
import { dryRunMigrations } from './dry-run-migrations.mjs';
import { appliedAmong } from './never-applied.mjs';
import { functionsPlan, isApp, isPainter, LOCK_TIMEOUT, migrationPlan, parseNameStatus, touches } from './plan.mjs';
import { gate } from './runtime-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ns = (...lines) => parseNameStatus(lines.join('\n'));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
  const commit = (m) => { git('add', '-A'); git('commit', '-qm', m); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  git('config', 'user.email', 't@example.test');
  git('config', 'user.name', 't');
  return { dir, git, write, commit };
}
function runPlan(dir, args) {
  const out = join(dir, `out-${Math.random()}.txt`);
  writeFileSync(out, '');
  const res = { status: 0, stdout: '' };
  try {
    res.stdout = execFileSync('node', [join(here, 'plan.mjs'), ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, v])],
      { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out }, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    res.status = e.status;
    res.stdout = e.stdout.toString();
  }
  res.outputs = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return res;
}
const allBases = (head, base, before = base) => ({ head, before, 'migrations-base': base, 'functions-base': base, 'painter-base': base, 'app-base': base });

test('the gate publishes only when both platforms match a tester build', () => {
  const installed = { android: [A], ios: [B] };
  assert.equal(gate({ android: A, ios: B }, installed).ok, true);
  const native = gate({ android: 'c'.repeat(40), ios: B }, installed);
  assert.equal(native.ok, false);
  assert.match(native.lines[0], /android: c{40} matches no tester build .* make and distribute a new build first/);
  assert.equal(gate({ android: A, ios: '' }, installed).ok, false, 'a missing fingerprint never publishes');
  assert.equal(gate({ android: A, ios: B }, { android: [A] }).ok, false, 'a platform with no recorded build never publishes');
});

test('lock_timeout must be set for the session by a statement, not in a comment and not "set local"', () => {
  assert.ok(LOCK_TIMEOUT.test("-- note\nset lock_timeout = '3s';\nalter table x add y int;"));
  assert.ok(LOCK_TIMEOUT.test("SET lock_timeout TO '5s';"));
  assert.ok(!LOCK_TIMEOUT.test("SET LOCAL lock_timeout TO '5s';"), 'set local is lost when the CLI splits the file');
  assert.ok(!LOCK_TIMEOUT.test("-- set lock_timeout = '3s';\nalter table x add y int;"));
  assert.ok(!LOCK_TIMEOUT.test('alter table x add y int;'));
});

test('migration rules: added files, edits since the base or since <before>, order, lock_timeout', () => {
  const read = (p) => ({ 'supabase/migrations/20261201000000_new.sql': "set lock_timeout = '3s';", 'supabase/migrations/20261202000000_bad.sql': 'select 1;' })[p] ?? '';
  const ok = migrationPlan({ changes: ns('A\tsupabase/migrations/20261201000000_new.sql'), sinceBefore: ns('A\tsupabase/migrations/20261201000000_new.sql'),
    beforeNewest: '20261126200000', migrations: ['20261126200000_legend_map_rename.sql', '20261201000000_new.sql'], read });
  assert.deepEqual(ok, { migrations: true, added_migrations: ['20261201000000_new.sql'], changed_unapplied: [], refused: [] });

  // PR 1 added M (applied), a later step failed; PR 2 edits M: it's "added" since the base, but modified since <before>
  const edited = migrationPlan({ changes: ns('A\tsupabase/migrations/20261201000000_new.sql'), sinceBefore: ns('M\tsupabase/migrations/20261201000000_new.sql'),
    beforeNewest: '20261201000000', migrations: ['20261201000000_new.sql'], read });
  assert.match(edited.refused.join('\n'), /20261201000000_new\.sql: modified/);

  const bad = migrationPlan({
    changes: ns('M\tsupabase/migrations/20261126200000_legend_map_rename.sql', 'D\tsupabase/migrations/20261125210000_fantasy_tiles.sql',
      'R100\tsupabase/migrations/20261126150000_fantasy_releases.sql\tsupabase/migrations/20261126150001_x.sql', 'A\tsupabase/migrations/20261202000000_bad.sql'),
    sinceBefore: ns('A\tsupabase/migrations/20261125000000_late.sql'),
    beforeNewest: '20261126200000', migrations: ['20261202000000_bad.sql'], read,
  });
  const r = bad.refused.join('\n');
  assert.match(r, /20261126200000_legend_map_rename\.sql: modified/);
  assert.match(r, /20261125210000_fantasy_tiles\.sql: deleted/);
  assert.match(r, /20261126150000_fantasy_releases\.sql: renamed/);
  assert.match(r, /20261125000000_late\.sql: sorts before 20261126200000.*rename it with a later timestamp/);
  assert.match(r, /20261202000000_bad\.sql: no "set lock_timeout/);
  assert.equal(bad.refused.length, 5);
});

test('functions by folder; a shared file or the config means all; painter and app paths', () => {
  const all = ['detours', 'sites', 'terrain'];
  assert.deepEqual(functionsPlan(ns('M\tsupabase/functions/sites/index.ts', 'M\tdocs/x.md'), all), ['sites']);
  assert.deepEqual(functionsPlan(ns('M\tsupabase/functions/_shared/openfreemap.ts'), all), all);
  assert.deepEqual(functionsPlan(ns('M\tsupabase/config.toml'), all), all);
  assert.deepEqual(functionsPlan(ns('M\tsupabase/functions/gone/index.ts'), all), [], 'a deleted function is not deployed');
  assert.ok(touches(ns('M\tsupabase/legend-map-renderer/src/worker.mjs'), isPainter));
  assert.ok(touches(ns('M\t.github/workflows/legend-map-renderer.yml'), isPainter));
  assert.ok(touches(ns('M\tmobile/src/app/debug.tsx'), isApp));
  assert.ok(!touches(ns('M\tdocs/deploy.md', 'M\tREADME.md'), (p) => isPainter(p) || isApp(p)));
});

test('plan.mjs on a real repository: each part counts from its own base', () => {
  const { dir, write, commit } = repo();
  write('supabase/migrations/20261125210000_old.sql', 'create table t();');
  write('supabase/functions/sites/index.ts', 'export {};');
  write('mobile/a.ts', '1');
  const c0 = commit('base');
  write('supabase/functions/sites/index.ts', 'export const x = 1;');
  write('mobile/a.ts', '2');
  const c1 = commit('functions and app change; the app update then waits for a native build');
  write('supabase/migrations/20261201000000_new.sql', "set lock_timeout = '3s';\nselect 1;");
  const c2 = commit('a migration');
  // functions were deployed at c1; the app never since c0
  const res = runPlan(dir, { head: c2, before: c1, 'migrations-base': c1, 'functions-base': c1, 'painter-base': c1, 'app-base': c0 });
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(res.outputs, { migrations: 'true', added_migrations: '20261201000000_new.sql', changed_unapplied: '', functions: '', painter: 'false', mobile: 'true' });
});

test('plan.mjs exits 1 on an edited migration, and on one older than main\'s newest', () => {
  const { dir, write, commit } = repo();
  write('supabase/migrations/20261201000000_a.sql', "set lock_timeout = '3s';");
  write('supabase/functions/.keep', '');
  const c0 = commit('base');
  write('supabase/migrations/20261201000000_a.sql', "set lock_timeout = '3s'; -- edited");
  const c1 = commit('edit');
  const edited = runPlan(dir, allBases(c1, c0));
  assert.equal(edited.status, 1);
  assert.match(edited.stdout, /::error::supabase\/migrations\/20261201000000_a\.sql: modified/);
  write('supabase/migrations/20261201000000_a.sql', "set lock_timeout = '3s';");
  write('supabase/migrations/20261130000000_late.sql', "set lock_timeout = '3s';");
  const c2 = commit('late');
  const late = runPlan(dir, allBases(c2, c0));
  assert.equal(late.status, 1);
  assert.match(late.stdout, /20261130000000_late\.sql: sorts before 20261201000000/);
});

test('the repository itself passes the migration rules', () => {
  const root = join(here, '../..');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const res = runPlan(root, allBases(head, head));
  assert.equal(res.status, 0, res.stdout);
});

test('a part\'s base is the newest run whose job for it succeeded', async () => {
  const runs = [
    { id: 1, run_number: 1, head_sha: '1'.repeat(40) },
    { id: 3, run_number: 3, head_sha: '3'.repeat(40) },
    { id: 2, run_number: 2, head_sha: '2'.repeat(40) },
  ];
  const jobs = {
    1: [{ name: COMPONENT_JOBS.functions, conclusion: 'success' }, { name: COMPONENT_JOBS.app, conclusion: 'success' }],
    2: [{ name: COMPONENT_JOBS.functions, conclusion: 'success' }, { name: COMPONENT_JOBS.app, conclusion: 'skipped' }],
    3: [{ name: COMPONENT_JOBS.functions, conclusion: 'failure' }, { name: COMPONENT_JOBS.painter, conclusion: 'success' }],
  };
  const api = async (path) => {
    if (path.includes('/workflows/deploy.yml/runs')) return { workflow_runs: path.includes('page=1') ? runs : [] };
    return { jobs: jobs[path.match(/runs\/(\d+)\/jobs/)[1]] };
  };
  assert.equal(await lastDeployed(api, 'o/r', COMPONENT_JOBS.functions), '2'.repeat(40), 'run 3 failed: run 2');
  assert.equal(await lastDeployed(api, 'o/r', COMPONENT_JOBS.app), '1'.repeat(40), 'skipped is not deployed');
  assert.equal(await lastDeployed(api, 'o/r', COMPONENT_JOBS.painter), '3'.repeat(40));
  assert.equal(await lastDeployed(api, 'o/r', COMPONENT_JOBS.migrations), '', 'never deployed');
});

test('the guard: an older run may not deploy over a newer one', () => {
  const { dir, write, commit } = repo();
  write('f', '1');
  const old = commit('old');
  write('f', '2');
  const newer = commit('newer');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  assert.equal(isAncestor(old, newer, git), true, 'a newer run may deploy');
  assert.equal(isAncestor(newer, newer, git), true, 'a re-run of the same commit may deploy');
  assert.equal(isAncestor(newer, old, git), false, 're-running the older run may not');
  assert.equal(isAncestor('', old, git), true, 'nothing deployed yet');
});

test('the dry run\'s JSON is parsed, anything else fails', () => {
  assert.deepEqual(dryRunMigrations('{"upToDate":false,"dryRun":true,"migrations":["20261201000000_new.sql"],"seeds":[]}'), ['20261201000000_new.sql']);
  assert.deepEqual(dryRunMigrations('{"upToDate":true,"dryRun":true,"migrations":[]}'), []);
  assert.throws(() => dryRunMigrations('Finished supabase db push.'), /isn't JSON/);
  assert.throws(() => dryRunMigrations('{"dryRun":false,"migrations":[]}'), /unexpected/);
  assert.throws(() => dryRunMigrations('{"dryRun":true,"migrations":["x; rm -rf /"]}'), /unexpected/);
});

test('a migration listed as never applied may be fixed, renamed or deleted; the deploy checks the hosted history', () => {
  const read = () => "set lock_timeout = '3s';";
  const p = migrationPlan({
    changes: ns('M\tsupabase/migrations/20261201000000_broken.sql', 'D\tsupabase/migrations/20261130000000_late.sql', 'A\tsupabase/migrations/20261202000000_late.sql'),
    sinceBefore: ns('M\tsupabase/migrations/20261201000000_broken.sql', 'D\tsupabase/migrations/20261130000000_late.sql', 'A\tsupabase/migrations/20261202000000_late.sql'),
    beforeNewest: '20261201000000', migrations: ['20261201000000_broken.sql', '20261202000000_late.sql'], read,
    neverApplied: ['20261201000000', '20261130000000'],
  });
  assert.deepEqual(p.refused, []);
  assert.deepEqual(p.changed_unapplied, ['20261130000000', '20261201000000']);
  assert.equal(p.migrations, true);
  const history = JSON.stringify({ migrations: [{ local: '20261126200000', remote: '20261126200000' }, { local: '20261201000000', remote: '' }] });
  assert.deepEqual(appliedAmong(history, ['20261201000000', '20261130000000']), [], 'neither reached the hosted project');
  assert.deepEqual(appliedAmong(history, ['20261126200000']), ['20261126200000'], 'an applied one is caught');
  assert.throws(() => appliedAmong('{"_tag":"Error"}', ['1']), /unexpected migration list output/);
});
