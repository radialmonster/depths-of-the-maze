// Procedural canvas textures for the renderer (no image files). Generated once, cached.
// Colour maps are light/neutral so per-instance theme colours still tint them.
import * as THREE from 'three';
import { mulberry32 } from './core.js';

// ------------------------------------------------------------------ noise helpers
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smoothstep(a, b, x) { return smooth(clamp01((x - a) / (b - a))); }

// Periodic value-noise fBm sampler over u,v in [0,1): fx/fy = base lattice cells across the
// texture, so results tile seamlessly. Lattices are precomputed once per sampler (fast inner loop).
function sampler(fx, fy, oct, seed) {
  const layers = [];
  let amp = 0.5, norm = 0;
  for (let o = 0; o < oct; o++) {
    const px = fx << o, py = fy << o;
    const arr = new Float32Array(px * py);
    for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) arr[j * px + i] = hash2(i, j, seed + o * 101);
    layers.push({ px, py, arr, amp });
    norm += amp; amp *= 0.5;
  }
  const inv = 1 / norm;
  return (u, v) => {
    let sum = 0;
    for (let k = 0; k < layers.length; k++) {
      const L = layers[k], px = L.px, arr = L.arr;
      const x = u * px, y = v * L.py;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const tx = smooth(x - x0), ty = smooth(y - y0);
      const ix0 = ((x0 % px) + px) % px, iy0 = ((y0 % L.py) + L.py) % L.py;
      const ix1 = ix0 + 1 === px ? 0 : ix0 + 1, iy1 = iy0 + 1 === L.py ? 0 : iy0 + 1;
      const r0 = iy0 * px, r1 = iy1 * px;
      const a = arr[r0 + ix0], b = arr[r0 + ix1], c = arr[r1 + ix0], d = arr[r1 + ix1];
      const top = a + (b - a) * tx;
      sum += L.amp * (top + (c + (d - c) * tx - top) * ty);
    }
    return sum * inv;
  };
}

// Inside distance (px) of point to a rounded rect (positive inside).
function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
  const hx = (x1 - x0) * 0.5 - r, hy = (y1 - y0) * 0.5 - r;
  const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return -(Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r);
}

// ------------------------------------------------------------------ canvas output
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Build colour / normal / roughness canvases from float fields (H height 0..1, RGB colour 0..1, R rough 0..1).
function finishSurface(w, h, H, CR, CG, CB, R, normalStrength) {
  const colorC = makeCanvas(w, h), normalC = makeCanvas(w, h), roughC = makeCanvas(w, h);
  const cctx = colorC.getContext('2d'), nctx = normalC.getContext('2d'), rctx = roughC.getContext('2d');
  const cimg = cctx.createImageData(w, h), nimg = nctx.createImageData(w, h), rimg = rctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w, yp = ((y + 1) % h) * w, yr = y * w;
    for (let x = 0; x < w; x++) {
      const i = yr + x, o = i * 4;
      const xm = (x - 1 + w) % w, xp = (x + 1) % w;
      // Canvas y points down; with flipY the texture's +v points up, so +ny = H(y+1) - H(y-1).
      let nx = (H[yr + xm] - H[yr + xp]) * normalStrength;
      let ny = (H[yp + x] - H[ym + x]) * normalStrength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nimg.data[o] = (nx * inv * 0.5 + 0.5) * 255;
      nimg.data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      nimg.data[o + 2] = (inv * 0.5 + 0.5) * 255;
      nimg.data[o + 3] = 255;
      cimg.data[o] = clamp01(CR[i]) * 255;
      cimg.data[o + 1] = clamp01(CG[i]) * 255;
      cimg.data[o + 2] = clamp01(CB[i]) * 255;
      cimg.data[o + 3] = 255;
      const rv = clamp01(R[i]) * 255;
      rimg.data[o] = rv; rimg.data[o + 1] = rv; rimg.data[o + 2] = rv; rimg.data[o + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0); nctx.putImageData(nimg, 0, 0); rctx.putImageData(rimg, 0, 0);
  return { colorC, normalC, roughC };
}

function fields(w, h) {
  const n = w * h;
  return { H: new Float32Array(n), CR: new Float32Array(n), CG: new Float32Array(n), CB: new Float32Array(n), R: new Float32Array(n) };
}

// Random-walk cracks, written into a mask (only where `allow(x, y)` is true).
function drawCracks(mask, w, h, count, rng, x0, y0, cw, ch, allow) {
  for (let c = 0; c < count; c++) {
    let x = x0 + cw * (0.15 + rng() * 0.7), y = y0 + ch * (0.15 + rng() * 0.7);
    let ang = rng() * Math.PI * 2;
    const steps = 14 + Math.floor(rng() * 30);
    for (let s = 0; s < steps; s++) {
      ang += (rng() - 0.5) * 0.9;
      x += Math.cos(ang) * 1.6; y += Math.sin(ang) * 1.6;
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < x0 + 1 || iy < y0 + 1 || ix >= x0 + cw - 1 || iy >= y0 + ch - 1) break;
      if (!allow(ix, iy)) break;
      const i = iy * w + ix;
      mask[i] = 1;
      if (s % 3 === 0 && rng() < 0.5) { mask[i + 1] = Math.max(mask[i + 1], 0.5); mask[i + w] = Math.max(mask[i + w], 0.5); }
      if (rng() < 0.04) ang += (rng() < 0.5 ? -1 : 1) * 1.2; // occasional kink
    }
  }
}

// ------------------------------------------------------------------ flagstone cells (floor + wall tops)
function jitterLayout(layout, rng, amt) {
  // Move interior split lines a little so no two cells read identical.
  const splitsX = new Map(), splitsY = new Map();
  const j = (m, v) => {
    if (v <= 0 || v >= 1) return v;
    if (!m.has(v)) m.set(v, v + (rng() - 0.5) * amt);
    return m.get(v);
  };
  return layout.map(([a, b, c, d]) => [j(splitsX, a), j(splitsY, b), j(splitsX, c), j(splitsY, d)]);
}

// Renders one square cell of stones into the fields at (ox, oy) with size S.
function stoneCell(F, W, ox, oy, S, layout, rng, seed, p) {
  const rects = layout.map(([a, b, c, d]) => ({
    x0: a * S, y0: b * S, x1: c * S, y1: d * S,
    val: p.baseVal + rng() * p.valVar,
    hue: (rng() - 0.5) * p.hueVar,
    tx: (rng() - 0.5) * 0.12, ty: (rng() - 0.5) * 0.12,
  }));
  const s1 = sampler(4, 4, 4, seed + 11), sJ = sampler(12, 12, 1, seed + 7);
  const s2 = sampler(32, 32, 2, seed + 23), s3 = sampler(20, 20, 1, seed + 37);
  const owner = new Int16Array(S * S);
  const dist = new Float32Array(S * S);
  const N1 = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S, v = (y + 0.5) / S;
      const n1 = N1[y * S + x] = s1(u, v);
      let best = -1e9, bi = 0;
      for (let r = 0; r < rects.length; r++) {
        const R = rects[r];
        const d = insideRoundRect(x + 0.5, y + 0.5, R.x0, R.y0, R.x1, R.y1, p.radius);
        if (d > best) { best = d; bi = r; }
      }
      best += (sJ(u, v) - 0.5) * 0.5 * p.edgeJitter + (n1 - 0.5) * p.edgeJitter;
      owner[y * S + x] = bi;
      dist[y * S + x] = best;
    }
  }
  const crack = new Float32Array(W * (oy + S + 2));
  const crackCount = Math.floor(rng() * (p.cracks + 1));
  drawCracks(crack, W, 0, crackCount, rng, ox, oy, S, S, (ix, iy) => dist[(iy - oy) * S + (ix - ox)] > p.grout + 3);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S, v = (y + 0.5) / S;
      const li = y * S + x, gi = (oy + y) * W + (ox + x);
      const R = rects[owner[li]];
      const d = dist[li];
      const n1 = N1[li];
      const n2 = s2(u, v);
      const n3 = s3(u, v);
      const bevel = smoothstep(p.grout, p.grout + p.bevel, d);
      const stoneMix = smoothstep(p.grout - 1.2, p.grout + 1.2, d);
      const c = crack[gi] || 0;
      const spk = hash2(ox + x, oy + y, seed + 3);

      let sv = R.val * (0.9 + 0.14 * n1) * (0.95 + 0.08 * n2);
      sv *= 0.8 + 0.2 * bevel;
      if (n3 > 0.78) sv *= 0.88;
      if (spk < 0.011) sv *= 0.82; else if (spk > 0.99) sv *= 1.07;
      sv *= 1 - 0.38 * c;
      const gv = p.groutVal * (0.92 + 0.14 * n2);
      const val = gv + (sv - gv) * stoneMix;
      const hue = R.hue * stoneMix;

      const tilt = (u - 0.5) * R.tx + (v - 0.5) * R.ty;
      const sh = 0.35 + 0.5 * bevel + 0.12 * n1 + 0.05 * n2 + tilt - (n3 > 0.78 ? 0.06 : 0) - 0.3 * c;
      const gh = 0.08 + 0.05 * n2;
      F.H[gi] = gh + (sh - gh) * stoneMix;
      F.CR[gi] = val * (1 + hue);
      F.CG[gi] = val;
      F.CB[gi] = val * (1 - hue);
      F.R[gi] = 0.95 + (0.7 + 0.14 * n1 + 0.1 * c - 0.95) * stoneMix;
    }
  }
}

const FLOOR_LAYOUTS = [
  [[0, 0, 1, 1]],
  [[0, 0, 1, 0.55], [0, 0.55, 1, 1]],
  [[0, 0, 0.6, 1], [0.6, 0, 1, 0.5], [0.6, 0.5, 1, 1]],
  [[0, 0, 0.5, 1], [0.5, 0, 1, 1]],
];
const TOP_LAYOUTS = [
  [[0, 0, 1, 1]],
  [[0, 0, 1, 0.5], [0, 0.5, 1, 1]],
  [[0, 0, 0.6, 1], [0.6, 0, 1, 0.5], [0.6, 0.5, 1, 1]],
  [[0, 0, 1, 1]],
];

function stoneAtlas(size, layouts, seed, params) {
  const S = size / 2;
  const F = fields(size, size);
  const rng = mulberry32(seed);
  for (let c = 0; c < 4; c++) {
    const ox = (c % 2) * S, oy = Math.floor(c / 2) * S;
    const layout = jitterLayout(layouts[c], rng, 0.14);
    stoneCell(F, size, ox, oy, S, layout, rng, seed + c * 1000, params);
  }
  return finishSurface(size, size, F.H, F.CR, F.CG, F.CB, F.R, params.normalStrength);
}

// ------------------------------------------------------------------ wall sides (brick courses)
// 512 x 320 px covers 2 world units wide x 1.2 tall (the full wall height), tiling horizontally.
function wallSide(seed) {
  const W = 512, Hh = 320;
  const F = fields(W, Hh);
  const rng = mulberry32(seed);
  const coping = 38;
  const rowCount = 4;
  const rowH = (Hh - coping) / rowCount;
  const rows = [];
  rows.push({ y0: 0, y1: coping, breaks: makeBreaks(W, 190, 300, rng) });
  for (let r = 0; r < rowCount; r++) rows.push({ y0: coping + r * rowH, y1: coping + (r + 1) * rowH, breaks: makeBreaks(W, 130, 210, rng) });
  for (const row of rows) row.vals = row.breaks.map(() => ({ val: 0.9 + rng() * 0.1, hue: (rng() - 0.5) * 0.05 }));

  const grout = 3.2, bevel = 7, radius = 5;
  const sJ = sampler(12, 8, 3, seed + 5), s1 = sampler(8, 5, 4, seed + 11), s2 = sampler(48, 30, 2, seed + 23);
  const dist = new Float32Array(W * Hh);
  const owner = new Int32Array(W * Hh);
  for (let y = 0; y < Hh; y++) {
    const ri = rows.findIndex((r) => y < r.y1);
    const row = rows[ri < 0 ? rows.length - 1 : ri];
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = (y + 0.5) / Hh;
      // Find the segment containing x (breaks are sorted; last wraps around to the first).
      const b = row.breaks;
      let si = b.length - 1;
      for (let k = 0; k < b.length; k++) if (x >= b[k]) si = k;
      const start = b[si];
      const end = si + 1 < b.length ? b[si + 1] : b[0] + W;
      let lx = x + 0.5;
      if (lx < start) lx += W;
      const d = insideRoundRect(lx, y + 0.5, start, row.y0, end, row.y1, radius) + (sJ(u, v) - 0.5) * 4;
      dist[y * W + x] = d;
      owner[y * W + x] = (rows.indexOf(row) << 8) | si;
    }
  }
  const crack = new Float32Array(W * Hh);
  drawCracks(crack, W, Hh, 7, rng, 0, 0, W, Hh, (ix, iy) => dist[iy * W + ix] > grout + 2);

  for (let y = 0; y < Hh; y++) {
    const fy = y / Hh;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = (x + 0.5) / W, v = (y + 0.5) / Hh;
      const own = owner[i];
      const row = rows[own >> 8];
      const bv = row.vals[own & 255];
      const d = dist[i];
      const n1 = s1(u, v);
      const n2 = s2(u, v);
      const bev = smoothstep(grout, grout + bevel, d);
      const mix = smoothstep(grout - 1, grout + 1, d);
      const c = crack[i];
      const spk = hash2(x, y, seed + 9);
      let sv = bv.val * (0.9 + 0.14 * n1) * (0.95 + 0.08 * n2) * (0.8 + 0.2 * bev);
      if (spk < 0.015) sv *= 0.82;
      if (row.y0 === 0) sv *= 1.05; // coping course a touch lighter
      sv *= 1 - 0.35 * c;
      const gv = 0.6 * (0.92 + 0.14 * n2);
      let val = gv + (sv - gv) * mix;
      // Ambient-occlusion band and grime at the base of the wall.
      const ao = smoothstep(0.6, 1.0, fy);
      val *= 1 - 0.42 * Math.pow(ao, 1.4) * (0.85 + 0.3 * n1);
      // Slight darkening just under the coping lip.
      if (y > coping && y < coping + 8) val *= 0.9 + 0.1 * ((y - coping) / 8);
      const hue = bv.hue * mix;
      F.CR[i] = val * (1 + hue); F.CG[i] = val; F.CB[i] = val * (1 - hue);
      const sh = 0.4 + 0.45 * bev + 0.12 * n1 + 0.05 * n2 - 0.3 * c;
      F.H[i] = 0.08 + (sh - 0.08) * mix;
      F.R[i] = 0.95 + (0.74 + 0.12 * n1 - 0.95) * mix;
    }
  }
  return finishSurface(W, Hh, F.H, F.CR, F.CG, F.CB, F.R, 3.2);
}

function makeBreaks(W, minLen, maxLen, rng) {
  const breaks = [];
  let x = rng() * maxLen;
  const first = x;
  while (x < first + W - minLen) {
    breaks.push(x % W);
    x += minLen + rng() * (maxLen - minLen);
  }
  return breaks.sort((a, b) => a - b);
}

// ------------------------------------------------------------------ wood planks (door frames)
function wood(seed) {
  const S = 256;
  const F = fields(S, S);
  const rng = mulberry32(seed);
  const planks = 3, pw = S / planks;
  const tones = Array.from({ length: planks }, () => 0.85 + rng() * 0.25);
  const warps = Array.from({ length: planks }, (_, p) => sampler(4, 2, 3, seed + p * 13));
  const sFine = sampler(64, 4, 2, seed + 50);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const u = (x + 0.5) / S, v = (y + 0.5) / S;
      const p = Math.min(planks - 1, Math.floor(x / pw));
      const lx = x - p * pw;
      const edge = Math.min(lx, pw - lx);
      const gap = smoothstep(1, 3.5, edge);
      const warp = warps[p](u, v);
      const grain = 0.5 + 0.5 * Math.sin((u * 60 + warp * 9 + p * 3) * 1.0);
      const fine = sFine(u, v);
      let t = tones[p] * (0.82 + 0.12 * grain + 0.1 * fine);
      // nails
      const nx = p * pw + pw / 2;
      for (const ny of [22, S - 22]) {
        const ddx = x + 0.5 - nx, ddy = y + 0.5 - ny, dd = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dd < 4.5) t *= 0.35 + 0.1 * (dd / 4.5);
      }
      t *= 0.35 + 0.65 * gap;
      F.CR[i] = 0.72 * t; F.CG[i] = 0.5 * t; F.CB[i] = 0.3 * t;
      F.H[i] = (0.3 + 0.5 * gap + 0.08 * grain) ;
      F.R[i] = 0.8 - 0.1 * grain;
    }
  }
  return finishSurface(S, S, F.H, F.CR, F.CG, F.CB, F.R, 2.5);
}

// ------------------------------------------------------------------ radial sprites
function radial(size, stops) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// ------------------------------------------------------------------ public
let cache = null;

function tex(canvas, srgb, aniso, repeat) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function surfaceTextures(s, aniso, repeat) {
  return { map: tex(s.colorC, true, aniso, repeat), normalMap: tex(s.normalC, false, aniso, repeat), roughnessMap: tex(s.roughC, false, aniso, repeat) };
}

/** Returns the shared texture set (generated on first call). */
export function getTextures(maxAnisotropy = 8) {
  if (cache) return cache;
  const aniso = Math.max(1, Math.min(8, maxAnisotropy));
  const floor = stoneAtlas(512, FLOOR_LAYOUTS, 1337, {
    grout: 3.2, bevel: 14, radius: 18, edgeJitter: 9, baseVal: 0.9, valVar: 0.09, hueVar: 0.06, groutVal: 0.76, cracks: 2, normalStrength: 3.4,
  });
  const top = stoneAtlas(512, TOP_LAYOUTS, 4242, {
    grout: 5, bevel: 18, radius: 16, edgeJitter: 4, baseVal: 0.94, valVar: 0.06, hueVar: 0.04, groutVal: 0.6, cracks: 1, normalStrength: 3.5,
  });
  cache = {
    floor: surfaceTextures(floor, aniso, true),
    wallTop: surfaceTextures(top, aniso, true),
    wallSide: surfaceTextures(wallSide(777), aniso, true),
    wood: surfaceTextures(wood(99), aniso, true),
    glow: tex(radial(64, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [0.6, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]), true, 1, false),
    shadow: tex(radial(64, [[0, 'rgba(0,0,0,0.55)'], [0.55, 'rgba(0,0,0,0.3)'], [1, 'rgba(0,0,0,0)']]), true, 1, false),
  };
  return cache;
}
