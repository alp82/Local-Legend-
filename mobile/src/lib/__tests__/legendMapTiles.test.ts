import { describe, expect, it } from '@jest/globals';

import {
  legendMapLabelUrl,
  legendMapTileUrl,
  labelsGeoJSON,
  MAX_TILES_PER_REQUEST,
  nextPoll,
  STALL_LIMIT_MS,
  tileKey,
  tileSetKey,
  tilesOfSetKey,
  tileZoomFor,
  tilesForView,
  type PollState,
} from '../legendMapTiles';
import type { BBox } from '../sitesApi';

// A phone screen at z16 over Berlin Kreuzberg (390 x 844 CSS px).
const berlin: BBox = [13.4129, 52.5017, 13.4177, 52.5064];

describe('tile zoom', () => {
  it('matches MapLibre raster tile choice for 512 px tiles', () => {
    expect(tileZoomFor(14.5)).toBe(15);
    expect(tileZoomFor(15.49)).toBe(15);
    expect(tileZoomFor(15.5)).toBe(16);
    expect(tileZoomFor(18)).toBe(16);
  });
});

describe('tiles for a view', () => {
  it('asks for nothing below the Legend map zoom', () => {
    expect(tilesForView(berlin, 14.4)).toEqual({ tiles: [], visible: 0 });
  });

  it('lists the visible tiles first, nearest the centre first, then a ring', () => {
    const { tiles, visible } = tilesForView(berlin, 16);
    expect(visible).toBeGreaterThan(0);
    expect(tiles.every(([z]) => z === 16)).toBe(true);
    // the tile under the screen centre (13.4153, 52.50405) comes first
    expect(tileKey(tiles[0])).toBe('16/35210/21497');
    // the ring adds a tile on every side
    const xs = tiles.map(([, x]) => x), ys = tiles.map(([, , y]) => y);
    const vx = tiles.slice(0, visible).map(([, x]) => x), vy = tiles.slice(0, visible).map(([, , y]) => y);
    expect(Math.min(...xs)).toBe(Math.min(...vx) - 1);
    expect(Math.max(...ys)).toBe(Math.max(...vy) + 1);
    expect(new Set(tiles.map(tileKey)).size).toBe(tiles.length);
  });

  it('uses z15 tiles below zoom 15.5', () => {
    const { tiles } = tilesForView(berlin, 15);
    expect(tiles.every(([z]) => z === 15)).toBe(true);
  });

  it('never asks for more than the server takes in one call', () => {
    const { tiles, visible } = tilesForView([13.3, 52.45, 13.5, 52.55], 16);
    expect(tiles.length).toBe(MAX_TILES_PER_REQUEST);
    expect(visible).toBeLessThanOrEqual(MAX_TILES_PER_REQUEST);
  });

  it('wraps across the antimeridian and drops rows off the map', () => {
    const { tiles } = tilesForView([179.999, 85.04, -179.999 + 360, 85.05], 16);
    expect(tiles.every(([, x, y]) => x >= 0 && x < 2 ** 16 && y >= 0)).toBe(true);
  });
});

describe('tile URL', () => {
  it('points at the version folder of the public bucket', () => {
    expect(legendMapTileUrl('http://127.0.0.1:54321/', 'legend-map-tiles', 3)).toBe(
      'http://127.0.0.1:54321/storage/v1/object/public/legend-map-tiles/v3/{z}/{x}/{y}.webp',
    );
  });
});

describe('labels', () => {
  it('sit next to the tile, as JSON', () => {
    expect(legendMapLabelUrl(legendMapTileUrl('http://h', 'legend-map-tiles', 2), [16, 35210, 21497])).toBe(
      'http://h/storage/v1/object/public/legend-map-tiles/v2/16/35210/21497.json',
    );
  });

  it('become one feature collection, without duplicates', () => {
    const oranien = { name: 'Oranienstraße', lng: 13.42, lat: 52.5, rot: -12.5, water: 0 as const };
    const spree = { name: 'Spree', lng: 13.43, lat: 52.51, rot: 30, water: 1 as const };
    const fc = JSON.parse(labelsGeoJSON([[oranien], [oranien, spree], []]));
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]).toEqual({
      type: 'Feature',
      properties: { name: 'Oranienstraße', rot: -12.5, water: 0 },
      geometry: { type: 'Point', coordinates: [13.42, 52.5] },
    });
    expect(fc.features[1].properties.water).toBe(1);
  });
});

describe('polling', () => {
  it('backs off 1.5, 3, 6, 10 ... up to 15 s while tiles on screen are being painted', () => {
    let state: PollState | null = null;
    const delays: (number | null)[] = [];
    let now = 0;
    for (let i = 0; i < 6; i++) {
      const r = nextPoll(state, now, true, 20);
      delays.push(r.delayMs);
      state = r.state;
      now += r.delayMs ?? 0;
    }
    expect(delays).toEqual([1500, 3000, 6000, 10000, 15000, 15000]);
  });

  it('stops when nothing on screen is pending', () => {
    expect(nextPoll({ attempt: 2, since: 0, pending: 3 }, 5000, false, 3)).toEqual({ delayMs: null, state: null });
  });

  it('keeps asking as long as requested tiles keep getting painted', () => {
    // a pan queues more tiles than one painter finishes in minutes: every painted tile restarts the limit
    let state: PollState | null = null;
    let now = 0;
    let pending = 30;
    for (let i = 0; i < 100; i++) {
      const r = nextPoll(state, now, true, pending);
      expect(r.delayMs).not.toBeNull();
      state = r.state;
      now += r.delayMs!;
      if (i % 2 === 1) pending--; // one tile per two polls, about one every 30 s
    }
    expect(now).toBeGreaterThan(STALL_LIMIT_MS * 2);
  });

  it('stops after the stall limit without a painted tile, even when the camera moves inside the same tiles', () => {
    const first = nextPoll(null, 10_000, true, 5).state!;
    expect(first).toEqual({ attempt: 1, since: 10_000, pending: 5 });
    expect(nextPoll(first, 10_000 + STALL_LIMIT_MS - 1, true, 5).delayMs).not.toBeNull();
    expect(nextPoll(first, 10_000 + STALL_LIMIT_MS, true, 5).delayMs).toBeNull();
  });
});

describe('tile set keys', () => {
  it('ignore the order a camera move puts the tiles in', () => {
    const a = tilesForView(berlin, 16);
    const shuffled = { tiles: [...a.tiles.slice(0, a.visible).reverse(), ...a.tiles.slice(a.visible).reverse()], visible: a.visible };
    expect(tileSetKey(shuffled.tiles, shuffled.visible)).toBe(tileSetKey(a.tiles, a.visible));
  });

  it('change when a tile enters or leaves the screen', () => {
    const a = tilesForView(berlin, 16);
    expect(tileSetKey(a.tiles, a.visible - 1)).not.toBe(tileSetKey(a.tiles, a.visible));
  });

  it('give back the same tiles, visible first', () => {
    const a = tilesForView(berlin, 16);
    const b = tilesOfSetKey(tileSetKey(a.tiles, a.visible));
    expect(b.visible).toBe(a.visible);
    expect(new Set(b.tiles.slice(0, b.visible).map(tileKey))).toEqual(new Set(a.tiles.slice(0, a.visible).map(tileKey)));
    expect(new Set(b.tiles.map(tileKey))).toEqual(new Set(a.tiles.map(tileKey)));
  });
});
