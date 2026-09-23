// Plain-Node unit tests for hit-time combat math (DESIGN §6.1, §10, §17.12): slow strength (applySlow /
// effMoveCooldown) and weapon-role projectile resolution (point-blank + armor). No framework, no build step:
//   node test/combat.test.js      (or: npm test)
// Exits non-zero if any assertion fails.

import assert from 'node:assert/strict';
import { applySlow, effMoveCooldown, MAX_SLOW_PCT, createEnemy, ENEMY_TYPES } from '../public/js/enemies.js';
import {
  computeDamage, mitigate, reduceByDefense, projectileHitDamage, POINT_BLANK_RANGE, createPlayer, recalcStats,
} from '../public/js/character.js';
import { createSkillState, useSkill } from '../public/js/skills.js';

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);
const fakeRng = { range: (a) => a, chance: () => false, pick: (l) => l[0] };
const enemy = (typeId = 'goblin') => createEnemy(typeId, 5, 5, 1, fakeRng, { elite: false });
const moveCd = (e) => effMoveCooldown(e, ENEMY_TYPES[e.type], false);

console.log('Slow strength (applySlow)');
test('fresh enemies start unslowed', () => {
  const e = enemy();
  assert.equal(e.slow, 0);
  assert.equal(e.slowPct, 0);
});
test('applies to an unslowed enemy', () => {
  const e = enemy();
  assert.ok(applySlow(e, 0.5, 3));
  close(e.slowPct, 0.5); close(e.slow, 3);
});
test('a weaker slow never overwrites a stronger active one, even if longer', () => {
  const e = enemy();
  applySlow(e, 0.5, 1);
  assert.equal(applySlow(e, 0.2, 10), false);
  close(e.slowPct, 0.5); close(e.slow, 1);
});
test('a stronger slow overwrites, even if shorter', () => {
  const e = enemy();
  applySlow(e, 0.2, 5);
  assert.ok(applySlow(e, 0.5, 0.5));
  close(e.slowPct, 0.5); close(e.slow, 0.5);
});
test('equal strength: only a longer duration overwrites', () => {
  const e = enemy();
  applySlow(e, 0.5, 2);
  assert.equal(applySlow(e, 0.5, 1), false);
  close(e.slow, 2);
  assert.equal(applySlow(e, 0.5, 2), false, 'equal duration is not an overwrite');
  assert.ok(applySlow(e, 0.5, 3));
  close(e.slow, 3);
});
test('an expired slow (timer 0) is replaced by anything, even weaker', () => {
  const e = enemy();
  e.slowPct = 0.5; e.slow = 0; // stale strength, timer ran out
  assert.ok(applySlow(e, 0.2, 0.6));
  close(e.slowPct, 0.2); close(e.slow, 0.6);
});
test('strength is capped at MAX_SLOW_PCT (0.75)', () => {
  const e = enemy();
  applySlow(e, 1, 2);
  close(MAX_SLOW_PCT, 0.75);
  close(e.slowPct, MAX_SLOW_PCT);
});
test('zero strength or zero duration does nothing', () => {
  const e = enemy();
  assert.equal(applySlow(e, 0, 5), false);
  assert.equal(applySlow(e, 0.5, 0), false);
  assert.equal(e.slow, 0); assert.equal(e.slowPct, 0);
});
test('resist shortens duration only, never strength (Bone Tyrant slow resist 0.5)', () => {
  assert.equal(ENEMY_TYPES.bone_tyrant.resist.slow, 0.5);
  const e = enemy('bone_tyrant');
  applySlow(e, 0.5, 3);
  close(e.slowPct, 0.5); close(e.slow, 1.5);
});
test('the overwrite comparison uses the resisted duration', () => {
  const e = enemy('bone_tyrant');
  e.slowPct = 0.5; e.slow = 2;
  assert.equal(applySlow(e, 0.5, 3), false, '3s resisted to 1.5s < 2s remaining');
  close(e.slow, 2);
});

console.log('Slowed movement (effMoveCooldown)');
test('unslowed = base cooldown', () => {
  const e = enemy();
  close(moveCd(e), e.moveCooldown);
});
test('50% slow doubles the cooldown (Frost Nova parity with the old flat halving)', () => {
  const e = enemy();
  applySlow(e, 0.5, 3);
  close(moveCd(e), e.moveCooldown * 2);
});
test('base / (1 - slowPct); the 75% cap means at most 4x', () => {
  const e = enemy();
  applySlow(e, 0.2, 1);
  close(moveCd(e), e.moveCooldown / 0.8);
  e.slowPct = 0.99; // even a bad direct write can't exceed the cap
  close(moveCd(e), e.moveCooldown * 4);
});
test('slowPct is ignored once the timer has run out', () => {
  const e = enemy();
  e.slowPct = 0.5; e.slow = 0;
  close(moveCd(e), e.moveCooldown);
});

console.log('Frost Nova slow');
function novaGame(targets) {
  const p = createPlayer(); p.skillState = createSkillState(); recalcStats(p);
  p.skillState.known.frostNova = 1; p.mana = 100;
  return { player: p, rng: null, enemiesInRadius: () => targets, damageEnemy() {}, effect() {}, bus: { emit() {} } };
}
test('Nova applies a 50% slow for 3s (unchanged behavior)', () => {
  const e = enemy();
  assert.ok(useSkill(novaGame([e]), 2));
  close(e.slowPct, 0.5); close(e.slow, 3);
  assert.ok(e.frozen > 0);
});
test('Nova does not weaken a stronger slow already active', () => {
  const e = enemy();
  applySlow(e, 0.7, 1);
  useSkill(novaGame([e]), 2);
  close(e.slowPct, 0.7); close(e.slow, 1);
});

console.log('Armor formula');
test('reduceByDefense = x * 100/(100+def), rounded, min 1', () => {
  assert.equal(reduceByDefense(100, 0), 100);
  assert.equal(reduceByDefense(100, 100), 50);
  assert.equal(reduceByDefense(30, 20), 25);
  assert.equal(reduceByDefense(1, 500), 1);
  assert.equal(reduceByDefense(10, -5), 10, 'negative defense treated as 0');
});
test('computeDamage and mitigate still use the same formula', () => {
  assert.equal(computeDamage(30, 20, null).amount, 25);
  assert.equal(mitigate({ stats: { defense: 100, dodgeChance: 0 } }, 100), 50);
});

console.log('Projectile hit resolution (point-blank + armor)');
const shot = (extra) => ({ x: 0, y: 0, ox: 0, oy: 0, damage: 40, pointBlankDamage: 20, applyDefense: true, ...extra });
test('POINT_BLANK_RANGE is ~1.5 tiles', () => close(POINT_BLANK_RANGE, 1.5));
test('spell projectiles (applyDefense false/unset) are unchanged: rolled damage, no armor, no point-blank', () => {
  assert.deepEqual(projectileHitDamage({ damage: 40, ox: 0, oy: 0 }, 1, 0, 100), { amount: 40, pointBlank: false });
  assert.deepEqual(projectileHitDamage(shot({ applyDefense: false }), 1, 0, 100), { amount: 40, pointBlank: false });
});
test('weapon shot beyond point-blank range: rolled damage reduced by defense', () => {
  assert.deepEqual(projectileHitDamage(shot(), 4, 0, 100), { amount: 20, pointBlank: false });
  assert.deepEqual(projectileHitDamage(shot(), 4, 0, 0), { amount: 40, pointBlank: false });
});
test('weapon shot within point-blank range: pointBlankDamage, then defense', () => {
  assert.deepEqual(projectileHitDamage(shot(), 1, 0, 0), { amount: 20, pointBlank: true });
  assert.deepEqual(projectileHitDamage(shot(), 1, 0, 100), { amount: 10, pointBlank: true });
});
test('point-blank boundary is inclusive and uses straight-line distance from ox,oy', () => {
  assert.equal(projectileHitDamage(shot({ ox: 2, oy: 3 }), 3.5, 3, 0).pointBlank, true, 'exactly 1.5');
  assert.equal(projectileHitDamage(shot({ ox: 2, oy: 3 }), 3.51, 3, 0).pointBlank, false);
  assert.equal(projectileHitDamage(shot(), 1.1, 1.1, 0).pointBlank, false, 'diagonal ~1.556');
  assert.equal(projectileHitDamage(shot(), 1, 1, 0).pointBlank, true, 'diagonal ~1.414');
});
test('weapon shot without pointBlankDamage just uses its damage up close', () => {
  assert.deepEqual(projectileHitDamage(shot({ pointBlankDamage: null }), 1, 0, 100), { amount: 20, pointBlank: false });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
