#!/usr/bin/env node
// The painter fingerprint: a hash that changes whenever painted output can change, and only then. A new
// fingerprint means a new tile version (supabase/migrations/*_fantasy_releases.sql); the same fingerprint means
// tiles painted by this image match the ones already published, so a redeploy just restarts.
//
// What goes in, each file by its SHA-256:
// - painter/**/*.js and *.mjs: the painter and planner;
// - assets/**: the atlases, textures, sprite index, bundle and the label font;
// - src/page/*: the in-browser paint path (painter workers, village names, label filtering, z15 downsampling);
// - src/paint-output.mjs: Chromium's flags and the label file format;
// - the Playwright version from package-lock.json (it fixes the Chromium build);
// - the Dockerfile's FROM line (the base image, pinned by digest: Chromium's libraries and fonts).
// Nothing else: the worker loop, the queue, the source store and the deploy files don't change pixels.
// test/golden.test.mjs checks the claim: with the fingerprint unchanged, a fixed set of tiles must paint the
// recorded bytes.
//
//   node src/fingerprint.mjs            prints the fingerprint
//   node src/fingerprint.mjs --list     and every input with its hash
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir, keep) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

/** Every input as [label, sha256], sorted by label. */
export function fingerprintInputs(root = ROOT) {
  const files = [
    ...walk(join(root, 'painter'), (p) => /\.m?js$/.test(p)),
    ...walk(join(root, 'assets'), () => true),
    ...walk(join(root, 'src/page'), () => true),
    join(root, 'src/paint-output.mjs'),
  ];
  const inputs = files.map((p) => [relative(root, p).split('\\').join('/'), sha(readFileSync(p))]);
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const pw = lock.packages?.['node_modules/playwright-core']?.version;
  if (!pw) throw new Error('package-lock.json has no playwright-core version');
  inputs.push(['playwright-core', sha(pw)]);
  const from = readFileSync(join(root, 'Dockerfile'), 'utf8').split('\n').find((l) => /^FROM\s/i.test(l));
  if (!from || !/@sha256:[0-9a-f]{64}/.test(from)) throw new Error('the Dockerfile must pin its base image by digest');
  inputs.push(['Dockerfile FROM', sha(from.trim())]);
  return inputs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The fingerprint: 16 hex digits. */
export function painterFingerprint(root = ROOT) {
  return sha(fingerprintInputs(root).map(([k, v]) => `${k}\0${v}\n`).join('')).slice(0, 16);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--list')) for (const [k, v] of fingerprintInputs()) console.log(`${v.slice(0, 16)}  ${k}`);
  console.log(painterFingerprint());
}
