// Dungeon generation + FOV. Owned by the Map agent. Public API is fixed by DESIGN.md §7:
//   generateDungeon(depth, rng, opts?) -> map     opts.prevArchetype: the previous depth's map.archetype
//                                                  opts.merchant: reserve a spawn-free merchant room (merchant depth)
//   computeFOV(map, x, y, radius)
//
// Generation algorithm ("large rooms linked together", deterministic given rng):
//  0. Archetype (§17.13): each depth picks a profile (halls/catacombs/caverns/keep/wings, never the previous
//     depth's) that sets the size mix, shape weights, corridor gaps, loop fraction, cluster chance and
//     parent weighting below. The algorithm itself is the same for all of them.
//  1. Room shapes. Each room is a floor mask inside its bounding box: plain rectangles,
//     pillared halls (isolated single WALL tiles >= 2 tiles from the edge, never blocking),
//     L-shapes (rectangle minus a corner), two overlapping rectangles, rounded caves, cross/T,
//     octagons, long galleries, ring halls (walkway round a solid core), split halls (a divider
//     with 1-2 gaps) and cellular-automata caverns. Walls inside a room (core, divider, pillars,
//     rock islands) are 'core' tiles: never a doorway, corridor or stair cubby.
//     Sizes: small 5-7, medium 8-11 x 8-10, large 12-18 x 10-14 (galleries 3-5 x 14-22).
//  2. Growth placement = spanning tree. The first room goes near the map centre: on a boss depth it is the boss
//     arena (§17.15, BOSS_ARENAS: link cap 2, doorways only on its two short ends, one room grown off each), otherwise
//     it may be a 'grand' 20-26 x 14-20 landmark; each new room is attached to an existing room on one
//     side, either sharing a wall (gap 1 -> a single doorway in the common wall) or a few tiles away
//     (short straight corridor). A room is kept only if every floor tile has a full wall ring (no two
//     spaces ever merge) and the link to its parent can be carved. The attachment links
//     form the spanning tree, so every room is reachable by construction. Cluster mode (Catacombs)
//     chains a few more small rooms straight off a new small room through shared walls.
//  3. Corridors are validated before carving: straight or L-shaped, 1 wide (some straight
//     ones widen to 2 between 1-wide doorways), and they may touch nothing but the two
//     rooms they join (and never run parallel to another corridor one wall apart).
//     Both ends are TILE.DOOR tiles in the room walls.
//  4. Loops + exit counts: a few extra links between nearby rooms create loops, then rooms
//     are topped up toward 2-4 links (large/grand) / 1-3 links (medium) with nearby rooms
//     (caps: 4 large/grand / 3 medium / 2 small). No corridor ever dead-ends.
//  5. A BFS safety net force-carves a corridor to any stray component (a no-op in practice).
//  6. Start room (entrance; on a boss depth from the third of rooms farthest from the arena), 1-3 exit rooms from the
//     farthest third (never the arena), and (opts.merchant)
//     a spawn-free 'merchant' room — then a detour ranking of every room (how far off the entrance->exit route it
//     is), all on the uncropped grid. Each stair tile is a one-tile cubby cut into the room's wall (findNiche),
//     preferring the camera-facing north wall.
//  7. Treasure wings (§17.14): rolled tiers (Cache/Hoard/Vault) attached as brand-new single-door LEAF rooms off
//     suitable parents (Vault first), on a canvas padded for them; a Vault may sit behind an antechamber.
//  8. Hidden-room modifier (§17.11): one Cache/Hoard's doorway becomes a secret wall (map.secrets / revealSecret).
//  9. Crop to the used area plus a 1-tile WALL border — last. Then chest spots and spawn caches.

import { TILE, bossForDepth } from './core.js';

const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const LINK_CAP = { small: 2, medium: 3, large: 4, grand: 4 }; // max rooms linked to one room
const isBig = (r) => r.size === 'large' || r.size === 'grand';
const DIR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Hidden treasure rooms (§17.11/§17.14): a concealment MODIFIER on one Cache/Hoard wing per depth (never a Vault). Every
// treasure wing is a purpose-built single-door leaf, so an eligible room exists whenever one was placed — the old 45%
// workaround for dead-end scarcity is gone and the roll is the designed 35%.
export const HIDDEN_ROOM_CHANCE = 0.35;
export const HIDDEN_ROOM_MIN_DEPTH = 2;

// ---------- Treasure tiers (§17.14) ----------
// Layout side of the tier table (loot lives in items.js rollChestContents, guards in enemies.js treasureGuardPlan).
export const TREASURE_TIER_IDS = Object.freeze(['cache', 'hoard', 'vault']);
export const TREASURE_ROOM_SIZE = Object.freeze({ cache: 'small', hoard: 'medium', vault: 'large' });
export const VAULT_MIN_DEPTH = 3;
export const MAX_TREASURE_ROOMS = 5;
export const TREASURE_EXTRA_SLOT_CHANCE = 0.5; // each slot beyond the first (and depth 1's only slot, see below)
export const ANTECHAMBER_MIN_DEPTH = 6;
export const ANTECHAMBER_CHANCE = 0.5;
// Margin added around the growth canvas before wings attach (cropped away again if unused). The pre-crop canvas
// never exceeds WING_CANVAS_MAX, so the final map can't either (§7: never > 90).
const WING_CANVAS_PAD = 8;
const WING_CANVAS_MAX = 90;

// Max treasure rooms that can roll on a depth: min(5, round(5·(1-e^(-depth/4)))) -> 1/2/3 at depths 1-3, 5 by 10.
export function treasureRoomSlots(depth) {
  return Math.min(MAX_TREASURE_ROOMS, Math.round(MAX_TREASURE_ROOMS * (1 - Math.exp(-depth / 4))));
}

// Tier weights at a depth: t = clamp((depth-1)/19, 0, 1); Cache 60->40, Hoard 30->40, Vault 10->20 (0 below
// VAULT_MIN_DEPTH). Relative weights — a Vault already rolled this depth is removed and the rest renormalize.
export function treasureTierWeights(depth) {
  const t = Math.min(1, Math.max(0, (depth - 1) / 19));
  return {
    cache: 0.6 - 0.2 * t,
    hoard: 0.3 + 0.1 * t,
    vault: depth >= VAULT_MIN_DEPTH ? 0.1 + 0.1 * t : 0,
  };
}

// The tiers this depth tries to place, ordered Vault first, then Hoards, then Caches (the pickier/rarer wings get
// first choice of parent rooms). From depth 2 the first slot always fills; every other slot fills at 50% — including
// depth 1's single slot (the spec pins "from depth 2", so depth 1 keeps the old flat 50% treasure-room odds).
// At most one Vault per depth.
export function rollTreasureTiers(depth, rng) {
  const slots = treasureRoomSlots(depth);
  const out = [];
  for (let s = 0; s < slots; s++) {
    const guaranteed = s === 0 && depth >= 2;
    if (!guaranteed && !rng.chance(TREASURE_EXTRA_SLOT_CHANCE)) continue;
    const w = treasureTierWeights(depth);
    if (out.includes('vault')) w.vault = 0;
    out.push(rng.weighted(TREASURE_TIER_IDS, (id) => w[id]));
  }
  const order = { vault: 0, hoard: 1, cache: 2 };
  return out.sort((a, b) => order[a] - order[b]);
}

// Chests per tier room: Cache 1, Hoard 1-2, Vault 2-3.
export function rollChestCount(tier, rng) {
  if (tier === 'vault') return rng.int(2, 3);
  if (tier === 'hoard') return rng.int(1, 2);
  return 1;
}

function computeMapSize(depth) {
  let s = 54 + Math.round((depth - 1) * 2.5);
  if (s > 86) s = 86;
  return s;
}

export function targetRoomCount(depth) {
  return Math.min(22, 11 + Math.floor((depth - 1) * 0.6));
}

// ---------- Floor archetypes (§17.13) ----------
// Each depth draws one profile; the growth algorithm below is the same for all of them, an archetype only swaps the
// constants it runs with. sizeMix = small/medium/large weights; favored/favoredShare = which shapes (relative weights)
// get what share of each size category's shape roll (null = every eligible shape evenly); sharedWall = chance a new room shares a wall
// with its parent (gap 1), otherwise gap = int(gap[0], gap[1]); loops = extra-link fraction; widen = chance a straight
// corridor gets a 2-wide body; cluster = chance a newly placed small room grows a cluster of 2-4 more small rooms;
// parent = parent-weighting ('spread': 1/(1+links), 'deep': toward the deepest spanning-tree nodes); grand = chance
// the seed room rolls the 'grand' landmark size (never on boss depths).
export const ARCHETYPES = Object.freeze({
  halls: {
    sizeMix: { small: 18, medium: 44, large: 38 }, favored: null, favoredShare: 0,
    sharedWall: 0.3, gap: [3, 7], loops: 0.25, widen: 0.3, cluster: 0, parent: 'spread', grand: 0.2,
  },
  catacombs: {
    sizeMix: { small: 45, medium: 45, large: 10 }, favored: { rect: 1, cross: 1 }, favoredShare: 0.75,
    sharedWall: 0.5, gap: [3, 7], loops: 0.35, widen: 0.3, cluster: 0.4, parent: 'spread', grand: 0.2,
  },
  caverns: {
    sizeMix: { small: 10, medium: 40, large: 50 }, favored: { cave: 1, cavern: 1 }, favoredShare: 0.72,
    sharedWall: 0.45, gap: [3, 7], loops: 0.25, widen: 0.6, cluster: 0, parent: 'spread', grand: 0.2,
  },
  keep: {
    sizeMix: { small: 18, medium: 44, large: 38 }, favored: { rect: 2, pillars: 2, ringHall: 2, gallery: 1 }, favoredShare: 0.75,
    sharedWall: 0.3, gap: [3, 7], loops: 0.15, widen: 0.3, cluster: 0, parent: 'spread', grand: 1,
  },
  wings: {
    sizeMix: { small: 18, medium: 44, large: 38 }, favored: null, favoredShare: 0,
    sharedWall: 0.2, gap: [5, 12], loops: 0.15, widen: 0.3, cluster: 0, parent: 'deep', grand: 0.2,
  },
});
export const ARCHETYPE_IDS = Object.freeze(Object.keys(ARCHETYPES));

// Uniform over the archetypes, excluding the previous depth's (so two consecutive floors never share a profile).
export function pickArchetype(rng, prevArchetype) {
  const pool = ARCHETYPE_IDS.filter(a => a !== prevArchetype);
  return rng.pick(pool);
}

// Shapes each size category may roll. Grand (the landmark seed room) is ring hall or pillared hall only.
export const SHAPES_BY_SIZE = Object.freeze({
  small: ['rect', 'cross'],
  medium: ['rect', 'Lshape', 'overlap', 'cave', 'cross', 'octagon', 'gallery', 'splitHall', 'cavern'],
  large: ['rect', 'pillars', 'Lshape', 'overlap', 'cave', 'cross', 'octagon', 'gallery', 'ringHall', 'splitHall', 'cavern'],
  grand: ['ringHall', 'pillars'],
});

// Within one size category: the favored shapes that category can roll split favoredShare (by their relative
// weights), every other eligible shape splits the rest evenly; no favored shape eligible -> all even.
function shapeWeight(profile, eligible, type) {
  const favored = (profile && profile.favored) || {};
  const fav = eligible.filter(t => favored[t]);
  if (!fav.length || fav.length === eligible.length) return 1;
  if (!favored[type]) return (1 - profile.favoredShare) / (eligible.length - fav.length);
  const total = fav.reduce((sum, t) => sum + favored[t], 0);
  return profile.favoredShare * favored[type] / total;
}

// ---------- Room shapes ----------
// A shape is { w, h, mask: Uint8Array(w*h) (1 = floor), pillars: [[lx,ly]], core: [[lx,ly]], type }.
// core = WALL tiles inside the room that must never become a doorway, stair cubby or corridor: a ring hall's solid
// centre, a split hall's divider, and any enclosed rock (pillars, cavern islands) — found automatically here, since
// anything not 4-connected to the outside of the bounding box is enclosed by the room's own floor.
function normalizeShape(w, h, mask, pillars, type, core = []) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  const nm = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) nm[y * nw + x] = mask[(y + y0) * w + (x + x0)];
  // enclosed non-floor: flood the outside in from the bbox border
  const outside = new Uint8Array(nw * nh);
  const q = [];
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    if ((x === 0 || y === 0 || x === nw - 1 || y === nh - 1) && !nm[y * nw + x]) { outside[y * nw + x] = 1; q.push(y * nw + x); }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const x = q[qi] % nw, y = (q[qi] / nw) | 0;
    for (const [dx, dy] of DIR4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= nw || ny >= nh) continue;
      const ni = ny * nw + nx;
      if (!nm[ni] && !outside[ni]) { outside[ni] = 1; q.push(ni); }
    }
  }
  const coreSet = new Set();
  for (const [cx, cy] of core) {
    const x = cx - x0, y = cy - y0;
    if (x >= 0 && y >= 0 && x < nw && y < nh && !nm[y * nw + x]) coreSet.add(y * nw + x);
  }
  for (let i = 0; i < nw * nh; i++) if (!nm[i] && !outside[i]) coreSet.add(i);
  return {
    w: nw, h: nh, mask: nm, type,
    pillars: pillars.map(([px, py]) => [px - x0, py - y0]),
    core: [...coreSet].sort((a, b) => a - b).map(i => [i % nw, (i / nw) | 0]),
  };
}

// Door slots of a lone shape (local coords), by the same rule generateDungeon's doorSlots applies on the grid: a
// non-floor, non-core tile just outside a floor tile, on a straight 3-tile stretch of edge. Used to reject cavern
// blobs too ragged to take a door on every side, and by tests.
export function shapeDoorSlots(shape) {
  const { w, h, mask } = shape;
  const core = new Set(shape.core.map(([x, y]) => y * w + x));
  const floor = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!floor(x, y)) continue;
    for (const [dx, dy] of DIR4) {
      const sx = x + dx, sy = y + dy;
      if (floor(sx, sy)) continue;
      if (sx >= 0 && sy >= 0 && sx < w && sy < h && core.has(sy * w + sx)) continue;
      const px = dy, py = dx;
      if (floor(sx + px, sy + py) || floor(sx - px, sy - py)) continue;
      if (!floor(x + px, y + py) || !floor(x - px, y - py)) continue;
      out.push({ x: sx, y: sy, dx, dy });
    }
  }
  return out;
}

// Cellular-automata blob: ellipse-biased noise, 4 smoothing passes, spikes trimmed, largest 4-connected component
// kept. Rejected (null) unless it fills >= 45% of its box and has a door slot facing every direction.
function cavernShape(rng, w, h) {
  for (let attempt = 0; attempt < 12; attempt++) {
    let m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const nx = (x + 0.5 - w / 2) / (w / 2), ny = (y + 0.5 - h / 2) / (h / 2);
      const d = nx * nx + ny * ny;
      m[y * w + x] = rng.next() < (d < 0.3 ? 0.75 : d < 1 ? 0.58 : 0.3) ? 1 : 0;
    }
    const at = (g, x, y) => (x >= 0 && y >= 0 && x < w && y < h ? g[y * w + x] : 0);
    for (let it = 0; it < 4; it++) {
      const n = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let c = 0;
        for (const [dx, dy] of DIR8) c += at(m, x + dx, y + dy);
        n[y * w + x] = c >= 5 || (m[y * w + x] && c >= 4) ? 1 : 0;
      }
      m = n;
    }
    for (let it = 0; it < 2; it++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        let c = 0;
        for (const [dx, dy] of DIR4) c += at(m, x + dx, y + dy);
        if (c <= 1) m[y * w + x] = 0;
      }
    }
    // largest 4-connected component
    const comp = new Int32Array(w * h).fill(-1);
    let best = -1, bestSize = 0;
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || comp[s] !== -1) continue;
      const q = [s]; comp[s] = s;
      for (let qi = 0; qi < q.length; qi++) {
        const x = q[qi] % w, y = (q[qi] / w) | 0;
        for (const [dx, dy] of DIR4) {
          const nx = x + dx, ny = y + dy;
          if (!at(m, nx, ny) || comp[ny * w + nx] !== -1) continue;
          comp[ny * w + nx] = s; q.push(ny * w + nx);
        }
      }
      if (q.length > bestSize) { bestSize = q.length; best = s; }
    }
    if (bestSize < w * h * 0.45) continue;
    for (let i = 0; i < w * h; i++) m[i] = comp[i] === best ? 1 : 0;
    // a few rock islands (1x1..2x2) standing in open floor — cover, and never a chokepoint since each keeps a full
    // floor ring (so they're enclosed -> core, never a door slot)
    const islands = w * h >= 100 ? rng.int(0, 2) : rng.int(0, 1);
    for (let k = 0, tries = 0; k < islands && tries < 30; tries++) {
      const iw = rng.int(1, 2), ih = rng.int(1, 2);
      const ix = rng.int(2, w - 2 - iw), iy = rng.int(2, h - 2 - ih);
      let clear = true;
      for (let y = iy - 2; y < iy + ih + 2 && clear; y++) for (let x = ix - 2; x < ix + iw + 2; x++) if (!at(m, x, y)) { clear = false; break; }
      if (!clear) continue;
      for (let y = iy; y < iy + ih; y++) for (let x = ix; x < ix + iw; x++) m[y * w + x] = 0;
      k++;
    }
    const shape = normalizeShape(w, h, m, [], 'cavern');
    const slots = shapeDoorSlots(shape);
    if (DIR4.every(([dx, dy]) => slots.some(s => s.dx === dx && s.dy === dy))) return shape;
  }
  return null;
}

// opts: { profile (archetype, for shape weights), type (force a shape — tests) }. cat 'grand' is the landmark size.
export function makeShape(rng, cat, opts = {}) {
  let w, h;
  if (cat === 'small') { w = rng.int(5, 7); h = rng.int(5, 7); }
  else if (cat === 'medium') { w = rng.int(8, 11); h = rng.int(8, 10); }
  else if (cat === 'large') { w = rng.int(12, 18); h = rng.int(10, 14); }
  else { w = rng.int(20, 26); h = rng.int(14, 20); } // grand

  const eligible = SHAPES_BY_SIZE[cat];
  let type = opts.type || rng.weighted(eligible, t => shapeWeight(opts.profile, eligible, t));

  if (type === 'gallery') {
    // a long thin hall, either orientation
    const long = rng.int(14, 22), short = rng.int(3, 5);
    if (rng.chance(0.5)) { w = long; h = short; } else { w = short; h = long; }
  }
  if (type === 'cavern') {
    const cav = cavernShape(rng, w, h);
    if (cav) return cav;
    type = 'cave'; // too ragged every try: fall back to the smooth cave
  }

  const mask = new Uint8Array(w * h);
  const pillars = [];
  const core = [];
  const fillRect = (rx, ry, rw, rh) => {
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) mask[y * w + x] = 1;
  };

  if (type === 'Lshape') {
    fillRect(0, 0, w, h);
    const cw = rng.int(3, Math.max(3, w - 5)), ch = rng.int(3, Math.max(3, h - 5));
    const cx = rng.chance(0.5) ? 0 : w - cw, cy = rng.chance(0.5) ? 0 : h - ch;
    for (let y = cy; y < cy + ch; y++) for (let x = cx; x < cx + cw; x++) mask[y * w + x] = 0;
  } else if (type === 'overlap') {
    // two overlapping rectangles anchored in opposite corners (optionally mirrored)
    const wa = rng.int(Math.ceil(w * 0.5), w - 2), ha = rng.int(Math.ceil(h * 0.5), h - 1);
    const wb = rng.int(Math.max(5, w - wa + 3), w - 1), hb = rng.int(Math.max(5, h - ha + 3), h);
    const flip = rng.chance(0.5);
    const ax = flip ? w - wa : 0, bx = flip ? 0 : w - wb;
    fillRect(ax, 0, wa, ha);
    fillRect(bx, h - hb, wb, hb);
  } else if (type === 'cave') {
    const rx = w / 2, ry = h / 2;
    for (let y = 0; y < h; y++) {
      const ny = (y + 0.5 - ry) / ry;
      const half = Math.sqrt(Math.max(0, 1 - ny * ny)) * rx;
      let a = Math.round(rx - half), b = Math.round(rx + half) - 1;
      if (b - a + 1 > 5) { if (rng.chance(0.35)) a++; if (rng.chance(0.35)) b--; }
      if (b - a + 1 < 3) { const m = Math.floor(rx); a = Math.min(a, m - 1); b = Math.max(b, m + 1); }
      for (let x = Math.max(0, a); x <= Math.min(w - 1, b); x++) mask[y * w + x] = 1;
    }
  } else if (type === 'cross') {
    // centred overlapping bars: a plus, or a T (one bar pushed to an edge, the other centred through it)
    const vb = rng.int(3, Math.max(3, w - 2)), hb = rng.int(3, Math.max(3, h - 2));
    const vx = (w - vb) >> 1, hy = (h - hb) >> 1;
    const t = rng.chance(0.5) ? rng.int(0, 3) : -1; // -1 = plus, else which edge the T's bar sits on
    if (t === 0) { fillRect(0, 0, w, hb); fillRect(vx, 0, vb, h); }
    else if (t === 1) { fillRect(0, h - hb, w, hb); fillRect(vx, 0, vb, h); }
    else if (t === 2) { fillRect(0, 0, vb, h); fillRect(0, hy, w, hb); }
    else if (t === 3) { fillRect(w - vb, 0, vb, h); fillRect(0, hy, w, hb); }
    else { fillRect(0, hy, w, hb); fillRect(vx, 0, vb, h); }
  } else if (type === 'octagon') {
    fillRect(0, 0, w, h);
    const c = Math.min(rng.int(2, 3), Math.max(1, (Math.min(w, h) - 3) >> 1));
    for (let y = 0; y < c; y++) for (let x = 0; x < c - y; x++) {
      mask[y * w + x] = 0; mask[y * w + (w - 1 - x)] = 0;
      mask[(h - 1 - y) * w + x] = 0; mask[(h - 1 - y) * w + (w - 1 - x)] = 0;
    }
  } else if (type === 'ringHall') {
    // a walkway around a solid core (>= 3x3)
    fillRect(0, 0, w, h);
    const lo = cat === 'grand' ? 4 : 3, hi = cat === 'grand' ? 6 : 4;
    const rx = Math.max(2, Math.min(rng.int(lo, hi), (w - 3) >> 1));
    const ry = Math.max(2, Math.min(rng.int(lo, hi), (h - 3) >> 1));
    for (let y = ry; y < h - ry; y++) for (let x = rx; x < w - rx; x++) { mask[y * w + x] = 0; core.push([x, y]); }
  } else if (type === 'splitHall') {
    // a one-tile dividing wall across the middle of the long axis, broken by 1-2 gaps (2-3 wide)
    fillRect(0, 0, w, h);
    const vertical = w >= h; // divider runs along y (splitting left/right halves) when the room is wide
    const span = vertical ? w : h, len = vertical ? h : w;
    const at = Math.max(3, Math.min(span - 4, (span >> 1) + rng.int(-1, 1)));
    const wall = new Array(len).fill(1);
    const nGaps = len >= 9 && rng.chance(0.5) ? 2 : 1;
    if (nGaps === 1) { const gw = rng.int(2, 3), g = rng.int(0, len - gw); for (let k = g; k < g + gw; k++) wall[k] = 0; }
    else {
      const g1w = rng.int(2, 3), g2w = rng.int(2, 3);
      const g1 = rng.int(0, 2), g2 = len - g2w - rng.int(0, 2);
      for (let k = g1; k < g1 + g1w; k++) wall[k] = 0;
      for (let k = g2; k < g2 + g2w; k++) wall[k] = 0;
    }
    for (let k = 0; k < len; k++) {
      if (!wall[k]) continue;
      const x = vertical ? at : k, y = vertical ? k : at;
      mask[y * w + x] = 0; core.push([x, y]);
    }
  } else {
    fillRect(0, 0, w, h);
    if (type === 'pillars') {
      // colonnade (two rows) or a grid of single pillars, spaced so each is isolated
      const step = rng.pick([3, 4]);
      const grid = h >= 11 && rng.chance(0.4);
      const xs = [], ys = [];
      const offX = 2 + ((w - 5) % step >> 1);
      for (let x = offX; x <= w - 3; x += step) xs.push(x);
      if (grid) { const offY = 2 + ((h - 5) % step >> 1); for (let y = offY; y <= h - 3; y += step) ys.push(y); }
      else ys.push(2, h - 3);
      for (const py of ys) for (const px of xs) { mask[py * w + px] = 0; pillars.push([px, py]); }
    }
  }
  return normalizeShape(w, h, mask, pillars, type, core);
}

// ---------- Boss arenas (§17.15) ----------
// On a boss depth the seed room is a purpose-built arena shaped for that boss (BOSS_ARENAS), not whichever room the
// boss happened to land in. Minimum, derived from the bosses' own attack numbers (§17.15): a 16x13 box, >= 180 floor
// tiles, and a clear 9x9 core (Chebyshev radius 4, no pillar/rock) around the boss's spawn point — the room centre,
// the same tile placeRoom makes room.cx/cy. Every arena is room.size 'large' with a link cap of 2 and doorways only on
// its two short ends (the ends of its long axis), so the level grows outward from both sides.
export const ARENA_MIN = Object.freeze({ long: 16, short: 13, floor: 180, clearRadius: 4 });
export const ARENA_LINK_CAP = 2;
// shape: the room.shape id it builds; w/h: size ranges (long x short, before a random 90° turn).
export const BOSS_ARENAS = Object.freeze({
  // Slime King — "Sump": a smooth, open ellipse whose ~8-tile radius matches Glob Spray's range (8, enemies.js), with
  // 3-4 lone rock islands >= 6 tiles out on the diagonals as cover, each with open floor all round it.
  slime_king: Object.freeze({ name: 'Sump', shape: 'sump', w: [17, 19], h: [15, 17] }),
  // Bone Tyrant — "Ossuary Hall": a long hall with a two-row colonnade 3 tiles in from each long wall. The colonnade
  // breaks for the clear 9x9 crossing at the centre (a 13-15 wide hall can't fit both the rows and the core), so the
  // pillars stand in the two end bays — where spear lanes stop on them and a Bone Charge baited into one ends early.
  bone_tyrant: Object.freeze({ name: 'Ossuary Hall', shape: 'ossuaryHall', w: [20, 24], h: [13, 15] }),
});
// Any boss without its own entry yet: a plain 17x15 rectangle (clear core by construction).
export const GENERIC_ARENA = Object.freeze({ name: 'Arena', shape: 'arena', w: [17, 17], h: [15, 15] });
export const ARENA_SHAPES = Object.freeze(['sump', 'ossuaryHall', 'arena']);
export const arenaSpec = (bossId) => BOSS_ARENAS[bossId] || GENERIC_ARENA;

// Measurements of an arena shape against ARENA_MIN: box (long/short side), floor tiles, and the clear-core radius —
// the largest Chebyshev radius around the spawn tile ((w-1)>>1, (h-1)>>1) that is all floor. endSlots: door slots on
// each short end (the two ends of the long axis).
export function arenaStats(shape) {
  const { w, h, mask } = shape;
  let floor = 0;
  for (let i = 0; i < w * h; i++) floor += mask[i];
  const sx = (w - 1) >> 1, sy = (h - 1) >> 1;
  const isFloor = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  let clearRadius = -1;
  for (let r = 0; r <= Math.max(w, h); r++) {
    let ok = true;
    for (let y = sy - r; y <= sy + r && ok; y++) for (let x = sx - r; x <= sx + r; x++) if (!isFloor(x, y)) { ok = false; break; }
    if (!ok) break;
    clearRadius = r;
  }
  const horiz = w >= h;
  const slots = shapeDoorSlots(shape);
  const endSlots = horiz
    ? [slots.filter(s => s.dx === -1).length, slots.filter(s => s.dx === 1).length]
    : [slots.filter(s => s.dy === -1).length, slots.filter(s => s.dy === 1).length];
  return { long: Math.max(w, h), short: Math.min(w, h), floor, clearRadius, spawn: { x: sx, y: sy }, endSlots };
}
export function arenaMeetsMinimum(shape) {
  const s = arenaStats(shape);
  return s.long >= ARENA_MIN.long && s.short >= ARENA_MIN.short && s.floor >= ARENA_MIN.floor
    && s.clearRadius >= ARENA_MIN.clearRadius && s.endSlots.every(n => n > 0);
}
// The two sides an arena's doorways may use: the ends of its long axis.
export function arenaDoorSides(shape) {
  return shape.w >= shape.h ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
}

// The arena for `bossId` (opts.type forces a shape id — tests). Built long-axis horizontal, then turned 90° half the
// time. Rebuilt until it passes arenaMeetsMinimum; the generic rectangle (which always does) is the last resort.
export function makeArenaShape(rng, bossId, opts = {}) {
  const spec = opts.type ? (Object.values(BOSS_ARENAS).find(a => a.shape === opts.type) || GENERIC_ARENA) : arenaSpec(bossId);
  for (let attempt = 0; attempt < 30; attempt++) {
    let w = rng.int(spec.w[0], spec.w[1]), h = rng.int(spec.h[0], spec.h[1]);
    if (h > w) [w, h] = [h, w];
    const mask = new Uint8Array(w * h);
    const pillars = [];
    const cx = (w - 1) >> 1, cy = (h - 1) >> 1;
    if (spec.shape === 'sump') {
      const a = w / 2, b = h / 2;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const nx = (x + 0.5 - a) / a, ny = (y + 0.5 - b) / b;
        if (nx * nx + ny * ny <= 1) mask[y * w + x] = 1;
      }
      // islands on the four diagonals (so none stands in front of an end doorway), 3 or 4 of them
      const want = rng.int(3, 4);
      const quads = rng.shuffle([0, 1, 2, 3]).slice(0, want);
      const taken = [];
      for (const q of quads) {
        for (let t = 0; t < 16; t++) {
          const ang = Math.PI / 4 + q * Math.PI / 2 + rng.range(-0.3, 0.3);
          const r = rng.range(6, 6.8);
          const iw = rng.chance(0.35) ? 2 : 1, ih = iw === 1 && rng.chance(0.35) ? 2 : 1;
          const ix = Math.round(cx + Math.cos(ang) * r), iy = Math.round(cy + Math.sin(ang) * r);
          const cells = [];
          for (let y = iy; y < iy + ih; y++) for (let x = ix; x < ix + iw; x++) cells.push([x, y]);
          // >= 6 tiles from the centre, and a full ring of open floor round it (cover you can always walk around)
          if (cells.some(([x, y]) => Math.hypot(x - cx, y - cy) < 6)) continue;
          let ok = true;
          for (let y = iy - 1; y <= iy + ih && ok; y++) for (let x = ix - 1; x <= ix + iw; x++) {
            if (!isMaskFloor(mask, w, h, x, y)) { ok = false; break; }
          }
          if (!ok || taken.some(([x, y]) => x >= ix - 3 && x <= ix + iw + 2 && y >= iy - 3 && y <= iy + ih + 2)) continue;
          for (const [x, y] of cells) { mask[y * w + x] = 0; taken.push([x, y]); }
          pillars.push(...cells);
          break;
        }
      }
    } else {
      mask.fill(1);
      if (spec.shape === 'ossuaryHall') {
        // two colonnade rows 3 tiles in from each long wall, a pillar every other tile, broken for the clear core
        const rows = [3, h - 4];
        for (let x = 2; x <= cx - (ARENA_MIN.clearRadius + 1); x += 2) {
          for (const px of [x, w - 1 - x]) for (const py of rows) { mask[py * w + px] = 0; pillars.push([px, py]); }
        }
      }
    }
    let shape = normalizeShape(w, h, mask, pillars, spec.shape);
    if (rng.chance(0.5)) shape = transposeShape(shape);
    if (arenaMeetsMinimum(shape)) return shape;
  }
  return opts.type || spec === GENERIC_ARENA ? null : makeArenaShape(rng, null);
}
function isMaskFloor(mask, w, h, x, y) { return x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1; }
// A shape turned 90° (mirrored across its diagonal): w/h, mask, pillars and core swap axes.
function transposeShape(s) {
  const mask = new Uint8Array(s.w * s.h);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) mask[x * s.h + y] = s.mask[y * s.w + x];
  return {
    w: s.h, h: s.w, mask, type: s.type,
    pillars: s.pillars.map(([x, y]) => [y, x]),
    core: s.core.map(([x, y]) => [y, x]).sort((a, b) => (a[1] * s.h + a[0]) - (b[1] * s.h + b[0])),
  };
}

// opts.prevArchetype: the previous depth's map.archetype, so this depth never repeats it (§17.13).
// opts.merchant: this is a merchant depth — reserve the merchant's room (map.merchantRoomId).
export function generateDungeon(depth, rng, opts = {}) {
  const archetype = pickArchetype(rng, opts.prevArchetype);
  const profile = ARCHETYPES[archetype];
  let width = computeMapSize(depth);
  let height = width;
  const idx = (x, y) => y * width + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
  const interior = (x, y) => x >= 1 && y >= 1 && x <= width - 2 && y <= height - 2;

  let tiles = new Uint8Array(width * height).fill(TILE.WALL);
  let roomIdGrid = new Int32Array(width * height).fill(-1); // per-cell room id (room floor only)
  let reserved = new Uint8Array(width * height); // 1 = a room's core WALL tile (never a doorway/corridor/cubby)
  const rooms = [];
  const links = new Set(); // "a|b" with a<b
  const linkKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const linkCount = new Map();
  // A room's link cap: its size's, unless it carries its own (the boss arena's is ARENA_LINK_CAP).
  const linkCap = (r) => r._linkCap ?? LINK_CAP[r.size];

  // ---------- 1+2. Room placement ----------
  function canPlace(shape, ox, oy) {
    if (ox < 1 || oy < 1 || ox + shape.w > width - 1 || oy + shape.h > height - 1) return false;
    const { w, h, mask } = shape;
    for (const [lx, ly] of shape.core) {
      const i = idx(ox + lx, oy + ly);
      if (tiles[i] !== TILE.WALL || reserved[i]) return false;
    }
    for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
      if (!mask[ly * w + lx]) continue;
      const x = ox + lx, y = oy + ly;
      if (tiles[idx(x, y)] !== TILE.WALL || reserved[idx(x, y)]) return false;
      for (const [dx, dy] of DIR8) {
        const nx = x + dx, ny = y + dy;
        if (!interior(nx, ny) && !inBounds(nx, ny)) return false;
        if (tiles[idx(nx, ny)] !== TILE.WALL) return false;
      }
    }
    return true;
  }

  function placeRoom(shape, ox, oy, cat) {
    const id = rooms.length;
    const cells = [];
    const { w, h, mask } = shape;
    for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
      if (!mask[ly * w + lx]) continue;
      const i = idx(ox + lx, oy + ly);
      tiles[i] = TILE.FLOOR; roomIdGrid[i] = id; cells.push(i);
    }
    const core = shape.core.map(([lx, ly]) => idx(ox + lx, oy + ly));
    for (const i of core) reserved[i] = 1;
    // cx,cy: bbox centre if it is floor, otherwise the nearest floor tile of the room
    let cx = ox + ((w - 1) >> 1), cy = oy + ((h - 1) >> 1);
    if (roomIdGrid[idx(cx, cy)] !== id) {
      let best = cells[0], bd = Infinity;
      for (const i of cells) {
        const x = i % width, y = (i / width) | 0;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      cx = best % width; cy = (best / width) | 0;
    }
    const room = { id, x: ox, y: oy, w, h, cx, cy, size: cat, shape: shape.type, doors: [], kind: 'normal' };
    Object.defineProperty(room, '_cells', { value: cells, enumerable: false, writable: true });
    Object.defineProperty(room, '_core', { value: core, enumerable: false, writable: true });
    rooms.push(room);
    linkCount.set(id, 0);
    return room;
  }

  function unplaceRoom(room) {
    for (const i of room._cells) { tiles[i] = TILE.WALL; roomIdGrid[i] = -1; }
    for (const i of room._core) reserved[i] = 0;
    rooms.pop();
    linkCount.delete(room.id);
  }

  // The sides (unit [dx,dy]) a room with restricted doorways (_doorSides: the boss arena's two short ends) may still
  // open a doorway on: one doorway per side, so its two links always leave from opposite ends.
  function openDoorSides(room) {
    const used = new Set();
    for (const d of room.doors) {
      for (const [dx, dy] of DIR4) {
        const ix = d.x - dx, iy = d.y - dy;
        if (inBounds(ix, iy) && roomIdGrid[idx(ix, iy)] === room.id) used.add(dx + ',' + dy);
      }
    }
    return room._doorSides.filter(([dx, dy]) => !used.has(dx + ',' + dy));
  }

  // Door slots: wall tiles directly outside a straight stretch of the room's edge.
  function doorSlots(room) {
    const out = [];
    const id = room.id;
    const sides = room._doorSides ? openDoorSides(room) : DIR4;
    for (const i of room._cells) {
      const x = i % width, y = (i / width) | 0;
      for (const [dx, dy] of sides) {
        const sx = x + dx, sy = y + dy;
        if (!interior(sx, sy) || roomIdGrid[idx(sx, sy)] === id || reserved[idx(sx, sy)]) continue;
        const px = dy, py = dx; // perpendicular
        if (!inBounds(sx + px, sy + py) || !inBounds(sx - px, sy - py)) continue;
        if (roomIdGrid[idx(sx + px, sy + py)] === id || roomIdGrid[idx(sx - px, sy - py)] === id) continue;
        // the tiles flanking the inner floor tile must also be room floor (straight wall)
        if (roomIdGrid[idx(x + px, y + py)] !== id || roomIdGrid[idx(x - px, y - py)] !== id) continue;
        out.push({ x: sx, y: sy, dx, dy });
      }
    }
    return out;
  }

  // A carved passage may touch only the room floors it joins, at its two end tiles.
  function pathValid(cells, aId, bId) {
    const set = new Set(cells);
    const last = cells.length - 1;
    for (let k = 0; k <= last; k++) {
      const i = cells[k];
      const x = i % width, y = (i / width) | 0;
      if (!interior(x, y) || tiles[i] !== TILE.WALL || reserved[i]) return false;
      for (const [dx, dy] of DIR8) {
        const ni = idx(x + dx, y + dy);
        if (set.has(ni) || tiles[ni] === TILE.WALL) continue;
        const rid = roomIdGrid[ni];
        if (k === 0 && rid === aId) continue;
        if (k === last && rid === bId) continue;
        return false;
      }
      // keep clear of other corridors (no parallel hallways one wall apart)
      for (const [dx, dy] of DIR4) {
        const nx = x + 2 * dx, ny = y + 2 * dy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (!set.has(ni) && tiles[ni] !== TILE.WALL && roomIdGrid[ni] === -1) return false;
      }
    }
    return true;
  }

  function lineCells(x0, y0, x1, y1, out) {
    let x = x0, y = y0;
    out.push(idx(x, y));
    while (x !== x1 || y !== y1) {
      x += Math.sign(x1 - x); y += Math.sign(y1 - y);
      out.push(idx(x, y));
    }
  }

  // Try to link rooms A and B with a doorway / short corridor. Returns true on success.
  function connect(A, B, maxLen, allowL) {
    const bcx = B.x + B.w / 2, bcy = B.y + B.h / 2, acx = A.x + A.w / 2, acy = A.y + A.h / 2;
    const sa = doorSlots(A).filter(s => s.dx * (bcx - s.x) + s.dy * (bcy - s.y) > 0);
    const sb = doorSlots(B).filter(s => s.dx * (acx - s.x) + s.dy * (acy - s.y) > 0);
    const cands = [];
    for (const a of sa) {
      for (const b of sb) {
        const man = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        if (man + 1 > maxLen) continue;
        if (a.dx === -b.dx && a.dy === -b.dy) {
          // straight: same row/column, B in front of A
          if (a.dx !== 0 ? a.y !== b.y : a.x !== b.x) continue;
          if ((b.x - a.x) * a.dx + (b.y - a.y) * a.dy < 0) continue;
          cands.push({ a, b, corner: null, cost: man + rng.next() * 1.5 });
        } else if (allowL && a.dx * b.dx + a.dy * b.dy === 0) {
          const corner = a.dx !== 0 ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
          const kA = (corner.x - a.x) * a.dx + (corner.y - a.y) * a.dy;
          const kB = (corner.x - b.x) * b.dx + (corner.y - b.y) * b.dy;
          if (kA < 1 || kB < 1) continue;
          cands.push({ a, b, corner, cost: man + 4 + rng.next() * 1.5 });
        }
      }
    }
    if (!cands.length) return false;
    cands.sort((p, q) => p.cost - q.cost);
    const tries = Math.min(cands.length, 60);
    for (let t = 0; t < tries; t++) {
      const c = cands[t];
      const cells = [];
      if (c.corner) {
        lineCells(c.a.x, c.a.y, c.corner.x, c.corner.y, cells);
        const tail = [];
        lineCells(c.corner.x, c.corner.y, c.b.x, c.b.y, tail);
        for (let k = 1; k < tail.length; k++) cells.push(tail[k]);
      } else {
        lineCells(c.a.x, c.a.y, c.b.x, c.b.y, cells);
      }
      if (!pathValid(cells, A.id, B.id)) continue;
      carvePassage(cells, A, B, !c.corner ? { px: c.a.dy, py: c.a.dx } : null);
      return true;
    }
    return false;
  }

  function carvePassage(cells, A, B, straightPerp) {
    for (const i of cells) tiles[i] = TILE.FLOOR;
    const first = cells[0], last = cells[cells.length - 1];
    tiles[first] = TILE.DOOR; tiles[last] = TILE.DOOR;
    A.doors.push({ x: first % width, y: (first / width) | 0 });
    B.doors.push({ x: last % width, y: (last / width) | 0 });
    const k = linkKey(A.id, B.id);
    links.add(k);
    linkCount.set(A.id, linkCount.get(A.id) + 1);
    linkCount.set(B.id, linkCount.get(B.id) + 1);

    // occasionally widen a straight corridor body to 2 tiles (doorways stay 1 wide)
    if (straightPerp && cells.length >= 4 && rng.chance(profile.widen)) {
      const body = cells.slice(1, -1);
      const sides = rng.chance(0.5) ? [1, -1] : [-1, 1];
      for (const s of sides) {
        const off = idx(straightPerp.px * s, straightPerp.py * s) - idx(0, 0);
        const lane = body.map(i => i + off);
        const set = new Set(cells.concat(lane));
        let ok = true;
        for (const i of lane) {
          const x = i % width, y = (i / width) | 0;
          if (!interior(x, y) || tiles[i] !== TILE.WALL || reserved[i]) { ok = false; break; }
          for (const [dx, dy] of DIR8) {
            const ni = idx(x + dx, y + dy);
            if (!set.has(ni) && tiles[ni] !== TILE.WALL) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (ok) { for (const i of lane) tiles[i] = TILE.FLOOR; break; }
      }
    }
  }

  function pickCategory() {
    return rng.weighted(['small', 'medium', 'large'], c => profile.sizeMix[c]);
  }
  const pickGap = () => (rng.chance(profile.sharedWall) ? 1 : rng.int(profile.gap[0], profile.gap[1]));

  // Attach a new room of size `cat` to `parent` on a random side (or `side`), `gap` tiles out; kept only if its link
  // carves. A parent with restricted doorways (the boss arena) only grows rooms off its still-open ends.
  const treeDepth = new Map(); // spanning-tree depth per room id ('deep' parent weighting)
  function tryAttach(parent, cat, gap, side = null) {
    const sides = parent._doorSides ? openDoorSides(parent) : DIR4;
    if (!sides.length) return null;
    const shape = makeShape(rng, cat, { profile });
    const [dx, dy] = side || rng.pick(sides);
    let ox, oy;
    if (dx !== 0) {
      ox = dx > 0 ? parent.x + parent.w + gap : parent.x - gap - shape.w;
      oy = rng.int(parent.y - shape.h + 3, parent.y + parent.h - 3);
    } else {
      oy = dy > 0 ? parent.y + parent.h + gap : parent.y - gap - shape.h;
      ox = rng.int(parent.x - shape.w + 3, parent.x + parent.w - 3);
    }
    if (!canPlace(shape, ox, oy)) return null;
    const room = placeRoom(shape, ox, oy, cat);
    if (!connect(parent, room, gap + 6, false) && !connect(parent, room, gap + 8, true)) { unplaceRoom(room); return null; }
    treeDepth.set(room.id, treeDepth.get(parent.id) + 1);
    return room;
  }

  // Boss depths (§17.15): the seed room is the boss arena, and it's one room on top of the base count (§7), so the
  // rest of the floor keeps the same number of rooms as a non-boss depth.
  const bossId = bossForDepth(depth);
  let arena = null;
  const target = targetRoomCount(depth) + (bossId ? 1 : 0);
  {
    if (bossId) {
      // The boss arena takes the seed slot: placed first, near the centre of an empty canvas, so it always fits (the
      // canvas is >= 64 tiles by depth 5; an arena is at most 24 long). Then one room is grown off each short end.
      const shape = makeArenaShape(rng, bossId);
      for (let t = 0; t < 40 && !arena; t++) {
        const j = t < 30 ? 6 : 0;
        const ox = Math.floor(width / 2 - shape.w / 2) + rng.int(-j, j);
        const oy = Math.floor(height / 2 - shape.h / 2) + rng.int(-j, j);
        if (canPlace(shape, ox, oy)) arena = placeRoom(shape, ox, oy, 'large');
      }
      if (!arena) throw new Error(`map.js: boss arena did not fit a ${width}x${height} canvas`);
      treeDepth.set(arena.id, 0);
      arena.kind = 'boss';
      arena.arena = bossId;
      Object.defineProperty(arena, '_linkCap', { value: ARENA_LINK_CAP, enumerable: false, writable: true });
      Object.defineProperty(arena, '_doorSides', { value: arenaDoorSides(shape), enumerable: false, writable: true });
      for (const side of arena._doorSides) {
        for (let t = 0; t < 60 && rooms.length < target; t++) {
          if (!openDoorSides(arena).some(([dx, dy]) => dx === side[0] && dy === side[1])) break;
          if (tryAttach(arena, pickCategory(), pickGap(), side)) break;
        }
      }
    } else {
      // Seed room near the centre; it may roll the 'grand' landmark size (§17.13) — never on a boss depth, whose seed
      // slot is the arena above.
      const firstCat = rng.chance(profile.grand) ? 'grand' : 'large';
      for (let t = 0; t < 40 && rooms.length === 0; t++) {
        const cat = t < 20 ? firstCat : 'medium';
        const shape = makeShape(rng, cat, { profile });
        const ox = Math.floor(width / 2 - shape.w / 2) + rng.int(-6, 6);
        const oy = Math.floor(height / 2 - shape.h / 2) + rng.int(-6, 6);
        if (canPlace(shape, ox, oy)) { placeRoom(shape, ox, oy, cat); treeDepth.set(0, 0); }
      }
    }
    let attempts = 0;
    const maxAttempts = target * 50;
    while (rooms.length < target && attempts < maxAttempts) {
      attempts++;
      const open = rooms.filter(r => linkCount.get(r.id) < linkCap(r));
      if (!open.length) break;
      // 'spread': prefer parents with few links so the tree spreads out rather than forming one chain (a compact
      // blob). 'deep': prefer the deepest spanning-tree nodes, growing a few long branches instead.
      const parent = profile.parent === 'deep'
        ? rng.weighted(open, r => (1 + treeDepth.get(r.id)) ** 2)
        : rng.weighted(open, r => 1 / (1 + linkCount.get(r.id)));
      const cat = pickCategory();
      const room = tryAttach(parent, cat, pickGap());
      if (!room || cat !== 'small' || !rng.chance(profile.cluster)) continue;
      // Cluster mode: grow 2-4 more small rooms straight off this one (shared walls, gap 1), each attached to a
      // cluster member that still has link room — cell blocks, crypt rows, barracks suites.
      const members = [room];
      let want = rng.int(2, 4);
      for (let tries = 0; want > 0 && tries < 24 && rooms.length < target; tries++) {
        const openM = members.filter(r => linkCount.get(r.id) < LINK_CAP.small);
        if (!openM.length) break;
        // mostly the newest member (rows), sometimes any open one (branching blocks)
        const anchor = rng.chance(0.7) ? openM[openM.length - 1] : rng.pick(openM);
        const next = tryAttach(anchor, 'small', 1);
        if (next) { members.push(next); want--; }
      }
    }
  }

  // ---------- 4. Loops + exit-count top-up ----------
  function bboxGap(a, b) {
    const gx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
    const gy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
    return gx + gy;
  }
  {
    const pairs = [];
    for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
      const g = bboxGap(rooms[i], rooms[j]);
      if (g <= 9) pairs.push({ a: rooms[i], b: rooms[j], g: g + rng.next() * 3 });
    }
    pairs.sort((p, q) => p.g - q.g);

    let loops = Math.max(2, Math.round(rooms.length * profile.loops));
    for (const p of pairs) {
      if (loops <= 0) break;
      if (links.has(linkKey(p.a.id, p.b.id))) continue;
      if (linkCount.get(p.a.id) >= linkCap(p.a) || linkCount.get(p.b.id) >= linkCap(p.b)) continue;
      if (connect(p.a, p.b, 12, true)) loops--;
    }

    const want = new Map();
    for (const r of rooms) {
      let t;
      if (isBig(r)) t = rng.int(2, 4);
      else if (r.size === 'medium') t = rng.int(1, 3);
      else t = rng.chance(0.2) ? 2 : 1;
      want.set(r.id, t);
    }
    for (const p of pairs) {
      const need = (r) => linkCount.get(r.id) < want.get(r.id);
      if (!need(p.a) && !need(p.b)) continue;
      // do not push the other room far beyond its own cap (large rooms cap at 4)
      const cap = (r) => linkCount.get(r.id) < linkCap(r);
      if (!cap(p.a) || !cap(p.b)) continue;
      if (links.has(linkKey(p.a.id, p.b.id))) continue;
      connect(p.a, p.b, 12, true);
    }
    // large rooms still stuck at one link: allow a somewhat longer connector
    for (const r of rooms) {
      if (!isBig(r) || linkCount.get(r.id) >= Math.min(2, linkCap(r))) continue;
      const others = rooms.filter(o => o !== r && !links.has(linkKey(r.id, o.id)) && linkCount.get(o.id) < linkCap(o))
        .map(o => ({ o, g: bboxGap(r, o) })).filter(e => e.g <= 16).sort((p, q) => p.g - q.g);
      for (const e of others) if (connect(r, e.o, 20, true)) break;
    }
  }

  // ---------- 5. Connectivity safety net ----------
  function computeComponents() {
    const comp = new Int32Array(width * height).fill(-1);
    let count = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = idx(x, y);
        if (tiles[i] === TILE.WALL || comp[i] !== -1) continue;
        const queue = [i]; comp[i] = count; let qi = 0;
        while (qi < queue.length) {
          const ci = queue[qi++]; const cx = ci % width, cy = (ci / width) | 0;
          for (const [dx, dy] of DIR4) {
            const nx = cx + dx, ny = cy + dy;
            if (!interior(nx, ny)) continue;
            const ni = idx(nx, ny);
            if (comp[ni] === -1 && tiles[ni] !== TILE.WALL) { comp[ni] = count; queue.push(ni); }
          }
        }
        count++;
      }
    }
    return { comp, count };
  }

  // Strictly 4-connected L-shaped carve (a diagonal-stepping line is not 4-connected).
  function carveLine(x0, y0, x1, y1) {
    const carve = (x, y) => { if (interior(x, y) && tiles[idx(x, y)] === TILE.WALL) tiles[idx(x, y)] = TILE.FLOOR; };
    let x = x0, y = y0;
    carve(x, y);
    while (x !== x1) { x += x1 > x ? 1 : -1; carve(x, y); }
    while (y !== y1) { y += y1 > y ? 1 : -1; carve(x, y); }
  }

  {
    let { comp, count } = computeComponents();
    let guard = 0;
    while (count > 1 && guard < 20) {
      guard++;
      const sizes = new Array(count).fill(0);
      for (let i = 0; i < comp.length; i++) if (comp[i] >= 0) sizes[comp[i]]++;
      let mainId = 0; for (let i = 1; i < count; i++) if (sizes[i] > sizes[mainId]) mainId = i;
      for (let ci = 0; ci < count; ci++) {
        if (ci === mainId) continue;
        let sx = -1, sy = -1;
        for (let i = 0; i < comp.length; i++) if (comp[i] === ci) { sx = i % width; sy = (i / width) | 0; break; }
        if (sx === -1) continue;
        let best = null, bestD = Infinity;
        for (let i = 0; i < comp.length; i++) {
          if (comp[i] !== mainId) continue;
          const cx = i % width, cy = (i / width) | 0;
          const d = Math.abs(cx - sx) + Math.abs(cy - sy);
          if (d < bestD) { bestD = d; best = [cx, cy]; }
        }
        if (best) { carveLine(sx, sy, best[0], best[1]); break; }
      }
      ({ comp, count } = computeComponents());
    }
  }

  // ---------- Stair cubbies ----------
  // Stairs sit in a one-tile cubby cut into a room's wall, so they read as a doorway
  // instead of a marker in the middle of the floor. Weights prefer the north wall (it
  // faces the camera), then east/west; a south-wall cubby hides behind its own blocks.
  const NICHE_DIRS = [[0, -1, 4], [1, 0, 2], [-1, 0, 2], [0, 1, 0.5]];
  const isWallAt = (x, y) => !inBounds(x, y) || tiles[idx(x, y)] === TILE.WALL;
  // Tries progressively looser rules (0: strict, 1: closer to doors, 2: corners allowed) before
  // giving up on a wall cubby for this room.
  function findNiche(room) {
    for (let relax = 0; relax <= 2; relax++) {
      const n = findNicheWith(room, relax);
      if (n) return n;
    }
    // Fallback: a free-standing stair tile in the room center.
    return { x: room.cx, y: room.cy, dir: { x: 0, y: 1 }, front: { x: room.cx, y: room.cy }, freestanding: true };
  }
  function findNicheWith(room, relax) {
    const doorRadius = relax >= 1 ? 1 : 2;
    let best = null, bestScore = -Infinity;
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (!inBounds(x, y)) continue;
        const i = idx(x, y);
        if (tiles[i] !== TILE.FLOOR || roomIdGrid[i] !== room.id) continue;
        for (const [dx, dy, weight] of NICHE_DIRS) {
          const nx = x + dx, ny = y + dy;
          if (!interior(nx, ny) || tiles[idx(nx, ny)] !== TILE.WALL || reserved[idx(nx, ny)]) continue;
          const px = dy, py = dx; // perpendicular to the cubby's axis
          // Solid rock on both sides of the cubby and behind it.
          const rock = [[px, py], [-px, -py], [dx, dy], [dx + px, dy + py], [dx - px, dy - py]];
          if (rock.some(([ox, oy]) => !isWallAt(nx + ox, ny + oy))) continue;
          // Not tucked into a room corner: open floor on both sides of the approach tile.
          if (relax < 2 && (isWallAt(x + px, y + py) || isWallAt(x - px, y - py))) continue;
          // Keep clear of doorways.
          let nearDoor = false;
          for (let oy = -doorRadius; oy <= doorRadius && !nearDoor; oy++) {
            for (let ox = -doorRadius; ox <= doorRadius; ox++) {
              if (inBounds(x + ox, y + oy) && tiles[idx(x + ox, y + oy)] === TILE.DOOR) { nearDoor = true; break; }
            }
          }
          if (nearDoor) continue;
          // Favor the middle of the wall, with a little jitter so layouts vary.
          const offCenter = dx === 0 ? Math.abs(x - room.cx) : Math.abs(y - room.cy);
          const score = weight * 10 - offCenter + rng.next() * 1.5;
          if (score > bestScore) {
            bestScore = score;
            best = { x: nx, y: ny, dir: { x: -dx, y: -dy }, front: { x, y } };
          }
        }
      }
    }
    return best;
  }

  // Every non-WALL tile touching (8-neighbourhood) a room's floor from outside it. A dead end has exactly one: its
  // single doorway. Reads the live roomIdGrid, so it also catches any opening the BFS safety net carved without
  // registering a door.
  function roomOpenings(room) {
    const out = new Set();
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (!inBounds(x, y) || roomIdGrid[idx(x, y)] !== room.id) continue;
        for (const [dx, dy] of DIR8) {
          const nx = x + dx, ny = y + dy;
          if (!inBounds(nx, ny) || roomIdGrid[idx(nx, ny)] === room.id || tiles[idx(nx, ny)] === TILE.WALL) continue;
          out.add(idx(nx, ny));
        }
      }
    }
    return out;
  }
  function isDeadEndRoom(room) {
    if (room.doors.length !== 1) return false;
    const open = roomOpenings(room);
    const d = room.doors[0];
    return open.size === 1 && open.has(idx(d.x, d.y)) && tiles[idx(d.x, d.y)] === TILE.DOOR;
  }

  // 4-connected BFS distance field over every non-WALL tile, from one tile.
  function bfsFrom(sx, sy) {
    const d = new Int32Array(width * height).fill(-1);
    const s = idx(sx, sy);
    d[s] = 0;
    const queue = [s];
    for (let qi = 0; qi < queue.length; qi++) {
      const ci = queue[qi], cx = ci % width, cy = (ci / width) | 0;
      for (const [dx, dy] of DIR4) {
        const nx = cx + dx, ny = cy + dy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (tiles[ni] !== TILE.WALL && d[ni] === -1) { d[ni] = d[ci] + 1; queue.push(ni); }
      }
    }
    return d;
  }

  // ---------- 4. Start room / entrance, exits (the boss arena is already room 0) — then detour ranking (all on the UNCROPPED grid) ----------
  const baseRoomCount = rooms.length; // rooms placed by growth; everything after this is a treasure wing
  let startCandidates = rooms.filter(r => !isBig(r));
  if (arena) {
    // Boss depth (§17.15): the start room comes from the third of rooms farthest (walking) from the arena, so the
    // arena still ends up far from where the player enters. If that third has no small room: the farthest small one.
    const fromArena = bfsFrom(arena.cx, arena.cy);
    const dA = (r) => Math.max(0, fromArena[idx(r.cx, r.cy)]);
    const ranked = rooms.filter(r => r !== arena).sort((a, b) => dA(b) - dA(a));
    const farThird = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 3)));
    const farSmall = farThird.filter(r => !isBig(r));
    const anySmall = ranked.filter(r => !isBig(r));
    startCandidates = farSmall.length ? farSmall : anySmall.length ? [anySmall[0]] : ranked.slice(0, 1);
  }
  const startRoom = rng.pick(startCandidates.length ? startCandidates : rooms);
  startRoom.kind = 'start';
  const entrance = findNiche(startRoom);
  tiles[idx(entrance.x, entrance.y)] = TILE.ENTRANCE;

  const bfsDist = bfsFrom(entrance.x, entrance.y);

  // Exits: 1-3 rooms from the farthest third by walking distance — never the boss arena (§17.15).
  const otherRooms = rooms.filter(r => r !== startRoom && r.kind !== 'boss');
  for (const r of otherRooms) r._dist = bfsDist[idx(r.cx, r.cy)] < 0 ? 0 : bfsDist[idx(r.cx, r.cy)];
  otherRooms.sort((a, b) => b._dist - a._dist);
  const topThirdCount = Math.max(1, Math.ceil(otherRooms.length / 3));
  const topThird = otherRooms.slice(0, topThirdCount);

  let numExits = depth <= 2 ? 1 : rng.int(1, 3);
  numExits = Math.min(numExits, topThird.length || 1);
  const exitPool = rng.shuffle(topThird.slice());
  const exits = [];
  for (let i = 0; i < numExits && i < exitPool.length; i++) {
    const r = exitPool[i];
    r.kind = 'exit';
    const ex = findNiche(r);
    tiles[idx(ex.x, ex.y)] = TILE.EXIT;
    exits.push(ex);
  }
  if (exits.length === 0 && otherRooms.length) {
    const r = otherRooms[0];
    r.kind = 'exit';
    const ex = findNiche(r);
    tiles[idx(ex.x, ex.y)] = TILE.EXIT;
    exits.push(ex);
  }

  // (The boss room is the arena seed room, room 0, tagged 'boss' when it was placed — §17.15.)
  for (const r of otherRooms) delete r._dist;

  // Merchant room (opts.merchant — main.js passes isMerchantDepth): a dedicated room kind with no enemies inside
  // (excluded from spawn candidates and populatedFloor below), chosen BEFORE the treasure wings so a wing never
  // attaches to it. Same pick as shop.js always used: a random 'normal' room from the half farthest (straight-line)
  // from the entrance; with no normal room at all, the start room hosts it (it's already spawn-free).
  let merchantRoom = null;
  if (opts.merchant) {
    const pool = rooms.filter(r => r.kind === 'normal');
    if (pool.length) {
      const ranked = pool.slice().sort((a, b) => Math.hypot(b.cx - entrance.x, b.cy - entrance.y) - Math.hypot(a.cx - entrance.x, a.cy - entrance.y));
      merchantRoom = rng.pick(ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2))));
      merchantRoom.kind = 'merchant';
    } else {
      merchantRoom = startRoom;
    }
  }

  // Detour ranking (§17.14): how far off the entrance->exit route a room is. detour = dE(room) + dX(room) - dE(exit)
  // for the exit that minimizes it — 0 for a room ON a shortest route to some exit, growing with the side trip needed
  // to visit it. Treasure wings are leaves (one door each), so attaching them can't change any of these numbers.
  // (Re-run from the entrance now that the exit cubbies exist: the first field was taken while they were still rock.)
  const entField = bfsFrom(entrance.x, entrance.y);
  const exitFields = exits.map(ex => ({ d: bfsFrom(ex.x, ex.y), base: entField[idx(ex.x, ex.y)] }));
  const entranceDist = new Map(), detour = new Map();
  for (const r of rooms) {
    const ci = idx(r.cx, r.cy);
    const dE = Math.max(0, entField[ci]);
    let best = Infinity;
    for (const f of exitFields) if (f.d[ci] >= 0 && f.base >= 0) best = Math.min(best, dE + f.d[ci] - f.base);
    entranceDist.set(r.id, dE);
    detour.set(r.id, best === Infinity ? 0 : best);
  }

  // Re-seats the whole map in a new nw x nh grid whose (0,0) is the old (ox,oy) — a crop (ox,oy >= 0) or a pad
  // (negative) — shifting rooms (box, centre, doors, secret door, cell/core indices), stairs and secrets to match.
  function reframe(ox, oy, nw, nh) {
    const nt = new Uint8Array(nw * nh).fill(TILE.WALL);
    const nr = new Int32Array(nw * nh).fill(-1);
    const nres = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const sx = x + ox, sy = y + oy;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const oi = sy * width + sx;
      nt[y * nw + x] = tiles[oi]; nr[y * nw + x] = roomIdGrid[oi]; nres[y * nw + x] = reserved[oi];
    }
    const remap = (i) => ((((i / width) | 0) - oy) * nw + ((i % width) - ox));
    for (const r of rooms) {
      r.x -= ox; r.y -= oy; r.cx -= ox; r.cy -= oy;
      for (const d of r.doors) { d.x -= ox; d.y -= oy; }
      if (r.secretDoor) { r.secretDoor.x -= ox; r.secretDoor.y -= oy; }
      r._cells = r._cells.map(remap);
      r._core = r._core.map(remap);
    }
    const shift = (p) => { p.x -= ox; p.y -= oy; if (p.front) { p.front.x -= ox; p.front.y -= oy; } };
    shift(entrance);
    for (const ex of exits) shift(ex);
    for (const sc of secrets) shift(sc);
    tiles = nt; roomIdGrid = nr; reserved = nres; width = nw; height = nh;
  }
  const secrets = []; // filled by step 6; declared here so reframe() can shift them

  // ---------- 5. Treasure wings (§17.14): purpose-built single-door leaves, Vault first, then Hoards, then Caches ----------
  // Parents: any base room except the start, boss and merchant rooms (exit rooms are fine: a leaf can't block a stair).
  const parentPool = rooms.filter(r => r.kind === 'normal' || r.kind === 'exit');
  const byDetour = parentPool.slice().sort((a, b) => detour.get(b.id) - detour.get(a.id));
  const offHalf = byDetour.slice(0, Math.ceil(byDetour.length / 2));
  const offThird = byDetour.slice(0, Math.ceil(byDetour.length / 3));
  const dEs = parentPool.map(r => entranceDist.get(r.id)).sort((a, b) => a - b);
  const medianDE = dEs.length ? dEs[(dEs.length - 1) >> 1] : 0;
  const vaultStrict = offThird.filter(r => entranceDist.get(r.id) >= medianDE);
  // Route rule per tier, then progressively looser pools if nothing in the strict one can take a leaf.
  const ROUTE_POOLS = {
    vault: [vaultStrict, offThird, offHalf, parentPool],
    hoard: [offHalf, parentPool],
    cache: [parentPool],
  };
  const usedParents = new Set();
  const PER_PARENT_TRIES = 6;
  const MAX_WING_TRIES = 90;

  // Snapshot / restore of the whole carve state (an antechamber whose Vault then can't be placed is rolled back).
  function snapshot() {
    return {
      tiles: tiles.slice(), rid: roomIdGrid.slice(), res: reserved.slice(), n: rooms.length,
      doors: rooms.map(r => r.doors.length), links: [...links], lc: [...linkCount],
    };
  }
  function restore(s) {
    tiles = s.tiles; roomIdGrid = s.rid; reserved = s.res;
    rooms.length = s.n;
    rooms.forEach((r, i) => { r.doors.length = s.doors[i]; });
    links.clear(); for (const k of s.links) links.add(k);
    linkCount.clear(); for (const [k, v] of s.lc) linkCount.set(k, v);
  }

  // Parents in the order to try them: unused before already-used, under their link cap before over it; shuffled.
  function orderParents(pool) {
    const shuffled = rng.shuffle(pool.slice());
    const rank = (r) => (usedParents.has(r.id) ? 2 : 0) + (linkCount.get(r.id) < linkCap(r) ? 0 : 1);
    return shuffled.sort((a, b) => rank(a) - rank(b));
  }
  // Attach a `cat` leaf to some room of the tier's pools; returns { room, parent } or null.
  function attachLeaf(tier, cat, budget = MAX_WING_TRIES) {
    let tries = 0;
    const seen = new Set();
    for (const pool of ROUTE_POOLS[tier]) {
      for (const parent of orderParents(pool)) {
        if (seen.has(parent.id)) continue;
        seen.add(parent.id);
        for (let t = 0; t < PER_PARENT_TRIES; t++) {
          if (++tries > budget) return null;
          const room = tryAttach(parent, cat, pickGap());
          if (room) return { room, parent };
        }
      }
    }
    return null;
  }
  const tagWing = (room, tier, parent) => {
    room.kind = 'treasure';
    room.treasureTier = tier;
    usedParents.add(parent.id);
  };

  const treasureTiers = rollTreasureTiers(depth, rng);
  // Wings attach at the edge of the layout, and the growth canvas is nearly full (esp. early depths), so give them
  // a margin to grow into; the final crop (step 7) trims whatever stays unused. Never past WING_CANVAS_MAX.
  if (treasureTiers.length) {
    const pad = Math.max(0, Math.min(WING_CANVAS_PAD, (WING_CANVAS_MAX - Math.max(width, height)) >> 1));
    if (pad > 0) reframe(-pad, -pad, width + 2 * pad, height + 2 * pad);
  }
  let antechamberRolled = false;
  for (const tier of treasureTiers) {
    if (tier === 'vault' && depth >= ANTECHAMBER_MIN_DEPTH && rng.chance(ANTECHAMBER_CHANCE)) {
      antechamberRolled = true;
      // Vault antechamber: a medium guard room as a leaf of the parent, the Vault a leaf of the antechamber (two doors,
      // still off every start-to-exit path). A failed Vault rolls the antechamber back; then a plain Vault is tried.
      let placed = false;
      for (let a = 0; a < 4 && !placed; a++) {
        const snap = snapshot();
        const ante = attachLeaf('vault', 'medium', 40);
        if (!ante) break;
        let vault = null;
        for (let t = 0; t < 24 && !vault; t++) vault = tryAttach(ante.room, 'large', pickGap());
        if (!vault) { restore(snap); continue; }
        tagWing(ante.room, 'vault', ante.parent);
        ante.room.antechamber = true;
        tagWing(vault, 'vault', ante.room);
        vault.antechamberId = ante.room.id;
        placed = true;
      }
      if (placed) continue;
    }
    const got = attachLeaf(tier, TREASURE_ROOM_SIZE[tier]);
    if (got) tagWing(got.room, tier, got.parent);
  }

  // ---------- 6. Hidden-room modifier (§17.11): one Cache or Hoard's doorway becomes a secret wall ----------
  // Only a genuine dead end (one opening, its door) is sealed, so hiding it can never cut off any other floor.
  if (depth >= HIDDEN_ROOM_MIN_DEPTH && rng.chance(HIDDEN_ROOM_CHANCE)) {
    const eligible = rooms.filter(r => r.kind === 'treasure' && (r.treasureTier === 'cache' || r.treasureTier === 'hoard')
      && isDeadEndRoom(r));
    if (eligible.length) {
      const room = rng.pick(eligible);
      const d = room.doors[0];
      tiles[idx(d.x, d.y)] = TILE.WALL;
      room.hidden = true;
      room.secretDoor = { x: d.x, y: d.y };
      secrets.push({ x: d.x, y: d.y, roomId: room.id, revealed: false });
    }
  }

  // ---------- 7. Crop to the used area (keeps a 1-tile WALL border) — last, so every step above saw real distances ----------
  {
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (tiles[idx(x, y)] === TILE.WALL) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // a secret doorway is a WALL tile until revealed, but still has to be inside the map
    for (const sc of secrets) { x0 = Math.min(x0, sc.x); y0 = Math.min(y0, sc.y); x1 = Math.max(x1, sc.x); y1 = Math.max(y1, sc.y); }
    const ox = x0 - 1, oy = y0 - 1;
    const nw = x1 - x0 + 3, nh = y1 - y0 + 3;
    if (ox !== 0 || oy !== 0 || nw !== width || nh !== height) reframe(ox, oy, nw, nh);
  }

  // ---------- 8. Chest spots in each treasure room (not the antechamber) ----------
  // Toward the back of the room (far from its doorway), >= 2 tiles apart, never next to the doorway, each with open
  // floor on >= 3 sides (loot lands there), and never splitting the room: all its other floor stays reachable from
  // the doorway with every chest in place (a chest is a solid NPC).
  for (const room of rooms) {
    if (room.kind !== 'treasure' || room.antechamber) continue;
    const want = rollChestCount(room.treasureTier, rng);
    const door = room.doors[0];
    const cellSet = new Set(room._cells);
    const blocked = new Set();
    const isOpen = (i) => cellSet.has(i) && !blocked.has(i);
    const openAround = (i) => DIR4.filter(([dx, dy]) => isOpen(i + dx + dy * width)).length;
    // the room tile just inside the doorway
    let entry = -1;
    for (const [dx, dy] of DIR4) { const i = idx(door.x + dx, door.y + dy); if (cellSet.has(i)) { entry = i; break; } }
    const connectedWithout = () => {
      if (entry < 0 || blocked.has(entry)) return false;
      const seen = new Set([entry]), q = [entry];
      for (let qi = 0; qi < q.length; qi++) {
        for (const [dx, dy] of DIR4) {
          const ni = q[qi] + dx + dy * width;
          if (isOpen(ni) && !seen.has(ni)) { seen.add(ni); q.push(ni); }
        }
      }
      return seen.size === room._cells.length - blocked.size;
    };
    const ranked = room._cells.map(i => ({ i, d: Math.hypot(i % width - door.x, ((i / width) | 0) - door.y) + rng.next() * 0.5 }))
      .sort((a, b) => b.d - a.d);
    room.chests = [];
    for (const { i } of ranked) {
      if (room.chests.length >= want) break;
      const x = i % width, y = (i / width) | 0;
      if (Math.max(Math.abs(x - door.x), Math.abs(y - door.y)) <= 1) continue;
      if (room.chests.some(c => Math.max(Math.abs(c.x - x), Math.abs(c.y - y)) < 2)) continue;
      if (openAround(i) < 3) continue;
      blocked.add(i);
      if (!connectedWithout() || [...blocked].some(b => openAround(b) < 1)) { blocked.delete(i); continue; }
      room.chests.push({ x, y });
    }
  }

  // ---------- 9. Spawn candidate caches ----------
  // Treasure wings (every tier, incl. antechambers) get no general spawn candidates: their guards are placed by
  // enemies.js from the tier table (§17.14), and a hidden room holds nothing at all (§17.11). Nor does the boss arena:
  // only the boss and its guards wait there (§17.15).
  const treasureRoomIds = new Set(rooms.filter(r => r.kind === 'treasure' || r.kind === 'boss').map(r => r.id));
  const merchantRoomId = merchantRoom ? merchantRoom.id : -2;
  const roomFloors = [];
  const corridorFloors = [];
  let populatedFloor = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = idx(x, y);
      if (tiles[i] !== TILE.FLOOR) continue;
      const rid = roomIdGrid[i];
      if (treasureRoomIds.has(rid) || rid === merchantRoomId) continue;
      populatedFloor++;
      if (rid === -1) corridorFloors.push({ x, y, roomId: null });
      else if (rid !== startRoom.id) roomFloors.push({ x, y, roomId: rid });
    }
  }

  // ---------- 10. Map object ----------
  const visible = new Uint8Array(width * height);
  const explored = new Uint8Array(width * height);
  const finalRoomIdGrid = roomIdGrid;

  const map = {
    width, height, tiles, visible, explored, rooms, entrance, exits,
    archetype, // this depth's generation profile (§17.13); a data hook only — nothing renders differently yet
    // Floor tiles open to general spawning (§17.16): every FLOOR tile outside the treasure wings, the merchant's room
    // and the boss arena.
    populatedFloor,
    // The room shop.js puts the merchant in (opts.merchant), or null: kind 'merchant', or the start room as fallback.
    merchantRoomId: merchantRoom ? merchantRoom.id : null,
    baseRoomCount, // rooms from the growth pass; rooms[baseRoomCount..] are treasure wings
    // What the treasure roll asked for (§17.14), so placement failures are measurable (§17.17 Layer 1):
    // tiers rolled (Vault/Hoards/Caches order) and whether the Vault rolled an antechamber.
    treasureRolled: { tiers: treasureTiers, antechamber: antechamberRolled },
    // Hidden treasure-room doorways (§17.11): WALL tiles until revealed. [{ x, y, roomId, revealed }]
    secrets,
    idx(x, y) { return y * width + x; },
    inBounds(x, y) { return x >= 0 && y >= 0 && x < width && y < height; },
    get(x, y) { return this.inBounds(x, y) ? tiles[this.idx(x, y)] : TILE.WALL; },
    isWalkable(x, y) { return this.inBounds(x, y) && tiles[this.idx(x, y)] !== TILE.WALL; },
    isOpaque(x, y) { return !this.inBounds(x, y) || tiles[this.idx(x, y)] === TILE.WALL; },
    // Floor tiles of one room (its own floor, not its doorways): [{x, y}].
    roomTiles(roomId) {
      const out = [];
      for (let i = 0; i < finalRoomIdGrid.length; i++) {
        if (finalRoomIdGrid[i] === roomId && tiles[i] === TILE.FLOOR) out.push({ x: i % width, y: (i / width) | 0 });
      }
      return out;
    },
    // The room whose floor (x,y) is, or null.
    roomAt(x, y) {
      if (!this.inBounds(x, y)) return null;
      const id = finalRoomIdGrid[this.idx(x, y)];
      return id >= 0 ? rooms[id] : null;
    },
    // 75% room tiles / 25% corridor tiles, spread per room in proportion to room area (§17.16): each room's tiles are
    // shuffled and its k-th of n tiles keyed (k+u)/n (u random per room), so sorting by key interleaves the rooms —
    // ANY prefix of the result (spawnEnemies consumes it front to back) takes ~the same share of every room's floor,
    // instead of a plain shuffle's chance clumps. Room and corridor picks are interleaved the same way.
    spawnCandidates(sRng, count, minDistFromEntrance) {
      const minD2 = minDistFromEntrance * minDistFromEntrance;
      const far = (p) => (p.x - entrance.x) ** 2 + (p.y - entrance.y) ** 2 >= minD2;
      const farCorr = corridorFloors.filter(far);
      const byRoom = new Map();
      for (const p of roomFloors) {
        if (!far(p)) continue;
        let a = byRoom.get(p.roomId);
        if (!a) byRoom.set(p.roomId, (a = []));
        a.push(p);
      }
      const spread = (groups) => {
        const keyed = [];
        for (const g of groups) {
          const u = sRng.next();
          for (let k = 0; k < g.length; k++) keyed.push({ p: g[k], key: (k + u) / g.length });
        }
        return keyed.sort((a, b) => a.key - b.key).map(e => e.p);
      };
      const farRoom = spread([...byRoom.values()].map(a => sRng.shuffle(a)));
      sRng.shuffle(farCorr);
      const wantRoom = Math.round(count * 0.75);
      const roomPick = farRoom.slice(0, wantRoom), corrPick = farCorr.slice(0, count - wantRoom);
      const chosen = spread([roomPick, corrPick].filter(a => a.length));
      if (chosen.length < count) {
        const extra = farRoom.slice(wantRoom).concat(farCorr.slice(count - wantRoom));
        sRng.shuffle(extra);
        for (const p of extra) { if (chosen.length >= count) break; chosen.push(p); }
      }
      return chosen.slice(0, count).map(p => ({ x: p.x, y: p.y, roomId: p.roomId }));
    },
    hasLineOfSight(x0, y0, x1, y1) { return computeLineOfSight(this, x0, y0, x1, y1); },
    // The unrevealed secret doorway at (x,y), or null.
    secretAt(x, y) { return secrets.find(sc => !sc.revealed && sc.x === x && sc.y === y) || null; },
    // Opens a secret doorway: WALL -> DOOR. Returns the secret, or null if there is none (or it's already open).
    revealSecret(x, y) {
      const sc = this.secretAt(x, y);
      if (!sc) return null;
      sc.revealed = true;
      tiles[this.idx(x, y)] = TILE.DOOR;
      return sc;
    },
  };

  return map;
}

function computeLineOfSight(map, x0, y0, x1, y1) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (!(x === x1 && y === y1)) {
    const e2 = 2 * err;
    let stepX = false, stepY = false;
    if (e2 > -dy) { err -= dy; x += sx; stepX = true; }
    if (e2 < dx) { err += dx; y += sy; stepY = true; }
    if (x === x1 && y === y1) break;
    if (stepX && stepY) {
      // moving through a lattice corner: block if both flanking cells are opaque
      if (map.isOpaque(x - sx, y) && map.isOpaque(x, y - sy)) return false;
    }
    if (map.isOpaque(x, y)) return false;
  }
  return true;
}

// ---------- FOV: recursive shadowcasting (8 octants), symmetric & fast ----------
const OCT_MULT = [
  [1, 0, 0, -1, -1, 0, 0, 1],
  [0, 1, -1, 0, 0, -1, 1, 0],
  [0, 1, 1, 0, 0, -1, -1, 0],
  [1, 0, 0, 1, -1, 0, 0, -1],
];

export function computeFOV(map, px, py, radius) {
  map.visible.fill(0);
  if (!map.inBounds(px, py)) return;
  const r2 = radius * radius;
  const mark = (x, y) => {
    if (!map.inBounds(x, y)) return;
    const i = map.idx(x, y);
    map.visible[i] = 1;
    map.explored[i] = 1;
  };
  mark(px, py);
  for (let oct = 0; oct < 8; oct++) {
    castLight(map, px, py, 1, 1.0, 0.0, radius, r2,
      OCT_MULT[0][oct], OCT_MULT[1][oct], OCT_MULT[2][oct], OCT_MULT[3][oct], mark);
  }

  // Shadowcasting's slope math can occasionally leave a wall un-lit even though it is
  // directly adjacent to a lit floor tile (a known edge case at slope boundaries). Do an
  // explicit pass so every wall bounding visible floor renders lit, as required.
  const x0 = Math.max(0, px - radius), x1 = Math.min(map.width - 1, px + radius);
  const y0 = Math.max(0, py - radius), y1 = Math.min(map.height - 1, py + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = map.idx(x, y);
      if (!map.visible[i] || map.isOpaque(x, y)) continue;
      if (map.isOpaque(x + 1, y)) mark(x + 1, y);
      if (map.isOpaque(x - 1, y)) mark(x - 1, y);
      if (map.isOpaque(x, y + 1)) mark(x, y + 1);
      if (map.isOpaque(x, y - 1)) mark(x, y - 1);
    }
  }
}

function castLight(map, cx, cy, row, start, end, radius, r2, xx, xy, yx, yy, mark) {
  if (start < end) return;
  let newStart = 0;
  for (let distance = row; distance <= radius; distance++) {
    const dy = -distance;
    let blocked = false;
    for (let dx = -distance; dx <= 0; dx++) {
      const mapX = cx + dx * xx + dy * xy;
      const mapY = cy + dx * yx + dy * yy;
      const lSlope = (dx - 0.5) / (dy + 0.5);
      const rSlope = (dx + 0.5) / (dy - 0.5);
      if (start < rSlope) continue;
      if (end > lSlope) break;
      if (dx * dx + dy * dy <= r2) mark(mapX, mapY);
      const opaque = map.isOpaque(mapX, mapY);
      if (blocked) {
        if (opaque) { newStart = rSlope; continue; }
        blocked = false; start = newStart;
      } else if (opaque && distance < radius) {
        blocked = true;
        castLight(map, cx, cy, distance + 1, start, lSlope, radius, r2, xx, xy, yx, yy, mark);
        newStart = rSlope;
      }
    }
    if (blocked) break;
  }
}
