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
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { startRenderer } from './renderer.mjs';
import { supabaseFromEnv } from './supabase.mjs';

const env = (name, fallback) => process.env[name] || fallback;

const config = {
  sourceDir: resolve(env('SOURCE_CACHE_DIR', '.source')),
  paintWorkers: Number(env('PAINT_WORKERS', '4')),
  batch: Number(env('LEASE_BATCH', '8')),
  idleMs: Number(env('IDLE_POLL_MS', '1000')),
  once: env('EXIT_WHEN_IDLE', '') === '1',
  heartbeat: env('HEARTBEAT_FILE', '/tmp/fantasy-worker-heartbeat.json'),
};

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const sb = supabaseFromEnv();
const renderer = await startRenderer({ sourceDir: config.sourceDir, workers: config.paintWorkers, log });
log(`worker ready: Chromium ${renderer.chromium}, ${config.paintWorkers} paint workers, ${sb.mode}, source data in ${config.sourceDir}`);

const stats = { startedAt: new Date().toISOString(), painted: 0, failed: 0, lastPaintAt: null, lastError: null };
async function beat(state) {
  const body = { ...stats, state, at: new Date().toISOString(), source: await renderer.sourceStatus() };
  await writeFile(config.heartbeat, JSON.stringify(body)).catch((e) => log(`heartbeat: ${e.message}`));
}

const tilePath = (v, z, x, y) => `v${v}/${z}/${x}/${y}.webp`;
const labelPath = (v, z, x, y) => `v${v}/${z}/${x}/${y}.json`;
const HALF = 20037508.342789244;
const lngLat = (mx, my) => [
  Math.round(((mx / HALF) * 180) * 1e6) / 1e6,
  Math.round((Math.atan(Math.exp(my / 6378137)) * 2 - Math.PI / 2) * (180 / Math.PI) * 1e6) / 1e6,
];
/** The app's live labels for a tile: [{ name, lng, lat, rot, water }]. */
const labelJson = (labels) => JSON.stringify(labels.map((L) => {
  const [lng, lat] = lngLat(L.wx, L.wy);
  return { name: L.name, lng, lat, rot: L.rot, water: L.water };
}));

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
while (!stopping) {
  let leased;
  try {
    leased = await sb.rpc('lease_fantasy_tiles', { p_limit: config.batch });
  } catch (e) {
    log(`lease failed: ${e.message}`);
    stats.lastError = { tile: null, error: `lease: ${e.message}`, at: new Date().toISOString() };
    await beat('lease failing');
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  if (!leased.length) {
    await beat('idle');
    if (config.once) break;
    await new Promise((r) => setTimeout(r, config.idleMs));
    continue;
  }
  await beat('painting');
  // z16 first: a z15 job in the same batch can then reuse its children
  await Promise.all(leased.filter((t) => t.z === 16).map(job));
  await Promise.all(leased.filter((t) => t.z === 15).map(job));
}
await beat('stopped');
await renderer.close();
log('worker stopped');
