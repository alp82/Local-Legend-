// Offline queue: every GPS fix is stored locally first, then uploaded in batches.
//
// No double processing: a point gets a batch id exactly once, inside a BEGIN IMMEDIATE
// transaction, and the batch row (with its UUID) is committed before anything is sent.
// A retry always resends the same batch id with the same points, and the server dedupes
// on batch id. Points are marked sent only after the server accepts their batch. Within a
// runtime, concurrent upload triggers share one in-flight run; if a second runtime sends
// the same batch at the same moment, it is still the same batch id.
//
// Closing: the server claims the last 2 minutes of a session only once it knows the session is
// finished. After the batches, every stopped session with no unsent points or batches is closed
// with close_walk_session, and marked closed locally only after the server confirms. A failed
// close is retried on the next run; closing twice is harmless.
import * as Battery from 'expo-battery';
import { randomUUID } from 'expo-crypto';

import { db, emit, getKv, immediate, setKv } from './db';
import { findGaps, retryDelayMs, type Fix } from './geo';
import { closeWalkSession, submitLocationBatch, type BatchResult, type LocationPoint } from './territoryApi';

export const BATCH_SIZE = 200;
export const GAP_MS = 2 * 60_000;
const UPLOAD_THROTTLE_MS = 60_000;
const POINT_RETENTION_MS = 7 * 24 * 3600_000;
const SESSION_RETENTION_MS = 30 * 24 * 3600_000;
const MAX_BATCHES_PER_RUN = 20;

export type LastUpload =
  | { at: number; ok: true; batchId: string; points: number; result: BatchResult }
  | { at: number; ok: false; batchId: string | null; error: string };

export async function batteryLevel(): Promise<number | null> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level >= 0 ? level : null;
  } catch {
    return null;
  }
}

/** Stores fixes for a session, logs gaps over 2 minutes since the previous fix, and remembers the last fix. */
export function recordFixes(sessionId: string, fixes: LocationPoint[]) {
  if (fixes.length === 0) return;
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  immediate(() => {
    const prev = db.getFirstSync<Fix>(
      'SELECT t, lat, lng FROM points WHERE session_id = ? ORDER BY t DESC LIMIT 1',
      sessionId,
    );
    const fresh = prev ? sorted.filter((p) => p.t > prev.t) : sorted;
    for (const gap of findGaps(prev ? [prev, ...fresh] : fresh, GAP_MS)) {
      db.runSync(
        'INSERT INTO gaps (session_id, from_t, to_t, distance_m) VALUES (?, ?, ?, ?)',
        sessionId,
        gap.fromT,
        gap.toT,
        gap.distanceM,
      );
    }
    for (const p of sorted) {
      db.runSync(
        'INSERT OR IGNORE INTO points (session_id, t, lat, lng, acc, spd) VALUES (?, ?, ?, ?, ?, ?)',
        sessionId,
        p.t,
        p.lat,
        p.lng,
        p.acc,
        p.spd,
      );
    }
    setKv('last_fix', JSON.stringify(sorted[sorted.length - 1]));
  });
  emit('points');
}

type Batch = { id: string; session_id: string };

/** Returns the oldest unsent batch, or forms a new one from up to 200 unbatched points of one session. */
function claimNextBatch(battery: number | null): Batch | null {
  return immediate(() => {
    const pending = db.getFirstSync<Batch>(
      'SELECT id, session_id FROM batches WHERE sent_at IS NULL ORDER BY created_at, rowid LIMIT 1',
    );
    if (pending) return pending;
    const first = db.getFirstSync<{ session_id: string }>(
      'SELECT session_id FROM points WHERE batch_id IS NULL ORDER BY t LIMIT 1',
    );
    if (!first) return null;
    const id = randomUUID();
    db.runSync(
      'INSERT INTO batches (id, session_id, created_at, battery) VALUES (?, ?, ?, ?)',
      id,
      first.session_id,
      Date.now(),
      battery,
    );
    const { changes } = db.runSync(
      `UPDATE points SET batch_id = ? WHERE id IN (
         SELECT id FROM points WHERE batch_id IS NULL AND session_id = ? ORDER BY t LIMIT ?)`,
      id,
      first.session_id,
      BATCH_SIZE,
    );
    db.runSync('UPDATE batches SET point_count = ? WHERE id = ?', changes, id);
    return { id, session_id: first.session_id };
  });
}

function prune(now: number) {
  db.runSync('DELETE FROM points WHERE sent_at IS NOT NULL AND sent_at < ?', now - POINT_RETENTION_MS);
  db.runSync('DELETE FROM batches WHERE sent_at IS NOT NULL AND sent_at < ?', now - POINT_RETENTION_MS);
  db.runSync('DELETE FROM gaps WHERE to_t < ?', now - SESSION_RETENTION_MS);
  db.runSync(
    'DELETE FROM sessions WHERE stopped_at IS NOT NULL AND stopped_at < ?',
    now - SESSION_RETENTION_MS,
  );
}

function message(e: unknown) {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String(e.message);
  return String(e);
}

/** submit_location_batch raises 22023 for a malformed batch; retrying can't fix it. */
function isPermanentRejection(e: unknown) {
  return !!e && typeof e === 'object' && 'code' in e && e.code === '22023';
}

/** Stopped sessions whose points are all uploaded and that the server doesn't know are finished. */
function sessionsToClose(): string[] {
  return db
    .getAllSync<{ id: string }>(
      `SELECT id FROM sessions s
       WHERE stopped_at IS NOT NULL AND closed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM points p WHERE p.session_id = s.id AND p.sent_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.session_id = s.id AND b.sent_at IS NULL)
       ORDER BY stopped_at`,
    )
    .map((r) => r.id);
}

/** Closes finished sessions on the server. Returns the number of cells claimed. Stops at the first error. */
async function closeStoppedSessions(): Promise<number> {
  let newCells = 0;
  for (const id of sessionsToClose()) {
    try {
      // closed: false means the server never saw a batch of this session; there's nothing to
      // claim and nothing more will come, so it counts as done too.
      const result = await closeWalkSession(id);
      db.runSync('UPDATE sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL', Date.now(), id);
      newCells += result.newCells;
    } catch (e) {
      setKv('last_close_error', `${new Date().toISOString()} ${id.slice(0, 8)}: ${message(e)}`);
      break;
    }
  }
  return newCells;
}

async function runUpload() {
  const now = Date.now();
  setKv('last_upload_attempt', now);
  prune(now);
  let uploaded = 0;
  let failed = false;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const batch = claimNextBatch(await batteryLevel());
    if (!batch) break;
    const points = db.getAllSync<LocationPoint>(
      'SELECT t, lat, lng, acc, spd FROM points WHERE batch_id = ? ORDER BY t',
      batch.id,
    );
    db.runSync('UPDATE batches SET attempts = attempts + 1 WHERE id = ?', batch.id);
    try {
      const result = await submitLocationBatch(batch.id, batch.session_id, points);
      const sentAt = Date.now();
      immediate(() => {
        db.runSync(
          'UPDATE batches SET sent_at = ?, result = ?, last_error = NULL WHERE id = ?',
          sentAt,
          JSON.stringify(result),
          batch.id,
        );
        db.runSync('UPDATE points SET sent_at = ? WHERE batch_id = ?', sentAt, batch.id);
        setKv('upload_failures', 0);
        setKv('next_retry_at', null);
        setKv('last_upload', JSON.stringify({ at: sentAt, ok: true, batchId: batch.id, points: points.length, result }));
      });
      uploaded++;
    } catch (e) {
      if (isPermanentRejection(e)) {
        // The server will never accept this batch. Mark it done so it doesn't block the queue.
        const at = Date.now();
        immediate(() => {
          db.runSync(
            'UPDATE batches SET sent_at = ?, result = ?, last_error = ? WHERE id = ?',
            at,
            JSON.stringify({ dropped: true }),
            message(e),
            batch.id,
          );
          db.runSync('UPDATE points SET sent_at = ? WHERE batch_id = ?', at, batch.id);
          setKv('last_upload', JSON.stringify({ at, ok: false, batchId: batch.id, error: `Dropped: ${message(e)}` }));
        });
        continue;
      }
      const failures = Number(getKv('upload_failures') ?? 0) + 1;
      const at = Date.now();
      immediate(() => {
        db.runSync('UPDATE batches SET last_error = ? WHERE id = ?', message(e), batch.id);
        setKv('upload_failures', failures);
        setKv('next_retry_at', at + retryDelayMs(failures));
        setKv('last_upload', JSON.stringify({ at, ok: false, batchId: batch.id, error: message(e) }));
      });
      failed = true;
      break;
    }
  }
  // After a transient failure the server is likely unreachable; the next run closes them.
  const closedCells = failed ? 0 : await closeStoppedSessions();
  if (uploaded > 0 || closedCells > 0) emit('upload');
}

let inFlight: Promise<void> | null = null;

/** Uploads everything queued now, ignoring throttle and backoff. Concurrent calls share one run. */
export function uploadNow(): Promise<void> {
  inFlight ??= runUpload()
    .catch((e) => setKv('last_upload', JSON.stringify({ at: Date.now(), ok: false, batchId: null, error: message(e) })))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Called after new points arrive: uploads at most once a minute, and not before the retry backoff ends. */
export function maybeUpload(): Promise<void> {
  const now = Date.now();
  if (inFlight) return inFlight;
  if (now - Number(getKv('last_upload_attempt') ?? 0) < UPLOAD_THROTTLE_MS) return Promise.resolve();
  if (now < Number(getKv('next_retry_at') ?? 0)) return Promise.resolve();
  return uploadNow();
}

/** Not-yet-uploaded fixes per session, oldest first, for drawing the local track. */
export function pendingTrack(): GeoJSON.FeatureCollection {
  const rows = db.getAllSync<{ session_id: string; lat: number; lng: number }>(
    'SELECT session_id, lat, lng FROM points WHERE sent_at IS NULL ORDER BY session_id, t',
  );
  const lines = new Map<string, GeoJSON.Position[]>();
  for (const r of rows) {
    const line = lines.get(r.session_id) ?? [];
    line.push([r.lng, r.lat]);
    lines.set(r.session_id, line);
  }
  const coordinates = [...lines.values()].map((l) => (l.length === 1 ? [l[0], l[0]] : l));
  return {
    type: 'FeatureCollection',
    features: coordinates.length
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates } }]
      : [],
  };
}
