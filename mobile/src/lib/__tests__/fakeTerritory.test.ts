import { describe, expect, it } from '@jest/globals';

import { cellsToTerritory, countCells, fakeCells, fakeSites, fakeWorld, type CellGrid } from '../fakeTerritory';
import { buildFog, cellSizeM, geometryStats, polygonsOf, signedArea } from '../geo';

/** Grid from rows of '#' (claimed) and '.' at an arbitrary spot. */
function grid(rows: string[]): CellGrid {
  const h = rows.length;
  const w = rows[0].length;
  const claimed = new Uint8Array(w * h);
  rows.forEach((r, j) => [...r].forEach((ch, i) => (claimed[j * w + i] = ch === '#' ? 1 : 0)));
  return { x0: 619_000, y0: 750_000, w, h, claimed };
}

const shape = (rows: string[]) => polygonsOf(cellsToTerritory(grid(rows))).map((p) => p.map((r) => r.length - 1));

describe('cellsToTerritory', () => {
  it('merges a block of cells into one rectangle with 4 corners', () => {
    expect(shape(['##', '##'])).toEqual([[4]]);
  });

  it('keeps only the corners of an L shape', () => {
    expect(shape(['#.', '##'])).toEqual([[6]]);
  });

  it('cuts unclaimed pockets as holes of their polygon', () => {
    const polys = polygonsOf(cellsToTerritory(grid(['#####', '#...#', '#.#.#', '#...#', '#####'])));
    // The ring with a hole, and the single cell inside the hole as its own polygon.
    expect(polys.map((p) => p.length).sort()).toEqual([1, 2]);
    const ringed = polys.find((p) => p.length === 2)!;
    expect(signedArea(ringed[0])).toBeGreaterThan(0); // outer CCW in lng/lat
    expect(signedArea(ringed[1])).toBeLessThan(0);
  });

  it('splits diagonal neighbors into separate polygons', () => {
    expect(shape(['#.', '.#'])).toEqual([[4], [4]]);
    expect(shape(['##.', '#.#', '.##'])).toEqual([[6], [6]]);
  });

  it('is empty without claimed cells', () => {
    expect(cellsToTerritory(grid(['..', '..'])).features).toEqual([]);
  });
});

describe('fake territory', () => {
  const center = { lat: 45.5017, lng: -73.5673 };

  it('claims about 50 km² from walks around the center', () => {
    const g = fakeCells({ center });
    const km2 = (countCells(g) * cellSizeM(center.lat) ** 2) / 1e6;
    expect(km2).toBeGreaterThanOrEqual(50);
    expect(km2).toBeLessThan(50.1);
  });

  it('is deterministic and places 500 sites, owned on land or as silhouettes nearby', () => {
    const small = fakeCells({ center, targetKm2: 2, radiusM: 1500 });
    const again = fakeCells({ center, targetKm2: 2, radiusM: 1500 });
    expect(again.claimed).toEqual(small.claimed);
    const sites = fakeSites(small);
    expect(sites).toHaveLength(500);
    expect(new Set(sites.map((s) => s.visibility))).toEqual(new Set(['owned', 'silhouette']));
    expect(sites.filter((s) => s.visibility === 'silhouette').every((s) => s.name === null)).toBe(true);
  });

  it('builds the 50 km² fog fast enough (prints timings)', () => {
    const world = fakeWorld({ center });
    const stats = geometryStats(world.territory.claimed);
    const runs = 50;
    let t0 = Date.now();
    let fog = buildFog(world.territory.claimed);
    for (let i = 1; i < runs; i++) fog = buildFog(world.territory.claimed);
    const buildMs = (Date.now() - t0) / runs;
    t0 = Date.now();
    let json = '';
    for (let i = 0; i < 10; i++) json = JSON.stringify(fog);
    const stringifyMs = (Date.now() - t0) / 10;
    console.log(
      [
        `fake world: ${(world.territory.areaM2 / 1e6).toFixed(1)} km², ${world.territory.totalCells} cells, generated in ${world.generateMs} ms`,
        `polygons ${stats.polygons}, rings ${stats.rings}, vertices ${stats.vertices}, sites ${world.sites.length}`,
        `buildFog: ${buildMs.toFixed(2)} ms average over ${runs} runs`,
        `fog JSON: ${(json.length / 1e6).toFixed(2)} MB, JSON.stringify ${stringifyMs.toFixed(1)} ms average`,
      ].join('\n'),
    );
    expect(buildMs).toBeLessThan(100);
  });
});
