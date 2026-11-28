// The camera's pan limit while the Legend map shows (lib/legendMapReach.ts): its centre stays
// close enough to the player that the screen never runs past the painted reach. Watches the
// player's position coarsely on its own, since the follow camera reads none while following is
// off. Without a position, or with the Legend map off, the bounds are the whole world (Android
// keeps the last bounds when the prop goes away, so the limit is never lifted by removing it).
import type { LngLatBounds } from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { useEffect, useMemo, useState } from 'react';

import { panBounds } from '@/lib/legendMapReach';
import type { BBox } from '@/lib/sitesApi';

/** No limit. */
const WORLD: LngLatBounds = [-180, -85.0511, 180, 85.0511];

export function useLegendMapPanBounds(active: boolean, canShowLocation: boolean, view: BBox | null): LngLatBounds {
  const [me, setMe] = useState<[number, number] | null>(null);

  useEffect(() => {
    if (!active || !canShowLocation) return;
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    const put = (l: Location.LocationObject) => !cancelled && setMe([l.coords.longitude, l.coords.latitude]);
    (async () => {
      const last = await Location.getLastKnownPositionAsync().catch(() => null);
      if (last) put(last);
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 50 }, put);
      if (cancelled) sub.remove();
    })().catch(() => {});
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [active, canShowLocation]);

  // the same bounds keep the same array, so the camera isn't handed new ones on every render
  const key = active && me ? panBounds(me, view).join(',') : '';
  return useMemo(() => (key ? (key.split(',').map(Number) as LngLatBounds) : WORLD), [key]);
}
