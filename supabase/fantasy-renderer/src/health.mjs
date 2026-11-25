#!/usr/bin/env node
// Container health check: healthy while the worker's heartbeat is fresh. The worker writes
// it after every round (at least every IDLE_POLL_MS when idle, every few seconds when
// painting), so a stale file means it hangs or has died.
//   node src/health.mjs [max-age-seconds=120]
import { readFileSync } from 'node:fs';

const file = process.env.HEARTBEAT_FILE || '/tmp/fantasy-worker-heartbeat.json';
const maxAge = Number(process.argv[2] ?? 120) * 1000;
try {
  const beat = JSON.parse(readFileSync(file, 'utf8'));
  const age = Date.now() - Date.parse(beat.at);
  if (age > maxAge) {
    console.error(`stale heartbeat: ${Math.round(age / 1000)} s old (${beat.state})`);
    process.exit(1);
  }
  console.log(`ok: ${beat.state}, ${beat.painted} painted, ${beat.failed} failed since ${beat.startedAt}`);
} catch (e) {
  console.error(`no heartbeat: ${e.message}`);
  process.exit(1);
}
