// Plain-Node unit tests for the skill registry / resolution model (DESIGN §9, §17.10). No framework, no build step:
//   node test/skills.test.js      (or: npm test)
// Exits non-zero if any assertion fails.

import assert from 'node:assert/strict';
import {
  SKILL_DEFS, SLOT_CATEGORIES, WEAPON_CLASSES, CLASS_DEFAULT_ATTACK, CATEGORY_DEFAULT, MAX_SKILL_RANK,
  validateSkillRegistry, activeSkill, effectiveCooldown, createSkillState, normalizeSkillState,
  skillRank, upgradeSkill, useSkill, updateSkills, weaponClass, skillCooldown,
  assignSkill, learnSkill, knownSkills, attackSkillForClass, skillDescription,
} from '../public/js/skills.js';
import { createPlayer, recalcStats } from '../public/js/character.js';

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);

function withTempDefs(defs, fn) {
  Object.assign(SKILL_DEFS, defs);
  try { fn(); } finally { for (const id in defs) delete SKILL_DEFS[id]; }
}
function fakeAttack(id, classes) {
  return { id, name: id, icon: '?', category: 'attack', classes, element: 'physical', baseCooldown: 1, manaCost: 0, rankPerks: {}, cast: () => true };
}
function freshPlayer(weaponKind) {
  const p = createPlayer();
  p.skillState = createSkillState();
  if (weaponKind) p.equipment.weapon = { id: 1, type: 'weapon', slot: 'weapon', weaponKind, stats: { damageMin: 2, damageMax: 4 } };
  recalcStats(p);
  return p;
}

console.log('Guaranteed-skill rule');
test('registry validates cleanly', () => assert.deepEqual(validateSkillRegistry(), []));
test('every weapon class has an unconditional default attack', () => {
  for (const cls of WEAPON_CLASSES) {
    const d = SKILL_DEFS[CLASS_DEFAULT_ATTACK[cls]];
    assert.ok(d, `no default for ${cls}`);
    assert.equal(d.category, 'attack');
    assert.ok(d.classes.includes(cls));
  }
});
test('every slot 2-4 category has an unrestricted default', () => {
  for (const cat of SLOT_CATEGORIES.slice(1)) {
    const d = SKILL_DEFS[CATEGORY_DEFAULT[cat]];
    assert.ok(d, `no default for ${cat}`);
    assert.equal(d.category, cat);
    assert.ok(!d.classes || d.classes.length === 0);
  }
});
test('validator flags a class with no default', () => {
  const saved = CLASS_DEFAULT_ATTACK.melee1h;
  delete CLASS_DEFAULT_ATTACK.melee1h;
  try { assert.ok(validateSkillRegistry().some((e) => e.includes('melee1h'))); } finally { CLASS_DEFAULT_ATTACK.melee1h = saved; }
});
test('validator flags a weapon-restricted category default', () => {
  const d = SKILL_DEFS[CATEGORY_DEFAULT.spell];
  d.classes = ['bow'];
  try { assert.ok(validateSkillRegistry().some((e) => e.includes('weapon-restricted'))); } finally { delete d.classes; }
  assert.deepEqual(validateSkillRegistry(), []);
});
test('fresh skill state knows every default at rank 1', () => {
  const s = createSkillState();
  for (const id of [...Object.values(CLASS_DEFAULT_ATTACK), ...Object.values(CATEGORY_DEFAULT)]) assert.equal(s.known[id], 1);
});

console.log('activeSkill resolution');
test('default slots resolve to Cleave / Arcane Bolt / Frost Nova / Shadow Dash', () => {
  const p = freshPlayer('sword');
  assert.deepEqual([0, 1, 2, 3].map((i) => activeSkill(p, i).id), ['cleave', 'arcaneBolt', 'frostNova', 'shadowDash']);
});
test('slot 1 resolves for every existing weapon kind and unarmed', () => {
  const expected = { sword: 'cleave', axe: 'cleave', mace: 'cleave', dagger: 'cleave', bow: 'bowShot', wand: 'spark', staff: 'staffSweep', someFutureKind: 'cleave' };
  for (const kind of [null, ...Object.keys(expected)]) {
    const p = freshPlayer(kind);
    assert.ok(WEAPON_CLASSES.includes(weaponClass(p)), `class for ${kind}`);
    assert.equal(activeSkill(p, 0).id, kind ? expected[kind] : 'cleave', `slot 1 with ${kind}`);
  }
});
test('bow is its own class with Bow Shot as its always-known default', () => {
  assert.equal(CLASS_DEFAULT_ATTACK.bow, 'bowShot');
  const p = freshPlayer('bow');
  assert.equal(weaponClass(p), 'bow');
  assert.equal(skillRank(p, 'bowShot'), 1);
  const bare = createPlayer(); bare.skillState = undefined;
  bare.equipment.weapon = { id: 1, type: 'weapon', slot: 'weapon', weaponKind: 'bow', stats: { damageMin: 2, damageMax: 4 } };
  assert.equal(activeSkill(bare, 0).id, 'bowShot', 'no skillState at all still resolves');
});
test('unlisted weapon kinds fall back to melee1h / Cleave', () => {
  assert.equal(weaponClass(freshPlayer('someFutureKind')), 'melee1h');
});
test('wand and staff are their own classes with Spark / Staff Sweep as always-known defaults', () => {
  assert.deepEqual([...WEAPON_CLASSES].sort(), ['bow', 'melee1h', 'staff', 'wand']);
  for (const [kind, cls, id] of [['wand', 'wand', 'spark'], ['staff', 'staff', 'staffSweep']]) {
    assert.equal(CLASS_DEFAULT_ATTACK[cls], id);
    const p = freshPlayer(kind);
    assert.equal(weaponClass(p), cls);
    assert.equal(skillRank(p, id), 1, `${id} known with no unlock`);
    assert.ok(createSkillState().known[id] >= 1, `${id} seeded into a new skill state`);
    const bare = createPlayer(); bare.skillState = undefined;
    bare.equipment.weapon = { id: 1, type: 'weapon', slot: 'weapon', weaponKind: kind, stats: { damageMin: 2, damageMax: 4 } };
    assert.equal(activeSkill(bare, 0).id, id, `no skillState at all still resolves (${kind})`);
  }
});
test('new attack skills follow the attack-category rules (free, weapon-locked, short cooldown)', () => {
  for (const id of ['spark', 'staffSweep']) {
    const d = SKILL_DEFS[id];
    assert.equal(d.category, 'attack');
    assert.equal(d.manaCost, 0, `${id} costs no mana`);
    assert.equal(d.classes.length, 1);
  }
  assert.equal(SKILL_DEFS.spark.aimed, true);
  assert.equal(SKILL_DEFS.spark.element, 'arcane');
  assert.equal(SKILL_DEFS.spark.range, 4);
  close(SKILL_DEFS.spark.baseCooldown, 0.45);
  close(SKILL_DEFS.staffSweep.baseCooldown, 0.6);
});
test('attack tooltips only quote damage numbers while their own weapon class is held', () => {
  const wand = freshPlayer('wand');
  assert.match(skillDescription('spark', 1, wand), /dealing \d+-\d+ damage/);
  assert.doesNotMatch(skillDescription('bowShot', 1, wand), /\d+-\d+/, 'a wand ranged row is not Bow Shot damage');
  const staff = freshPlayer('staff');
  assert.match(skillDescription('staffSweep', 1, staff), /Deals \d+-\d+ damage/);
  assert.doesNotMatch(skillDescription('cleave', 1, staff), /\d+-\d+/, 'a staff melee row is not Cleave damage');
});
test('a wand/staff-only skill picked for a class falls back when that weapon is not equipped', () => {
  const p = freshPlayer('sword');
  assert.equal(assignSkill(p, 'melee1h', 'spark'), false, 'spark is not a melee1h skill');
  assert.ok(assignSkill(p, 'wand', 'spark'));
  assert.equal(activeSkill(p, 0).id, 'cleave');
});
test('every slot resolves even with a bare/empty skillState (defaults implicitly known)', () => {
  const p = createPlayer();
  assert.deepEqual([0, 1, 2, 3].map((i) => activeSkill(p, i).id), ['cleave', 'arcaneBolt', 'frostNova', 'shadowDash']);
  p.skillState = undefined;
  assert.equal(activeSkill(p, 0).id, 'cleave');
});
test('out-of-range slot returns null', () => {
  assert.equal(activeSkill(freshPlayer(), 4), null);
  assert.equal(activeSkill(freshPlayer(), -1), null);
});
test('an eligible, known loadout choice for the weapon class wins over the default', () => {
  withTempDefs({ tAlt: fakeAttack('tAlt', ['melee1h']) }, () => {
    const p = freshPlayer('sword');
    p.skillState.known.tAlt = 1;
    p.skillState.loadout.attack.melee1h = 'tAlt';
    assert.equal(activeSkill(p, 0).id, 'tAlt');
  });
});
test('an unknown (not learned) loadout choice falls back to the class default', () => {
  withTempDefs({ tAlt: fakeAttack('tAlt', ['melee1h']) }, () => {
    const p = freshPlayer('sword');
    p.skillState.loadout.attack.melee1h = 'tAlt';
    assert.equal(activeSkill(p, 0).id, 'cleave');
  });
});
test('an ineligible choice (wrong weapon class) falls back, and the assignment is kept', () => {
  withTempDefs({ tBow: fakeAttack('tBow', ['bow']) }, () => {
    const p = freshPlayer('sword');
    p.skillState.known.tBow = 1;
    p.skillState.loadout.attack.melee1h = 'tBow';
    assert.equal(activeSkill(p, 0).id, 'cleave');
    assert.equal(p.skillState.loadout.attack.melee1h, 'tBow');
  });
});
test('slots 2-4 honor a known choice and reject a wrong-category or weapon-locked one', () => {
  const spellAlt = { ...fakeAttack('tSpell', undefined), category: 'spell', manaCost: 1 };
  const spellLocked = { ...fakeAttack('tLocked', ['bow']), category: 'spell' };
  withTempDefs({ tSpell: spellAlt, tLocked: spellLocked }, () => {
    const p = freshPlayer('sword');
    p.skillState.known.tSpell = 1;
    p.skillState.known.tLocked = 1;
    p.skillState.loadout.spell = 'tSpell';
    assert.equal(activeSkill(p, 1).id, 'tSpell');
    p.skillState.loadout.spell = 'tLocked';
    assert.equal(activeSkill(p, 1).id, 'arcaneBolt');
    p.skillState.loadout.spell = 'frostNova'; // wrong category
    assert.equal(activeSkill(p, 1).id, 'arcaneBolt');
  });
});

console.log('effectiveCooldown');
test('rank 1, no CDR = base cooldown', () => close(effectiveCooldown(SKILL_DEFS.frostNova, 1, freshPlayer()), 6));
test('-5% per rank, compounding', () => {
  close(effectiveCooldown(SKILL_DEFS.frostNova, 2, null), 6 * 0.95);
  close(effectiveCooldown(SKILL_DEFS.frostNova, 5, null), 6 * Math.pow(0.95, 4));
});
test('cooldownReduction multiplies, clamped to 0..0.4', () => {
  const p = { stats: { cooldownReduction: 0.2 } };
  close(effectiveCooldown(SKILL_DEFS.cleave, 1, p), 0.45 * 0.8);
  p.stats.cooldownReduction = 0.9;
  close(effectiveCooldown(SKILL_DEFS.cleave, 3, p), 0.45 * 0.95 * 0.95 * 0.6);
  p.stats.cooldownReduction = -1;
  close(effectiveCooldown(SKILL_DEFS.cleave, 1, p), 0.45);
});
test('recalcStats exposes cooldownReduction = 0 with no gear setting it', () => assert.equal(freshPlayer('sword').stats.cooldownReduction, 0));

console.log('ranks, cooldowns, save normalization');
test('upgradeSkill raises only that skill, spends a point, caps at 5', () => {
  const p = freshPlayer();
  p.skillPoints = 10;
  assert.ok(upgradeSkill(p, 'arcaneBolt'));
  assert.equal(skillRank(p, 'arcaneBolt'), 2);
  assert.equal(skillRank(p, 'cleave'), 1);
  assert.equal(p.skillPoints, 9);
  while (upgradeSkill(p, 'arcaneBolt'));
  assert.equal(skillRank(p, 'arcaneBolt'), MAX_SKILL_RANK);
  assert.equal(p.skillPoints, 6);
  assert.equal(upgradeSkill(p, 'nope'), false);
  p.skillPoints = 0;
  assert.equal(upgradeSkill(p, 'cleave'), false);
});
test('useSkill sets a per-skill-id cooldown {t,max} from effectiveCooldown; updateSkills ticks it', () => {
  const p = freshPlayer();
  p.skillState.known.frostNova = 3;
  p.mana = 100;
  const game = { player: p, rng: null, enemiesInRadius: () => [], effect() {}, bus: { emit() {} } };
  assert.ok(useSkill(game, 2));
  const cd = skillCooldown(p, 'frostNova');
  close(cd.max, effectiveCooldown(SKILL_DEFS.frostNova, 3, p));
  close(cd.t, cd.max);
  assert.equal(p.mana, 100 - SKILL_DEFS.frostNova.manaCost);
  assert.equal(useSkill(game, 2), false, 'still on cooldown');
  updateSkills(game, 1);
  close(skillCooldown(p, 'frostNova').t, cd.max - 1);
  close(skillCooldown(p, 'frostNova').max, cd.max);
  assert.equal(skillCooldown(p, 'cleave'), null);
  updateSkills(game, 100);
  assert.equal(skillCooldown(p, 'frostNova').t, 0);
});
test('normalizeSkillState drops unknown ids, clamps ranks, re-seeds defaults', () => {
  const s = normalizeSkillState({
    known: { cleave: 9, arcaneBolt: 3, removedSkill: 4, frostNova: 'x' },
    loadout: { attack: { melee1h: 'removedSkill', bow: 'frostNova' }, spell: 'removedSkill', special: 'frostNova', movement: 42 },
  });
  assert.equal(s.known.cleave, MAX_SKILL_RANK);
  assert.equal(s.known.arcaneBolt, 3);
  assert.equal(s.known.frostNova, 1);
  assert.equal(s.known.shadowDash, 1);
  assert.ok(!('removedSkill' in s.known));
  assert.equal(s.loadout.attack.melee1h, 'cleave');
  assert.equal(s.loadout.attack.bow, 'bowShot', 'wrong-category attack assignment dropped (class default kept)');
  assert.equal(s.loadout.spell, 'arcaneBolt');
  assert.equal(s.loadout.special, 'frostNova');
  assert.equal(s.loadout.movement, 'shadowDash');
});
test('normalizeSkillState tolerates missing / garbage input', () => {
  for (const raw of [undefined, null, 5, 'x', {}, { known: null, loadout: [] }]) {
    const p = createPlayer();
    p.skillState = normalizeSkillState(raw);
    assert.deepEqual([0, 1, 2, 3].map((i) => activeSkill(p, i).id), ['cleave', 'arcaneBolt', 'frostNova', 'shadowDash']);
  }
});

console.log('assignSkill / learnSkill');
test('assignSkill sets a class pick (even for a class not equipped) and activeSkill honors it', () => {
  withTempDefs({ tAlt: fakeAttack('tAlt', ['melee1h']) }, () => {
    const p = freshPlayer('sword');
    assert.equal(assignSkill(p, 'melee1h', 'tAlt'), false, 'not known yet');
    p.skillState.known.tAlt = 1;
    assert.ok(assignSkill(p, 'melee1h', 'tAlt'));
    assert.equal(p.skillState.loadout.attack.melee1h, 'tAlt');
    assert.equal(activeSkill(p, 0).id, 'tAlt');
    assert.equal(attackSkillForClass(p, 'melee1h').id, 'tAlt');
    assert.ok(assignSkill(p, 'melee1h', 'cleave'));
    assert.equal(activeSkill(p, 0).id, 'cleave');
  });
});
test('assignSkill rejects wrong class, wrong category, unknown ids and bad targets', () => {
  withTempDefs({ tBow: fakeAttack('tBow', ['bow']) }, () => {
    const p = freshPlayer('sword');
    p.skillState.known.tBow = 1;
    assert.equal(assignSkill(p, 'melee1h', 'tBow'), false, 'bow-only skill on melee1h');
    assert.equal(assignSkill(p, 'melee1h', 'arcaneBolt'), false, 'spell into attack');
    assert.equal(assignSkill(p, 'spell', 'frostNova'), false, 'special into spell');
    assert.equal(assignSkill(p, 'attack', 'cleave'), false, 'attack needs a class, not the category');
    assert.equal(assignSkill(p, 'nonsense', 'cleave'), false);
    assert.equal(assignSkill(p, 'spell', 'nope'), false);
    assert.equal(p.skillState.loadout.attack.melee1h, 'cleave');
    assert.equal(p.skillState.loadout.spell, 'arcaneBolt');
  });
});
test('assignSkill sets a slot 2-4 category pick', () => {
  withTempDefs({ tSpell: { ...fakeAttack('tSpell', undefined), category: 'spell' } }, () => {
    const p = freshPlayer();
    p.skillState.known.tSpell = 1;
    assert.ok(assignSkill(p, 'spell', 'tSpell'));
    assert.equal(activeSkill(p, 1).id, 'tSpell');
  });
});
test('learnSkill: new skill -> rank 1 + 1 free skill point; duplicate -> +1 rank; capped', () => {
  withTempDefs({ tAlt: fakeAttack('tAlt', ['melee1h']) }, () => {
    const p = freshPlayer();
    p.skillPoints = 0;
    assert.ok(learnSkill(p, 'tAlt'));
    assert.equal(skillRank(p, 'tAlt'), 1);
    assert.equal(p.skillPoints, 1);
    assert.ok(learnSkill(p, 'tAlt'));
    assert.equal(skillRank(p, 'tAlt'), 2);
    assert.equal(p.skillPoints, 1, 'duplicate gives rank, not a point');
    while (learnSkill(p, 'tAlt'));
    assert.equal(skillRank(p, 'tAlt'), MAX_SKILL_RANK);
    assert.equal(learnSkill(p, 'nope'), false);
    assert.ok(learnSkill(p, 'cleave'), 'defaults are known: duplicate path');
    assert.equal(skillRank(p, 'cleave'), 2);
  });
});
test('knownSkills lists only known skills of that category', () => {
  withTempDefs({ tAlt: fakeAttack('tAlt', ['bow']) }, () => {
    const p = freshPlayer();
    assert.deepEqual(knownSkills(p, 'attack').map((d) => d.id), ['cleave', 'bowShot', 'spark', 'staffSweep']);
    p.skillState.known.tAlt = 1;
    assert.deepEqual(knownSkills(p, 'attack').map((d) => d.id), ['cleave', 'bowShot', 'spark', 'staffSweep', 'tAlt']);
    assert.deepEqual(knownSkills(p, 'movement').map((d) => d.id), ['shadowDash']);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
