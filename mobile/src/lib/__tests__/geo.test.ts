import { describe, expect, it } from '@jest/globals';

import { buildFog, findGaps, retryDelayMs, revealArea, signedArea, type Position } from '../geo';
import type { TerritoryGeoJSON } from '../territoryApi';

const square = (x: number, y: number, s = 0.001): Position[] => [
  [x, y],
  [x, y + s],
  [x + s, y + s],
  [x + s, y],
  [x, y],
]; // clockwise on purpose

function fc(...polygons: Position[][][]): TerritoryGeoJSON {
  return {
    type: 'FeatureCollection',
    features: polygons.map((coordinates) => ({
      type: 'Feature',
      properties: null,
      geometry: { type: 'Polygon', coordinates },
    })),
  };
}

function fogParts(claimed: TerritoryGeoJSON | null) {
  const geometry = buildFog(claimed).features[0].geometry as GeoJSON.MultiPolygon;
  return geometry.coordinates as Position[][][];
}

describe('buildFog', () => {
  it('covers the world with no claimed land', () => {
    const parts = fogParts(null);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(1);
    expect(signedArea(parts[0][0])).toBeGreaterThan(0);
  });

  it('cuts claimed outer rings as clockwise holes and handles MultiPolygons', () => {
    const multi: TerritoryGeoJSON = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: null,
          geometry: { type: 'MultiPolygon', coordinates: [[square(10, 50)], [[...square(11, 50)].reverse()]] },
        },
      ],
    };
    const [world, ...islands] = fogParts(multi);
    expect(islands).toHaveLength(0);
    expect(world).toHaveLength(3);
    expect(signedArea(world[0])).toBeGreaterThan(0);
    expect(signedArea(world[1])).toBeLessThan(0);
    expect(signedArea(world[2])).toBeLessThan(0);
  });

  it('turns enclaves inside claimed land back into fog islands', () => {
    const outer = square(10, 50, 0.01);
    const enclave = square(10.004, 50.004, 0.001);
    const [world, island] = fogParts(fc([outer, enclave]));
    expect(world).toHaveLength(2);
    expect(island).toHaveLength(1);
    expect(signedArea(island[0])).toBeGreaterThan(0);
  });

  it('closes unclosed rings', () => {
    const open = square(10, 50).slice(0, 4);
    const [world] = fogParts(fc([open]));
    expect(world[1][0]).toEqual(world[1][world[1].length - 1]);
  });
});

describe('revealArea', () => {
  it('is empty on first load', () => {
    expect(revealArea(null, fc([square(10, 50)])).features).toHaveLength(0);
  });

  it('skips unchanged polygons and returns new ones', () => {
    const a = square(10, 50);
    const b = square(11, 50);
    const reveal = revealArea(fc([a]), fc([a], [b]));
    expect(reveal.features).toHaveLength(1);
    expect((reveal.features[0].geometry as GeoJSON.Polygon).coordinates).toHaveLength(1);
  });

  it('cuts old land out of a grown polygon', () => {
    const old = square(10.002, 50.002, 0.001);
    const grown = square(10, 50, 0.01);
    const reveal = revealArea(fc([old]), fc([grown]));
    const rings = (reveal.features[0].geometry as GeoJSON.Polygon).coordinates as Position[][];
    expect(rings).toHaveLength(2);
    expect(signedArea(rings[0])).toBeGreaterThan(0);
    expect(signedArea(rings[1])).toBeLessThan(0);
  });
});

describe('findGaps', () => {
  it('reports pauses over the threshold with distance moved', () => {
    const fixes = [
      { t: 0, lat: 52, lng: 13 },
      { t: 60_000, lat: 52, lng: 13 },
      { t: 300_000, lat: 52.001, lng: 13 },
      { t: 310_000, lat: 52.001, lng: 13 },
    ];
    const gaps = findGaps(fixes, 120_000);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].fromT).toBe(60_000);
    expect(gaps[0].toT).toBe(300_000);
    expect(gaps[0].distanceM).toBeGreaterThan(100);
    expect(gaps[0].distanceM).toBeLessThan(120);
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially and caps at 15 minutes', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(20)).toBe(15 * 60_000);
  });
});
