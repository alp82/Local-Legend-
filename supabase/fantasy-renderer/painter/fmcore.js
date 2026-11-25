// The fantasy map painter's core: projection, noise, elevation and the world constants. Everything the
// painter (painter5.js, tiledata.js, chunkworker.js, tilepainter.js) needs and nothing else; no DOM,
// no map view. Every function here is a pure function of world coordinates.

// ---------------------------------------------------------------- the world (web mercator)
export const R = 6378137;
export const WORLD = 2 * Math.PI * R, HALF = WORLD / 2;
export const toM = ([lng, lat]) => [R * lng * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
export const toLL = ([x, y]) => [x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];

/**
 * KF: mercator units per "map metre", one constant for the whole world. Every placement distance,
 * grid spacing and threshold in the painter is written in map metres and multiplied by KF, so the
 * same place gets the same layout whichever tile, chunk or view computes it. (A latitude-dependent
 * factor would make two neighbouring tiles at slightly different latitudes disagree.) 1.4 is the
 * true factor at about 44° N; nearer the equator the art reads a little larger, further north smaller.
 */
export const KF = 1.4;

// Where the data comes from. Override before painting (the prototype uses serve.py's same-origin proxy).
export const NET = {
  ofm: 'https://tiles.openfreemap.org/',
  dem: 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/',
};

// ---------------------------------------------------------------- noise & hashing
export function hash(i, j, s = 0) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(s, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = fade(x - i), fy = fade(y - j);
  const a = hash(i, j, s), b = hash(i + 1, j, s), c = hash(i, j + 1, s), d = hash(i + 1, j + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(x, y, s, oct = 3) {
  let v = 0, amp = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { v += vnoise(x * f, y * f, s + o * 17) * amp; n += amp; amp *= 0.5; f *= 2.03; }
  return v / n;
}

// ---------------------------------------------------------------- elevation (Terrarium PNG tiles)
const demCache = new Map();
async function demTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!demCache.has(key)) {
    demCache.set(key, (async () => {
      try {
        const res = await fetch(`${NET.dem}${key}.png`); if (!res.ok) throw new Error('HTTP ' + res.status);
        const bmp = await createImageBitmap(await res.blob());
        const cv = new OffscreenCanvas(256, 256), cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(bmp, 0, 0);
        const d = cx.getImageData(0, 0, 256, 256).data, e = new Float32Array(256 * 256);
        for (let i = 0; i < e.length; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        return e;
      } catch { demCache.delete(key); return null; } // a failed fetch is not data: try again next time
    })());
  }
  return demCache.get(key);
}
/** Elevation in metres at a mercator point, bilinear over Terrarium tiles at zoom z (pure: a missing tile reads 0). */
export async function demSampler(bb, z) {
  const ts = WORLD / 2 ** z;
  const tx0 = Math.floor((bb[0] + HALF) / ts), tx1 = Math.floor((bb[2] + HALF) / ts);
  const ty0 = Math.floor((HALF - bb[3]) / ts), ty1 = Math.floor((HALF - bb[1]) / ts);
  const tiles = new Map(), jobs = [];
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) jobs.push(demTile(z, x, y).then((e) => tiles.set(x + ',' + y, e)));
  await Promise.all(jobs);
  const pix = (gx, gy) => { const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256), e = tiles.get(tx + ',' + ty); return e ? e[(gy - ty * 256) * 256 + (gx - tx * 256)] : 0; };
  return (mx, my) => {
    const fx = (mx + HALF) / ts * 256 - 0.5, fy = (HALF - my) / ts * 256 - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const a = pix(x0, y0), b = pix(x0 + 1, y0), c = pix(x0, y0 + 1), d = pix(x0 + 1, y0 + 1);
    return a * (1 - ax) * (1 - ay) + b * ax * (1 - ay) + c * (1 - ax) * ay + d * ax * ay;
  };
}

// ---------------------------------------------------------------- geometry (mercator metres)
export function inRing(x, y, r) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
export const inPoly = (x, y, p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h));
export function bboxOf(rings) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const [x, y] of r) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}
export function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); }
export const polysOf = (f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
export const linesOf = (f) => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : []);
// geometry in mercator (tiledata.js decodes it so; GeoJSON from elsewhere is converted once)
export const polysM = (f) => f._pm || (f._pm = polysOf(f).map((p) => p.map((r) => r.map(toM))));
export const linesM = (f) => f._lm || (f._lm = linesOf(f).map((l) => l.map(toM)));
export const lineLen = (pts) => { let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return d / KF; };
/** Distance from a point to a polyline (mercator units). */
export function distToLine(x, y, pts) {
  let bd = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y); if (d < bd) bd = d;
  }
  return pts.length === 1 ? Math.hypot(pts[0][0] - x, pts[0][1] - y) : bd;
}
/** Minimum-area oriented rectangle of a ring. */
export function obb(pts) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const ux = dx / L, uy = dy / L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of pts) { const a = x * ux + y * uy, b = -x * uy + y * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, ux, uy, a0, a1, b0, b1 };
  }
  if (!best) return null;
  const { ux, uy, a0, a1, b0, b1 } = best;
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  let len = a1 - a0, wid = b1 - b0, ang = Math.atan2(uy, ux);
  if (wid > len) { [len, wid] = [wid, len]; ang += Math.PI / 2; }
  return { cx: ca * ux - cb * uy, cy: ca * uy + cb * ux, len, wid, ang };
}
/** Polygons in buckets on a fixed world grid: which polygon holds a point. */
export class Index {
  constructor(G) { this.G = G; this.items = []; this.b = new Map(); }
  add(rings, props) {
    const bb = bboxOf(rings), id = this.items.length;
    this.items.push({ rings, props, bb });
    for (let i = Math.floor(bb[0] / this.G); i <= Math.floor(bb[2] / this.G); i++)
      for (let j = Math.floor(bb[1] / this.G); j <= Math.floor(bb[3] / this.G); j++) {
        const k = i + ',' + j; if (!this.b.has(k)) this.b.set(k, []); this.b.get(k).push(id);
      }
  }
  at(x, y) {
    for (const id of this.b.get(Math.floor(x / this.G) + ',' + Math.floor(y / this.G)) || []) {
      const it = this.items[id];
      if (x < it.bb[0] || x > it.bb[2] || y < it.bb[1] || y > it.bb[3]) continue;
      if (inPoly(x, y, it.rings)) return it;
    }
    return null;
  }
}
/** A value hashed from a world point (rounded to the map metre) and a seed. */
export const H01 = (x, y, s) => hash(Math.round(x / KF), Math.round(y / KF), s);
