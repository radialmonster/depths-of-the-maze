// Plain-Node unit tests for map generation variety (DESIGN §17.13): floor archetypes (never repeating back-to-back),
// the new room shapes, the ring hall's core never offered as a doorway, cluster mode, the grand seed room, the raised
// room-count curve, and room.shape. Boss arenas (§17.15): bossForDepth, per-boss arena shapes, minimum size + clear
// core, the arena as the seed room, its doorways, and population.
//   node test/map.test.js      (or: npm test)
import assert from 'node:assert/strict';
import { RNG, TILE, bossForDepth, isBossDepth } from '../public/js/core.js';
import {
  generateDungeon, makeShape, shapeDoorSlots, pickArchetype, targetRoomCount, ARCHETYPES, ARCHETYPE_IDS, SHAPES_BY_SIZE,
  BOSS_ARENAS, GENERIC_ARENA, ARENA_MIN, ARENA_SHAPES, makeArenaShape, arenaStats, arenaMeetsMinimum,
} from '../public/js/map.js';
import { spawnEnemies } from '../public/js/enemies.js';

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.stack}`); }
}

const GROWTH_SHAPES = [...new Set(Object.values(SHAPES_BY_SIZE).flat())];
const ALL_SHAPES = [...GROWTH_SHAPES, ...ARENA_SHAPES];
const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Floor tiles of a lone shape, 4-connected from the first one.
function shapeConnected(s) {
  const floor = [];
  for (let i = 0; i < s.w * s.h; i++) if (s.mask[i]) floor.push(i);
  const seen = new Set([floor[0]]), q = [floor[0]];
  for (let qi = 0; qi < q.length; qi++) {
    const x = q[qi] % s.w, y = (q[qi] / s.w) | 0;
    for (const [dx, dy] of DIR4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
      const ni = ny * s.w + nx;
      if (s.mask[ni] && !seen.has(ni)) { seen.add(ni); q.push(ni); }
    }
  }
  return seen.size === floor.length;
}
// Tiles reachable from the entrance (4-connected, walkable).
function reachable(map) {
  const { x, y } = map.entrance.front;
  const seen = new Uint8Array(map.width * map.height);
  seen[map.idx(x, y)] = 1;
  const q = [[x, y]];
  for (let qi = 0; qi < q.length; qi++) {
    const [cx, cy] = q[qi];
    for (const [dx, dy] of DIR4) {
      const nx = cx + dx, ny = cy + dy;
      if (!map.isWalkable(nx, ny) || seen[map.idx(nx, ny)]) continue;
      seen[map.idx(nx, ny)] = 1; q.push([nx, ny]);
    }
  }
  return seen;
}
const inBox = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

// One run of consecutive depths, each told the previous depth's archetype (as main.js does).
function run(seed, depths = 25) {
  const rng = new RNG(seed);
  const maps = [];
  let prev;
  for (let depth = 1; depth <= depths; depth++) {
    const map = generateDungeon(depth, rng, { prevArchetype: prev });
    maps.push({ depth, map });
    prev = map.archetype;
  }
  return maps;
}
const RUNS = [11, 22, 33, 44, 55, 66].flatMap((s) => run(s));

console.log('Map archetypes & shapes (§17.13)');

test('room-count curve: min(22, 11 + floor((depth-1)*0.6))', () => {
  assert.deepEqual([1, 2, 3, 5, 10, 18, 19, 20, 30].map(targetRoomCount), [11, 11, 12, 13, 16, 21, 21, 22, 22]);
});

test('every generated floor places its full room count (all but a rare wide-gap Wings layout)', () => {
  // (the growth pass's rooms; treasure wings, §17.14, and the boss arena, §17.15, are added on top of this base count)
  const want = (depth) => targetRoomCount(depth) + (isBossDepth(depth) ? 1 : 0);
  const short = RUNS.filter(({ depth, map }) => map.baseRoomCount !== want(depth));
  for (const { depth, map } of RUNS) assert.ok(map.baseRoomCount <= want(depth));
  assert.ok(short.length <= RUNS.length * 0.02, `${short.length}/${RUNS.length} floors short of their room count`);
});

test('pickArchetype never returns the previous archetype, and reaches every other one', () => {
  const rng = new RNG(5);
  for (const prev of [undefined, ...ARCHETYPE_IDS]) {
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      const a = pickArchetype(rng, prev);
      assert.ok(ARCHETYPE_IDS.includes(a));
      assert.notEqual(a, prev);
      seen.add(a);
    }
    assert.equal(seen.size, prev ? ARCHETYPE_IDS.length - 1 : ARCHETYPE_IDS.length);
  }
});

test('consecutive depths never share an archetype; every archetype shows up', () => {
  const seen = new Set();
  for (let i = 1; i < RUNS.length; i++) {
    const a = RUNS[i - 1], b = RUNS[i];
    if (b.depth !== 1) assert.notEqual(b.map.archetype, a.map.archetype, `repeat at depth ${b.depth}`);
    seen.add(b.map.archetype);
  }
  assert.deepEqual([...seen].sort(), [...ARCHETYPE_IDS].sort());
  // no opts at all still works (a fresh run / tests that don't track the previous floor)
  assert.ok(ARCHETYPE_IDS.includes(generateDungeon(3, new RNG(1)).archetype));
});

test('archetype profiles carry the §17.13 table values', () => {
  const mix = (a) => Object.values(ARCHETYPES[a].sizeMix).join('/');
  assert.equal(mix('halls'), '18/44/38');
  assert.equal(mix('catacombs'), '45/45/10');
  assert.equal(mix('caverns'), '10/40/50');
  assert.equal(ARCHETYPES.catacombs.cluster, 0.4);
  assert.equal(ARCHETYPES.catacombs.sharedWall, 0.5);
  assert.equal(ARCHETYPES.catacombs.loops, 0.35);
  assert.equal(ARCHETYPES.caverns.sharedWall, 0.45);
  assert.ok(ARCHETYPES.caverns.widen > ARCHETYPES.halls.widen);
  assert.equal(ARCHETYPES.keep.loops, 0.15);
  assert.equal(ARCHETYPES.keep.grand, 1);
  assert.deepEqual(ARCHETYPES.wings.gap, [5, 12]);
  assert.equal(ARCHETYPES.wings.loops, 0.15);
  assert.equal(ARCHETYPES.wings.parent, 'deep');
});

test('every shape builds a valid room: one 4-connected floor, cores enclosed walls, a door slot facing every way', () => {
  const rng = new RNG(9);
  for (const [cat, types] of Object.entries(SHAPES_BY_SIZE)) {
    for (const type of types) {
      for (let i = 0; i < 150; i++) {
        const s = makeShape(rng, cat, { type });
        if (type !== 'cavern') assert.equal(s.type, type);
        else assert.ok(s.type === 'cavern' || s.type === 'cave');
        assert.ok(s.w >= 3 && s.h >= 3, `${type} ${s.w}x${s.h}`);
        assert.ok(shapeConnected(s), `${cat} ${type} floor split`);
        for (const [x, y] of s.core) assert.equal(s.mask[y * s.w + x], 0, `${type} core tile is floor`);
        const slots = shapeDoorSlots(s);
        // (the pre-§17.13 smooth 'cave' ellipse can miss a side on narrow boxes; that just limits which way it links)
        if (s.type !== 'cave') for (const [dx, dy] of DIR4) assert.ok(slots.some((sl) => sl.dx === dx && sl.dy === dy), `${cat} ${type} no ${dx},${dy} door slot`);
        else assert.ok(slots.length > 0);
        const core = new Set(s.core.map(([x, y]) => `${x},${y}`));
        for (const sl of slots) assert.ok(!core.has(`${sl.x},${sl.y}`), `${type} door slot on a core tile`);
      }
    }
  }
});

test('shape specifics: gallery, ring hall core, split-hall divider, cross notches, octagon chamfers, grand size', () => {
  const rng = new RNG(4);
  for (let i = 0; i < 200; i++) {
    const g = makeShape(rng, 'medium', { type: 'gallery' });
    const [short, long] = [Math.min(g.w, g.h), Math.max(g.w, g.h)];
    assert.ok(short >= 3 && short <= 5 && long >= 14 && long <= 22, `gallery ${g.w}x${g.h}`);

    for (const cat of ['large', 'grand']) {
      const r = makeShape(rng, cat, { type: 'ringHall' });
      // the core is exactly the solid rectangle of walls inside the box, >= 3x3, all of it marked
      const walls = [];
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (!r.mask[y * r.w + x]) walls.push([x, y]);
      const xs = walls.map((p) => p[0]), ys = walls.map((p) => p[1]);
      const cw = Math.max(...xs) - Math.min(...xs) + 1, ch = Math.max(...ys) - Math.min(...ys) + 1;
      assert.ok(cw >= 3 && ch >= 3 && walls.length === cw * ch, `ring core ${cw}x${ch}`);
      assert.equal(r.core.length, walls.length);
      if (cat === 'grand') assert.ok(r.w >= 20 && r.w <= 26 && r.h >= 14 && r.h <= 20, `grand ${r.w}x${r.h}`);
    }

    const sp = makeShape(rng, 'large', { type: 'splitHall' });
    let wallCount = 0;
    for (let k = 0; k < sp.w * sp.h; k++) if (!sp.mask[k]) wallCount++;
    assert.ok(wallCount > 0 && sp.core.length === wallCount, 'every divider tile is core');

    const c = makeShape(rng, 'large', { type: 'cross' });
    assert.ok([0, c.w - 1].some((x) => [0, c.h - 1].some((y) => !c.mask[y * c.w + x])), 'cross/T has a notched corner');

    const o = makeShape(rng, 'large', { type: 'octagon' });
    for (const [x, y] of [[0, 0], [o.w - 1, 0], [0, o.h - 1], [o.w - 1, o.h - 1]]) assert.equal(o.mask[y * o.w + x], 0);

    const p = makeShape(rng, 'grand', { type: 'pillars' });
    assert.ok(p.w >= 20 && p.h >= 14 && p.pillars.length > 0);
  }
});

test('ring halls / split halls on real floors: no doorway, corridor or stairs ever cut into a core or divider', () => {
  let rings = 0, splits = 0;
  for (const { map } of RUNS) {
    for (const r of map.rooms) {
      if (r.shape !== 'ringHall' && r.shape !== 'splitHall') continue;
      if (r.shape === 'ringHall') rings++; else splits++;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        const t = map.get(x, y);
        assert.ok(t === TILE.FLOOR || t === TILE.WALL, `${r.shape} has tile ${t} inside its box at ${x},${y}`);
      }
      for (const d of r.doors) assert.ok(!inBox(r, d.x, d.y), 'door inside the room box');
      if (r.shape === 'ringHall') {
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
          if (map.get(x, y) !== TILE.WALL) continue;
          n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
        assert.equal(n, (x1 - x0 + 1) * (y1 - y0 + 1), 'ring core still solid');
      }
    }
  }
  assert.ok(rings >= 5 && splits >= 5, `saw ${rings} ring halls, ${splits} split halls`);
});

test('every room carries its shape id and a walkable centre; every floor tile is reachable', () => {
  const shapes = new Set();
  for (const { depth, map } of RUNS) {
    const seen = reachable(map);
    const hidden = map.rooms.find((r) => r.hidden);
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      if (!map.isWalkable(x, y) || seen[map.idx(x, y)]) continue;
      assert.ok(hidden && inBox(hidden, x, y), `depth ${depth}: ${x},${y} unreachable`);
    }
    for (const r of map.rooms) {
      assert.ok(Object.keys(r).includes('shape') && ALL_SHAPES.includes(r.shape), `room.shape ${r.shape}`);
      assert.ok(map.isWalkable(r.cx, r.cy));
      assert.ok(r.doors.length >= 1);
      shapes.add(r.shape);
    }
  }
  // (every growth shape, and both bosses' arenas; the generic arena only serves bosses that don't exist yet)
  const expected = [...GROWTH_SHAPES, ...Object.values(BOSS_ARENAS).map((a) => a.shape)];
  assert.deepEqual([...shapes].sort(), expected.sort(), 'every shape gets picked somewhere');
});

test('grand landmark seed room: only ever room 0, never on a boss depth, always on a Keep non-boss depth', () => {
  let grands = 0;
  for (const { depth, map } of RUNS) {
    const g = map.rooms.filter((r) => r.size === 'grand');
    assert.ok(g.length <= 1);
    if (depth % 5 === 0) assert.equal(g.length, 0, 'grand room on a boss depth');
    else if (map.archetype === 'keep') assert.equal(g.length, 1, 'keep without a grand seed');
    if (!g.length) continue;
    grands++;
    assert.equal(g[0].id, 0);
    assert.ok(['ringHall', 'pillars'].includes(g[0].shape));
    assert.ok(g[0].kind !== 'start', 'grand room is never the start room');
  }
  assert.ok(grands > 5);
});

test('Catacombs cluster mode: small rooms chain off each other through shared walls, each still a valid 5-7 room', () => {
  // A shared-wall link is one doorway listed by both rooms.
  const smallPairs = (map) => {
    const at = new Map();
    let n = 0;
    for (const r of map.rooms) {
      if (r.size !== 'small') continue;
      for (const d of r.doors) { const k = `${d.x},${d.y}`; if (at.has(k)) n++; else at.set(k, r); }
    }
    return n;
  };
  const perFloor = { catacombs: [0, 0], halls: [0, 0] };
  for (const { map } of RUNS) {
    if (perFloor[map.archetype]) { perFloor[map.archetype][0] += smallPairs(map); perFloor[map.archetype][1]++; }
    for (const r of map.rooms) if (r.size === 'small') assert.ok(r.w >= 5 && r.h >= 5 && r.w <= 7 && r.h <= 7, `small ${r.w}x${r.h}`);
  }
  const cat = perFloor.catacombs[0] / perFloor.catacombs[1], halls = perFloor.halls[0] / perFloor.halls[1];
  assert.ok(cat > 1.5 && cat > halls * 3, `small-small shared walls per floor: catacombs ${cat.toFixed(2)}, halls ${halls.toFixed(2)}`);
});

console.log('Boss arenas (§17.15)');

test('bossForDepth (core.js): Slime King on 5, 15, 25...; Bone Tyrant on 10, 20, 30...; null elsewhere', () => {
  assert.deepEqual([5, 10, 15, 20, 25, 30, 35, 40].map(bossForDepth),
    ['slime_king', 'bone_tyrant', 'slime_king', 'bone_tyrant', 'slime_king', 'bone_tyrant', 'slime_king', 'bone_tyrant']);
  for (const d of [0, 1, 2, 3, 4, 6, 9, 11, 14, 16, 21, 29]) assert.equal(bossForDepth(d), null, `depth ${d}`);
  assert.ok(isBossDepth(5) && !isBossDepth(6));
});

test('arena shapes: every roll meets the minimum (16x13, >= 180 floor, clear 9x9 core, a door slot on each end)', () => {
  const rng = new RNG(21);
  for (const [bossId, spec] of [...Object.entries(BOSS_ARENAS), ['someFutureBoss', GENERIC_ARENA]]) {
    for (let i = 0; i < 300; i++) {
      const s = makeArenaShape(rng, bossId);
      assert.equal(s.type, spec.shape, `${bossId} -> ${s.type}`);
      const st = arenaStats(s);
      assert.ok(arenaMeetsMinimum(s), `${s.type} ${JSON.stringify(st)}`);
      assert.ok(st.long >= ARENA_MIN.long && st.short >= ARENA_MIN.short && st.floor >= ARENA_MIN.floor);
      assert.ok(st.clearRadius >= ARENA_MIN.clearRadius);
      assert.ok(shapeConnected(s), `${s.type} floor split`);
      // every pillar / rock island is enclosed core (never a doorway) and outside the clear core
      for (const [x, y] of s.core) {
        assert.equal(s.mask[y * s.w + x], 0);
        assert.ok(Math.max(Math.abs(x - st.spawn.x), Math.abs(y - st.spawn.y)) > ARENA_MIN.clearRadius, 'pillar in the clear core');
      }
    }
  }
});

test('arenaMeetsMinimum rejects undersized / obstructed rooms', () => {
  const rect = (w, h, holes = []) => {
    const mask = new Uint8Array(w * h).fill(1);
    for (const [x, y] of holes) mask[y * w + x] = 0;
    return { w, h, mask, type: 'rect', pillars: holes, core: holes };
  };
  assert.ok(arenaMeetsMinimum(rect(17, 15)));
  assert.ok(!arenaMeetsMinimum(rect(15, 13)), 'too short');
  assert.ok(!arenaMeetsMinimum(rect(18, 12)), 'too narrow');
  assert.ok(!arenaMeetsMinimum(rect(16, 11)), 'under 180 floor');
  assert.ok(!arenaMeetsMinimum(rect(17, 15, [[8 + 4, 7]])), 'pillar 4 tiles from the spawn point');
  assert.ok(arenaMeetsMinimum(rect(17, 15, [[8 + 5, 7]])), 'pillar 5 tiles out is fine');
  assert.equal(arenaStats(rect(17, 15, [[8 + 3, 7 - 3]])).clearRadius, 2);
});

test('arena specifics: Sump is a ~17-19 x 15-17 ellipse with islands >= 6 out; Ossuary Hall 20-24 x 13-15 with colonnades 3 in', () => {
  const rng = new RNG(3);
  let islands = 0;
  for (let i = 0; i < 300; i++) {
    const s = makeArenaShape(rng, 'slime_king');
    const [L, S] = [Math.max(s.w, s.h), Math.min(s.w, s.h)];
    assert.ok(L >= 17 && L <= 19 && S >= 15 && S <= 17, `sump ${s.w}x${s.h}`);
    const { spawn } = arenaStats(s);
    for (const [x, y] of s.core) assert.ok(Math.hypot(x - spawn.x, y - spawn.y) >= 6, 'sump island too close to the centre');
    // corners are rock (an ellipse, not a rectangle)
    for (const [x, y] of [[0, 0], [s.w - 1, 0], [0, s.h - 1], [s.w - 1, s.h - 1]]) assert.equal(s.mask[y * s.w + x], 0);
    islands += s.core.length > 0 ? 1 : 0;

    const o = makeArenaShape(rng, 'bone_tyrant');
    const horiz = o.w >= o.h;
    const [OL, OS] = [Math.max(o.w, o.h), Math.min(o.w, o.h)];
    assert.ok(OL >= 20 && OL <= 24 && OS >= 13 && OS <= 15, `ossuary ${o.w}x${o.h}`);
    assert.ok(o.pillars.length >= 8, 'two colonnade rows at each end');
    for (const [x, y] of o.pillars) {
      const across = horiz ? y : x;
      assert.ok(across === 3 || across === OS - 4, `pillar ${across} tiles in from a long wall`);
    }
  }
  assert.ok(islands > 290, 'the Sump nearly always has cover islands');
});

const BOSS_FLOORS = [];
for (let i = 0; i < 80; i++) {
  const depth = 5 * (1 + (i % 6));
  BOSS_FLOORS.push({ depth, seed: 900 + i, map: generateDungeon(depth, new RNG(900 + i), { merchant: true }) });
}

test('boss depths: the arena is the seed room (room 0), per-boss shape, tagged kind/arena/size, minimum size on the real map', () => {
  for (const { depth, map } of BOSS_FLOORS) {
    const arenas = map.rooms.filter((r) => r.kind === 'boss');
    assert.equal(arenas.length, 1);
    const a = arenas[0];
    assert.equal(a.id, 0);
    assert.equal(a.arena, bossForDepth(depth));
    assert.equal(a.shape, BOSS_ARENAS[bossForDepth(depth)].shape);
    assert.equal(a.size, 'large');
    assert.ok(map.roomTiles(a.id).length >= ARENA_MIN.floor);
    for (let y = a.cy - 4; y <= a.cy + 4; y++) for (let x = a.cx - 4; x <= a.cx + 4; x++) {
      assert.equal(map.get(x, y), TILE.FLOOR, `clear core ${x},${y}`);
      assert.equal(map.roomAt(x, y).id, a.id);
    }
  }
  // non-boss depths never get one
  for (const { depth, map } of RUNS) if (!isBossDepth(depth)) assert.ok(!map.rooms.some((r) => r.kind === 'boss' || r.arena));
});

test('arena doorways: 1-2, on opposite short ends; linked only to growth rooms (never a treasure wing)', () => {
  for (const { map } of BOSS_FLOORS) {
    const a = map.rooms[0];
    assert.ok(a.doors.length >= 1 && a.doors.length <= 2, `${a.doors.length} doors`);
    const horiz = a.w >= a.h;
    const side = (d) => Math.sign(horiz ? d.x - a.cx : d.y - a.cy);
    for (const d of a.doors) assert.notEqual(side(d), 0);
    if (a.doors.length === 2) assert.equal(side(a.doors[0]) * side(a.doors[1]), -1, 'both doors on one end');
    // whatever room each doorway leads to (through its corridor) is a growth room
    for (const d of a.doors) {
      const seen = new Set([map.idx(d.x, d.y)]); const q = [[d.x, d.y]];
      for (let qi = 0; qi < q.length; qi++) {
        const [x, y] = q[qi];
        for (const [dx, dy] of DIR4) {
          const nx = x + dx, ny = y + dy;
          if (!map.isWalkable(nx, ny)) continue;
          const r = map.roomAt(nx, ny);
          if (r) { if (r.id !== a.id) assert.ok(r.id < map.baseRoomCount && r.kind !== 'treasure', 'arena linked to a wing'); continue; }
          const k = map.idx(nx, ny); if (!seen.has(k)) { seen.add(k); q.push([nx, ny]); }
        }
      }
    }
  }
});

test('arena: no stairs, merchant, spawn candidates or general spawns inside; boss at its centre with 2-4 guards', () => {
  for (const { depth, seed, map } of BOSS_FLOORS) {
    const a = map.rooms[0];
    const inA = (x, y) => { const r = map.roomAt(x, y); return !!r && r.id === a.id; };
    for (const s of [map.entrance, ...map.exits]) assert.ok(!inA(s.front.x, s.front.y), 'stairs in the arena');
    assert.notEqual(map.merchantRoomId, a.id);
    for (const c of map.spawnCandidates(new RNG(1), 5000, 0)) assert.notEqual(c.roomId, a.id);
    const enemies = spawnEnemies({ map, depth, rng: new RNG(seed) });
    const boss = enemies.find((e) => e.type === bossForDepth(depth));
    assert.ok(boss && boss.x === a.cx && boss.y === a.cy, 'boss at the arena centre');
    const guards = enemies.filter((e) => e.bossGuard);
    assert.ok(guards.length >= 2 && guards.length <= 4, `${guards.length} guards`);
    for (const e of enemies) if (inA(e.x, e.y)) assert.ok(e === boss || e.bossGuard, 'general spawn inside the arena');
    for (const g of guards) assert.ok(inA(g.x, g.y), 'boss guard outside the arena');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
