// Applies the fantasy map's zoom floor (lib/zoomFloor.ts) to the map camera.
//
// The floor is the Camera's native minZoom, so pinch, double-tap, two-finger tap and every
// camera move (the follow camera, Recenter, any easeTo or jumpTo) stop at it without a bounce.
// When the fantasy map turns on while the camera is further out (the Debug switch, or the
// server switch arriving after launch), the camera eases up to the floor first and the floor
// is applied once it's there. With the fantasy map off, minZoom is MapLibre's own minimum and
// zoom works as before.
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { createZoomFloor, MAP_MIN_ZOOM } from '@/lib/zoomFloor';

/** Returns the Camera's minZoom. `zoom` is the camera's last reported zoom (null before the first). */
export function useZoomFloor(cameraRef: RefObject<CameraRef | null>, active: boolean, zoom: number | null): number {
  const [minZoom, setMinZoom] = useState(MAP_MIN_ZOOM);
  const floor = useRef<ReturnType<typeof createZoomFloor> | null>(null);
  floor.current ??= createZoomFloor(
    (z, duration) => cameraRef.current?.zoomTo(z, { duration, easing: 'ease' }),
    setMinZoom,
  );

  useEffect(() => {
    floor.current?.update(active, zoom);
  }, [active, zoom]);

  useEffect(() => () => floor.current?.dispose(), []);

  return minZoom;
}
