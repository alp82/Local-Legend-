// The painter's data: OpenMapTiles z14 vector tiles (OpenFreeMap), fetched once, decoded once and kept
// in memory. Nothing here depends on a map view.
//
// Purity rule: a query never answers from partial data. Asking for a tile that is not loaded throws
// NeedTiles (listing what is missing); withData() catches it, loads those tiles and runs the whole
// computation again. So every decision the painter makes sees all the data its fixed world window
// covers, whichever tile or chunk asked first, and the memoised world plan (fmworld.js) never caches
// a result computed from an incomplete window.
//
// Geometry is decoded straight from tile coordinates to web-mercator metres (a linear map).
import { VectorTile, PbfReader } from './vendor/vt.mjs';
import { toLL, NET, HALF, NeedDem, loadDem } from './fmcore.js';

export const Z14 = 14, TS14 = (2 * HALF) / 2 ** Z14; // the data tile and its size in mercator units
const LAYERS = ['landcover', 'park', 'landuse', 'water', 'waterway', 'building', 'poi', 'place', 'transportation', 'transportation_name', 'mountain_peak'];
let template = null;
const tiles = new Map(); // "x/y" → Promise
const done = new Map();  // "x/y" → { layer: feature[] } once loaded (an empty object for a tile with no data)
const fails = new Map();

export class NeedTiles extends Error {
  constructor(list) { super(`need ${list.length} data tiles`); this.tiles = list; }
}

async function tileUrl(x, y) {
  if (!template) template = (await (await fetch(NET.ofm + 'planet')).json()).tiles[0];
  return template.replace('{z}', Z14).replace('{x}', x).replace('{y}', y);
}
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a; };
/** One vector tile feature as a GeoJSON-like object whose geometry is already in mercator metres. */
function convert(vf, tx, ty) {
  const ext = vf.extent, x0 = tx * TS14 - HALF, y0 = HALF - ty * TS14, k = TS14 / ext;
  const rings = vf.loadGeometry().map((r) => r.map((p) => [x0 + p.x * k, y0 - p.y * k]));
  const f = {};
  if (vf.type === 1) f.geometry = { type: 'Point', coordinates: toLL(rings[0][0]) };
  else if (vf.type === 2) { f.geometry = { type: 'MultiLineString' }; f._lm = rings; }
  else {
    // classify rings into polygons: an outer ring, then the holes that follow it (MVT winding)
    const polys = []; let cur = null, outerSign = 0;
    for (const r of rings) { const s = Math.sign(ringArea(r)); if (!s) continue; if (!outerSign) outerSign = s; if (s === outerSign) { cur = [r]; polys.push(cur); } else if (cur) cur.push(r); }
    f.geometry = { type: 'MultiPolygon' }; f._pm = polys;
  }
  return f;
}
function loadTile(x, y) {
  const key = x + '/' + y;
  if (done.has(key)) return Promise.resolve(done.get(key));
  if (!tiles.has(key)) tiles.set(key, (async () => {
    const out = {};
    try {
      const res = await fetch(await tileUrl(x, y));
      if (res.status === 404 || res.status === 204) { done.set(key, out); return out; } // no data there: an empty tile
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const vt = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
      for (const name of LAYERS) {
        const L = vt.layers[name]; const arr = out[name] = [];
        if (!L) continue;
        // only the bounding box now; the geometry is converted the first time a query touches it
        const x0 = x * TS14 - HALF, y0 = HALF - y * TS14;
        for (let i = 0; i < L.length; i++) { const vf = L.feature(i), k = TS14 / vf.extent, [a, b, c, d] = vf.bbox(); arr.push({ id: vf.id, properties: vf.properties, mbb: [x0 + a * k, y0 - d * k, x0 + c * k, y0 - b * k], _vf: vf, _tx: x, _ty: y }); }
      }
    } catch (e) {
      // a failed fetch is not data: forget it so the next request tries again (after three failures the
      // tile counts as empty, so a dead tile cannot hang the painter; this is logged as a data failure)
      tiles.delete(key); const n = (fails.get(key) || 0) + 1; fails.set(key, n);
      console.warn('data tile', key, String(e), n >= 3 ? '(given up: treated as empty)' : '');
      if (n >= 3) { done.set(key, {}); return {}; }
      throw e;
    }
    done.set(key, out);
    return out;
  })());
  return tiles.get(key);
}
const tileRange = (bb) => [Math.floor((bb[0] + HALF) / TS14), Math.floor((HALF - bb[3]) / TS14), Math.floor((bb[2] + HALF) / TS14), Math.floor((HALF - bb[1]) / TS14)];
/** Load the tiles under a mercator bbox (a prefetch; queries still throw for anything else they need). */
export async function ensure(bb) {
  const [x0, y0, x1, y1] = tileRange(bb), list = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push([x, y]);
  await ensureTiles(list);
}
export async function ensureTiles(list) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await Promise.allSettled(list.map(([x, y]) => loadTile(x, y)));
    if (r.every((v) => v.status === 'fulfilled')) return;
  }
}
/** Run fn (sync or async) until it no longer needs data tiles that are not loaded yet. */
export async function withData(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i > 2000 || !(e instanceof NeedTiles || e instanceof NeedDem)) throw e;
      if (typeof self !== 'undefined' && self.__dataLog) self.__dataLog.push( // (the check tools' load log)
        (e instanceof NeedDem ? 'dem ' : 'tile ') + e.tiles.map((t) => t.join('/')).join(' '));
      if (e instanceof NeedDem) await loadDem(e.tiles); else await ensureTiles(e.tiles);
    }
  }
}
function realise(f) { if (f._vf) { const g = convert(f._vf, f._tx, f._ty); f.geometry = g.geometry; if (g._pm) f._pm = g._pm; if (g._lm) f._lm = g._lm; f._vf = null; } return f; }
/** The features of one layer in one data tile (throws NeedTiles when that tile is not loaded). */
export function tileFeatures(layer, x, y, raw = false) {
  const t = done.get(x + '/' + y); if (!t) throw new NeedTiles([[x, y]]);
  const L = t[layer] || [];
  if (!raw) for (const f of L) realise(f);
  return L;
}
/** Features of one layer whose bbox meets a mercator bbox (throws NeedTiles when a tile under it is not loaded). */
export function features(layer, bb, raw = false) {
  const [x0, y0, x1, y1] = tileRange(bb), out = [], miss = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (!done.has(x + '/' + y)) miss.push([x, y]);
  if (miss.length) throw new NeedTiles(miss);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    for (const f of done.get(x + '/' + y)[layer] || []) { const m = f.mbb; if (m[2] >= bb[0] && m[0] <= bb[2] && m[3] >= bb[1] && m[1] <= bb[3]) out.push(raw ? f : realise(f)); }
  }
  return out;
}
