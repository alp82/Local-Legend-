// Run with: deno test --allow-read --allow-env supabase/functions/sites/
// The fixture is the real OpenFreeMap tile 14/9099/5552 (Krakow's old town and
// Wawel), saved from the 2026-11-01 planet build.

import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import { featureId, normalizeTile, osmId, type SourceFilter, USER_AGENT } from './openfreemap.ts';

const tile = await Deno.readFile(new URL('./testdata/krakow_14_9099_5552.pbf', import.meta.url));

// The shape private.source_filter() returns, trimmed.
const filter: SourceFilter = {
  zoom: 14,
  grid: 8,
  keys: [
    { key: 'poi.subclass', vals: ['artwork', 'castle', 'cafe', 'park'] },
    { key: 'landcover.subclass', vals: ['park'] },
    { key: 'landuse.class', vals: ['cemetery'] },
    { key: 'transportation_name.subclass', vals: ['steps'] },
  ],
};

const payload = normalizeTile(tile, 9099, 5552, filter);
const byId = new Map(payload.elements.map((e) => [e.id, e]));

Deno.test('decodes OSM ids from the feature id', () => {
  assertEquals(osmId(2780576981), 'node/278057698');
  assertEquals(osmId(7855504152), 'way/785550415');
  assertEquals(osmId(22703), 'relation/2270');
  assertEquals(osmId(undefined), null);
  assertEquals(osmId(40), null);
});

Deno.test('keeps only features the filter names, with layer-prefixed tags', () => {
  const dragon = byId.get('node/278057698')!;
  assertEquals(dragon.tags.name, 'Smok Wawelski');
  assertEquals(dragon.tags['poi.class'], 'art_gallery');
  assertEquals(dragon.tags['poi.subclass'], 'artwork');
  assert(payload.elements.every((e) => e.tags['poi.subclass'] !== 'waste_basket'), 'no unlisted POIs');
  assert(payload.elements.every((e) => !Object.keys(e.tags).some((k) => k.startsWith('name_'))), 'no name variants');
});

Deno.test('converts tile coordinates to WGS84', () => {
  const castle = byId.get('way/785550415')!;
  assertEquals(castle.tags.name, 'Zamek Wawel');
  // Wawel Castle, from openstreetmap.org.
  assertAlmostEquals(castle.lat!, 50.054, 0.002);
  assertAlmostEquals(castle.lon!, 19.935, 0.003);
  for (const e of payload.elements) {
    const pts = e.geometry ? e.geometry.coordinates.flat() : [[e.lon!, e.lat!]];
    assert(pts.every(([lon, lat]) => lon > 19.92 && lon < 19.96 && lat > 50.04 && lat < 50.07), e.id);
  }
});

Deno.test('merges a park POI with its landcover polygon', () => {
  const park = byId.get('way/1221128266')!;
  assertEquals(park.tags.name, 'Planty');
  assertEquals(park.tags['poi.subclass'], 'park');
  assertEquals(park.tags['landcover.subclass'], 'park');
  assert(park.lat !== undefined, 'keeps the POI point');
  assertEquals(park.geometry?.type, 'MultiLineString');
  const ring = park.geometry!.coordinates[0];
  assertEquals(ring[0], ring[ring.length - 1], 'rings stay closed');
});

Deno.test('turns zone polygons into rings without a point', () => {
  const cemetery = payload.elements.find((e) => e.tags['landuse.class'] === 'cemetery' && !e.tags['poi.class'])!;
  assert(cemetery.geometry && cemetery.lat === undefined);
});

Deno.test('gives named steps a point on the line', () => {
  const steps = payload.elements.find((e) => e.tags['transportation_name.subclass'] === 'steps')!;
  assertEquals(steps.id, 'way/827644994');
  assert(steps.lat !== undefined && steps.geometry === undefined);
});

Deno.test('measures building cover on the 8 x 8 grid', () => {
  const cover = payload.building_cover;
  assertEquals(cover.length, 64);
  assert(cover.every((v) => v >= 0 && v <= 1));
  // Old town blocks are dense; the Vistula bank in the south-west is not.
  assert(Math.max(...cover) > 0.6);
  assert(cover[5 * 8 + 0] < 0.1);
});

Deno.test('the same tile always gives the same payload', () => {
  assertEquals(JSON.stringify(normalizeTile(tile, 9099, 5552, filter)), JSON.stringify(payload));
});

Deno.test('hashes features without an id', () => {
  const tags = { 'poi.class': 'cafe', 'poi.subclass': 'cafe', name: 'X' };
  const a = featureId(undefined, 'poi', tags, { x: 10, y: 20 });
  assert(/^hash\/[0-9a-f]{16}$/.test(a), a);
  assertEquals(featureId(0, 'poi', tags, { x: 10, y: 20 }), a, 'id 0 counts as missing');
  assert(featureId(undefined, 'poi', tags, { x: 11, y: 20 }) !== a, 'position matters');
  assert(featureId(undefined, 'poi', { ...tags, name: 'Y' }, { x: 10, y: 20 }) !== a, 'name matters');
  assertEquals(featureId(2780576981, 'poi', tags, { x: 10, y: 20 }), 'node/278057698');
  assert(payload.elements.every((e) => /^(node|way|relation)\/\d+$/.test(e.id)), 'the fixture has OSM ids everywhere');
});

Deno.test('an empty tile gives an empty payload', () => {
  const empty = normalizeTile(new Uint8Array(), 9099, 5552, filter);
  assertEquals(empty.elements, []);
  assertEquals(empty.building_cover, new Array(64).fill(0));
});

Deno.test('the user agent names the app and nothing personal', () => {
  assertEquals(USER_AGENT, 'LocalLegendPrototype/0.1');
});
