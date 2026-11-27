// Map switches shared between the Debug screen and the map. The debug switches are in
// memory only and reset when the app restarts; the Legend map switch is kept in local
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
  /** Show the painted Legend map over the street map (on by default; saved). */
  legendMap: boolean;
};

const LEGEND_MAP_KEY = 'legendMapOff';
/** The same switch under the layer's earlier name; read once, then moved (remove after December 2026). */
const OLD_KEY = 'fantasyMapOff';

function storedLegendMap(): boolean {
  try {
    const ls = globalThis.localStorage;
    if (ls?.getItem(OLD_KEY) === '1') {
      ls.setItem(LEGEND_MAP_KEY, '1');
      ls.removeItem(OLD_KEY);
    }
    return ls?.getItem(LEGEND_MAP_KEY) !== '1';
  } catch {
    return true;
  }
}

let settings: DebugSettings = { alignmentGrid: false, fakeTerritory: false, perfReadout: false, legendMap: storedLegendMap() };
const listeners = new Set<() => void>();

export function setDebugSetting<K extends keyof DebugSettings>(key: K, value: DebugSettings[K]) {
  settings = { ...settings, [key]: value };
  if (key === 'legendMap') {
    try {
      if (value) globalThis.localStorage?.removeItem(LEGEND_MAP_KEY);
      else globalThis.localStorage?.setItem(LEGEND_MAP_KEY, '1');
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
