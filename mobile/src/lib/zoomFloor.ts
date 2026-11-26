// The zoom floor while the fantasy map shows: the player can't zoom out past the point where
// the painted map ends, so it never vanishes into the parchment or the street map. Pure
// functions; hooks/use-zoom-floor.ts applies them to the camera.
import { FANTASY_MIN_ZOOM } from './fantasyTiles';

/**
 * The lowest map zoom while the fantasy map shows. Its z15 tiles draw from FANTASY_MIN_ZOOM
 * (14.5: MapLibre rounds a 512 px raster source's tile zoom, and the source starts at 15), and
 * the parchment starts fading in below 14.5. A small margin keeps the floor off that edge.
 */
export const FANTASY_ZOOM_FLOOR = FANTASY_MIN_ZOOM + 0.1;

/** No floor: MapLibre's own minimum zoom, the map's behaviour without the fantasy map. */
export const MAP_MIN_ZOOM = 0;

/** Zooms this close to the floor count as at it (camera zooms come back as floats). */
const EPSILON = 0.01;

export type ZoomFloorState = {
  /** The fantasy map shows (server switch on, the player's Debug switch on). */
  active: boolean;
  /** The floor is applied to the camera (Camera.minZoom). */
  armed: boolean;
  /** The camera's last reported zoom, or null before the first report. */
  zoom: number | null;
  /** An ease up to the floor is in flight. */
  easing: boolean;
};

/**
 * What to do next:
 * - `disarm`: the fantasy map is off; zoom as before (minZoom back to MAP_MIN_ZOOM).
 * - `arm`: apply the floor (the camera is at or above it, or its zoom is unknown yet).
 * - `ease`: the camera is below the floor; ease it up first, so the floor doesn't jump it.
 * - `none`: nothing to change (already armed, or an ease is in flight).
 */
export function zoomFloorAction(s: ZoomFloorState): 'disarm' | 'arm' | 'ease' | 'none' {
  if (!s.active) return s.armed ? 'disarm' : 'none';
  if (s.armed) return 'none';
  if (s.zoom === null || s.zoom >= FANTASY_ZOOM_FLOOR - EPSILON) return 'arm';
  return s.easing ? 'none' : 'ease';
}

/** A camera zoom raised to the floor while the fantasy map shows, else unchanged. */
export function clampZoom(zoom: number, active: boolean): number {
  return active ? Math.max(zoom, FANTASY_ZOOM_FLOOR) : zoom;
}

const EASE_MS = 500;
/** An ease that hasn't reported the floor by then was cut short by another camera move. */
const EASE_TIMEOUT_MS = EASE_MS + 700;
/** Eases tried before the floor is applied anyway. */
const MAX_EASES = 3;

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };

/**
 * Drives the camera's minZoom from whether the fantasy map shows and the camera's reported
 * zoom. Below the floor when it turns on, it eases the camera up first (`zoomTo`) and applies
 * the floor once a report shows the camera there: a native minZoom set above the current zoom
 * would jump. An ease cut short by another camera move is tried again, at most MAX_EASES
 * times, then the floor is applied anyway. `onMinZoom` gets every new minZoom.
 */
export function createZoomFloor(
  zoomTo: (zoom: number, durationMs: number) => void,
  onMinZoom: (minZoom: number) => void,
  timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) },
) {
  const s: ZoomFloorState = { active: false, armed: false, zoom: null, easing: false };
  let eases = 0;
  let timer: unknown = null;
  let minZoom = MAP_MIN_ZOOM;

  const stopTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const publish = () => {
    const next = s.active && s.armed ? FANTASY_ZOOM_FLOOR : MAP_MIN_ZOOM;
    if (next !== minZoom) onMinZoom((minZoom = next));
  };
  const step = () => {
    const action = zoomFloorAction(s);
    if (action === 'disarm' || action === 'arm' || (action === 'ease' && eases >= MAX_EASES)) {
      stopTimer();
      s.easing = false;
      eases = 0;
      s.armed = action !== 'disarm';
    } else if (action === 'ease') {
      s.easing = true;
      eases++;
      zoomTo(FANTASY_ZOOM_FLOOR, EASE_MS);
      timer = timers.set(() => {
        timer = null;
        s.easing = false;
        step();
      }, EASE_TIMEOUT_MS);
    }
    publish();
  };

  return {
    /** The fantasy map's state and the camera's last reported zoom (null before the first). */
    update(active: boolean, zoom: number | null) {
      s.active = active;
      s.zoom = zoom;
      step();
    },
    get minZoom() {
      return minZoom;
    },
    dispose: stopTimer,
  };
}
