// Item generation, rarities, loot tables, equip/use/drop. Owned by the Loot agent — see DESIGN.md §11.
//
// Ground-item pickup convention (main.js must honor this):
//   dropItem() pushes { id, x, y, item, noPickup:true } to game.groundItems at the player's current tile.
//   `noPickup` prevents main.js's "step onto tile -> auto pickup" logic from instantly re-collecting the
//   item the player is still standing on. main.js should clear `noPickup` (delete it or set false) the
//   first time it notices the player's (x,y) no longer equals the ground entry's (x,y) — i.e. once the
//   player has stepped off that tile, the item becomes pickupable again like any other ground item.

import { RARITY, RARITY_ORDER, uid, RNG, clamp } from './core.js';
import { recalcStats } from './character.js';

// ---------------------------------------------------------------------------
// Constants & tables
// ---------------------------------------------------------------------------

export const INVENTORY_SIZE = 24;

export const SLOTS = [
  { id: 'weapon', name: 'Weapon', icon: '⚔️' },
  { id: 'offhand', name: 'Off-Hand', icon: '🛡️' },
  { id: 'helm', name: 'Helm', icon: '⛑️' },
  { id: 'armor', name: 'Armor', icon: '🥋' },
  { id: 'boots', name: 'Boots', icon: '👢' },
  { id: 'ring', name: 'Ring', icon: '💍' },
  { id: 'amulet', name: 'Amulet', icon: '📿' },
];

const ALL_EQUIP = ['weapon', 'offhand', 'helm', 'armor', 'boots', 'ring', 'amulet'];
const WEAPON_KINDS = ['sword', 'axe', 'mace', 'dagger', 'staff', 'bow', 'wand'];
const OFFHAND_KINDS = ['shield', 'orb', 'tome'];

// ---------------------------------------------------------------------------
// Weapon kinds -> hands / role / class (DESIGN §17.9). The single source of truth: character.js's damage rows,
// skills.js's slot-1 class (and the class list + default attacks it derives), the equip rules, compareGear and the
// held-weapon model all read this — never a kind-by-kind check elsewhere.
//   hands  1 | 2              2 = off-hand slot locked + two-handed itemization tier (TWO_HAND_*)
//   role   'melee' | 'ranged' which damage row (meleeMin/Max or rangedMin/Max) the weapon's damage feeds
//   cls    weapon class: what slot-1 attack eligibility and per-class loadout memory key off (§17.10)
//   scale  attribute added to that damage row (x0.8, character.js WEAPON_ATTR_SCALE)
//   defaultAttack  the class's always-known attack skill id (guaranteed-skill rule)
// ---------------------------------------------------------------------------
const MELEE_1H = Object.freeze({ hands: 1, cls: 'melee1h', role: 'melee', scale: 'str', defaultAttack: 'cleave' });
export const WEAPON_KIND_INFO = Object.freeze({
  sword: MELEE_1H,
  axe: MELEE_1H,
  mace: MELEE_1H,
  dagger: MELEE_1H,
  bow: Object.freeze({ hands: 2, cls: 'bow', role: 'ranged', scale: 'dex', defaultAttack: 'bowShot' }),
  // Caster weapons (Phase 5): int-scaled. Wand is a 1H ranged shooter (keeps the off-hand for an orb/tome/shield);
  // staff is a 2H melee sweeper (off-hand locked, two-handed itemization tier).
  wand: Object.freeze({ hands: 1, cls: 'wand', role: 'ranged', scale: 'int', defaultAttack: 'spark' }),
  staff: Object.freeze({ hands: 2, cls: 'staff', role: 'melee', scale: 'int', defaultAttack: 'staffSweep' }),
});
// Fallback for unarmed AND for any weapon kind without an entry above (every itemized kind has one today, so in
// practice: unarmed, and old/unknown kinds from a save). An unlisted kind behaves exactly like a one-handed melee
// weapon: feeds meleeMin/Max (str), no off-hand restriction, melee1h class (Cleave).
export const FALLBACK_WEAPON_INFO = MELEE_1H;

export function weaponKindInfo(kind) {
  return (kind && Object.prototype.hasOwnProperty.call(WEAPON_KIND_INFO, kind)) ? WEAPON_KIND_INFO[kind] : FALLBACK_WEAPON_INFO;
}
// Info for an equipped/bag weapon item (null/undefined = unarmed -> fallback).
export function weaponInfo(weaponItem) { return weaponKindInfo(weaponItem && weaponItem.weaponKind); }
export function weaponClassOf(weaponItem) { return weaponInfo(weaponItem).cls; }
export function isTwoHanded(weaponItem) { return !!weaponItem && weaponInfo(weaponItem).hands === 2; }

// Two-handed itemization tier (§17.9), compensating for the locked off-hand. Applied per weapon kind at generation,
// so value-derived prices (shop buy / Featured / sell / buyback) follow automatically.
export const TWO_HAND_STAT_MULT = 1.5;
export const TWO_HAND_EXTRA_AFFIXES = 1;
export const TWO_HAND_VALUE_MULT = 1.4;

// Stat multiplier / extra affix count for a weapon kind's tier (1H: none; 2H: TWO_HAND_*).
export function weaponTier(weaponKind) {
  const two = weaponKindInfo(weaponKind).hands === 2;
  return { statMult: two ? TWO_HAND_STAT_MULT : 1, extraAffixes: two ? TWO_HAND_EXTRA_AFFIXES : 0 };
}
const TYPE_WEIGHTS = { weapon: 20, offhand: 12, helm: 12, armor: 16, boots: 12, ring: 14, amulet: 14 };

const ICONS = {
  sword: '🗡️', axe: '🪓', mace: '🔨', dagger: '🔪', staff: '🦯', bow: '🏹', wand: '🪄',
  shield: '🛡️', orb: '🔮', tome: '📖',
  helm: '⛑️', armor: '🥋', boots: '👢', ring: '💍', amulet: '📿',
  potionHealth: '🧪', potionMana: '💧',
};

const STAT_LABELS = {
  str: 'Strength', dex: 'Dexterity', int: 'Intellect', vit: 'Vitality', def: 'Defense',
  armor: 'Armor', damageMin: 'Min Damage', damageMax: 'Max Damage', spellPower: 'Spell Power',
  maxHp: 'Max HP', maxMana: 'Max Mana', critChance: 'Crit Chance', hpRegen: 'HP Regen',
  manaRegen: 'Mana Regen', moveSpeed: 'Move Speed', pierce: 'Arrow Pierce',
};

const PRIMARY_KEYS = new Set(['damageMin', 'damageMax', 'armor']);

// Tiered base names. 6 tiers, breakpoints below.
const TIER_BREAKPOINTS = [1, 4, 7, 10, 14, 18];

const WEAPON_NAMES = {
  sword: ['Rusty Sword', 'Iron Sword', 'Steel Longsword', "Knight's Sword", 'Runed Blade', 'Blade of the Ancients'],
  axe: ['Chipped Hatchet', 'Iron Axe', 'War Axe', 'Battle Axe', 'Runed Cleaver', "Executioner's Axe"],
  mace: ['Wooden Club', 'Iron Mace', 'Spiked Mace', 'War Hammer', 'Runed Maul', 'Skullcrusher'],
  dagger: ['Bent Dagger', 'Iron Dagger', 'Serrated Knife', "Assassin's Blade", 'Runed Kris', 'Nightfang'],
  staff: ['Gnarled Stick', 'Apprentice Staff', 'Oak Staff', "Sorcerer's Staff", 'Runed Staff', "Archmage's Staff"],
  bow: ['Crude Bow', 'Short Bow', "Hunter's Bow", 'Recurve Bow', 'Runed Longbow', 'Stormcaller Bow'],
  wand: ['Twig Wand', 'Apprentice Wand', 'Ashwood Wand', "Sorcerer's Wand", 'Runed Wand', "Archmage's Wand"],
};

const OFFHAND_NAMES = {
  shield: ['Wooden Buckler', 'Iron Shield', 'Reinforced Shield', "Knight's Shield", 'Runed Bulwark', 'Aegis of the Ancients'],
  orb: ['Cracked Orb', 'Apprentice Orb', 'Crystal Orb', "Sorcerer's Orb", 'Runed Orb', "Archmage's Orb"],
  tome: ['Tattered Tome', 'Apprentice Tome', 'Bound Tome', "Sorcerer's Tome", 'Runed Tome', 'Tome of the Ancients'],
};

const SLOT_NAMES = {
  helm: ['Cloth Cap', 'Leather Cap', 'Iron Helm', "Knight's Helm", 'Runed Helm', 'Crown of the Ancients'],
  armor: ['Tattered Tunic', 'Leather Armor', 'Chainmail', 'Plate Armor', 'Runed Plate', 'Aegis Plate'],
  boots: ['Worn Boots', 'Leather Boots', 'Iron Greaves', "Knight's Boots", 'Runed Boots', 'Boots of the Ancients'],
  ring: ['Copper Ring', 'Silver Ring', 'Gold Ring', 'Jeweled Ring', 'Runed Ring', 'Ring of the Ancients'],
  amulet: ['Bone Amulet', 'Silver Amulet', 'Jeweled Amulet', 'Ornate Amulet', 'Runed Amulet', 'Amulet of the Ancients'],
};

const LEGENDARY_NAMES = {
  weapon: ['Dawnbreaker', 'Doomfang', 'Worldsplitter', 'Nightfall', 'Starfury', 'Grimhowl'],
  offhand: ['Aegis Eternal', 'Soulwarden', 'Emberheart', 'Voidguard'],
  helm: ['Crown of Ages', 'Mindshatter', 'Diadem of the Deep'],
  armor: ['Ironclad Legacy', 'Bulwark of Kings', 'Carapace of the Void'],
  boots: ['Windstriders', 'Stormtread', "Wanderer's Legacy"],
  ring: ['Band of Eternity', 'Circle of Fate', 'Loop of the Void'],
  amulet: ['Heart of the Mountain', 'Eye of the Storm', 'Pendant of the Ancients'],
};

const POTION_SIZES = {
  minor: { heal: 30, mana: 20, value: 8 },
  normal: { heal: 70, mana: 50, value: 20 },
  greater: { heal: 150, mana: 100, value: 45 },
};

const TYPE_BASE_VALUE = { weapon: 10, offhand: 8, helm: 7, armor: 9, boots: 6, ring: 8, amulet: 8 };
const RARITY_VALUE_MULT = { common: 1, magic: 1.8, rare: 3.2, epic: 6, legendary: 14 };

// Affix pool. `types` lists which item.type values may roll this affix; an optional `kinds` further restricts a
// weapon affix to those weaponKinds (Piercing is bow-only).
const AFFIX_POOL = [
  { id: 'vicious', kind: 'prefix', word: 'Vicious', types: ['weapon'],
    roll: (lvl, rng) => ({ damageMin: 1 + lvl * 0.3, damageMax: 2 + lvl * 0.4 }) },
  // Each arrow passes through +1 more enemy: Bow Shot adds stats.pierce to its projectile's existing `pierce` field.
  { id: 'piercing', kind: 'prefix', word: 'Piercing', types: ['weapon'], kinds: ['bow'],
    roll: () => ({ pierce: 1 }) },
  { id: 'sturdy', kind: 'prefix', word: 'Sturdy', types: ['offhand', 'helm', 'armor', 'boots'],
    roll: (lvl, rng) => ({ armor: 2 + lvl * 0.5 }) },
  { id: 'keen', kind: 'prefix', word: 'Keen', types: ['weapon', 'ring', 'amulet'],
    roll: (lvl, rng) => ({ critChance: 0.02 + rng.range(0, 0.04) }) },
  { id: 'bear', kind: 'suffix', phrase: 'of the Bear', types: ALL_EQUIP,
    roll: (lvl, rng) => ({ vit: 1 + lvl * 0.3, str: 1 + lvl * 0.3 }) },
  { id: 'fox', kind: 'suffix', phrase: 'of the Fox', types: ALL_EQUIP,
    roll: (lvl, rng) => ({ dex: 1 + lvl * 0.4 }) },
  { id: 'owl', kind: 'suffix', phrase: 'of the Owl', types: ALL_EQUIP,
    roll: (lvl, rng) => ({ int: 1 + lvl * 0.4 }) },
  { id: 'vigor', kind: 'suffix', phrase: 'of Vigor', types: ALL_EQUIP,
    roll: (lvl, rng) => ({ hpRegen: 0.3 + lvl * 0.08 }) },
  { id: 'haste', kind: 'suffix', phrase: 'of Haste', types: ALL_EQUIP,
    roll: (lvl, rng) => ({ moveSpeed: 0.05 + rng.range(0, 0.10) }) },
  { id: 'power', kind: 'suffix', phrase: 'of Power', types: ['weapon', 'offhand', 'ring', 'amulet'],
    roll: (lvl, rng) => ({ spellPower: 1 + lvl * 0.5 }) },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function tierIndexFor(itemLevel) {
  let idx = 0;
  for (let i = 0; i < TIER_BREAKPOINTS.length; i++) if (itemLevel >= TIER_BREAKPOINTS[i]) idx = i;
  return idx;
}

function tierName(type, kind, itemLevel) {
  const idx = tierIndexFor(itemLevel);
  if (type === 'weapon') return WEAPON_NAMES[kind][idx];
  if (type === 'offhand') return OFFHAND_NAMES[kind][idx];
  return SLOT_NAMES[type][idx];
}

const STAFF_SP_BASE = 3;
const STAFF_SP_PER_LVL = 1.35;

// Unrounded common-rarity base stats (before the 2H tier multiplier) — exported for the balance tests only.
export function baseStatsFor(type, kind, lvl) {
  if (type === 'weapon') return weaponBaseStats(kind, lvl);
  if (type === 'offhand') return offhandBaseStats(kind, lvl);
  return {};
}

function weaponBaseStats(kind, lvl) {
  switch (kind) {
    case 'sword': {
      const min = 2 + lvl * 1.0;
      return { damageMin: min, damageMax: min + (3 + lvl * 0.4), dex: 0.5 + lvl * 0.3 };
    }
    case 'axe': {
      const min = 2 + lvl * 1.0;
      return { damageMin: min, damageMax: min + (6 + lvl * 0.8), str: 1 + lvl * 0.5 };
    }
    case 'mace': {
      const min = 3 + lvl * 1.2;
      return { damageMin: min, damageMax: min + (5 + lvl * 0.7), str: 1.2 + lvl * 0.55 };
    }
    case 'dagger': {
      const min = 1 + lvl * 0.7;
      return { damageMin: min, damageMax: min + (1 + lvl * 0.2), dex: 1 + lvl * 0.5, critChance: 0.01 + lvl * 0.002 };
    }
    case 'staff': {
      // Spell power raised from 2 + lvl*1.0 (Phase 5) so staff (x1.5 as a 2H weapon) keeps >= 1.1x a same-level
      // wand + orb (and wand + tome) combo's spell power — see DESIGN §17.9 and test/items.test.js.
      const min = 1 + lvl * 0.5;
      return { damageMin: min, damageMax: min + (1 + lvl * 0.2), spellPower: STAFF_SP_BASE + lvl * STAFF_SP_PER_LVL, int: 1 + lvl * 0.4 };
    }
    case 'wand': {
      // Caster 1H: low physical damage (Spark's damage is mostly the int*0.8 on the ranged row), real spell power + int.
      const min = 1 + lvl * 0.6;
      return { damageMin: min, damageMax: min + (1.5 + lvl * 0.25), spellPower: 1.5 + lvl * 0.7, int: 1 + lvl * 0.4 };
    }
    case 'bow': {
      const min = 1 + lvl * 0.8;
      return { damageMin: min, damageMax: min + (2 + lvl * 0.3), dex: 1 + lvl * 0.5 };
    }
    default:
      return { damageMin: 1, damageMax: 2 };
  }
}

function offhandBaseStats(kind, lvl) {
  switch (kind) {
    case 'shield': return { armor: 2 + lvl * 0.9, def: 1 + lvl * 0.4 };
    case 'orb': return { spellPower: 2 + lvl * 0.9, maxMana: 3 + lvl * 1.2 };
    case 'tome': return { spellPower: 1.5 + lvl * 0.7, int: 1 + lvl * 0.5 };
    default: return {};
  }
}

const SLOT_BASE_STATS = {
  helm: (lvl) => ({ armor: 2 + lvl * 0.8, vit: 0.5 + lvl * 0.25 }),
  armor: (lvl) => ({ armor: 4 + lvl * 1.4, vit: 1 + lvl * 0.3 }),
  boots: (lvl) => ({ armor: 1 + lvl * 0.5, dex: 0.5 + lvl * 0.25 }),
  ring: (lvl, rng) => {
    const picks = rng.shuffle(['str', 'dex', 'int', 'vit', 'def']).slice(0, 2);
    const out = {};
    for (const k of picks) out[k] = 1 + lvl * 0.4;
    return out;
  },
  amulet: (lvl, rng) => {
    const picks = rng.shuffle(['vit', 'int', 'maxHp', 'maxMana', 'spellPower']).slice(0, 2);
    const out = {};
    for (const k of picks) {
      if (k === 'maxHp') out[k] = 6 + lvl * 2.2;
      else if (k === 'maxMana') out[k] = 5 + lvl * 1.8;
      else out[k] = 1 + lvl * 0.4;
    }
    return out;
  },
};

// Attribute stats grow slowly (~0.25-0.4/level in SLOT_BASE_STATS and most affixes) — rounding
// them to whole numbers made items feel identical for several levels in a row. Keeping one
// decimal place instead (same trick already used for hpRegen/manaRegen) makes every level read
// as a real upgrade without touching the growth formulas or inflating power.
const ONE_DECIMAL_KEYS = new Set(['hpRegen', 'manaRegen', 'str', 'dex', 'int', 'vit', 'def']);

function finalizeStats(stats) {
  for (const k of Object.keys(stats)) {
    let v = stats[k];
    if (k === 'critChance' || k === 'moveSpeed') v = Math.round(v * 100) / 100;
    else if (ONE_DECIMAL_KEYS.has(k)) v = Math.round(v * 10) / 10;
    else v = Math.round(v);
    if (!v) { delete stats[k]; continue; }
    stats[k] = v;
  }
}

function rollAffixes(rng, type, itemLevel, count, statsOut, weaponKind = null) {
  if (count <= 0) return { prefixWords: [], suffixPhrases: [] };
  let eligible = rng.shuffle(AFFIX_POOL.filter((a) => a.types.includes(type) && (!a.kinds || a.kinds.includes(weaponKind))));
  let chosen = eligible.slice(0, Math.min(count, eligible.length));
  if (count >= 2 && !chosen.some((a) => a.kind === 'prefix')) {
    const prefixOptions = eligible.filter((a) => a.kind === 'prefix' && !chosen.includes(a));
    if (prefixOptions.length) { chosen = chosen.slice(0, -1); chosen.push(prefixOptions[0]); }
  }
  for (const a of chosen) {
    const contrib = a.roll(itemLevel, rng);
    for (const [k, v] of Object.entries(contrib)) statsOut[k] = (statsOut[k] || 0) + v;
  }
  return {
    prefixWords: chosen.filter((a) => a.kind === 'prefix').map((a) => a.word),
    suffixPhrases: chosen.filter((a) => a.kind === 'suffix').map((a) => a.phrase),
  };
}

function buildName(rarity, baseName, affixResult, type, rng) {
  if (rarity === 'legendary') {
    const pool = LEGENDARY_NAMES[type] || LEGENDARY_NAMES.weapon;
    const flavor = rng.pick(pool);
    return `${flavor} (Legendary ${baseName})`;
  }
  let name = baseName;
  if (affixResult.prefixWords.length) name = `${affixResult.prefixWords.join(' ')} ${name}`;
  if (affixResult.suffixPhrases.length) {
    let suf = affixResult.suffixPhrases[0];
    for (let i = 1; i < affixResult.suffixPhrases.length; i++) {
      suf += ` and ${affixResult.suffixPhrases[i].replace(/^of\s+/i, '')}`;
    }
    name = `${name} ${suf}`;
  }
  return name;
}

export function computeValue(type, itemLevel, rarity, weaponKind = null) {
  const base = (TYPE_BASE_VALUE[type] || 8) + itemLevel * 4;
  const hands = type === 'weapon' && weaponKindInfo(weaponKind).hands === 2 ? TWO_HAND_VALUE_MULT : 1;
  return Math.round(base * (RARITY_VALUE_MULT[rarity] || 1) * hands);
}

function rollRarity(rng, depth, { elite = false, boss = false, minRarity = null } = {}) {
  const w = {};
  for (const id of RARITY_ORDER) w[id] = RARITY[id].weight;
  const depthFactor = clamp(depth / 20, 0, 1);
  w.common *= (1 - depthFactor * 0.6);
  w.magic *= (1 + depthFactor * 0.3);
  w.rare *= (1 + depthFactor * 1.5);
  w.epic *= (1 + depthFactor * 3.0);
  w.legendary *= (1 + depthFactor * 6.0);
  if (depth < 4 && !boss) w.legendary = 0;
  if (elite) { w.common *= 0.5; w.rare *= 2; w.epic *= 2.5; w.legendary *= 2; }
  if (boss) { w.common = 0; w.magic *= 0.3; w.rare *= 3; w.epic *= 4; w.legendary *= 5; }
  if (minRarity) {
    const minIdx = RARITY_ORDER.indexOf(minRarity);
    RARITY_ORDER.forEach((id, i) => { if (i < minIdx) w[id] = 0; });
  }
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  if (total <= 0) return minRarity || 'common';
  return rng.weighted(RARITY_ORDER, (id) => w[id]);
}

function potionSizeForDepth(depth) {
  if (depth >= 8) return 'greater';
  if (depth >= 4) return 'normal';
  return 'minor';
}

function buildPotion(kind, size, itemLevel) {
  const cfg = POTION_SIZES[size] || POTION_SIZES.minor;
  const amount = kind === 'health' ? cfg.heal : cfg.mana;
  const name = `${cap(size)} ${kind === 'health' ? 'Health' : 'Mana'} Potion`;
  return {
    id: uid(), name, baseName: name, type: 'potion', slot: null,
    rarity: 'common', icon: kind === 'health' ? ICONS.potionHealth : ICONS.potionMana,
    itemLevel, potionKind: kind, size,
    potion: kind === 'health' ? { heal: amount } : { mana: amount },
    stack: 1, maxStack: 20,
    value: cfg.value,
  };
}

// ---------------------------------------------------------------------------
// Public API (§11)
// ---------------------------------------------------------------------------

export function generateItem(depth, rng = new RNG(), opts = {}) {
  depth = Math.max(1, Math.floor(depth) || 1);
  const type = opts.type || rng.weighted(ALL_EQUIP, (t) => TYPE_WEIGHTS[t]);

  if (type === 'potion') {
    const size = opts.size || potionSizeForDepth(depth);
    const kind = opts.potionKind || (rng.chance(0.65) ? 'health' : 'mana');
    const potion = buildPotion(kind, size, clamp(depth, 1, 60));
    potion.stack = opts.stack ?? 1;
    return potion;
  }

  const itemLevel = opts.itemLevel || clamp(depth + rng.int(-1, 1), 1, 60);
  const rarity = opts.rarity || rollRarity(rng, depth, { elite: !!opts.elite, boss: !!opts.boss, minRarity: opts.minRarity });

  let weaponKind, offhandKind, baseName, icon, slot, raw;
  if (type === 'weapon') {
    weaponKind = opts.weaponKind || rng.pick(WEAPON_KINDS);
    slot = 'weapon';
    baseName = tierName('weapon', weaponKind, itemLevel);
    icon = ICONS[weaponKind];
    raw = weaponBaseStats(weaponKind, itemLevel);
  } else if (type === 'offhand') {
    offhandKind = opts.offhandKind || rng.pick(OFFHAND_KINDS);
    slot = 'offhand';
    baseName = tierName('offhand', offhandKind, itemLevel);
    icon = ICONS[offhandKind];
    raw = offhandBaseStats(offhandKind, itemLevel);
  } else {
    slot = type;
    baseName = tierName(type, null, itemLevel);
    icon = ICONS[type];
    raw = SLOT_BASE_STATS[type](itemLevel, rng);
  }

  // Two-handed weapons (§17.9): base stats x1.5 and +1 affix at every rarity (price x1.4 in computeValue).
  const tier = type === 'weapon' ? weaponTier(weaponKind) : { statMult: 1, extraAffixes: 0 };
  const mult = RARITY[rarity].statMult * tier.statMult;
  const stats = {};
  for (const [k, v] of Object.entries(raw)) stats[k] = v * mult;

  const affixResult = rollAffixes(rng, type, itemLevel, RARITY[rarity].affixes + tier.extraAffixes, stats, weaponKind || null);
  finalizeStats(stats);

  const name = buildName(rarity, baseName, affixResult, type, rng);
  const value = computeValue(type, itemLevel, rarity, weaponKind || null);

  const item = { id: uid(), name, baseName, type, slot, rarity, icon, itemLevel, stats, value };
  if (weaponKind) item.weaponKind = weaponKind;
  if (offhandKind) item.offhandKind = offhandKind;
  return item;
}

// ---------------------------------------------------------------------------
// Skill books (DESIGN §11, §17.11). skills.js registers these hooks (items.js can't import skills.js: cycle):
//   info(skillId, player) -> { name, icon, category, categoryLabel, requires, description, unique, rank, maxRank } | null
//   read(player, skillId) -> { ok, isNew, rank, name, reason }       (learnSkill + what happened)
//   bossDrops(bossType, bossesDefeated, rng) -> [skillId]            (first kill / repeat kill book rolls)
//   randomGeneric(rng) -> skillId | null                              (a hidden treasure room's bonus book, §17.11)
// ---------------------------------------------------------------------------
let skillBookHooks = null;
export function setSkillBookHooks(hooks) { skillBookHooks = hooks || null; }

export const SKILL_BOOK_ICON = '📕';
// A skill book item. Boss-unique books are legendary-coloured, generic-pool books rare-coloured. Never merchant stock
// (generateItem never rolls this type), but sellable / buy-back-able like any bag item.
export function createSkillBook(skillId, depth = 1) {
  const info = skillBookHooks ? skillBookHooks.info(skillId, null) : null;
  const unique = !!(info && info.unique);
  const itemLevel = clamp(Math.floor(depth) || 1, 1, 60);
  const name = `Skill Book: ${(info && info.name) || skillId}`;
  return {
    id: uid(), name, baseName: name, type: 'skillbook', slot: null,
    rarity: unique ? 'legendary' : 'rare', icon: SKILL_BOOK_ICON,
    itemLevel, skillId, stats: {},
    value: Math.round((unique ? 120 : 60) + itemLevel * 4),
  };
}

// Reads a skill book from the bag: learns the skill (+1 skill point) or, if known, +1 rank. Not consumed (returns
// false) at max rank or for an unknown skill id.
function readSkillBookItem(game, item) {
  const player = game.player;
  const idx = player.inventory.findIndex((i) => i.id === item.id);
  if (idx === -1 || !skillBookHooks) return false;
  const res = skillBookHooks.read(player, item.skillId);
  if (!res.ok) {
    game.log?.(res.reason === 'max' ? `${res.name} is already mastered (rank ${res.rank}).` : 'The pages are unreadable.', '#aaaaaa');
    game.bus?.emit('denied');
    return false;
  }
  player.inventory.splice(idx, 1);
  recalcStats(player);
  if (res.isNew) {
    game.log?.(`Learned ${res.name}! +1 skill point. Assign it in the Skills tab (K).`, '#ffd43b');
    game.floatText?.(player.x, player.y, `New skill: ${res.name}`, '#ffd43b', { size: 18 });
  } else {
    game.log?.(`${res.name} rises to rank ${res.rank}!`, '#ffd43b');
    game.floatText?.(player.x, player.y, `${res.name} rank ${res.rank}`, '#ffd43b', { size: 16 });
  }
  game.effect?.('levelup', player.x, player.y);
  game.bus?.emit('skillLearned', { skillId: item.skillId, isNew: res.isNew, rank: res.rank });
  return true;
}

// `opts.bossesDefeated` (the player's list, before this kill is recorded) enables a boss's skill-book drops (§17.11).
export function rollLoot(enemy, depth, rng, opts = {}) {
  const drops = [];
  const isBoss = enemy?.behavior === 'boss' || enemy?.type === 'boss';
  const isElite = !!enemy?.elite;

  // Gold
  const goldChance = isBoss ? 1 : 0.6;
  if (rng.chance(goldChance)) {
    const [gmin, gmax] = enemy?.gold || [2 + depth * 2, 6 + depth * 3];
    let amount = rng.int(gmin, gmax);
    if (isBoss) amount = Math.round(amount * 3);
    else if (isElite) amount = Math.round(amount * 1.5);
    if (amount > 0) drops.push({ type: 'gold', amount });
  }

  // Items
  if (isBoss) {
    const n = rng.int(3, 5);
    let haveRarePlus = false;
    // The boss's guaranteed drop is at least rare, with a shot at epic/legendary that
    // improves slightly the deeper the run goes.
    const depthBonus = clamp(depth / 40, 0, 1);
    const legendaryChance = 0.05 + depthBonus * 0.05; // 5% -> 10%
    const epicChance = 0.25 + depthBonus * 0.10;      // 25% -> 35%
    let guaranteedMin = 'rare';
    if (rng.chance(legendaryChance)) guaranteedMin = 'legendary';
    else if (rng.chance(epicChance)) guaranteedMin = 'epic';
    for (let i = 0; i < n; i++) {
      const forceMin = (!haveRarePlus && i === n - 1) ? guaranteedMin : null;
      const item = generateItem(depth, rng, { boss: true, minRarity: forceMin });
      if (RARITY_ORDER.indexOf(item.rarity) >= RARITY_ORDER.indexOf('rare')) haveRarePlus = true;
      drops.push(item);
    }
    // Bosses always leave a health potion behind, on top of the mob potion roll below.
    drops.push(generateItem(depth, rng, { type: 'potion', potionKind: 'health' }));
    // Skill books (§17.11): first kill of this boss type this run = its unique book; repeat kills = small chances.
    if (skillBookHooks && Array.isArray(opts.bossesDefeated) && enemy?.type) {
      for (const id of skillBookHooks.bossDrops(enemy.type, opts.bossesDefeated, rng)) drops.push(createSkillBook(id, depth));
    }
  } else {
    const dropChance = isElite ? 0.6 : 0.18;
    if (rng.chance(dropChance)) drops.push(generateItem(depth, rng, { elite: isElite }));
  }

  // Potion (bosses already got a guaranteed health potion above)
  if (!isBoss && rng.chance(0.12)) {
    const kind = rng.chance(0.65) ? 'health' : 'mana';
    drops.push(generateItem(depth, rng, { type: 'potion', potionKind: kind }));
  }

  return drops;
}

// ---------------------------------------------------------------------------
// Treasure chests (§17.14). Pure: callable standalone (tests, the §17.17 simulation harness), like rollLoot.
//   itemLevel  generateItem's opts.itemLevel — never a shifted `depth`, so the rarity roll (incl. the depth<4
//              legendary gate) stays the current depth's; the tier only moves how good the gear is.
//   elite      opts.elite on the rarity roll; rarePerChest = one item per chest at opts.minRarity 'rare'.
//   gold/potion are per ROOM, so they go in the room's first chest (opts.first).
// ---------------------------------------------------------------------------
export const CHEST_LOOT = Object.freeze({
  cache: Object.freeze({ items: [1, 1], levelOffset: -1, jitter: [-1, 1], elite: false, rarePerChest: false, gold: [10, 20], potion: 0 }),
  hoard: Object.freeze({ items: [2, 2], levelOffset: 0, jitter: [-1, 1], elite: true, rarePerChest: false, gold: [20, 40], potion: 0.5 }),
  vault: Object.freeze({ items: [2, 3], levelOffset: 0, jitter: [1, 2], elite: true, rarePerChest: true, gold: [40, 70], potion: 1 }),
});

// Item level of one treasure item: Cache max(1, depth-1) ±1, Hoard depth ±1, Vault depth +1..2 (never below depth).
export function treasureItemLevel(tier, depth, rng) {
  const t = CHEST_LOOT[tier] || CHEST_LOOT.cache;
  const base = Math.max(1, depth + t.levelOffset);
  return clamp(base + rng.int(t.jitter[0], t.jitter[1]), 1, 60);
}

// One chest's contents -> [item | {type:'gold', amount}]. opts.first: this is the room's first chest (gets the room's
// gold, potion roll and — opts.hidden, §17.11 — one random generic-pool skill book).
export function rollChestContents(tier, depth, rng, opts = {}) {
  depth = Math.max(1, Math.floor(depth) || 1);
  const t = CHEST_LOOT[tier] || CHEST_LOOT.cache;
  const first = opts.first !== false;
  const out = [];
  const n = rng.int(t.items[0], t.items[1]);
  for (let i = 0; i < n; i++) {
    out.push(generateItem(depth, rng, {
      itemLevel: treasureItemLevel(tier, depth, rng),
      elite: t.elite,
      minRarity: t.rarePerChest && i === 0 ? 'rare' : null,
    }));
  }
  if (first) {
    out.push({ type: 'gold', amount: rng.int(t.gold[0], t.gold[1]) * depth });
    if (t.potion > 0 && rng.chance(t.potion)) {
      out.push(generateItem(depth, rng, { type: 'potion', potionKind: rng.chance(0.65) ? 'health' : 'mana' }));
    }
    if (opts.hidden && skillBookHooks && typeof skillBookHooks.randomGeneric === 'function') {
      const id = skillBookHooks.randomGeneric(rng);
      if (id) out.push(createSkillBook(id, depth));
    }
  }
  return out;
}

// Two-handed equip rules (§17.9), without changing anything -> { ok, reason?, evicts? }.
// `evicts` = the off-hand a 2H weapon would push into the bag; `reason` = the refusal message.
export function equipCheck(player, item) {
  if (!player || !player.equipment || !item || item.type === 'potion') return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(player.equipment, item.slot)) return { ok: false };
  const weapon = player.equipment.weapon;
  if (item.slot === 'offhand' && isTwoHanded(weapon)) {
    return { ok: false, reason: `Can't equip: ${weapon.name} is two-handed` };
  }
  const off = player.equipment.offhand;
  if (item.slot === 'weapon' && isTwoHanded(item) && off) {
    // Bag after the swap: -1 (this item leaves it) +1 (the old weapon, if any) +1 (the evicted off-hand).
    const inBag = (player.inventory || []).some((i) => i && i.id === item.id) ? 1 : 0;
    const after = (player.inventory || []).length - inBag + (weapon ? 1 : 0) + 1;
    if (after > INVENTORY_SIZE) {
      // Both the old weapon and the off-hand may need a slot, so name a count rather than just one item.
      const short = after - INVENTORY_SIZE;
      return { ok: false, reason: `Bag full: need ${short} more free slot${short === 1 ? '' : 's'}` };
    }
    return { ok: true, evicts: off };
  }
  return { ok: true };
}

// `log(text, color)` (optional) receives the two-handed refusal / off-hand eviction messages.
export function equipItem(player, item, log = null) {
  const idx = player.inventory.findIndex((i) => i.id === item.id);
  if (idx === -1) return false;
  if (item.type === 'potion') return false;
  const slot = item.slot;
  if (!Object.prototype.hasOwnProperty.call(player.equipment, slot)) return false;
  const check = equipCheck(player, item);
  if (!check.ok) {
    if (check.reason && typeof log === 'function') log(check.reason, '#ff8787');
    return false;
  }
  const prev = player.equipment[slot] || null;
  player.inventory.splice(idx, 1);
  player.equipment[slot] = item;
  if (prev) player.inventory.splice(idx, 0, prev);
  if (check.evicts) {
    player.equipment.offhand = null;
    player.inventory.push(check.evicts);
    if (typeof log === 'function') log(`${check.evicts.name} unequipped (two-handed weapon)`, '#9aa3bd');
  }
  recalcStats(player);
  return true;
}

// Saved items keep the icon they were generated with; re-derive a weapon's from the current ICONS table so e.g. a
// staff saved before Phase 5 (when staff used the wand emoji) doesn't look like a wand. No-op for everything else.
export function refreshItemIcon(item) {
  if (item && item.type === 'weapon' && item.weaponKind && ICONS[item.weaponKind]) item.icon = ICONS[item.weaponKind];
  return item;
}

// Saves from before bows/staves were two-handed can hold a bow or staff AND an off-hand. Moves the off-hand to the bag and returns
// null, or returns it (already unequipped) when the bag is full so the caller can drop it on the ground.
export function enforceTwoHanded(player) {
  const off = player && player.equipment && player.equipment.offhand;
  if (!off || !isTwoHanded(player.equipment.weapon)) return null;
  player.equipment.offhand = null;
  recalcStats(player);
  if (player.inventory.length < INVENTORY_SIZE) { player.inventory.push(off); return null; }
  return off;
}

export function unequipItem(player, slot) {
  const item = player.equipment[slot];
  if (!item) return false;
  if (player.inventory.length >= INVENTORY_SIZE) return false;
  player.equipment[slot] = null;
  player.inventory.push(item);
  recalcStats(player);
  return true;
}

export function useItem(game, item) {
  const player = game.player;
  if (item.type === 'skillbook') return readSkillBookItem(game, item);
  if (item.type !== 'potion') return equipItem(player, item, typeof game.log === 'function' ? (t, c) => game.log(t, c) : null);

  const idx = player.inventory.findIndex((i) => i.id === item.id);
  if (idx === -1) return false;
  const pot = player.inventory[idx];
  let used = false;

  if (pot.potion?.heal) {
    if (player.hp < player.stats.maxHp) {
      const before = player.hp;
      player.hp = clamp(player.hp + pot.potion.heal, 0, player.stats.maxHp);
      const healed = player.hp - before;
      game.floatText?.(player.x, player.y, `+${healed} HP`, '#4caf50');
      game.effect?.('heal', player.x, player.y);
      game.bus?.emit('potionUsed', { kind: 'heal' });
      used = true;
    }
  }
  if (pot.potion?.mana) {
    if (player.mana < player.stats.maxMana) {
      const before = player.mana;
      player.mana = clamp(player.mana + pot.potion.mana, 0, player.stats.maxMana);
      const gained = player.mana - before;
      game.floatText?.(player.x, player.y, `+${gained} MP`, '#4f8cff');
      game.effect?.('heal', player.x, player.y);
      game.bus?.emit('potionUsed', { kind: 'mana' });
      used = true;
    }
  }

  if (!used) {
    game.log?.(`${pot.name}: already full.`, '#aaaaaa');
    return false;
  }

  pot.stack -= 1;
  if (pot.stack <= 0) {
    player.inventory.splice(idx, 1);
    // A drained pinned stack hands its pin to another stack of the same size (a full stack
    // overflows into a second one), else the pin clears and the hotbar reverts to best-first.
    const kind = potionHotbarKind(pot);
    const field = kind && PIN_FIELD[kind];
    if (field && player[field] === pot.id) {
      const twin = player.inventory.find((it) => it && it.type === 'potion'
        && it.potionKind === pot.potionKind && it.size === pot.size);
      player[field] = twin ? twin.id : null;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hotbar potion selection (5 / 6, LT / RT). See DESIGN.md §17.8b.
// A pinned stack (player.activeHealPotionId / activeManaPotionId) wins; otherwise the
// strongest stack of that kind (largest restore amount, then item level) is drunk first.
// ---------------------------------------------------------------------------
const PIN_FIELD = { heal: 'activeHealPotionId', mana: 'activeManaPotionId' };

// 'heal' | 'mana' | null — which hotbar slot a potion belongs to.
export function potionHotbarKind(item) {
  if (!item || item.type !== 'potion' || !item.potion) return null;
  if (item.potion.heal > 0) return 'heal';
  if (item.potion.mana > 0) return 'mana';
  return null;
}

export function bestPotion(player, kind) {
  let best = null;
  for (const it of player?.inventory || []) {
    if (potionHotbarKind(it) !== kind) continue;
    if (!best || it.potion[kind] > best.potion[kind]
      || (it.potion[kind] === best.potion[kind] && (it.itemLevel || 0) > (best.itemLevel || 0))) best = it;
  }
  return best;
}

// The pinned stack for this kind if it's still in the bag, else null (stale ids from a
// drop/sale/old save just fall through to the best-first default).
export function pinnedPotion(player, kind) {
  const id = player && player[PIN_FIELD[kind]];
  if (id == null) return null;
  return (player.inventory || []).find((it) => it && it.id === id && potionHotbarKind(it) === kind) || null;
}

// What the hotbar key for `kind` will drink right now.
export function activePotion(player, kind) {
  return pinnedPotion(player, kind) || bestPotion(player, kind);
}

// Pin `item` as its kind's hotbar potion, or unpin it if it already is.
// Returns 'pinned' | 'unpinned' | null (not a potion).
export function togglePotionPin(player, item) {
  const kind = potionHotbarKind(item);
  if (!kind || !player) return null;
  const field = PIN_FIELD[kind];
  if (player[field] === item.id) { player[field] = null; return 'unpinned'; }
  player[field] = item.id;
  return 'pinned';
}

export function dropItem(game, item) {
  const player = game.player;
  const idx = player.inventory.findIndex((i) => i.id === item.id);
  if (idx === -1) return false;
  player.inventory.splice(idx, 1);
  // noPickup guards against instant re-pickup while the player is still standing on this tile;
  // main.js should clear it once the player steps off (x,y).
  game.groundItems.push({ id: uid(), x: player.x, y: player.y, item, noPickup: true });
  return true;
}

// Selling/salvaging always removes the whole inventory entry (the entire stack for a
// potion), so the price must cover every unit in it, not just one.
export function sellValue(item) {
  return Math.max(1, Math.round(item.value * 0.35 * (item.stack || 1)));
}

// Merchant buy price. Chosen so sellValue/buyPrice lands around 27% (within the ~25-35%
// "sell back a fraction of what you paid" range) while keeping potions and a magic item or
// two affordable at a merchant depth, with rares costing a more serious chunk of savings.
export const BUY_MULT = 1.3;
export function buyPrice(item) {
  return Math.max(1, Math.round(item.value * BUY_MULT));
}

export function addToInventory(player, item) {
  if (item.type === 'potion') {
    for (const it of player.inventory) {
      if (it.type === 'potion' && it.potionKind === item.potionKind && it.size === item.size && it.stack < it.maxStack) {
        const room = it.maxStack - it.stack;
        const moved = Math.min(room, item.stack);
        it.stack += moved;
        item.stack -= moved;
        if (item.stack <= 0) return true;
      }
    }
  }
  if (player.inventory.length >= INVENTORY_SIZE) return false;
  player.inventory.push(item);
  return true;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatStatValue(key, val) {
  if (key === 'critChance' || key === 'moveSpeed') return `${(val * 100).toFixed(1)}%`;
  if (key === 'hpRegen' || key === 'manaRegen') return `${val.toFixed(1)}/s`;
  if (ONE_DECIMAL_KEYS.has(key)) return `${val.toFixed(1)}`;
  return `${Math.round(val)}`;
}

function typeLabel(item) {
  if (item.type === 'weapon') return `Weapon (${cap(item.weaponKind)}${isTwoHanded(item) ? ', Two-handed' : ''})`;
  if (item.type === 'offhand') return `Off-Hand (${cap(item.offhandKind)})`;
  if (item.type === 'potion') return 'Potion';
  if (item.type === 'skillbook') return 'Skill Book';
  return cap(item.type);
}

function primaryStatLine(item) {
  if (item.type === 'potion') {
    const bits = [];
    if (item.potion?.heal) bits.push(`Heals ${item.potion.heal} HP`);
    if (item.potion?.mana) bits.push(`Restores ${item.potion.mana} Mana`);
    return bits.join(', ');
  }
  if (item.stats?.damageMin != null) return `Damage ${Math.round(item.stats.damageMin)}–${Math.round(item.stats.damageMax)}`;
  if (item.stats?.armor != null) return `Armor ${Math.round(item.stats.armor)}`;
  return '';
}

function bonusStatLines(item) {
  const lines = [];
  for (const [k, v] of Object.entries(item.stats || {})) {
    if (PRIMARY_KEYS.has(k) || !v) continue;
    lines.push(`+${formatStatValue(k, v)} ${STAT_LABELS[k] || k}`);
  }
  return lines;
}

const CMP_EPS = { critChance: 0.001, moveSpeed: 0.001, hpRegen: 0.05, manaRegen: 0.05 };

function compareLines(item, equipped) {
  const keys = new Set([...Object.keys(item.stats || {}), ...Object.keys(equipped.stats || {})]);
  const lines = [];
  for (const k of keys) {
    const a = item.stats?.[k] || 0;
    const b = equipped.stats?.[k] || 0;
    const delta = a - b;
    const eps = CMP_EPS[k] ?? 0.5;
    if (Math.abs(delta) < eps) continue;
    const positive = delta > 0;
    const color = positive ? '#4caf50' : '#e5534b';
    const arrow = positive ? '▲' : '▼';
    const label = STAT_LABELS[k] || k;
    const dtext = formatStatValue(k, Math.abs(delta));
    lines.push(`<div class="tt-cmp-line" style="color:${color};">${positive ? '+' : '-'}${dtext} ${escapeHtml(label)} ${arrow}</div>`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Gear comparison: simulate wearing `item` and diff the stats the player actually plays with.
// ---------------------------------------------------------------------------

// Derived stats that decide better/worse. `floor` keeps tiny bases (e.g. 0 regen) from turning a small gain
// into a huge relative change. Crit/dodge are compared in absolute points against a 20% floor.
// A metric whose `get` returns null is "not applicable" on that side (e.g. melee with a bow equipped) and is skipped,
// never treated as a real 0.
const CMP_METRICS = [
  { k: 'melee', get: (s) => (s.meleeMin == null ? null : (s.meleeMin + s.meleeMax) / 2), floor: 6 },
  { k: 'ranged', get: (s) => (s.rangedMin == null ? null : (s.rangedMin + s.rangedMax) / 2), floor: 6 },
  { k: 'pierce', get: (s) => s.pierce || 0, floor: 4 },
  { k: 'spellPower', get: (s) => s.spellPower, floor: 6 },
  { k: 'defense', get: (s) => s.defense, floor: 6 },
  { k: 'maxHp', get: (s) => s.maxHp, floor: 60 },
  { k: 'maxMana', get: (s) => s.maxMana, floor: 40 },
  { k: 'critChance', get: (s) => s.critChance, floor: 0.2 },
  { k: 'dodgeChance', get: (s) => s.dodgeChance, floor: 0.2 },
  { k: 'moveSpeed', get: (s) => 1 / Math.max(0.001, s.moveCooldown), floor: 5 },
  { k: 'hpRegen', get: (s) => s.hpRegen, floor: 3 },
  { k: 'manaRegen', get: (s) => s.manaRegen, floor: 3 },
];
const CMP_TIE = 0.03; // net relative change below this on a mixed item = no clear winner

// Stats with some equipment slots replaced (`overrides` = { slot: item|null }), on a throwaway copy of the player.
function simStats(player, overrides) {
  const sim = { ...player, equipment: { ...player.equipment, ...overrides }, hp: player.hp, mana: player.mana };
  return recalcStats(sim);
}

// Which attack skill a weapon class would put in slot 1 — skills.js registers this (items.js can't import skills.js
// without an import cycle). Used only for the "Switches your attack to {skill}" text.
let attackSkillResolver = null;
export function setAttackSkillResolver(fn) { attackSkillResolver = typeof fn === 'function' ? fn : null; }
function attackSkillName(player, cls) {
  const def = attackSkillResolver ? attackSkillResolver(player, cls) : null;
  return (def && def.name) || 'a different attack';
}

// -> null for potions/unequippable, else
//   { verdict:'up'|'down'|'mixed'|'same'|'swap'|'blocked', tradeoff, score, before, after, evicts, classSwap, toClass, blockedBy }
// `before`/`after` are full player.stats objects (current gear vs. wearing `item`). Two-handed weapons are compared
// as "weapon + empty off-hand" vs "current weapon + current off-hand" (`evicts` = the off-hand that would come off).
// A weapon of a different class (§17.9: melee<->ranged<->caster) is never an up/downgrade: verdict 'swap' (⇄).
// An off-hand while a two-handed weapon is held: verdict 'blocked' (it can't be equipped).
export function compareGear(item, player) {
  if (!item || item.type === 'potion' || !player?.equipment) return null;
  const eq = player.equipment;
  if (!Object.prototype.hasOwnProperty.call(eq, item.slot)) return null;
  const current = eq[item.slot] || null;
  if (current && current.id === item.id) return null;
  const before = simStats(player, {});
  if (item.slot === 'offhand' && isTwoHanded(eq.weapon)) {
    return { verdict: 'blocked', tradeoff: false, score: 0, before, after: before, evicts: null, classSwap: false, blockedBy: eq.weapon };
  }
  const overrides = { [item.slot]: item };
  const evicts = item.slot === 'weapon' && isTwoHanded(item) ? (eq.offhand || null) : null;
  if (evicts) overrides.offhand = null;
  const after = simStats(player, overrides);
  let score = 0, gains = 0, losses = 0;
  for (const m of CMP_METRICS) {
    const a = m.get(before), b = m.get(after);
    if (a == null || b == null) continue; // not applicable on one side (role change) — not a real 0
    const rel = (b - a) / Math.max(Math.abs(a), m.floor);
    if (Math.abs(rel) < 0.005) continue;
    score += rel;
    if (rel > 0) gains++; else losses++;
  }
  const toClass = item.slot === 'weapon' ? weaponClassOf(item) : null;
  const classSwap = item.slot === 'weapon' && toClass !== weaponClassOf(eq.weapon);
  let verdict;
  if (classSwap) verdict = 'swap';
  else if (!gains && !losses) verdict = 'same';
  else if (!losses) verdict = 'up';
  else if (!gains) verdict = 'down';
  else verdict = score > CMP_TIE ? 'up' : score < -CMP_TIE ? 'down' : 'mixed';
  return { verdict, tradeoff: gains > 0 && losses > 0, score, before, after, evicts, classSwap, toClass };
}

// Quick-equip: for each slot, wear the bag item that is the biggest upgrade. Returns the items equipped.
// Weapons: only the equipped weapon's own class is considered (sword->axe yes, sword->bow never — a class swap is
// never 'up' anyway). The off-hand step is skipped while a two-handed weapon is held (§17.9).
export function equipUpgrades(player) {
  const equipped = [];
  for (const { id: slot } of SLOTS) {
    if (slot === 'offhand' && isTwoHanded(player.equipment.weapon)) continue;
    const cls = weaponClassOf(player.equipment.weapon);
    let best = null, bestScore = 0;
    for (const item of player.inventory) {
      if (!item || item.slot !== slot) continue;
      if (slot === 'weapon' && weaponClassOf(item) !== cls) continue;
      const gc = compareGear(item, player);
      if (gc && gc.verdict === 'up' && gc.score > bestScore) { best = item; bestScore = gc.score; }
    }
    if (best && equipItem(player, best)) equipped.push(best);
  }
  return equipped;
}

const VERDICT_LINE = {
  up: ['#51cf66', '▲ Upgrade'],
  down: ['#ff6b6b', '▼ Downgrade'],
  mixed: ['#fcc419', '↕ Trade-off'],
  same: ['#9aa3bd', '= No change'],
  swap: ['#74c0fc', '⇄ Different weapon type'],
  blocked: ['#ff8787', '🔒 Off-hand locked'],
};

// Extra explanation under the verdict: class swap / two-handed eviction / locked off-hand.
function verdictNote(gc, player) {
  if (!gc) return '';
  if (gc.verdict === 'blocked') return `Can't equip: ${gc.blockedBy.name} is two-handed.`;
  const bits = [];
  if (gc.classSwap) bits.push(`Switches your attack to ${attackSkillName(player, gc.toClass)}.`);
  if (gc.evicts) bits.push(`Two-handed: unequips ${gc.evicts.name}.`);
  return bits.join(' ');
}

// Skill book body: "Attack · Requires Bow", what the skill does, and what reading it would do right now (§17.11).
function skillBookTooltipLines(item, player) {
  const info = skillBookHooks ? skillBookHooks.info(item.skillId, player || null) : null;
  if (!info) return ['<div class="tt-primary">An unreadable book.</div>'];
  const lines = [];
  const req = info.requires ? `Requires ${info.requires}` : 'Any weapon';
  lines.push(`<div class="tt-primary">${escapeHtml(`${info.icon} ${info.name} — ${info.categoryLabel} · ${req}`)}</div>`);
  if (info.description) lines.push(`<div class="tt-stat">${escapeHtml(info.description)}</div>`);
  if (info.unique) lines.push('<div class="tt-stat" style="color:#ff9f43;">Boss-unique skill</div>');
  let use;
  if (!player) use = ['#9aa3bd', 'Read to learn this skill.'];
  else if (info.rank <= 0) use = ['#51cf66', 'Read: learn this skill (rank 1) and gain 1 free skill point.'];
  else if (info.rank < info.maxRank) use = ['#51cf66', `Known at rank ${info.rank}. Read: rank ${info.rank + 1}.`];
  else use = ['#9aa3bd', `Mastered (rank ${info.maxRank}). Reading it does nothing — sell it.`];
  lines.push(`<div class="tt-verdict" style="color:${use[0]};">${escapeHtml(use[1])}</div>`);
  if (info.requires && player && info.category === 'attack') {
    lines.push(`<div class="tt-verdict-note" style="color:#9aa3bd;">Usable in slot 1 while a ${escapeHtml(info.requires.toLowerCase())} is equipped; can be learned with any weapon.</div>`);
  }
  return lines;
}

export function itemTooltip(item, player) {
  const rc = RARITY[item.rarity]?.color || '#ffffff';
  const parts = [];
  parts.push('<div class="tt-item">');
  parts.push(`<div class="tt-name" style="color:${rc};font-weight:bold;">${escapeHtml(item.name)}</div>`);
  parts.push(`<div class="tt-rarity" style="color:${rc};">${escapeHtml(RARITY[item.rarity]?.name || item.rarity)} ${escapeHtml(typeLabel(item))}</div>`);

  if (item.type === 'skillbook') {
    parts.push(...skillBookTooltipLines(item, player));
    parts.push(`<div class="tt-value">Value: ${item.value}g</div>`);
    parts.push('</div>');
    return parts.join('');
  }

  const primary = primaryStatLine(item);
  if (primary) parts.push(`<div class="tt-primary">${escapeHtml(primary)}</div>`);

  const bonusLines = bonusStatLines(item);
  if (bonusLines.length) {
    parts.push(`<div class="tt-stats">${bonusLines.map((l) => `<div class="tt-stat">${escapeHtml(l)}</div>`).join('')}</div>`);
  }

  if (item.type === 'potion') {
    parts.push(`<div class="tt-stack">Stack: ${item.stack}/${item.maxStack}</div>`);
  }
  parts.push(`<div class="tt-ilvl">Item Level ${item.itemLevel}</div>`);
  parts.push(`<div class="tt-value">Value: ${item.value}g</div>`);

  if (item.type !== 'potion' && player?.equipment) {
    const equipped = player.equipment[item.slot];
    const gc = compareGear(item, player);
    const verdict = gc ? VERDICT_LINE[gc.verdict] : null;
    const note = verdictNote(gc, player);
    const tradeoffNote = gc && gc.tradeoff && (gc.verdict === 'up' || gc.verdict === 'down');
    const verdictHtml = verdict
      ? `<div class="tt-verdict" style="color:${verdict[0]};">${verdict[1]}${tradeoffNote ? ' <span class="tt-verdict-note">(with trade-offs)</span>' : ''}</div>`
        + (note ? `<div class="tt-verdict-note" style="color:${verdict[0]};">${escapeHtml(note)}</div>` : '')
      : '';
    // The off-hand a two-handed weapon would take off: its stats are lost too, so list them as losses.
    const lostOff = gc && gc.evicts ? compareLines({ stats: {} }, gc.evicts) : [];
    if (equipped && equipped.id !== item.id) {
      const cmp = compareLines(item, equipped);
      parts.push(`<div class="tt-compare">${verdictHtml}${cmp.join('')}${lostOff.join('')}</div>`);
    } else if (!equipped) {
      parts.push(`<div class="tt-compare">${verdictHtml}<div class="tt-compare-empty" style="color:#888;">(Nothing equipped)</div>${lostOff.join('')}</div>`);
    }
  }

  parts.push('</div>');
  return parts.join('');
}

export function startingGear() {
  const weapon = {
    id: uid(), name: 'Rusty Sword', baseName: 'Rusty Sword', type: 'weapon', slot: 'weapon',
    weaponKind: 'sword', rarity: 'common', icon: ICONS.sword, itemLevel: 1,
    stats: { damageMin: 5, damageMax: 8 }, value: computeValue('weapon', 1, 'common'),
  };
  const armor = {
    id: uid(), name: 'Tattered Tunic', baseName: 'Tattered Tunic', type: 'armor', slot: 'armor',
    rarity: 'common', icon: ICONS.armor, itemLevel: 1,
    stats: { armor: 2 }, value: computeValue('armor', 1, 'common'),
  };
  const healthPotion = buildPotion('health', 'minor', 1);
  healthPotion.stack = 3;
  const manaPotion = buildPotion('mana', 'minor', 1);
  manaPotion.stack = 2;

  return {
    equipment: { weapon, offhand: null, helm: null, armor, boots: null, ring: null, amulet: null },
    inventory: [healthPotion, manaPotion],
  };
}
