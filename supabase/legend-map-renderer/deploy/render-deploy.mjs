#!/usr/bin/env node
// Writes the deploy tree Coolify deploys from: the legend-map-deploy branch, which holds nothing but
//   compose.yaml      deploy/compose.yaml with the worker image pinned by digest (never a tag) and the egress
//                     proxy script of the same commit inline, in the proxy's EGRESS_SCRIPT variable (the proxy
//                     writes it to a small tmpfs at start and runs it in its own pinned image). Inline because
//                     Coolify puts only the compose file on the host: a script next to it never arrives
//                     (November 27, 2026: Docker then mounted an empty folder). Not a Compose config: Compose
//                     can't put inline content into a read-only container.
//   RELEASE.json      what is deployed: digest, commit, painter fingerprint, the run that built it
//   releases.ndjson   every release so far, one per line: the only digests the rollback workflow accepts
//
// Run by the release workflow (a new image) and the rollback workflow (an earlier one), never by hand on the
// branch: only the protected environment's deploy key may push it.
//
//   node deploy/render-deploy.mjs --out <checkout of the deploy branch> --digest sha256:<64 hex>
//        --commit <40 hex> --fingerprint <16 hex> --run <url> [--image ghcr.io/<owner>/local-legend-map-renderer]
//        [--record]   append to releases.ndjson (a new release; a rollback deploys an existing record)
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    out: { type: 'string' },
    digest: { type: 'string' },
    commit: { type: 'string' },
    fingerprint: { type: 'string' },
    run: { type: 'string' },
    image: { type: 'string', default: 'ghcr.io/alp82/local-legend-map-renderer' },
    record: { type: 'boolean', default: false },
  },
});
const need = (ok, what) => {
  if (!ok) throw new Error(`render-deploy: ${what}`);
};
need(a.out, '--out is required');
need(/^sha256:[0-9a-f]{64}$/.test(a.digest ?? ''), '--digest must be sha256:<64 hex>');
need(/^[0-9a-f]{40}$/.test(a.commit ?? ''), '--commit must be a full commit hash');
need(/^[0-9a-f]{16}$/.test(a.fingerprint ?? ''), '--fingerprint must be 16 hex digits');
need(/^https:\/\/github\.com\/[^\s]+$/.test(a.run ?? ''), '--run must be the run URL');
need(/^ghcr\.io\/[a-z0-9._/-]+$/.test(a.image), '--image must be a ghcr.io repository without a tag');

const here = new URL('.', import.meta.url);
const compose = readFileSync(new URL('compose.yaml', here), 'utf8');
const IMAGE_LINE = '    image: ${LEGEND_MAP_RENDERER_IMAGE:?}';
need(compose.split('\n').filter((l) => l === IMAGE_LINE).length === 1, `compose.yaml must have exactly one "${IMAGE_LINE.trim()}" line`);
const MOUNT = `    volumes:
      # next to this file in the repository; deploy/ship.sh copies it and sets LEGEND_MAP_EGRESS_SCRIPT
      - \${LEGEND_MAP_EGRESS_SCRIPT:-../src/egress-proxy.mjs}:/egress/egress-proxy.mjs:ro
`;
need(compose.split(MOUNT).length === 2, 'compose.yaml must mount the egress script exactly as render-deploy.mjs expects');
const COMMAND = '    command: ["node", "/egress/egress-proxy.mjs"]\n';
need(compose.split(COMMAND).length === 2, 'compose.yaml must start the egress proxy exactly as render-deploy.mjs expects');
const ALLOW = /^      EGRESS_ALLOW: .*\n/m;
need(ALLOW.test(compose), 'compose.yaml must set EGRESS_ALLOW');
const script = readFileSync(new URL('../src/egress-proxy.mjs', here), 'utf8');
need(!script.includes('\t'), 'the egress script must not contain tabs');
// $ is Compose's interpolation character, also inside a block scalar: $$ is a literal $.
const inline = script.replace(/\$/g, '$$$$').replace(/\n$/, '').split('\n').map((l) => (l ? `        ${l}` : '')).join('\n');
const pinned = compose
  .replace(IMAGE_LINE, `    image: ${a.image}@${a.digest}`)
  .replace(COMMAND, () => `    # EGRESS_SCRIPT (src/egress-proxy.mjs of this commit) is written to a tmpfs and run; the root file
    # system stays read-only
    command: ["sh", "-c", "printf '%s' \\"$$EGRESS_SCRIPT\\" > /egress/egress-proxy.mjs && exec node /egress/egress-proxy.mjs"]
`)
  .replace(MOUNT, () => `    tmpfs:
      - /egress:uid=1000,gid=1000,mode=0700,size=1m
`)
  .replace(ALLOW, (m) => `${m}      EGRESS_SCRIPT: |
${inline}
`)
  .replace(
    /^# Deployed by Coolify/m,
    `# Rendered by deploy/render-deploy.mjs from ${a.commit} (${a.run}). Don't edit this branch.\n#\n# Deployed by Coolify`,
  );

mkdirSync(a.out, { recursive: true });
writeFileSync(join(a.out, 'compose.yaml'), pinned);
rmSync(join(a.out, 'egress-proxy.mjs'), { force: true }); // the copy earlier deploy trees had next to compose.yaml
const release = { digest: a.digest, image: `${a.image}@${a.digest}`, commit: a.commit, fingerprint: a.fingerprint, run: a.run, at: new Date().toISOString() };
writeFileSync(join(a.out, 'RELEASE.json'), JSON.stringify(release, null, 2) + '\n');
const log = join(a.out, 'releases.ndjson');
if (a.record) appendFileSync(log, JSON.stringify(release) + '\n');
else need(existsSync(log) && readFileSync(log, 'utf8').split('\n').some((l) => l && JSON.parse(l).digest === a.digest), `${a.digest} is not a recorded release`);
console.log(`deploy tree for ${release.image} (painter ${a.fingerprint}) written to ${a.out}`);
