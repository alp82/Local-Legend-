#!/usr/bin/env node
// Health and progress of the fantasy map, for whoever runs the worker:
//   docker compose exec worker node src/status.mjs
// Prints the database's view (public.fantasy_status: queue depth, tiles painted, storage,
// the last error, today's requests) and, when run next to the worker, its heartbeat.
import { readFileSync } from 'node:fs';

import { supabaseFromEnv } from './supabase.mjs';

const status = await supabaseFromEnv().rpc('fantasy_status');
let heartbeat = null;
try {
  heartbeat = JSON.parse(readFileSync(process.env.HEARTBEAT_FILE || '/tmp/fantasy-worker-heartbeat.json', 'utf8'));
  heartbeat.age_s = Math.round((Date.now() - Date.parse(heartbeat.at)) / 1000);
} catch {}
console.log(JSON.stringify({ database: status, worker: heartbeat }, null, 2));
