// Read-only views over the local tracking store for the Debug screen and commute-test logs.
import { db, getKv } from './db';
import type { LastUpload } from './queue';
import type { LocationPoint } from './territoryApi';

export type Diagnostics = {
  tracking: boolean;
  sessionId: string | null;
  pointsToday: number;
  queued: number;
  sent: number;
  failedAttempts: number;
  nextRetryAt: number | null;
  lastFix: LocationPoint | null;
  lastUpload: LastUpload | null;
  lastTaskError: string | null;
};

function parse<T>(value: string | null): T | null {
  return value ? (JSON.parse(value) as T) : null;
}

export function getDiagnostics(): Diagnostics {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const counts = db.getFirstSync<{ today: number; queued: number; sent: number }>(
    `SELECT
       COALESCE(SUM(t >= ?), 0) AS today,
       COALESCE(SUM(sent_at IS NULL), 0) AS queued,
       COALESCE(SUM(sent_at IS NOT NULL), 0) AS sent
     FROM points`,
    midnight.getTime(),
  );
  const nextRetry = Number(getKv('next_retry_at') ?? 0);
  return {
    tracking: getKv('tracking') === '1',
    sessionId: getKv('session_id'),
    pointsToday: counts?.today ?? 0,
    queued: counts?.queued ?? 0,
    sent: counts?.sent ?? 0,
    failedAttempts: Number(getKv('upload_failures') ?? 0),
    nextRetryAt: nextRetry > Date.now() ? nextRetry : null,
    lastFix: parse<LocationPoint>(getKv('last_fix')),
    lastUpload: parse<LastUpload>(getKv('last_upload')),
    lastTaskError: getKv('last_task_error'),
  };
}

const time = (t: number | null) => (t ? new Date(t).toLocaleString() : '—');
const pct = (b: number | null) => (b === null ? '?' : `${Math.round(b * 100)}%`);
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** Plain-text log of recent sessions: times, points, battery, gaps over 2 minutes, batches. */
export function sessionLog(limit = 20): string {
  const sessions = db.getAllSync<{
    id: string;
    started_at: number;
    stopped_at: number | null;
    battery_start: number | null;
    battery_end: number | null;
    points: number;
    first_t: number | null;
    last_t: number | null;
    batches: number;
  }>(
    `SELECT s.*,
       (SELECT COUNT(*) FROM points p WHERE p.session_id = s.id) AS points,
       (SELECT MIN(t) FROM points p WHERE p.session_id = s.id) AS first_t,
       (SELECT MAX(t) FROM points p WHERE p.session_id = s.id) AS last_t,
       (SELECT COUNT(*) FROM batches b WHERE b.session_id = s.id) AS batches
     FROM sessions s ORDER BY started_at DESC LIMIT ?`,
    limit,
  );
  if (sessions.length === 0) return 'No sessions yet.';
  return sessions
    .map((s) => {
      const end = s.stopped_at ?? Date.now();
      const hours = (end - s.started_at) / 3600_000;
      const drain =
        s.battery_start !== null && s.battery_end !== null && hours > 0
          ? ` (${(((s.battery_start - s.battery_end) * 100) / hours).toFixed(1)}%/h)`
          : '';
      const gaps = db.getAllSync<{ from_t: number; to_t: number; distance_m: number }>(
        'SELECT from_t, to_t, distance_m FROM gaps WHERE session_id = ? ORDER BY from_t',
        s.id,
      );
      const lines = [
        `Session ${s.id.slice(0, 8)}`,
        `  ${time(s.started_at)} → ${s.stopped_at ? time(s.stopped_at) : 'running'} (${mins(end - s.started_at)})`,
        `  points ${s.points} in ${s.batches} batches (kept 7 days), first fix ${time(s.first_t)}, last fix ${time(s.last_t)}`,
        `  battery ${pct(s.battery_start)} → ${pct(s.battery_end)}${drain}`,
        `  gaps > 2 min: ${gaps.length}`,
        ...gaps.map((g) => `    ${time(g.from_t)} +${mins(g.to_t - g.from_t)}, moved ${Math.round(g.distance_m)} m`),
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Battery level recorded with each recent batch (oldest first). */
export function batchLog(limit = 30): string {
  const rows = db.getAllSync<{
    created_at: number;
    point_count: number;
    attempts: number;
    battery: number | null;
    sent_at: number | null;
    last_error: string | null;
  }>(
    'SELECT created_at, point_count, attempts, battery, sent_at, last_error FROM batches ORDER BY created_at DESC LIMIT ?',
    limit,
  );
  return rows
    .reverse()
    .map(
      (b) =>
        `${time(b.created_at)} ${b.point_count} pts, battery ${pct(b.battery)}, ${b.attempts} tries, ${
          b.sent_at ? 'sent' : `pending${b.last_error ? `: ${b.last_error}` : ''}`
        }`,
    )
    .join('\n');
}
