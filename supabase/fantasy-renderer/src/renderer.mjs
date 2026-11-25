// A tile painter: the local server plus one headless Chromium page that runs the vendored
// prototype painter in a pool of Web Workers.
import { chromium } from 'playwright';

import { startServer } from './server.mjs';

export const PAINT_ZOOM = 16;

/**
 * @param {{ sourceDir: string, workers?: number, log?: (msg: string) => void }} opts
 */
export async function startRenderer({ sourceDir, workers = 4, log = () => {} }) {
  const server = await startServer({ sourceDir });
  // Software rendering only: the same Chromium build gives the same pixels on any machine.
  const browser = await chromium.launch({ args: ['--disable-gpu', '--use-angle=swiftshader'] });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log(`page ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => log(`page error: ${e.message}`));
  async function load() {
    await page.goto(`${server.url}/page/render.html?workers=${workers}`);
    await page.waitForFunction(() => window.rendererReady === true, null, { timeout: 120_000 });
  }
  await load();
  // A reload in progress; paints wait for it.
  let reloading = null;

  // The painter treats a failed source fetch as "no data" and the workers keep failed terrain
  // tiles for the session. So every source tile a paint reads is fetched before the paint, and
  // a paint during which the server failed any request is thrown away and the page reloaded.
  async function prefetch(x, y) {
    const [x0, y0, x1, y1] = tileBounds(x, y, PAINT_ZOOM);
    const ts = x1 - x0;
    const kF = 1 / Math.cos((Math.round(lngLatOf(0, (y0 + y1) / 2)[1] * 2) / 2) * (Math.PI / 180));
    // the tile and its 3×3 neighbourhood (their plans), each with the painter's data window
    const ofm = rangeOf([x0 - ts - 800 * kF, y0 - ts - 800 * kF, x1 + ts + 800 * kF, y1 + ts + 800 * kF], 14);
    const dem = rangeOf([x0 - ts - 100 * kF, y0 - ts - 100 * kF, x1 + ts + 100 * kF, y1 + ts + 100 * kF], 14);
    const jobs = [];
    for (let tx = ofm[0]; tx <= ofm[2]; tx++) for (let ty = ofm[1]; ty <= ofm[3]; ty++) jobs.push(server.ofmTile(14, tx, ty));
    for (let tx = dem[0]; tx <= dem[2]; tx++) for (let ty = dem[1]; ty <= dem[3]; ty++) jobs.push(server.demTile(`14/${tx}/${ty}.png`));
    await Promise.all(jobs);
  }

  return {
    /** The page, for checks (test/renderer.test.mjs). */
    page,
    stats: server.stats,
    chromium: browser.version(),
    /** Paints z16 tile x/y; returns { webp: Buffer, rgbaHash, labels, hearts, ms, tm }. */
    async paint(x, y, quality) {
      await prefetch(x, y);
      for (let attempt = 0; ; attempt++) {
        await reloading;
        const errorsBefore = server.stats.errors;
        const r = await page.evaluate(([a, b, q]) => window.paintTile(a, b, q), [x, y, quality]);
        if (server.stats.errors === errorsBefore) return { ...r, webp: Buffer.from(r.webp, 'base64') };
        if (attempt >= 1) throw new Error(`source data failed twice while painting 16/${x}/${y}`);
        log(`source error during 16/${x}/${y}; reloading the painter and trying again`);
        reloading ??= load().finally(() => {
          reloading = null;
        });
      }
    },
    /** One z15 tile from its four z16 children (Buffers or null; order NW, NE, SW, SE). */
    async downsample(children, quality) {
      const b64 = children.map((c) => (c ? c.toString('base64') : null));
      const r = await page.evaluate(([c, q]) => window.downsample(c, q), [b64, quality]);
      return Buffer.from(r, 'base64');
    },
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

const HALF = 20037508.342789244;
/** Mercator bounds [x0, y0, x1, y1] of tile x/y at zoom z. */
export function tileBounds(x, y, z) {
  const ts = (2 * HALF) / 2 ** z;
  return [x * ts - HALF, HALF - (y + 1) * ts, (x + 1) * ts - HALF, HALF - y * ts];
}
/** Tile range [x0, y0, x1, y1] at zoom z covering a mercator bbox. */
function rangeOf(bb, z) {
  const ts = (2 * HALF) / 2 ** z;
  return [Math.floor((bb[0] + HALF) / ts), Math.floor((HALF - bb[3]) / ts), Math.floor((bb[2] + HALF) / ts), Math.floor((HALF - bb[1]) / ts)];
}
/** XYZ tile containing a longitude/latitude at zoom z. */
export function tileOf(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x, y };
}
/** Longitude/latitude of mercator metres. */
export function lngLatOf(mx, my) {
  return [(mx / HALF) * 180, (Math.atan(Math.exp(my / 6378137)) * 2 - Math.PI / 2) * (180 / Math.PI)];
}
