// Map switches shared between the Debug screen and the map. The debug switches are in
// memory only and reset when the app restarts; the fantasy map switch is kept in local
// storage.
import 'expo-sqlite/localStorage/install';

import { useSyncExternalStore } from 'react';

export type DebugSettings = {
  /** Draw the zoom-21 claim cell grid at zoom 17 and above. */
  alignmentGrid: boolean;
  /** Replace the real territory and sites with a synthetic 50 km² realm. */
  fakeTerritory: boolean;
  /** Show the perf readout on the map (always on with the fake territory). */
  perfReadout: boolean;
  /** Show the painted fantasy map over the street map (on by default; saved). */
  fantasyMap: boolean;
};

const FANTASY_KEY = 'fantasyMapOff';

function storedFantasyMap(): boolean {
  try {
    return globalThis.localStorage?.getItem(FANTASY_KEY) !== '1';
  } catch {
    return true;
  }
}

let settings: DebugSettings = { alignmentGrid: false, fakeTerritory: false, perfReadout: false, fantasyMap: storedFantasyMap() };
const listeners = new Set<() => void>();

export function setDebugSetting<K extends keyof DebugSettings>(key: K, value: DebugSettings[K]) {
  settings = { ...settings, [key]: value };
  if (key === 'fantasyMap') {
    try {
      if (value) globalThis.localStorage?.removeItem(FANTASY_KEY);
      else globalThis.localStorage?.setItem(FANTASY_KEY, '1');
    } catch {}
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDebugSettings(): DebugSettings {
  return useSyncExternalStore(subscribe, () => settings);
}
