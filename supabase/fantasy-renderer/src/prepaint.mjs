#!/usr/bin/env node
// Pre-paints an area: queues its tiles for the worker at the lowest priority (players'
// requests always go first), after printing what it will cost.
//
//   node src/prepaint.mjs --at 13.4140,52.5005 --radius-km 2 [--yes]
//   node src/prepaint.mjs --bbox 13.38,52.49,13.45,52.52 [--yes]
//
// Without --yes it only prints the estimate. Options: --no-z15 (skip zoom 15),
// --seconds-per-tile (painting time per tile on the worker host, default 1.5: one painter
// on the worker host; 0.8 s was measured on a fast desktop core),
// --kb-z16 / --kb-z15 (tile sizes; default: the averages measured so far, from fantasy_status).
//
// The worker paints the queued tiles itself. Don't paint an area on another machine and
// upload it: every tile must come from the same frozen source data, or tiles painted
// apart can disagree at their edges.
//
// Same environment as the worker (SUPABASE_URL plus the renderer user or a secret key).
import { parseArgs } from 'node:util';

import { tileOf } from './renderer.mjs';
import { supabaseFromEnv } from './supabase.mjs';

const { values: a } = parseArgs({
  options: {
    at: { type: 'string' },
    'radius-km': { type: 'string' },
    bbox: { type: 'string' },
    yes: { type: 'boolean', default: false },
    'no-z15': { type: 'boolean', default: false },
    'seconds-per-tile': { type: 'string', default: '1.5' },
    'kb-z16': { type: 'string' },
    'kb-z15': { type: 'string' },
  },
});

/** [west, south, east, north] in degrees. */
function area() {
  if (a.bbox) {
    const b = a.bbox.split(',').map(Number);
    if (b.length !== 4 || b.some(Number.isNaN) || b[0] >= b[2] || b[1] >= b[3]) throw new Error('--bbox west,south,east,north');
    return b;
  }
  if (!a.at || !a['radius-km']) throw new Error('give --at lng,lat with --radius-km, or --bbox west,south,east,north');
  const [lng, lat] = a.at.split(',').map(Number);
  const r = Number(a['radius-km']);
  const dLat = r / 111.32, dLng = r / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

const [w, s, e, n] = area();
const nw = tileOf(w, n, 16), se = tileOf(e, s, 16);
// With zoom 15, the area grows to whole z15 tiles: each needs all four of its children.
const even = !a['no-z15'];
const [x0, y0] = even ? [nw.x & ~1, nw.y & ~1] : [nw.x, nw.y];
const [x1, y1] = even ? [se.x | 1, se.y | 1] : [se.x, se.y];
const z16 = [];
for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) z16.push([16, x, y]);
const z15 = even ? [...new Set(z16.map(([, x, y]) => `${x >> 1}/${y >> 1}`))].map((k) => [15, ...k.split('/').map(Number)]) : [];
const MAX = 5000;
if (z16.length > 40_000) throw new Error(`${z16.length} tiles: split the area`);

const sb = supabaseFromEnv();
const status = await sb.rpc('fantasy_status');
const kb16 = Number(a['kb-z16'] ?? status.painted?.avg_kb_z16 ?? 142);
const kb15 = Number(a['kb-z15'] ?? status.painted?.avg_kb_z15 ?? 174);

async function count(tiles, dryRun) {
  let queued = 0, existing = 0;
  for (let i = 0; i < tiles.length; i += MAX) {
    const r = await sb.rpc('queue_fantasy_tiles', { p_tiles: tiles.slice(i, i + MAX), p_dry_run: dryRun });
    queued += r.queued;
    existing += r.existing;
  }
  return { queued, existing };
}

const c16 = await count(z16, true), c15 = await count(z15, true);
const sec = Number(a['seconds-per-tile']);
// A z15 tile is a scaled-down copy of its four children, which the worker has by then.
const hours = (c16.queued * sec + c15.queued * 0.3) / 3600;
const mb = (c16.queued * kb16 + c15.queued * kb15) / 1024;
const km = (x) => x.toFixed(1);
const widthKm = (e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180), heightKm = (n - s) * 111.32;
console.log(`Area: ${km(widthKm)} × ${km(heightKm)} km (${w.toFixed(4)},${s.toFixed(4)},${e.toFixed(4)},${n.toFixed(4)}), tile version v${status.version}`);
console.log(`Zoom 16: ${z16.length} tiles, ${c16.queued} new, ${c16.existing} already queued or painted`);
console.log(`Zoom 15: ${z15.length} tiles, ${c15.queued} new, ${c15.existing} already queued or painted`);
const took = hours * 3600 < 90 ? `${Math.round(hours * 3600)} s` : hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`;
console.log(`Estimate: ${took} of painting at ${sec} s per tile (players' requests go first), ${mb.toFixed(0)} MB of storage (${kb16} KB per z16 tile, ${kb15} KB per z15 tile)`);
console.log(`Queue now: ${status.queue.queued} queued (${status.queue.queued_prepaint} pre-painting), ${status.queue.painting} painting`);

if (!a.yes) {
  console.log('Dry run: nothing queued. Add --yes to queue these tiles.');
  process.exit(0);
}
// z15 first: the worker leases the newest requests first, so the z16 tiles queued after them
// are painted before their parents, which then only need scaling down.
const q15 = await count(z15, false);
const q16 = await count(z16, false);
console.log(`Queued ${q16.queued} z16 and ${q15.queued} z15 tiles. Watch progress with: node src/status.mjs`);
