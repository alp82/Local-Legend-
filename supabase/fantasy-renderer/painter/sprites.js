// PROTOTYPE, throwaway. Every icon and texture is painted on a canvas at load time and handed
// to MapLibre with map.addImage(). Nothing here is final art: it only has to read as
// "painted fantasy map" so the three directions can be judged.
//
// Palette is lifted from UI Assets/ (Castle 2, Fantasy Tavern 1, Sawmill 1): warm stone,
// dark timber, slate-blue roofs, saturated grass.

export const PR = 2; // pixel ratio of every image

export const C = {
  ink: '#3d2b1f',
  inkSoft: 'rgba(61,43,31,0.55)',
  parchment: '#eadcb4',
  grass: '#86b04c',
  grassDark: '#6a9638',
  grassLight: '#a3c766',
  meadow: '#9cc25e',
  forest: '#4f7d32',
  forestDark: '#355a22',
  forestLight: '#6f9b43',
  water: '#6aa3c4',
  waterDark: '#3f7aa0',
  waterLight: '#9cc8de',
  stone: '#d9cbab',
  stoneDark: '#a8987a',
  stoneShade: '#bcae8e',
  timber: '#7a4e27',
  timberDark: '#5a3819',
  roof: '#3f5fa6',
  roofDark: '#2c467f',
  roofLight: '#5d7fc4',
  thatch: '#c9a35a',
  thatchDark: '#9c7a3a',
  redRoof: '#a5553a',
  redRoofDark: '#7d3d28',
  dirt: '#c59f66',
  dirtDark: '#8d6a3c',
  cobble: '#bdb29b',
  wheat: '#d8bb63',
  plough: '#9c7b4f',
};

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * PR);
  c.height = Math.round(h * PR);
  const ctx = c.getContext('2d');
  ctx.scale(PR, PR);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  return { c, ctx, w, h };
}

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function poly(ctx, pts, fill, stroke = C.ink, lw = 0.8) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

// Isometric projection around an origin.
export function iso(ox, oy, k = 1) {
  const cx = Math.cos(Math.PI / 6) * k, sy = Math.sin(Math.PI / 6) * k;
  return (u, v, z = 0) => [ox + (u - v) * cx, oy + (u + v) * sy - z * k];
}

export function shadow(ctx, x, y, rx, ry, a = 0.28) {
  ctx.save();
  ctx.fillStyle = `rgba(40,30,15,${a})`;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * One isometric gabled house. (x, y) is the ground point of the front corner.
 * w along the ridge, d across, h wall height, r roof height.
 */
export function house(ctx, x, y, { w = 8, d = 6, h = 5, r = 4, wall = C.stone, wallShade = C.stoneShade, roof = C.roof, roofDark = C.roofDark, timber = true, chimney = false, k = 1 } = {}) {
  const P = iso(x - (w - d) * 0.0, y - (w + d) * 0.5 * k * 0.5, k);
  shadow(ctx, x, y + 0.5, (w + d) * 0.55 * k, (w + d) * 0.22 * k);
  // back roof slope (peeks above)
  poly(ctx, [P(0, 0, h), P(0, d / 2, h + r), P(w, d / 2, h + r), P(w, 0, h)], roofDark);
  // right face (u = w) with gable
  poly(ctx, [P(w, 0, 0), P(w, d, 0), P(w, d, h), P(w, d / 2, h + r), P(w, 0, h)], wallShade);
  // front face (v = d)
  poly(ctx, [P(0, d, 0), P(w, d, 0), P(w, d, h), P(0, d, h)], wall);
  if (timber) {
    ctx.strokeStyle = C.timberDark; ctx.lineWidth = 0.6;
    ctx.beginPath();
    const a = P(0, d, h * 0.55), b = P(w, d, h * 0.55);
    ctx.moveTo(...a); ctx.lineTo(...b);
    for (const t of [0.33, 0.66]) { const p = P(w * t, d, 0), q = P(w * t, d, h); ctx.moveTo(...p); ctx.lineTo(...q); }
    ctx.stroke();
  }
  // door + window glow
  poly(ctx, [P(w * 0.42, d, 0), P(w * 0.58, d, 0), P(w * 0.58, d, h * 0.5), P(w * 0.42, d, h * 0.5)], C.timberDark, null);
  poly(ctx, [P(w * 0.15, d, h * 0.62), P(w * 0.27, d, h * 0.62), P(w * 0.27, d, h * 0.85), P(w * 0.15, d, h * 0.85)], '#f2c25a', null);
  poly(ctx, [P(w, d * 0.35, h * 0.45), P(w, d * 0.6, h * 0.45), P(w, d * 0.6, h * 0.75), P(w, d * 0.35, h * 0.75)], '#f2c25a', null);
  // front roof slope
  poly(ctx, [P(0, d, h), P(w, d, h), P(w, d / 2, h + r), P(0, d / 2, h + r)], roof);
  // roof texture strokes
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (const t of [0.25, 0.5, 0.75]) { const p = P(w * t, d, h), q = P(w * t, d / 2, h + r); ctx.moveTo(...p); ctx.lineTo(...q); }
  ctx.stroke();
  if (chimney) {
    poly(ctx, [P(w * 0.75, d * 0.5, h + r * 0.4), P(w * 0.85, d * 0.5, h + r * 0.4), P(w * 0.85, d * 0.5, h + r * 1.25), P(w * 0.75, d * 0.5, h + r * 1.25)], C.stoneDark);
  }
}

/** A square tower with a pointed blue cap (church spire / keep). */
export function tower(ctx, x, y, { s = 5, h = 14, cap = 8, wall = C.stone, wallShade = C.stoneShade, roof = C.roof, roofDark = C.roofDark, k = 1, flag = false } = {}) {
  const P = iso(x, y - s * 0.5 * k, k);
  shadow(ctx, x, y + 0.5, s * 1.1 * k, s * 0.45 * k);
  poly(ctx, [P(s, 0, 0), P(s, s, 0), P(s, s, h), P(s, 0, h)], wallShade);
  poly(ctx, [P(0, s, 0), P(s, s, 0), P(s, s, h), P(0, s, h)], wall);
  poly(ctx, [P(s * 0.35, s, h * 0.6), P(s * 0.65, s, h * 0.6), P(s * 0.65, s, h * 0.8), P(s * 0.35, s, h * 0.8)], '#f2c25a', null);
  const apex = P(s / 2, s / 2, h + cap);
  poly(ctx, [P(s, 0, h), P(s, s, h), apex], roofDark);
  poly(ctx, [P(0, s, h), P(s, s, h), apex], roof);
  if (flag) {
    ctx.strokeStyle = C.ink; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(apex[0], apex[1]); ctx.lineTo(apex[0], apex[1] - 5 * k); ctx.stroke();
    poly(ctx, [[apex[0], apex[1] - 5 * k], [apex[0] + 4 * k, apex[1] - 4 * k], [apex[0], apex[1] - 3 * k]], '#e0b13a', C.ink, 0.4);
  }
}

export function treeCrown(ctx, x, y, r, col = C.forest, dark = C.forestDark, light = C.forestLight) {
  shadow(ctx, x + r * 0.35, y + r * 0.55, r * 0.95, r * 0.45, 0.25);
  ctx.fillStyle = C.timberDark;
  ctx.fillRect(x - r * 0.12, y, r * 0.24, r * 0.6);
  ctx.beginPath(); ctx.arc(x, y - r * 0.2, r, 0, Math.PI * 2);
  ctx.fillStyle = dark; ctx.fill();
  ctx.beginPath(); ctx.arc(x - r * 0.12, y - r * 0.32, r * 0.8, 0, Math.PI * 2);
  ctx.fillStyle = col; ctx.fill();
  ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.55, r * 0.38, 0, Math.PI * 2);
  ctx.fillStyle = light; ctx.fill();
}

export function conifer(ctx, x, y, r) {
  shadow(ctx, x + r * 0.3, y + r * 0.2, r * 0.8, r * 0.35, 0.25);
  poly(ctx, [[x, y - r * 2.2], [x + r * 0.9, y], [x - r * 0.9, y]], C.forestDark, 'rgba(30,45,20,0.8)', 0.5);
  poly(ctx, [[x, y - r * 2.2], [x, y], [x - r * 0.9, y]], C.forest, null);
}

// ---------------------------------------------------------------- icons

function hutIcon(kind) {
  const { c, ctx } = canvas(26, 24);
  const presets = [
    { roof: C.thatch, roofDark: C.thatchDark, wall: C.stone, timber: true, w: 9, d: 7, h: 5, r: 5 },
    { roof: C.roof, roofDark: C.roofDark, wall: C.stone, timber: true, chimney: true, w: 10, d: 7, h: 6, r: 4.5 },
    { roof: C.redRoof, roofDark: C.redRoofDark, wall: '#c9a97c', wallShade: '#a98c62', timber: false, w: 12, d: 7, h: 5, r: 4 },
    { roof: C.thatch, roofDark: C.thatchDark, wall: '#b48a5a', wallShade: '#8f6b43', timber: true, w: 7, d: 6, h: 4, r: 4.5 },
  ];
  house(ctx, 13, 20, presets[kind]);
  return c;
}

function manorIcon() {
  const { c, ctx } = canvas(34, 34);
  house(ctx, 15, 30, { w: 13, d: 8, h: 7, r: 5, chimney: true });
  tower(ctx, 24, 28, { s: 5, h: 15, cap: 7, flag: true });
  return c;
}

export function settlementIcon(tier) {
  // tier: 0 lone hut, 1 hamlet, 2 village, 3 walled town, 4 castle city
  if (tier === 0) {
    const { c, ctx } = canvas(28, 26);
    treeCrown(ctx, 20, 17, 4);
    house(ctx, 12, 22, { roof: C.thatch, roofDark: C.thatchDark, w: 9, d: 7, h: 5, r: 5 });
    return c;
  }
  if (tier === 1) {
    const { c, ctx } = canvas(40, 32);
    treeCrown(ctx, 31, 15, 4.5);
    house(ctx, 12, 20, { roof: C.thatch, roofDark: C.thatchDark, w: 8, d: 6, h: 5, r: 4 });
    house(ctx, 26, 23, { w: 9, d: 6, h: 5, r: 4, chimney: true });
    house(ctx, 15, 29, { roof: C.redRoof, roofDark: C.redRoofDark, w: 8, d: 6, h: 4, r: 4 });
    return c;
  }
  if (tier === 2) {
    const { c, ctx } = canvas(54, 44);
    // village green
    ctx.fillStyle = 'rgba(200,170,110,0.55)';
    ctx.beginPath(); ctx.ellipse(27, 32, 24, 10, 0, 0, Math.PI * 2); ctx.fill();
    treeCrown(ctx, 8, 30, 4.5);
    house(ctx, 16, 25, { roof: C.thatch, roofDark: C.thatchDark, w: 8, d: 6, h: 5, r: 4 });
    tower(ctx, 30, 25, { s: 5, h: 13, cap: 9 });
    house(ctx, 40, 30, { w: 9, d: 6, h: 5, r: 4, chimney: true });
    house(ctx, 22, 38, { roof: C.redRoof, roofDark: C.redRoofDark, w: 9, d: 6, h: 5, r: 4 });
    house(ctx, 36, 41, { w: 8, d: 6, h: 4, r: 4 });
    treeCrown(ctx, 47, 39, 4);
    return c;
  }
  if (tier === 3) {
    const { c, ctx } = canvas(70, 58);
    const cx = 35, cy = 38, rx = 29, ry = 15;
    ctx.fillStyle = '#b9a785';
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    // back wall
    ctx.strokeStyle = C.ink; ctx.lineWidth = 3.6;
    ctx.beginPath(); ctx.ellipse(cx, cy - 4, rx, ry, 0, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.strokeStyle = C.stone; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.ellipse(cx, cy - 4, rx, ry, 0, Math.PI, 2 * Math.PI); ctx.stroke();
    house(ctx, 22, 33, { w: 8, d: 6, h: 5, r: 4 });
    house(ctx, 46, 34, { roof: C.redRoof, roofDark: C.redRoofDark, w: 8, d: 6, h: 5, r: 4 });
    tower(ctx, 34, 32, { s: 6, h: 16, cap: 9, flag: true });
    house(ctx, 28, 44, { w: 9, d: 6, h: 5, r: 4, chimney: true });
    house(ctx, 42, 46, { roof: C.thatch, roofDark: C.thatchDark, w: 8, d: 6, h: 4, r: 4 });
    // front wall
    const front = () => { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI); };
    ctx.lineWidth = 6; ctx.strokeStyle = C.ink; front(); ctx.stroke();
    ctx.lineWidth = 4.6; ctx.strokeStyle = C.stone; front(); ctx.stroke();
    ctx.setLineDash([1.6, 1.6]); ctx.lineWidth = 1.2; ctx.strokeStyle = C.stoneDark;
    ctx.beginPath(); ctx.ellipse(cx, cy - 2, rx, ry, 0, 0, Math.PI); ctx.stroke(); ctx.setLineDash([]);
    for (const a of [0.15, 0.5, 0.85]) {
      const x = cx + Math.cos(Math.PI * a) * rx, y = cy + Math.sin(Math.PI * a) * ry;
      tower(ctx, x - 2.5, y + 2, { s: 5, h: 8, cap: 5 });
    }
    // gate
    poly(ctx, [[cx - 3, cy + ry + 2], [cx + 3, cy + ry + 2], [cx + 3, cy + ry - 3], [cx - 3, cy + ry - 3]], C.timberDark, C.ink, 0.6);
    return c;
  }
  // tier 4: castle city
  const { c, ctx } = canvas(84, 72);
  const cx = 42, cy = 48, rx = 36, ry = 18;
  ctx.fillStyle = '#b9a785';
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = C.ink; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.ellipse(cx, cy - 5, rx, ry, 0, Math.PI, 2 * Math.PI); ctx.stroke();
  ctx.strokeStyle = C.stone; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(cx, cy - 5, rx, ry, 0, Math.PI, 2 * Math.PI); ctx.stroke();
  house(ctx, 20, 42, { w: 8, d: 6, h: 5, r: 4 });
  house(ctx, 62, 44, { roof: C.redRoof, roofDark: C.redRoofDark, w: 8, d: 6, h: 5, r: 4 });
  house(ctx, 30, 55, { w: 9, d: 6, h: 5, r: 4, chimney: true });
  house(ctx, 54, 57, { roof: C.thatch, roofDark: C.thatchDark, w: 8, d: 6, h: 4, r: 4 });
  // keep
  house(ctx, 34, 44, { w: 14, d: 9, h: 11, r: 6, timber: false });
  tower(ctx, 44, 42, { s: 7, h: 24, cap: 11, flag: true });
  tower(ctx, 28, 40, { s: 5, h: 16, cap: 7 });
  const front = () => { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI); };
  ctx.lineWidth = 7; ctx.strokeStyle = C.ink; front(); ctx.stroke();
  ctx.lineWidth = 5.4; ctx.strokeStyle = C.stone; front(); ctx.stroke();
  for (const a of [0.08, 0.35, 0.65, 0.92]) {
    const x = cx + Math.cos(Math.PI * a) * rx, y = cy + Math.sin(Math.PI * a) * ry;
    tower(ctx, x - 3, y + 2, { s: 6, h: 10, cap: 6 });
  }
  poly(ctx, [[cx - 4, cy + ry + 3], [cx + 4, cy + ry + 3], [cx + 4, cy + ry - 3], [cx - 4, cy + ry - 3]], C.timberDark, C.ink, 0.6);
  return c;
}

function peakIcon(big) {
  const s = big ? 1.4 : 1;
  const { c, ctx } = canvas(40 * s, 30 * s);
  ctx.scale(s, s);
  // secondary peak
  poly(ctx, [[4, 28], [14, 12], [24, 28]], '#8f8470', C.ink, 0.8);
  poly(ctx, [[14, 12], [24, 28], [17, 28]], '#6d6455', null);
  // main
  poly(ctx, [[10, 28], [22, 4], [36, 28]], '#a39880', C.ink, 0.9);
  poly(ctx, [[22, 4], [36, 28], [25, 28], [24, 18]], '#7a705e', null);
  poly(ctx, [[22, 4], [26.5, 12], [24, 11], [22, 13.5], [19.5, 10.5], [17.5, 13]], '#f6f3ea', C.ink, 0.6);
  ctx.strokeStyle = 'rgba(61,43,31,0.6)'; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(22, 4); ctx.lineTo(24, 18); ctx.lineTo(25, 28); ctx.stroke();
  return c;
}

export function smallIcon(kind) {
  const { c, ctx } = canvas(26, 22);
  if (kind === 'barrow') {
    ctx.fillStyle = '#7da348';
    ctx.beginPath(); ctx.ellipse(13, 15, 10, 5, 0, Math.PI, 0); ctx.fill(); ctx.strokeStyle = C.ink; ctx.lineWidth = 0.8; ctx.stroke();
    poly(ctx, [[11, 15], [11, 9], [15, 9], [15, 15]], C.stoneDark, C.ink, 0.6);
  } else if (kind === 'anvil') {
    poly(ctx, [[6, 12], [20, 12], [17, 15], [9, 15]], '#5d5d66', C.ink, 0.7);
    poly(ctx, [[10, 15], [16, 15], [17, 19], [9, 19]], '#4a4a52', C.ink, 0.7);
    ctx.fillStyle = '#f29a3a'; ctx.beginPath(); ctx.arc(20, 8, 2, 0, 7); ctx.fill();
  } else if (kind === 'chapel') {
    house(ctx, 10, 20, { w: 9, d: 6, h: 6, r: 4 });
    tower(ctx, 17, 19, { s: 4, h: 12, cap: 6 });
  } else if (kind === 'tree') {
    treeCrown(ctx, 13, 15, 6);
  } else if (kind === 'tent') {
    poly(ctx, [[5, 18], [13, 6], [21, 18]], '#e9dcc0', C.ink, 0.7);
    poly(ctx, [[13, 6], [21, 18], [15, 18]], '#d9a548', null);
  }
  return c;
}

// ---------------------------------------------------------------- patterns (seamless)

export function wrapEach(size, x, y, r, fn) {
  for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
    const X = x + dx, Y = y + dy;
    if (X + r < 0 || Y + r < 0 || X - r > size || Y - r > size) continue;
    fn(X, Y);
  }
}

export function brushNoise(ctx, size, n, colors, seed, len = 3, lw = 1) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * size, y = r() * size, a = -0.5 + r() * 0.4;
    ctx.strokeStyle = colors[Math.floor(r() * colors.length)];
    ctx.lineWidth = lw;
    wrapEach(size, x, y, len, (X, Y) => {
      ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X + Math.cos(a) * len, Y + Math.sin(a) * len); ctx.stroke();
    });
  }
}

export function blotches(ctx, size, n, colors, seed, rmin, rmax) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * size, y = r() * size, rad = rmin + r() * (rmax - rmin);
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    wrapEach(size, x, y, rad, (X, Y) => { ctx.beginPath(); ctx.arc(X, Y, rad, 0, Math.PI * 2); ctx.fill(); });
  }
}

function patGrass(base = C.grass, seed = 1) {
  const S = 96;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  blotches(ctx, S, 26, ['rgba(255,240,180,0.07)', 'rgba(40,70,20,0.07)', 'rgba(120,150,60,0.10)'], seed, 6, 16);
  brushNoise(ctx, S, 140, ['rgba(60,95,30,0.35)', 'rgba(170,205,110,0.4)', 'rgba(90,130,45,0.35)'], seed + 7, 2.5, 0.7);
  return c;
}

function patParchment() {
  const S = 128;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = C.parchment; ctx.fillRect(0, 0, S, S);
  blotches(ctx, S, 40, ['rgba(160,120,60,0.05)', 'rgba(255,250,230,0.10)'], 3, 8, 22);
  brushNoise(ctx, S, 90, ['rgba(120,90,50,0.12)'], 5, 5, 0.4);
  return c;
}

function patMeadow() {
  const S = 96;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = C.meadow; ctx.fillRect(0, 0, S, S);
  brushNoise(ctx, S, 160, ['rgba(70,110,35,0.35)', 'rgba(190,220,130,0.45)'], 11, 2.5, 0.7);
  blotches(ctx, S, 18, ['#f4e6a1', '#f0f0e6', '#e8a0b4', '#c9b3f0'], 12, 0.7, 1.1);
  return c;
}

function patForest(dense = true, seed = 21) {
  const S = 64;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = dense ? '#5d8a3a' : C.meadow; ctx.fillRect(0, 0, S, S);
  brushNoise(ctx, S, 60, ['rgba(40,70,25,0.4)'], seed, 2, 0.7);
  const r = rng(seed);
  const pts = [];
  const step = dense ? 12 : 21;
  for (let y = 0; y < S; y += step * 0.8) for (let x = 0; x < S; x += step) {
    const off = (Math.round(y / (step * 0.8)) % 2) * step * 0.5;
    pts.push([x + off + (r() - 0.5) * 4, y + (r() - 0.5) * 4, (dense ? 5 : 4.5) + r() * 1.6, r()]);
  }
  pts.sort((a, b) => a[1] - b[1]);
  for (const [x, y, rad, t] of pts) {
    wrapEach(S, x, y, rad * 2.2, (X, Y) => (t < 0.25 && dense ? conifer(ctx, X, Y + rad * 0.6, rad * 0.75) : treeCrown(ctx, X, Y, rad)));
  }
  return c;
}

function patOrchard() {
  const S = 48;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = '#a4c463'; ctx.fillRect(0, 0, S, S);
  brushNoise(ctx, S, 50, ['rgba(70,110,35,0.3)'], 31, 2, 0.6);
  for (let y = 6; y < S; y += 12) for (let x = 6; x < S; x += 12) {
    treeCrown(ctx, x, y, 3.2, '#5e9a3a', '#3f6e26', '#8cc25a');
    ctx.fillStyle = '#d4483a'; ctx.beginPath(); ctx.arc(x + 1, y - 1, 0.6, 0, 7); ctx.fill();
  }
  return c;
}

/** Ploughed / crop stripes. dir: 0 horizontal, 1 vertical, 2 diagonal. */
function patField(base, stripe, dir, seed) {
  const S = 32;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = stripe; ctx.lineWidth = 1.6;
  ctx.beginPath();
  if (dir === 0) for (let y = 2; y < S; y += 4) { ctx.moveTo(0, y); ctx.lineTo(S, y); }
  else if (dir === 1) for (let x = 2; x < S; x += 4) { ctx.moveTo(x, 0); ctx.lineTo(x, S); }
  else for (let k = -S; k < S * 2; k += 4) { ctx.moveTo(k, 0); ctx.lineTo(k + S, S); }
  ctx.stroke();
  brushNoise(ctx, S, 30, ['rgba(255,255,220,0.18)', 'rgba(60,40,20,0.12)'], seed, 1.5, 0.5);
  return c;
}

function patWater() {
  const S = 96;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = C.water; ctx.fillRect(0, 0, S, S);
  blotches(ctx, S, 20, ['rgba(255,255,255,0.05)', 'rgba(30,70,110,0.06)'], 41, 8, 20);
  const r = rng(42);
  ctx.strokeStyle = 'rgba(235,248,255,0.55)'; ctx.lineWidth = 0.8;
  for (let i = 0; i < 16; i++) {
    const x = r() * S, y = r() * S;
    wrapEach(S, x, y, 6, (X, Y) => {
      ctx.beginPath(); ctx.moveTo(X - 4, Y); ctx.quadraticCurveTo(X - 2, Y - 1.6, X, Y); ctx.quadraticCurveTo(X + 2, Y - 1.6, X + 4, Y); ctx.stroke();
    });
  }
  return c;
}

function patSimple(base, dots, seed, n = 60, rmin = 0.6, rmax = 1.6) {
  const S = 64;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  blotches(ctx, S, n, dots, seed, rmin, rmax);
  return c;
}

function patMarsh() {
  const S = 48;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = '#8fb170'; ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(80,140,170,0.7)'; ctx.lineWidth = 0.8;
  for (let y = 6; y < S; y += 12) for (let x = 4; x < S; x += 16) {
    const ox = (y / 12) % 2 ? 8 : 0;
    ctx.beginPath(); ctx.moveTo(x + ox, y); ctx.lineTo(x + ox + 7, y); ctx.stroke();
    ctx.strokeStyle = 'rgba(50,80,30,0.8)';
    ctx.beginPath(); ctx.moveTo(x + ox + 3, y); ctx.lineTo(x + ox + 2, y - 4); ctx.moveTo(x + ox + 4, y); ctx.lineTo(x + ox + 5, y - 4); ctx.stroke();
    ctx.strokeStyle = 'rgba(80,140,170,0.7)';
  }
  return c;
}

function patBarrows() {
  const S = 48;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = '#93b35c'; ctx.fillRect(0, 0, S, S);
  for (const [x, y] of [[10, 12], [34, 20], [18, 38], [42, 42]]) {
    ctx.fillStyle = '#769a45'; ctx.beginPath(); ctx.ellipse(x, y, 7, 3.5, 0, Math.PI, 0); ctx.fill();
    ctx.strokeStyle = C.inkSoft; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.fillStyle = C.stoneDark; ctx.fillRect(x - 0.8, y - 7, 1.6, 4);
  }
  return c;
}

function patQuarry() {
  const S = 64;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = '#b9ad98'; ctx.fillRect(0, 0, S, S);
  const r = rng(71);
  for (let i = 0; i < 26; i++) {
    const x = r() * S, y = r() * S, s = 2 + r() * 3;
    wrapEach(S, x, y, s * 2, (X, Y) => poly(ctx, [[X, Y], [X + s, Y - s * 0.4], [X + s * 1.6, Y + s * 0.4], [X + s * 0.6, Y + s]], ['#9a8f7e', '#cfc5b2', '#8a8070'][i % 3], 'rgba(61,43,31,0.5)', 0.4));
  }
  return c;
}

function patMarket() {
  const S = 64;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = '#d8c39a'; ctx.fillRect(0, 0, S, S);
  brushNoise(ctx, S, 60, ['rgba(120,90,50,0.25)'], 81, 2, 0.6);
  for (const [x, y, col] of [[14, 18, '#d9a548'], [44, 30, '#b44a3a'], [24, 50, '#3f5fa6']]) {
    poly(ctx, [[x - 6, y + 4], [x, y - 4], [x + 6, y + 4]], '#efe4cc', C.ink, 0.6);
    poly(ctx, [[x, y - 4], [x + 6, y + 4], [x + 2, y + 4]], col, null);
  }
  return c;
}

function patSnow() { return patSimple('#eef1f2', ['rgba(150,170,190,0.25)', 'rgba(255,255,255,0.8)'], 91, 40, 1, 4); }
function patSand() { return patSimple('#e6d3a0', ['rgba(170,140,80,0.35)', 'rgba(255,250,220,0.6)'], 92, 80, 0.4, 0.9); }
function patRock() { return patQuarry(); }

function patFlagstone() {
  const S = 32;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = '#cdbf9f'; ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(90,70,45,0.45)'; ctx.lineWidth = 0.6;
  for (let y = 0; y < S; y += 8) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke();
    const o = (y / 8) % 2 ? 5 : 0;
    for (let x = o; x < S; x += 10) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 8); ctx.stroke(); }
  }
  return c;
}

function patTourney() {
  const S = 32;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = '#c9b27c'; ctx.fillRect(0, 0, S, S);
  brushNoise(ctx, S, 40, ['rgba(110,80,40,0.3)'], 95, 2, 0.6);
  return c;
}

// Line patterns: MapLibre scales the image height to the line width, so these are drawn at a
// fixed height and only the proportions matter. Width must be a power of two.
function linePat(kind) {
  const W = 32, H = 16;
  const { c, ctx } = canvas(W, H);
  if (kind === 'cobble') {
    ctx.fillStyle = '#8c7f68'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C.cobble; ctx.fillRect(0, 2, W, H - 4);
    const r = rng(5);
    for (let row = 0; row < 3; row++) for (let x = -2 + row * 2; x < W; x += 5) {
      ctx.fillStyle = ['#cfc5ae', '#b1a68e', '#c3b89f'][Math.floor(r() * 3)];
      ctx.beginPath(); ctx.ellipse(x + 2.2, 4.5 + row * 3.6, 2.1, 1.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(70,55,35,0.45)'; ctx.lineWidth = 0.4; ctx.stroke();
    }
    ctx.fillStyle = 'rgba(61,43,31,0.85)'; ctx.fillRect(0, 0, W, 1.2); ctx.fillRect(0, H - 1.2, W, 1.2);
  } else if (kind === 'cart') {
    // dirt road with two wheel ruts and a grass crown
    ctx.fillStyle = C.dirt; ctx.fillRect(0, 1, W, H - 2);
    ctx.fillStyle = 'rgba(141,106,60,0.75)'; ctx.fillRect(0, 4, W, 1.4); ctx.fillRect(0, H - 5.4, W, 1.4);
    ctx.fillStyle = 'rgba(120,160,70,0.55)'; ctx.fillRect(0, 7.3, W, 1.4);
    brushNoise(ctx, W, 14, ['rgba(90,60,30,0.35)'], 6, 1.5, 0.5);
    ctx.fillStyle = 'rgba(110,80,40,0.7)'; ctx.fillRect(0, 0, W, 1); ctx.fillRect(0, H - 1, W, 1);
  } else if (kind === 'planks') {
    ctx.fillStyle = '#9a6b3a'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = C.timberDark; ctx.lineWidth = 0.8;
    for (let x = 0; x < W; x += 4) { ctx.beginPath(); ctx.moveTo(x, 1.5); ctx.lineTo(x, H - 1.5); ctx.stroke(); }
    ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, 1.8); ctx.fillRect(0, H - 1.8, W, 1.8);
  }
  return c;
}

export function buildImages() {
  const images = {};
  for (let i = 0; i < 4; i++) images[`hut_${i}`] = hutIcon(i);
  images.manor = manorIcon();
  for (let t = 0; t <= 4; t++) images[`settle_${t}`] = settlementIcon(t);
  images.peak = peakIcon(false);
  images.peak_big = peakIcon(true);
  for (const k of ['barrow', 'anvil', 'chapel', 'tree', 'tent']) images[`i_${k}`] = smallIcon(k);

  images.p_grass = patGrass();
  images.p_parchment = patParchment();
  images.p_meadow = patMeadow();
  images.p_forest = patForest(true);
  images.p_grove = patForest(false, 23);
  images.p_orchard = patOrchard();
  images.p_field_0 = patField('#d3b765', 'rgba(150,115,45,0.45)', 0, 51);
  images.p_field_1 = patField('#9fbf55', 'rgba(70,110,35,0.45)', 1, 52);
  images.p_field_2 = patField('#a88456', 'rgba(110,75,40,0.5)', 2, 53);
  images.p_field_3 = patField('#c4c06a', 'rgba(120,120,40,0.4)', 1, 54);
  images.p_field_4 = patField('#b5cc73', 'rgba(90,130,50,0.4)', 0, 55);
  images.p_water = patWater();
  images.p_marsh = patMarsh();
  images.p_barrows = patBarrows();
  images.p_quarry = patQuarry();
  images.p_market = patMarket();
  images.p_snow = patSnow();
  images.p_sand = patSand();
  images.p_rock = patRock();
  images.p_flagstone = patFlagstone();
  images.p_tourney = patTourney();
  images.l_cobble = linePat('cobble');
  images.l_cart = linePat('cart');
  images.l_planks = linePat('planks');
  return images;
}

export function addImages(map, images) {
  for (const [name, c] of Object.entries(images)) {
    if (map.hasImage(name)) continue;
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    map.addImage(name, data, { pixelRatio: PR });
  }
}
