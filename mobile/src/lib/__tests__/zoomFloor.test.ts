import { describe, expect, it, jest } from '@jest/globals';

import { LEGEND_MAP_MIN_ZOOM, tileZoomFor, tilesForView } from '../legendMapTiles';
import { clampZoom, createZoomFloor, LEGEND_MAP_ZOOM_FLOOR, MAP_MIN_ZOOM, zoomFloorAction } from '../zoomFloor';

// A phone screen around Berlin at the floor.
const BERLIN: [number, number, number, number] = [13.4, 52.49, 13.43, 52.51];

describe('the zoom floor', () => {
  it('sits just above where the painted map ends, where it still requests and draws tiles', () => {
    expect(LEGEND_MAP_ZOOM_FLOOR).toBeGreaterThan(LEGEND_MAP_MIN_ZOOM);
    expect(LEGEND_MAP_ZOOM_FLOOR - LEGEND_MAP_MIN_ZOOM).toBeLessThanOrEqual(0.25);
    // MapLibre rounds a 512 px raster source's tile zoom; the source starts at 15.
    expect(Math.round(LEGEND_MAP_ZOOM_FLOOR)).toBe(15);
    expect(tileZoomFor(LEGEND_MAP_ZOOM_FLOOR)).toBe(15);
    expect(tilesForView(BERLIN, LEGEND_MAP_ZOOM_FLOOR).tiles.length).toBeGreaterThan(0);
  });

  it('raises a camera zoom only while the Legend map shows', () => {
    expect(clampZoom(12, true)).toBe(LEGEND_MAP_ZOOM_FLOOR);
    expect(clampZoom(16, true)).toBe(16);
    expect(clampZoom(12, false)).toBe(12);
  });
});

describe('zoomFloorAction', () => {
  const base = { active: true, armed: false, zoom: 16, easing: false };
  it('arms at or above the floor, or before the camera reported a zoom', () => {
    expect(zoomFloorAction(base)).toBe('arm');
    expect(zoomFloorAction({ ...base, zoom: LEGEND_MAP_ZOOM_FLOOR - 0.005 })).toBe('arm');
    expect(zoomFloorAction({ ...base, zoom: null })).toBe('arm');
  });
  it('eases up first below the floor, once', () => {
    expect(zoomFloorAction({ ...base, zoom: 12 })).toBe('ease');
    expect(zoomFloorAction({ ...base, zoom: 12, easing: true })).toBe('none');
  });
  it('disarms when the Legend map is off, and leaves an armed floor alone', () => {
    expect(zoomFloorAction({ ...base, active: false, armed: true })).toBe('disarm');
    expect(zoomFloorAction({ ...base, active: false })).toBe('none');
    expect(zoomFloorAction({ ...base, armed: true, zoom: 12 })).toBe('none');
  });
});

function setup() {
  const zoomTo = jest.fn<(zoom: number, ms: number) => void>();
  const changes: number[] = [];
  const pending: { fn: () => void; ms: number }[] = [];
  const floor = createZoomFloor(zoomTo, (m) => changes.push(m), {
    set: (fn, ms) => pending.push({ fn, ms }) - 1,
    clear: (i) => {
      pending[i as number] = { fn: () => {}, ms: 0 };
    },
  });
  const fire = () => pending.splice(0).forEach((p) => p.fn());
  return { floor, zoomTo, changes, fire };
}

describe('createZoomFloor', () => {
  it('leaves zoom alone with the Legend map off', () => {
    const { floor, zoomTo, changes } = setup();
    floor.update(false, 12);
    floor.update(false, 18);
    expect(floor.minZoom).toBe(MAP_MIN_ZOOM);
    expect(zoomTo).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });

  it('applies the floor at once when the camera is already above it', () => {
    const { floor, zoomTo } = setup();
    floor.update(true, 16);
    expect(floor.minZoom).toBe(LEGEND_MAP_ZOOM_FLOOR);
    expect(zoomTo).not.toHaveBeenCalled();
  });

  it('switched on further out: eases up, then applies the floor when the camera is there', () => {
    const { floor, zoomTo, changes } = setup();
    floor.update(true, 12.3);
    expect(zoomTo).toHaveBeenCalledTimes(1);
    expect(zoomTo).toHaveBeenCalledWith(LEGEND_MAP_ZOOM_FLOOR, expect.any(Number));
    expect(floor.minZoom).toBe(MAP_MIN_ZOOM); // no floor yet: it would jump the camera
    floor.update(true, LEGEND_MAP_ZOOM_FLOOR);
    expect(floor.minZoom).toBe(LEGEND_MAP_ZOOM_FLOOR);
    expect(zoomTo).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([LEGEND_MAP_ZOOM_FLOOR]);
  });

  it('tries again when another camera move cuts the ease short, then applies the floor anyway', () => {
    const { floor, zoomTo, fire } = setup();
    floor.update(true, 12);
    floor.update(true, 12.5); // the follow camera moved the center; still below
    expect(zoomTo).toHaveBeenCalledTimes(1);
    fire(); // the ease timed out
    expect(zoomTo).toHaveBeenCalledTimes(2);
    fire();
    expect(zoomTo).toHaveBeenCalledTimes(3);
    fire();
    expect(zoomTo).toHaveBeenCalledTimes(3);
    expect(floor.minZoom).toBe(LEGEND_MAP_ZOOM_FLOOR);
  });

  it('switched off: back to the map’s own minimum, and on again eases up again', () => {
    const { floor, zoomTo, changes } = setup();
    floor.update(true, 16);
    floor.update(false, 16);
    expect(floor.minZoom).toBe(MAP_MIN_ZOOM);
    floor.update(false, 11); // zoomed out with the Legend map off
    floor.update(true, 11);
    expect(zoomTo).toHaveBeenCalledTimes(1);
    floor.update(true, LEGEND_MAP_ZOOM_FLOOR);
    expect(changes).toEqual([LEGEND_MAP_ZOOM_FLOOR, MAP_MIN_ZOOM, LEGEND_MAP_ZOOM_FLOOR]);
  });

  it('switched off mid-ease: drops the pending retry', () => {
    const { floor, zoomTo, fire } = setup();
    floor.update(true, 12);
    floor.update(false, 12);
    fire();
    expect(zoomTo).toHaveBeenCalledTimes(1);
    expect(floor.minZoom).toBe(MAP_MIN_ZOOM);
  });
});
