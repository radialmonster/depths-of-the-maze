// Balance simulation harness (DESIGN §17.17) — the pure, DOM-free core shared by tools/sim.js (`npm run sim`, slow,
// statistical) and test/balance.test.js (fast, fixed seeds, part of `npm test`). Everything here only calls the
// game's own exported pure functions: generateDungeon, spawnEnemies, placeMerchant/generateMerchantStock/shopPrice,
// rollLoot, rollChestContents, createPlayer/recalcStats/gainXP, addToInventory/equipUpgrades/compareGear/sellValue.
//
//   Layer 1  floorSample(depth, seed)          one generated + populated floor, fully tallied (a "full clear" view)
//   Layer 2  simulateRun(seed, opts)            a simple player policy over depths 1..N (explore fraction, sell, buy)
//            summarize / aggregate helpers      per-depth mean / p10 / p90
import { RNG, TILE, RARITY_ORDER, bossForDepth, isBossDepth } from '../public/js/core.js';
import { generateDungeon, arenaStats, treasureRoomSlots, treasureTierWeights } from '../public/js/map.js';
import { spawnEnemies, spawnDensity } from '../public/js/enemies.js';
import {
  rollLoot, rollChestContents, CHEST_LOOT, INVENTORY_SIZE, addToInventory, equipUpgrades, equipItem, compareGear,
  sellValue, startingGear,
} from '../public/js/items.js';
import { createPlayer, recalcStats, gainXP } from '../public/js/character.js';
import { placeMerchant, shopPrice, MERCHANT_ENEMY_CLEARANCE } from '../public/js/shop.js';
import '../public/js/skills.js'; // registers the skill-book hooks (hidden-room and boss books)

export { spawnDensity };

// A reproducible per-(seed, depth, index) seed.
export function mixSeed(seed, depth, i = 0) {
  let h = (seed >>> 0) ^ Math.imul(depth + 1, 0x9E3779B1) ^ Math.imul(i + 1, 0x85EBCA77);
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Design-table expectations (§17.14) — computed from the table itself, not from the code under test.
// ---------------------------------------------------------------------------
// Expected treasure items per depth: E[rooms] (first slot 100% from depth 2 / 50% at depth 1, each extra slot 50%)
// x tier mix (nominal weights) x E[chests] x E[items/chest] (Cache 1x1, Hoard 1.5x2, Vault 2.5x2.5). The one-Vault cap
// is ignored here (it only trims deep floors a little; the ±25% band in balance.test.js covers it).
export function designTreasureItems(depth) {
  const slots = treasureRoomSlots(depth);
  const rooms = (depth >= 2 ? 1 : 0.5) + 0.5 * (slots - 1);
  const w = treasureTierWeights(depth);
  const tot = w.cache + w.hoard + w.vault;
  const perRoom = (w.cache * 1 * 1 + w.hoard * 1.5 * 2 + w.vault * 2.5 * 2.5) / tot;
  return rooms * perRoom;
}
// Allowed item-level offsets (itemLevel - depth) per tier (§17.14), for a given depth.
export function tierLevelRange(tier, depth) {
  const t = CHEST_LOOT[tier];
  const base = Math.max(1, depth + t.levelOffset);
  return [Math.max(1, base + t.jitter[0]) - depth, Math.max(1, base + t.jitter[1]) - depth];
}

// ---------------------------------------------------------------------------
// Shared floor setup — mirrors main.js loadDepth(): generate (merchant depth), spawn, drop general spawns inside the
// merchant's clearance (treasure guards exempt), clear any straggler out of a hidden room.
// ---------------------------------------------------------------------------
export function buildFloor(depth, rng, opts = {}) {
  const t0 = performance.now();
  const map = generateDungeon(depth, rng, { merchant: true, prevArchetype: opts.prevArchetype });
  const genMs = performance.now() - t0;
  let enemies = spawnEnemies({ map, depth, rng });
  const merchant = placeMerchant({ map, depth, rng, npcs: [] });
  if (merchant) enemies = enemies.filter((e) => e.treasureGuard || Math.hypot(e.x - merchant.x, e.y - merchant.y) > MERCHANT_ENEMY_CLEARANCE);
  const hiddenIds = new Set(map.rooms.filter((r) => r.hidden).map((r) => r.id));
  if (hiddenIds.size) enemies = enemies.filter((e) => { const r = map.roomAt(e.x, e.y); return !r || !hiddenIds.has(r.id); });
  return { map, enemies, merchant, genMs };
}

export const isGeneral = (e) => e.behavior !== 'boss' && !e.bossGuard && !e.treasureGuard && !e.exitSentry;

// arenaStats() on the boss room as it was actually placed (mask rebuilt from the map's own room grid).
export function placedArenaStats(map, room) {
  const mask = new Uint8Array(room.w * room.h);
  for (let y = 0; y < room.h; y++) for (let x = 0; x < room.w; x++) {
    const r = map.roomAt(room.x + x, room.y + y);
    if (r && r.id === room.id && map.get(room.x + x, room.y + y) === TILE.FLOOR) mask[y * room.w + x] = 1;
  }
  return arenaStats({ w: room.w, h: room.h, mask, core: [] }); // endSlots is not meaningful here (interior rock is not marked core)
}

const rarityIdx = (r) => RARITY_ORDER.indexOf(r);

// ---------------------------------------------------------------------------
// Layer 1 — one floor, everything on it tallied (as if fully cleared and every chest opened).
// ---------------------------------------------------------------------------
export function floorSample(depth, seed, opts = {}) {
  const rng = new RNG(seed);
  const { map, enemies, genMs } = buildFloor(depth, rng, opts);
  const s = { depth, genMs };
  s.rooms = map.rooms.length;
  s.baseRooms = map.baseRoomCount;
  s.populatedFloor = map.populatedFloor;
  s.width = map.width; s.height = map.height;

  const general = enemies.filter(isGeneral);
  s.enemiesGeneral = general.length;
  s.density = general.length / Math.max(1, map.populatedFloor) * 100;
  s.densityTarget = spawnDensity(depth);
  s.eliteShare = general.length ? general.filter((e) => e.elite).length / general.length : 0;
  s.exitSentries = enemies.filter((e) => e.exitSentry).length;
  s.treasureGuards = enemies.filter((e) => e.treasureGuard).length;
  s.bossGuards = enemies.filter((e) => e.bossGuard).length;
  s.enemiesTotal = enemies.length;

  // Treasure
  const wings = map.rooms.filter((r) => r.kind === 'treasure' && !r.antechamber);
  s.treasureRooms = wings.length;
  s.cache = wings.filter((r) => r.treasureTier === 'cache').length;
  s.hoard = wings.filter((r) => r.treasureTier === 'hoard').length;
  s.vault = wings.filter((r) => r.treasureTier === 'vault').length;
  s.antechambers = map.rooms.filter((r) => r.antechamber).length;
  s.hidden = wings.filter((r) => r.hidden).length;
  s.wingsRolled = map.treasureRolled.tiers.length;
  s.wingsPlaced = wings.length;
  s.anteRolled = map.treasureRolled.antechamber ? 1 : 0;
  s.antePlaced = s.antechambers;
  s.chests = 0; s.treasureItems = 0; s.chestGold = 0; s.chestPotions = 0; s.booksHidden = 0;
  s.treasureRarity = [0, 0, 0, 0, 0];
  s.levelOffsets = { cache: [], hoard: [], vault: [] };
  for (const r of wings) {
    (r.chests || []).forEach((c, i) => {
      s.chests++;
      for (const it of rollChestContents(r.treasureTier, depth, rng, { first: i === 0, hidden: !!r.hidden })) {
        if (it.type === 'gold') s.chestGold += it.amount;
        else if (it.type === 'potion') s.chestPotions++;
        else if (it.type === 'skillbook') s.booksHidden++;
        else {
          s.treasureItems++;
          s.treasureRarity[rarityIdx(it.rarity)]++;
          s.levelOffsets[r.treasureTier].push(it.itemLevel - depth);
        }
      }
    });
  }

  // Mob loot (every enemy killed; boss books as in a run that killed every earlier boss)
  const defeated = [];
  for (let d = 1; d < depth; d++) if (isBossDepth(d) && !defeated.includes(bossForDepth(d))) defeated.push(bossForDepth(d));
  s.mobGold = 0; s.mobPotions = 0; s.mobItems = 0; s.booksBoss = 0;
  for (const e of enemies) {
    for (const it of rollLoot(e, depth, rng, { bossesDefeated: defeated })) {
      if (it.type === 'gold') s.mobGold += it.amount;
      else if (it.type === 'potion') s.mobPotions++;
      else if (it.type === 'skillbook') s.booksBoss++;
      else s.mobItems++;
    }
  }

  // Boss arena
  const boss = map.rooms.find((r) => r.kind === 'boss');
  if (boss) {
    const a = placedArenaStats(map, boss);
    s.arenaFloor = a.floor; s.arenaClearRadius = a.clearRadius; s.arenaLong = a.long; s.arenaShort = a.short;
    s.arenaClearCore = 2 * a.clearRadius + 1;
  }
  s._map = opts.keepMap ? map : undefined;
  s._enemies = opts.keepMap ? enemies : undefined;
  return s;
}

// ---------------------------------------------------------------------------
// Layer 2 — run economy. Policy (simple, documented, deliberately not clever):
//   * explore: rooms are visited in random order (start room first) until `explore` of all room floor is covered;
//     a Vault behind an antechamber is one unit with it; a hidden room is found when its (unmodelled) parent is
//     visited AND the player spots the passage: explore x hiddenFind. Corridor enemies: each met with p = explore.
//     On a boss depth the arena is always visited (policy fights the boss).
//   * everything met is killed; every reached chest opened; everything picked up. Books are read on the spot (not
//     bagged). Bag full: quick-equip upgrades, then drop the lowest-value gear item if the new one is worth more
//     (counted as overflow either way — the bag-pressure measure).
//   * treasure: false = counterfactual that never opens a chest (measures what the §17.14 tiers add).
//   * at the merchant (every depth): equipUpgrades -> sell every unequipped gear item and surplus potions (> potionKeep
//     per kind at the current size; older sizes sold) at sellValue -> record gold on hand and what of the stock is
//     affordable -> if `buy`, buy stock items that are a clear upgrade (best score first) while gold lasts.
// ---------------------------------------------------------------------------
export const ECON_DEFAULTS = Object.freeze({ depths: 20, explore: 0.7, hiddenFind: 0.5, buy: true, potionKeep: 10, treasure: true });

function roomFloorCount(map) {
  const n = new Map();
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    if (map.get(x, y) !== TILE.FLOOR) continue;
    const r = map.roomAt(x, y);
    if (r) n.set(r.id, (n.get(r.id) || 0) + 1);
  }
  return n;
}

// Which rooms the policy reaches this floor -> Set of room ids.
function exploreRooms(map, rng, cfg) {
  const area = roomFloorCount(map);
  const total = [...area.values()].reduce((a, b) => a + b, 0);
  const visited = new Set();
  let covered = 0;
  const visit = (id) => { if (!visited.has(id)) { visited.add(id); covered += area.get(id) || 0; } };
  const start = map.rooms.find((r) => r.kind === 'start');
  if (start) visit(start.id);
  const boss = map.rooms.find((r) => r.kind === 'boss');
  if (boss) visit(boss.id);
  const behindAnte = new Map(); // antechamber id -> vault id
  for (const r of map.rooms) if (r.antechamberId != null) behindAnte.set(r.antechamberId, r.id);
  const units = map.rooms.filter((r) => !visited.has(r.id) && !r.hidden && !(r.antechamberId != null));
  rng.shuffle(units);
  for (const r of units) {
    if (covered >= cfg.explore * total) break;
    visit(r.id);
    if (behindAnte.has(r.id)) visit(behindAnte.get(r.id));
  }
  for (const r of map.rooms) if (r.hidden && rng.chance(cfg.explore * cfg.hiddenFind)) visit(r.id);
  return visited;
}

const isGear = (it) => it && it.slot && it.type !== 'potion' && it.type !== 'skillbook';
const potionSizeRank = { minor: 0, normal: 1, greater: 2 };

function gearSnapshot(player) {
  const eq = Object.values(player.equipment);
  const lv = eq.reduce((a, it) => a + (it ? it.itemLevel : 0), 0) / eq.length;
  const value = eq.reduce((a, it) => a + (it ? it.value : 0), 0);
  // Mean rarity index of what's worn (0 common .. 4 legendary; empty slot = 0) — how far the character's own loot has
  // outgrown a stock tier (§17.4's stock-rarity steps were set from this).
  const rarity = eq.reduce((a, it) => a + (it ? rarityIdx(it.rarity) : 0), 0) / eq.length;
  const st = player.stats;
  return {
    gearIlvl: lv, gearValue: value, gearRarity: rarity, slotsFilled: eq.filter(Boolean).length,
    melee: st.meleeMin == null ? 0 : (st.meleeMin + st.meleeMax) / 2, defense: st.defense, maxHp: st.maxHp,
  };
}

export function simulateRun(seed, opts = {}) {
  const cfg = { ...ECON_DEFAULTS, ...opts };
  const rng = new RNG(seed);
  const player = createPlayer();
  const sg = startingGear();
  player.equipment = sg.equipment;
  player.inventory = sg.inventory;
  recalcStats(player);
  const game = { player };
  const out = [];
  let prevArchetype;

  for (let depth = 1; depth <= cfg.depths; depth++) {
    const { map, enemies, merchant } = buildFloor(depth, rng, { prevArchetype });
    prevArchetype = map.archetype;
    const rec = { depth, goldMob: 0, // books: every book read (boss + hidden); bossBooks: the boss subset
       goldChest: 0, sellIncome: 0, itemsLooted: 0, potionsLooted: 0, books: 0,
      bossBooks: 0, overflow: 0, overflowValue: 0, bagMax: 0, killed: 0, chestsOpened: 0 };
    const visited = exploreRooms(map, rng, cfg);
    rec.treasureReached = map.rooms.filter((r) => r.kind === 'treasure' && !r.antechamber && visited.has(r.id)).length;
    rec.treasureRooms = map.rooms.filter((r) => r.kind === 'treasure' && !r.antechamber).length;

    const pickUp = (it) => {
      if (it.type === 'gold') return;
      if (it.type === 'skillbook') { rec.books++; return; } // read on the spot
      if (it.type === 'potion') rec.potionsLooted++; else rec.itemsLooted++;
      if (addToInventory(player, it)) { rec.bagMax = Math.max(rec.bagMax, player.inventory.length); return; }
      rec.overflow++;
      equipUpgrades(player);
      if (addToInventory(player, it)) return;
      // still full: keep whichever is worth more
      let worst = -1;
      player.inventory.forEach((b, i) => { if (isGear(b) && (worst < 0 || b.value < player.inventory[worst].value)) worst = i; });
      if (isGear(it) && worst >= 0 && player.inventory[worst].value < it.value) {
        rec.overflowValue += sellValue(player.inventory[worst]);
        player.inventory.splice(worst, 1, it);
      } else rec.overflowValue += sellValue(it);
      rec.bagMax = INVENTORY_SIZE;
    };

    // Kill what the policy meets (xp first, like main.js killEnemy), then loot it.
    for (const e of enemies) {
      const r = map.roomAt(e.x, e.y);
      const met = r ? visited.has(r.id) : rng.chance(cfg.explore);
      if (!met) continue;
      rec.killed++;
      gainXP(game, e.xp);
      const loot = rollLoot(e, depth, rng, { bossesDefeated: player.bossesDefeated });
      if (e.behavior === 'boss') {
        rec.bossBooks += loot.filter((it) => it.type === 'skillbook').length;
        if (!player.bossesDefeated.includes(e.type)) player.bossesDefeated.push(e.type);
      }
      for (const it of loot) { if (it.type === 'gold') { rec.goldMob += it.amount; player.gold += it.amount; } else pickUp(it); }
    }
    // Chests in reached treasure rooms
    for (const r of map.rooms) {
      if (!cfg.treasure || r.kind !== 'treasure' || r.antechamber || !visited.has(r.id)) continue;
      (r.chests || []).forEach((c, i) => {
        rec.chestsOpened++;
        for (const it of rollChestContents(r.treasureTier, depth, rng, { first: i === 0, hidden: !!r.hidden })) {
          if (it.type === 'gold') { rec.goldChest += it.amount; player.gold += it.amount; } else pickUp(it);
        }
      });
    }

    // Merchant: equip, sell, then look at the stock.
    equipUpgrades(player);
    const sizeNow = map && merchant ? merchant.stock.heal.size : null;
    const keptPotions = { health: 0, mana: 0 };
    const keep = [];
    for (const it of player.inventory) {
      let sell = isGear(it);
      if (it.type === 'potion') {
        if (sizeNow && potionSizeRank[it.size] < potionSizeRank[sizeNow]) sell = true;
        else {
          const room = cfg.potionKeep - keptPotions[it.potionKind];
          if (room <= 0) sell = true;
          else if (it.stack > room) { // sell the surplus part of the stack
            const surplus = { ...it, stack: it.stack - room };
            rec.sellIncome += sellValue(surplus);
            it.stack = room;
          }
          if (!sell) keptPotions[it.potionKind] += it.stack;
        }
      }
      if (sell) rec.sellIncome += sellValue(it); else keep.push(it);
    }
    player.inventory = keep;
    player.gold += rec.sellIncome;
    rec.income = rec.goldMob + rec.goldChest + rec.sellIncome;
    rec.goldOnHand = player.gold;

    if (merchant) {
      const stock = [...merchant.stock.gear.map((item) => ({ kind: 'gear', item })), { kind: 'featured', item: merchant.stock.featured }];
      const prices = stock.map((s) => shopPrice(s.kind, s.item));
      const regular = prices.slice(0, -1);
      rec.affordRegular = regular.filter((p) => p <= player.gold).length;
      rec.affordFeatured = prices[prices.length - 1] <= player.gold ? 1 : 0;
      rec.affordAny = prices.some((p) => p <= player.gold) ? 1 : 0;
      let g = player.gold, n = 0;
      for (const p of [...prices].sort((a, b) => a - b)) { if (p > g) break; g -= p; n++; }
      rec.affordTogether = n;
      rec.cheapestPrice = Math.min(...regular);
      rec.featuredPrice = prices[prices.length - 1];
      // Supply vs. demand (§17.4): the price of the whole gear stock, and gold on hand measured in Featured items.
      rec.stockTotal = prices.reduce((a, b) => a + b, 0);
      rec.onHandVsFeatured = player.gold / rec.featuredPrice;
      rec.goldVsCheapest = player.gold / rec.cheapestPrice;
      // How many stock items are an actual upgrade for this character (what a player would want to buy).
      rec.stockUpgrades = stock.filter((s) => { const gc = compareGear(s.item, player); return gc && gc.verdict === 'up'; }).length;
      rec.bought = 0; rec.spent = 0;
      if (cfg.buy) {
        const avail = stock.map((s, i) => ({ ...s, price: prices[i] }));
        for (;;) {
          let best = null, bestScore = 0;
          for (const s of avail) {
            if (s.price > player.gold) continue;
            const gc = compareGear(s.item, player);
            if (gc && gc.verdict === 'up' && gc.score > bestScore) { best = s; bestScore = gc.score; }
          }
          if (!best) break;
          avail.splice(avail.indexOf(best), 1);
          player.gold -= best.price; rec.spent += best.price; rec.bought++;
          player.inventory.push(best.item);
          equipItem(player, best.item);
          // sell whatever it replaced
          player.inventory = player.inventory.filter((it) => { if (isGear(it)) { player.gold += sellValue(it); return false; } return true; });
        }
      }
    }
    rec.goldAfter = player.gold;
    rec.bagAfterShop = player.inventory.length;
    Object.assign(rec, gearSnapshot(player));
    rec.level = player.level;
    rec.levelMinusDepth = player.level - depth;
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, p10: quantile(v, 0.1), p50: quantile(v, 0.5), p90: quantile(v, 0.9), p99: quantile(v, 0.99), n: v.length };
}
