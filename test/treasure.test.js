// Plain-Node unit tests for treasure tiers (DESIGN §17.14), the hidden-room modifier (§17.11), the reordered map
// pipeline (§7) and merchant rooms: tier weights / room-count curve / tier roll, chest contents (item-level offsets
// via opts.itemLevel, rarity, gold, potions, the hidden bonus book), guard plans, antechamber gating, leaf structure,
// and spawn exclusion for treasure wings and the merchant's room.
//   node test/treasure.test.js      (or: npm test)
import assert from 'node:assert/strict';
import { RNG, TILE, RARITY_ORDER } from '../public/js/core.js';
import {
  generateDungeon, treasureRoomSlots, treasureTierWeights, rollTreasureTiers, rollChestCount,
  HIDDEN_ROOM_CHANCE, HIDDEN_ROOM_MIN_DEPTH, VAULT_MIN_DEPTH, ANTECHAMBER_MIN_DEPTH,
} from '../public/js/map.js';
import { rollChestContents, treasureItemLevel, CHEST_LOOT } from '../public/js/items.js';
import { treasureGuardPlan, spawnEnemies, enemyPoolForDepth } from '../public/js/enemies.js';
import '../public/js/skills.js'; // registers the skill-book hooks (the hidden room's bonus book)

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.stack}`); }
}
const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A spread of generated floors (depths 1-30), each on a merchant depth as main.js generates them.
const MAPS = [];
for (let i = 0; i < 300; i++) {
  const depth = 1 + (i % 30);
  const t0 = performance.now();
  const map = generateDungeon(depth, new RNG(4242 + i), { merchant: true });
  MAPS.push({ depth, map, ms: performance.now() - t0, seed: 4242 + i });
}
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
      if (d[ni] !== -1 || (blocked && blocked.has(ni))) continue;
      d[ni] = d[i] + 1; q.push(ni);
    }
  }
  return d;
}

console.log('Treasure tiers (§17.14)');

test('room-count curve: min(5, round(5·(1-e^(-depth/4)))) — 1/2/3 at depths 1-3, 5 from depth 10', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 8, 10, 20, 40].map(treasureRoomSlots), [1, 2, 3, 3, 4, 4, 4, 5, 5, 5]);
});

test('tier weights drift with t = (depth-1)/19: Cache 60->40, Hoard 30->40, Vault 10->20 (0 below depth 3)', () => {
  const w = (d) => Object.values(treasureTierWeights(d)).map((v) => +v.toFixed(4));
  assert.deepEqual(w(1), [0.6, 0.3, 0]);
  assert.deepEqual(w(2), [0.5895, 0.3053, 0]);
  assert.deepEqual(w(VAULT_MIN_DEPTH), [0.5789, 0.3105, 0.1105]);
  assert.deepEqual(w(20), [0.4, 0.4, 0.2]);
  assert.deepEqual(w(35), [0.4, 0.4, 0.2]);
});

test('tier roll: Vault-first order, at most one Vault, slot fill rules, distribution follows the weights', () => {
  const order = { vault: 0, hoard: 1, cache: 2 };
  for (const depth of [1, 2, 3, 6, 10, 20]) {
    const rng = new RNG(depth);
    const K = 20000;
    let rooms = 0, empty = 0;
    const count = { cache: 0, hoard: 0, vault: 0 };
    for (let i = 0; i < K; i++) {
      const t = rollTreasureTiers(depth, rng);
      assert.ok(t.length <= treasureRoomSlots(depth));
      for (let k = 1; k < t.length; k++) assert.ok(order[t[k - 1]] <= order[t[k]], `order ${t}`);
      assert.ok(t.filter((x) => x === 'vault').length <= 1, 'two Vaults');
      if (depth < VAULT_MIN_DEPTH) assert.ok(!t.includes('vault'));
      if (!t.length) empty++;
      rooms += t.length;
      for (const x of t) count[x]++;
    }
    const slots = treasureRoomSlots(depth);
    if (depth >= 2) assert.equal(empty, 0, 'from depth 2 the first slot always fills');
    else assert.ok(near(empty / K, 0.5, 0.02), `depth 1 fills ${1 - empty / K}`);
    const expectRooms = (depth >= 2 ? 1 : 0.5) + (slots - 1) * 0.5;
    assert.ok(near(rooms / K, expectRooms, 0.03), `depth ${depth}: ${rooms / K} rooms vs ${expectRooms}`);
    // Cache:Hoard ratio is untouched by the one-Vault cap
    const w = treasureTierWeights(depth);
    assert.ok(near(count.cache / count.hoard, w.cache / w.hoard, 0.08), `depth ${depth} cache/hoard ${count.cache / count.hoard}`);
    if (depth >= VAULT_MIN_DEPTH) {
      // P(a depth rolls a Vault) = 1 - prod over filled slots of (1 - pVault): check against a direct formula
      const pv = w.vault / (w.cache + w.hoard + w.vault);
      let pNone = 0;
      for (let k = 0; k < slots; k++) { // k extra slots filled
        const comb = [1, 1, 2, 6, 24][slots - 1] / ([1, 1, 2, 6, 24][k] * [1, 1, 2, 6, 24][slots - 1 - k]);
        pNone += comb * 0.5 ** (slots - 1) * (1 - pv) ** (k + 1);
      }
      assert.ok(near(count.vault / K, 1 - pNone, 0.015), `depth ${depth}: vault rate ${count.vault / K} vs ${1 - pNone}`);
    }
  }
});

test('chest counts: Cache 1, Hoard 1-2, Vault 2-3', () => {
  const rng = new RNG(3);
  const seen = { cache: new Set(), hoard: new Set(), vault: new Set() };
  for (let i = 0; i < 400; i++) for (const t of Object.keys(seen)) seen[t].add(rollChestCount(t, rng));
  assert.deepEqual([...seen.cache].sort(), [1]);
  assert.deepEqual([...seen.hoard].sort(), [1, 2]);
  assert.deepEqual([...seen.vault].sort(), [2, 3]);
});

test('item-level offsets (opts.itemLevel, not a shifted depth): Cache max(1,d-1)±1, Hoard d±1, Vault d+1..2', () => {
  const rng = new RNG(11);
  for (const depth of [1, 2, 3, 7, 15, 30]) {
    const seen = { cache: new Set(), hoard: new Set(), vault: new Set() };
    for (let i = 0; i < 300; i++) {
      for (const tier of Object.keys(seen)) {
        for (const it of rollChestContents(tier, depth, rng, { first: false })) seen[tier].add(it.itemLevel);
      }
    }
    const range = (a, b) => { const out = []; for (let v = Math.max(1, a); v <= b; v++) out.push(v); return out; };
    const cb = Math.max(1, depth - 1);
    assert.deepEqual([...seen.cache].sort((a, b) => a - b), range(cb - 1, cb + 1), `cache @${depth}`);
    assert.deepEqual([...seen.hoard].sort((a, b) => a - b), range(depth - 1, depth + 1), `hoard @${depth}`);
    assert.deepEqual([...seen.vault].sort((a, b) => a - b), [depth + 1, depth + 2], `vault @${depth}`);
    assert.equal(treasureItemLevel('vault', depth, new RNG(1)) > depth, true);
  }
});

test('rarity: the tier never moves the legendary gate; Vault chests hold >= 1 rare+ item; Hoard/Vault roll as elite', () => {
  const rng = new RNG(5);
  const idx = (it) => RARITY_ORDER.indexOf(it.rarity);
  let hoardRare = 0, cacheRare = 0, n = 0;
  for (let i = 0; i < 1500; i++) {
    // depth 3 < 4: no legendary even though a depth-3 Vault item is item level 4-5
    for (const tier of ['cache', 'hoard', 'vault']) for (const it of rollChestContents(tier, 3, rng, { first: false })) assert.notEqual(it.rarity, 'legendary');
    const v = rollChestContents('vault', 10, rng, { first: false });
    assert.ok(v.length >= 2 && v.length <= 3);
    assert.ok(idx(v[0]) >= RARITY_ORDER.indexOf('rare'), 'one item per Vault chest at minRarity rare');
    const h = rollChestContents('hoard', 10, rng, { first: false }), c = rollChestContents('cache', 10, rng, { first: false });
    assert.equal(h.length, 2); assert.equal(c.length, 1);
    hoardRare += h.filter((it) => idx(it) >= 2).length; cacheRare += c.filter((it) => idx(it) >= 2).length; n++;
  }
  assert.ok(hoardRare / (2 * n) > (cacheRare / n) * 1.5, `elite roll: hoard rare+ ${hoardRare / (2 * n)} vs cache ${cacheRare / n}`);
});

test('gold / potions go in the first chest only, at the table amounts; a hidden room adds exactly one generic book', () => {
  const rng = new RNG(8);
  const pot = { cache: 0, hoard: 0, vault: 0 };
  const K = 2000;
  for (let i = 0; i < K; i++) {
    for (const tier of ['cache', 'hoard', 'vault']) {
      const depth = 1 + (i % 25);
      const first = rollChestContents(tier, depth, rng, { first: true });
      const gold = first.filter((x) => x.type === 'gold');
      assert.equal(gold.length, 1);
      const [g0, g1] = CHEST_LOOT[tier].gold;
      assert.ok(gold[0].amount >= g0 * depth && gold[0].amount <= g1 * depth && gold[0].amount % depth === 0, `${tier} gold ${gold[0].amount} @${depth}`);
      if (first.some((x) => x.type === 'potion')) pot[tier]++;
      assert.ok(!first.some((x) => x.type === 'skillbook'), 'no book unless hidden');
      const later = rollChestContents(tier, depth, rng, { first: false });
      assert.ok(!later.some((x) => x.type === 'gold' || x.type === 'potion'));
    }
  }
  assert.equal(pot.cache, 0);
  assert.ok(near(pot.hoard / K, 0.5, 0.04), `hoard potion ${pot.hoard / K}`);
  assert.equal(pot.vault, K);
  for (const tier of ['cache', 'hoard']) {
    const withBook = rollChestContents(tier, 6, rng, { first: true, hidden: true });
    const books = withBook.filter((x) => x.type === 'skillbook');
    assert.equal(books.length, 1);
    assert.ok(books[0].skillId && books[0].rarity === 'rare', 'a generic-pool book');
    assert.equal(rollChestContents(tier, 6, rng, { first: false, hidden: true }).filter((x) => x.type === 'skillbook').length, 0);
  }
});

test('guard plans: Cache 0-2, Hoard 2-3 @25% elite, Vault min(6, 3+floor(d/8)) at depth+1 plus a warden', () => {
  const rng = new RNG(2);
  const c = new Set(), h = new Set();
  for (let i = 0; i < 300; i++) {
    const pc = treasureGuardPlan('cache', 7, rng); c.add(pc.count); assert.equal(pc.level, 7); assert.equal(pc.eliteChance, null); assert.ok(!pc.warden);
    const ph = treasureGuardPlan('hoard', 7, rng); h.add(ph.count); assert.equal(ph.level, 7); assert.equal(ph.eliteChance, 0.25);
  }
  assert.deepEqual([...c].sort(), [0, 1, 2]);
  assert.deepEqual([...h].sort(), [2, 3]);
  assert.deepEqual([3, 7, 8, 16, 24, 40].map((d) => treasureGuardPlan('vault', d, rng).count), [3, 3, 4, 5, 6, 6]);
  const pv = treasureGuardPlan('vault', 9, rng);
  assert.equal(pv.level, 10); assert.ok(pv.warden);
});

console.log('Treasure wings on real floors (§7 pipeline)');

test('every treasure room is a purpose-built single-door leaf; blocking its door cuts off only itself', () => {
  let wings = 0;
  for (const { map, depth } of MAPS) {
    const dE = bfs(map);
    for (const r of map.rooms.filter((r) => r.kind === 'treasure')) {
      wings++;
      assert.ok(r.id >= map.baseRoomCount, 'a wing is never a base room');
      assert.equal(r.doors.length, r.antechamber ? 2 : 1);
      assert.equal(r.size, { cache: 'small', hoard: 'medium', vault: r.antechamber ? 'medium' : 'large' }[r.treasureTier]);
      if (r.hidden) continue; // covered by unlock.test.js
      const d = r.doors[0]; // an antechamber: its door to the parent (placed first)
      const cut = bfs(map, new Set([map.idx(d.x, d.y)]));
      const own = new Set(map.roomTiles(r.id).map((t) => map.idx(t.x, t.y)));
      if (r.antechamber) for (const v of map.rooms) if (v.antechamberId === r.id) for (const t of map.roomTiles(v.id)) own.add(map.idx(t.x, t.y));
      for (let i = 0; i < map.tiles.length; i++) {
        if (dE[i] < 0 || cut[i] >= 0 || i === map.idx(d.x, d.y)) continue;
        if (own.has(i)) continue;
        const rr = map.roomAt(i % map.width, (i / map.width) | 0);
        assert.ok(r.antechamber && !rr, `depth ${depth}: blocking a ${r.treasureTier} door cut off other floor`);
      }
    }
  }
  assert.ok(wings > 400, `saw ${wings} wings`);
});

test('wings never touch the start / boss / merchant room, never hold stairs, and never change an entrance->exit route', () => {
  for (const { map } of MAPS) {
    const dE = bfs(map);
    const wingDoors = new Set();
    for (const r of map.rooms.filter((r) => r.kind === 'treasure')) {
      const d = r.secretDoor || r.doors[0];
      wingDoors.add(map.idx(d.x, d.y));
      for (const s of [map.entrance, ...map.exits]) assert.ok(!(s.front.x >= r.x && s.front.x < r.x + r.w && s.front.y >= r.y && s.front.y < r.y + r.h));
      // the parent side of the doorway: walk the corridor out to the first other room
      const seen = new Set([map.idx(d.x, d.y)]), q = [[d.x, d.y]];
      let parent = null;
      for (let qi = 0; qi < q.length && !parent; qi++) {
        for (const [dx, dy] of DIR4) {
          const nx = q[qi][0] + dx, ny = q[qi][1] + dy, ni = map.idx(nx, ny);
          if (seen.has(ni) || (!map.isWalkable(nx, ny))) continue;
          seen.add(ni);
          const rr = map.roomAt(nx, ny);
          if (rr && rr.id !== r.id) { parent = rr; break; }
          if (!rr) q.push([nx, ny]);
        }
      }
      if (r.hidden) continue; // its door is a wall: the walk above can't leave the doorway tile
      assert.ok(parent, 'wing has a parent');
      if (r.antechamberId != null) assert.equal(parent.id, r.antechamberId);
      else assert.ok(parent.kind === 'normal' || parent.kind === 'exit', `wing parent is a ${parent.kind} room`);
    }
    const dB = bfs(map, wingDoors);
    for (const ex of map.exits) assert.equal(dB[map.idx(ex.x, ex.y)], dE[map.idx(ex.x, ex.y)]);
  }
});

test('Vault antechambers: only from depth 6, only with a Vault (its leaf), at most 2 rooms per depth', () => {
  let antes = 0;
  for (const { map, depth } of MAPS) {
    const a = map.rooms.filter((r) => r.antechamber);
    const vaults = map.rooms.filter((r) => r.treasureTier === 'vault' && !r.antechamber);
    assert.ok(vaults.length <= 1);
    if (!a.length) continue;
    antes++;
    assert.ok(depth >= ANTECHAMBER_MIN_DEPTH);
    assert.equal(a.length, 1);
    assert.equal(vaults.length, 1);
    assert.equal(vaults[0].antechamberId, a[0].id);
    assert.ok(map.treasureRolled.antechamber);
    assert.equal((a[0].chests || []).length, 0);
  }
  assert.ok(antes >= 10, `saw ${antes} antechambers`);
});

test('placed wings match the roll (placement failures stay rare) and chests fit their tier', () => {
  let rolled = 0, placed = 0;
  for (const { map } of MAPS) {
    rolled += map.treasureRolled.tiers.length;
    const rooms = map.rooms.filter((r) => r.kind === 'treasure' && !r.antechamber);
    placed += rooms.length;
    for (const r of rooms) {
      const n = r.chests.length, [lo, hi] = { cache: [1, 1], hoard: [1, 2], vault: [2, 3] }[r.treasureTier];
      assert.ok(n >= lo && n <= hi, `${r.treasureTier} with ${n} chests`);
      for (const c of r.chests) assert.equal(map.roomAt(c.x, c.y), r);
    }
  }
  assert.ok(placed / rolled > 0.97, `placed ${placed}/${rolled}`);
});

test(`hidden-room modifier: one Cache/Hoard on ~${HIDDEN_ROOM_CHANCE * 100}% of depths from depth ${HIDDEN_ROOM_MIN_DEPTH} (not the old 45%)`, () => {
  assert.equal(HIDDEN_ROOM_CHANCE, 0.35);
  let n = 0, hidden = 0;
  for (let i = 0; i < 1200; i++) {
    const depth = 2 + (i % 28);
    const map = generateDungeon(depth, new RNG(90000 + i));
    n++;
    const h = map.rooms.filter((r) => r.hidden);
    assert.ok(h.length <= 1);
    if (h.length) { hidden++; assert.ok(h[0].treasureTier === 'cache' || h[0].treasureTier === 'hoard'); }
  }
  for (const { map, depth } of MAPS) if (depth < HIDDEN_ROOM_MIN_DEPTH) assert.equal(map.secrets.length, 0);
  assert.ok(hidden / n > 0.30 && hidden / n < 0.40, `hidden on ${(hidden / n * 100).toFixed(1)}% of depths`);
});

console.log('Merchant room + population');

test('merchant depth: a dedicated kind:"merchant" room, never a wing parent, with no spawn candidates', () => {
  for (const { map } of MAPS) {
    const m = map.rooms[map.merchantRoomId];
    assert.ok(m && (m.kind === 'merchant' || m.kind === 'start'));
    for (const c of map.spawnCandidates(new RNG(1), 5000, 0)) {
      assert.notEqual(c.roomId, m.id, 'spawn candidate in the merchant room');
      if (c.roomId != null) assert.notEqual(map.rooms[c.roomId].kind, 'treasure', 'spawn candidate in a wing');
    }
  }
  assert.equal(generateDungeon(4, new RNG(1)).merchantRoomId, null, 'no merchant room unless asked for');
});

test('populatedFloor = floor tiles outside the treasure wings and the merchant room', () => {
  for (const { map } of MAPS) {
    const skip = new Set(map.rooms.filter((r) => r.kind === 'treasure').map((r) => r.id));
    if (map.merchantRoomId != null) skip.add(map.merchantRoomId);
    let n = 0;
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      if (map.get(x, y) !== TILE.FLOOR) continue;
      const r = map.roomAt(x, y);
      if (!r || !skip.has(r.id)) n++;
    }
    assert.equal(map.populatedFloor, n);
  }
});

test('spawnEnemies: guards per tier from the depth pool, nobody in the merchant room / hidden room / on a chest', () => {
  for (const { map, depth, seed } of MAPS.slice(0, 150)) {
    const enemies = spawnEnemies({ map, depth, rng: new RNG(seed) });
    const pool = enemyPoolForDepth(depth);
    const chest = new Set(map.rooms.flatMap((r) => r.chests || []).map((c) => `${c.x},${c.y}`));
    for (const e of enemies) {
      const r = map.roomAt(e.x, e.y);
      assert.ok(!r || r.id !== map.merchantRoomId, 'enemy in the merchant room');
      assert.ok(!r || !r.hidden, 'enemy in a hidden room');
      assert.ok(!chest.has(`${e.x},${e.y}`), 'enemy on a chest');
      if (r && r.kind === 'treasure') assert.ok(e.treasureGuard, 'general spawn inside a wing');
      if (e.treasureGuard) assert.ok(pool.includes(e.type), 'guard from outside the depth pool');
    }
    // guards stand by the chests, not on the tiles they're opened from
    for (const r of map.rooms) for (const c of r.chests || []) {
      const sides = DIR4.filter(([dx, dy]) => map.isWalkable(c.x + dx, c.y + dy));
      assert.ok(sides.some(([dx, dy]) => !enemies.some((e) => e.x === c.x + dx && e.y === c.y + dy)), 'a chest boxed in by guards');
    }
    for (const v of map.rooms.filter((r) => r.treasureTier === 'vault' && !r.antechamber)) {
      const g = enemies.filter((e) => e.treasureGuard === 'vault');
      assert.equal(g.length, Math.min(6, 3 + Math.floor(depth / 8)) + 1);
      assert.ok(g.every((e) => e.level === depth + 1));
      const w = g.filter((e) => e.warden);
      assert.equal(w.length, 1); assert.ok(w[0].elite && /Vault Warden/.test(w[0].name));
      assert.equal(map.roomAt(w[0].x, w[0].y).id, v.id, 'warden waits in the Vault');
    }
  }
});

test('generation stays fast with wings (mean < 10 ms)', () => {
  const mean = MAPS.reduce((a, m) => a + m.ms, 0) / MAPS.length;
  assert.ok(mean < 10, `mean ${mean.toFixed(2)} ms`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
