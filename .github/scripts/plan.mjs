#!/usr/bin/env node
// What a push to main deploys, from the files changed between two commits (docs/deploy.md):
//
//   node .github/scripts/plan.mjs <base> <head>
//
// Prints the plan and, under GitHub Actions, writes it to $GITHUB_OUTPUT:
//   migrations=true|false      supabase/migrations changed (only added files are allowed)
//   added_migrations=<names>   the migration files added, space-separated
//   functions=<names>          Edge Functions to deploy, space-separated (supabase/functions/<name>/**;
//                              all of them when supabase/functions/_shared or supabase/config.toml changed)
//   painter=true|false         the Legend map renderer changed (its tests and release)
//   mobile=true|false          the app changed (an over-the-air update)
// Exits 1 when a migration rule is broken:
//   - a migration file that existed at <base> was modified, renamed or deleted (it may already be applied:
//     the hosted history would no longer match the file);
//   - a migration after the baseline doesn't set a lock_timeout (a migration that waits for locks can queue
//     every request behind it: docs/legend-map-deploy.md, step 6).
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Migrations up to this version predate the lock_timeout rule (they're applied; history stays as it is). */
export const LOCK_TIMEOUT_BASELINE = '20261126200000';
export const LOCK_TIMEOUT = /^\s*set\s+(local\s+)?lock_timeout\s*(=|to)\s*'?\d/im;

/**
 * @param {{ status: string, path: string, from?: string }[]} changes  git diff --name-status entries
 * @param {{ migrations: string[], functions: string[], read: (path: string) => string }} tree  the head commit
 */
export function plan(changes, tree) {
  const refused = [];
  const added = [];
  const functions = new Set();
  let allFunctions = false;
  let painter = false;
  let mobile = false;
  for (const c of changes) {
    for (const p of [c.path, c.from].filter(Boolean)) {
      if (p.startsWith('supabase/migrations/')) {
        if (c.status === 'A') added.push(p.slice('supabase/migrations/'.length));
        else if (p === (c.from ?? c.path)) refused.push(`${p}: ${{ M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed type' }[c.status] ?? c.status} (an existing migration may already be applied; add a new one instead)`);
      } else if (p.startsWith('supabase/functions/')) {
        const name = p.split('/')[2];
        if (name.startsWith('_')) allFunctions = true;
        else if (tree.functions.includes(name)) functions.add(name);
      } else if (p === 'supabase/config.toml') {
        allFunctions = true;
      } else if (p.startsWith('supabase/legend-map-renderer/') || p === '.github/workflows/legend-map-renderer.yml') {
        painter = true;
      } else if (p.startsWith('mobile/')) {
        mobile = true;
      }
    }
  }
  for (const name of tree.migrations) {
    if (name.slice(0, 14) > LOCK_TIMEOUT_BASELINE && !LOCK_TIMEOUT.test(tree.read(`supabase/migrations/${name}`))) {
      refused.push(`supabase/migrations/${name}: no "set lock_timeout = '…';" (every migration after ${LOCK_TIMEOUT_BASELINE} must set one)`);
    }
  }
  return {
    migrations: added.length > 0 || refused.some((r) => r.startsWith('supabase/migrations/')),
    added_migrations: added.sort(),
    functions: (allFunctions ? tree.functions : [...functions]).sort(),
    painter,
    mobile,
    refused: [...new Set(refused)],
  };
}

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

function main([base, head]) {
  if (!/^[0-9a-f]{7,40}$/.test(base ?? '') || !/^[0-9a-f]{7,40}$/.test(head ?? '')) {
    throw new Error('usage: plan.mjs <base commit> <head commit>');
  }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const changes = parseNameStatus(git('diff', '--name-status', '-M', base, head));
  const ls = (dir) => git('ls-tree', '--name-only', `${head}:${dir}`).split('\n').filter(Boolean);
  const tree = {
    migrations: ls('supabase/migrations').filter((n) => n.endsWith('.sql')),
    functions: ls('supabase/functions').filter((n) => !n.startsWith('_') && !n.startsWith('.') && git('ls-tree', '--name-only', `${head}:supabase/functions/${n}`).includes('index.ts')),
    read: (p) => git('show', `${head}:${p}`),
  };
  const p = plan(changes, tree);
  console.log(JSON.stringify({ base, head, ...p }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `migrations=${p.migrations}`,
      `added_migrations=${p.added_migrations.join(' ')}`,
      `functions=${p.functions.join(' ')}`,
      `painter=${p.painter}`,
      `mobile=${p.mobile}`,
    ].join('\n') + '\n');
  }
  if (p.refused.length) {
    for (const r of p.refused) console.error(`::error::${r}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
