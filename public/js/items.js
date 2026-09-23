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
const WEAPON_KINDS = ['sword', 'axe', 'mace', 'dagger', 'staff', 'bow'];
const OFFHAND_KINDS = ['shield', 'orb', 'tome'];
const TYPE_WEIGHTS = { weapon: 20, offhand: 12, helm: 12, armor: 16, boots: 12, ring: 14, amulet: 14 };

const ICONS = {
  sword: '🗡️', axe: '🪓', mace: '🔨', dagger: '🔪', staff: '🪄', bow: '🏹',
  shield: '🛡️', orb: '🔮', tome: '📖',
  helm: '⛑️', armor: '🥋', boots: '👢', ring: '💍', amulet: '📿',
  potionHealth: '🧪', potionMana: '💧',
};

const STAT_LABELS = {
  str: 'Strength', dex: 'Dexterity', int: 'Intellect', vit: 'Vitality', def: 'Defense',
  armor: 'Armor', damageMin: 'Min Damage', damageMax: 'Max Damage', spellPower: 'Spell Power',
  maxHp: 'Max HP', maxMana: 'Max Mana', critChance: 'Crit Chance', hpRegen: 'HP Regen',
  manaRegen: 'Mana Regen', moveSpeed: 'Move Speed',
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

// Affix pool. `types` lists which item.type values may roll this affix.
const AFFIX_POOL = [
  { id: 'vicious', kind: 'prefix', word: 'Vicious', types: ['weapon'],
    roll: (lvl, rng) => ({ damageMin: 1 + lvl * 0.3, damageMax: 2 + lvl * 0.4 }) },
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
      const min = 1 + lvl * 0.5;
      return { damageMin: min, damageMax: min + (1 + lvl * 0.2), spellPower: 2 + lvl * 1.0, int: 1 + lvl * 0.4 };
    }
    case 'bow': {
      const min = 1 + lvl * 0.8;
      return { damageMin: min, damageMax: min + (2 + lvl * 0.3), dex: 1 + lvl * 0.5, spellPower: 0.5 + lvl * 0.3 };
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

function rollAffixes(rng, type, itemLevel, count, statsOut) {
  if (count <= 0) return { prefixWords: [], suffixPhrases: [] };
  let eligible = rng.shuffle(AFFIX_POOL.filter((a) => a.types.includes(type)));
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

function computeValue(type, itemLevel, rarity) {
  const base = (TYPE_BASE_VALUE[type] || 8) + itemLevel * 4;
  return Math.round(base * (RARITY_VALUE_MULT[rarity] || 1));
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

  const mult = RARITY[rarity].statMult;
  const stats = {};
  for (const [k, v] of Object.entries(raw)) stats[k] = v * mult;

  const affixResult = rollAffixes(rng, type, itemLevel, RARITY[rarity].affixes, stats);
  finalizeStats(stats);

  const name = buildName(rarity, baseName, affixResult, type, rng);
  const value = computeValue(type, itemLevel, rarity);

  const item = { id: uid(), name, baseName, type, slot, rarity, icon, itemLevel, stats, value };
  if (weaponKind) item.weaponKind = weaponKind;
  if (offhandKind) item.offhandKind = offhandKind;
  return item;
}

export function rollLoot(enemy, depth, rng) {
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

export function equipItem(player, item) {
  const idx = player.inventory.findIndex((i) => i.id === item.id);
  if (idx === -1) return false;
  if (item.type === 'potion') return false;
  const slot = item.slot;
  if (!Object.prototype.hasOwnProperty.call(player.equipment, slot)) return false;
  const prev = player.equipment[slot] || null;
  player.inventory.splice(idx, 1);
  player.equipment[slot] = item;
  if (prev) player.inventory.splice(idx, 0, prev);
  recalcStats(player);
  return true;
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
  if (item.type !== 'potion') return equipItem(player, item);

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
  if (pot.stack <= 0) player.inventory.splice(idx, 1);
  return true;
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

export function sellValue(item) {
  return Math.max(1, Math.round(item.value * 0.35));
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
  if (item.type === 'weapon') return `Weapon (${cap(item.weaponKind)})`;
  if (item.type === 'offhand') return `Off-Hand (${cap(item.offhandKind)})`;
  if (item.type === 'potion') return 'Potion';
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
const CMP_METRICS = [
  { k: 'melee', get: (s) => (s.meleeMin + s.meleeMax) / 2, floor: 6 },
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

function simStats(player, slot, item) {
  const sim = { ...player, equipment: { ...player.equipment, [slot]: item }, hp: player.hp, mana: player.mana };
  return recalcStats(sim);
}

// -> null for potions/unequippable, else { verdict:'up'|'down'|'mixed'|'same', tradeoff, score, before, after }
// `before`/`after` are full player.stats objects (current gear vs. wearing `item`).
export function compareGear(item, player) {
  if (!item || item.type === 'potion' || !player?.equipment) return null;
  if (!Object.prototype.hasOwnProperty.call(player.equipment, item.slot)) return null;
  const current = player.equipment[item.slot] || null;
  if (current && current.id === item.id) return null;
  const before = simStats(player, item.slot, current);
  const after = simStats(player, item.slot, item);
  let score = 0, gains = 0, losses = 0;
  for (const m of CMP_METRICS) {
    const a = m.get(before), b = m.get(after);
    const rel = (b - a) / Math.max(Math.abs(a), m.floor);
    if (Math.abs(rel) < 0.005) continue;
    score += rel;
    if (rel > 0) gains++; else losses++;
  }
  let verdict;
  if (!gains && !losses) verdict = 'same';
  else if (!losses) verdict = 'up';
  else if (!gains) verdict = 'down';
  else verdict = score > CMP_TIE ? 'up' : score < -CMP_TIE ? 'down' : 'mixed';
  return { verdict, tradeoff: gains > 0 && losses > 0, score, before, after };
}

// Quick-equip: for each slot, wear the bag item that is the biggest upgrade. Returns the items equipped.
export function equipUpgrades(player) {
  const equipped = [];
  for (const { id: slot } of SLOTS) {
    let best = null, bestScore = 0;
    for (const item of player.inventory) {
      if (!item || item.slot !== slot) continue;
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
};

export function itemTooltip(item, player) {
  const rc = RARITY[item.rarity]?.color || '#ffffff';
  const parts = [];
  parts.push('<div class="tt-item">');
  parts.push(`<div class="tt-name" style="color:${rc};font-weight:bold;">${escapeHtml(item.name)}</div>`);
  parts.push(`<div class="tt-rarity" style="color:${rc};">${escapeHtml(RARITY[item.rarity]?.name || item.rarity)} ${escapeHtml(typeLabel(item))}</div>`);

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
    const verdictHtml = verdict
      ? `<div class="tt-verdict" style="color:${verdict[0]};">${verdict[1]}${gc.tradeoff && gc.verdict !== 'mixed' ? ' <span class="tt-verdict-note">(with trade-offs)</span>' : ''}</div>`
      : '';
    if (equipped && equipped.id !== item.id) {
      const cmp = compareLines(item, equipped);
      parts.push(`<div class="tt-compare">${verdictHtml}${cmp.join('')}</div>`);
    } else if (!equipped) {
      parts.push(`<div class="tt-compare">${verdictHtml}<div class="tt-compare-empty" style="color:#888;">(Nothing equipped)</div></div>`);
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
