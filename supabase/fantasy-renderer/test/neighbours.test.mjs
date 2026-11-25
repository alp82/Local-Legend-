// Neighbouring tiles must agree where they meet, even when they're painted in different
// browsers, from different paint histories, with different tiles painted before them.
//
// For each pair of adjacent tiles T and N:
//   - browser A paints T first, from a fresh start;
//   - browser B first paints the two tiles beyond N (away from T), then N.
// Then:
//   1. Plans: the plan of T and the plan of N must be the same in both browsers. A sprite
//      that crosses the edge is drawn by both tiles from its owner's plan, so this is what
//      makes its two halves match.
//   2. Set pieces across the edge: listed, and each must be owned by exactly one plan; no two
//      settlement set pieces in the nine plans around T stand on the same ground.
//   3. Seam: the last pixel column (or row) of T against the first of N, in 16-px segments,
//      compared with the change between neighbouring columns inside each tile. A road that
//      stops at the edge or a piece cut in half shows up as a segment that changes far more
//      across the edge than inside the tiles.
//
// Needs the network the first time (source tiles are then kept in .source/). Slow: ~30 s.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { startRenderer, tileBounds, tileOf, lngLatOf } from '../src/renderer.mjs';

// The painted settlements (hearts, hamlets, farmsteads), from the art index.
const SET_PIECES = new Set(
  Object.entries(JSON.parse(readFileSync(new URL('../assets/index.json', import.meta.url), 'utf8')))
    .filter(([, m]) => String(m.src).startsWith('concept/setpieces'))
    .map(([n]) => n),
);
const sourceDir = resolve(process.env.SOURCE_CACHE_DIR ?? '.source');
const PX = 1024;
const EDGE_PX = 3;
const SEGMENT = 16;

// Pairs around village hearts in three cities, and two where a set piece itself lies across
// the edge. [name, z16 x, z16 y of T, direction of N, set piece that must cross (or null)]
const at = (lng, lat) => Object.values(tileOf(lng, lat, 16));
const PAIRS = [
  ['Berlin Luisenstadt, east edge', ...at(13.4153, 52.50405), 'east', null],
  ['Berlin Luisenstadt, south edge', ...at(13.4153, 52.50405), 'south', null],
  ['Manhattan Midtown, east edge', ...at(-73.98674, 40.75628), 'east', null],
  ['Innsbruck Sankt Nikolaus, south edge', ...at(11.39186, 47.272375), 'south', null],
  ['Berlin walled town across an east edge', 35206, 21500, 'east', 'walled-town-grey-corner'],
  ['Berlin town across a south edge', 35208, 21500, 'south', 'town-orchard-market'],
];

const rgba = (b64) => Buffer.from(b64, 'base64');
/** Column c (0..EDGE_PX-1) of a vertical strip, or row r of a horizontal one, as RGB triples. */
function line(strip, k, vertical) {
  const out = [];
  if (vertical) for (let y = 0; y < PX; y++) { const o = (y * EDGE_PX + k) * 4; out.push([strip[o], strip[o + 1], strip[o + 2]]); }
  else for (let x = 0; x < PX; x++) { const o = (k * PX + x) * 4; out.push([strip[o], strip[o + 1], strip[o + 2]]); }
  return out;
}
const diff = (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;

/** Segments where the change across the edge is far above the change inside either tile. */
function seamFaults(a1, a0, b0, b1) {
  const faults = [];
  for (let s = 0; s < PX; s += SEGMENT) {
    let across = 0, inside = 0;
    for (let k = s; k < s + SEGMENT; k++) {
      across += diff(a0[k], b0[k]);
      inside += (diff(a1[k], a0[k]) + diff(b0[k], b1[k])) / 2;
    }
    across /= SEGMENT;
    inside /= SEGMENT;
    if (across > 2.5 * inside + 12) faults.push({ at: s, across: +across.toFixed(1), inside: +inside.toFixed(1) });
  }
  return faults;
}

/** Plan objects of tile (x, y) whose sprite box crosses its edge on side `dir` (east, south, west, north). */
function crossing(planJson, x, y, dir) {
  const [x0, y0, x1, y1] = tileBounds(x, y, 16);
  const ts = x1 - x0;
  const lat = lngLatOf(0, (y0 + y1) / 2)[1];
  const kF = 1 / Math.cos((Math.round(lat * 2) / 2) * (Math.PI / 180));
  const sx = PX / ts, ppm = sx * kF;
  return JSON.parse(planJson).filter((o) => {
    const w = o.w * ppm, h = o.h * ppm, px = (o.wx - x0) * sx, py = (y1 - o.wy) * sx;
    const left = px - w * o.ax, right = px + w * (1 - o.ax), top = py - h * o.ay, bottom = py + h * (1 - o.ay);
    if (dir === 'east') return left < PX && right > PX;
    if (dir === 'south') return top < PX && bottom > PX;
    if (dir === 'west') return left < 0 && right > 0;
    return top < 0 && bottom > 0; // north
  });
}

for (const [name, x, y, dir, piece] of PAIRS) {
  test(`neighbours agree: ${name}`, async () => {
    const [dx, dy] = dir === 'east' ? [1, 0] : [0, 1];
    const T = [x, y], N = [x + dx, y + dy];
    const a = await startRenderer({ sourceDir, workers: 2 });
    const b = await startRenderer({ sourceDir, workers: 3 });
    try {
      const pa = await a.paint(T[0], T[1], 0.8, { edges: true, plans: true });
      await b.paint(N[0] + 2 * dx, N[1] + 2 * dy, 0.8);
      await b.paint(N[0] + dx, N[1] + dy, 0.8);
      const pb = await b.paint(N[0], N[1], 0.8, { edges: true, plans: true });

      const kT = `${T[0]}/${T[1]}`, kN = `${N[0]}/${N[1]}`;
      assert.equal(pb.plans[kT], pa.plans[kT], `the plan of ${kT} is the same in both browsers`);
      assert.equal(pb.plans[kN], pa.plans[kN], `the plan of ${kN} is the same in both browsers`);

      const back = dir === 'east' ? 'west' : 'north';
      const spanning = [...crossing(pa.plans[kT], T[0], T[1], dir), ...crossing(pa.plans[kN], N[0], N[1], back)];
      // every object belongs to exactly one plan
      const owners = (o) => [pa.plans[kT], pa.plans[kN]].filter((p) => JSON.parse(p).some((q) => q.name === o.name && q.wx === o.wx && q.wy === o.wy)).length;
      for (const o of spanning) assert.equal(owners(o), 1, `${o.name} at ${o.wx}, ${o.wy} has one owner`);

      if (piece) assert.ok(spanning.some((o) => o.name === piece), `${piece} lies across the edge`);

      // A heart decided twice (once per window) would put two set pieces on the same ground.
      const big = Object.values(pa.plans).flatMap((pl) => JSON.parse(pl)).filter((o) => SET_PIECES.has(o.name));
      const box = (o) => [o.wx - o.w * o.ax, o.wy - o.h * (1 - o.ay), o.wx + o.w * (1 - o.ax), o.wy + o.h * o.ay];
      for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) {
        const [a0, a1, a2, a3] = box(big[i]), [b0, b1, b2, b3] = box(big[j]);
        const ov = Math.max(0, Math.min(a2, b2) - Math.max(a0, b0)) * Math.max(0, Math.min(a3, b3) - Math.max(a1, b1));
        const smaller = Math.min((a2 - a0) * (a3 - a1), (b2 - b0) * (b3 - b1));
        assert.ok(ov < 0.35 * smaller, `${big[i].name} and ${big[j].name} don't stand on the same ground`);
      }

      const ea = pa.edges, eb = pb.edges;
      const vertical = dir === 'east';
      const sa = rgba(vertical ? ea.right : ea.bottom), sb = rgba(vertical ? eb.left : eb.top);
      const faults = seamFaults(line(sa, EDGE_PX - 2, vertical), line(sa, EDGE_PX - 1, vertical), line(sb, 0, vertical), line(sb, 1, vertical));
      const pieces = spanning.filter((o) => o.solid).map((o) => o.name);
      console.log(`  ${name}: ${spanning.length} sprites cross the edge (${pieces.length} solid: ${[...new Set(pieces)].join(', ') || 'none'}); seam faults: ${faults.length}`);
      assert.deepEqual(faults, [], `no seam faults between ${kT} and ${kN}`);
    } finally {
      await a.close();
      await b.close();
    }
  });
}

test('the seam check finds edges that do not belong together', async () => {
  const a = await startRenderer({ sourceDir, workers: 2 });
  try {
    // A tile's east edge against its own west edge: the same tile, but not neighbours.
    const p = await a.paint(35206, 21500, 0.8, { edges: true });
    const r = rgba(p.edges.right), l = rgba(p.edges.left);
    const faults = seamFaults(line(r, EDGE_PX - 2, true), line(r, EDGE_PX - 1, true), line(l, 0, true), line(l, 1, true));
    console.log(`  control: ${faults.length} of ${PX / SEGMENT} segments flagged`);
    assert.ok(faults.length >= 8, `the check flags a mismatched edge (${faults.length} segments)`);
  } finally {
    await a.close();
  }
});
