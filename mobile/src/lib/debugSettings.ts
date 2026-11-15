// Map debug switches shared between the Debug screen and the map. In memory only: they
// reset when the app restarts.
import { useSyncExternalStore } from 'react';

export type DebugSettings = {
  /** Draw the zoom-21 claim cell grid at zoom 17 and above. */
  alignmentGrid: boolean;
  /** Replace the real territory and sites with a synthetic 50 km² realm. */
  fakeTerritory: boolean;
  /** Show the perf readout on the map (always on with the fake territory). */
  perfReadout: boolean;
};

let settings: DebugSettings = { alignmentGrid: false, fakeTerritory: false, perfReadout: false };
const listeners = new Set<() => void>();

export function setDebugSetting<K extends keyof DebugSettings>(key: K, value: DebugSettings[K]) {
  settings = { ...settings, [key]: value };
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
