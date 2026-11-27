// The deploy tree (deploy/render-deploy.mjs): Coolify puts only compose.yaml on the host, so the egress
// proxy script must travel inside it. Checks the image pin, that nothing is mounted from next to the file,
// and that the script comes out of Compose's interpolation byte for byte (with Docker, through
// `docker compose config` itself).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const render = new URL('../deploy/render-deploy.mjs', import.meta.url).pathname;
const script = readFileSync(new URL('../src/egress-proxy.mjs', import.meta.url), 'utf8');
const DIGEST = `sha256:${'a'.repeat(64)}`;

function renderTree() {
  const out = mkdtempSync(join(tmpdir(), 'render-deploy-'));
  writeFileSync(join(out, 'egress-proxy.mjs'), 'stale copy from an earlier tree');
  execFileSync('node', [render, '--out', out, '--digest', DIGEST, '--commit', 'b'.repeat(40), '--fingerprint', 'ea50df47c283491d',
    '--run', 'https://github.com/alp82/Local-Legend-/actions/runs/1', '--record'], { stdio: 'pipe' });
  return out;
}

test('the deploy tree is compose.yaml alone, with the image pinned and the egress script inside', () => {
  const out = renderTree();
  assert.ok(!existsSync(join(out, 'egress-proxy.mjs')), 'the stale script next to compose.yaml is removed');
  const compose = readFileSync(join(out, 'compose.yaml'), 'utf8');
  assert.match(compose, new RegExp(`image: ghcr\\.io/alp82/local-legend-map-renderer@${DIGEST}`));
  assert.ok(!compose.includes('LEGEND_MAP_RENDERER_IMAGE:?'), 'no unpinned image left');
  assert.ok(!/egress-proxy\.mjs:\/egress/.test(compose), 'nothing is mounted from next to the file');
  assert.ok(compose.includes('"printf \'%s\' \\"$$EGRESS_SCRIPT\\" > /egress/egress-proxy.mjs && exec node /egress/egress-proxy.mjs"'),
    'the command escapes $ for Compose');
  assert.match(compose, /tmpfs:\n {6}- \/egress:uid=1000,gid=1000,mode=0700,size=1m\n/);
  // the block scalar, as Compose reads it: 8 spaces of indentation off, $$ back to $
  const block = compose.split('      EGRESS_SCRIPT: |\n')[1].split(/\n(?! {8}|\n)/)[0];
  const value = block.split('\n').map((l) => l.slice(8)).join('\n').replace(/\$\$/g, '$') + '\n';
  assert.equal(value, script);
});

test('docker compose reads the egress script back unchanged', (t) => {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  } catch {
    return t.skip('no docker compose here');
  }
  const out = renderTree();
  mkdirSync(join(out, 'env'));
  writeFileSync(join(out, 'env', 'worker.env'), '');
  const json = execFileSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: out, env: { ...process.env, LEGEND_MAP_SUPABASE_HOST: 'x.supabase.co', LEGEND_MAP_RENDERER_DIR: join(out, 'env') }, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  const egress = JSON.parse(json).services.egress;
  // `config` prints literal dollars escaped again, ready to be read once more
  assert.equal(egress.environment.EGRESS_SCRIPT.replace(/\$\$/g, '$'), script);
  assert.equal(egress.read_only, true);
  assert.deepEqual(egress.command.slice(0, 2), ['sh', '-c']);
});
