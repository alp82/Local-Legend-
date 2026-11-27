// Tests for the deploy pipeline's scripts: node --test .github/scripts/scripts.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ANCHOR, bases, JOBS, newerAttempts, upToDate } from './deployed.mjs';
import { dryRunMigrations } from './dry-run-migrations.mjs';
import { appliedAmong } from './never-applied.mjs';
import { functionsPlan, isApp, isPainter, LOCK_TIMEOUT, migrationPlan, parseNameStatus, touches } from './plan.mjs';
import { gate, NO_MATCH, parseRuntimes } from './runtime-gate.mjs';

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
  const out = join(mkdtempSync(join(tmpdir(), 'plan-out-')), 'github-output.txt');
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
  assert.throws(() => gate({ android: A, ios: '' }, installed), /ios: no valid fingerprint/, 'a missing fingerprint is an error, not "waiting"');
  assert.equal(gate({ android: A, ios: B }, { android: [A] }).ok, false, 'a platform with no recorded build never publishes');
  assert.throws(() => parseRuntimes('{"android": ["x"], "ios": []}'), /"android" must be a list of 40-hex/);
  assert.throws(() => parseRuntimes('not json'));
  assert.deepEqual(parseRuntimes(readFileSync(join(here, '../app-runtimes.json'), 'utf8')).android.length, 1);
});

test('the gate\'s exit codes: 0 publish, 2 waiting for a native build, 1 broken', () => {
  const run = (args, runtimes) => {
    const f = join(mkdtempSync(join(tmpdir(), 'gate-')), 'r.json');
    writeFileSync(f, runtimes);
    try {
      execFileSync('node', [join(here, 'runtime-gate.mjs'), ...args, '--runtimes', f], { stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  const good = JSON.stringify({ android: [A], ios: [B] });
  assert.equal(run(['--android', A, '--ios', B], good), 0);
  assert.equal(run(['--android', 'c'.repeat(40), '--ios', B], good), NO_MATCH);
  assert.equal(run(['--android', A, '--ios', ''], good), 1, 'an empty fingerprint');
  assert.equal(run(['--android', A, '--ios', B], '{"android": ['), 1, 'a malformed app-runtimes.json');
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

const S = (n) => String(n).repeat(40);
function history(runs) {
  // runs: [{ n, jobs: { name: conclusion } }], any order; run ids = numbers
  return async (path) => {
    if (path.includes('/workflows/deploy.yml/runs')) {
      return { workflow_runs: path.includes('page=1') ? runs.map((r) => ({ id: r.n, run_number: r.n, head_sha: S(r.n % 10), status: r.status ?? 'completed', conclusion: r.conclusion ?? 'success' })) : [] };
    }
    return { jobs: Object.entries(runs.find((r) => r.n === Number(path.match(/runs\/(\d+)\/jobs/)[1])).jobs).map(([name, conclusion]) => ({ name, conclusion })) };
  };
}
const ran = (extra = {}) => ({ [JOBS.plan]: 'success', [JOBS.migrations]: 'skipped', [JOBS.functions]: 'skipped', [JOBS.painterCaller]: 'skipped', [JOBS.appCheck]: 'skipped', [JOBS.app]: 'skipped', ...extra });

test('up to date: a successful job, or skipped because nothing of the part changed; not a waiting app update', () => {
  assert.deepEqual(upToDate(ran()), { migrations: true, functions: true, painter: true, app: true }, 'nothing changed anywhere');
  assert.deepEqual(upToDate(ran({ [JOBS.migrations]: 'failure' })), { migrations: false, functions: false, painter: false, app: false },
    'a failed migration: the later parts were skipped for that reason, not because nothing changed');
  assert.equal(upToDate(ran({ [JOBS.appCheck]: 'success', [JOBS.app]: 'skipped' })).app, false, 'waiting for a native build');
  assert.equal(upToDate(ran({ [JOBS.appCheck]: 'success', [JOBS.app]: 'success' })).app, true);
  const painterCalled = ran({ [JOBS.painter]: 'failure' });
  delete painterCalled[JOBS.painterCaller];
  assert.equal(upToDate(painterCalled).painter, false, 'a failed release');
  assert.equal(upToDate(painterCalled).app, false, 'and the app update after it was skipped for that reason');
  assert.deepEqual(upToDate({ [JOBS.plan]: 'failure' }), { migrations: false, functions: false, painter: false, app: false });
  // cancelled between jobs: migrations succeeded, the rest were skipped by the cancel, not for lack of changes
  assert.deepEqual(upToDate(ran({ [JOBS.migrations]: 'success' }), 'cancelled'), { migrations: true, functions: false, painter: false, app: false });
  // a job missing from the run (renamed): never up to date, nor anything after it
  const renamed = ran();
  delete renamed[JOBS.functions];
  assert.deepEqual(upToDate(renamed), { migrations: true, functions: false, painter: false, app: false });
});

test('bases: one pass, each part from its newest up-to-date run; the anchor when history runs out; fail at the cap', async () => {
  const api = history([
    { n: 5, status: 'in_progress', jobs: {} }, // this run
    { n: 4, jobs: ran({ [JOBS.functions]: 'failure', [JOBS.migrations]: 'success' }) },
    { n: 3, jobs: ran({ [JOBS.appCheck]: 'success', [JOBS.app]: 'skipped' }) },
    { n: 2, jobs: ran({ [JOBS.appCheck]: 'success', [JOBS.app]: 'success' }) },
  ]);
  assert.deepEqual(await bases(api, 'o/r', 5), { bases: { migrations: S(4), functions: S(3), painter: S(3), app: S(2) }, behind: [] });
  // a part never deployed (functions failed in every run): the anchor, everything since it is deployed
  const never = history([{ n: 2, jobs: ran({ [JOBS.functions]: 'failure' }) }, { n: 1, jobs: ran({ [JOBS.functions]: 'failure' }) }]);
  assert.equal((await bases(never, 'o/r', 9)).bases.functions, ANCHOR);
  // an app update waiting longer than the cap: only the app falls back to the anchor; the others go on
  const waiting = history(Array.from({ length: 8 }, (_, i) => ({ n: i + 1, jobs: ran({ [JOBS.appCheck]: 'success', [JOBS.app]: 'skipped' }) })));
  assert.deepEqual(await bases(waiting, 'o/r', 99, { maxRuns: 5 }),
    { bases: { migrations: S(8), functions: S(8), painter: S(8), app: ANCHOR }, behind: ['app'] });
  // a cancelled run's skipped jobs don't count
  const cancelled = history([{ n: 2, conclusion: 'cancelled', jobs: ran({ [JOBS.migrations]: 'success' }) }, { n: 1, jobs: ran() }]);
  assert.deepEqual((await bases(cancelled, 'o/r', 9)).bases, { migrations: S(2), functions: S(1), painter: S(1), app: S(1) });
});

test('the guard: a newer run that started deploying the part, even if it failed partway', async () => {
  const api = history([
    { n: 7, jobs: ran({ [JOBS.appCheck]: 'success', [JOBS.app]: 'failure' }) }, // Android published, iOS failed
    { n: 6, jobs: ran({ [JOBS.functions]: 'success' }) },
    { n: 5, jobs: ran() },
  ]);
  assert.deepEqual(await newerAttempts(api, 'o/r', 'app', 5), ['#7 (failure)'], 're-running #5 may not publish over #7');
  assert.deepEqual(await newerAttempts(api, 'o/r', 'functions', 5), ['#6 (success)']);
  assert.deepEqual(await newerAttempts(api, 'o/r', 'migrations', 5), [], 'skipped everywhere since: #5 may');
  assert.deepEqual(await newerAttempts(api, 'o/r', 'app', 7), [], 'the newest run may');
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
