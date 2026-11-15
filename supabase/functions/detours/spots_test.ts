// Run with: deno test --allow-read --allow-env supabase/functions/detours/
// Uses the sites fixture: the real OpenFreeMap tile 14/9099/5552 (Krakow's
// old town and Wawel), saved from the 2026-11-01 planet build.

import { assert, assertEquals } from 'jsr:@std/assert@1';
import { spotFeatures, type SpotRequest } from './spots.ts';

const tile = await Deno.readFile(new URL('../sites/testdata/krakow_14_9099_5552.pbf', import.meta.url));

// The shape private.detour_spot_filter() returns, trimmed.
const request: SpotRequest = {
  zoom: 14,
  keys: [
    { key: 'building.render_height', vals: null },
    { key: 'landuse.class', vals: ['cemetery', 'school'] },
    { key: 'poi.subclass', vals: ['artwork', 'park'] },
    { key: 'transportation.class', vals: ['minor', 'rail'] },
    { key: 'transportation.subclass', vals: ['footway', 'pedestrian'] },
  ],
};

const { features } = spotFeatures(tile, 9099, 5552, request);

Deno.test('forwards only features the request names', () => {
  assert(features.length > 100);
  for (const f of features) {
    const matches = request.keys.some(({ key, vals }) => key in f.tags && (vals === null || vals.includes(f.tags[key])));
    assert(matches, JSON.stringify(f.tags));
  }
  assert(features.every((f) => f.tags['poi.subclass'] !== 'waste_basket'));
});

Deno.test('keeps every property, so the database can drop closed and private ways', () => {
  const closed = features.filter((f) => f.tags['transportation.access'] === 'no');
  assert(closed.length > 0, 'the tile has ways with access=no');
  const tunnels = features.filter((f) => f.tags['transportation.brunnel'] === 'tunnel');
  assert(tunnels.length > 0, 'the tile has footways in tunnels');
  assert(features.every((f) => !Object.keys(f.tags).some((k) => k.startsWith('name_'))), 'no name variants');
});

Deno.test('gives full geometry by type', () => {
  const dragon = features.find((f) => f.tags.name === 'Smok Wawelski')!;
  assertEquals(dragon.type, 'point');
  assertEquals(dragon.geometry.type, 'Point');

  const footways = features.filter((f) => f.tags['transportation.subclass'] === 'footway' && f.type === 'line');
  assert(footways.length > 10);
  for (const f of footways) {
    assertEquals(f.geometry.type, 'MultiLineString');
    const lines = f.geometry.coordinates as [number, number][][];
    assert(lines.every((l) => l.length >= 2));
  }

  const buildings = features.filter((f) => 'building.render_height' in f.tags);
  assert(buildings.length > 100);
  for (const f of buildings) {
    assertEquals(f.type, 'polygon');
    const rings = f.geometry.coordinates as [number, number][][];
    assert(rings.every((r) => r.length >= 4 && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1]), 'closed rings');
  }
});

Deno.test('converts tile coordinates to WGS84', () => {
  const dragon = features.find((f) => f.tags.name === 'Smok Wawelski')!;
  const [lon, lat] = dragon.geometry.coordinates as [number, number];
  // The Wawel Dragon statue, from openstreetmap.org.
  assert(Math.abs(lat - 50.0531) < 0.001 && Math.abs(lon - 19.9330) < 0.001, `${lat}, ${lon}`);
});
