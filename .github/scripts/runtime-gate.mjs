#!/usr/bin/env node
// The over-the-air update's gate (docs/deploy.md, "App updates"): an update only reaches phones whose native
// build has the same runtime version, which is the app's fingerprint (mobile/app.json: runtimeVersion policy
// "fingerprint"). Publishing one for a runtime no tester has would reach nobody; publishing native changes
// as an update would crash the builds that do match. So the update is published only when the fingerprint of
// every platform is one the testers' builds have, listed in .github/app-runtimes.json.
//
//   node .github/scripts/runtime-gate.mjs --android <fingerprint> --ios <fingerprint>
//
// Exits 0 when both match (publish), 1 otherwise (a native build is needed first).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * @param {Record<string, string>} fingerprints  platform → computed fingerprint
 * @param {Record<string, string[]>} installed  platform → runtime versions of the testers' builds
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function gate(fingerprints, installed) {
  const lines = [];
  let ok = true;
  for (const [platform, fp] of Object.entries(fingerprints)) {
    if (!/^[0-9a-f]{40}$/.test(fp ?? '')) {
      ok = false;
      lines.push(`${platform}: no fingerprint computed (got "${fp ?? ''}")`);
      continue;
    }
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
  const installed = JSON.parse(readFileSync(values.runtimes, 'utf8'));
  const { ok, lines } = gate({ android: values.android, ios: values.ios }, installed);
  for (const l of lines) console.log(l);
  if (!ok) {
    console.log('::error::Not publishing the over-the-air update: a native build is needed (see the lines above).');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
