// The local HTTP server the headless browser paints from. It serves the vendored painter,
// the art, and the painter's two data feeds:
//
// - /ofm/: OpenFreeMap vector tiles. Every source tile is frozen: the first copy fetched is
//   stored and served forever after, so tiles painted weeks apart read the same data and still
//   meet at their edges. The OpenFreeMap build is pinned on first use (pinned.json).
// - /dem/: AWS terrain tiles (terrarium), stored the same way.
//
// The store is a directory (SOURCE_CACHE_DIR). It isn't a cache in the sense of being
// disposable: deleting it lets OpenStreetMap changes in, which can make new tiles disagree
// with neighbours painted before.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
const DEM = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/';
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.pbf': 'application/x-protobuf',
  '.ttf': 'font/ttf',
};
// Only these folders are served; the page and the painter never need anything else.
const STATIC = { '/painter/': 'painter', '/assets/': 'assets', '/page/': 'src/page' };

async function fetchRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok || res.status === 404) return res;
      last = new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 300 * 2 ** i));
  }
  throw last;
}

async function writeAtomic(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

/** A store of frozen upstream files under `dir`; concurrent requests for one key share a fetch. */
function frozenStore(dir, stats) {
  const inflight = new Map();
  return async function get(key, fetchUpstream) {
    const file = join(dir, key);
    try {
      const bytes = await readFile(file);
      stats.hit++;
      return bytes;
    } catch {}
    if (!inflight.has(key)) {
      inflight.set(
        key,
        (async () => {
          const bytes = await fetchUpstream();
          // A missing upstream tile (404) is real data too (open sea, the poles): store it empty.
          await writeAtomic(file, bytes ?? new Uint8Array());
          stats.miss++;
          return bytes ?? new Uint8Array();
        })().finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  };
}

/**
 * Starts the server on a free port. Returns { url, close, stats }.
 * @param {{ sourceDir: string, port?: number }} opts
 */
export async function startServer({ sourceDir, port = 0 }) {
  const stats = { hit: 0, miss: 0, errors: 0 };
  const store = frozenStore(sourceDir, stats);
  const pinnedFile = join(sourceDir, 'pinned.json');
  let template = null;

  function pinnedTemplate() {
    template ??= (async () => {
      try {
        return JSON.parse(await readFile(pinnedFile, 'utf8')).template;
      } catch {
        const res = await fetchRetry(OFM_TILEJSON);
        if (!res.ok) throw new Error(`OpenFreeMap TileJSON: HTTP ${res.status}`);
        const t = (await res.json()).tiles[0];
        await writeAtomic(pinnedFile, JSON.stringify({ template: t, pinnedAt: new Date().toISOString() }, null, 2));
        return t;
      }
    })();
    template.catch(() => {
      template = null;
    });
    return template;
  }

  async function currentTemplate() {
    const res = await fetchRetry(OFM_TILEJSON);
    return (await res.json()).tiles[0];
  }

  async function ofmTile(z, x, y) {
    const sub = (t) => t.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    return store(`ofm/${z}/${x}/${y}.pbf`, async () => {
      let res = await fetchRetry(sub(await pinnedTemplate()));
      // OpenFreeMap removes old builds. A tile never fetched before then comes from the current
      // build; once stored it is frozen like every other.
      if (res.status === 404) res = await fetchRetry(sub(await currentTemplate()));
      if (res.status === 404) return null;
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  async function demTile(path) {
    return store(`dem/${path}`, async () => {
      const res = await fetchRetry(DEM + path);
      if (res.status === 404) return null;
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (path === '/ofm/planet') {
        // The painter reads tiles[0] and fills in z/x/y; it always asks for z14.
        const origin = `http://${req.headers.host}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tiles: [`${origin}/ofm/frozen/{z}/{x}/{y}.pbf`] }));
        return;
      }
      let m = path.match(/^\/ofm\/frozen\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
      if (m) {
        const bytes = await ofmTile(m[1], m[2], m[3]);
        if (!bytes.length) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': TYPES['.pbf'] }).end(bytes);
        return;
      }
      m = path.match(/^\/dem\/(\d+\/\d+\/\d+\.png)$/);
      if (m) {
        const bytes = await demTile(m[1]);
        if (!bytes.length) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': TYPES['.png'] }).end(bytes);
        return;
      }
      if (path === '/') {
        res.writeHead(302, { location: '/page/render.html' }).end();
        return;
      }
      for (const [prefix, dir] of Object.entries(STATIC)) {
        if (!path.startsWith(prefix)) continue;
        const rel = normalize(path.slice(prefix.length));
        if (rel.startsWith('..')) break;
        const bytes = await readFile(join(ROOT, dir, rel));
        res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' }).end(bytes);
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      stats.errors++;
      console.error('server', path, e?.message ?? e);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, stats, ofmTile, demTile, close: () => new Promise((r) => server.close(r)) };
}
