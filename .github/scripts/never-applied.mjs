#!/usr/bin/env node
// Checks that migrations a deploy changes under .github/migration-fixes.json were never applied to the hosted
// project, from `supabase migration list --remote --output-format json` (CLI 3.4.0:
// {"migrations": [{"local": …, "remote": …, "time": …}], …}).
//
//   node .github/scripts/never-applied.mjs <file with the CLI's stdout> <version>...
//
// Exits 1 if any of them is in the hosted history, or if the output isn't the expected JSON.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function appliedAmong(text, versions) {
  const out = JSON.parse(text);
  if (!Array.isArray(out?.migrations)) throw new Error(`unexpected migration list output: ${text.slice(0, 200)}`);
  const remote = new Set(out.migrations.map((m) => m.remote).filter(Boolean));
  return versions.filter((v) => remote.has(v));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, ...versions] = process.argv.slice(2);
  try {
    const applied = appliedAmong(readFileSync(file, 'utf8'), versions);
    if (applied.length) {
      console.log(`::error::listed in .github/migration-fixes.json as never applied, but the hosted project has them: ${applied.join(' ')}. Their files must stay as they were applied; add a new migration instead.`);
      process.exit(1);
    }
    console.log(`never applied, as listed: ${versions.join(' ') || '(none changed)'}`);
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exit(1);
  }
}
