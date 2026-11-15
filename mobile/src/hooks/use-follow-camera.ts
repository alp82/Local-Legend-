// Keeps the map centered on the player while "follow" is on, in JS instead of the
// Camera's native trackUserLocation. The native mode moves the camera from two places
// (the location component and its own location listener) and stacks a new tracking
// listener each time it turns on, which made Recenter jump back and forth.
//
// Follow and the last camera view are saved, so the map opens the way it was left.
import type { CameraRef, InitialViewState, ViewStateChangeEvent } from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { getKv, setKv } from '@/lib/db';

const FOLLOW_KEY = 'map_follow';
const VIEW_KEY = 'map_view';
const DEFAULT_ZOOM = 16;
/** A last known position older than this is skipped, so Recenter doesn't pan to a stale spot first. */
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;
/**
 * A drag that leaves you more than this share of the screen from the center stops
 * following. Pinch zoom and rotation keep following.
 */
const BREAK_SHARE = 0.15;
const EASE_MS = 600;

type LngLat = [number, number];

function readSavedView(): { center: LngLat; zoom: number } | null {
  try {
    const v = JSON.parse(getKv(VIEW_KEY) ?? 'null');
    return Array.isArray(v?.center) && typeof v.zoom === 'number' ? v : null;
  } catch {
    return null;
  }
}

export function useFollowCamera(cameraRef: RefObject<CameraRef | null>, canShowLocation: boolean) {
  const [follow, setFollowState] = useState(() => getKv(FOLLOW_KEY) !== '0');
  const [initialViewState] = useState<InitialViewState>(() => readSavedView() ?? { zoom: DEFAULT_ZOOM });
  const hasSavedView = useRef('center' in initialViewState);
  const me = useRef<LngLat | null>(null);
  const gesture = useRef(false);

  const setFollow = (on: boolean) => {
    setFollowState(on);
    setKv(FOLLOW_KEY, on ? 1 : 0);
  };

  useEffect(() => {
    // Not following and a saved view exists: leave the map where it was.
    if (!canShowLocation || (!follow && hasSavedView.current)) return;
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    const move = (p: LngLat) => {
      me.current = p;
      if (cancelled || gesture.current) return;
      if (!hasSavedView.current) {
        // First launch: the camera has no center yet (0°, 0°), so jump instead of easing.
        hasSavedView.current = true;
        cameraRef.current?.jumpTo({ center: p, zoom: DEFAULT_ZOOM });
      } else {
        cameraRef.current?.easeTo({ center: p, duration: EASE_MS });
      }
    };
    (async () => {
      const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }).catch(() => null);
      if (last) move([last.coords.longitude, last.coords.latitude]);
      if (cancelled || !follow) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 1000 },
        (l) => move([l.coords.longitude, l.coords.latitude]),
      );
      if (cancelled) sub.remove();
    })().catch(() => {});
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [canShowLocation, follow, cameraRef]);

  const onRegionWillChange = (e: { nativeEvent: ViewStateChangeEvent }) => {
    if (e.nativeEvent.userInteraction) gesture.current = true;
  };

  const onRegionDidChange = (e: { nativeEvent: ViewStateChangeEvent }) => {
    const { center, zoom, bounds, userInteraction } = e.nativeEvent;
    setKv(VIEW_KEY, JSON.stringify({ center, zoom }));
    if (!userInteraction) return;
    gesture.current = false;
    if (!follow || !me.current) return;
    const dx = Math.abs(center[0] - me.current[0]) / Math.max(bounds[2] - bounds[0], 1e-9);
    const dy = Math.abs(center[1] - me.current[1]) / Math.max(bounds[3] - bounds[1], 1e-9);
    if (Math.max(dx, dy) > BREAK_SHARE) setFollow(false);
    // Small drift from a pinch: snap back onto the player.
    else cameraRef.current?.easeTo({ center: me.current, duration: EASE_MS });
  };

  return {
    follow,
    recenter: () => setFollow(true),
    initialViewState,
    onRegionWillChange,
    onRegionDidChange,
  };
}
