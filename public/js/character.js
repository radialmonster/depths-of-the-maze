// Player creation, stats, XP/levels, damage formulas. Owned by the Character agent — see DESIGN.md §8.
// Pure module: no DOM, no three.js. Only touches `game.bus`, `game.effect`, `game.log` (guarded) via gainXP.

// ---------------------------------------------------------------------------
// Attribute metadata for the Character (C) panel.
// ---------------------------------------------------------------------------
export const ATTRIBUTES = [
  { id: 'str', name: 'Strength', description: 'Increases melee damage and adds a small amount of max HP.' },
  { id: 'dex', name: 'Dexterity', description: 'Increases crit chance, dodge chance, and move speed slightly.' },
  { id: 'int', name: 'Intelligence', description: 'Increases max mana, spell power, and mana regen.' },
  { id: 'vit', name: 'Vitality', description: 'Increases max HP and HP regen.' },
  { id: 'def', name: 'Defense', description: 'Reduces incoming damage (diminishing returns).' },
];

// ---------------------------------------------------------------------------
// Tuning constants (documented here for the balance report).
// ---------------------------------------------------------------------------
const BASE_HP = 40;
const BASE_MANA = 30;
const HP_PER_VIT = 6;
const HP_PER_STR = 1.5;
const MANA_PER_INT = 5;
const HP_PER_LEVEL = 4; // automatic base growth per level, on top of attribute contributions
const MANA_PER_LEVEL = 2;

const FIST_MIN = 1;
const FIST_MAX = 3;
const STR_MELEE_SCALE = 0.8; // str points -> flat melee damage added on top of weapon damageMin/Max

const DEFENSE_K = 1.0; // mitigate(): raw * 100/(100+defense*k)

const BASE_MOVE_COOLDOWN = 0.15; // seconds per tile
const MIN_MOVE_COOLDOWN = 0.08;
const MOVE_SPEED_PER_DEX = 0.0015; // small dex contribution to move speed
const MOVE_COOLDOWN_PER_SPEED = 1; // moveSpeed stat directly reduces cooldown (seconds), from equipment

const CRIT_MULT_BASE = 1.5;
const CRIT_CHANCE_BASE = 0.03;
const CRIT_CHANCE_PER_DEX = 0.002;
const DODGE_CHANCE_BASE = 0.0;
const DODGE_CHANCE_PER_DEX = 0.0015;
const DODGE_CHANCE_MAX = 0.35;

const HP_REGEN_BASE = 0.4; // per second
const HP_REGEN_PER_VIT = 0.06;
const MANA_REGEN_BASE = 0.6;
const MANA_REGEN_PER_INT = 0.08;

const DEFENSE_PER_DEF_ATTR = 1.0; // 1 defense point per DEF attribute point (equipment armor adds more)

// ---------------------------------------------------------------------------
// createPlayer
// ---------------------------------------------------------------------------
export function createPlayer() {
  const player = {
    id: 'player',
    x: 0,
    y: 0,
    facing: { x: 0, y: 1 },
    name: 'Hero',
    level: 1,
    xp: 0,
    attrPoints: 0,
    skillPoints: 0,
    gold: 0,
    base: { str: 5, dex: 5, int: 5, vit: 5, def: 3 },
    hp: 1,
    mana: 1,
    stats: {
      maxHp: 1, maxMana: 1,
      meleeMin: FIST_MIN, meleeMax: FIST_MAX,
      rangedMin: 0, rangedMax: 0,
      spellPower: 0,
      defense: 0,
      critChance: CRIT_CHANCE_BASE,
      critMult: CRIT_MULT_BASE,
      moveCooldown: BASE_MOVE_COOLDOWN,
      hpRegen: HP_REGEN_BASE,
      manaRegen: MANA_REGEN_BASE,
      dodgeChance: DODGE_CHANCE_BASE,
    },
    equipment: { weapon: null, offhand: null, helm: null, armor: null, boots: null, ring: null, amulet: null },
    inventory: [],
    skills: [],
    moveTimer: 0,
    invuln: 0,
    hitFlash: 0,
    dead: false,
    buffs: [],
    _noManaFlashTimer: 0, // internal throttle for "No mana" float text, used by skills.js indirectly via game
  };
  recalcStats(player);
  player.hp = player.stats.maxHp;
  player.mana = player.stats.maxMana;
  return player;
}

// ---------------------------------------------------------------------------
// recalcStats — pure recompute from base attrs + level + equipment + skills + buffs.
// ---------------------------------------------------------------------------
export function recalcStats(player) {
  const lvl = player.level || 1;
  const b = player.base;

  // Start with attribute totals (base attrs only; equipment flat attr bonuses added below).
  let str = b.str, dex = b.dex, int_ = b.int, vit = b.vit, def = b.def;

  // Equipment aggregate.
  let armor = 0, damageMin = 0, damageMax = 0, spellPower = 0;
  let maxHpBonus = 0, maxManaBonus = 0, critChanceBonus = 0;
  let hpRegenBonus = 0, manaRegenBonus = 0, moveSpeedBonus = 0;
  let hasWeapon = false;

  const equipmentSlots = player.equipment || {};
  for (const slot in equipmentSlots) {
    const item = equipmentSlots[slot];
    if (!item || !item.stats) continue;
    const s = item.stats;
    if (s.str) str += s.str;
    if (s.dex) dex += s.dex;
    if (s.int) int_ += s.int;
    if (s.vit) vit += s.vit;
    if (s.def) def += s.def;
    if (s.armor) armor += s.armor;
    if (s.damageMin) { damageMin += s.damageMin; hasWeapon = true; }
    if (s.damageMax) { damageMax += s.damageMax; hasWeapon = true; }
    if (s.spellPower) spellPower += s.spellPower;
    if (s.maxHp) maxHpBonus += s.maxHp;
    if (s.maxMana) maxManaBonus += s.maxMana;
    if (s.critChance) critChanceBonus += s.critChance;
    if (s.hpRegen) hpRegenBonus += s.hpRegen;
    if (s.manaRegen) manaRegenBonus += s.manaRegen;
    if (s.moveSpeed) moveSpeedBonus += s.moveSpeed;
  }

  // Buffs (temporary stat deltas, keys match player.stats or raw attrs — support both).
  let buffMoveSpeed = 0, buffCritChance = 0, buffDefenseFlat = 0, buffSpellPower = 0;
  let buffDamageMin = 0, buffDamageMax = 0, buffMaxHp = 0, buffMaxMana = 0;
  if (Array.isArray(player.buffs)) {
    for (const buff of player.buffs) {
      const s = buff && buff.stats;
      if (!s) continue;
      if (s.str) str += s.str;
      if (s.dex) dex += s.dex;
      if (s.int) int_ += s.int;
      if (s.vit) vit += s.vit;
      if (s.def) buffDefenseFlat += s.def;
      if (s.armor) buffDefenseFlat += s.armor;
      if (s.spellPower) buffSpellPower += s.spellPower;
      if (s.damageMin) buffDamageMin += s.damageMin;
      if (s.damageMax) buffDamageMax += s.damageMax;
      if (s.maxHp) buffMaxHp += s.maxHp;
      if (s.maxMana) buffMaxMana += s.maxMana;
      if (s.critChance) buffCritChance += s.critChance;
      if (s.moveSpeed) buffMoveSpeed += s.moveSpeed;
    }
  }

  // Derived stats.
  const maxHp = Math.round(BASE_HP + (lvl - 1) * HP_PER_LEVEL + vit * HP_PER_VIT + str * HP_PER_STR + maxHpBonus + buffMaxHp);
  const maxMana = Math.round(BASE_MANA + (lvl - 1) * MANA_PER_LEVEL + int_ * MANA_PER_INT + maxManaBonus + buffMaxMana);

  const meleeMin = hasWeapon ? Math.max(1, Math.round(damageMin + str * STR_MELEE_SCALE + buffDamageMin)) : FIST_MIN + Math.floor(str * 0.15);
  const meleeMax = hasWeapon ? Math.max(meleeMin + 1, Math.round(damageMax + str * STR_MELEE_SCALE + buffDamageMax)) : FIST_MAX + Math.floor(str * 0.15);

  // Ranged/spell power: base skill (Arcane Bolt) uses spellPower + dex.
  const totalSpellPower = Math.round(spellPower + int_ * 0.8 + buffSpellPower);
  const rangedMin = Math.max(1, Math.round(totalSpellPower * 0.8 + dex * 0.2));
  const rangedMax = Math.max(rangedMin + 1, Math.round(totalSpellPower * 1.2 + dex * 0.3));

  const defense = Math.max(0, Math.round(def * DEFENSE_PER_DEF_ATTR + armor + buffDefenseFlat));

  const critChance = clampNum(CRIT_CHANCE_BASE + dex * CRIT_CHANCE_PER_DEX + critChanceBonus + buffCritChance, 0, 0.75);
  const critMult = CRIT_MULT_BASE;

  const dodgeChance = clampNum(DODGE_CHANCE_BASE + dex * DODGE_CHANCE_PER_DEX, 0, DODGE_CHANCE_MAX);

  const hpRegen = HP_REGEN_BASE + vit * HP_REGEN_PER_VIT + hpRegenBonus;
  const manaRegen = MANA_REGEN_BASE + int_ * MANA_REGEN_PER_INT + manaRegenBonus;

  const moveCooldownRaw = BASE_MOVE_COOLDOWN - dex * MOVE_SPEED_PER_DEX - (moveSpeedBonus + buffMoveSpeed) * MOVE_COOLDOWN_PER_SPEED;
  const moveCooldown = clampNum(moveCooldownRaw, MIN_MOVE_COOLDOWN, 0.4);

  player.stats = {
    maxHp, maxMana,
    meleeMin, meleeMax,
    rangedMin, rangedMax,
    spellPower: totalSpellPower,
    defense,
    critChance, critMult,
    moveCooldown,
    hpRegen, manaRegen,
    dodgeChance,
  };

  // Clamp current hp/mana to new caps without healing.
  if (player.hp == null || player.hp > player.stats.maxHp) player.hp = Math.min(player.hp ?? player.stats.maxHp, player.stats.maxHp);
  if (player.mana == null || player.mana > player.stats.maxMana) player.mana = Math.min(player.mana ?? player.stats.maxMana, player.stats.maxMana);
  player.hp = Math.max(0, player.hp);
  player.mana = Math.max(0, player.mana);

  return player.stats;
}

function clampNum(v, a, b) { return v < a ? a : v > b ? b : v; }

// ---------------------------------------------------------------------------
// XP / leveling
// ---------------------------------------------------------------------------
export function xpForLevel(level) {
  return Math.round(50 * Math.pow(level, 1.5));
}

export function gainXP(game, amount) {
  const p = game.player;
  if (!p || p.dead || amount <= 0) return;
  p.xp += amount;
  let leveledUp = false;
  let need = xpForLevel(p.level);
  while (p.xp >= need) {
    p.xp -= need;
    p.level += 1;
    p.attrPoints += 3;
    p.skillPoints += 1;
    leveledUp = true;
    need = xpForLevel(p.level);
  }
  if (leveledUp) {
    recalcStats(p);
    p.hp = p.stats.maxHp;
    p.mana = p.stats.maxMana;
    try { game.bus && game.bus.emit('levelUp', { level: p.level }); } catch (e) { /* ignore */ }
    try { if (typeof game.effect === 'function') game.effect('levelup', p.x, p.y); } catch (e) { /* ignore */ }
    try { if (typeof game.log === 'function') game.log(`Level up! You are now level ${p.level}.`, '#ffd34f'); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Attribute spending
// ---------------------------------------------------------------------------
export function spendAttribute(player, attr) {
  if (!player || player.attrPoints <= 0) return false;
  if (!(attr in player.base)) return false;
  player.base[attr] += 1;
  player.attrPoints -= 1;
  recalcStats(player);
  return true;
}

// ---------------------------------------------------------------------------
// Combat math
// ---------------------------------------------------------------------------
// computeDamage(power, targetDefense, rng, critChance, critMult) -> {amount:int, crit:bool}
// `power` may be a number, or {min,max} — callers in this module pass a number (already rolled or a flat value);
// skills.js rolls its own min/max via rng before calling this, per DESIGN contract signature (power: number).
export function computeDamage(power, targetDefense, rng, critChance = 0, critMult = CRIT_MULT_BASE) {
  let base = typeof power === 'number' ? power : rng.range(power.min, power.max);
  const variance = 1 + (rng ? rng.range(-0.15, 0.15) : 0);
  let amount = base * variance;

  const crit = rng ? rng.chance(critChance) : false;
  if (crit) amount *= critMult;

  const def = Math.max(0, targetDefense || 0);
  const mitigated = amount * (100 / (100 + def * DEFENSE_K));

  amount = Math.max(1, Math.round(mitigated));
  return { amount, crit };
}

// mitigate(player, rawAmount) -> number. Applies player's own defense + dodge to incoming damage.
// Returns 0 to mean "dodged" (main.js should show "Dodge" float text in that case).
// Signature is fixed by the contract (no rng param); the dodge roll uses Math.random() since it's a
// presentation-layer coin flip, not part of the deterministic sim state (unlike computeDamage's rng).
export function mitigate(player, rawAmount) {
  if (!player || rawAmount <= 0) return 0;
  const stats = player.stats || {};
  if (stats.dodgeChance > 0 && Math.random() < stats.dodgeChance) {
    return 0; // dodged
  }
  const def = Math.max(0, stats.defense || 0);
  const mitigated = rawAmount * (100 / (100 + def * DEFENSE_K));
  return Math.max(1, Math.round(mitigated));
}

// ---------------------------------------------------------------------------
// Per-frame update: regen, timers, buffs.
// ---------------------------------------------------------------------------
export function updatePlayer(game, dt) {
  const p = game.player;
  if (!p) return;

  if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
  if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dt);
  if (p.moveTimer > 0) p.moveTimer = Math.max(0, p.moveTimer - dt);
  if (p._noManaFlashTimer > 0) p._noManaFlashTimer = Math.max(0, p._noManaFlashTimer - dt);

  if (!p.dead) {
    if (p.hp > 0 && p.hp < p.stats.maxHp) {
      p.hp = Math.min(p.stats.maxHp, p.hp + p.stats.hpRegen * dt);
    }
    if (p.mana < p.stats.maxMana) {
      p.mana = Math.min(p.stats.maxMana, p.mana + p.stats.manaRegen * dt);
    }
  }

  // Buffs: tick down, remove expired, recalc if anything changed.
  if (Array.isArray(p.buffs) && p.buffs.length) {
    let changed = false;
    for (let i = p.buffs.length - 1; i >= 0; i--) {
      const buff = p.buffs[i];
      buff.timer -= dt;
      if (buff.timer <= 0) {
        p.buffs.splice(i, 1);
        changed = true;
      }
    }
    if (changed) recalcStats(p);
  }
}
