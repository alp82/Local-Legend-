// PROTOTYPE, throwaway. The painter's own data path: OpenMapTiles z14 vector tiles fetched through
// serve.py's pass-through, decoded once, kept in memory. Unlike map.querySourceFeatures this does
// not depend on what the map happens to show, so a place always gets the same data and paints
// the same picture.
//
// Geometry is decoded straight from tile coordinates to web-mercator metres (a linear map), with
// no detour through longitude/latitude: that is most of the decoding cost saved.
import { VectorTile, PbfReader } from './vendor/vt.mjs';
import { toLL } from './density.js';

const Z = 14, HALF = 20037508.342789244, TS = (2 * HALF) / 2 ** Z;
const LAYERS = ['landcover', 'park', 'landuse', 'water', 'waterway', 'building', 'poi', 'place', 'transportation', 'transportation_name', 'mountain_peak'];
let template = null;
const tiles = new Map(); // "x/y" → Promise<{ layer: feature[] }>
const done = new Map();  // "x/y" → { layer: feature[] } once loaded

async function tileUrl(x, y) {
  if (!template) template = (await (await fetch('/ofm/planet')).json()).tiles[0];
  return template.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
}
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a; };
/** One vector tile feature as a GeoJSON-like object whose geometry is already in mercator metres. */
function convert(vf, tx, ty) {
  const ext = vf.extent, x0 = tx * TS - HALF, y0 = HALF - ty * TS, k = TS / ext;
  const rings = vf.loadGeometry().map((r) => r.map((p) => [x0 + p.x * k, y0 - p.y * k]));
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const [x, y] of r) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  const f = { id: vf.id, properties: vf.properties, mbb: [a, b, c, d] };
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
  if (!tiles.has(key)) tiles.set(key, (async () => {
    const out = {};
    try {
      const res = await fetch(await tileUrl(x, y)); if (!res.ok) throw new Error('HTTP ' + res.status);
      const vt = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
      for (const name of LAYERS) {
        const L = vt.layers[name]; const arr = out[name] = [];
        if (!L) continue;
        // only the bounding box now; the geometry is converted the first time a query touches it
        const x0 = x * TS - HALF, y0 = HALF - y * TS;
        for (let i = 0; i < L.length; i++) { const vf = L.feature(i), k = TS / vf.extent, [a, b, c, d] = vf.bbox(); arr.push({ id: vf.id, properties: vf.properties, mbb: [x0 + a * k, y0 - d * k, x0 + c * k, y0 - b * k], _vf: vf, _tx: x, _ty: y }); }
      }
    } catch (e) {
      // a failed fetch is not data: forget it so the next request tries again
      console.warn('tile', key, e); tiles.delete(key); return out;
    }
    done.set(key, out);
    return out;
  })());
  return tiles.get(key);
}
const tileRange = (bb) => [Math.floor((bb[0] + HALF) / TS), Math.floor((HALF - bb[3]) / TS), Math.floor((bb[2] + HALF) / TS), Math.floor((HALF - bb[1]) / TS)];
/** Make sure the tiles under a mercator bbox are loaded. */
export async function ensure(bb) {
  const [x0, y0, x1, y1] = tileRange(bb), jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(loadTile(x, y));
  await Promise.all(jobs);
}
/** Features of one layer whose bbox meets a mercator bbox (tiles must be loaded with ensure). */
export function features(layer, bb, raw = false) {
  const [x0, y0, x1, y1] = tileRange(bb), out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const t = done.get(x + '/' + y); if (!t) continue;
    for (const f of t[layer] || []) { const m = f.mbb; if (m[2] >= bb[0] && m[0] <= bb[2] && m[3] >= bb[1] && m[1] <= bb[3]) { if (f._vf && !raw) { const g = convert(f._vf, f._tx, f._ty); f.geometry = g.geometry; if (g._pm) f._pm = g._pm; if (g._lm) f._lm = g._lm; f._vf = null; } out.push(f); } }
  }
  return out;
}
