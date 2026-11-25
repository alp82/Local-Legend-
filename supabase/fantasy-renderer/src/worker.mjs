#!/usr/bin/env node
// The fantasy tile worker: leases queued tiles from Supabase, paints them, uploads them to
// the fantasy-tiles bucket and reports each one. Runs anywhere Node and Chromium run; all
// configuration is environment variables (see README.md).
//
// A z16 tile is painted directly. A z15 tile is its four z16 children scaled down; children
// not painted yet are painted (and stored) first.
import { resolve } from 'node:path';

import { startRenderer } from './renderer.mjs';
import { createSupabase } from './supabase.mjs';

const env = (name, fallback) => {
  const v = process.env[name] || fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};

const config = {
  url: env('SUPABASE_URL'),
  key: env('SUPABASE_SECRET_KEY'),
  sourceDir: resolve(env('SOURCE_CACHE_DIR', '.source')),
  paintWorkers: Number(env('PAINT_WORKERS', '4')),
  batch: Number(env('LEASE_BATCH', '8')),
  idleMs: Number(env('IDLE_POLL_MS', '1000')),
  once: env('EXIT_WHEN_IDLE', '') === '1',
};

if (!/^https?:\/\//.test(config.url)) throw new Error(`SUPABASE_URL must be an http(s) URL, got "${config.url}"`);

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const sb = createSupabase(config.url, config.key);
const renderer = await startRenderer({ sourceDir: config.sourceDir, workers: config.paintWorkers, log });
log(`worker ready: Chromium ${renderer.chromium}, ${config.paintWorkers} paint workers, source data in ${config.sourceDir}`);

const tilePath = (v, z, x, y) => `v${v}/${z}/${x}/${y}.webp`;

/** Paints, uploads and records one z16 tile; returns its bytes. */
async function paint16(v, x, y, quality) {
  const t = await renderer.paint(x, y, quality);
  await sb.upload(tilePath(v, 16, x, y), t.webp);
  await sb.rpc('finish_fantasy_tile', { p_version: v, p_z: 16, p_x: x, p_y: y, p_ok: true, p_bytes: t.webp.length, p_paint_ms: t.ms });
  log(`16/${x}/${y} v${v} ${t.ms} ms ${(t.webp.length / 1024).toFixed(0)} KB`);
  return t.webp;
}

async function paint15(v, x, y, quality) {
  const t0 = Date.now();
  const kids = await Promise.all(
    [[0, 0], [1, 0], [0, 1], [1, 1]].map(async ([u, w]) => {
      const cx = x * 2 + u, cy = y * 2 + w;
      return (await sb.download(tilePath(v, 16, cx, cy))) ?? paint16(v, cx, cy, quality);
    }),
  );
  const webp = await renderer.downsample(kids, quality);
  await sb.upload(tilePath(v, 15, x, y), webp);
  const ms = Date.now() - t0;
  await sb.rpc('finish_fantasy_tile', { p_version: v, p_z: 15, p_x: x, p_y: y, p_ok: true, p_bytes: webp.length, p_paint_ms: ms });
  log(`15/${x}/${y} v${v} ${ms} ms ${(webp.length / 1024).toFixed(0)} KB`);
}

async function job({ version, z, x, y, webp_quality: quality }) {
  try {
    if (z === 16) await paint16(version, x, y, quality);
    else await paint15(version, x, y, quality);
  } catch (e) {
    log(`${z}/${x}/${y} v${version} failed: ${e.message}`);
    await sb.rpc('finish_fantasy_tile', { p_version: version, p_z: z, p_x: x, p_y: y, p_ok: false, p_error: e.message }).catch(() => {});
  }
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; });

while (!stopping) {
  let leased;
  try {
    leased = await sb.rpc('lease_fantasy_tiles', { p_limit: config.batch });
  } catch (e) {
    log(`lease failed: ${e.message}`);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  if (!leased.length) {
    if (config.once) break;
    await new Promise((r) => setTimeout(r, config.idleMs));
    continue;
  }
  // z16 first: a z15 job in the same batch can then reuse its children
  leased.sort((a, b) => b.z - a.z);
  await Promise.all(leased.filter((t) => t.z === 16).map(job));
  await Promise.all(leased.filter((t) => t.z === 15).map(job));
}
await renderer.close();
log('worker stopped');
