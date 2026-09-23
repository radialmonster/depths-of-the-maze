// Player skills: a static registry of skill definitions (SKILL_DEFS) plus the loadout/resolution model that decides
// which skill is active in each HUD slot. Owned by the Character agent — see DESIGN.md §9 and §17.10.
// Uses ONLY the game API in DESIGN §6 (game.enemyAt, enemiesInRadius, damageEnemy, spawnProjectile, effect,
// floatText, log, isFree, isWalkable, rng, bus, player).
//
// Data model:
//   SKILL_DEFS[id]            static definition (never saved — a continued run always uses current numbers)
//   player.skillState.known   { [id]: rank }  learned skills and their own ranks (1..MAX_SKILL_RANK)
//   player.skillState.loadout { attack: { [weaponClass]: id }, spell: id, special: id, movement: id }
//   player.skillCooldowns     { [id]: { t, max } }  runtime only (not saved); `max` = the duration set at cast time
// activeSkill(player, slotIndex) resolves what's in a slot right now; nothing else indexes slots directly.

import { computeDamage } from './character.js';
import { applyResist, applySlow } from './enemies.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
export const MAX_SKILL_RANK = 5;
const RANK_DAMAGE_BONUS = 0.15;       // +15% damage per rank (rank 1 = base, so multiplier = 1 + (rank-1)*0.15)
const RANK_COOLDOWN_MULT = 0.95;      // -5% cooldown per rank (compounding), see effectiveCooldown()
const MAX_COOLDOWN_REDUCTION = 0.4;   // cap on stats.cooldownReduction

const CLEAVE_BASE_CD = 0.45;
const CLEAVE_MANA = 0;

const BOLT_BASE_CD = 0.6;
const BOLT_MANA = 6;
const BOLT_SPEED = 14;
const BOLT_RANGE = 10;
// Aim assist (player.stats.autoAimAssist, 0..0.20) applies to any skill whose definition has aimed:true, using that
// skill's own `range`. At cast time only, blend the fire direction toward the closest visible enemy inside this
// forward cone and the skill's range. The projectile still flies straight (no homing). See DESIGN §17.5.
const RANGED_ASSIST_CONE_COS = Math.cos(40 * Math.PI / 180); // 40deg half-angle, like main.js BUMP_CONE; max nudge ~8deg

const NOVA_BASE_CD = 6.0;
const NOVA_MANA = 20;
const NOVA_BASE_RADIUS = 2.5;
const NOVA_RADIUS_PER_RANK = 0.25;
const NOVA_FROZEN_BASE = 1.2;
const NOVA_FROZEN_PER_RANK = 0.15;
const NOVA_SLOW = 3.0;       // slow duration (s)
const NOVA_SLOW_PCT = 0.5;   // slow strength: 50% => moves at half speed (DESIGN §17.12)

const DASH_BASE_CD = 2.5;
const DASH_MANA = 5;
const DASH_BASE_TILES = 3;
const DASH_INVULN_BASE = 0.4;
const DASH_INVULN_PER_RANK = 0.05;

const NO_MANA_FLASH_THROTTLE = 0.6; // seconds between "No mana" float texts

function rankMult(rank) { return 1 + (rank - 1) * RANK_DAMAGE_BONUS; }

// Sums a numeric rankPerks key over every perk rank <= `rank` (booleans count as 1), e.g. Arcane Bolt's
// { 3: { pierce: 1 }, 5: { pierce: 1 } } gives pierce 0 / 1 / 2 at ranks 1-2 / 3-4 / 5.
function perkTotal(def, rank, key) {
  let total = 0;
  const perks = def.rankPerks || {};
  for (const r in perks) {
    if (Number(r) <= rank && perks[r][key]) total += Number(perks[r][key]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Slots, categories and weapon classes
// ---------------------------------------------------------------------------
// HUD slot index (0-3) -> category. Slot 1 (index 0) is the weapon-class-dependent attack.
export const SLOT_CATEGORIES = ['attack', 'spell', 'special', 'movement'];

// Weapon classes that exist right now. Every one of them must have a default attack in CLASS_DEFAULT_ATTACK
// (validated at startup). Later phases add melee2h / bow / wand / staff along with their default attacks.
export const WEAPON_CLASSES = ['melee1h'];

// Display names for weapon classes (Skills tab labels, "Requires {class}"). Lists every class in DESIGN §17.9 so a
// class that lands later already reads correctly; only WEAPON_CLASSES decides which ones exist.
export const WEAPON_CLASS_NAMES = { melee1h: 'Melee', melee2h: 'Two-handed', bow: 'Bow', wand: 'Wand', staff: 'Staff' };
export function weaponClassName(cls) { return WEAPON_CLASS_NAMES[cls] || cls; }

// Weapon kind -> class. Transitional stand-in for items.js WEAPON_KIND_INFO (DESIGN §17.9): today bows and staves
// still behave as melee weapons (they Cleave and feed meleeMin/Max), so they map to melee1h until the phase that
// gives them their own class + default attack. Unarmed / unknown kinds are melee1h too.
const KIND_CLASS = {
  sword: 'melee1h', axe: 'melee1h', mace: 'melee1h', dagger: 'melee1h',
  bow: 'melee1h', staff: 'melee1h',
};
const UNARMED_CLASS = 'melee1h';

// The guaranteed-skill rule (DESIGN §9 / §17.10): every weapon class and every slot 2-4 category has an
// unconditional default, always known at rank >= 1.
export const CLASS_DEFAULT_ATTACK = { melee1h: 'cleave' };
export const CATEGORY_DEFAULT = { spell: 'arcaneBolt', special: 'frostNova', movement: 'shadowDash' };

export function weaponClass(player) {
  const w = player && player.equipment && player.equipment.weapon;
  if (!w) return UNARMED_CLASS;
  return KIND_CLASS[w.weaponKind] || UNARMED_CLASS;
}

function defaultSkillIds() {
  return [...new Set([...Object.values(CLASS_DEFAULT_ATTACK), ...Object.values(CATEGORY_DEFAULT)])];
}

// ---------------------------------------------------------------------------
// Skill registry
// ---------------------------------------------------------------------------
export const SKILL_DEFS = {
  cleave: {
    id: 'cleave', name: 'Cleave', icon: '⚔️',
    description: 'Melee arc hitting the tile in front and the two beside it.',
    category: 'attack', classes: ['melee1h'], aimed: false, element: 'physical',
    baseCooldown: CLEAVE_BASE_CD, manaCost: CLEAVE_MANA,
    rankPerks: { 3: { knockbackAlways: true, text: 'Knockback on every hit, not just crits.' } },
    cast: castCleave,
    describe(rank, player) {
      const stats = (player && player.stats) || {};
      const mult = rankMult(rank);
      const lo = Math.max(1, Math.round((stats.meleeMin ?? 1) * mult));
      const hi = Math.max(lo + 1, Math.round((stats.meleeMax ?? 3) * mult));
      const kb = perkTotal(this, rank, 'knockbackAlways') ? ' Knockback on hit.' : ' Knockback on crit.';
      return `Deals ${lo}-${hi} damage to 3 tiles in front.${kb}`;
    },
  },
  arcaneBolt: {
    id: 'arcaneBolt', name: 'Arcane Bolt', icon: '🔮',
    description: 'Fires a piercing bolt of arcane energy.',
    category: 'spell', aimed: true, range: BOLT_RANGE, element: 'arcane',
    baseCooldown: BOLT_BASE_CD, manaCost: BOLT_MANA,
    rankPerks: {
      3: { pierce: 1, text: 'Pierces +1 enemy.' },
      5: { pierce: 1, text: 'Pierces +1 more enemy.' },
    },
    cast: castArcaneBolt,
    describe(rank, player) {
      const stats = (player && player.stats) || {};
      const mult = rankMult(rank);
      const lo = Math.max(1, Math.round((stats.rangedMin ?? 1) * mult));
      const hi = Math.max(lo + 1, Math.round((stats.rangedMax ?? 3) * mult));
      const pierce = perkTotal(this, rank, 'pierce');
      const pierceStr = pierce > 0 ? ` Pierces ${pierce} ${pierce > 1 ? 'enemies' : 'enemy'}.` : '';
      return `Fires a bolt dealing ${lo}-${hi} damage.${pierceStr} Costs ${this.manaCost} mana.`;
    },
  },
  frostNova: {
    id: 'frostNova', name: 'Frost Nova', icon: '❄️',
    description: 'Damages and freezes/slows all nearby enemies.',
    category: 'special', aimed: false, element: 'frost',
    baseCooldown: NOVA_BASE_CD, manaCost: NOVA_MANA,
    rankPerks: {}, // radius and freeze duration grow every rank (NOVA_*_PER_RANK) instead of at specific ranks
    cast: castFrostNova,
    describe(rank, player) {
      const stats = (player && player.stats) || {};
      const radius = (NOVA_BASE_RADIUS + (rank - 1) * NOVA_RADIUS_PER_RANK).toFixed(2);
      const power = Math.round((stats.spellPower ?? 5) * rankMult(rank));
      const freeze = (NOVA_FROZEN_BASE + (rank - 1) * NOVA_FROZEN_PER_RANK).toFixed(1);
      return `Deals ~${power} damage to all enemies within ${radius} tiles, freezing them for ${freeze}s and slowing after. Costs ${this.manaCost} mana.`;
    },
  },
  shadowDash: {
    id: 'shadowDash', name: 'Shadow Dash', icon: '💨',
    description: 'Dash forward through free tiles, briefly invulnerable.',
    category: 'movement', aimed: false, element: 'physical',
    baseCooldown: DASH_BASE_CD, manaCost: DASH_MANA,
    rankPerks: { 4: { dashTiles: 1, text: 'Dash 1 tile further.' } },
    cast: castShadowDash,
    describe(rank) {
      const tiles = DASH_BASE_TILES + perkTotal(this, rank, 'dashTiles');
      const invuln = (DASH_INVULN_BASE + (rank - 1) * DASH_INVULN_PER_RANK).toFixed(2);
      return `Dash up to ${tiles} tiles, gaining ${invuln}s of invulnerability. Costs ${this.manaCost} mana.`;
    },
  },
};

// ---------------------------------------------------------------------------
// Registry validation (guaranteed-skill rule). Returns a list of error strings; [] = valid.
// Run at module load (loud console.error) and by tests/skills.test.js.
// ---------------------------------------------------------------------------
export function validateSkillRegistry() {
  const errors = [];
  for (const id in SKILL_DEFS) {
    const d = SKILL_DEFS[id];
    if (d.id !== id) errors.push(`SKILL_DEFS.${id}: id field is "${d.id}"`);
    if (!SLOT_CATEGORIES.includes(d.category)) errors.push(`${id}: unknown category "${d.category}"`);
    if (typeof d.cast !== 'function') errors.push(`${id}: missing cast()`);
    if (!(d.baseCooldown > 0)) errors.push(`${id}: baseCooldown must be > 0`);
    if (!(d.manaCost >= 0)) errors.push(`${id}: manaCost must be >= 0`);
    if (d.category === 'attack' && !(Array.isArray(d.classes) && d.classes.length)) {
      errors.push(`${id}: attack skills must list the weapon classes that can use them`);
    }
  }
  for (const cls of WEAPON_CLASSES) {
    const id = CLASS_DEFAULT_ATTACK[cls];
    const d = id && SKILL_DEFS[id];
    if (!d) errors.push(`weapon class "${cls}" has no default attack skill`);
    else if (d.category !== 'attack' || !(d.classes || []).includes(cls)) {
      errors.push(`weapon class "${cls}" default "${id}" is not an attack skill usable by that class`);
    }
  }
  for (const kind in KIND_CLASS) {
    if (!WEAPON_CLASSES.includes(KIND_CLASS[kind])) errors.push(`weapon kind "${kind}" maps to unknown class "${KIND_CLASS[kind]}"`);
  }
  if (!WEAPON_CLASSES.includes(UNARMED_CLASS)) errors.push(`unarmed class "${UNARMED_CLASS}" is not a weapon class`);
  for (const cat of SLOT_CATEGORIES) {
    if (cat === 'attack') continue;
    const id = CATEGORY_DEFAULT[cat];
    const d = id && SKILL_DEFS[id];
    if (!d) errors.push(`category "${cat}" has no default skill`);
    else if (d.category !== cat) errors.push(`category "${cat}" default "${id}" has category "${d.category}"`);
    else if (Array.isArray(d.classes) && d.classes.length) {
      errors.push(`category "${cat}" default "${id}" is weapon-restricted — a slot default must be unconditional`);
    }
  }
  return errors;
}

{
  const errors = validateSkillRegistry();
  if (errors.length) {
    console.error(`[skills] SKILL REGISTRY INVALID — guaranteed-skill rule violated (DESIGN §17.10):\n  ${errors.join('\n  ')}`);
  }
}

// ---------------------------------------------------------------------------
// Skill state (known ranks + loadout)
// ---------------------------------------------------------------------------
export function createSkillState() {
  const known = {};
  for (const id of defaultSkillIds()) known[id] = 1;
  return {
    known,
    loadout: { attack: { ...CLASS_DEFAULT_ATTACK }, ...CATEGORY_DEFAULT },
  };
}

// Forgiving load of a saved skillState: drops unknown skill ids and ill-typed entries, clamps ranks, re-seeds
// defaults (always known). Loadout entries that don't name a known skill of the right category are dropped, so
// that slot falls back to its default through activeSkill().
export function normalizeSkillState(raw) {
  const state = createSkillState();
  const rawKnown = raw && raw.known && typeof raw.known === 'object' ? raw.known : {};
  for (const id in rawKnown) {
    if (!Object.prototype.hasOwnProperty.call(SKILL_DEFS, id)) continue;
    const r = Math.floor(Number(rawKnown[id]));
    if (!(r >= 1)) continue;
    state.known[id] = Math.min(MAX_SKILL_RANK, r);
  }
  const isKnownOf = (id, cat) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(SKILL_DEFS, id)
    && SKILL_DEFS[id].category === cat && state.known[id] >= 1;
  const rawLoadout = raw && raw.loadout && typeof raw.loadout === 'object' ? raw.loadout : {};
  const rawAttack = rawLoadout.attack && typeof rawLoadout.attack === 'object' ? rawLoadout.attack : {};
  for (const cls in rawAttack) {
    const id = rawAttack[cls];
    // Kept even if currently ineligible for `cls` (§17.10: an assignment survives and returns once eligible).
    if (isKnownOf(id, 'attack')) state.loadout.attack[cls] = id;
  }
  for (const cat of SLOT_CATEGORIES) {
    if (cat === 'attack') continue;
    if (isKnownOf(rawLoadout[cat], cat)) state.loadout[cat] = rawLoadout[cat];
  }
  return state;
}

// Rank the player has in a skill (0 = not known). Defaults are always known, at least rank 1.
export function skillRank(player, skillId) {
  const known = player && player.skillState && player.skillState.known;
  const r = known && known[skillId];
  if (r >= 1) return Math.min(MAX_SKILL_RANK, r);
  return defaultSkillIds().includes(skillId) ? 1 : 0;
}

// Is `def` usable in a slot of `category` for a player whose weapon class is `cls`? (Known + right category +
// weapon-class match: attack skills must list `cls`; slot 2-4 skills must be unrestricted or list `cls`.)
export function skillEligible(player, def, category, cls) {
  if (!def || def.category !== category || skillRank(player, def.id) < 1) return false;
  const classes = Array.isArray(def.classes) ? def.classes : [];
  if (category === 'attack') return classes.includes(cls);
  return classes.length === 0 || classes.includes(cls);
}

// ---------------------------------------------------------------------------
// activeSkill — what's in HUD slot `slotIndex` (0-3) right now (DESIGN §17.10):
//   slot 0: weapon class -> player's loadout choice for that class if still eligible -> class default.
//   slots 1-3: player's loadout choice for the category if eligible -> category default.
// Always returns a skill definition (guaranteed-skill rule), or null only for an out-of-range slot index.
// ---------------------------------------------------------------------------
export function activeSkill(player, slotIndex) {
  const category = SLOT_CATEGORIES[slotIndex];
  if (!category) return null;
  const cls = weaponClass(player);
  if (category === 'attack') return attackSkillForClass(player, cls);
  const loadout = (player && player.skillState && player.skillState.loadout) || {};
  const choice = SKILL_DEFS[loadout[category]];
  if (skillEligible(player, choice, category, cls)) return choice;
  return SKILL_DEFS[CATEGORY_DEFAULT[category]];
}

// The attack skill slot 1 would hold with a `cls` weapon equipped: the player's remembered pick for that class if
// still eligible, else the class default. activeSkill() uses it for the equipped class; the Skills tab uses it to show
// the other classes' assignments (§17.10).
export function attackSkillForClass(player, cls) {
  const loadout = (player && player.skillState && player.skillState.loadout) || {};
  const choice = SKILL_DEFS[(loadout.attack || {})[cls]];
  if (skillEligible(player, choice, 'attack', cls)) return choice;
  return SKILL_DEFS[CLASS_DEFAULT_ATTACK[cls]] || SKILL_DEFS[CLASS_DEFAULT_ATTACK[UNARMED_CLASS]];
}

// Every skill the player knows (rank >= 1) in `category`, in registry order. For the Skills tab's picker list.
export function knownSkills(player, category) {
  return Object.values(SKILL_DEFS).filter((d) => d.category === category && skillRank(player, d.id) >= 1);
}

// ---------------------------------------------------------------------------
// assignSkill — the Skills-tab picker (§17.10). `categoryOrClass` is a weapon class (sets loadout.attack[class]; the
// skill must be a known attack skill usable by that class — it need NOT match the currently equipped weapon, so a
// class's pick can be set while holding something else) or a slot 2-4 category (sets loadout[category]; the skill
// must be a known skill of that category). Returns false, changing nothing, for anything else.
// ---------------------------------------------------------------------------
export function assignSkill(player, categoryOrClass, skillId) {
  const def = SKILL_DEFS[skillId];
  if (!player || !def || skillRank(player, skillId) < 1) return false;
  if (!player.skillState) player.skillState = createSkillState();
  const loadout = player.skillState.loadout || (player.skillState.loadout = {});
  if (WEAPON_CLASSES.includes(categoryOrClass)) {
    if (def.category !== 'attack' || !(def.classes || []).includes(categoryOrClass)) return false;
    if (!loadout.attack) loadout.attack = {};
    loadout.attack[categoryOrClass] = skillId;
    return true;
  }
  if (categoryOrClass === 'attack' || !SLOT_CATEGORIES.includes(categoryOrClass)) return false;
  if (def.category !== categoryOrClass) return false;
  loadout[categoryOrClass] = skillId;
  return true;
}

// ---------------------------------------------------------------------------
// learnSkill — a skill book was read (§17.11). Unknown skill: learned at rank 1, plus 1 free skill point. Already
// known: +1 rank (a duplicate book is never dead weight), capped at MAX_SKILL_RANK. Returns false (nothing changed —
// the caller should not consume the book) for an unknown id or a skill already at max rank.
// ---------------------------------------------------------------------------
export function learnSkill(player, skillId) {
  if (!player || !SKILL_DEFS[skillId]) return false;
  if (!player.skillState) player.skillState = createSkillState();
  const rank = skillRank(player, skillId);
  if (rank >= MAX_SKILL_RANK) return false;
  player.skillState.known[skillId] = rank + 1;
  if (rank === 0) player.skillPoints = (player.skillPoints || 0) + 1;
  return true;
}

// ---------------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------------
export function effectiveCooldown(skillDef, rank, player) {
  const cdr = Math.min(MAX_COOLDOWN_REDUCTION, Math.max(0, (player && player.stats && player.stats.cooldownReduction) || 0));
  return skillDef.baseCooldown * Math.pow(RANK_COOLDOWN_MULT, Math.max(1, rank) - 1) * (1 - cdr);
}

// -> { t, max } (t = seconds remaining, max = the full duration set when it was cast) or null if never cast.
export function skillCooldown(player, skillId) {
  const cds = player && player.skillCooldowns;
  return (cds && cds[skillId]) || null;
}

// ---------------------------------------------------------------------------
// useSkill
// ---------------------------------------------------------------------------
export function useSkill(game, index) {
  const player = game.player;
  if (!player || player.dead) return false;
  const skill = activeSkill(player, index);
  if (!skill) return false;
  const rank = skillRank(player, skill.id);

  const cd = skillCooldown(player, skill.id);
  if (cd && cd.t > 0) return false;

  if (skill.manaCost > 0 && player.mana < skill.manaCost) {
    if (player._noManaFlashTimer <= 0) {
      if (typeof game.floatText === 'function') game.floatText(player.x, player.y, 'No mana', '#6af');
      try { game.bus && game.bus.emit('denied'); } catch (e) { /* ignore */ }
      player._noManaFlashTimer = NO_MANA_FLASH_THROTTLE;
    }
    return false;
  }

  if (!skill.cast(game, player, skill, rank)) return false;

  player.mana = Math.max(0, player.mana - skill.manaCost);
  const dur = effectiveCooldown(skill, rank, player);
  if (!player.skillCooldowns) player.skillCooldowns = {};
  player.skillCooldowns[skill.id] = { t: dur, max: dur };
  try { game.bus && game.bus.emit('skillUsed', { skill, rank }); } catch (e) { /* ignore */ }
  return true;
}

// ---------------------------------------------------------------------------
// updateSkills — tick every skill's own cooldown, slotted or not (§17.10)
// ---------------------------------------------------------------------------
export function updateSkills(game, dt) {
  const cds = game.player && game.player.skillCooldowns;
  if (!cds) return;
  for (const id in cds) {
    if (cds[id].t > 0) cds[id].t = Math.max(0, cds[id].t - dt);
  }
}

// ---------------------------------------------------------------------------
// upgradeSkill — spend 1 skill point on a known skill's own rank (max MAX_SKILL_RANK)
// ---------------------------------------------------------------------------
export function upgradeSkill(player, skillId) {
  if (!player || player.skillPoints <= 0) return false;
  if (!SKILL_DEFS[skillId]) return false;
  const rank = skillRank(player, skillId);
  if (rank < 1 || rank >= MAX_SKILL_RANK) return false;
  if (!player.skillState) player.skillState = createSkillState();
  player.skillState.known[skillId] = rank + 1;
  player.skillPoints -= 1;
  return true;
}

// ---------------------------------------------------------------------------
// skillDescription — human string with current numbers
// ---------------------------------------------------------------------------
export function skillDescription(skillId, rank, player) {
  const def = SKILL_DEFS[skillId];
  if (!def) return '';
  return typeof def.describe === 'function' ? def.describe(rank, player) : (def.description || '');
}

// ---------------------------------------------------------------------------
// Skill implementations — cast(game, player, skill /*def*/, rank) -> bool (false = didn't go off: no cost/cooldown)
// ---------------------------------------------------------------------------

function facingOf(player) {
  const f = player.facing || { x: 0, y: 1 };
  return { x: f.x || 0, y: f.y || 0 };
}

// Perpendicular direction to a facing dir (for cleave's side tiles).
function perpOf(facing) {
  // rotate 90deg: (x,y) -> (-y, x)
  return { x: -facing.y, y: facing.x };
}

function castCleave(game, player, skill, rank) {
  const facing = facingOf(player);
  const perp = perpOf(facing);
  const fx = player.x + facing.x, fy = player.y + facing.y;
  const targets = [
    { x: fx, y: fy },
    { x: fx + perp.x, y: fy + perp.y },
    { x: fx - perp.x, y: fy - perp.y },
  ];

  const mult = rankMult(rank);
  const knockbackAlways = perkTotal(skill, rank, 'knockbackAlways') > 0;
  const rng = game.rng;
  const critChance = player.stats.critChance;
  const critMult = player.stats.critMult;

  for (const t of targets) {
    const enemy = typeof game.enemyAt === 'function' ? game.enemyAt(t.x, t.y) : null;
    if (!enemy) continue;
    const power = rng.range(player.stats.meleeMin, player.stats.meleeMax) * mult;
    const { amount, crit } = computeDamage(power, enemy.defense, rng, critChance, critMult);
    const opts = { crit, source: 'melee', element: skill.element };
    if (knockbackAlways || crit) opts.knockback = { x: facing.x, y: facing.y };
    if (typeof game.damageEnemy === 'function') game.damageEnemy(enemy, amount, opts);
  }

  if (typeof game.effect === 'function') game.effect('slash', player.x + facing.x, player.y + facing.y, { dir: facing });
  return true; // consumes cooldown/mana even on a whiff, matching a real "swing"
}

function castArcaneBolt(game, player, skill, rank) {
  const facing = facingOf(player);
  const rng = game.rng;
  const mult = rankMult(rank);
  const power = rng.range(player.stats.rangedMin, player.stats.rangedMax) * mult;
  const critChance = player.stats.critChance;
  const critMult = player.stats.critMult;
  // Precompute final damage (ignoring target defense — spell damage bypasses armor per contract note);
  // crit is rolled here so main.js/renderer can react to it (e.g. bigger float text) without recomputing.
  const crit = rng.chance(critChance);
  let amount = power * (1 + rng.range(-0.15, 0.15));
  if (crit) amount *= critMult;
  amount = Math.max(1, Math.round(amount));

  const pierce = perkTotal(skill, rank, 'pierce');
  // Analog stick play aims freely (player.aim) from the free-movement position (fx/fy).
  const ox = player.fx ?? player.x, oy = player.fy ?? player.y;
  const aim = assistAim(game, player, skill, player.aim || facing, ox, oy);

  if (typeof game.spawnProjectile === 'function') {
    game.spawnProjectile({
      x: ox, y: oy,
      dx: aim.x, dy: aim.y,
      speed: BOLT_SPEED,
      range: skill.range,
      damage: amount,
      crit,
      power: true,
      owner: 'player',
      color: '#a86bff',
      size: 0.22,
      pierce,
      kind: 'bolt',
      element: skill.element,
    });
  }
  return true;
}

// Generic aim assist for any skill with aimed:true: nudges the initial fire direction toward the closest enemy
// that is within that skill's own `range`, inside the forward cone, and in line of sight, by
// player.stats.autoAimAssist. Returns `aim` unchanged for non-aimed skills, with no assist, or with no target.
function assistAim(game, player, skill, aim, ox, oy) {
  const assist = (player.stats && player.stats.autoAimAssist) || 0;
  const range = skill && skill.aimed ? skill.range : 0;
  const alen = Math.hypot(aim.x, aim.y);
  if (assist <= 0 || !(range > 0) || alen === 0 || typeof game.enemiesInRadius !== 'function') return aim;
  const ax = aim.x / alen, ay = aim.y / alen;
  const canSee = typeof game.hasLineOfSight === 'function';
  let best = null, bestD = Infinity;
  for (const e of game.enemiesInRadius(ox, oy, range)) {
    const ex = e.x - ox, ey = e.y - oy;
    const d = Math.hypot(ex, ey);
    if (d === 0 || d >= bestD) continue;
    if ((ex * ax + ey * ay) / d < RANGED_ASSIST_CONE_COS) continue;
    if (canSee && !game.hasLineOfSight(player.x, player.y, e.x, e.y)) continue;
    best = { x: ex / d, y: ey / d };
    bestD = d;
  }
  if (!best) return aim;
  const bx = ax + (best.x - ax) * assist, by = ay + (best.y - ay) * assist;
  const blen = Math.hypot(bx, by) || 1;
  return { x: bx / blen, y: by / blen };
}

function castFrostNova(game, player, skill, rank) {
  const radius = NOVA_BASE_RADIUS + (rank - 1) * NOVA_RADIUS_PER_RANK;
  const mult = rankMult(rank);
  const rng = game.rng;
  const critChance = player.stats.critChance;
  const critMult = player.stats.critMult;

  const enemies = typeof game.enemiesInRadius === 'function' ? game.enemiesInRadius(player.x, player.y, radius) : [];
  const frozen = NOVA_FROZEN_BASE + (rank - 1) * NOVA_FROZEN_PER_RANK;

  for (const enemy of enemies) {
    const power = player.stats.spellPower * mult;
    const { amount, crit } = computeDamage(power, enemy.defense, rng, critChance, critMult);
    if (typeof game.damageEnemy === 'function') game.damageEnemy(enemy, amount, { crit, source: 'spell', element: skill.element });
    // Status-effect durations scale by the target's resist to that effect (enemies.js
    // ENEMY_TYPES.resist) — e.g. Bone Tyrant shrugs off most of the freeze/slow, Slime King
    // barely resists either. Regular enemies have no resist table, so this is a no-op for them.
    enemy.frozen = applyResist(enemy, 'freeze', frozen);
    applySlow(enemy, NOVA_SLOW_PCT, NOVA_SLOW); // resist shortens the duration inside applySlow (§17.12)
  }

  if (typeof game.effect === 'function') game.effect('nova', player.x, player.y, { radius });
  return true; // always "goes off" even with 0 targets in range — it's still a mana-spending AoE pulse
}

function castShadowDash(game, player, skill, rank) {
  const facing = facingOf(player);
  if (facing.x === 0 && facing.y === 0) return false;

  const maxTiles = DASH_BASE_TILES + perkTotal(skill, rank, 'dashTiles');
  const oldX = player.x, oldY = player.y;
  let steps = 0;
  let cx = player.x, cy = player.y;

  for (let i = 1; i <= maxTiles; i++) {
    const nx = player.x + facing.x * i;
    const ny = player.y + facing.y * i;
    if (typeof game.isFree === 'function' ? !game.isFree(nx, ny) : false) break;
    if (typeof game.isWalkable === 'function' && !game.isWalkable(nx, ny)) break;
    cx = nx; cy = ny;
    steps++;
  }

  if (steps === 0) return false; // fully blocked: no cooldown/mana consumed

  player.x = cx;
  player.y = cy;
  player.invuln = Math.max(player.invuln || 0, DASH_INVULN_BASE + (rank - 1) * DASH_INVULN_PER_RANK);

  if (typeof game.effect === 'function') game.effect('dash', cx, cy, { from: { x: oldX, y: oldY } });
  return true;
}
