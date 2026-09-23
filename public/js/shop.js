// Merchant placement, stock generation and buy/sell transactions. Owned by no one module —
// pure game-logic glue between map.js (room placement), items.js (stock/pricing) and the UI
// (public/js/ui.js renders game.npcs / merchant.stock; renderer.js draws them).
//
// A merchant is a plain object pushed onto game.npcs (reset to [] every loadDepth()):
//   { id, type: 'merchant', x, y, fx, fy, stock: { heal, mana, gear: [item...], featured } }
// `heal`/`mana` are potion templates (unlimited — buying clones one with stack:1); `gear` and
// `featured` are unique items, each removed from stock once bought. Stock is regenerated fresh
// every depth and never carries over — enemies don't respawn either, so a player who can't
// afford something on this depth's shop is choosing to save gold for the next one.

import { uid, TILE, dist, clamp } from './core.js';
import { generateItem, addToInventory, sellValue, buyPrice } from './items.js';

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

// 4 "regular" magic/rare items (roughly a single depth's income each) plus 1 "featured" premium
// item (see featuredRarity/featuredPriceMult below).
const REGULAR_GEAR_COUNT = 4;

// The featured item is rare at shallow depths, with a rising chance of epic the deeper you go.
function featuredRarity(depth, rng) {
  const epicChance = clamp(0.05 + depth * 0.02, 0.05, 0.5);
  return rng.chance(epicChance) ? 'epic' : 'rare';
}

// Extra markup on top of buyPrice() for the featured item, so it costs roughly 2-3 depths of
// typical income instead of one. Gold income grows faster with depth than item value does, so
// the markup rises with item level to hold that 2-3 depth target (est. income ~35g/depth at
// depth 1, ~120g at 5, ~260g at 10 → featured ≈ 110g / 285g / 600g).
const FEATURED_MULT_BASE = 1.5;
const FEATURED_MULT_PER_LEVEL = 0.13;
export function featuredPriceMult(itemLevel) {
  return FEATURED_MULT_BASE + FEATURED_MULT_PER_LEVEL * Math.max(0, (itemLevel || 1) - 1);
}

// The price to buy a given stock entry. Regular gear/potions use buyPrice() as-is; the featured
// slot gets featuredPriceMult() on top. UI and buyFromMerchant both go through this so the
// displayed price and the charged price can never drift apart.
export function shopPrice(stockKind, item) {
  const base = buyPrice(item);
  return stockKind === 'featured' ? Math.max(1, Math.round(base * featuredPriceMult(item.itemLevel))) : base;
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
  const itemLevel = depth + 1;
  for (let i = 0; i < REGULAR_GEAR_COUNT; i++) gear.push(generateItem(depth + 1, rng, { minRarity: 'magic', itemLevel }));
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

// Places a merchant in a 'normal' room (preferring rooms further from the entrance), generates
// its stock and pushes it onto game.npcs. Falls back to the start room (findMerchantTile still
// keeps it off the entrance niche and away from doors) if no normal room exists, so a merchant
// is placed on every qualifying depth rather than skipped. Returns the merchant, or null only if
// the map has no rooms at all. `opts.room` lets the debug hook / tests force a specific room.
export function placeMerchant(game, opts = {}) {
  const map = game.map;
  if (!map) return null;
  let pool = (map.rooms || []).filter((r) => r.kind === 'normal');
  const fallback = !pool.length;
  if (fallback) {
    const startRoom = (map.rooms || []).find((r) => r.kind === 'start');
    pool = startRoom ? [startRoom] : [];
  }
  if (!pool.length) return null;

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
// array so this can never touch them. Mirrors the existing salvage-on-shift-click pricing:
// the whole stack is removed for a single unit's sellValue.
export function sellToMerchant(game, invIndex) {
  const p = game && game.player;
  if (!p) return { ok: false, reason: 'invalid' };
  const item = p.inventory[invIndex];
  if (!item) return { ok: false, reason: 'empty' };
  const price = sellValue(item);
  p.inventory.splice(invIndex, 1);
  p.gold = (p.gold || 0) + price;
  return { ok: true, item, price };
}
