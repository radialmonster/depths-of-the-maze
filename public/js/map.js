// Dungeon generation + FOV. Owned by the Map agent. Public API is fixed by DESIGN.md §7:
//   generateDungeon(depth, rng) -> map
//   computeFOV(map, x, y, radius)
//
// Generation algorithm ("large rooms linked together", deterministic given rng):
//  1. Room shapes. Each room is a floor mask inside its bounding box: plain rectangles,
//     pillared halls (isolated single WALL tiles >= 2 tiles from the edge, never blocking),
//     L-shapes (rectangle minus a corner), two overlapping rectangles, and rounded caves.
//     Size mix leans medium/large (8x8 .. 18x14) with a few small rooms (5x5 .. 7x7).
//  2. Growth placement = spanning tree. The first room goes near the map centre; each new
//     room is attached to a random existing room on one side, either sharing a wall
//     (gap 1 -> a single doorway in the common wall) or 3-7 tiles away (short straight
//     corridor). A room is kept only if every floor tile has a full wall ring (no two
//     spaces ever merge) and the link to its parent can be carved. The attachment links
//     form the spanning tree, so every room is reachable by construction.
//  3. Corridors are validated before carving: straight or L-shaped, 1 wide (some straight
//     ones widen to 2 between 1-wide doorways), and they may touch nothing but the two
//     rooms they join (and never run parallel to another corridor one wall apart).
//     Both ends are TILE.DOOR tiles in the room walls.
//  4. Loops + exit counts: a few extra links between nearby rooms create loops, then rooms
//     are topped up toward 2-4 links (large) / 1-3 links (medium) with nearby rooms
//     (caps: 4 large / 3 medium / 2 small). No corridor ever dead-ends.
//  5. A BFS safety net force-carves a corridor to any stray component (a no-op in practice),
//     then the map is cropped to the used area plus a 1-tile WALL border.
//  6. Start room (entrance) is chosen, BFS distances computed, then 1-3 exit rooms are chosen
//     from the farthest third of rooms. Each stair tile is a one-tile cubby cut into the
//     room's wall (findNiche), preferring the camera-facing north wall; every 5th depth tags the largest far room 'boss';
//     a dead-end room (one doorway) may be tagged 'treasure', and from depth 2 hidden behind a
//     secret doorway (map.secrets / revealSecret, §17.11).

import { TILE } from './core.js';

const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const LINK_CAP = { small: 2, medium: 3, large: 4 }; // max rooms linked to one room
const DIR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Treasure rooms (§17.11): a dead-end room, 50% of depths; from depth 2 on, some depths get a HIDDEN treasure room
// instead (secret doorway + chest). The hidden roll comes first. ~1 in 4 layouts has no eligible dead-end room at
// all, so the roll is 45% to land the design target of a hidden room on ~35% of depths (measured: ~34% over 1000
// layouts at depths 2-26).
export const TREASURE_ROOM_CHANCE = 0.5;
export const HIDDEN_ROOM_CHANCE = 0.45;
export const HIDDEN_ROOM_MIN_DEPTH = 2;

function computeMapSize(depth) {
  let s = 54 + Math.round((depth - 1) * 2.5);
  if (s > 86) s = 86;
  return s;
}

function targetRoomCount(depth) {
  return Math.min(16, 10 + Math.floor((depth - 1) * 0.6));
}

// ---------- Room shapes ----------
// A shape is { w, h, mask: Uint8Array(w*h) (1 = floor), pillars: [[lx,ly]], type }.
function normalizeShape(w, h, mask, pillars, type) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  const nm = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) nm[y * nw + x] = mask[(y + y0) * w + (x + x0)];
  return { w: nw, h: nh, mask: nm, pillars: pillars.map(([px, py]) => [px - x0, py - y0]), type };
}

function makeShape(rng, cat) {
  let w, h;
  if (cat === 'small') { w = rng.int(5, 7); h = rng.int(5, 7); }
  else if (cat === 'medium') { w = rng.int(8, 11); h = rng.int(8, 10); }
  else { w = rng.int(12, 18); h = rng.int(10, 14); }

  let type = 'rect';
  if (cat === 'medium') type = rng.weighted(['rect', 'L', 'overlap', 'cave'], t => ({ rect: 50, L: 20, overlap: 18, cave: 12 }[t]));
  else if (cat === 'large') type = rng.weighted(['rect', 'pillars', 'L', 'overlap', 'cave'], t => ({ rect: 22, pillars: 28, L: 16, overlap: 18, cave: 16 }[t]));

  const mask = new Uint8Array(w * h);
  const pillars = [];
  const fillRect = (rx, ry, rw, rh) => {
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) mask[y * w + x] = 1;
  };

  if (type === 'L') {
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
  return normalizeShape(w, h, mask, pillars, type);
}

export function generateDungeon(depth, rng) {
  let width = computeMapSize(depth);
  let height = width;
  const idx = (x, y) => y * width + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
  const interior = (x, y) => x >= 1 && y >= 1 && x <= width - 2 && y <= height - 2;

  let tiles = new Uint8Array(width * height).fill(TILE.WALL);
  let roomIdGrid = new Int32Array(width * height).fill(-1); // per-cell room id (room floor only)
  const rooms = [];
  const links = new Set(); // "a|b" with a<b
  const linkKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const linkCount = new Map();

  // ---------- 1+2. Room placement ----------
  function canPlace(shape, ox, oy) {
    if (ox < 1 || oy < 1 || ox + shape.w > width - 1 || oy + shape.h > height - 1) return false;
    const { w, h, mask } = shape;
    for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
      if (!mask[ly * w + lx]) continue;
      const x = ox + lx, y = oy + ly;
      if (tiles[idx(x, y)] !== TILE.WALL) return false;
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
    const room = { id, x: ox, y: oy, w, h, cx, cy, size: cat, doors: [], kind: 'normal' };
    Object.defineProperty(room, '_cells', { value: cells, enumerable: false, writable: true });
    rooms.push(room);
    linkCount.set(id, 0);
    return room;
  }

  function unplaceRoom(room) {
    for (const i of room._cells) { tiles[i] = TILE.WALL; roomIdGrid[i] = -1; }
    rooms.pop();
    linkCount.delete(room.id);
  }

  // Door slots: wall tiles directly outside a straight stretch of the room's edge.
  function doorSlots(room) {
    const out = [];
    const id = room.id;
    for (const i of room._cells) {
      const x = i % width, y = (i / width) | 0;
      for (const [dx, dy] of DIR4) {
        const sx = x + dx, sy = y + dy;
        if (!interior(sx, sy) || roomIdGrid[idx(sx, sy)] === id) continue;
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
      if (!interior(x, y) || tiles[i] !== TILE.WALL) return false;
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
    if (straightPerp && cells.length >= 4 && rng.chance(0.3)) {
      const body = cells.slice(1, -1);
      const sides = rng.chance(0.5) ? [1, -1] : [-1, 1];
      for (const s of sides) {
        const off = idx(straightPerp.px * s, straightPerp.py * s) - idx(0, 0);
        const lane = body.map(i => i + off);
        const set = new Set(cells.concat(lane));
        let ok = true;
        for (const i of lane) {
          const x = i % width, y = (i / width) | 0;
          if (!interior(x, y) || tiles[i] !== TILE.WALL) { ok = false; break; }
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
    return rng.weighted(['small', 'medium', 'large'], c => ({ small: 18, medium: 44, large: 38 }[c]));
  }

  const target = targetRoomCount(depth);
  {
    // first room near the centre
    for (let t = 0; t < 40 && rooms.length === 0; t++) {
      const shape = makeShape(rng, t < 20 ? 'large' : 'medium');
      const ox = Math.floor(width / 2 - shape.w / 2) + rng.int(-6, 6);
      const oy = Math.floor(height / 2 - shape.h / 2) + rng.int(-6, 6);
      if (canPlace(shape, ox, oy)) placeRoom(shape, ox, oy, t < 20 ? 'large' : 'medium');
    }
    let attempts = 0;
    const maxAttempts = target * 50;
    while (rooms.length < target && attempts < maxAttempts) {
      attempts++;
      // prefer parents with few links so the tree spreads out rather than forming one chain
      const open = rooms.filter(r => linkCount.get(r.id) < LINK_CAP[r.size]);
      if (!open.length) break;
      const parent = rng.weighted(open, r => 1 / (1 + linkCount.get(r.id)));
      const cat = pickCategory();
      const shape = makeShape(rng, cat);
      const [dx, dy] = rng.pick(DIR4);
      const gap = rng.chance(0.3) ? 1 : rng.int(3, 7);
      let ox, oy;
      if (dx !== 0) {
        ox = dx > 0 ? parent.x + parent.w + gap : parent.x - gap - shape.w;
        oy = rng.int(parent.y - shape.h + 3, parent.y + parent.h - 3);
      } else {
        oy = dy > 0 ? parent.y + parent.h + gap : parent.y - gap - shape.h;
        ox = rng.int(parent.x - shape.w + 3, parent.x + parent.w - 3);
      }
      if (!canPlace(shape, ox, oy)) continue;
      const room = placeRoom(shape, ox, oy, cat);
      if (!connect(parent, room, gap + 6, false) && !connect(parent, room, gap + 8, true)) unplaceRoom(room);
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

    let loops = Math.max(2, Math.round(rooms.length * 0.25));
    for (const p of pairs) {
      if (loops <= 0) break;
      if (links.has(linkKey(p.a.id, p.b.id))) continue;
      if (linkCount.get(p.a.id) >= LINK_CAP[p.a.size] || linkCount.get(p.b.id) >= LINK_CAP[p.b.size]) continue;
      if (connect(p.a, p.b, 12, true)) loops--;
    }

    const want = new Map();
    for (const r of rooms) {
      let t;
      if (r.size === 'large') t = rng.int(2, 4);
      else if (r.size === 'medium') t = rng.int(1, 3);
      else t = rng.chance(0.2) ? 2 : 1;
      want.set(r.id, t);
    }
    for (const p of pairs) {
      const need = (r) => linkCount.get(r.id) < want.get(r.id);
      if (!need(p.a) && !need(p.b)) continue;
      // do not push the other room far beyond its own cap (large rooms cap at 4)
      const cap = (r) => linkCount.get(r.id) < LINK_CAP[r.size];
      if (!cap(p.a) || !cap(p.b)) continue;
      if (links.has(linkKey(p.a.id, p.b.id))) continue;
      connect(p.a, p.b, 12, true);
    }
    // large rooms still stuck at one link: allow a somewhat longer connector
    for (const r of rooms) {
      if (r.size !== 'large' || linkCount.get(r.id) >= 2) continue;
      const others = rooms.filter(o => o !== r && !links.has(linkKey(r.id, o.id)) && linkCount.get(o.id) < LINK_CAP[o.size])
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

  // ---------- Crop to the used area (keeps a 1-tile WALL border) ----------
  {
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (tiles[idx(x, y)] === TILE.WALL) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const ox = x0 - 1, oy = y0 - 1;
    const nw = x1 - x0 + 3, nh = y1 - y0 + 3;
    if (ox > 0 || oy > 0 || nw < width || nh < height) {
      const nt = new Uint8Array(nw * nh).fill(TILE.WALL);
      const nr = new Int32Array(nw * nh).fill(-1);
      for (let y = 1; y < nh - 1; y++) for (let x = 1; x < nw - 1; x++) {
        const oi = (y + oy) * width + (x + ox);
        nt[y * nw + x] = tiles[oi]; nr[y * nw + x] = roomIdGrid[oi];
      }
      tiles = nt; roomIdGrid = nr; width = nw; height = nh;
      for (const r of rooms) {
        r.x -= ox; r.y -= oy; r.cx -= ox; r.cy -= oy;
        for (const d of r.doors) { d.x -= ox; d.y -= oy; }
      }
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
          if (!interior(nx, ny) || tiles[idx(nx, ny)] !== TILE.WALL) continue;
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
  // single doorway. Uses the post-crop roomIdGrid (room._cells indices are pre-crop), so it also catches any opening
  // the BFS safety net carved without registering a door.
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

  // ---------- 6. Start room / entrance ----------
  const startCandidates = rooms.filter(r => r.size !== 'large');
  const startRoom = rng.pick(startCandidates.length ? startCandidates : rooms);
  startRoom.kind = 'start';
  const entrance = findNiche(startRoom);
  tiles[idx(entrance.x, entrance.y)] = TILE.ENTRANCE;

  // ---------- 7. BFS distances from entrance ----------
  const bfsDist = new Int32Array(width * height).fill(-1);
  {
    const startIdx = idx(entrance.x, entrance.y);
    bfsDist[startIdx] = 0;
    const queue = [startIdx]; let qi = 0;
    while (qi < queue.length) {
      const ci = queue[qi++]; const cx = ci % width, cy = (ci / width) | 0;
      for (const [dx, dy] of DIR4) {
        const nx = cx + dx, ny = cy + dy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (tiles[ni] !== TILE.WALL && bfsDist[ni] === -1) { bfsDist[ni] = bfsDist[ci] + 1; queue.push(ni); }
      }
    }
  }

  // ---------- 8. Exits ----------
  const otherRooms = rooms.filter(r => r !== startRoom);
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

  // ---------- 9. Boss / treasure tags ----------
  if (depth % 5 === 0) {
    let pool = topThird.filter(r => r.kind === 'normal');
    if (!pool.length) pool = otherRooms.filter(r => r.kind === 'normal');
    if (pool.length) {
      let best = pool[0];
      for (const r of pool) if (r.w * r.h > best.w * best.h) best = r;
      best.kind = 'boss';
    }
  }
  // Treasure room (§17.11): always a dead end — a still-'normal' room (so never start/exit/boss; the merchant only
  // ever picks 'normal' rooms, so never the merchant's either) whose ONLY opening is a single doorway — so hiding
  // that doorway can never cut off any other floor. From HIDDEN_ROOM_MIN_DEPTH, HIDDEN_ROOM_CHANCE of depths hide it:
  // its doorway becomes a WALL tile listed in map.secrets until the player finds it (main.js -> revealSecret).
  const secrets = [];
  {
    const deadEnds = rooms.filter(r => r.kind === 'normal' && isDeadEndRoom(r));
    const hide = depth >= HIDDEN_ROOM_MIN_DEPTH && rng.chance(HIDDEN_ROOM_CHANCE);
    if (deadEnds.length && (hide || rng.chance(TREASURE_ROOM_CHANCE))) {
      const small = deadEnds.filter(r => r.size === 'small');
      const room = rng.pick(small.length ? small : deadEnds);
      room.kind = 'treasure';
      if (hide) {
        const d = room.doors[0];
        tiles[idx(d.x, d.y)] = TILE.WALL;
        room.hidden = true;
        room.secretDoor = { x: d.x, y: d.y };
        secrets.push({ x: d.x, y: d.y, roomId: room.id, revealed: false });
      }
    }
  }

  for (const r of otherRooms) delete r._dist;

  // ---------- 10. Spawn candidate caches ----------
  // Hidden treasure rooms get no enemy/loot spawn candidates: nothing should be sealed in there (§17.11).
  const hiddenRoomIds = new Set(secrets.map(sc => sc.roomId));
  const roomFloors = [];
  const corridorFloors = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = idx(x, y);
      if (tiles[i] !== TILE.FLOOR) continue;
      const rid = roomIdGrid[i];
      if (rid === -1) corridorFloors.push({ x, y, roomId: null });
      else if (rid !== startRoom.id && !hiddenRoomIds.has(rid)) roomFloors.push({ x, y, roomId: rid });
    }
  }

  // ---------- 11. Map object ----------
  const visible = new Uint8Array(width * height);
  const explored = new Uint8Array(width * height);

  const map = {
    width, height, tiles, visible, explored, rooms, entrance, exits,
    // Hidden treasure-room doorways (§17.11): WALL tiles until revealed. [{ x, y, roomId, revealed }]
    secrets,
    idx(x, y) { return y * width + x; },
    inBounds(x, y) { return x >= 0 && y >= 0 && x < width && y < height; },
    get(x, y) { return this.inBounds(x, y) ? tiles[this.idx(x, y)] : TILE.WALL; },
    isWalkable(x, y) { return this.inBounds(x, y) && tiles[this.idx(x, y)] !== TILE.WALL; },
    isOpaque(x, y) { return !this.inBounds(x, y) || tiles[this.idx(x, y)] === TILE.WALL; },
    spawnCandidates(sRng, count, minDistFromEntrance) {
      const minD2 = minDistFromEntrance * minDistFromEntrance;
      const farRoom = roomFloors.filter(p => (p.x - entrance.x) ** 2 + (p.y - entrance.y) ** 2 >= minD2);
      const farCorr = corridorFloors.filter(p => (p.x - entrance.x) ** 2 + (p.y - entrance.y) ** 2 >= minD2);
      sRng.shuffle(farRoom); sRng.shuffle(farCorr);
      const wantRoom = Math.round(count * 0.75);
      const chosen = farRoom.slice(0, wantRoom).concat(farCorr.slice(0, count - wantRoom));
      if (chosen.length < count) {
        const extra = farRoom.slice(wantRoom).concat(farCorr.slice(count - wantRoom));
        sRng.shuffle(extra);
        for (const p of extra) { if (chosen.length >= count) break; chosen.push(p); }
      }
      sRng.shuffle(chosen);
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
