import { describe, expect, it } from '@jest/globals';

import { bboxOfTiles, SiteCache, tileOf, tilesForBBox } from '../siteCache';
import type { BBox, Site } from '../sitesApi';

const site = (id: string, lng: number, lat: number): Site => ({
  id,
  kind: 'place',
  subtype: 'cafe',
  name: id,
  lng,
  lat,
  visibility: 'owned',
});

const box: BBox = [-73.58, 45.49, -73.55, 45.51];

describe('grid keys', () => {
  it('covers a box with the tiles that intersect it', () => {
    const keys = tilesForBBox(box);
    expect(keys.length).toBeGreaterThan(1);
    expect(keys).toContain(tileOf(-73.567, 45.5));
    const outer = bboxOfTiles(keys);
    expect(outer[0]).toBeLessThanOrEqual(box[0]);
    expect(outer[1]).toBeLessThanOrEqual(box[1]);
    expect(outer[2]).toBeGreaterThanOrEqual(box[2]);
    expect(outer[3]).toBeGreaterThanOrEqual(box[3]);
  });
});

describe('SiteCache', () => {
  it('reports nothing missing once a box is fetched, so panning back does not refetch', () => {
    const cache = new SiteCache();
    const keys = cache.missing(box);
    cache.store(keys, [site('a', -73.567, 45.5), site('b', -73.56, 45.495)]);
    expect(cache.missing(box)).toEqual([]);
    expect(cache.missing([-73.575, 45.495, -73.56, 45.505])).toEqual([]);
    expect(cache.all().map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('only fetches the new tiles after panning, and keeps each site once', () => {
    const cache = new SiteCache();
    cache.store(cache.missing(box), [site('a', -73.567, 45.5)]);
    const moved: BBox = [-73.56, 45.49, -73.52, 45.51];
    const missing = cache.missing(moved);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.length).toBeLessThan(tilesForBBox(moved).length);
    // The server answers for the whole box, including site a again.
    cache.store(missing, [site('a', -73.567, 45.5), site('c', -73.53, 45.5)]);
    expect(cache.all().map((s) => s.id).sort()).toEqual(['a', 'c']);
  });

  it('evicts the oldest tiles past its size limit and empties on clear', () => {
    const cache = new SiteCache(2);
    cache.store(['1/1'], []);
    cache.store(['1/2'], []);
    cache.store(['1/3'], []);
    expect(cache.size).toBe(2);
    expect(cache.missing(bboxOfTiles(['1/1'], 14).map((v, i) => v + (i < 2 ? 1e-9 : -1e-9)) as BBox)).toEqual(['1/1']);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
