// Merchant placement, stock generation and buy/sell transactions. Owned by no one module —
// pure game-logic glue between map.js (room placement), items.js (stock/pricing) and the UI
// (public/js/ui.js renders game.npcs / merchant.stock; renderer.js draws them).
//
// A merchant is a plain object pushed onto game.npcs (reset to [] every loadDepth()):
//   { id, type: 'merchant', x, y, fx, fy, stock: { heal, mana, gear: [item...], featured },
//     buyback: [{ item, price }...] }
// `heal`/`mana` are potion templates (unlimited — buying clones one with stack:1); `gear` and
// `featured` are unique items, each removed from stock once bought. Stock is regenerated fresh
// every depth and never carries over — enemies don't respawn either, so a player who can't
// afford something on this depth's shop is choosing to save gold for the next one.
// `buyback` holds what the player sold to this merchant (a misclick safety net); it lives on the
// merchant object, so it resets with the stock every depth.

import { uid, TILE, dist, clamp, RARITY_ORDER } from './core.js';
import { generateItem, addToInventory, sellValue, buyPrice, INVENTORY_SIZE } from './items.js';

// A merchant shows up on every Nth depth. Kept as one constant/function so it's easy to tune;
// currently every depth (interval 1).
export const MERCHANT_DEPTH_INTERVAL = 1;
export function isMerchantDepth(depth) {
  return depth > 0 && depth % MERCHANT_DEPTH_INTERVAL === 0;
}

// How close (in tiles, using the player's analog fx/fy) the player must be to trade.
export const MERCHANT_RANGE = 1.5;

// How many tiles of clearance around a freshly-placed merchant should be kept enemy-free.
export const MERCHANT_ENEMY_CLEARANCE = 3;

// 4 "regular" items (each at most about one depth's income) plus 1 "featured" premium item (see
// stockRarityFloor/featuredRarity/featuredPriceMult below). The count stays fixed on purpose: the §17.17 sim showed
// the stock's total price already exceeded a depth's income at every depth even before the rarity steps (d10 ~2.4k vs
// ~0.9-1.9k income, d20 ~6.3k vs ~3-4.3k), so the late-game surplus was never "too little to buy" — it was "nothing
// worth buying" (below). Tripling the regular slots by depth 20 was tried in the sim: it only cut unspent gold ~half.
const REGULAR_GEAR_COUNT = 4;

// How many recently-sold items the merchant keeps on the Buyback tab. Selling past the cap
// evicts the oldest entry (FIFO).
export const MERCHANT_BUYBACK_CAP = 12;

// Stock rarity tracks what a character is actually wearing at that depth (DESIGN §17.4). The §17.17 sim measured the
// real cause of the late-game gold pile: from ~depth 6 the character's own loot (§17.14 treasure tiers, elites,
// bosses) already dresses them mostly in rare/epic/legendary gear, so a magic-floor depth+1 stock stopped being an
// upgrade (only ~1 of the 5 stock items was an upgrade at d10, ~0.6 at d20) and gold had nothing to go to. So the
// floor of the 4 regular items steps up at the first two boss milestones: magic (d1-4, unchanged) -> rare (d5-9) ->
// epic (d10+). Each step: from `depth` on, regular gear rolls at least `gear`; the Featured item is `featured`, with
// featuredUpChance(depth) of one tier higher.
export const STOCK_RARITY_STEPS = Object.freeze([
  Object.freeze({ depth: 1, gear: 'magic', featured: 'rare' }),
  Object.freeze({ depth: 5, gear: 'rare', featured: 'epic' }),
  Object.freeze({ depth: 10, gear: 'epic', featured: 'epic' }),
]);
function stockRarityStep(depth) {
  let step = STOCK_RARITY_STEPS[0];
  for (const s of STOCK_RARITY_STEPS) if (depth >= s.depth) step = s;
  return step;
}
export function stockRarityFloor(depth) { return stockRarityStep(depth).gear; }

// Every gear stock item is at exactly this item level (see generateMerchantStock).
export function stockItemLevel(depth) { return depth + 1; }

// The Featured item's chance of one tier above its step's base rarity (rare->epic at d1-4, epic->legendary from
// d5) — the same curve the old rare-or-epic Featured used.
export function featuredUpChance(depth) {
  return clamp(0.05 + depth * 0.02, 0.05, 0.5);
}
export function featuredRarity(depth, rng) {
  const base = stockRarityStep(depth).featured;
  const up = RARITY_ORDER[Math.min(RARITY_ORDER.length - 1, RARITY_ORDER.indexOf(base) + 1)];
  return rng.chance(featuredUpChance(depth)) ? up : base;
}

// Extra markup on top of buyPrice() for the featured item, so it's the "save up for it" pick rather than an every-
// depth purchase. Gold income grows faster with depth than item value does, so the markup rises with item level.
// Measured by the §17.17 sim (with the stock-rarity steps above): Featured ~220g at d3 / ~1.1k at d8 / ~2.9k at d15
// / ~4.7k at d20, ~1-1.5 depths of income, affordable on arrival 47% / 72% / 86% / 88% of the time.
const FEATURED_MULT_BASE = 1.5;
const FEATURED_MULT_PER_LEVEL = 0.13;
export function featuredPriceMult(itemLevel) {
  return FEATURED_MULT_BASE + FEATURED_MULT_PER_LEVEL * Math.max(0, (itemLevel || 1) - 1);
}

// Same idea, gentler, on the 4 regular gear slots. Stays well under featuredPriceMult at every level so Featured
// keeps its "the splurge item" identity. It multiplies buyPrice(), which already includes BUY_MULT (1.3), so it is
// exactly 1.0 through the shallow stock (depths 1-4 sell item levels 2-5, the part §17.4's affordability fix made
// work) and only starts climbing with the first stock-rarity step (depth 5 -> item level 6): 1.05 there, 1.8 at
// depth 20. (The first version was 1.3 + 0.05/level from level 1, which stacked on BUY_MULT, made depth-1 gear 1.69x
// value and cut depth-1 "can afford anything" from 42% to 23%.)
const REGULAR_MULT_PER_LEVEL = 0.05;
// Last item level still at 1.0: the stock of the depth just before the first rarity step (depth 4 -> level 5).
const REGULAR_MULT_FREE_LEVEL = stockItemLevel(STOCK_RARITY_STEPS[1].depth - 1);
export function regularGearPriceMult(itemLevel) {
  return 1 + REGULAR_MULT_PER_LEVEL * Math.max(0, (itemLevel || 1) - REGULAR_MULT_FREE_LEVEL);
}

// The price to buy a given stock entry. Potions use buyPrice() as-is (§16: potions stay in flat
// tiers, never a per-level curve); regular gear and the featured slot each get their own markup
// on top, gear's the milder one. UI and buyFromMerchant both go through this so the displayed
// price and the charged price can never drift apart.
export function shopPrice(stockKind, item) {
  const base = buyPrice(item);
  if (stockKind === 'featured') return Math.max(1, Math.round(base * featuredPriceMult(item.itemLevel)));
  if (stockKind === 'gear') return Math.max(1, Math.round(base * regularGearPriceMult(item.itemLevel)));
  return base;
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export function generateMerchantStock(depth, rng) {
  const heal = generateItem(depth, rng, { type: 'potion', potionKind: 'health' });
  const mana = generateItem(depth, rng, { type: 'potion', potionKind: 'mana' });
  const gear = [];
  // An exact itemLevel (not generateItem's usual +/-1 jitter) so each deeper shop's stock is
  // strictly stronger/pricier than the last depth's — the randomness that stays is rarity/affix
  // rolls, which is what makes two shops at the same depth feel different.
  const itemLevel = stockItemLevel(depth);
  const minRarity = stockRarityFloor(depth);
  for (let i = 0; i < REGULAR_GEAR_COUNT; i++) gear.push(generateItem(depth + 1, rng, { minRarity, itemLevel }));
  const featured = generateItem(depth + 1, rng, { rarity: featuredRarity(depth, rng), itemLevel });
  return { heal, mana, gear, featured };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

// Picks a floor tile inside `room` that isn't a door and isn't orthogonally adjacent to one,
// biased toward the room's centre so the merchant doesn't block a doorway or corridor mouth.
function findMerchantTile(map, room, rng) {
  const candidates = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (!map.inBounds(x, y) || map.get(x, y) !== TILE.FLOOR) continue;
      let nearDoor = false;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (map.get(x + dx, y + dy) === TILE.DOOR) { nearDoor = true; break; }
      }
      if (nearDoor) continue;
      candidates.push({ x, y, d: dist(x, y, room.cx, room.cy) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.d - b.d);
  const top = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * 0.4)));
  return rng.pick(top);
}

// Places a merchant in the room map.js reserved for it (map.merchantRoomId: a kind:'merchant' room that never gets
// enemy spawns, or the start room when no normal room existed), generates its stock and pushes it onto game.npcs.
// For a map generated without opts.merchant it falls back to the old pick: a 'normal' room (preferring rooms further
// from the entrance), else the start room (findMerchantTile still keeps it off the entrance niche and away from
// doors). Returns the merchant, or null only if the map has no rooms at all. `opts.room` lets the debug hook / tests
// force a specific room.
export function placeMerchant(game, opts = {}) {
  const map = game.map;
  if (!map) return null;
  // Normally map.js already chose the room (generateDungeon opts.merchant): a dedicated kind:'merchant' room with no
  // spawns inside (or the start room as its fallback). The pick below only runs for maps generated without it.
  const chosen = !opts.room && map.merchantRoomId != null ? (map.rooms || [])[map.merchantRoomId] : null;
  if (chosen) opts = { ...opts, room: chosen };
  let pool = (map.rooms || []).filter((r) => r.kind === 'normal');
  const fallback = !pool.length;
  if (fallback) {
    const startRoom = (map.rooms || []).find((r) => r.kind === 'start');
    pool = startRoom ? [startRoom] : [];
  }
  if (!pool.length && !opts.room) return null;

  let room = opts.room;
  if (!room) {
    if (fallback) {
      room = pool[0];
    } else {
      const ent = map.entrance;
      const ranked = pool.slice().sort((a, b) => dist(b.cx, b.cy, ent.x, ent.y) - dist(a.cx, a.cy, ent.x, ent.y));
      const far = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
      room = game.rng.pick(far);
    }
  }

  const spot = findMerchantTile(map, room, game.rng) || { x: room.cx, y: room.cy };
  const merchant = {
    id: uid(), type: 'merchant', x: spot.x, y: spot.y, fx: spot.x, fy: spot.y,
    stock: generateMerchantStock(game.depth, game.rng),
    buyback: [],
  };
  game.npcs = game.npcs || [];
  game.npcs.push(merchant);
  return merchant;
}

// ---------------------------------------------------------------------------
// Queries used by main.js/ui.js
// ---------------------------------------------------------------------------

export function npcAt(game, x, y) {
  const npcs = game.npcs;
  if (!npcs) return null;
  for (const n of npcs) if (n.x === x && n.y === y) return n;
  return null;
}

// This depth's merchant regardless of the player's distance from them — unlike nearbyMerchant, not range-gated.
// Used so Bag salvage (which can happen anywhere on the floor, §17.8) can still land in a Buyback safety net.
export function currentMerchant(game) {
  const npcs = game.npcs;
  if (!npcs || !npcs.length) return null;
  return npcs.find((n) => n.type === 'merchant') || null;
}

// The merchant the player is currently close enough to trade with, or null.
export function nearbyMerchant(game) {
  const p = game.player;
  const npcs = game.npcs;
  if (!p || !npcs || !npcs.length) return null;
  const px = p.fx ?? p.x, py = p.fy ?? p.y;
  for (const n of npcs) {
    if (n.type !== 'merchant') continue;
    if (dist(px, py, n.x, n.y) <= MERCHANT_RANGE) return n;
  }
  return null;
}

// The closed treasure chest (§17.11 — a `{ type: 'chest', opened }` NPC in a hidden treasure room) the player is close
// enough to open, or null. Same range rule as trading with a merchant.
export function nearbyChest(game) {
  const p = game.player;
  const npcs = game.npcs;
  if (!p || !npcs || !npcs.length) return null;
  const px = p.fx ?? p.x, py = p.fy ?? p.y;
  for (const n of npcs) {
    if (n.type !== 'chest' || n.opened) continue;
    if (dist(px, py, n.x, n.y) <= MERCHANT_RANGE) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

// stockKind: 'heal' | 'mana' | 'gear' | 'featured'; `index` only matters for 'gear'.
// Returns { ok: true, item, price } or { ok: false, reason: 'gold'|'full'|'empty'|'invalid' }.
export function buyFromMerchant(game, merchant, stockKind, index) {
  const p = game && game.player;
  if (!p || !merchant || !merchant.stock) return { ok: false, reason: 'invalid' };

  let item = null;
  const isGear = stockKind === 'gear';
  const isFeatured = stockKind === 'featured';
  if (isGear) {
    item = merchant.stock.gear[index];
  } else if (isFeatured) {
    item = merchant.stock.featured;
  } else if (stockKind === 'heal' || stockKind === 'mana') {
    const template = merchant.stock[stockKind];
    if (template) item = { ...template, id: uid(), stack: 1 };
  }
  if (!item) return { ok: false, reason: 'empty' };

  const price = shopPrice(stockKind, item);
  if ((p.gold || 0) < price) return { ok: false, reason: 'gold' };
  if (!addToInventory(p, item)) return { ok: false, reason: 'full' };

  p.gold -= price;
  if (isGear) merchant.stock.gear.splice(index, 1);
  if (isFeatured) merchant.stock.featured = null;
  return { ok: true, item, price };
}

// Sells one bag slot (by inventory index) to the merchant. Equipped items aren't in the bag
// array so this can never touch them. The whole stack is removed for sellValue(item), which
// covers every unit in it. When `merchant` is given, the sold item (whole stack) and the gold
// it fetched are appended to merchant.buyback (capped FIFO).
export function sellToMerchant(game, invIndex, merchant) {
  const p = game && game.player;
  if (!p) return { ok: false, reason: 'invalid' };
  const item = p.inventory[invIndex];
  if (!item) return { ok: false, reason: 'empty' };
  const price = sellValue(item);
  p.inventory.splice(invIndex, 1);
  p.gold = (p.gold || 0) + price;
  if (merchant) {
    merchant.buyback = merchant.buyback || [];
    merchant.buyback.push({ item, price });
    while (merchant.buyback.length > MERCHANT_BUYBACK_CAP) merchant.buyback.shift();
  }
  return { ok: true, item, price };
}

function fitsInInventory(p, item) {
  if (p.inventory.length < INVENTORY_SIZE) return true;
  if (item.type !== 'potion') return false;
  let room = 0;
  for (const it of p.inventory) {
    if (it.type === 'potion' && it.potionKind === item.potionKind && it.size === item.size) room += Math.max(0, it.maxStack - it.stack);
  }
  return room >= (item.stack || 1);
}

// Buys back merchant.buyback[index] for exactly the gold it sold for (no markup), restoring the
// same item object (same stack size). Returns { ok: true, item, price } or
// { ok: false, reason: 'gold'|'full'|'empty'|'invalid' } like buyFromMerchant.
export function buybackFromMerchant(game, merchant, index) {
  const p = game && game.player;
  if (!p || !merchant) return { ok: false, reason: 'invalid' };
  const entry = (merchant.buyback || [])[index];
  if (!entry) return { ok: false, reason: 'empty' };
  if ((p.gold || 0) < entry.price) return { ok: false, reason: 'gold' };
  // addToInventory can partially merge a potion stack before failing on a full bag, which would
  // hand over part of the stack for free — so check the whole stack fits before touching anything.
  if (!fitsInInventory(p, entry.item)) return { ok: false, reason: 'full' };
  if (!addToInventory(p, entry.item)) return { ok: false, reason: 'full' };
  p.gold -= entry.price;
  merchant.buyback.splice(index, 1);
  return { ok: true, item: entry.item, price: entry.price };
}
