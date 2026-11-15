// Run with: deno test --allow-read --allow-env supabase/functions/detours/
// Uses the sites fixture: the real OpenFreeMap tile 14/9099/5552 (Krakow).

import { assert, assertEquals } from 'jsr:@std/assert@1';
import { type Admin, areaTile, type LeasedArea, loadAreas } from './areas.ts';

const tile = await Deno.readFile(new URL('../sites/testdata/krakow_14_9099_5552.pbf', import.meta.url));
const request = { zoom: 14, keys: [{ key: 'transportation.class', vals: ['minor'] }] };
const krakow = 9099 * 2 ** 14 + 5552;

/** A fake service-role client that records calls and how many ingests overlap. */
function fakeAdmin(ingestMs: number, failArea?: number) {
  const calls: { fn: string; area: number }[] = [];
  let running = 0;
  let maxRunning = 0;
  const admin: Admin = {
    async rpc(fn, args) {
      const area = args.p_area as number;
      calls.push({ fn, area });
      if (fn !== 'ingest_detour_area') return { data: null, error: null };
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, ingestMs));
      running--;
      if (area === failArea) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      return { data: { area, spots: 1 }, error: null };
    },
  };
  return { admin, calls, maxRunning: () => maxRunning };
}

Deno.test('areaTile splits an area id into the tile column and row', () => {
  assertEquals(areaTile(krakow, 14), { x: 9099, y: 5552 });
});

Deno.test('downloads every tile at once but runs one ingest at a time, nearest first', async () => {
  const areas: LeasedArea[] = [krakow, krakow + 1, krakow + 2, krakow + 3].map((area) => ({ area, request }));
  const { admin, calls, maxRunning } = fakeAdmin(20);
  let downloading = 0;
  let maxDownloading = 0;
  const done: number[] = [];
  await loadAreas(admin, areas, {
    timeoutMs: 1_000,
    fetchTile: async () => {
      downloading++;
      maxDownloading = Math.max(maxDownloading, downloading);
      await new Promise((resolve) => setTimeout(resolve, 10));
      downloading--;
      return tile;
    },
    onDone: (area) => done.push(area),
  });
  assertEquals(maxRunning(), 1, 'ingest_detour_area calls never overlap');
  assertEquals(maxDownloading, 4, 'the downloads run together');
  assertEquals(calls.map((c) => c.area), areas.map((a) => a.area));
  assertEquals(done, areas.map((a) => a.area));
});

Deno.test('a failed download or ingest releases that lease and the rest still load', async () => {
  const areas: LeasedArea[] = [krakow, krakow + 1, krakow + 2].map((area) => ({ area, request }));
  const { admin, calls } = fakeAdmin(1, krakow + 2);
  const quiet = console.error;
  console.error = () => {};
  try {
    await loadAreas(admin, areas, {
      timeoutMs: 1_000,
      fetchTile: (_z, _x, y) => (y === 5553 ? Promise.reject(new Error('tile 14/9099/5553: HTTP 503')) : Promise.resolve(tile)),
    });
  } finally {
    console.error = quiet;
  }
  assertEquals(calls, [
    { fn: 'ingest_detour_area', area: krakow },
    { fn: 'fail_detour_area', area: krakow + 1 },
    { fn: 'ingest_detour_area', area: krakow + 2 },
    { fn: 'fail_detour_area', area: krakow + 2 },
  ]);
  assert(calls.every((c) => c.fn !== 'ingest_detour_area' || c.area !== krakow + 1), 'no ingest without a tile');
});
