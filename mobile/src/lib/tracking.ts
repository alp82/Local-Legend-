// Background walk recording. Imported for its side effect from the root layout so the task
// is defined at module load, including when Android starts the JS runtime headlessly to
// deliver locations after the app was swiped away.
import { randomUUID } from 'expo-crypto';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Linking, PermissionsAndroid, Platform } from 'react-native';

import { db, emit, getKv, setKv } from './db';
import { batteryLevel, maybeUpload, recordFixes, uploadNow } from './queue';

export const LOCATION_TASK = 'local-legend-location';

// Settings, from the expo-location SDK 58 docs and its Android source:
// - High accuracy maps to PRIORITY_HIGH_ACCURACY (GPS). Balanced is "within one hundred
//   meters" (Wi-Fi/cell), too coarse for a 60 m strip.
// - distanceInterval 10 m: no fixes (and no JS wake-ups) while standing still; at walking
//   speed it's roughly one fix every 7 s, plenty for a 60 m strip.
// - timeInterval 5 s (Android): the fused provider's interval and max batching delay.
// - deferredUpdates: while the app is in the background, Android buffers fixes natively and
//   runs the JS task at most every 30 s / 50 m instead of on every fix. A killed service
//   loses at most that buffer. In the foreground fixes arrive immediately.
// - iOS: Fitness activity type, never auto-pause (pausing misses walks that start after a
//   stop), blue status bar indicator so the user knows tracking is on.
const TASK_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.High,
  distanceInterval: 10,
  timeInterval: 5000,
  deferredUpdatesInterval: 30_000,
  deferredUpdatesDistance: 50,
  activityType: Location.ActivityType.Fitness,
  pausesUpdatesAutomatically: false,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'Clearing the Mist',
    notificationBody: 'Local Legend is recording your walk.',
    notificationColor: '#208AEF',
    killServiceOnDestroy: false,
  },
};

function currentSession(): string {
  let id = getKv('session_id');
  if (!id) {
    // The OS restarted tracking without a session (e.g. after a reinstall); open one.
    id = randomUUID();
    db.runSync('INSERT OR IGNORE INTO sessions (id, started_at) VALUES (?, ?)', id, Date.now());
    setKv('session_id', id);
  }
  return id;
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    setKv('last_task_error', `${new Date().toISOString()} ${error.message}`);
    return;
  }
  const locations = data?.locations ?? [];
  if (locations.length === 0) return;
  recordFixes(
    currentSession(),
    locations.map((l) => ({
      t: Math.round(l.timestamp),
      lat: l.coords.latitude,
      lng: l.coords.longitude,
      acc: l.coords.accuracy ?? null,
      spd: l.coords.speed ?? null,
    })),
  );
  // Awaited so the OS keeps the JS runtime awake until the upload finishes.
  await maybeUpload();
});

export function isTrackingWanted(): boolean {
  return getKv('tracking') === '1';
}

export type PermissionState =
  | 'granted'
  | 'foreground-ask'
  | 'foreground-denied'
  | 'background-ask'
  | 'background-denied';

/** Where the user is in the foreground → background permission flow, without prompting. */
export async function permissionState(): Promise<PermissionState> {
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) return fg.canAskAgain ? 'foreground-ask' : 'foreground-denied';
  const bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted) return bg.canAskAgain ? 'background-ask' : 'background-denied';
  return 'granted';
}

export async function requestForeground(): Promise<PermissionState> {
  await Location.requestForegroundPermissionsAsync();
  return permissionState();
}

/** On Android 11+ this opens system settings, where the user must pick "Allow all the time". */
export async function requestBackground(): Promise<PermissionState> {
  await Location.requestBackgroundPermissionsAsync();
  return permissionState();
}

/** Android 13+: lets the tracking notification show. Tracking works without it. */
export async function requestNotifications() {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
}

export function openSettings() {
  return Linking.openSettings();
}

/** Starts a new session. Caller must have both location permissions. */
export async function startTracking() {
  const id = randomUUID();
  db.runSync(
    'INSERT INTO sessions (id, started_at, battery_start) VALUES (?, ?, ?)',
    id,
    Date.now(),
    await batteryLevel(),
  );
  setKv('session_id', id);
  setKv('tracking', '1');
  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, TASK_OPTIONS);
  } catch (e) {
    await endSession();
    throw e;
  }
  emit('tracking');
}

async function endSession() {
  const id = getKv('session_id');
  if (id) {
    db.runSync(
      'UPDATE sessions SET stopped_at = ?, battery_end = ? WHERE id = ?',
      Date.now(),
      await batteryLevel(),
      id,
    );
  }
  setKv('session_id', null);
  setKv('tracking', '0');
}

export async function stopTracking() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  await endSession();
  emit('tracking');
  void uploadNow();
}

/**
 * If tracking was on, make sure location updates are running (after an app restart, an
 * update or a force stop). Must run while the app is in the foreground: Android doesn't
 * allow starting a foreground service from the background. Keeps the current session.
 */
export async function resumeTrackingIfWanted(): Promise<void> {
  if (!isTrackingWanted()) return;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
  if ((await permissionState()) !== 'granted') return;
  currentSession();
  await Location.startLocationUpdatesAsync(LOCATION_TASK, TASK_OPTIONS);
}
