#!/usr/bin/env node
// Copies the fantasy map painter and its reduced art from the throwaway prototype
// (prototypes/fantasy-map/, never committed) into painter/ and assets/, and records what
// was copied in VENDORED.md. The prototype is only read.
//
//   node scripts/sync-prototype.mjs [path/to/prototypes/fantasy-map]
//
// After a sync, `git diff painter/ VENDORED.md` is the whole change.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const proto = resolve(process.argv[2] ?? join(root, '../../prototypes/fantasy-map'));

// The painter exactly as the prototype's README hands it over (round 10, "Handover"): the
// entry point tilepainter.js and its module graph, and nothing else.
const CODE = ['tilepainter.js', 'painter5.js', 'fmworld.js', 'fmcore.js', 'tiledata.js', 'vendor/vt.mjs'];

const sprites = join(proto, 'sprites5');
const bundle = JSON.parse(readFileSync(join(sprites, 'bundle.json'), 'utf8'));
// Only what the painter loads: the sheets, the textures and the two indexes.
const ART = [
  'bundle.json',
  'index.json',
  ...bundle.sheets,
  ...bundle.textures.map((n) => `tex-${n}.webp`),
];
// The village name font (SIL Open Font License), painted into the tiles.
const FONTS = ['IMFeENsc28P.ttf', 'OFL.txt'];

// painter/ holds the copy and nothing else: files the prototype dropped go with it.
rmSync(join(root, 'painter'), { recursive: true, force: true });

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
const rows = [];
let artBytes = 0;
for (const f of CODE) {
  const to = join(root, 'painter', f);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(proto, f), to);
  rows.push(`| painter/${f} | ${f} | ${sha(to)} |`);
}
for (const f of ART) {
  const to = join(root, 'assets', f);
  copyFileSync(join(sprites, f), to);
  artBytes += readFileSync(to).length;
  rows.push(`| assets/${f} | sprites5/${f} | ${sha(to)} |`);
}
mkdirSync(join(root, 'assets/fonts'), { recursive: true });
for (const f of FONTS) {
  const to = join(root, 'assets/fonts', f);
  copyFileSync(join(proto, 'fonts', f), to);
  rows.push(`| assets/fonts/${f} | fonts/${f} | ${sha(to)} |`);
}
// Art the prototype no longer lists would linger here; report it so it can be deleted.
const stale = readdirSync(join(root, 'assets')).filter((f) => f !== 'fonts' && !ART.includes(f));

const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
writeFileSync(
  join(root, 'VENDORED.md'),
  `# Vendored painter

The files in \`painter/\` and \`assets/\` are copies from the fantasy map prototype
(\`prototypes/fantasy-map/\`, untracked and never committed). Don't edit them here. Change
the prototype, then run \`node scripts/sync-prototype.mjs\` and review \`git diff\`.

Copied on ${now}. Art: ${(artBytes / 1e6).toFixed(1)} MB in ${ART.length} files.

| Here | Prototype file | SHA-256 (first 16) |
| --- | --- | --- |
${rows.join('\n')}
`,
);
console.log(`copied ${CODE.length} code files and ${ART.length} art files (${(artBytes / 1e6).toFixed(1)} MB)`);
if (stale.length) console.warn(`not in the prototype any more, delete: ${stale.join(', ')}`);
