// Fast banded balance checks (DESIGN §17.17) — the `npm test` companion to the slow statistical `npm run sim`
// (tools/sim.js). Fixed seeds, 50 floors per depth over depths 1-20, asserting bands rather than exact numbers:
// treasure rooms are genuine single-door leaves and the boss arena is the seed room, every boss room meets §17.15's
// minimum, at most one Vault per depth, the hidden-book rate, exact item-level offsets per tier, enemy density vs
// density(depth) (§17.16), treasure items/depth vs the §17.14 design table, generation time, and the §17.4 merchant
// stock rarity steps / shallow-stock pricing.
//   node test/balance.test.js      (or: npm test)
import assert from 'node:assert/strict';
import { RNG, isBossDepth, bossForDepth, RARITY_ORDER } from '../public/js/core.js';
import { ARENA_MIN, HIDDEN_ROOM_MIN_DEPTH } from '../public/js/map.js';
import { computeSpawnCount, DENSITY_BASE, DENSITY_PER_DEPTH } from '../public/js/enemies.js';
import { buyPrice } from '../public/js/items.js';
import {
  generateMerchantStock, shopPrice, regularGearPriceMult, featuredPriceMult, stockRarityFloor, stockItemLevel,
  featuredUpChance, STOCK_RARITY_STEPS,
} from '../public/js/shop.js';
import {
  floorSample, simulateRun, mixSeed, spawnDensity, designTreasureItems, tierLevelRange, placedArenaStats, isGeneral,
} from '../tools/simlib.js';

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.stack}`); }
}
const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

const N = 50, MAX_DEPTH = 20, SEED = 20260923;
const FLOORS = [];
for (let d = 1; d <= MAX_DEPTH; d++) for (let i = 0; i < N; i++) FLOORS.push(floorSample(d, mixSeed(SEED, d, i), { keepMap: true }));
const byDepth = (d) => FLOORS.filter((f) => f.depth === d);

function bfs(map, blocked) {
  const { x, y } = map.entrance.front;
  const d = new Int32Array(map.width * map.height).fill(-1);
  d[map.idx(x, y)] = 0;
  const q = [map.idx(x, y)];
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi], cx = i % map.width, cy = (i / map.width) | 0;
    for (const [dx, dy] of DIR4) {
      const nx = cx + dx, ny = cy + dy;
      if (!map.isWalkable(nx, ny)) continue;
      const ni = map.idx(nx, ny);
      if (d[ni] !== -1 || blocked.has(ni)) continue;
      d[ni] = d[i] + 1; q.push(ni);
    }
  }
  return d;
}

console.log(`Balance bands (§17.17): ${FLOORS.length} floors, depths 1-${MAX_DEPTH}`);

test('every treasure room is a single-door leaf (antechamber: 2 doors, its Vault behind it); the arena is the seed room', () => {
  let wings = 0;
  for (const { _map: map, depth } of FLOORS) {
    for (const r of map.rooms) {
      if (r.kind === 'boss') { assert.equal(r.id, 0, 'the boss arena is room 0 (the seed room)'); continue; }
      if (r.kind !== 'treasure') continue;
      wings++;
      assert.ok(r.id >= map.baseRoomCount, 'a wing is never a growth room');
      assert.equal(r.doors.length, r.antechamber ? 2 : 1, `depth ${depth}: ${r.treasureTier} has ${r.doors.length} doors`);
      if (r.hidden) continue; // its doorway is a WALL until revealed — nothing reaches it at all (unlock.test.js)
      // Blocking the room's (first) door cuts off only the room itself (+ the Vault behind an antechamber).
      const door = r.doors[0];
      const di = map.idx(door.x, door.y);
      const open = bfs(map, new Set()), cut = bfs(map, new Set([di]));
      const own = new Set();
      const ids = [r.id, ...map.rooms.filter((v) => v.antechamberId === r.id).map((v) => v.id)];
      for (const id of ids) for (const t of map.roomTiles(id)) own.add(map.idx(t.x, t.y));
      for (let i = 0; i < map.tiles.length; i++) {
        if (open[i] < 0 || cut[i] >= 0 || i === di || own.has(i)) continue;
        // an antechamber's doorway to its Vault is corridor/door floor that belongs to neither room
        assert.ok(r.antechamber && !map.roomAt(i % map.width, (i / map.width) | 0), `depth ${depth}: ${r.treasureTier} door cut off other floor`);
      }
    }
  }
  assert.ok(wings > 1500, `saw ${wings} wings`);
});

test(`every boss room meets §17.15's minimum (${ARENA_MIN.long}x${ARENA_MIN.short}, >= ${ARENA_MIN.floor} floor, clear 9x9 core); none off boss depths`, () => {
  for (const { _map: map, depth } of FLOORS) {
    const bosses = map.rooms.filter((r) => r.kind === 'boss');
    assert.equal(bosses.length, isBossDepth(depth) ? 1 : 0, `depth ${depth}: ${bosses.length} boss rooms`);
    for (const b of bosses) {
      const s = placedArenaStats(map, b);
      assert.equal(b.arena, bossForDepth(depth));
      assert.ok(s.long >= ARENA_MIN.long && s.short >= ARENA_MIN.short, `depth ${depth}: arena ${s.long}x${s.short}`);
      assert.ok(s.floor >= ARENA_MIN.floor, `depth ${depth}: arena floor ${s.floor}`);
      assert.ok(s.clearRadius >= ARENA_MIN.clearRadius, `depth ${depth}: clear radius ${s.clearRadius}`);
    }
  }
});

test('at most one Vault per depth', () => {
  for (const f of FLOORS) assert.ok(f.vault <= 1, `depth ${f.depth}: ${f.vault} Vaults`);
  assert.ok(FLOORS.some((f) => f.vault === 1));
});

test(`hidden-room book rate lands between 30% and 40% of depths (from depth ${HIDDEN_ROOM_MIN_DEPTH})`, () => {
  const eligible = FLOORS.filter((f) => f.depth >= HIDDEN_ROOM_MIN_DEPTH);
  const rate = eligible.filter((f) => f.booksHidden > 0).length / eligible.length;
  assert.ok(rate >= 0.30 && rate <= 0.40, `hidden book on ${(rate * 100).toFixed(1)}% of depths`);
  for (const f of FLOORS) {
    if (f.depth < HIDDEN_ROOM_MIN_DEPTH) assert.equal(f.booksHidden, 0);
    assert.ok(f.booksHidden <= 1);
    assert.equal(f.booksHidden, f.hidden, 'a hidden room always holds exactly one book');
  }
});

test('treasure item levels: exact per-tier offsets (Cache max(1,d-1)±1, Hoard d±1, Vault d+1..2), every offset seen', () => {
  for (const tier of ['cache', 'hoard', 'vault']) {
    const seen = new Set();
    for (const f of FLOORS) {
      const [lo, hi] = tierLevelRange(tier, f.depth);
      for (const o of f.levelOffsets[tier]) {
        assert.ok(o >= lo && o <= hi, `depth ${f.depth}: ${tier} item level offset ${o} outside ${lo}..${hi}`);
        if (f.depth >= 3) seen.add(o);
      }
    }
    const [lo, hi] = tierLevelRange(tier, 10);
    for (let o = lo; o <= hi; o++) assert.ok(seen.has(o), `${tier}: offset ${o} never rolled`);
  }
});

test('enemy density (general spawns / 100 populated floor) within ±10% of density(depth) at every depth (§17.16)', () => {
  assert.equal(spawnDensity(1), DENSITY_BASE);
  assert.ok(Math.abs(spawnDensity(20) - (DENSITY_BASE + DENSITY_PER_DEPTH * 19)) < 1e-9);
  assert.equal(computeSpawnCount(10, 1500), Math.round(spawnDensity(10) * 15));
  for (let d = 1; d <= MAX_DEPTH; d++) {
    const fl = byDepth(d);
    const got = mean(fl.map((f) => f.density)), want = spawnDensity(d);
    assert.ok(Math.abs(got / want - 1) <= 0.10, `depth ${d}: density ${got.toFixed(3)} vs ${want.toFixed(3)}`);
  }
});

test('general spawns spread over rooms in proportion to area (no clumping), and never where they must not be', () => {
  // Per floor: general enemies in each growth room vs. that room's share of candidate floor. Pooled over floors, the
  // share of general room spawns that land in the largest half of the rooms tracks their share of the floor.
  let bigFloor = 0, allFloor = 0, bigSpawn = 0, allSpawn = 0;
  for (const { _map: map, _enemies: enemies } of FLOORS) {
    const eligible = map.rooms.filter((r) => r.kind === 'normal' || r.kind === 'exit');
    const area = new Map(eligible.map((r) => [r.id, map.roomTiles(r.id).length]));
    const sorted = [...eligible].sort((a, b) => area.get(b.id) - area.get(a.id));
    const big = new Set(sorted.slice(0, Math.ceil(sorted.length / 2)).map((r) => r.id));
    for (const r of eligible) { allFloor += area.get(r.id); if (big.has(r.id)) bigFloor += area.get(r.id); }
    for (const e of enemies.filter(isGeneral)) {
      const r = map.roomAt(e.x, e.y);
      if (!r) continue;
      assert.ok(r.kind !== 'treasure' && r.kind !== 'boss' && r.kind !== 'merchant', `general spawn in a ${r.kind} room`);
      if (!area.has(r.id)) continue;
      allSpawn++; if (big.has(r.id)) bigSpawn++;
    }
  }
  const fShare = bigFloor / allFloor, sShare = bigSpawn / allSpawn;
  assert.ok(Math.abs(sShare - fShare) < 0.06, `larger rooms: ${(fShare * 100).toFixed(1)}% of floor, ${(sShare * 100).toFixed(1)}% of room spawns`);
});

test('treasure items per depth within ±25% of the §17.14 design table', () => {
  for (let d = 1; d <= MAX_DEPTH; d++) {
    const got = mean(byDepth(d).map((f) => f.treasureItems)), want = designTreasureItems(d);
    assert.ok(Math.abs(got / want - 1) <= 0.25, `depth ${d}: ${got.toFixed(2)} treasure items vs design ${want.toFixed(2)}`);
  }
  assert.ok(Math.abs(designTreasureItems(10) - 7.4) < 0.1, 'design table: ~7.4 treasure items at depth 10 (§17.14)');
});

test('mean generation time stays under 10 ms', () => {
  const ms = mean(FLOORS.map((f) => f.genMs));
  assert.ok(ms < 10, `mean ${ms.toFixed(2)} ms`);
});

test('run-economy policy (Layer 2) runs end to end and reports sane numbers', () => {
  for (let i = 0; i < 3; i++) {
    const run = simulateRun(mixSeed(SEED, 0, i), { depths: 6 });
    assert.equal(run.length, 6);
    let prevLevel = 1;
    for (const r of run) {
      for (const k of ['goldOnHand', 'income', 'affordRegular', 'affordFeatured', 'gearIlvl', 'level', 'bagMax']) {
        assert.ok(Number.isFinite(r[k]), `depth ${r.depth}: ${k} = ${r[k]}`);
      }
      assert.ok(r.affordRegular >= 0 && r.affordRegular <= 4 && r.goldAfter >= 0 && r.bagMax <= 24);
      assert.ok(r.level >= prevLevel); prevLevel = r.level;
    }
  }
});

// §17.4: merchant stock rarity tracks the depth (the late-game gold-surplus fix), and the regular-gear markup never
// touches the shallow stock (depths before the first rarity step price exactly like the pre-markup shop).
test('merchant stock: rarity floor per step, Featured base tier (+ featuredUpChance one up), shallow gear unmarked', () => {
  const ri = (r) => RARITY_ORDER.indexOf(r);
  const firstStep = STOCK_RARITY_STEPS[1].depth;
  const SHOPS = 200;
  for (let d = 1; d <= 25; d++) {
    const step = [...STOCK_RARITY_STEPS].reverse().find((s) => d >= s.depth);
    assert.equal(stockRarityFloor(d), step.gear);
    const rng = new RNG(mixSeed(SEED, d, 7));
    const featured = {};
    for (let i = 0; i < SHOPS; i++) {
      const st = generateMerchantStock(d, rng);
      for (const g of st.gear) {
        assert.ok(ri(g.rarity) >= ri(step.gear), `depth ${d}: ${g.rarity} gear under the ${step.gear} floor`);
        assert.equal(g.itemLevel, stockItemLevel(d));
        assert.equal(shopPrice('gear', g), Math.max(1, Math.round(buyPrice(g) * regularGearPriceMult(g.itemLevel))));
        if (d < firstStep) assert.equal(shopPrice('gear', g), buyPrice(g), `depth ${d}: shallow gear must not be marked up`);
      }
      const f = st.featured;
      assert.equal(f.itemLevel, stockItemLevel(d));
      assert.equal(shopPrice('featured', f), Math.max(1, Math.round(buyPrice(f) * featuredPriceMult(f.itemLevel))));
      featured[f.rarity] = (featured[f.rarity] || 0) + 1;
    }
    const up = RARITY_ORDER[Math.min(RARITY_ORDER.length - 1, ri(step.featured) + 1)];
    const seen = Object.keys(featured);
    assert.ok(seen.every((r) => r === step.featured || r === up), `depth ${d}: featured rolled ${seen}`);
    const upShare = (featured[up] || 0) / SHOPS;
    assert.ok(Math.abs(upShare - featuredUpChance(d)) < 0.1, `depth ${d}: featured ${up} ${upShare} vs ${featuredUpChance(d)}`);
  }
  // The gear markup stays under Featured's at every level (Featured keeps its "splurge item" identity).
  for (let lvl = 1; lvl <= 40; lvl++) assert.ok(regularGearPriceMult(lvl) < featuredPriceMult(lvl));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
