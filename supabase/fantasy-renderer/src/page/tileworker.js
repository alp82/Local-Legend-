// A painter worker: the vendored painter/chunkworker.js, unchanged, plus one message it
// lacks. 'planLabels' returns a chunk's plan together with its label candidates, so the
// page can paint the names of neighbouring chunks that reach into a tile.
//
// region() below is chunkworker.js's region() with planOnly set; the check in
// test/renderer.test.mjs fails if the two ever give different plans (after a re-sync).
import '/painter/chunkworker.js';
import { paintRegion } from '/painter/painter5.js';
import { ensure, features } from '/painter/tiledata.js';

const chunkOnMessage = self.onmessage;
const box = (g, i, j) => [i * g.CW, j * g.CW, (i + 1) * g.CW, (j + 1) * g.CW];

async function planAndLabels(g, band, comp, i, j) {
  const BC = box(g, i, j);
  await ensure([BC[0] - 760 * g.kF, BC[1] - 760 * g.kF, BC[2] + 760 * g.kF, BC[3] + 760 * g.kF]);
  const r = await paintRegion({ chunk: BC, margin: g.M, band, ppm: g.ppm, kF: g.kF, q: g.q, lite: !!g.lite, comp, data: features, planOnly: true });
  return { plan: r.plan, labels: r.labels };
}

self.onmessage = async (e) => {
  if (e.data.type !== 'planLabels') return chunkOnMessage(e);
  const { id, g, band, comp, i, j } = e.data;
  try {
    self.postMessage({ id, ...(await planAndLabels(g, band, comp, i, j)) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
