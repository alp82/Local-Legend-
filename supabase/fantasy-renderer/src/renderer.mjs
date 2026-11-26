// A tile painter: the local server plus one headless Chromium page that runs the vendored
// prototype painter in a pool of Web Workers.
import { chromium } from 'playwright';

import { startServer } from './server.mjs';

export const PAINT_ZOOM = 16;

/**
 * @param {{ sourceDir: string, workers?: number, recycleAfter?: number, log?: (msg: string) => void }} opts
 * recycleAfter: tiles per page; the painter's workers keep plans and world-plan caches for good,
 * so a long-running page is replaced (default 300 tiles, env RECYCLE_TILES).
 */
export async function startRenderer({ sourceDir, workers = 4, recycleAfter = Number(process.env.RECYCLE_TILES || 300), log = () => {} }) {
  const server = await startServer({ sourceDir });
  // Software rendering only: the same Chromium build gives the same pixels on any machine.
  const browser = await chromium.launch({ args: ['--disable-gpu', '--use-angle=swiftshader'] });
  let closing = false;
  // If Chromium itself goes, nothing here can recover: exit, and let the container restart.
  browser.on('disconnected', () => {
    if (closing) return;
    log('Chromium exited; stopping');
    process.exit(1);
  });

  let page = null;
  let paintsOnPage = 0;
  let inflight = 0;
  let gate = null; // a page replacement in progress; paints wait for it
  async function freshPage(reason) {
    if (page) await page.close().catch(() => {});
    page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') log(`page ${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => log(`page error: ${e.message}`));
    page.on('crash', () => log('painter page crashed'));
    await page.goto(`${server.url}/page/render.html?workers=${workers}`);
    await page.waitForFunction(() => window.rendererReady === true, null, { timeout: 120_000 });
    paintsOnPage = 0;
    if (reason) log(`painter page replaced (${reason})`);
  }
  /** Replaces the page once the paints on it have finished. */
  function replacePage(reason) {
    gate ??= (async () => {
      while (inflight > 0) await new Promise((r) => setTimeout(r, 50));
      await freshPage(reason);
    })().finally(() => {
      gate = null;
    });
    return gate;
  }
  await freshPage();

  // After three failed fetches the painter treats a data tile as empty. So the source tiles a
  // paint is likely to read are fetched first, and a paint during which the server failed any
  // request is thrown away and the page reloaded.
  async function prefetch(x, y) {
    const [x0, y0, x1, y1] = tileBounds(x, y, PAINT_ZOOM);
    // The world plan reads wide windows (map metres, 1.4 mercator units each; the painter's README,
    // round 11): roads joined along real streets up to 2 km from an entrance, names within 2 km,
    // the valley floor within 1.5 km. Prefetching is only a head start: anything else is fetched
    // on demand through the same frozen store.
    const reach = 3000 * 1.4, near = 1600 * 1.4;
    const ofm = rangeOf([x0 - reach, y0 - reach, x1 + reach, y1 + reach], 14);
    const dem = rangeOf([x0 - near, y0 - near, x1 + near, y1 + near], 14);
    const jobs = [];
    for (let tx = ofm[0]; tx <= ofm[2]; tx++) for (let ty = ofm[1]; ty <= ofm[3]; ty++) jobs.push(server.ofmTile(14, tx, ty));
    for (let tx = dem[0]; tx <= dem[2]; tx++) for (let ty = dem[1]; ty <= dem[3]; ty++) jobs.push(server.demTile(`14/${tx}/${ty}.png`));
    await Promise.all(jobs);
  }

  return {
    /** The current page, for checks (test/renderer.test.mjs). */
    get page() {
      return page;
    },
    stats: server.stats,
    chromium: browser.version(),
    /**
     * Paints z16 tile x/y; returns { webp: Buffer, rgbaHash, labels, names, dropped, ms }.
     * labels: the tile's road and water names for the app; names: its village names (painted in);
     * dropped: road names left out because the painter drew no road there.
     * opts { edges, plans } add check data (see page/tileworker.js).
     */
    async paint(x, y, quality, opts = {}) {
      await prefetch(x, y);
      for (let attempt = 0; ; attempt++) {
        while (gate) await gate;
        if (paintsOnPage >= recycleAfter) {
          await replacePage(`after ${paintsOnPage} tiles`);
          continue;
        }
        inflight++;
        paintsOnPage++;
        const errorsBefore = server.stats.errors;
        let r, err;
        try {
          r = await page.evaluate(([a, b, q, o]) => window.paintTile(a, b, q, o), [x, y, quality, opts]);
        } catch (e) {
          err = e;
        } finally {
          inflight--;
        }
        if (err) {
          // A crashed or closed page loses every paint on it; anything else is the tile's own error.
          if (attempt >= 1 || !/crash|closed|destroyed/i.test(err.message)) throw err;
          log(`painting 16/${x}/${y} lost with the page (${err.message.split('\n')[0]}); trying again`);
          await replacePage('crash');
          continue;
        }
        if (server.stats.errors === errorsBefore) return { ...r, webp: Buffer.from(r.webp, 'base64') };
        if (attempt >= 1) throw new Error(`source data failed twice while painting 16/${x}/${y}`);
        log(`source error during 16/${x}/${y}; replacing the painter page and trying again`);
        await replacePage('source error');
      }
    },
    /** One z15 tile from its four z16 children (Buffers or null; order NW, NE, SW, SE). */
    async downsample(children, quality) {
      const b64 = children.map((c) => (c ? c.toString('base64') : null));
      while (gate) await gate;
      const r = await page.evaluate(([c, q]) => window.downsample(c, q), [b64, quality]);
      return Buffer.from(r, 'base64');
    },
    async close() {
      closing = true;
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
