// Plain-Node unit tests for weapon kinds / two-handed itemization, equip rules and gear comparison (DESIGN §17.9),
// plus the bow-driven damage rows and Bow Shot (§8, §9, §17.12). No framework, no build step:
//   node test/items.test.js      (or: npm test)
// Exits non-zero if any assertion fails.

import assert from 'node:assert/strict';
import { RNG } from '../public/js/core.js';
import {
  WEAPON_KIND_INFO, FALLBACK_WEAPON_INFO, weaponKindInfo, weaponClassOf, isTwoHanded, weaponTier, computeValue,
  TWO_HAND_STAT_MULT, TWO_HAND_VALUE_MULT, generateItem, equipItem, equipCheck, compareGear, equipUpgrades,
  enforceTwoHanded, INVENTORY_SIZE,
} from '../public/js/items.js';
import { createPlayer, recalcStats } from '../public/js/character.js';
import { createSkillState, useSkill, SKILL_DEFS, boltDamageRange, skillCooldown, effectiveCooldown } from '../public/js/skills.js';

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);

// Deterministic "rng": shuffle keeps pool order, rolls take the low end, no crits.
const orderRng = { shuffle: (a) => a, range: (a) => a, pick: (l) => l[0], chance: () => false, int: (a) => a };

let nextId = 1000;
const weapon = (weaponKind, min, max, extra = {}) => ({
  id: nextId++, name: `Test ${weaponKind}`, type: 'weapon', slot: 'weapon', weaponKind, rarity: 'common',
  stats: { damageMin: min, damageMax: max, ...extra }, value: 10,
});
const shield = (armor = 10) => ({ id: nextId++, name: 'Test Shield', type: 'offhand', slot: 'offhand', offhandKind: 'shield', rarity: 'common', stats: { armor }, value: 10 });
function player(equip = {}, inventory = []) {
  const p = createPlayer();
  p.skillState = createSkillState();
  Object.assign(p.equipment, equip);
  p.inventory = inventory;
  recalcStats(p);
  return p;
}

console.log('WEAPON_KIND_INFO');
test('melee1h kinds and bow have real entries; staff is deliberately absent (Phase 5)', () => {
  for (const k of ['sword', 'axe', 'mace', 'dagger']) {
    assert.deepEqual({ ...WEAPON_KIND_INFO[k] }, { hands: 1, cls: 'melee1h', role: 'melee', scale: 'str', defaultAttack: 'cleave' });
  }
  assert.deepEqual({ ...WEAPON_KIND_INFO.bow }, { hands: 2, cls: 'bow', role: 'ranged', scale: 'dex', defaultAttack: 'bowShot' });
  assert.ok(!('staff' in WEAPON_KIND_INFO));
});
test('unlisted kinds (staff), unknown kinds and unarmed use the melee1h fallback', () => {
  for (const k of ['staff', 'someFutureKind', undefined, null, 'toString']) assert.equal(weaponKindInfo(k), FALLBACK_WEAPON_INFO, String(k));
  assert.equal(weaponClassOf(null), 'melee1h');
  assert.equal(weaponClassOf(weapon('staff', 1, 2)), 'melee1h');
  assert.equal(isTwoHanded(weapon('staff', 1, 2)), false);
  assert.equal(isTwoHanded(null), false);
  assert.equal(isTwoHanded(weapon('bow', 1, 2)), true);
});

console.log('Two-handed itemization');
test('weaponTier: 2H = x1.5 stats, +1 affix; 1H and fallback = none', () => {
  assert.deepEqual(weaponTier('bow'), { statMult: 1.5, extraAffixes: 1 });
  assert.deepEqual(weaponTier('sword'), { statMult: 1, extraAffixes: 0 });
  assert.deepEqual(weaponTier('staff'), { statMult: 1, extraAffixes: 0 });
});
test('computeValue: 2H weapons x1.4, everything else unchanged', () => {
  const base = computeValue('weapon', 7, 'rare', 'sword');
  assert.equal(computeValue('weapon', 7, 'rare', 'bow'), Math.round((10 + 7 * 4) * 3.2 * TWO_HAND_VALUE_MULT));
  assert.equal(base, Math.round((10 + 7 * 4) * 3.2));
  assert.equal(computeValue('armor', 7, 'rare', 'bow'), computeValue('armor', 7, 'rare'), 'kind ignored for non-weapons');
});
test('generated bow: base stats x1.5 and value x1.4', () => {
  const L = 10;
  const bow = generateItem(5, orderRng, { type: 'weapon', weaponKind: 'bow', rarity: 'common', itemLevel: L });
  // With pool order, the one extra affix on a common bow is Vicious (damage only), so spellPower/dex are pure base.
  assert.equal(bow.stats.spellPower, Math.round((0.5 + L * 0.3) * TWO_HAND_STAT_MULT));
  assert.equal(bow.stats.dex, Math.round((1 + L * 0.5) * TWO_HAND_STAT_MULT * 10) / 10);
  assert.equal(bow.value, computeValue('weapon', L, 'common', 'bow'));
});
test('+1 affix at every rarity for bows (common bows get an affix, common swords none)', () => {
  const sword = generateItem(5, orderRng, { type: 'weapon', weaponKind: 'sword', rarity: 'common', itemLevel: 5 });
  assert.equal(sword.name, sword.baseName);
  const bow = generateItem(5, orderRng, { type: 'weapon', weaponKind: 'bow', rarity: 'common', itemLevel: 5 });
  assert.notEqual(bow.name, bow.baseName);
  const magicBow = generateItem(5, orderRng, { type: 'weapon', weaponKind: 'bow', rarity: 'magic', itemLevel: 5 });
  assert.equal(magicBow.name, `Vicious Piercing ${magicBow.baseName}`, '2 affixes = magic 1 + 1');
});

console.log('Piercing affix');
test('Piercing only ever rolls on bows', () => {
  const rng = new RNG(1234);
  let bowsWithPierce = 0;
  for (let i = 0; i < 3000; i++) {
    const it = generateItem(1 + (i % 20), rng, { type: i % 3 ? 'weapon' : undefined, rarity: 'epic' });
    if (it.stats.pierce) {
      assert.equal(it.weaponKind, 'bow', `${it.name} rolled pierce`);
      assert.equal(it.stats.pierce, 1);
      bowsWithPierce++;
    }
  }
  assert.ok(bowsWithPierce > 0, 'some epic bows should roll Piercing');
});
test('pierce from gear reaches player.stats.pierce', () => {
  assert.equal(player({ weapon: weapon('bow', 4, 8, { pierce: 1 }) }).stats.pierce, 1);
  assert.equal(player().stats.pierce, 0);
});

console.log('Damage rows (character.js)');
test('melee weapon: meleeMin/Max = weapon + str*0.8, ranged null', () => {
  const p = player({ weapon: weapon('sword', 4, 8) });
  assert.equal(p.stats.meleeMin, Math.round(4 + 5 * 0.8));
  assert.equal(p.stats.meleeMax, Math.round(8 + 5 * 0.8));
  assert.equal(p.stats.rangedMin, null);
  assert.equal(p.stats.rangedMax, null);
});
test('bow: rangedMin/Max = weapon + dex*0.8, melee null (bow damage no longer feeds melee)', () => {
  const p = player({ weapon: weapon('bow', 4, 8) });
  p.base.dex = 20; p.base.str = 50; recalcStats(p);
  assert.equal(p.stats.rangedMin, 4 + 16);
  assert.equal(p.stats.rangedMax, 8 + 16);
  assert.equal(p.stats.meleeMin, null);
  assert.equal(p.stats.meleeMax, null);
});
test('unarmed and staff stay melee (fallback)', () => {
  const u = player({ weapon: null });
  assert.ok(u.stats.meleeMin >= 1); assert.equal(u.stats.rangedMin, null);
  const s = player({ weapon: weapon('staff', 3, 5) });
  assert.equal(s.stats.meleeMin, Math.round(3 + 4)); assert.equal(s.stats.rangedMin, null);
});
test('Arcane Bolt damage comes from spell power only (no dex)', () => {
  const p = player();
  const lowDex = boltDamageRange(p);
  p.base.dex = 200; recalcStats(p);
  assert.deepEqual(boltDamageRange(p), lowDex);
  assert.equal(lowDex.min, Math.max(1, Math.round(p.stats.spellPower * 0.8)));
  assert.equal(lowDex.max, Math.max(lowDex.min + 1, Math.round(p.stats.spellPower * 1.2)));
});

console.log('Two-handed equip rules');
test('equipping a bow evicts the off-hand into the bag, with a log line', () => {
  const sh = shield(), bow = weapon('bow', 5, 9), sword = weapon('sword', 3, 5);
  const p = player({ weapon: sword, offhand: sh }, [bow]);
  const logs = [];
  assert.ok(equipItem(p, bow, (t) => logs.push(t)));
  assert.equal(p.equipment.weapon, bow);
  assert.equal(p.equipment.offhand, null);
  assert.ok(p.inventory.includes(sh) && p.inventory.includes(sword));
  assert.deepEqual(logs, ['Test Shield unequipped (two-handed weapon)']);
});
test('bag full: the bow is refused and nothing changes', () => {
  const sh = shield(), bow = weapon('bow', 5, 9), sword = weapon('sword', 3, 5);
  const bag = [bow];
  while (bag.length < INVENTORY_SIZE) bag.push(weapon('dagger', 1, 2));
  const p = player({ weapon: sword, offhand: sh }, bag);
  const logs = [];
  assert.equal(equipItem(p, bow, (t) => logs.push(t)), false);
  assert.equal(p.equipment.weapon, sword);
  assert.equal(p.equipment.offhand, sh);
  assert.equal(p.inventory.length, INVENTORY_SIZE);
  assert.deepEqual(logs, ['Bag full: no room for your Test Shield']);
});
test('bag full but unarmed: bow fits (the bow\'s own cell holds the shield)', () => {
  const sh = shield(), bow = weapon('bow', 5, 9);
  const bag = [bow];
  while (bag.length < INVENTORY_SIZE) bag.push(weapon('dagger', 1, 2));
  const p = player({ weapon: null, offhand: sh }, bag);
  assert.ok(equipCheck(p, bow).ok);
  assert.ok(equipItem(p, bow));
});
test('equipping an off-hand while a bow is held is refused outright', () => {
  const sh = shield(), bow = weapon('bow', 5, 9);
  const p = player({ weapon: bow }, [sh]);
  const logs = [];
  assert.equal(equipItem(p, sh, (t) => logs.push(t)), false);
  assert.equal(p.equipment.weapon, bow);
  assert.equal(p.equipment.offhand, null);
  assert.deepEqual(logs, ["Can't equip: Test bow is two-handed"]);
});
test('enforceTwoHanded (old saves: bow + off-hand) moves the off-hand to the bag', () => {
  const sh = shield(), bow = weapon('bow', 5, 9);
  const p = player({ weapon: bow, offhand: sh }, []);
  assert.equal(enforceTwoHanded(p), null);
  assert.equal(p.equipment.offhand, null);
  assert.ok(p.inventory.includes(sh));
  const full = player({ weapon: bow, offhand: sh }, Array.from({ length: INVENTORY_SIZE }, () => weapon('dagger', 1, 2)));
  assert.equal(enforceTwoHanded(full), sh, 'bag full: returned for the caller to drop');
  assert.equal(full.equipment.offhand, null);
});

console.log('compareGear / quick-equip');
test('melee -> bow is a class swap (⇄), never up/down, and lists the evicted off-hand', () => {
  const sh = shield(30), bow = weapon('bow', 50, 90), sword = weapon('sword', 3, 5);
  const p = player({ weapon: sword, offhand: sh }, [bow]);
  const gc = compareGear(bow, p);
  assert.equal(gc.verdict, 'swap');
  assert.equal(gc.classSwap, true);
  assert.equal(gc.toClass, 'bow');
  assert.equal(gc.evicts, sh);
  assert.equal(gc.after.meleeMin, null);
  assert.ok(gc.after.rangedMin > 0);
  assert.ok(gc.after.defense < gc.before.defense, 'lost shield armor shows up in the after-stats');
});
test('a 2H weapon compares against weapon + current off-hand (lost off-hand counts)', () => {
  // Legacy state (bow + shield): a slightly better bow would be an upgrade alone, but it also costs the big shield.
  const sh = shield(60), bow = weapon('bow', 10, 14), better = weapon('bow', 11, 15);
  const p = player({ weapon: bow, offhand: sh }, [better]);
  const gc = compareGear(better, p);
  assert.equal(gc.evicts, sh);
  assert.notEqual(gc.verdict, 'up');
  assert.ok(gc.score < 0);
  const noShield = player({ weapon: bow }, [better]);
  assert.equal(compareGear(better, noShield).verdict, 'up');
});
test('null damage rows are "not applicable", not 0 (bow vs bow compares ranged only)', () => {
  const p = player({ weapon: weapon('bow', 10, 14) });
  const worse = weapon('bow', 6, 9);
  const gc = compareGear(worse, p);
  assert.equal(gc.verdict, 'down');
  assert.equal(gc.before.meleeMin, null);
});
test('an off-hand while a bow is held is "blocked" (no badge, not an upgrade)', () => {
  const p = player({ weapon: weapon('bow', 10, 14) }, [shield(50)]);
  const gc = compareGear(p.inventory[0], p);
  assert.equal(gc.verdict, 'blocked');
});
test('quick-equip stays within the weapon class and skips the off-hand under a 2H weapon', () => {
  const sword = weapon('sword', 3, 5), axe = weapon('axe', 5, 8), bigBow = weapon('bow', 80, 120);
  const p = player({ weapon: sword }, [bigBow, axe]);
  const done = equipUpgrades(p);
  assert.deepEqual(done, [axe]);
  assert.equal(p.equipment.weapon, axe);

  const bow = weapon('bow', 10, 14), better = weapon('bow', 12, 16), sh = shield(40), sword2 = weapon('sword', 90, 120);
  const q = player({ weapon: bow }, [sh, better, sword2]);
  const done2 = equipUpgrades(q);
  assert.deepEqual(done2, [better]);
  assert.equal(q.equipment.offhand, null);
});

console.log('Bow Shot');
function bowGame(rank = 1, extra = {}) {
  const p = player({ weapon: weapon('bow', 10, 20, extra) });
  p.skillState.known.bowShot = rank;
  p.fx = p.x = 3; p.fy = p.y = 3; p.facing = { x: 1, y: 0 };
  const shots = [];
  const game = {
    player: p, rng: new RNG(7), bus: { emit() {} },
    spawnProjectile: (pr) => shots.push(pr), enemiesInRadius: () => [], hasLineOfSight: () => true,
  };
  return { p, game, shots };
}
test('slot 1 with a bow casts Bow Shot: an armor-reduced arrow with a point-blank floor, no mana', () => {
  const { p, game, shots } = bowGame();
  const mana = p.mana;
  assert.ok(useSkill(game, 0));
  assert.equal(shots.length, 1);
  const a = shots[0];
  assert.equal(a.kind, 'arrow');
  assert.equal(a.applyDefense, true);
  assert.equal(a.owner, 'player');
  assert.deepEqual([a.ox, a.oy, a.dx, a.dy], [3, 3, 1, 0]);
  assert.equal(a.pointBlankDamage, Math.min(a.damage, p.stats.rangedMin));
  assert.ok(a.damage >= Math.floor(p.stats.rangedMin * 0.85) && a.damage <= Math.ceil(p.stats.rangedMax * 1.15 * p.stats.critMult));
  assert.equal(a.slow, null, 'no slow before rank 3');
  assert.equal(p.mana, mana);
  close(skillCooldown(p, 'bowShot').max, 0.45);
  close(SKILL_DEFS.bowShot.baseCooldown, SKILL_DEFS.cleave.baseCooldown);
});
test('rank 3+ arrows carry an applySlow-compatible ~22% / 0.6s slow', () => {
  const { game, shots } = bowGame(3);
  useSkill(game, 0);
  assert.deepEqual(shots[0].slow, { pct: 0.22, dur: 0.6 });
  close(skillCooldown(game.player, 'bowShot').max, effectiveCooldown(SKILL_DEFS.bowShot, 3, game.player));
});
test('Piercing gear adds to the arrow\'s pierce', () => {
  const { game, shots } = bowGame(1, { pierce: 1 });
  useSkill(game, 0);
  assert.equal(shots[0].pierce, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
