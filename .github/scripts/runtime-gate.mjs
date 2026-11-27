#!/usr/bin/env node
// The over-the-air update's gate (docs/deploy.md, "App updates"): an update only reaches phones whose native
// build has the same runtime version, which is the app's fingerprint (mobile/app.json: runtimeVersion policy
// "fingerprint"). Publishing one for a runtime no tester has would reach nobody; publishing native changes
// as an update would crash the builds that do match. So the update is published only when the fingerprint of
// every platform is one the testers' builds have, listed in .github/app-runtimes.json.
//
//   node .github/scripts/runtime-gate.mjs --android <fingerprint> --ios <fingerprint>
//
// Exit codes: 0 both match (publish); 2 a fingerprint matches no tester build (a native build is needed: the
// update waits); 1 anything else is wrong (a missing or malformed fingerprint, a malformed app-runtimes.json),
// which must fail the deploy rather than pass as "waiting".
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const NO_MATCH = 2;
const HASH = /^[0-9a-f]{40}$/;

/** Validates .github/app-runtimes.json's content; throws on anything but { android: [hash…], ios: [hash…] }. */
export function parseRuntimes(text) {
  const r = JSON.parse(text);
  for (const p of ['android', 'ios']) {
    if (!Array.isArray(r?.[p]) || !r[p].every((h) => HASH.test(h))) throw new Error(`.github/app-runtimes.json: "${p}" must be a list of 40-hex fingerprints`);
  }
  return r;
}

/**
 * @param {Record<string, string>} fingerprints  platform → computed fingerprint
 * @param {Record<string, string[]>} installed  platform → runtime versions of the testers' builds
 * @returns {{ ok: boolean, lines: string[] }}  throws when a fingerprint is missing or malformed
 */
export function gate(fingerprints, installed) {
  const lines = [];
  let ok = true;
  for (const [platform, fp] of Object.entries(fingerprints)) {
    if (!HASH.test(fp ?? '')) throw new Error(`${platform}: no valid fingerprint computed (got "${fp ?? ''}")`);
    const known = installed[platform] ?? [];
    if (known.includes(fp)) {
      lines.push(`${platform}: ${fp} matches a tester build`);
    } else {
      ok = false;
      lines.push(`${platform}: ${fp} matches no tester build (${known.join(', ') || 'none recorded'}). Native code or config changed: ` +
        'make and distribute a new build first (docs/test-distribution.md), then add its runtime to .github/app-runtimes.json.');
    }
  }
  return { ok, lines };
}

function main() {
  const { values } = parseArgs({ options: { android: { type: 'string' }, ios: { type: 'string' }, runtimes: { type: 'string', default: '.github/app-runtimes.json' } } });
  let result;
  try {
    result = gate({ android: values.android, ios: values.ios }, parseRuntimes(readFileSync(values.runtimes, 'utf8')));
  } catch (e) {
    console.log(`::error::The app update gate failed: ${e.message}`);
    process.exit(1);
  }
  for (const l of result.lines) console.log(l);
  if (!result.ok) process.exit(NO_MATCH);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
