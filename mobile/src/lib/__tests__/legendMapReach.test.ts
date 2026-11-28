import { describe, expect, it } from '@jest/globals';

import { LEGEND_MAP_REACH_M, panBounds } from '../legendMapReach';

const M_PER_DEG = 111_320;
const lat = 52.5;
const me: [number, number] = [13.4, lat];
const kmLng = (deg: number) => (deg * M_PER_DEG * Math.cos((lat * Math.PI) / 180)) / 1000;
const kmLat = (deg: number) => (deg * M_PER_DEG) / 1000;
/** A view of w x h metres centred on the player. */
function viewOf(wM: number, hM: number): [number, number, number, number] {
  const dx = wM / 2 / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  const dy = hM / 2 / M_PER_DEG;
  return [me[0] - dx, me[1] - dy, me[0] + dx, me[1] + dy];
}

describe('pan bounds', () => {
  it('keep the whole screen inside the painted reach around the player', () => {
    const view = viewOf(1500, 3300); // a tall phone at the zoom floor
    const [w, s, e, n] = panBounds(me, view);
    // the centre may move this far; half the screen lies beyond it
    const reachX = kmLng(e - me[0]) * 1000 + 750;
    const reachY = kmLat(n - me[1]) * 1000 + 1650;
    expect(reachX).toBeLessThanOrEqual(LEGEND_MAP_REACH_M);
    expect(reachY).toBeLessThanOrEqual(LEGEND_MAP_REACH_M);
    expect(reachX).toBeGreaterThan(LEGEND_MAP_REACH_M - 400);
    expect(w).toBeLessThan(me[0]);
    expect(s).toBeLessThan(me[1]);
  });

  it('let the camera roam further when zoomed in', () => {
    const far = panBounds(me, viewOf(1500, 3300));
    const near = panBounds(me, viewOf(400, 800));
    expect(near[2] - near[0]).toBeGreaterThan(far[2] - far[0]);
    expect(near[3] - near[1]).toBeGreaterThan(far[3] - far[1]);
  });

  it('always leave some room to pan, even when the screen is wider than the reach', () => {
    const [w, s, e, n] = panBounds(me, viewOf(6000, 6000));
    expect(kmLng(e - w)).toBeGreaterThan(0.3);
    expect(kmLat(n - s)).toBeGreaterThan(0.3);
  });

  it('stay the same for small moves of the player and the camera', () => {
    const a = panBounds(me, viewOf(1500, 3300));
    const b = panBounds([me[0] + 0.0001, me[1] + 0.0001], viewOf(1510, 3290));
    expect(b).toEqual(a);
  });
});
