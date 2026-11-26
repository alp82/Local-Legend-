#!/usr/bin/env node
// The fantasy tile worker: leases queued tiles from Supabase, paints them, uploads them to
// the fantasy-tiles bucket and reports each one. Runs anywhere Node and Chromium run; all
// configuration is environment variables (see README.md).
//
// A z16 tile is painted directly. A z15 tile is its four z16 children scaled down; children
// not painted yet are painted (and stored) first.
//
// After every round the worker writes a heartbeat file (HEARTBEAT_FILE); src/health.mjs
// reads it for the container health check, src/status.mjs shows it with the queue.
//
// At start-up it reports its painter fingerprint (src/fingerprint.mjs, src/release.mjs): the database then
// carries on, stages a new tile version for this painter, or rolls back to this painter's earlier version.
// The worker paints only versions painted with its own painter, switches phones to a staged version once it's
// done, and deletes replaced versions after their grace period.
//
// After IDLE_RELEASE_MS with nothing to paint, Chromium is closed to give its memory back to
// the shared host (state "idle, painter released"); the next lease launches it again.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { painterFingerprint } from './fingerprint.mjs';
import { labelJson } from './paint-output.mjs';
import { createRelease } from './release.mjs';
import { startRenderer } from './renderer.mjs';
import { supabaseFromEnv } from './supabase.mjs';

const env = (name, fallback) => process.env[name] || fallback;

const config = {
  sourceDir: resolve(env('SOURCE_CACHE_DIR', '.source')),
  paintWorkers: Number(env('PAINT_WORKERS', '4')),
  batch: Number(env('LEASE_BATCH', '8')),
  idleMs: Number(env('IDLE_POLL_MS', '1000')),
  releaseAfterMs: Number(env('IDLE_RELEASE_MS', '60000')),
  once: env('EXIT_WHEN_IDLE', '') === '1',
  heartbeat: env('HEARTBEAT_FILE', '/tmp/fantasy-worker-heartbeat.json'),
};

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const sb = supabaseFromEnv();
const renderer = await startRenderer({ sourceDir: config.sourceDir, workers: config.paintWorkers, log });
const fingerprint = painterFingerprint();
log(`worker ready: painter ${fingerprint}, Chromium ${renderer.chromium}, ${config.paintWorkers} paint workers, ${sb.mode}, source data in ${config.sourceDir}`);
const release = createRelease(sb, fingerprint, log);

const stats = { startedAt: new Date().toISOString(), painted: 0, failed: 0, lastPaintAt: null, lastError: null, browserReleases: 0 };
async function beat(state) {
  const r = release.state;
  const body = { ...stats, state, at: new Date().toISOString(), painter: { fingerprint, action: r.action, version: r.version, staging: r.staging }, source: await renderer.sourceStatus() };
  await writeFile(config.heartbeat, JSON.stringify(body)).catch((e) => log(`heartbeat: ${e.message}`));
}

const tilePath = (v, z, x, y) => `v${v}/${z}/${x}/${y}.webp`;
const labelPath = (v, z, x, y) => `v${v}/${z}/${x}/${y}.json`;
/** Paints, uploads and records one z16 tile; returns { webp, labels } (labels as JSON text). */
async function paint16(v, x, y, quality) {
  const t = await renderer.paint(x, y, quality);
  const labels = labelJson(t.labels);
  // the labels first: a tile the app can load always has its label file
  await sb.upload(labelPath(v, 16, x, y), Buffer.from(labels), 'application/json');
  await sb.upload(tilePath(v, 16, x, y), t.webp);
  await sb.rpc('finish_fantasy_tile', { p_version: v, p_z: 16, p_x: x, p_y: y, p_ok: true, p_bytes: t.webp.length, p_paint_ms: t.ms });
  log(`16/${x}/${y} v${v} ${t.ms} ms ${(t.webp.length / 1024).toFixed(0)} KB`);
  stats.painted++;
  stats.lastPaintAt = new Date().toISOString();
  return { webp: t.webp, labels };
}

async function paint15(v, x, y, quality) {
  const t0 = Date.now();
  const kids = await Promise.all(
    [[0, 0], [1, 0], [0, 1], [1, 1]].map(async ([u, w]) => {
      const cx = x * 2 + u, cy = y * 2 + w;
      const [webp, labels] = await Promise.all([sb.download(tilePath(v, 16, cx, cy)), sb.download(labelPath(v, 16, cx, cy))]);
      return webp && labels ? { webp, labels: labels.toString() } : paint16(v, cx, cy, quality);
    }),
  );
  const webp = await renderer.downsample(kids.map((k) => k.webp), quality);
  // a z15 tile's labels are its children's
  const labels = JSON.stringify(kids.flatMap((k) => JSON.parse(k.labels)));
  await sb.upload(labelPath(v, 15, x, y), Buffer.from(labels), 'application/json');
  await sb.upload(tilePath(v, 15, x, y), webp);
  const ms = Date.now() - t0;
  await sb.rpc('finish_fantasy_tile', { p_version: v, p_z: 15, p_x: x, p_y: y, p_ok: true, p_bytes: webp.length, p_paint_ms: ms });
  log(`15/${x}/${y} v${v} ${ms} ms ${(webp.length / 1024).toFixed(0)} KB`);
  stats.painted++;
  stats.lastPaintAt = new Date().toISOString();
}

async function job({ version, z, x, y, webp_quality: quality }) {
  try {
    if (z === 16) await paint16(version, x, y, quality);
    else await paint15(version, x, y, quality);
  } catch (e) {
    log(`${z}/${x}/${y} v${version} failed: ${e.message}`);
    stats.failed++;
    stats.lastError = { tile: `${z}/${x}/${y}`, error: e.message, at: new Date().toISOString() };
    await sb.rpc('finish_fantasy_tile', { p_version: version, p_z: z, p_x: x, p_y: y, p_ok: false, p_error: e.message }).catch(() => {});
  }
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; });

await beat('starting');
await release.begin();
let lastWork = Date.now();
while (!stopping) {
  let leased;
  try {
    leased = await sb.rpc('lease_fantasy_tiles', release.leaseArgs(config.batch));
  } catch (e) {
    log(`lease failed: ${e.message}`);
    stats.lastError = { tile: null, error: `lease: ${e.message}`, at: new Date().toISOString() };
    await beat('lease failing');
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  if (!leased.length) {
    if (renderer.awake && Date.now() - lastWork >= config.releaseAfterMs && (await renderer.release())) {
      stats.browserReleases++;
      log(`painter released after ${Math.round((Date.now() - lastWork) / 1000)} s idle`);
    }
    await release.tick().catch((e) => log(`release: ${e.message}`));
    await beat(renderer.awake ? 'idle' : 'idle, painter released');
    if (config.once) break;
    await new Promise((r) => setTimeout(r, config.idleMs));
    continue;
  }
  await beat('painting');
  // z16 first: a z15 job in the same batch can then reuse its children
  await Promise.all(leased.filter((t) => t.z === 16).map(job));
  await Promise.all(leased.filter((t) => t.z === 15).map(job));
  lastWork = Date.now();
}
await beat('stopped');
await renderer.close();
log('worker stopped');
