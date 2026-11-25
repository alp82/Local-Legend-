import { describe, expect, it } from '@jest/globals';

import { fantasyLabelUrl, fantasyTileUrl, labelsGeoJSON, MAX_TILES_PER_REQUEST, tileKey, tileZoomFor, tilesForView } from '../fantasyTiles';
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
  it('asks for nothing below the fantasy map zoom', () => {
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
    expect(fantasyTileUrl('http://127.0.0.1:54321/', 'fantasy-tiles', 3)).toBe(
      'http://127.0.0.1:54321/storage/v1/object/public/fantasy-tiles/v3/{z}/{x}/{y}.webp',
    );
  });
});

describe('labels', () => {
  it('sit next to the tile, as JSON', () => {
    expect(fantasyLabelUrl(fantasyTileUrl('http://h', 'fantasy-tiles', 2), [16, 35210, 21497])).toBe(
      'http://h/storage/v1/object/public/fantasy-tiles/v2/16/35210/21497.json',
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
