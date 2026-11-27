#!/usr/bin/env node
// The migrations a `supabase db push --dry-run --output-format json` would apply (CLI 3.4.0: stdout is one JSON
// object, {"upToDate": …, "dryRun": true, "migrations": [...], …}; the text output carries no list unless the
// CLI detects a coding agent, so never parse that).
//
//   node .github/scripts/dry-run-migrations.mjs <file with the CLI's stdout>
//
// Prints the migration file names, space-separated (nothing when up to date). Exits 1 if the output isn't the
// expected JSON, so a changed CLI fails the deploy instead of passing it.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function dryRunMigrations(text) {
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error(`the dry run's output isn't JSON: ${text.slice(0, 200)}`);
  }
  if (out?.dryRun !== true || !Array.isArray(out.migrations) || !out.migrations.every((m) => typeof m === 'string' && /^\d{14}_[\w.-]+\.sql$/.test(m))) {
    throw new Error(`unexpected dry run output: ${text.slice(0, 200)}`);
  }
  return out.migrations;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(dryRunMigrations(readFileSync(process.argv[2], 'utf8')).join(' '));
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exit(1);
  }
}
