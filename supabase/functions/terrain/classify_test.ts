// Run with: deno test --allow-read --allow-env supabase/functions/terrain/
// Uses the sites fixture: the real OpenFreeMap tile 14/9099/5552 (Krakow's
// old town, Wawel, and the Vistula), saved from the 2026-11-01 planet build.

import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';
import { classifyTile, type TerrainRequest } from './classify.ts';

const tile = await Deno.readFile(new URL('../sites/testdata/krakow_14_9099_5552.pbf', import.meta.url));

// The request private.terrain_filter() sends: the classes come straight from
// the economy migration, so the test exercises the real rules.
const migrations = new URL('../../migrations/', import.meta.url);
let classesJson: string | undefined;
for await (const entry of Deno.readDir(migrations)) {
  if (!entry.name.endsWith('_economy.sql')) continue;
  const sql = await Deno.readTextFile(new URL(entry.name, migrations));
  classesJson = sql.match(/create function private\.terrain_classes\(\)[\s\S]*?\$json\$([\s\S]*?)\$json\$/)?.[1];
}
assert(classesJson, 'private.terrain_classes() not found in supabase/migrations/*_economy.sql');
const request: TerrainRequest = { ...JSON.parse(classesJson), zoom: 14, grid: 128 };

const grid = classifyTile(tile, 9099, 5552, request);

/** The code of the claim cell (zoom 21) holding a point. */
function at(g: string, lat: number, lng: number): string {
  const n = 2 ** 21;
  const x = Math.floor(((lng + 180) / 360) * n) - 9099 * 128;
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) - 5552 * 128;
  assert(x >= 0 && x < 128 && y >= 0 && y < 128, `${lat}, ${lng} is outside the tile`);
  return g[y * 128 + x];
}

Deno.test('the request has the four terrains of the rules, in priority order', () => {
  assertEquals(request.classes.map((c) => c.terrain), ['hills', 'waterside', 'park', 'builtUp']);
});

Deno.test('returns one code per claim cell', () => {
  assertEquals(grid.length, 128 * 128);
  assertMatch(grid, /^[hwpb-]+$/);
});

Deno.test('classifies known places in Krakow', () => {
  assertEquals(at(grid, 50.052, 19.933), 'w', 'the Vistula below Wawel');
  assertEquals(at(grid, 50.054, 19.9355), 'h', 'Wawel hill, next to its viewpoints');
  assertEquals(at(grid, 50.061, 19.9325), 'p', 'the Planty, the park ring around the old town');
  assertEquals(at(grid, 50.058, 19.9375), 'b', 'Grodzka Street in the old town');
});

Deno.test('the old town is mostly built-up, with some of every class', () => {
  const counts: Record<string, number> = {};
  for (const c of grid) counts[c] = (counts[c] ?? 0) + 1;
  assert(counts.b / grid.length > 0.5, `built-up share ${counts.b / grid.length}`);
  for (const code of ['h', 'w', 'p', '-']) assert((counts[code] ?? 0) > 100, `${code}: ${counts[code]}`);
});

Deno.test('the first class that matches wins', () => {
  const park = request.classes.find((c) => c.terrain === 'park')!;
  const builtUp = request.classes.find((c) => c.terrain === 'builtUp')!;
  const parkFirst = classifyTile(tile, 9099, 5552, { ...request, classes: [park, builtUp] });
  const builtFirst = classifyTile(tile, 9099, 5552, { ...request, classes: [builtUp, park] });
  assertEquals(at(parkFirst, 50.061, 19.9325), 'p');
  assertEquals(at(builtFirst, 50.061, 19.9325), 'b', 'the Planty has buildings nearby, so built-up wins when it comes first');
});

Deno.test('a buffer widens a class around its features', () => {
  const water = request.classes.find((c) => c.terrain === 'waterside')!;
  const narrow = classifyTile(tile, 9099, 5552, { ...request, classes: [{ ...water, match: water.match.map((m) => ({ ...m, buffer_m: 0 })) }] });
  const wide = classifyTile(tile, 9099, 5552, { ...request, classes: [water] });
  const count = (g: string) => [...g].filter((c) => c === 'w').length;
  assert(count(wide) > count(narrow), `${count(wide)} > ${count(narrow)}`);
  for (let i = 0; i < narrow.length; i++) if (narrow[i] === 'w') assertEquals(wide[i], 'w');
});

Deno.test('an empty tile is all none', () => {
  assertEquals(classifyTile(new Uint8Array(), 9099, 5552, request), '-'.repeat(128 * 128));
});
