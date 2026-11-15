import { describe, expect, it } from '@jest/globals';

import { cellFromId, cellGridLines, cellId, cellSizeM, cellXY, padBBox, tileXYToLngLat } from '../geo';

describe('zoom-21 cells', () => {
  it('numbers cells as x * 2^21 + y, like the backend', () => {
    expect(cellId(0, 0)).toBe(0);
    expect(cellId(1, 2)).toBe(2 ** 21 + 2);
    expect(cellId(2 ** 21 - 1, 2 ** 21 - 1)).toBe(2 ** 42 - 1);
    expect(cellFromId(cellId(1234567, 765432))).toEqual({ x: 1234567, y: 765432 });
  });

  it('uses XYZ tile numbering (y grows south)', () => {
    expect(cellXY(0, 0)).toEqual({ x: 2 ** 20, y: 2 ** 20 });
    expect(cellXY(-180, 85.06)).toEqual({ x: 0, y: 0 });
    // Montreal: the zoom-21 cell lies in zoom-13 tile 2421/2930 (OSM slippy-map formula).
    const c = cellXY(-73.5673, 45.5017);
    expect([c.x >> 8, c.y >> 8]).toEqual([2421, 2930]);
    const lat = (45.5017 * Math.PI) / 180;
    expect(c.y).toBe(Math.floor(((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * 2 ** 21));
  });

  it('puts a point inside the cell it maps to', () => {
    for (const [lng, lat] of [
      [-73.5673, 45.5017],
      [13.405, 52.52],
      [151.2093, -33.8688],
    ]) {
      const { x, y } = cellXY(lng, lat);
      const [w, n] = tileXYToLngLat(x, y, 21);
      const [e, s] = tileXYToLngLat(x + 1, y + 1, 21);
      expect(lng).toBeGreaterThanOrEqual(w);
      expect(lng).toBeLessThan(e);
      expect(lat).toBeLessThanOrEqual(n);
      expect(lat).toBeGreaterThan(s);
    }
  });

  it('has the documented ground size', () => {
    expect(cellSizeM(0)).toBeCloseTo(19.11, 2);
    expect(cellSizeM(52)).toBeCloseTo(11.76, 1);
  });
});

describe('cellGridLines', () => {
  it('draws one line per cell edge across the box, on cell boundaries', () => {
    const { x, y } = cellXY(-73.5673, 45.5017);
    const [w, n] = tileXYToLngLat(x + 0.5, y + 0.5, 21);
    const [e, s] = tileXYToLngLat(x + 3.5, y + 2.5, 21);
    const fc = cellGridLines([w, s, e, n])!;
    const lines = (fc.features[0].geometry as GeoJSON.MultiLineString).coordinates;
    // Columns x .. x+4 (5 lines) and rows y .. y+3 (4 lines).
    expect(lines).toHaveLength(9);
    expect(lines[0][0][0]).toBeCloseTo(tileXYToLngLat(x, 0, 21)[0], 10);
    expect(lines[5][0][1]).toBeCloseTo(tileXYToLngLat(0, y, 21)[1], 10);
  });

  it('gives up when zoomed out too far', () => {
    expect(cellGridLines([-73.6, 45.4, -73.5, 45.5])).toBeNull();
  });
});

describe('padBBox', () => {
  it('pads each side by a fraction of the size', () => {
    expect(padBBox([0, 0, 10, 20], 0.2)).toEqual([-2, -4, 12, 24]);
  });
});
