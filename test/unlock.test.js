// Plain-Node unit tests for skill unlocking (DESIGN §17.11): the six unlockable skills, skill books, boss-kill book
// drops, learnSkill's new-skill point / duplicate rank, and the hidden treasure-room map constraint.
//   node test/unlock.test.js      (or: npm test)
import assert from 'node:assert/strict';
import { RNG, TILE } from '../public/js/core.js';
import {
  SKILL_DEFS, CATEGORY_DEFAULT, CLASS_DEFAULT_ATTACK, MAX_SKILL_RANK, validateSkillRegistry, createSkillState,
  skillRank, knownSkills, learnSkill, assignSkill, activeSkill, useSkill, skillCooldown,
  GENERIC_BOOK_POOL, BOSS_SKILL_BOOKS, bossBookDrops, REPEAT_BOSS_GENERIC_BOOK_CHANCE, REPEAT_BOSS_UNIQUE_BOOK_CHANCE,
  readSkillBook, chainTargets, boltDamageRange,
} from '../public/js/skills.js';
import { createSkillBook, useItem, rollLoot, generateItem, itemTooltip, sellValue } from '../public/js/items.js';
import { createPlayer, recalcStats } from '../public/js/character.js';
import { createEnemy } from '../public/js/enemies.js';
import { generateDungeon, HIDDEN_ROOM_MIN_DEPTH } from '../public/js/map.js';

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.stack}`); }
}
const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a}`);

const NEW_SKILLS = ['volley', 'fireball', 'chainLightning', 'globBurst', 'boneCharge', 'blink'];

function freshPlayer(weaponKind, lo = 10, hi = 14) {
  const p = createPlayer();
  p.skillState = createSkillState();
  if (weaponKind) p.equipment.weapon = { id: 1, type: 'weapon', slot: 'weapon', weaponKind, stats: { damageMin: lo, damageMax: hi } };
  recalcStats(p);
  p.hp = p.stats.maxHp; p.mana = p.stats.maxMana = 999;
  p.x = p.fx = 5; p.y = p.fy = 5; p.facing = { x: 1, y: 0 }; p.aim = null;
  return p;
}
// A tiny open-floor world: walls outside [0, size), and on any `walls` tiles.
function world(p, enemies = [], { size = 20, walls = [] } = {}) {
  const wallSet = new Set(walls.map(([x, y]) => `${x},${y}`));
  const shots = [], hits = [], fx = [], floats = [], logs = [], events = [];
  const walk = (x, y) => x >= 0 && y >= 0 && x < size && y < size && !wallSet.has(`${x},${y}`);
  const game = {
    player: p, rng: new RNG(3), depth: 3,
    bus: { emit: (e, d) => events.push([e, d]) },
    isWalkable: walk,
    enemyAt: (x, y) => enemies.find((e) => !e.dead && e.x === x && e.y === y) || null,
    isFree(x, y) { return walk(x, y) && !this.enemyAt(x, y) && !(p.x === x && p.y === y); },
    enemiesInRadius: (x, y, r) => enemies.filter((e) => !e.dead && Math.hypot(e.x - x, e.y - y) <= r),
    hasLineOfSight: (x0, y0, x1, y1) => {
      // straight sampled line vs the wall set (good enough for these layouts)
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 4);
      for (let i = 1; i < n; i++) {
        const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n);
        if (!walk(x, y)) return false;
      }
      return true;
    },
    damageEnemy(e, amount, opts) {
      hits.push({ e, amount, opts });
      e.hp -= amount;
      if (e.hp <= 0) { e.dead = true; return; }
      const kb = opts && opts.knockback;
      if (kb && e.behavior !== 'boss' && this.isFree(e.x + kb.x, e.y + kb.y)) { e.x += kb.x; e.y += kb.y; }
    },
    spawnProjectile: (pr) => shots.push(pr),
    effect: (t, x, y, o) => fx.push({ t, x, y, o }),
    floatText: (x, y, text) => floats.push(text),
    log: (t) => logs.push(t),
  };
  return { game, shots, hits, fx, floats, logs, events };
}
const foe = (id, x, y, extra = {}) => ({ id, x, y, hp: 999, defense: 0, dead: false, behavior: 'melee', ...extra });

// ---------------------------------------------------------------------------
console.log('Registry');
test('registry still validates (guaranteed-skill rule intact)', () => assert.deepEqual(validateSkillRegistry(), []));
test('the six unlockable skills exist with the right categories / classes / elements', () => {
  const want = {
    volley: ['attack', 'physical'], fireball: ['spell', 'fire'], chainLightning: ['special', 'lightning'],
    globBurst: ['special', 'poison'], boneCharge: ['movement', 'physical'], blink: ['movement', 'arcane'],
  };
  for (const [id, [cat, el]] of Object.entries(want)) {
    assert.ok(SKILL_DEFS[id], id);
    assert.equal(SKILL_DEFS[id].category, cat, id);
    assert.equal(SKILL_DEFS[id].element, el, id);
    assert.ok(SKILL_DEFS[id].unlock, `${id} is unlockable`);
  }
  assert.deepEqual(SKILL_DEFS.volley.classes, ['bow']);
  for (const id of NEW_SKILLS.filter((i) => i !== 'volley')) assert.ok(!SKILL_DEFS[id].classes, `${id} unrestricted`);
});
test('none are known by a fresh player, and defaults are untouched', () => {
  const p = freshPlayer();
  for (const id of NEW_SKILLS) assert.equal(skillRank(p, id), 0, id);
  assert.deepEqual(CATEGORY_DEFAULT, { spell: 'arcaneBolt', special: 'frostNova', movement: 'shadowDash' });
  for (const id of NEW_SKILLS) assert.ok(!Object.values(CLASS_DEFAULT_ATTACK).includes(id));
});
test('validator rejects a default that is also unlockable', () => {
  SKILL_DEFS.frostNova.unlock = 'generic';
  try { assert.ok(validateSkillRegistry().some((e) => e.includes('frostNova'))); } finally { delete SKILL_DEFS.frostNova.unlock; }
});
test('book pools: 4 generic (one per slot category), 2 boss-unique', () => {
  assert.deepEqual([...GENERIC_BOOK_POOL].sort(), ['blink', 'chainLightning', 'fireball', 'volley']);
  assert.deepEqual(new Set(GENERIC_BOOK_POOL.map((id) => SKILL_DEFS[id].category)), new Set(['attack', 'spell', 'special', 'movement']));
  assert.deepEqual({ ...BOSS_SKILL_BOOKS }, { slime_king: 'globBurst', bone_tyrant: 'boneCharge' });
});

// ---------------------------------------------------------------------------
console.log('learnSkill: new-skill point / duplicate rank');
test('new skill: rank 1 + 1 free skill point; duplicate: +1 rank, no point; capped at 5 (not consumed)', () => {
  const p = freshPlayer();
  p.skillPoints = 0;
  let r = readSkillBook(p, 'fireball');
  assert.deepEqual([r.ok, r.isNew, r.rank, p.skillPoints], [true, true, 1, 1]);
  r = readSkillBook(p, 'fireball');
  assert.deepEqual([r.ok, r.isNew, r.rank, p.skillPoints], [true, false, 2, 1]);
  while (learnSkill(p, 'fireball'));
  assert.equal(skillRank(p, 'fireball'), MAX_SKILL_RANK);
  r = readSkillBook(p, 'fireball');
  assert.deepEqual([r.ok, r.reason, p.skillPoints], [false, 'max', 1]);
});
test('a learned skill becomes pickable for its slot', () => {
  const p = freshPlayer();
  learnSkill(p, 'blink');
  assert.deepEqual(knownSkills(p, 'movement').map((d) => d.id), ['shadowDash', 'blink']);
  assert.ok(assignSkill(p, 'movement', 'blink'));
  assert.equal(activeSkill(p, 3).id, 'blink');
});

// ---------------------------------------------------------------------------
console.log('Skill book item');
test('createSkillBook: generic = rare, boss-unique = legendary, skillId kept, sellable', () => {
  const g = createSkillBook('volley', 4), u = createSkillBook('globBurst', 5);
  assert.deepEqual([g.type, g.rarity, g.skillId, g.slot], ['skillbook', 'rare', 'volley', null]);
  assert.equal(u.rarity, 'legendary');
  assert.ok(g.name.includes('Volley'));
  assert.ok(u.value > g.value && sellValue(g) > 0);
});
test('tooltip: category + weapon requirement, and what reading it does', () => {
  const p = freshPlayer();
  const html = itemTooltip(createSkillBook('volley'), p);
  assert.ok(html.includes('Attack · Requires Bow'), html);
  assert.ok(html.includes('gain 1 free skill point'));
  assert.ok(itemTooltip(createSkillBook('blink'), p).includes('Movement · Any weapon'));
  learnSkill(p, 'blink');
  assert.ok(itemTooltip(createSkillBook('blink'), p).includes('Known at rank 1. Read: rank 2.'));
});
test('useItem reads a book: learns it, +1 point, book consumed; duplicate +1 rank; max rank not consumed', () => {
  const p = freshPlayer();
  p.skillPoints = 0;
  const { game, events } = world(p);
  const b1 = createSkillBook('chainLightning'), b2 = createSkillBook('chainLightning');
  p.inventory = [b1, b2];
  assert.ok(useItem(game, b1));
  assert.deepEqual([skillRank(p, 'chainLightning'), p.skillPoints, p.inventory.length], [1, 1, 1]);
  assert.ok(useItem(game, b2));
  assert.deepEqual([skillRank(p, 'chainLightning'), p.skillPoints, p.inventory.length], [2, 1, 0]);
  assert.ok(events.some(([e, d]) => e === 'skillLearned' && d.isNew));
  p.skillState.known.chainLightning = MAX_SKILL_RANK;
  const b3 = createSkillBook('chainLightning');
  p.inventory = [b3];
  assert.equal(useItem(game, b3), false);
  assert.equal(p.inventory.length, 1, 'kept in the bag');
});
test('skill books are never generated as random loot / merchant stock', () => {
  const rng = new RNG(99);
  for (let i = 0; i < 2000; i++) assert.notEqual(generateItem(1 + (i % 30), rng).type, 'skillbook');
});

// ---------------------------------------------------------------------------
console.log('Boss book drops');
const fixedRng = (seq) => { let i = 0; return { chance: (pr) => seq[i++ % seq.length] < pr, pick: (a) => a[0] }; };
test('first kill of a boss type: its unique book, guaranteed', () => {
  assert.deepEqual(bossBookDrops('slime_king', [], new RNG(1)), ['globBurst']);
  assert.deepEqual(bossBookDrops('bone_tyrant', ['slime_king'], new RNG(1)), ['boneCharge']);
});
test('repeat kill: generic roll then unique roll, independent', () => {
  assert.deepEqual(bossBookDrops('slime_king', ['slime_king'], fixedRng([0.99, 0.99])), []);
  assert.deepEqual(bossBookDrops('slime_king', ['slime_king'], fixedRng([0.1, 0.99])), [GENERIC_BOOK_POOL[0]]);
  assert.deepEqual(bossBookDrops('slime_king', ['slime_king'], fixedRng([0.99, 0.01])), ['globBurst']);
  assert.deepEqual(bossBookDrops('slime_king', ['slime_king'], fixedRng([0.1, 0.01])), [GENERIC_BOOK_POOL[0], 'globBurst']);
});
test('repeat-kill rates are ~20% generic and ~3% unique', () => {
  const rng = new RNG(12345);
  let gen = 0, uni = 0;
  const N = 40000;
  for (let i = 0; i < N; i++) {
    const d = bossBookDrops('bone_tyrant', ['bone_tyrant'], rng);
    if (d.some((id) => GENERIC_BOOK_POOL.includes(id))) gen++;
    if (d.includes('boneCharge')) uni++;
  }
  close(gen / N, REPEAT_BOSS_GENERIC_BOOK_CHANCE, 0.01, 'generic');
  close(uni / N, REPEAT_BOSS_UNIQUE_BOOK_CHANCE, 0.005, 'unique');
  close(REPEAT_BOSS_GENERIC_BOOK_CHANCE, 0.2); close(REPEAT_BOSS_UNIQUE_BOOK_CHANCE, 0.03);
});
test('rollLoot (the boss loot path) adds the book on a first kill, keeps the guaranteed rare+ item', () => {
  const boss = createEnemy('slime_king', 1, 1, 5, new RNG(2));
  const loot = rollLoot(boss, 5, new RNG(4), { bossesDefeated: [] });
  const books = loot.filter((i) => i.type === 'skillbook');
  assert.deepEqual(books.map((b) => [b.skillId, b.rarity]), [['globBurst', 'legendary']]);
  assert.ok(loot.some((i) => ['rare', 'epic', 'legendary'].includes(i.rarity) && i.type !== 'skillbook'));
  const regular = createEnemy('slime', 1, 1, 5, new RNG(2));
  for (let s = 0; s < 200; s++) assert.ok(!rollLoot(regular, 5, new RNG(s), { bossesDefeated: [] }).some((i) => i.type === 'skillbook'));
});

// ---------------------------------------------------------------------------
console.log('Casting the new skills');
test('Volley: 3 arrows fanned, 60% bow damage, armor-reduced, ONE shared hit set, longer cooldown than Bow Shot', () => {
  const p = freshPlayer('bow');
  learnSkill(p, 'volley');
  assignSkill(p, 'bow', 'volley');
  const { game, shots } = world(p);
  assert.ok(useSkill(game, 0));
  assert.equal(shots.length, 3);
  assert.ok(shots.every((s) => s.hit === shots[0].hit && s.hit instanceof Set), 'shared hit set');
  assert.ok(shots.every((s) => s.applyDefense && s.kind === 'arrow' && s.pointBlankDamage <= s.damage));
  assert.ok(shots[0].damage <= Math.ceil(p.stats.rangedMax * 0.6 * 1.15 * p.stats.critMult));
  const angles = shots.map((s) => Math.atan2(s.dy, s.dx)).sort((a, b) => a - b);
  assert.ok(angles[0] < 0 && angles[2] > 0 && Math.abs(angles[1]) < 1e-9, 'fan centred on facing');
  assert.ok(skillCooldown(p, 'volley').max > SKILL_DEFS.bowShot.baseCooldown);
  p.skillState.known.volley = 3;
  p.skillCooldowns = {};
  shots.length = 0;
  useSkill(game, 0);
  assert.equal(shots.length, 5, 'rank 3: 5 arrows');
});
test('Fireball: a fire spell projectile (no armor) with an explode radius; rank 3 widens it', () => {
  const p = freshPlayer();
  learnSkill(p, 'fireball'); assignSkill(p, 'spell', 'fireball');
  const { game, shots } = world(p);
  const mana = p.mana;
  assert.ok(useSkill(game, 1));
  const f = shots[0];
  assert.deepEqual([f.kind, f.element, !!f.applyDefense, f.explode.radius], ['fireball', 'fire', false, 1.5]);
  const { min, max } = boltDamageRange(p);
  assert.ok(f.damage >= Math.floor(min * 0.85) && f.damage <= Math.ceil(max * 1.15 * p.stats.critMult));
  assert.equal(p.mana, mana - SKILL_DEFS.fireball.manaCost);
  p.skillState.known.fireball = 3; p.skillCooldowns = {}; shots.length = 0;
  useSkill(game, 1);
  assert.equal(shots[0].explode.radius, 2);
});
test('Chain Lightning: nearest target, then jumps (in range, not repeated), falling damage; no target = no cost', () => {
  const p = freshPlayer();
  learnSkill(p, 'chainLightning'); assignSkill(p, 'special', 'chainLightning');
  const enemies = [foe(1, 8, 5), foe(2, 10, 5), foe(3, 12, 6), foe(4, 18, 18), foe(5, 13, 8)];
  const { game, hits, fx } = world(p, enemies);
  const order = chainTargets(game, p, 4).map((e) => e.id);
  assert.deepEqual(order, [1, 2, 3, 5]);
  assert.ok(useSkill(game, 2));
  assert.deepEqual(hits.map((h) => h.e.id), [1, 2, 3, 5], 'rank 1: 1 + 3 jumps');
  assert.ok(hits.every((h) => h.opts.element === 'lightning'));
  assert.ok(hits[0].amount >= hits[3].amount);
  assert.ok(fx.some((f) => f.t === 'chain' && f.o.points.length === 5));
  // nothing in range: false, no mana spent, no cooldown
  const p2 = freshPlayer(); learnSkill(p2, 'chainLightning'); assignSkill(p2, 'special', 'chainLightning');
  const w2 = world(p2, [foe(9, 18, 18)]);
  const mana = p2.mana;
  assert.equal(useSkill(w2.game, 2), false);
  assert.equal(p2.mana, mana);
  assert.equal(skillCooldown(p2, 'chainLightning'), null);
});
test('Chain Lightning does not arc through walls', () => {
  const p = freshPlayer();
  const walls = [[9, 3], [9, 4], [9, 5], [9, 6], [9, 7]];
  const { game } = world(p, [foe(1, 7, 5), foe(2, 10, 5)], { walls });
  assert.deepEqual(chainTargets(game, p, 4).map((e) => e.id), [1]);
});
test('Glob Burst: ring of 8 poison globs, shared hit set, each slowing 35% for 2s; rank 3 = 12', () => {
  const p = freshPlayer();
  learnSkill(p, 'globBurst'); assignSkill(p, 'special', 'globBurst');
  const { game, shots } = world(p);
  assert.ok(useSkill(game, 2));
  assert.equal(shots.length, 8);
  assert.ok(shots.every((s) => s.element === 'poison' && s.slow.pct === 0.35 && s.slow.dur === 2 && s.hit === shots[0].hit));
  const sumX = shots.reduce((a, s) => a + s.dx, 0), sumY = shots.reduce((a, s) => a + s.dy, 0);
  assert.ok(Math.abs(sumX) < 1e-9 && Math.abs(sumY) < 1e-9, 'evenly spaced ring');
  p.skillState.known.globBurst = 3; p.skillCooldowns = {}; shots.length = 0;
  useSkill(game, 2);
  assert.equal(shots.length, 12);
});
test('Bone Charge: moves up to 4 tiles, damages and shoves aside enemies in the lane, no invulnerability', () => {
  const p = freshPlayer('sword');
  learnSkill(p, 'boneCharge'); assignSkill(p, 'movement', 'boneCharge');
  const e = foe(1, 7, 5);
  const { game, hits } = world(p, [e]);
  assert.ok(useSkill(game, 3));
  assert.deepEqual([p.x, p.y], [9, 5]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opts.source, 'melee');
  assert.notEqual(e.y, 5, 'shoved off the lane');
  assert.equal(e.x, 7);
  assert.equal(p.invuln || 0, 0);
});
test('Bone Charge stops in front of an enemy it can\'t shove (a boss), still hitting it', () => {
  const p = freshPlayer('sword');
  learnSkill(p, 'boneCharge'); assignSkill(p, 'movement', 'boneCharge');
  const boss = foe(1, 8, 5, { behavior: 'boss' });
  const { game, hits } = world(p, [boss]);
  assert.ok(useSkill(game, 3));
  assert.deepEqual([p.x, p.y, boss.x, boss.y], [7, 5, 8, 5]);
  assert.equal(hits.length, 1);
});
test('Bone Charge into a wall with nothing to hit costs nothing', () => {
  const p = freshPlayer('sword');
  learnSkill(p, 'boneCharge'); assignSkill(p, 'movement', 'boneCharge');
  const { game } = world(p, [], { walls: [[6, 5]] });
  const mana = p.mana;
  assert.equal(useSkill(game, 3), false);
  assert.equal(p.mana, mana);
});
test('Blink: instant hop along the aim, over an enemy (Shadow Dash would stop), never through a wall', () => {
  const p = freshPlayer();
  learnSkill(p, 'blink'); assignSkill(p, 'movement', 'blink');
  const { game, fx } = world(p, [foe(1, 6, 5)]);
  assert.ok(useSkill(game, 3));
  assert.deepEqual([p.x, p.y, p.fx, p.fy], [7, 5, 7, 5]);
  assert.equal(p.invuln || 0, 0);
  assert.ok(fx.some((f) => f.t === 'blink'));
  assert.ok(skillCooldown(p, 'blink').max < SKILL_DEFS.shadowDash.baseCooldown);
  const p2 = freshPlayer(); learnSkill(p2, 'blink'); assignSkill(p2, 'movement', 'blink');
  const w2 = world(p2, [], { walls: [[6, 4], [6, 5], [6, 6]] });
  assert.equal(useSkill(w2.game, 3), false);
  assert.deepEqual([p2.x, p2.y], [5, 5]);
});

// ---------------------------------------------------------------------------
console.log('Hidden treasure rooms (map generation)');
function reachable(map, sx, sy) {
  const seen = new Uint8Array(map.width * map.height);
  const q = [[sx, sy]]; seen[map.idx(sx, sy)] = 1;
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!map.isWalkable(nx, ny) || seen[map.idx(nx, ny)]) continue;
      seen[map.idx(nx, ny)] = 1; q.push([nx, ny]);
    }
  }
  return seen;
}
test('treasure rooms are single-door leaves; a hidden one seals exactly its doorway and cuts off nothing else', () => {
  let hiddenCount = 0, treasureCount = 0;
  for (let i = 0; i < 160; i++) {
    const depth = 1 + (i % 22);
    const map = generateDungeon(depth, new RNG(777 + i));
    const wings = map.rooms.filter((r) => r.kind === 'treasure');
    treasureCount += wings.length;
    for (const r of wings) assert.equal(r.doors.length, r.antechamber ? 2 : 1, 'a wing is a single-door leaf (an antechamber: two)');
    const hidden = wings.filter((r) => r.hidden);
    assert.ok(hidden.length <= 1, 'at most one hidden room');
    if (!hidden.length) { assert.equal(map.secrets.length, 0); continue; }
    const t = hidden[0];
    hiddenCount++;
    assert.ok(depth >= HIDDEN_ROOM_MIN_DEPTH);
    assert.ok(t.treasureTier === 'cache' || t.treasureTier === 'hoard', 'never a Vault');
    assert.equal(map.secrets.length, 1);
    const sc = map.secrets[0];
    assert.deepEqual([sc.x, sc.y], [t.doors[0].x, t.doors[0].y]);
    assert.equal(map.get(sc.x, sc.y), TILE.WALL, 'sealed');
    // Before the reveal: everything except the treasure room is reachable from the entrance.
    const ent = map.entrance.front;
    const before = reachable(map, ent.x, ent.y);
    assert.equal(before[map.idx(t.cx, t.cy)], 0, 'treasure room sealed off');
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      if (!map.isWalkable(x, y) || before[map.idx(x, y)]) continue;
      const inRoom = x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h;
      assert.ok(inRoom, `tile ${x},${y} outside the treasure room was cut off`);
    }
    // No spawn candidate lands inside it.
    for (const c of map.spawnCandidates(new RNG(1), 400, 0)) assert.notEqual(c.roomId, t.id);
    // Reveal: becomes a door and the whole map connects.
    assert.ok(map.revealSecret(sc.x, sc.y));
    assert.equal(map.get(sc.x, sc.y), TILE.DOOR);
    assert.equal(map.revealSecret(sc.x, sc.y), null, 'only once');
    const after = reachable(map, ent.x, ent.y);
    assert.equal(after[map.idx(t.cx, t.cy)], 1);
  }
  assert.ok(hiddenCount >= 20, `saw ${hiddenCount} hidden rooms`);
  assert.ok(treasureCount > hiddenCount);
});
test('treasure rooms are never the start / exit / boss room (no stairs in them; boss floors keep a boss room)', () => {
  for (let i = 0; i < 60; i++) {
    const depth = 5 + 5 * (i % 3);
    const map = generateDungeon(depth, new RNG(31 + i));
    assert.ok(map.rooms.some((r) => r.kind === 'boss'));
    for (const t of map.rooms.filter((r) => r.kind === 'treasure')) {
      for (const s of [map.entrance, ...map.exits]) {
        const f = s.front;
        assert.ok(!(f.x >= t.x && f.x < t.x + t.w && f.y >= t.y && f.y < t.y + t.h), 'stairs open into a treasure room');
      }
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
