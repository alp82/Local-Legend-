#!/usr/bin/env node
// What a push to main deploys (docs/deploy.md). Each part of the app counts its changes from the commit it was
// last deployed from (.github/scripts/deployed.mjs), so one part failing doesn't hold back or redeploy the others.
//
//   node .github/scripts/plan.mjs --head <sha> --before <sha> \
//     --migrations-base <sha> --functions-base <sha> --painter-base <sha> --app-base <sha>
//   (a pull request passes its merge base for all of them)
//
// Prints the plan and, under GitHub Actions, writes it to $GITHUB_OUTPUT:
//   migrations=true|false      migrations were added since the migrations base
//   added_migrations=<names>   those files, space-separated
//   changed_unapplied=<vers>   migrations listed in .github/migration-fixes.json that this deploy changes
//   functions=<names>          Edge Functions changed since the functions base (supabase/functions/<name>/**;
//                              all of them when supabase/functions/_shared or supabase/config.toml changed)
//   painter=true|false         the Legend map renderer changed since the painter base
//   mobile=true|false          the app changed since the app base
// Exits 1 when a migration rule is broken (every check also runs on the pull request), except for versions listed
// in .github/migration-fixes.json as never applied (the deploy then checks the hosted history):
//   - a migration that existed at the migrations base or at <before> was modified, renamed or deleted: it may
//     already be applied, and the hosted history would no longer match the file;
//   - an added migration sorts before the newest one at <before>: `db push` refuses migrations older than the
//     last applied one (give it a new, later timestamp);
//   - a migration after the baseline doesn't set a lock_timeout for the session (`set lock_timeout = '…';`, not
//     `set local`, which is lost if the CLI splits the file into several transactions).
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Migrations up to this version predate the lock_timeout rule (they're applied; history stays as it is). */
export const LOCK_TIMEOUT_BASELINE = '20261126200000';
export const LOCK_TIMEOUT = /^\s*set\s+lock_timeout\s*(=|to)\s*'?\d/im;
const STATUS = { M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed type' };
const MIGRATIONS = 'supabase/migrations/';

/** git diff --name-status -M output → entries. */
export function parseNameStatus(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, a, b] = line.split('\t');
      return b ? { status: status[0], from: a, path: b } : { status: status[0], path: a };
    });
}

const version = (p) => p.slice(MIGRATIONS.length, MIGRATIONS.length + 14);

/**
 * Migration rules. `changes` since the migrations base, `sinceBefore` since <before>, `beforeNewest` the newest
 * version at <before>, `neverApplied` the versions listed in .github/migration-fixes.json (they may change; the
 * deploy checks the hosted history first).
 */
export function migrationPlan({ changes, sinceBefore, beforeNewest, migrations, read, neverApplied = [] }) {
  const refused = [];
  const added = [];
  const fixes = new Set();
  for (const c of [...changes, ...sinceBefore]) {
    const p = c.from ?? c.path;
    if (!p.startsWith(MIGRATIONS) && !c.path.startsWith(MIGRATIONS)) continue;
    if (c.status === 'A') continue;
    if (p.startsWith(MIGRATIONS) && neverApplied.includes(version(p))) {
      fixes.add(version(p));
      continue;
    }
    refused.push(`${p}: ${STATUS[c.status] ?? c.status} (an existing migration may already be applied; add a new one instead, or list its version in .github/migration-fixes.json if it never reached the hosted project)`);
  }
  for (const c of changes) {
    if (c.status === 'A' && c.path.startsWith(MIGRATIONS)) added.push(c.path.slice(MIGRATIONS.length));
  }
  for (const c of sinceBefore) {
    const name = c.path.slice(MIGRATIONS.length);
    if (c.status === 'A' && c.path.startsWith(MIGRATIONS) && beforeNewest && name.slice(0, 14) <= beforeNewest && !neverApplied.includes(name.slice(0, 14))) {
      refused.push(`${c.path}: sorts before ${beforeNewest}, the newest migration already on main (db push refuses it); rename it with a later timestamp`);
    }
  }
  for (const name of migrations) {
    if (name.slice(0, 14) > LOCK_TIMEOUT_BASELINE && !LOCK_TIMEOUT.test(read(`${MIGRATIONS}${name}`))) {
      refused.push(`${MIGRATIONS}${name}: no "set lock_timeout = '…';" for the session (every migration after ${LOCK_TIMEOUT_BASELINE} must set one; not "set local")`);
    }
  }
  return { migrations: added.length > 0 || fixes.size > 0, added_migrations: added.sort(), changed_unapplied: [...fixes].sort(), refused: [...new Set(refused)] };
}

/** Which functions changed (a shared file or the config: all of them). */
export function functionsPlan(changes, allFunctions) {
  const names = new Set();
  for (const c of changes) {
    for (const p of [c.path, c.from].filter(Boolean)) {
      if (p === 'supabase/config.toml' || p.startsWith('supabase/functions/_')) return [...allFunctions].sort();
      if (p.startsWith('supabase/functions/')) {
        const name = p.split('/')[2];
        if (allFunctions.includes(name)) names.add(name);
      }
    }
  }
  return [...names].sort();
}

export const touches = (changes, test) => changes.some((c) => [c.path, c.from].filter(Boolean).some(test));
export const isPainter = (p) => p.startsWith('supabase/legend-map-renderer/') || p === '.github/workflows/legend-map-renderer.yml';
export const isApp = (p) => p.startsWith('mobile/');

function main() {
  const { values: a } = parseArgs({
    options: Object.fromEntries(['head', 'before', 'migrations-base', 'functions-base', 'painter-base', 'app-base'].map((k) => [k, { type: 'string' }])),
  });
  for (const k of ['head', 'before', 'migrations-base', 'functions-base', 'painter-base', 'app-base']) {
    if (!/^[0-9a-f]{40}$/.test(a[k] ?? '')) throw new Error(`--${k} must be a full commit hash, got "${a[k] ?? ''}"`);
  }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const diff = (base) => parseNameStatus(git('diff', '--name-status', '-M', base, a.head));
  const ls = (commit, dir) => git('ls-tree', '--name-only', `${commit}:${dir}`).split('\n').filter(Boolean);
  const migrationsAt = (commit) => ls(commit, 'supabase/migrations').filter((n) => n.endsWith('.sql'));
  const functions = ls(a.head, 'supabase/functions').filter((n) => !n.startsWith('_') && !n.startsWith('.') && ls(a.head, `supabase/functions/${n}`).includes('index.ts'));

  const m = migrationPlan({
    changes: diff(a['migrations-base']),
    sinceBefore: diff(a.before),
    beforeNewest: migrationsAt(a.before).map((n) => n.slice(0, 14)).sort().pop(),
    migrations: migrationsAt(a.head),
    read: (p) => git('show', `${a.head}:${p}`),
    neverApplied: (() => {
      try {
        return JSON.parse(git('show', `${a.head}:.github/migration-fixes.json`)).never_applied ?? [];
      } catch {
        return [];
      }
    })(),
  });
  const p = {
    ...m,
    functions: functionsPlan(diff(a['functions-base']), functions),
    painter: touches(diff(a['painter-base']), isPainter),
    mobile: touches(diff(a['app-base']), isApp),
  };
  console.log(JSON.stringify({ ...a, ...p }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `migrations=${p.migrations}`,
      `added_migrations=${p.added_migrations.join(' ')}`,
      `changed_unapplied=${p.changed_unapplied.join(' ')}`,
      `functions=${p.functions.join(' ')}`,
      `painter=${p.painter}`,
      `mobile=${p.mobile}`,
    ].join('\n') + '\n');
  }
  if (p.refused.length) {
    for (const r of p.refused) console.log(`::error::${r}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
