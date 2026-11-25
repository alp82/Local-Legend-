// PROTOTYPE, throwaway. Client-side "world generation" from the vector tiles already loaded
// for the current view:
//
//   settlements  building footprint coverage per grid cell → smoothed → density peaks are
//                thinned by tier spacing (walled town / village / hamlet / lone hut), then
//                named after the nearest real place label.
//   fields       every built-up cell becomes a jittered field / orchard / meadow plot (B).
//   links        a few real streets survive as paths: the shortest street route between each
//                settlement and its two nearest neighbours.
//
// Everything is in Web Mercator metres. Grid cells are anchored to the global origin so a cell
// is the same cell from frame to frame; the set of loaded tiles still changes with the view,
// which is the main reason a real build would do this server-side per tile.

const R = 6378137;
const toM = ([lng, lat]) => [R * lng * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
const toLL = ([x, y]) => [x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];

const TIER_SPACING = [170, 340, 700, 1400]; // ground metres at walking zoom
const TIER_MIN_PX = [40, 60, 92, 120];        // keep icons from piling up at far zoom
const TIER_MIN_ZOOM = [14.5, 13.8, 0, 0];
const THRESH = [0.02, 0.07, 0.16, 0.28];     // smoothed building coverage (peak pick)
const WTHRESH = [0, 0.035, 0.10, 0.20];      // mean coverage over ~800 m (tier)

const PLACE_RANK = { city: 6, town: 5, suburb: 4, village: 4, quarter: 3, neighbourhood: 2, hamlet: 2, isolated_dwelling: 1 };
const PLACE_TIER = { city: 4, town: 3, suburb: 2, village: 2, quarter: 2, neighbourhood: 1, hamlet: 1, isolated_dwelling: 0 };

function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

function polygonsOf(f) {
  const g = f.geometry;
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function cellSizeFor(zoom) {
  if (zoom >= 14) return 110;
  if (zoom >= 13) return 170;
  if (zoom >= 12) return 320;
  if (zoom >= 10) return 700;
  return 1500;
}

/** Dominant street bearing (mod 90°) of the loaded streets, so fields line up with blocks. */
function streetBearing(map) {
  const bins = new Float64Array(90);
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'transportation' })) {
    if (!['minor', 'tertiary', 'secondary', 'primary', 'service'].includes(f.properties.class)) continue;
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) for (let i = 1; i < line.length; i++) {
      const [ax, ay] = toM(line[i - 1]), [bx, by] = toM(line[i]);
      const len = Math.hypot(bx - ax, by - ay);
      let a = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
      a = ((a % 90) + 90) % 90;
      bins[Math.floor(a) % 90] += len;
    }
  }
  let best = 0, bv = -1;
  for (let i = 0; i < 90; i++) {
    let v = 0;
    for (let d = -2; d <= 2; d++) v += bins[(i + d + 90) % 90];
    if (v > bv) { bv = v; best = i; }
  }
  return (best + 0.5) * Math.PI / 180;
}

/** Builds the density grid from buildings (z ≥ 13) or from settled landuse (far zoom). */
function densityGrid(map, cellGround, k) {
  const S = cellGround * k; // cell size in mercator metres
  const theta = map.getZoom() >= 13 ? streetBearing(map) : 0;
  const cs = Math.cos(theta), sn = Math.sin(theta);
  const rot = (x, y) => [x * cs + y * sn, -x * sn + y * cs];
  const unrot = (u, v) => [u * cs - v * sn, u * sn + v * cs];
  const cellAt = (x, y) => { const [u, v] = rot(x, y); return cell(Math.floor(u / S), Math.floor(v / S)); };
  const cells = new Map();
  const cell = (i, j) => {
    const key = i + ',' + j;
    let c = cells.get(key);
    if (!c) { c = { i, j, area: 0, sx: 0, sy: 0 }; cells.set(key, c); }
    return c;
  };
  const zoom = map.getZoom();
  let source = 'buildings', n = 0;
  if (zoom >= 13) {
    const seen = new Set();
    for (const f of map.querySourceFeatures('omt', { sourceLayer: 'building' })) {
      for (const poly of polygonsOf(f)) {
        const ring = poly[0].map(toM);
        let cx = 0, cy = 0;
        for (const [x, y] of ring) { cx += x; cy += y; }
        cx /= ring.length; cy /= ring.length;
        const key = (f.id ?? '') + ':' + Math.round(cx) + ':' + Math.round(cy);
        if (seen.has(key)) continue;
        seen.add(key);
        const a = ringArea(ring);
        const c = cellAt(cx, cy);
        c.area += a; c.sx += cx * a; c.sy += cy * a;
        n++;
      }
    }
  } else {
    source = 'landuse';
    const settled = new Set(['residential', 'commercial', 'retail', 'industrial', 'suburb', 'quarter', 'neighbourhood']);
    const sub = 3; // sub-samples per cell axis
    const seen = new Set();
    for (const f of map.querySourceFeatures('omt', { sourceLayer: 'landuse' })) {
      if (!settled.has(f.properties.class)) continue;
      for (const poly of polygonsOf(f)) {
        const ring = poly[0].map(toM);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        const step = S / sub;
        for (let y = Math.floor(y0 / step) * step + step / 2; y < y1; y += step) {
          for (let x = Math.floor(x0 / step) * step + step / 2; x < x1; x += step) {
            const sk = Math.round(x / step) + ',' + Math.round(y / step);
            if (seen.has(sk) || !pointInRing(x, y, ring)) continue;
            seen.add(sk);
            // A settled sample stands for ~30% building coverage.
            const a = step * step * 0.3;
            const c = cellAt(x, y);
            c.area += a; c.sx += x * a; c.sy += y * a;
          }
        }
        n++;
      }
    }
  }
  const cellArea = S * S;
  for (const c of cells.values()) c.d = c.area / cellArea;
  // 3×3 smoothing: settlements follow districts, not single blocks.
  for (const c of cells.values()) {
    let s = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const o = cells.get((c.i + di) + ',' + (c.j + dj));
      if (o) s += o.d * (di || dj ? 1 : 2);
    }
    c.s = s / 10;
  }
  // Mean coverage over a ~800 m window decides how big a settlement a peak can carry.
  const r = Math.max(1, Math.round(400 / cellGround));
  for (const c of cells.values()) {
    let sum = 0;
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) sum += cells.get((c.i + di) + ',' + (c.j + dj))?.d || 0;
    c.w = sum / ((2 * r + 1) ** 2);
  }
  return { cells, S, source, n, unrot, theta };
}

function placesInView(map) {
  const out = new Map();
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'place' })) {
    const cls = f.properties.class;
    if (!(cls in PLACE_RANK) || f.geometry.type !== 'Point') continue;
    const name = f.properties['name:latin'] || f.properties.name;
    if (!name || out.has(name)) continue;
    out.set(name, { name, cls, rank: PLACE_RANK[cls], m: toM(f.geometry.coordinates), ll: f.geometry.coordinates });
  }
  return [...out.values()].sort((a, b) => b.rank - a.rank);
}

export function computeSettlements(map) {
  const zoom = map.getZoom();
  const lat = map.getCenter().lat;
  const k = 1 / Math.cos(lat * Math.PI / 180); // ground → mercator scale
  const mpp = 78271.517 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom); // ground metres per css px
  const grid = densityGrid(map, cellSizeFor(zoom), k);
  const spacing = TIER_SPACING.map((s, t) => Math.max(s, TIER_MIN_PX[t] * mpp) * k);

  const cand = [...grid.cells.values()].filter((c) => c.s >= THRESH[0]).sort((a, b) => b.s - a.s);
  const accepted = [];
  const bucket = new Map();
  const B = spacing[3];
  const near = (x, y, fn) => {
    const bi = Math.floor(x / B), bj = Math.floor(y / B);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const a of bucket.get((bi + di) + ',' + (bj + dj)) || []) if (fn(a) === false) return false;
    return true;
  };
  for (const c of cand) {
    const [x, y] = c.area ? [c.sx / c.area, c.sy / c.area] : grid.unrot((c.i + 0.5) * grid.S, (c.j + 0.5) * grid.S);
    let t = 3;
    while (t > 0 && (c.s < THRESH[t] || c.w < WTHRESH[t])) t--;
    // A dense district may shrink to a smaller settlement, but never to a lone hut.
    const tMin = Math.max(0, t - 2);
    // Dense districts pack settlements closer: the busiest part of the realm.
    const f = Math.min(1.25, Math.max(0.68, 1.25 - 1.8 * (c.w || 0)));
    for (; t >= tMin; t--) {
      if (zoom < TIER_MIN_ZOOM[t]) { t = -1; break; }
      const ok = near(x, y, (a) => Math.hypot(a.x - x, a.y - y) >= (spacing[t] + spacing[a.t]) / 2 * f);
      if (ok) break;
    }
    if (t < tMin) continue;
    const s = { x, y, t, name: null, s: c.s };
    accepted.push(s);
    const bk = Math.floor(x / B) + ',' + Math.floor(y / B);
    if (!bucket.has(bk)) bucket.set(bk, []);
    bucket.get(bk).push(s);
  }

  // Name settlements after real places; rural places with no density get their own hamlet.
  const places = placesInView(map);
  for (const p of places) {
    let best = null, bd = Infinity;
    for (const s of accepted) {
      if (s.name) continue;
      const d = Math.hypot(s.x - p.m[0], s.y - p.m[1]);
      if (d < Math.max(spacing[s.t] * 0.75, 300 * k) && d < bd) { best = s; bd = d; }
    }
    if (best) {
      best.name = p.name;
      // A real village is at least a village, a real town at least a town.
      if (['village', 'town', 'city'].includes(p.cls)) best.t = Math.max(best.t, Math.min(PLACE_TIER[p.cls], 3));
      if (p.cls === 'city' && zoom < 13) best.t = 4;
      continue;
    }
    const t = Math.min(PLACE_TIER[p.cls], 3);
    if (zoom < TIER_MIN_ZOOM[t]) continue;
    const free = accepted.every((a) => Math.hypot(a.x - p.m[0], a.y - p.m[1]) >= (spacing[t] + spacing[a.t]) / 3);
    if (free && (p.rank >= 4 || zoom >= 13)) accepted.push({ x: p.m[0], y: p.m[1], t: p.cls === 'city' && zoom < 13 ? 4 : t, name: p.name, s: 0 });
  }

  const settlements = {
    type: 'FeatureCollection',
    features: accepted.map((s) => ({ type: 'Feature', properties: { tier: s.t, name: s.name, v: Math.floor(hash2(Math.round(s.x), Math.round(s.y)) * 3) }, geometry: { type: 'Point', coordinates: toLL([s.x, s.y]) } })),
  };
  return { settlements, grid, accepted, spacing, places, k };
}

const FIELD_PATS = ['p_field_0', 'p_field_1', 'p_field_2', 'p_field_3', 'p_field_4', 'p_orchard', 'p_meadow', 'p_field_1', 'p_field_0', 'p_orchard'];

export function computeFields(grid, accepted, spacing) {
  const { cells, S, unrot } = grid;
  const J = 0.28 * S;
  const vtx = (i, j) => unrot(i * S + (hash2(i, j) - 0.5) * J, j * S + (hash2(j * 7 + 3, i * 13 + 1) - 0.5) * J);
  const features = [];
  for (const c of cells.values()) {
    if (c.d < 0.02 && c.s < 0.03) continue;
    const [cx, cy] = unrot((c.i + 0.5) * S, (c.j + 0.5) * S);
    let pat = FIELD_PATS[Math.floor(hash2(c.i * 31 + 7, c.j * 17 + 5) * FIELD_PATS.length)];
    for (const s of accepted) {
      if (Math.hypot(s.x - cx, s.y - cy) < spacing[Math.min(s.t, 3)] * 0.22) { pat = 'p_meadow'; break; }
    }
    const ring = [vtx(c.i, c.j), vtx(c.i + 1, c.j), vtx(c.i + 1, c.j + 1), vtx(c.i, c.j + 1)];
    ring.push(ring[0]);
    features.push({ type: 'Feature', properties: { pat }, geometry: { type: 'Polygon', coordinates: [ring.map(toLL)] } });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------- links

const COST = { motorway: 1, trunk: 1, primary: 1, secondary: 1, tertiary: 0.95, minor: 1, service: 1.4, path: 1.15, track: 1.1 };

class Heap {
  constructor() { this.a = []; }
  push(n, p) {
    const a = this.a; a.push([p, n]);
    let i = a.length - 1;
    while (i > 0) { const q = (i - 1) >> 1; if (a[q][0] <= a[i][0]) break; [a[q], a[i]] = [a[i], a[q]]; i = q; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

export function computeLinks(map, endpoints, k, perEnd = 2) {
  const ids = new Map(), xy = [], adj = [];
  const node = (ll) => {
    const key = ll[0].toFixed(6) + ',' + ll[1].toFixed(6);
    let id = ids.get(key);
    if (id === undefined) { id = xy.length; ids.set(key, id); xy.push(toM(ll)); adj.push([]); }
    return id;
  };
  // Collect segments. Tile lines are simplified, so two crossing streets often share no
  // vertex: node them ourselves (segment intersections + T-junction snapping).
  const segs = [];
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'transportation' })) {
    const cost = COST[f.properties.class];
    if (!cost || f.properties.brunnel === 'tunnel') continue;
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      let prev = node(line[0]);
      for (let i = 1; i < line.length; i++) {
        const cur = node(line[i]);
        if (cur !== prev) segs.push({ a: prev, b: cur, cost, cuts: [] });
        prev = cur;
      }
    }
  }
  const GC = 40 * k, cellsMap = new Map();
  segs.forEach((s, si) => {
    const [ax, ay] = xy[s.a], [bx, by] = xy[s.b];
    for (let i = Math.floor(Math.min(ax, bx) / GC); i <= Math.floor(Math.max(ax, bx) / GC); i++)
      for (let j = Math.floor(Math.min(ay, by) / GC); j <= Math.floor(Math.max(ay, by) / GC); j++) {
        const kk = i + ',' + j;
        if (!cellsMap.has(kk)) cellsMap.set(kk, []);
        cellsMap.get(kk).push(si);
      }
  });
  const TOL = 4 * k;
  const snapTo = (s, p) => { // vertex p lies on segment s (not at its ends) → cut s there
    const [ax, ay] = xy[s.a], [bx, by] = xy[s.b], [px, py] = xy[p];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    if (!L2 || p === s.a || p === s.b) return;
    const t = ((px - ax) * dx + (py - ay) * dy) / L2;
    if (t <= 0.001 || t >= 0.999) return;
    if (Math.hypot(ax + t * dx - px, ay + t * dy - py) < TOL) s.cuts.push([t, p]);
  };
  for (const [kk, list] of cellsMap) {
    const [ci, cj] = kk.split(',').map(Number);
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const s = segs[list[x]], u = segs[list[y]];
      if (s.a === u.a || s.a === u.b || s.b === u.a || s.b === u.b) continue;
      const [ax, ay] = xy[s.a], [bx, by] = xy[s.b], [cx, cy] = xy[u.a], [dx, dy] = xy[u.b];
      const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (den) {
        const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
        const v = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
        if (t > 0.001 && t < 0.999 && v > 0.001 && v < 0.999) {
          const px = ax + t * (bx - ax), py = ay + t * (by - ay);
          if (Math.floor(px / GC) === ci && Math.floor(py / GC) === cj) {
            const n = node(toLL([px, py]));
            s.cuts.push([t, n]); u.cuts.push([v, n]);
            continue;
          }
        }
      }
      for (const p of [u.a, u.b]) snapTo(s, p);
      for (const p of [s.a, s.b]) snapTo(u, p);
    }
  }
  let edges = 0;
  const link = (p, q, cost) => {
    if (p === q) return;
    const w = Math.hypot(xy[q][0] - xy[p][0], xy[q][1] - xy[p][1]) * cost;
    adj[p].push(q, w); adj[q].push(p, w); edges++;
  };
  for (const s of segs) {
    s.cuts.sort((x, y) => x[0] - y[0]);
    let prev = s.a;
    for (const [, n] of s.cuts) { link(prev, n, s.cost); prev = n; }
    link(prev, s.b, s.cost);
  }
  if (!xy.length || endpoints.length < 2) return { fc: { type: 'FeatureCollection', features: [] }, nodes: xy.length, edges, routes: 0 };

  // snap endpoints to the nearest graph node (grid hash, 200 m cells)
  const G = 200 * k, hash = new Map();
  xy.forEach(([x, y], id) => { const kk = Math.floor(x / G) + ',' + Math.floor(y / G); if (!hash.has(kk)) hash.set(kk, []); hash.get(kk).push(id); });
  const snap = ([x, y]) => {
    let best = -1, bd = Infinity;
    const gi = Math.floor(x / G), gj = Math.floor(y / G);
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) for (const id of hash.get((gi + di) + ',' + (gj + dj)) || []) {
      const d = Math.hypot(xy[id][0] - x, xy[id][1] - y);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };
  const ends = endpoints.map((p) => ({ p, n: snap(p) })).filter((e) => e.n >= 0);
  const pairs = new Set();
  for (const a of ends) {
    const others = ends.filter((b) => b !== a).map((b) => ({ b, d: Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) })).filter((o) => o.d < 3500 * k).sort((x, y) => x.d - y.d).slice(0, perEnd);
    for (const { b } of others) pairs.add(a.n < b.n ? a.n + ':' + b.n : b.n + ':' + a.n);
  }

  const lines = [];
  const dist = new Float64Array(xy.length), prev = new Int32Array(xy.length);
  let routes = 0;
  for (const pr of pairs) {
    const [s, t] = pr.split(':').map(Number);
    if (s === t) continue;
    dist.fill(Infinity); prev.fill(-1);
    dist[s] = 0;
    const h = new Heap();
    const H = (n) => Math.hypot(xy[n][0] - xy[t][0], xy[n][1] - xy[t][1]) * 0.94;
    h.push(s, H(s));
    let found = false, pops = 0;
    while (h.size && pops++ < 200000) {
      const [, n] = h.pop();
      if (n === t) { found = true; break; }
      const a = adj[n];
      for (let i = 0; i < a.length; i += 2) {
        const m = a[i], nd = dist[n] + a[i + 1];
        if (nd < dist[m]) { dist[m] = nd; prev[m] = n; h.push(m, nd + H(m)); }
      }
    }
    if (!found) continue;
    const path = [];
    for (let n = t; n !== -1; n = prev[n]) path.push(toLL(xy[n]));
    lines.push(path);
    routes++;
  }
  return {
    fc: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }] },
    nodes: xy.length, edges, routes,
  };
}

export { toM, toLL };
