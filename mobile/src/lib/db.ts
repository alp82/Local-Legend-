// Local SQLite store for the tracking queue, upload batches, session log and small settings.
// Synchronous API on purpose: each call finishes before any other JS runs in this runtime,
// and BEGIN IMMEDIATE takes SQLite's write lock up front so a second runtime (headless
// background task) can't interleave inside a transaction.
import { openDatabaseSync } from 'expo-sqlite';

export const db = openDatabaseSync('tracking.db');

db.execSync(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  acc REAL,
  spd REAL,
  batch_id TEXT,
  sent_at INTEGER,
  UNIQUE (session_id, t)
);
CREATE INDEX IF NOT EXISTS points_batch ON points (batch_id);
CREATE INDEX IF NOT EXISTS points_t ON points (t);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  point_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  battery REAL,
  sent_at INTEGER,
  last_error TEXT,
  result TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  battery_start REAL,
  battery_end REAL,
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  from_t INTEGER NOT NULL,
  to_t INTEGER NOT NULL,
  distance_m REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves an existing table as
// it is, so add them here. sessions.closed_at: when the server confirmed close_walk_session.
function addColumn(table: string, column: string, type: string) {
  const has = () => db.getAllSync<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
  if (has()) return;
  try {
    db.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    // Another runtime (headless background task) may have added it at the same moment.
    if (!has()) throw e;
  }
}
addColumn('sessions', 'closed_at', 'INTEGER');

export function getKv(key: string): string | null {
  return db.getFirstSync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
}

export function setKv(key: string, value: string | number | null) {
  if (value === null) db.runSync('DELETE FROM kv WHERE key = ?', key);
  else db.runSync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, String(value));
}

/** Runs `fn` in a write transaction that holds the database lock from the start. */
export function immediate<T>(fn: () => T): T {
  db.execSync('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.execSync('COMMIT');
    return result;
  } catch (e) {
    db.execSync('ROLLBACK');
    throw e;
  }
}

// In-process change notifications so screens refresh when the background task (running in
// this same JS runtime while the app is alive) records points or the uploader succeeds.
type QueueEvent = 'points' | 'upload' | 'tracking';
const listeners = new Set<(e: QueueEvent) => void>();

export function onQueueEvent(fn: (e: QueueEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emit(e: QueueEvent) {
  for (const fn of listeners) fn(e);
}
