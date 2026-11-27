#!/usr/bin/env node
// Health and progress of the Legend map, for whoever runs the worker:
//   docker compose exec worker node src/status.mjs
// Prints the database's view (public.legend_map_status: queue depth, tiles painted, storage,
// the last error, today's requests) and, when run next to the worker, its heartbeat.
import { readFileSync } from 'node:fs';

import { supabaseFromEnv } from './supabase.mjs';
import { workerWarnings } from './warnings.mjs';

const status = await supabaseFromEnv().rpc('legend_map_status');
let heartbeat = null;
try {
  heartbeat = JSON.parse(readFileSync(process.env.HEARTBEAT_FILE || '/tmp/legend-map-worker-heartbeat.json', 'utf8'));
  heartbeat.age_s = Math.round((Date.now() - Date.parse(heartbeat.at)) / 1000);
} catch {}
const warnings = workerWarnings(heartbeat);
for (const w of warnings) console.error(`WARNING: ${w}`);
console.log(JSON.stringify({ warnings, database: status, worker: heartbeat }, null, 2));
