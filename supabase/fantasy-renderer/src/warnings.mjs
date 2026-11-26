// What an operator must notice in the worker's heartbeat, as plain sentences: a source limit
// stopping new areas, or the disk running low. Shown first by src/status.mjs and src/health.mjs.
const LOW_DISK_MB = 2000;

export function workerWarnings(beat) {
  const src = beat?.source ?? {};
  const out = [];
  if (src.limited) {
    out.push(`NEW AREAS ARE NOT PAINTED: ${src.limited}. Tiles on ground with stored source data still paint; others fail with "needs new source data" until the limit allows it (see the runbook, Failed tiles).`);
  }
  if (typeof src.diskFreeMb === 'number' && src.diskFreeMb < LOW_DISK_MB) {
    out.push(`LOW DISK: ${src.diskFreeMb} MB free where the source store lives.`);
  }
  return out;
}
