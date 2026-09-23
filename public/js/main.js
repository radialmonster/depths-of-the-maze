// Game glue: owns the game object, main loop, projectiles, pickups and depth transitions.
// See DESIGN.md §6 for the API exposed to other modules.
import { RNG, EventBus, uid, bumpUid, TILE, dist, clamp, ELEMENTS, RARITY } from './core.js';
import { generateDungeon, computeFOV } from './map.js';
import { Renderer } from './renderer.js';
import { createPlayer, recalcStats, gainXP, mitigate, updatePlayer, projectileHitDamage } from './character.js';
import { createSkillState, normalizeSkillState, useSkill, updateSkills } from './skills.js';
import { spawnEnemies, updateEnemies, createEnemy, getResist, applySlow } from './enemies.js';
import { rollLoot, startingGear, addToInventory, useItem, generateItem, activePotion, enforceTwoHanded, refreshItemIcon } from './items.js';
import { Input } from './input.js';
import { UI, padLabel } from './ui.js';
import { sfx, wireAudio } from './audio.js';
import { saveRun, loadRun, clearSave } from './save.js';
import { isMerchantDepth, placeMerchant, nearbyMerchant, MERCHANT_ENEMY_CLEARANCE } from './shop.js';

const FOV_RADIUS = 9;
const PROJECTILE_STEP = 0.25; // tiles per collision substep

// --- Combat "game feel" tunables -------------------------------------------------
const ENEMY_HIT_FLASH_DURATION = 0.15; // seconds an enemy stays whited-out after a hit
const KNOCKBACK_VISUAL_DURATION = 0.18; // seconds renderer.js spends easing the tile-knockback slide
const CRIT_SHAKE = 0.12;    // camera shake on a crit
const BOSS_HIT_SHAKE = 0.1; // camera shake whenever a boss takes damage
const KILL_SHAKE = 0.05;    // light camera shake on a regular (non-boss) kill
const CRIT_HITSTOP = 0.045;     // freeze duration on a crit
const KILL_HITSTOP = 0.06;      // freeze duration on a regular kill
const BOSS_HIT_HITSTOP = 0.05;  // freeze duration on any boss hit
const BOSS_KILL_HITSTOP = 0.15; // freeze duration on a boss kill
const HITSTOP_SIM_SCALE = 0.05; // sim dt multiplier while hit-stop is active
const RESIST_FEEDBACK_THRESHOLD = 0.2;  // |resist| at/above this gets tagged in the float text
const RESIST_FLOAT_THROTTLE_MS = 220;   // don't tag every target when an AoE hits a crowd

const container = document.getElementById('game');
const fadeEl = document.getElementById('fade');
const renderer = new Renderer(container);
const input = new Input();

// 'title' | 'playing' | 'paused' | 'transition' | 'dead'
let mode = 'title';

// Tiny freeze on impactful hits (crit/kill/boss). Purely a sim-speed throttle applied in frame()
// — input polling, rendering and UI keep running every real frame; see frame() below.
let hitStop = 0;
function triggerHitStop(seconds) { hitStop = Math.max(hitStop, seconds); }
let lastResistFloatAt = 0; // throttle for the resist/weakness float-text tag (see damageEnemy)

const game = {
  rng: new RNG(),
  bus: new EventBus(),
  depth: 1,
  time: 0,
  map: null,
  player: null,
  enemies: [],
  groundItems: [],
  projectiles: [],
  npcs: [],
  paused: false,
  stats: { kills: 0, goldEarned: 0, deepest: 1, timePlayed: 0 },

  isWalkable(x, y) {
    return !!this.map && this.map.isWalkable(x, y);
  },
  isFree(x, y) {
    if (!this.isWalkable(x, y)) return false;
    const p = this.player;
    if (p && !p.dead && p.x === x && p.y === y) return false;
    if (this.npcAt(x, y)) return false;
    return !this.enemyAt(x, y);
  },
  enemyAt(x, y) {
    for (const e of this.enemies) if (!e.dead && e.x === x && e.y === y) return e;
    return null;
  },
  npcAt(x, y) {
    for (const n of this.npcs) if (n.x === x && n.y === y) return n;
    return null;
  },
  enemiesInRadius(x, y, r) {
    return this.enemies.filter((e) => !e.dead && dist(x, y, e.x, e.y) <= r);
  },
  hasLineOfSight(x0, y0, x1, y1) {
    return !!this.map && this.map.hasLineOfSight(x0, y0, x1, y1);
  },

  damageEnemy(enemy, amount, opts = {}) {
    if (!enemy || enemy.dead) return;
    amount = Math.max(1, Math.round(amount));
    // Elemental resist/vulnerability (enemies.js ENEMY_TYPES.resist), keyed by opts.element.
    const resist = opts.element ? getResist(enemy, opts.element) : 0;
    if (resist) amount = Math.max(1, Math.round(amount * (1 - resist)));
    // A boss left "Dazed" after a whiffed charge takes bonus damage for a short window.
    if (enemy._vulnMult && enemy._vulnMult !== 1) amount = Math.max(1, Math.round(amount * enemy._vulnMult));
    enemy.hp -= amount;
    enemy.hitFlash = ENEMY_HIT_FLASH_DURATION;
    if (enemy.state === 'idle' || enemy.state === 'wander' || enemy.state === 'return') enemy.state = 'chase';
    enemy.provoked = true;

    // Resist/weakness float-text feedback, throttled so an AoE (Frost Nova) hitting a crowd
    // doesn't tag every single target at once.
    let floatText = opts.crit ? `${amount}!` : `${amount}`;
    let floatColor = opts.crit ? '#ffd34f' : '#ffffff';
    // Point-blank weapon shot (§17.12): smaller grey number + duller hit sound.
    const floatOpts = opts.pointBlank ? { size: 12 } : undefined;
    if (opts.pointBlank) floatColor = '#9aa2b1';
    if (Math.abs(resist) >= RESIST_FEEDBACK_THRESHOLD) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - lastResistFloatAt > RESIST_FLOAT_THROTTLE_MS) {
        lastResistFloatAt = now;
        if (resist > 0) { floatText = `${amount} Resist`; floatColor = '#9aa2b1'; }
        else { floatText = `${amount} Weak!`; floatColor = ELEMENTS[opts.element]?.color || '#ff9f43'; }
      }
    }
    this.floatText(enemy.x, enemy.y, floatText, floatColor, floatOpts);
    this.effect('hit', enemy.x, enemy.y, { color: opts.crit ? '#ffd34f' : '#ffffff', crit: !!opts.crit });
    sfx.hit(!!opts.crit, opts.element, !!opts.pointBlank);

    const isBoss = enemy.behavior === 'boss';
    if (opts.crit) { renderer.shake(CRIT_SHAKE); triggerHitStop(CRIT_HITSTOP); }
    if (isBoss) { renderer.shake(BOSS_HIT_SHAKE); triggerHitStop(BOSS_HIT_HITSTOP); }

    if (enemy.hp <= 0) {
      this.killEnemy(enemy);
      return;
    }
    const kb = opts.knockback;
    if (kb && !isBoss && this.isFree(enemy.x + kb.x, enemy.y + kb.y)) {
      enemy.x += kb.x;
      enemy.y += kb.y;
      enemy._kbTime = KNOCKBACK_VISUAL_DURATION; // renderer.js eases this slide instead of the generic lerp
    }
  },

  killEnemy(enemy) {
    enemy.hp = 0;
    enemy.dead = true;
    enemy.deathTimer = 0.5;
    this.stats.kills++;
    this.effect('death', enemy.x, enemy.y, { color: enemy.visual?.color || '#aa3333' });
    if (enemy.behavior === 'boss') {
      renderer.shake(0.6);
      triggerHitStop(BOSS_KILL_HITSTOP);
      ui.banner(`${enemy.name} slain!`, 'The depths tremble...');
    } else {
      renderer.shake(KILL_SHAKE);
      triggerHitStop(KILL_HITSTOP);
    }
    this.floatText(enemy.x, enemy.y - 0.4, `+${enemy.xp} XP`, '#b18cff');
    gainXP(this, enemy.xp);
    this.dropLoot(enemy.x, enemy.y, rollLoot(enemy, this.depth, this.rng));
    this.bus.emit('enemyKilled', { enemy });
  },

  damagePlayer(raw, source) {
    const p = this.player;
    if (!p || p.dead || mode !== 'playing') return;
    if (p.invuln > 0) return;
    const amount = Math.round(mitigate(p, raw));
    if (amount <= 0) {
      this.floatText(p.x, p.y, 'Dodge', '#9fd8ff');
      this.bus.emit('playerDodged');
      return;
    }
    p.hp -= amount;
    p.hitFlash = 0.2;
    this.floatText(p.x, p.y, `-${amount}`, '#ff4b4b');
    renderer.shake(Math.min(0.35, 0.08 + amount / Math.max(1, p.stats.maxHp)));
    ui.pulseHit(amount / Math.max(1, p.stats.maxHp));
    this.bus.emit('playerDamaged', { amount, source });
    if (p.hp <= 0) {
      p.hp = 0;
      playerDied(source);
    }
  },

  spawnProjectile(p) {
    const len = Math.hypot(p.dx, p.dy) || 1;
    this.projectiles.push({
      pierce: 0, size: 0.2, color: '#ffffff', kind: 'bolt', crit: false,
      // §6.1 / §17.12: weapon-role shots set applyDefense (armor applies at impact) and pointBlankDamage;
      // spells and enemy shots leave the defaults (bypass armor, no point-blank penalty, no slow).
      applyDefense: false, pointBlankDamage: null, slow: null,
      ...p,
      ox: p.ox ?? p.x, oy: p.oy ?? p.y, // origin, for the point-blank distance check
      id: p.id ?? uid(),
      dx: p.dx / len, dy: p.dy / len,
      traveled: 0,
      hit: p.hit instanceof Set ? p.hit : new Set(),
    });
    if (p.owner !== 'player') sfx.enemyShot();
  },

  effect(type, x, y, opts) { renderer.spawnEffect(type, x, y, opts || {}); },
  floatText(x, y, text, color, opts) { renderer.floatText(x, y, text, color, opts); },
  log(text, color) { ui.log(text, color); },

  dropLoot(x, y, list) {
    if (!list || !list.length) return;
    // Scatter onto nearby walkable tiles so piles don't all stack on one tile.
    const spots = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    let i = 0;
    for (const item of list) {
      let sx = x, sy = y;
      for (let k = 0; k < spots.length; k++) {
        const [ox, oy] = spots[(i + k) % spots.length];
        const t = this.map.get(x + ox, y + oy);
        if (this.isWalkable(x + ox, y + oy) && t !== TILE.EXIT && t !== TILE.ENTRANCE) { sx = x + ox; sy = y + oy; break; }
      }
      i++;
      this.groundItems.push({ id: uid(), x: sx, y: sy, item, noPickup: false });
    }
  },
};
window.game = game; // handy for debugging in devtools

const ui = new UI(game, input);
// Thin wrappers so enemies.js (which only talks to the `game` API, per its header contract)
// can trigger a HUD banner or a camera shake without importing ui.js/renderer.js directly.
game.banner = (title, subtitle) => ui.banner(title, subtitle);
game.shake = (amount) => renderer.shake(amount);

window.__dbg = {
  renderer, ui, input,
  // Live music/audio state: music state, layer gains, scheduler stats, live node counts.
  get music() {
    const m = sfx.music ? sfx.music.debugInfo() : null;
    if (m) m.sfxNodes = sfx.liveNodes;
    return m;
  },
  // Places a merchant next to the player on the current depth via the same placement/stock
  // code path as a real merchant depth, regardless of game.depth % MERCHANT_DEPTH_INTERVAL.
  spawnMerchant() {
    if (!game.map || !game.player) return null;
    const p = game.player;
    const room = game.map.rooms.find((r) => r.x <= p.x && p.x < r.x + r.w && r.y <= p.y && p.y < r.y + r.h) || game.map.rooms[0];
    const merchant = placeMerchant(game, { room });
    if (merchant) game.log('[debug] Merchant placed at ' + merchant.x + ',' + merchant.y, '#c9b27a');
    return merchant;
  },
  // Spawns a boss (default Slime King) 4-5 tiles from the player on the current depth,
  // already provoked so its intro/AI kicks in immediately — for testing boss fights on depth 1.
  spawnBoss(id = 'slime_king') {
    if (!game.map || !game.player) return null;
    const p = game.player;
    let spot = null;
    for (let tries = 0; tries < 40 && !spot; tries++) {
      const ang = game.rng.range(0, Math.PI * 2);
      const r = game.rng.range(4, 5);
      const nx = Math.round(p.x + Math.cos(ang) * r), ny = Math.round(p.y + Math.sin(ang) * r);
      if (game.isFree(nx, ny)) spot = { x: nx, y: ny };
    }
    if (!spot) spot = { x: p.x, y: p.y };
    const boss = createEnemy(id, spot.x, spot.y, game.depth, game.rng, { elite: false });
    boss.provoked = true;
    game.enemies.push(boss);
    game.log(`[debug] Spawned ${boss.name} at ${spot.x},${spot.y}`, '#c9b27a');
    return boss;
  },
  // Model review: moves the player into the biggest room and lays out one of every enemy type
  // (plus an elite, both bosses and a merchant) in a grid around it. Gallery enemies are frozen
  // (AI never runs, so they never attack) but keep their true colours (renderer skips the frost
  // tint for `_gallery`). They can still be hit/killed to review the flash and death animations.
  modelGallery() {
    if (!game.map || !game.player) return null;
    this.clearGallery();
    const map = game.map;
    const room = map.rooms.reduce((best, r) => (!best || r.w * r.h > best.w * best.h ? r : best), null);
    const layout = [
      ['slime', -4, -3], ['bat', -2, -3], ['goblin', 0, -3], ['kobold_slinger', 2, -3], ['skeleton', 4, -3],
      ['skeleton_archer', -4, -1], ['giant_spider', -2, -1], ['dark_mage', 0, -1], ['ogre', 2, -1], ['goblin', 4, -1, true],
      ['slime_king', -5, 2], ['bone_tyrant', 5, 2],
    ];
    // Pick the spot on the map where the most of the grid (plus merchant/player tiles and the
    // bosses' surroundings) lands on open floor, so the models don't clip into walls.
    const extra = [[0, 1], [0, 3], [-5, 1], [-5, 3], [-4, 2], [-6, 2], [5, 1], [5, 3], [4, 2], [6, 2], [-1, -2], [1, -2], [3, -2], [-3, -2]];
    let cx = room ? room.cx : game.player.x, cy = room ? room.cy : game.player.y, bestScore = -1;
    for (let y = 1; y < map.height - 1; y++) for (let x = 1; x < map.width - 1; x++) {
      let sc = 0;
      for (const [, dx, dy] of layout) if (map.isWalkable(x + dx, y + dy)) sc++;
      for (const [dx, dy] of extra) if (map.isWalkable(x + dx, y + dy)) sc++;
      if (sc > bestScore) { bestScore = sc; cx = x; cy = y; }
    }
    const used = new Set();
    const spotNear = (x, y) => {
      for (let r = 0; r <= 4; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx, ny = y + dy;
          if (!map.isWalkable(nx, ny) || used.has(nx + ',' + ny)) continue;
          used.add(nx + ',' + ny);
          return { x: nx, y: ny };
        }
      }
      return null;
    };
    const p = game.player;
    const ps = spotNear(cx, cy + 3) || { x: cx, y: cy };
    p.x = ps.x; p.y = ps.y; p.fx = ps.x; p.fy = ps.y; p.facing = { x: 0, y: 1 }; p.aim = null;
    const spawned = [];
    for (const [id, dx, dy, elite] of layout) {
      const s = spotNear(cx + dx, cy + dy);
      if (!s) continue;
      const e = createEnemy(id, s.x, s.y, game.depth, game.rng, { elite: !!elite });
      e._gallery = true; e.frozen = 1e9; e.provoked = false;
      game.enemies.push(e);
      spawned.push(e);
    }
    const ms = spotNear(cx, cy + 1);
    if (ms) {
      const merchant = placeMerchant(game, { room: room || undefined });
      if (merchant) { merchant.x = ms.x; merchant.y = ms.y; merchant.fx = ms.x; merchant.fy = ms.y; merchant._gallery = true; }
    }
    computeFOV(map, p.x, p.y, FOV_RADIUS);
    return spawned;
  },
  clearGallery() {
    game.enemies = (game.enemies || []).filter((e) => !e._gallery);
    game.npcs = (game.npcs || []).filter((n) => !n._gallery);
  },
};
wireAudio(game);

game.bus.on('levelUp', ({ level }) => {
  const charKey = input.lastDevice === 'gamepad' ? padLabel('LB', input.padStyle) : 'C';
  ui.banner('Level Up!', `You reached level ${level} — press ${charKey} to spend points`);
});
// Checkpoint the run every time a new depth is entered, so refreshing/closing mid-level
// keeps inventory/gold/xp. Skipped if the player already died on this frame.
game.bus.on('depthChanged', () => {
  if (game.player && !game.player.dead) saveRun(game);
});

// ---------------------------------------------------------------------------
// Run / depth lifecycle

function newGame() {
  game.rng = new RNG();
  game.depth = 1;
  game.time = 0;
  game.stats = { kills: 0, goldEarned: 0, deepest: 1, timePlayed: 0 };

  const p = createPlayer();
  p.skillState = createSkillState();
  const gear = startingGear();
  Object.assign(p.equipment, gear.equipment);
  p.inventory = gear.inventory;
  recalcStats(p);
  p.hp = p.stats.maxHp;
  p.mana = p.stats.maxMana;
  game.player = p;

  loadDepth(1);
  mode = 'playing';
}

// Mirrors newGame() but restores a player from a save instead of rolling a fresh one.
// The depth itself is always regenerated fresh — only the player/run stats are restored.
function continueGame(data) {
  try {
    const sp = data.player || {};
    game.rng = new RNG();
    game.depth = data.depth || 1;
    game.time = 0;
    game.stats = Object.assign({ kills: 0, goldEarned: 0, deepest: 1, timePlayed: 0 }, data.stats || {});

    const p = createPlayer();
    p.name = sp.name ?? p.name;
    p.level = sp.level ?? p.level;
    p.xp = sp.xp ?? p.xp;
    p.attrPoints = sp.attrPoints ?? p.attrPoints;
    p.skillPoints = sp.skillPoints ?? p.skillPoints;
    p.gold = sp.gold ?? p.gold;
    p.base = sp.base ? { ...sp.base } : p.base;
    p.equipment = sp.equipment ? { ...p.equipment, ...sp.equipment } : p.equipment;
    p.inventory = Array.isArray(sp.inventory) ? sp.inventory : p.inventory;
    // Forgiving: unknown skill ids are dropped, missing/unresolvable loadout slots fall back to defaults (§17.3).
    p.skillState = normalizeSkillState(sp.skillState);
    p.bossesDefeated = Array.isArray(sp.bossesDefeated) ? sp.bossesDefeated.filter((id) => typeof id === 'string') : [];
    // Hotbar potion pins (absent in older saves -> null = best-first default).
    p.activeHealPotionId = sp.activeHealPotionId ?? null;
    p.activeManaPotionId = sp.activeManaPotionId ?? null;

    // Bump the id counter past every id in the restored equipment/inventory so new items,
    // enemies and projectiles created from here on never collide with a saved id.
    let maxId = 0;
    for (const item of p.inventory) {
      if (item && typeof item.id === 'number') maxId = Math.max(maxId, item.id);
      refreshItemIcon(item);
    }
    for (const slot in p.equipment) {
      const item = p.equipment[slot];
      if (item && typeof item.id === 'number') maxId = Math.max(maxId, item.id);
      refreshItemIcon(item);
    }
    bumpUid(maxId);

    // Saves from before bows/staves were two-handed may hold a bow or staff + off-hand: move the off-hand to the bag (§17.9).
    const strayOffhand = enforceTwoHanded(p);
    recalcStats(p);
    p.hp = clamp(sp.hp ?? p.stats.maxHp, 0, p.stats.maxHp);
    p.mana = clamp(sp.mana ?? p.stats.maxMana, 0, p.stats.maxMana);
    if (!(p.hp > 0)) throw new Error('restored player has no hp');

    game.player = p;
    loadDepth(game.depth);
    if (strayOffhand) game.dropLoot(p.x, p.y, [strayOffhand]); // bag was full: leave it at the player's feet
    mode = 'playing';
  } catch (e) {
    console.error('[save] failed to restore run, starting a new game instead', e);
    clearSave();
    newGame();
  }
}

function loadDepth(depth) {
  game.depth = depth;
  game.stats.deepest = Math.max(game.stats.deepest, depth);
  game.map = generateDungeon(depth, game.rng);
  game.projectiles = [];
  game.groundItems = [];

  const p = game.player;
  // Arrive on the floor just in front of the up-stairs, facing into the room.
  const ent = game.map.entrance;
  p.x = ent.front ? ent.front.x : ent.x;
  p.y = ent.front ? ent.front.y : ent.y;
  p.fx = p.x;
  p.fy = p.y;
  p.aim = null;
  p.moveTimer = 0;
  p.facing = ent.dir ? { x: ent.dir.x, y: ent.dir.y } : { x: 0, y: 1 };

  game.enemies = spawnEnemies(game);
  seedTreasure();

  game.npcs = [];
  if (isMerchantDepth(depth)) {
    const merchant = placeMerchant(game);
    // Keep the immediate area walkable and safe: no enemies loitering right on top of the stall.
    if (merchant) game.enemies = game.enemies.filter((e) => dist(e.x, e.y, merchant.x, merchant.y) > MERCHANT_ENEMY_CLEARANCE);
  }

  computeFOV(game.map, p.x, p.y, FOV_RADIUS);
  renderer.buildMap(game.map, depth);
  ui.banner(`Depth ${depth}`, depth % 5 === 0 ? 'A powerful presence lurks here...' : depthFlavor(depth));
  game.log(`You enter depth ${depth}.`, '#c9b27a');
  game.bus.emit('depthChanged', { depth });
}

function depthFlavor(depth) {
  const lines = ['The air grows colder.', 'Something skitters in the dark.', 'Ancient stone, older than memory.',
    'You hear distant chanting.', 'The walls seem to breathe.', 'Bones crunch underfoot.'];
  return depth === 1 ? 'Find the stairs down.' : lines[(depth * 7) % lines.length];
}

function seedTreasure() {
  for (const room of game.map.rooms) {
    if (room.kind !== 'treasure') continue;
    const count = game.rng.int(2, 3);
    const loot = [];
    for (let i = 0; i < count; i++) loot.push(generateItem(game.depth + 1, game.rng));
    loot.push({ type: 'gold', amount: game.rng.int(20, 40) * game.depth });
    game.dropLoot(room.cx, room.cy, loot);
  }
}

function descend() {
  mode = 'transition';
  game.effect('exit', game.player.x, game.player.y);
  sfx.stairs();
  fadeEl.classList.add('on');
  setTimeout(() => {
    loadDepth(game.depth + 1);
    fadeEl.classList.remove('on');
    mode = 'playing';
  }, 420);
}

function playerDied(source) {
  const p = game.player;
  p.dead = true;
  mode = 'dead';
  clearSave(); // a dead run can't be continued
  game.effect('death', p.x, p.y, { color: '#ff3030' });
  game.log(`You were slain by ${source?.name || 'the dungeon'}.`, '#ff5555');
  game.bus.emit('playerDied');
  setTimeout(() => {
    ui.showDeath({
      depth: game.depth,
      level: p.level,
      kills: game.stats.kills,
      gold: game.stats.goldEarned,
      timePlayed: Math.floor(game.stats.timePlayed),
      killedBy: source?.name,
    }, () => {
      ui.closeAll();
      newGame();
    });
  }, 1200);
}

// ---------------------------------------------------------------------------
// Per-frame systems

function updatePlayerMovement(dt) {
  const p = game.player;
  syncFreePos(p);
  const stick = input.analogMove();
  if (stick) { updateFreeMovement(stick, dt); return; }

  const dir = input.moveDir();
  if (!dir) return;
  // Turning is instant so skills can be aimed before the step completes.
  p.facing = { x: dir.x, y: dir.y };
  p.aim = null;
  if (p.moveTimer > 0) return;

  const nx = p.x + dir.x, ny = p.y + dir.y;
  if (game.enemyAt(nx, ny)) {
    // Bumping an enemy attacks it with the basic skill.
    useSkill(game, 0);
    p.moveTimer = 0.12;
    return;
  }
  if (!game.isFree(nx, ny)) return;
  p.x = nx;
  p.y = ny;
  p.fx = nx;
  p.fy = ny;
  p.moveTimer = p.stats.moveCooldown;
  onPlayerMoved();
}

// ---------------------------------------------------------------------------
// Free (analog stick) movement. The player has a float position fx/fy; x/y stay the
// tile it rounds to, so enemy AI, melee range, FOV, pickups and stairs are unchanged.

const PLAYER_RADIUS = 0.3;  // half-size of the player's collision box, in tiles
const FREE_SUBSTEP = 0.2;   // max tiles moved per collision substep
const CORNER_ASSIST = 0.75; // how far off a doorway's lane you can be and still get eased into it
const BUMP_RANGE = 1.1;     // centre distance at which pushing toward an enemy attacks it
const BUMP_CONE = 0.77;     // cos(~40deg): how directly you must push toward it
const STUCK_EPS = 1e-6;     // below this, a frame's free-movement progress counts as "fully stuck" (§17.1)

// Anything that moved the player by whole tiles (dash, depth load, keyboard step) wins.
function syncFreePos(p) {
  if (p.fx === undefined || Math.round(p.fx) !== p.x || Math.round(p.fy) !== p.y) {
    p.fx = p.x;
    p.fy = p.y;
  }
}

function blockedForPlayer(tx, ty) {
  return !game.isWalkable(tx, ty) || !!game.enemyAt(tx, ty) || !!game.npcAt(tx, ty);
}

// Tile indices covered by the player's box along one axis.
function boxSpan(c) {
  return [Math.floor(c - PLAYER_RADIUS + 0.5 + 1e-4), Math.floor(c + PLAYER_RADIUS + 0.5 - 1e-4)];
}

// Moves the box along one axis, stopping flush against blocked tiles (and never pushing
// backwards if an enemy stepped into a tile the box already overlaps). Returns true if blocked.
function moveAxis(p, axis, delta) {
  if (!delta) return false;
  const s = Math.sign(delta);
  const pos = axis === 'x' ? p.fx : p.fy;
  const [lo, hi] = boxSpan(axis === 'x' ? p.fy : p.fx);
  let next = pos + delta;
  const lead = Math.floor(next + s * PLAYER_RADIUS + 0.5);
  let blocked = false;
  for (let o = lo; o <= hi && !blocked; o++) {
    blocked = axis === 'x' ? blockedForPlayer(lead, o) : blockedForPlayer(o, lead);
  }
  if (blocked) {
    const flush = lead - s * (0.5 + PLAYER_RADIUS + 1e-3);
    next = s > 0 ? Math.max(pos, Math.min(next, flush)) : Math.min(pos, Math.max(next, flush));
  }
  if (axis === 'x') { p.fx = next; p.x = Math.round(next); } else { p.fy = next; p.y = Math.round(next); }
  return blocked;
}

// When blocked head-on near a doorway or corridor mouth, slide sideways into its lane
// instead of snagging on the corner.
function cornerAssist(p, axis, s, amount) {
  const along = axis === 'x' ? p.x : p.y;
  const side = axis === 'x' ? p.fy : p.fx;
  const near = Math.round(side);
  if (game.enemyAt(along + s, near)) return; // pushing into an enemy means attack, not slide past it
  const lanes = [near, near + (side >= near ? 1 : -1)];
  for (const lane of lanes) {
    const off = lane - side;
    if (Math.abs(off) > CORNER_ASSIST || Math.abs(off) < 1e-3) continue;
    const open = axis === 'x' ? !blockedForPlayer(along + s, lane) : !blockedForPlayer(lane, along + s);
    if (!open) continue;
    moveAxis(p, axis === 'x' ? 'y' : 'x', Math.sign(off) * Math.min(Math.abs(off), amount));
    return;
  }
}

// Face the stick: smooth aim for the model and aimed skills (Arcane Bolt), nearest 4-way for tile skills.
function faceStick(p, stick) {
  p.aim = { x: stick.x, y: stick.y };
  p.facing = Math.abs(stick.x) >= Math.abs(stick.y)
    ? { x: Math.sign(stick.x), y: 0 }
    : { x: 0, y: Math.sign(stick.y) };
}

function updateFreeMovement(stick, dt) {
  const p = game.player;
  faceStick(p, stick);

  // Pushing roughly toward an adjacent enemy (within ~40 degrees) holds position and swings,
  // like bumping by tile; a clearly sideways push walks around it instead.
  const ahead = game.enemyAt(p.x + p.facing.x, p.y + p.facing.y);
  if (ahead) {
    const ex = ahead.x - p.fx, ey = ahead.y - p.fy, ed = Math.hypot(ex, ey);
    if (ed < BUMP_RANGE && (ex * stick.x + ey * stick.y) / ed > BUMP_CONE) { useSkill(game, 0); return; }
  }

  const speed = stick.mag / Math.max(0.05, p.stats.moveCooldown);
  const total = speed * dt;
  const steps = Math.max(1, Math.ceil(total / FREE_SUBSTEP));
  const startX = p.x, startY = p.y;
  const startFx = p.fx, startFy = p.fy;
  for (let i = 0; i < steps; i++) {
    const d = total / steps;
    const bx = moveAxis(p, 'x', stick.x * d);
    const by = moveAxis(p, 'y', stick.y * d);
    if (bx && Math.abs(stick.x) >= Math.abs(stick.y)) cornerAssist(p, 'x', Math.sign(stick.x), d);
    if (by && Math.abs(stick.y) > Math.abs(stick.x)) cornerAssist(p, 'y', Math.sign(stick.y), d);
  }

  // "Fully stuck" (§17.1): zero progress on both axes (nothing to slide along — e.g. a diagonal push in a 1-wide
  // corridor with an enemy blocking one axis and a wall the other) with an enemy on the facing tile counts as an
  // aimed push. Any movement at all — sliding past an enemy, even slowly — never attacks.
  if (total > STUCK_EPS && Math.abs(p.fx - startFx) < STUCK_EPS && Math.abs(p.fy - startFy) < STUCK_EPS
      && game.enemyAt(p.x + p.facing.x, p.y + p.facing.y)) useSkill(game, 0);

  if (p.x !== startX || p.y !== startY) onPlayerMoved();
}

function onPlayerMoved() {
  const p = game.player;
  sfx.footstep(); // one soft step per tile moved (throttled), so it follows movement speed
  computeFOV(game.map, p.x, p.y, FOV_RADIUS);
  pickupAt(p.x, p.y);
  if (game.map.get(p.x, p.y) === TILE.EXIT) descend();
}

function pickupAt(x, y) {
  const p = game.player;
  for (let i = game.groundItems.length - 1; i >= 0; i--) {
    const g = game.groundItems[i];
    if (g.x !== x || g.y !== y || g.noPickup) continue;
    if (g.item.type === 'gold') {
      p.gold += g.item.amount;
      game.stats.goldEarned += g.item.amount;
      game.floatText(x, y, `+${g.item.amount}g`, '#ffd34f');
      game.log(`Picked up ${g.item.amount} gold.`, '#e8a200');
      game.bus.emit('goldPickedUp', { amount: g.item.amount });
    } else if (addToInventory(p, g.item)) {
      game.log(`Picked up ${g.item.name}.`, rarityColor(g.item));
      game.bus.emit('itemPickedUp', { item: g.item });
    } else {
      game.floatText(x, y, 'Inventory full', '#ff9955');
      game.bus.emit('denied');
      g.noPickup = true;
      continue;
    }
    game.effect('pickup', x, y);
    game.groundItems.splice(i, 1);
  }
}

function rarityColor(item) {
  const r = RARITY[item.rarity];
  return (r && r.color) || '#ddd';
}

function clearNoPickupFlags() {
  const p = game.player;
  for (const g of game.groundItems) {
    if (g.noPickup && (g.x !== p.x || g.y !== p.y)) g.noPickup = false;
  }
}

function updateProjectiles(dt) {
  const p = game.player;
  for (let i = game.projectiles.length - 1; i >= 0; i--) {
    const pr = game.projectiles[i];
    let remaining = pr.speed * dt;
    let alive = true;
    while (remaining > 0 && alive) {
      const step = Math.min(PROJECTILE_STEP, remaining);
      remaining -= step;
      pr.x += pr.dx * step;
      pr.y += pr.dy * step;
      pr.traveled += step;
      const tx = Math.round(pr.x), ty = Math.round(pr.y);
      if (!game.isWalkable(tx, ty)) {
        game.effect('hit', pr.x - pr.dx * 0.3, pr.y - pr.dy * 0.3, { color: pr.color });
        alive = false;
        break;
      }
      if (pr.owner === 'player') {
        const e = game.enemyAt(tx, ty);
        if (e && !pr.hit.has(e.id)) {
          pr.hit.add(e.id);
          // Hit-time resolution (§17.12): point-blank + target defense for applyDefense shots; others unchanged.
          // Distance is measured to the target's tile, not the projectile's position: with 0.25-tile substeps an
          // arrow enters a tile 2 away at exactly 1.5 tiles from its origin, which would make 2-tile shots
          // point-blank. A point-blank hit uses the bottom of the roll, so its release crit doesn't apply either.
          const { amount, pointBlank } = projectileHitDamage(pr, e.x, e.y, e.defense);
          game.damageEnemy(e, amount, { crit: pr.crit && !pointBlank, source: 'ranged', element: pr.element, knockback: null, pointBlank });
          if (pr.slow && !e.dead) applySlow(e, pr.slow.pct, pr.slow.dur);
          if (pr.pierce > 0) pr.pierce--;
          else alive = false;
        }
      } else if (!p.dead && tx === p.x && ty === p.y) {
        game.damagePlayer(pr.damage, pr.source || { name: 'a bolt' });
        game.effect('hit', p.x, p.y, { color: pr.color });
        alive = false;
      }
      if (pr.traveled >= pr.range) alive = false;
    }
    if (!alive) game.projectiles.splice(i, 1);
  }
}

function updateDeadEnemies(dt) {
  for (let i = game.enemies.length - 1; i >= 0; i--) {
    const e = game.enemies[i];
    if (!e.dead) continue;
    e.deathTimer -= dt;
    if (e.deathTimer <= 0) game.enemies.splice(i, 1);
  }
}

function drinkPotion(kind) {
  const p = game.player;
  const potion = activePotion(p, kind); // pinned stack, else strongest (DESIGN.md §17.8b)
  if (!potion) {
    game.floatText(p.x, p.y, kind === 'heal' ? 'No health potions' : 'No mana potions', '#aaa');
    game.bus.emit('denied');
    return;
  }
  useItem(game, potion);
}

let lastNearMerchant = null; // merchant greeting plays when one first comes into trade range
function handleGameplayInput(dt) {
  if (input.pressed('pause')) { pauseGame(); return; }
  // LB and keyboard C both always mean Character — predictable regardless of pending points.
  // The on-screen "points to spend" HUD pill (mouse-only) is the one control that routes to
  // whichever tab actually has unspent points, via ui.openPendingPointsTab() (DESIGN §13).
  if (input.pressed('character')) { ui.toggleCharacter(); return; }
  if (input.pressed('skills')) { ui.toggleSkills(); return; }
  if (input.pressed('inventory')) { ui.toggleInventory(); return; }

  // In range of a merchant, confirm opens the shop instead of attacking. On gamepad, A is both
  // confirm and skill1 — suppress skill1 this frame so trading never also swings a weapon.
  const merchant = nearbyMerchant(game);
  if (merchant && merchant !== lastNearMerchant) sfx.merchantGreet();
  lastNearMerchant = merchant;
  let suppressSkill1 = false;
  if (merchant && input.pressed('confirm')) {
    ui.openShop(merchant);
    suppressSkill1 = true;
  }

  for (let i = 0; i < 4; i++) {
    if (i === 0 && suppressSkill1) continue;
    if (input.pressed(`skill${i + 1}`)) {
      // Skills read facing/aim, so apply any held direction first.
      const stick = input.analogMove();
      const dir = stick ? null : input.moveDir();
      if (stick) faceStick(game.player, stick);
      else if (dir) { game.player.facing = { x: dir.x, y: dir.y }; game.player.aim = null; }
      const beforeX = game.player.x, beforeY = game.player.y;
      useSkill(game, i);
      if (game.player.x !== beforeX || game.player.y !== beforeY) {
        syncFreePos(game.player);
        onPlayerMoved();
      }
    }
  }
  if (input.pressed('potion')) drinkPotion('heal');
  if (input.pressed('mana_potion')) drinkPotion('mana');
  updatePlayerMovement(dt);
}

// The overlay is shown after ui.update() so the same key press that paused
// doesn't also count as "resume" inside the UI's overlay handling.
let pauseOverlayPending = false;
function pauseGame() {
  mode = 'paused';
  pauseOverlayPending = true;
}

function resumeGame() {
  ui.hidePause();
  mode = 'playing';
}

// ---------------------------------------------------------------------------
// Main loop

let last = performance.now();
function tick(now) {
  frame(now);
  requestAnimationFrame(tick);
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  input.update();
  sfx.tryResume(); // harmless retry so a gamepad button eventually unlocks audio too
  if (input.pressed('mute')) {
    const muted = sfx.toggleMute();
    const msg = muted ? 'Sound off' : 'Sound on';
    game.log(msg, '#888888');
    if (game.player) game.floatText(game.player.x, game.player.y, msg, '#888888');
  }
  let simDt = 0;

  if (mode === 'playing') {
    if (ui.isModalOpen()) {
      // game is paused while panels are open; handleInput() returns 'pause' if Start/P was
      // pressed, so it still opens the pause menu (closing the panel first).
      if (ui.handleInput(game, input) === 'pause') pauseGame();
    } else {
      // Hit-stop: crits/kills/boss hits throttle the whole sim (player movement included, so the
      // player mesh doesn't rubber-band) to a crawl for a beat. Input polling and rendering never
      // skip a step, and presses are edge-based, so a skill pressed during the freeze still lands.
      simDt = hitStop > 0 ? dt * HITSTOP_SIM_SCALE : dt;
      game.time += dt;
      game.stats.timePlayed += dt;
      handleGameplayInput(simDt);
      if (mode === 'playing') {
        updatePlayer(game, simDt);
        updateSkills(game, simDt);
        updateEnemies(game, simDt);
        updateProjectiles(simDt);
        updateDeadEnemies(simDt);
        clearNoPickupFlags();
      }
      if (hitStop > 0) hitStop = Math.max(0, hitStop - dt);
    }
  } else if (mode === 'paused') {
    if (input.pressed('pause') || input.pressed('cancel')) resumeGame();
  } else if (mode === 'dead') {
    simDt = dt; // let death effects play out
    updateDeadEnemies(dt);
  }

  if (game.map) renderer.update(game, simDt);
  renderer.render();
  ui.update(game, dt);
  sfx.musicObserve(game, mode, ui.isModalOpen()); // music picks its state (throttled internally)
  if (pauseOverlayPending) {
    pauseOverlayPending = false;
    if (mode === 'paused') ui.showPause(() => resumeGame());
  }
}

// Debug helper: advance the simulation manually (e.g. when the tab is hidden and rAF is paused).
window.__step = (frames = 1, stepMs = 1000 / 60) => {
  for (let i = 0; i < frames; i++) {
    last -= stepMs;
    frame(performance.now());
  }
};

// Checkpoint the run if the tab is hidden/closed mid-level (refresh, close, alt-tab-and-forget).
// Not while dead or on the title screen — those cases have nothing worth persisting.
function saveIfActive() {
  if (mode === 'playing' || mode === 'paused') saveRun(game);
}
window.addEventListener('pagehide', saveIfActive);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveIfActive();
});

const pendingSave = loadRun();
ui.showStart({
  save: pendingSave ? { depth: pendingSave.depth, level: (pendingSave.player && pendingSave.player.level) || 1 } : null,
  onNew: () => { sfx.unlock(); newGame(); },
  onContinue: () => { sfx.unlock(); if (pendingSave) continueGame(pendingSave); else newGame(); },
});
requestAnimationFrame(tick);
