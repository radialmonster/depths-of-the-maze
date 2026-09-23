// Shared core utilities. Owned by the producer — see DESIGN.md §5.

export const TILE = Object.freeze({ WALL: 0, FLOOR: 1, DOOR: 2, ENTRANCE: 3, EXIT: 4 });

export const DIRS = Object.freeze({
  up: Object.freeze({ x: 0, y: -1 }),
  down: Object.freeze({ x: 0, y: 1 }),
  left: Object.freeze({ x: -1, y: 0 }),
  right: Object.freeze({ x: 1, y: 0 }),
});
export const DIR_LIST = [DIRS.up, DIRS.down, DIRS.left, DIRS.right];

export const RARITY = Object.freeze({
  common:    { id: 'common',    name: 'Common',    color: '#c8c8c8', weight: 60, statMult: 1.0, affixes: 0 },
  magic:     { id: 'magic',     name: 'Magic',     color: '#4f8cff', weight: 26, statMult: 1.25, affixes: 1 },
  rare:      { id: 'rare',      name: 'Rare',      color: '#ffd34f', weight: 10, statMult: 1.5, affixes: 2 },
  epic:      { id: 'epic',      name: 'Epic',      color: '#b44fff', weight: 3.5, statMult: 1.85, affixes: 3 },
  legendary: { id: 'legendary', name: 'Legendary', color: '#ff8c1a', weight: 0.5, statMult: 2.3, affixes: 4 },
});
export const RARITY_ORDER = ['common', 'magic', 'rare', 'epic', 'legendary'];

// Damage elements. Only 'physical' (Cleave), 'arcane' (Arcane Bolt) and 'frost' (Frost Nova)
// are dealt by anything today — fire/poison/lightning are reserved for future skills/gear, but
// the resist system and UI labels already support them (ENEMY_TYPES.resist, enemies.js
// getResist/applyResist).
export const ELEMENTS = Object.freeze({
  physical:  { id: 'physical',  name: 'Physical',  color: '#c8c8c8' },
  arcane:    { id: 'arcane',    name: 'Arcane',    color: '#a86bff' },
  frost:     { id: 'frost',     name: 'Frost',     color: '#66ccff' },
  fire:      { id: 'fire',      name: 'Fire',      color: '#ff7043' },
  poison:    { id: 'poison',    name: 'Poison',    color: '#66bb6a' },
  lightning: { id: 'lightning', name: 'Lightning', color: '#ffd43b' },
});
export const ELEMENT_ORDER = ['physical', 'arcane', 'frost', 'fire', 'poison', 'lightning'];

// Seeded PRNG (deterministic across a given seed). Exported so any module that needs a raw
// seeded generator function — not the full RNG class below — can share this one implementation
// (music.js and textures.js both used to keep their own identical copy of this).
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed = (Math.random() * 2 ** 32) >>> 0) {
    this.seed = seed;
    this._next = mulberry32(seed);
  }
  next() { return this._next(); }
  int(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
  range(min, max) { return min + this.next() * (max - min); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  weighted(arr, weightFn) {
    let total = 0;
    for (const a of arr) total += weightFn(a);
    let r = this.next() * total;
    for (const a of arr) { r -= weightFn(a); if (r <= 0) return a; }
    return arr[arr.length - 1];
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

export class EventBus {
  constructor() { this.handlers = new Map(); }
  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this.handlers.get(evt)?.delete(fn); }
  emit(evt, data) {
    const hs = this.handlers.get(evt);
    if (!hs) return;
    for (const fn of [...hs]) {
      try { fn(data); } catch (e) { console.error(`[bus] handler for "${evt}" threw`, e); }
    }
  }
}

let _uid = 1;
export const uid = () => _uid++;
// Bumps the id counter past `min` so items/enemies/projectiles created after loading a save
// never collide with ids already saved on the player's equipment/inventory.
export const bumpUid = (min) => { if (min >= _uid) _uid = min + 1; };

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
