// Enemy types, spawning and AI. Owned by the Enemy agent — see DESIGN.md §10.
// Only imports from core.js (per contract); everything else comes through the `game` API (§6)
// and the map API (§7) passed in at call time.

import { DIR_LIST, RNG, uid, clamp, lerp, manhattan, dist } from './core.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
const WANDER_RADIUS = 6;        // enemies wander within this many tiles of home
const PATH_RADIUS = 20;         // BFS search radius cap (perf)
const FAR_DIST = 25;            // beyond this, idle/wander/return enemies think less often
const GIVEUP_TIME = 4;          // seconds without LOS before an aggroed enemy returns home
const ELITE_CHANCE = 0.10;
const ELITE_PREFIXES = ['Elite', 'Champion'];

// ---------------------------------------------------------------------------
// Enemy type table
// ---------------------------------------------------------------------------
// baseHp/baseAtk/baseDef/baseXp are depth-1 values; scaled by (1 + 0.12*(depth-1)).
// gold is [min,max] at depth 1, scaled the same way.
export const ENEMY_TYPES = {
  slime: {
    id: 'slime', name: 'Slime', minDepth: 1, maxDepth: 60,
    baseHp: 28, baseAtk: 4, baseDef: 0, baseXp: 5, gold: [1, 3],
    moveCooldown: 0.42, attackCooldown: 1.1, aggroRange: 5,
    behavior: 'melee',
    wanderPause: [0.8, 2.4],
    visual: { shape: 'slime', color: '#4fd67a', scale: 0.9 },
  },
  bat: {
    id: 'bat', name: 'Bat', minDepth: 1, maxDepth: 60,
    baseHp: 13, baseAtk: 3, baseDef: 0, baseXp: 3, gold: [0, 2],
    moveCooldown: 0.16, attackCooldown: 0.55, aggroRange: 8,
    behavior: 'swarm',
    wanderPause: [0.3, 1.0],
    visual: { shape: 'bat', color: '#8a5fd1', scale: 0.6 },
  },
  goblin: {
    id: 'goblin', name: 'Goblin', minDepth: 1, maxDepth: 60,
    baseHp: 24, baseAtk: 5, baseDef: 1, baseXp: 6, gold: [2, 5],
    moveCooldown: 0.26, attackCooldown: 0.85, aggroRange: 7,
    behavior: 'coward', fleeHpFrac: 0.35,
    wanderPause: [0.6, 2.0],
    visual: { shape: 'goblin', color: '#7ac142', scale: 0.85 },
  },
  skeleton: {
    id: 'skeleton', name: 'Skeleton', minDepth: 1, maxDepth: 60,
    baseHp: 32, baseAtk: 5, baseDef: 3, baseXp: 7, gold: [2, 4],
    moveCooldown: 0.30, attackCooldown: 1.0, aggroRange: 6,
    behavior: 'melee',
    wanderPause: [0.6, 2.0],
    visual: { shape: 'skeleton', color: '#d8d8c0', scale: 0.95 },
  },
  giant_spider: {
    id: 'giant_spider', name: 'Giant Spider', minDepth: 2, maxDepth: 60,
    baseHp: 20, baseAtk: 6, baseDef: 1, baseXp: 8, gold: [1, 4],
    moveCooldown: 0.30, chaseMoveCooldown: 0.15, attackCooldown: 0.8, aggroRange: 4,
    behavior: 'melee',
    wanderPause: [2.0, 5.0], // ambush: sits mostly still until player is close
    visual: { shape: 'spider', color: '#5a2a6b', scale: 0.85 },
  },
  kobold_slinger: {
    id: 'kobold_slinger', name: 'Kobold Slinger', minDepth: 1, maxDepth: 60,
    baseHp: 16, baseAtk: 4, baseDef: 0, baseXp: 6, gold: [2, 5],
    moveCooldown: 0.30, attackCooldown: 1.3, aggroRange: 8,
    behavior: 'ranged',
    ranged: { minDist: 3, maxDist: 5, speed: 7, range: 8, color: '#ffcc55', size: 0.18, kind: 'enemyBolt' },
    wanderPause: [0.6, 2.0],
    visual: { shape: 'goblin', color: '#c98a3a', scale: 0.8 },
  },
  skeleton_archer: {
    id: 'skeleton_archer', name: 'Skeleton Archer', minDepth: 4, maxDepth: 60,
    baseHp: 28, baseAtk: 7, baseDef: 2, baseXp: 11, gold: [3, 6],
    moveCooldown: 0.30, attackCooldown: 1.2, aggroRange: 9,
    behavior: 'ranged',
    ranged: { minDist: 3, maxDist: 6, speed: 8, range: 9, color: '#c9d6e0', size: 0.18, kind: 'enemyBolt' },
    wanderPause: [0.6, 2.0],
    visual: { shape: 'skeleton', color: '#9fb7c9', scale: 0.95 },
  },
  dark_mage: {
    id: 'dark_mage', name: 'Dark Mage', minDepth: 5, maxDepth: 60,
    baseHp: 26, baseAtk: 9, baseDef: 1, baseXp: 14, gold: [4, 8],
    moveCooldown: 0.34, attackCooldown: 1.6, aggroRange: 9,
    behavior: 'ranged',
    ranged: { minDist: 4, maxDist: 7, speed: 6.5, range: 10, color: '#b45cff', size: 0.22, kind: 'enemyBolt' },
    castTime: 0.7, blink: true, blinkCooldown: 4,
    wanderPause: [0.6, 2.0],
    visual: { shape: 'mage', color: '#3a1a5c', scale: 1.0 },
  },
  ogre: {
    id: 'ogre', name: 'Ogre', minDepth: 5, maxDepth: 60,
    baseHp: 75, baseAtk: 13, baseDef: 4, baseXp: 20, gold: [6, 12],
    moveCooldown: 0.50, attackCooldown: 1.5, aggroRange: 6,
    behavior: 'melee', windup: 0.55, heavy: true,
    wanderPause: [1.0, 2.5],
    visual: { shape: 'ogre', color: '#8a4a2a', scale: 1.5 },
  },

  // --- Bosses (spawned explicitly by spawnEnemies on depth % 5 === 0) ---
  slime_king: {
    id: 'slime_king', name: 'Slime King', minDepth: 5, maxDepth: 60, boss: true,
    baseHp: 260, baseAtk: 10, baseDef: 3, baseXp: 130, gold: [40, 70],
    moveCooldown: 0.42, attackCooldown: 2.2, aggroRange: 40,
    behavior: 'boss', windup: 0.6, meleeRange: 1.6, slamRadius: 2.2, summon: 'slime',
    ranged: { minDist: 0, maxDist: 8, speed: 6, range: 9, color: '#4fd67a', size: 0.25, kind: 'enemyBolt' },
    visual: { shape: 'boss', color: '#3fae62', scale: 2.3 },
    // Squishy against blunt/physical hits, but ice bites deep into an ooze — and it still
    // freezes solid (if only a little less obligingly than a regular slime).
    resist: { physical: 0.25, frost: -0.3, freeze: 0.3 },
  },
  bone_tyrant: {
    id: 'bone_tyrant', name: 'Bone Tyrant', minDepth: 10, maxDepth: 60, boss: true,
    baseHp: 320, baseAtk: 15, baseDef: 6, baseXp: 170, gold: [50, 90],
    moveCooldown: 0.40, attackCooldown: 2.0, aggroRange: 40,
    behavior: 'boss', windup: 0.6, meleeRange: 1.6, slamRadius: 2.2, summon: 'skeleton',
    ranged: { minDist: 0, maxDist: 9, speed: 7, range: 10, color: '#cfcfc0', size: 0.25, kind: 'enemyBolt' },
    visual: { shape: 'boss', color: '#cfcfc0', scale: 2.4 },
    // Arcane bolts pass clean through a ribcage, but crushing blows shatter bone — and dry
    // bone catches fire far more readily than it freezes.
    resist: { arcane: 0.3, physical: -0.25, fire: -0.2, freeze: 0.6, slow: 0.5 },
  },
};

function depthMult(depth) {
  return 1 + 0.12 * (depth - 1);
}

function pickBossId(depth) {
  const idx = Math.max(1, Math.round(depth / 5));
  return (idx % 2 === 1) ? 'slime_king' : 'bone_tyrant';
}

// ---------------------------------------------------------------------------
// Resistances — ENEMY_TYPES[id].resist maps an element (core.js ELEMENTS: physical, arcane,
// frost, fire, poison, lightning) or a status effect ('freeze', 'slow', ...) to a -0.75..0.8
// modifier. Positive = resists (less damage / shorter effect), negative = vulnerable (more
// damage / longer effect). Clamped so nothing is ever fully immune. Enemies with no `resist`
// table (i.e. everything but the two bosses today) are simply neutral to everything.
// ---------------------------------------------------------------------------
const RESIST_MIN = -0.75;
const RESIST_MAX = 0.8;

export function getResist(enemy, key) {
  if (!key) return 0;
  const type = ENEMY_TYPES[enemy?.type];
  const raw = type?.resist?.[key] ?? 0;
  return clamp(raw, RESIST_MIN, RESIST_MAX);
}

// Scales a status-effect duration (freeze/slow/...) by the enemy's resist to that key.
// Never returns a negative duration; a negative resist (vulnerability) lengthens it instead.
export function applyResist(enemy, key, value) {
  return Math.max(0, value * (1 - getResist(enemy, key)));
}

// ---------------------------------------------------------------------------
// Enemy factory
// ---------------------------------------------------------------------------
export function createEnemy(typeId, x, y, depth, rng, opts = {}) {
  const type = ENEMY_TYPES[typeId];
  if (!type) throw new Error(`enemies.js: unknown enemy type "${typeId}"`);

  const mult = depthMult(depth);
  const elite = opts.elite ?? (!type.boss && rng.chance(ELITE_CHANCE));
  const hpMult = elite ? 2 : 1;
  const atkMult = elite ? 1.3 : 1;
  const xpMult = elite ? 1.8 : 1;
  const goldMult = elite ? 1.5 : 1;
  const scaleMult = elite ? 1.25 : 1;

  const hp = Math.max(1, Math.round(type.baseHp * mult * hpMult));
  const atk = Math.max(1, Math.round(type.baseAtk * mult * atkMult));
  const def = Math.max(0, Math.round(type.baseDef * mult));
  const xp = Math.max(1, Math.round(type.baseXp * mult * xpMult));
  const goldMin = Math.max(0, Math.round(type.gold[0] * mult * goldMult));
  const goldMax = Math.max(goldMin, Math.round(type.gold[1] * mult * goldMult));

  const name = elite ? `${rng.pick(ELITE_PREFIXES)} ${type.name}` : type.name;

  return {
    id: uid(),
    type: typeId,
    name,
    x, y,
    facing: { x: 0, y: 1 },
    hp, maxHp: hp,
    attack: atk,
    defense: def,
    xp,
    gold: [goldMin, goldMax],
    level: depth,
    moveCooldown: type.moveCooldown,
    moveTimer: rng.range(0, type.moveCooldown),
    attackCooldown: type.attackCooldown,
    attackTimer: 0,
    aggroRange: type.aggroRange,
    behavior: type.behavior,
    state: 'idle',
    home: { x, y },
    visual: {
      shape: type.visual.shape,
      color: type.visual.color,
      scale: type.visual.scale * scaleMult,
    },
    slow: 0,
    frozen: 0,
    hitFlash: 0,
    _kbTime: 0, // cosmetic: renderer.js eases the tile-knockback slide over this window
    dead: false,
    deathTimer: 0,
    elite,

    // --- boss-only bookkeeping (harmless on regular enemies) ---
    _hopTime: 0, _hopFrom: null, _hopDur: 0, // cosmetic: renderer.js arcs a boss leap over this window
    _dazedTime: 0, _vulnMult: 1,             // Bone Tyrant post-charge "Dazed" vulnerability window
    _phase: 1, _noticed: false,
    _activeAttack: null, _atkSub: null, _atkTimer: 0, _lastAttack: null, _gapTimer: 0,

    // --- internal AI bookkeeping (extra fields beyond §10; harmless, ignored by other modules) ---
    _wanderTimer: rng.range(0.2, 1.2),
    _path: null,
    _pathGoal: null,
    _pathTimer: 0,
    _noLosTimer: 0,
    _windup: 0,
    _cast: 0,
    _blinkCd: 0,
    _thinkAccum: rng.range(0, 0.3),
  };
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------
function computeSpawnCount(depth) {
  const t = clamp((depth - 1) / 14, 0, 1);
  const base = lerp(12, 35, t);
  return Math.round(base + Math.max(0, depth - 15) * 1.2);
}

function tileFree(map, enemies, x, y) {
  if (!map.inBounds(x, y) || !map.isWalkable(x, y)) return false;
  for (let i = 0; i < enemies.length; i++) {
    if (enemies[i].x === x && enemies[i].y === y) return false;
  }
  return true;
}

function findNearbyFree(map, enemies, x, y, maxR = 4) {
  if (tileFree(map, enemies, x, y)) return { x, y };
  for (let r = 1; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (tileFree(map, enemies, nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  return null;
}

export function spawnEnemies(game) {
  const { map, depth, rng } = game;
  const enemies = [];
  if (!map) return enemies;

  const count = computeSpawnCount(depth);
  const isBossFloor = depth % 5 === 0;
  const startRoom = map.rooms?.find(r => r.kind === 'start');
  const bossRoom = isBossFloor ? map.rooms?.find(r => r.kind === 'boss') : null;

  const pool = Object.keys(ENEMY_TYPES).filter((id) => {
    const t = ENEMY_TYPES[id];
    return !t.boss && depth >= t.minDepth && depth <= t.maxDepth;
  });
  if (pool.length === 0) pool.push('slime');

  const minDistFromEntrance = 8;
  const raw = map.spawnCandidates(rng, count + 16, minDistFromEntrance) || [];
  const candidates = raw.filter(c => !startRoom || c.roomId !== startRoom.id);
  let ci = 0;
  const nextCandidate = () => candidates[ci++] || null;

  // --- Boss + guards ---
  if (bossRoom) {
    const bossId = pickBossId(depth);
    const spot = findNearbyFree(map, enemies, bossRoom.cx, bossRoom.cy) || { x: bossRoom.cx, y: bossRoom.cy };
    const boss = createEnemy(bossId, spot.x, spot.y, depth, rng, { elite: false });
    enemies.push(boss);

    const guardCount = rng.int(2, 4);
    for (let i = 0; i < guardCount; i++) {
      const gx = bossRoom.cx + rng.int(-3, 3);
      const gy = bossRoom.cy + rng.int(-3, 3);
      const gspot = findNearbyFree(map, enemies, gx, gy);
      if (!gspot) continue;
      enemies.push(createEnemy(rng.pick(pool), gspot.x, gspot.y, depth, rng));
    }
  }

  // --- Regular population, with swarm grouping for bats ---
  let guard = 0;
  while (enemies.length < count && guard < count * 6) {
    guard++;
    const c = nextCandidate();
    if (!c) break;
    if (!tileFree(map, enemies, c.x, c.y)) continue;
    const tid = rng.pick(pool);
    const type = ENEMY_TYPES[tid];
    enemies.push(createEnemy(tid, c.x, c.y, depth, rng));

    if (type.behavior === 'swarm' && enemies.length < count) {
      const groupSize = rng.int(1, 3);
      for (let g = 0; g < groupSize && enemies.length < count; g++) {
        const gx = c.x + rng.int(-2, 2);
        const gy = c.y + rng.int(-2, 2);
        const gspot = findNearbyFree(map, enemies, gx, gy, 2);
        if (!gspot) continue;
        enemies.push(createEnemy(tid, gspot.x, gspot.y, depth, rng));
      }
    }
  }

  // --- Exit guards: occasionally a stronger sentry near exit rooms ---
  const exitRooms = map.rooms?.filter(r => r.kind === 'exit') || [];
  for (const r of exitRooms) {
    if (!rng.chance(0.5)) continue;
    const spot = findNearbyFree(map, enemies, r.cx, r.cy);
    if (!spot) continue;
    enemies.push(createEnemy(rng.pick(pool), spot.x, spot.y, depth, rng, { elite: rng.chance(0.5) }));
  }

  return enemies;
}

// ---------------------------------------------------------------------------
// Pathfinding (BFS, radius-limited, cached per enemy by caller)
// ---------------------------------------------------------------------------
function bfsPath(game, sx, sy, gx, gy, maxRadius = PATH_RADIUS) {
  if (sx === gx && sy === gy) return [];
  const key = (x, y) => (x + 20000) * 100000 + (y + 20000);
  const startKey = key(sx, sy);
  const visited = new Set([startKey]);
  const parent = new Map();
  const queue = [[sx, sy]];
  let qi = 0;
  let found = false;

  while (qi < queue.length) {
    const [cx, cy] = queue[qi++];
    for (let d = 0; d < DIR_LIST.length; d++) {
      const dir = DIR_LIST[d];
      const nx = cx + dir.x, ny = cy + dir.y;
      if (Math.abs(nx - sx) + Math.abs(ny - sy) > maxRadius) continue;
      const k = key(nx, ny);
      if (visited.has(k)) continue;
      if (!game.isWalkable(nx, ny)) continue;
      visited.add(k);
      parent.set(k, [cx, cy]);
      if (nx === gx && ny === gy) { found = true; break; }
      queue.push([nx, ny]);
    }
    if (found) break;
  }
  if (!found) return null;

  const path = [];
  let cur = [gx, gy];
  while (!(cur[0] === sx && cur[1] === sy)) {
    path.push({ x: cur[0], y: cur[1] });
    cur = parent.get(key(cur[0], cur[1]));
    if (!cur) return null;
  }
  path.reverse();
  return path;
}

function findAltStep(game, e, gx, gy) {
  const curD = manhattan(e.x, e.y, gx, gy);
  let best = null, bestD = curD;
  for (let d = 0; d < DIR_LIST.length; d++) {
    const dir = DIR_LIST[d];
    const nx = e.x + dir.x, ny = e.y + dir.y;
    if (!game.isFree(nx, ny)) continue;
    const nd = manhattan(nx, ny, gx, gy);
    if (nd < bestD) { bestD = nd; best = { x: nx, y: ny, dir }; }
  }
  return best;
}

function dirFromDelta(dx, dy) {
  if (dx > 0) return { x: 1, y: 0 };
  if (dx < 0) return { x: -1, y: 0 };
  if (dy > 0) return { x: 0, y: 1 };
  if (dy < 0) return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function facePlayer(e, p) {
  const dx = p.x - e.x, dy = p.y - e.y;
  if (Math.abs(dx) >= Math.abs(dy)) e.facing = { x: dx >= 0 ? 1 : -1, y: 0 };
  else e.facing = { x: 0, y: dy >= 0 ? 1 : -1 };
}

function effMoveCooldown(e, type, useChase) {
  const base = (useChase && type.chaseMoveCooldown) ? type.chaseMoveCooldown : e.moveCooldown;
  return e.slow > 0 ? base * 2 : base;
}

// Moves e one step along a cached path toward (gx,gy). Recomputes at most ~every 0.3s.
function moveAlongPathToward(game, e, type, gx, gy, dt, useChaseSpeed) {
  e._pathTimer -= dt;
  const staleGoal = !e._pathGoal || manhattan(e._pathGoal.x, e._pathGoal.y, gx, gy) > 2;
  const needsNewPath = !e._path || (e._path.length === 0 && (e.x !== gx || e.y !== gy)) || e._pathTimer <= 0 || staleGoal;
  if (needsNewPath) {
    e._path = bfsPath(game, e.x, e.y, gx, gy, PATH_RADIUS) || [];
    e._pathGoal = { x: gx, y: gy };
    e._pathTimer = game.rng.range(0.25, 0.35);
  }

  if (e.moveTimer > 0) return;
  if (!e._path || e._path.length === 0) { e.moveTimer = 0.1; return; }

  let step = e._path[0];
  let jitter = false;
  if (type.behavior === 'swarm' && game.rng.chance(0.3)) {
    const jd = game.rng.pick(DIR_LIST);
    const jx = e.x + jd.x, jy = e.y + jd.y;
    if (game.isFree(jx, jy)) { step = { x: jx, y: jy }; jitter = true; }
  }

  if (game.isFree(step.x, step.y)) {
    e.facing = dirFromDelta(step.x - e.x, step.y - e.y);
    e.x = step.x; e.y = step.y;
    if (!jitter) e._path.shift();
    e.moveTimer = effMoveCooldown(e, type, useChaseSpeed);
  } else {
    const alt = findAltStep(game, e, gx, gy);
    if (alt) {
      e.facing = alt.dir;
      e.x = alt.x; e.y = alt.y;
      e.moveTimer = effMoveCooldown(e, type, useChaseSpeed);
      e._path = null; // deviated from plan; replan next time
    } else {
      e.moveTimer = 0.12; // wait, blocked
    }
  }
}

// ---------------------------------------------------------------------------
// Ranged attack helpers
// ---------------------------------------------------------------------------
function fireProjectile(game, e, type, p) {
  if (!game.hasLineOfSight(e.x, e.y, p.x, p.y)) return;
  const r = type.ranged || {};
  const dx0 = p.x - e.x, dy0 = p.y - e.y;
  const len = Math.hypot(dx0, dy0) || 1;
  game.spawnProjectile({
    x: e.x, y: e.y,
    dx: dx0 / len, dy: dy0 / len,
    speed: r.speed ?? 8,
    range: r.range ?? 9,
    traveled: 0,
    damage: e.attack,
    crit: false,
    owner: 'enemy',
    color: r.color ?? '#ff5533',
    size: r.size ?? 0.2,
    pierce: 0,
    kind: r.kind ?? 'enemyBolt',
    hit: new Set(),
  });
}

function summonMinions(game, e, type, opts = {}) {
  const minionId = type.summon ?? 'slime';
  const [nMin, nMax] = opts.count || [2, 3];
  const n = game.rng.int(nMin, nMax);
  for (let i = 0; i < n; i++) {
    for (let tries = 0; tries < 8; tries++) {
      const ang = game.rng.range(0, Math.PI * 2);
      const rad = 2 + game.rng.next() * 2;
      const nx = Math.round(e.x + Math.cos(ang) * rad);
      const ny = Math.round(e.y + Math.sin(ang) * rad);
      if (game.isFree(nx, ny)) {
        const minion = createEnemy(minionId, nx, ny, e.level, game.rng);
        minion.state = 'chase';
        minion.home = { x: nx, y: ny };
        game.enemies.push(minion);
        break;
      }
    }
  }
  game.effect?.('nova', e.x, e.y, { radius: 3 });
  game.log?.(`${e.name} summons reinforcements!`, '#ff8844');
}

// ---------------------------------------------------------------------------
// State handlers
// ---------------------------------------------------------------------------
function checkAggro(game, e, type) {
  const p = game.player;
  if (!p || p.dead) return;
  if (e.hp < e.maxHp) { e.state = 'chase'; e._noLosTimer = 0; return; }
  const d = dist(e.x, e.y, p.x, p.y);
  if (d <= e.aggroRange && game.hasLineOfSight(e.x, e.y, p.x, p.y)) {
    e.state = 'chase';
    e._noLosTimer = 0;
  }
}

function updateWander(game, e, dt, type) {
  e._wanderTimer -= dt;
  if (e._wanderTimer > 0) { e.state = 'idle'; return; }
  e.state = 'wander';
  if (e.moveTimer > 0) return;

  const dirs = game.rng.shuffle([...DIR_LIST]);
  let moved = false;
  for (const d of dirs) {
    const nx = e.x + d.x, ny = e.y + d.y;
    if (manhattan(nx, ny, e.home.x, e.home.y) > WANDER_RADIUS) continue;
    if (!game.isFree(nx, ny)) continue;
    e.x = nx; e.y = ny; e.facing = d;
    moved = true;
    break;
  }
  e.moveTimer = effMoveCooldown(e, type, false);
  const [pmin, pmax] = type.wanderPause || [0.6, 2.0];
  e._wanderTimer = game.rng.range(pmin, pmax);
  if (!moved) e.state = 'idle';
}

function updateChase(game, e, type, dt) {
  const p = game.player;
  if (!p || p.dead) { e.state = 'return'; return; }

  const los = game.hasLineOfSight(e.x, e.y, p.x, p.y);
  if (los) e._noLosTimer = 0; else e._noLosTimer += dt;
  const d = dist(e.x, e.y, p.x, p.y);
  if (e._noLosTimer > GIVEUP_TIME && d > e.aggroRange) { e.state = 'return'; e._path = null; return; }

  if (type.behavior === 'coward' && e.hp < e.maxHp * (type.fleeHpFrac ?? 0.35)) {
    e.state = 'flee';
    return;
  }

  const md = manhattan(e.x, e.y, p.x, p.y);

  if (type.behavior === 'ranged') {
    if (md <= 1) { e.state = 'flee'; return; }
    const r = type.ranged;
    if (md >= r.minDist && md <= r.maxDist && los) { e.state = 'attack'; return; }
    moveAlongPathToward(game, e, type, p.x, p.y, dt, true);
    return;
  }

  if (md === 1) { e.state = 'attack'; return; }
  moveAlongPathToward(game, e, type, p.x, p.y, dt, true);
}

function resolveMeleeHit(game, e, type) {
  const p = game.player;
  if (p && !p.dead && manhattan(e.x, e.y, p.x, p.y) === 1) {
    game.damagePlayer(type.heavy ? Math.round(e.attack * 1.5) : e.attack, e);
  }
}

function updateAttack(game, e, type, dt) {
  const p = game.player;
  if (!p || p.dead) { e.state = 'return'; return; }
  facePlayer(e, p);
  const md = manhattan(e.x, e.y, p.x, p.y);

  if (type.behavior === 'ranged') {
    if (md <= 1) { e.state = 'flee'; e._cast = 0; return; }
    if (md > type.ranged.maxDist || !game.hasLineOfSight(e.x, e.y, p.x, p.y)) {
      e.state = 'chase'; e._cast = 0; return;
    }

    // Dark mage: optional blink away if player closes in during cast.
    if (type.blink) {
      e._blinkCd = Math.max(0, e._blinkCd - dt);
      if (md <= 2 && e._blinkCd <= 0) {
        const bx = clamp(e.x + (e.x - p.x > 0 ? 2 : -2), 1, 9999);
        const by = clamp(e.y + (e.y - p.y > 0 ? 2 : -2), 1, 9999);
        if (game.isFree(bx, by)) {
          e.x = bx; e.y = by;
          e._blinkCd = type.blinkCooldown ?? 4;
          e._cast = 0;
          return;
        }
      }
    }

    if (type.castTime) {
      if (e._cast > 0) {
        e._cast -= dt;
        if (e._cast <= 0) {
          fireProjectile(game, e, type, p);
          e.attackTimer = e.attackCooldown;
        }
        return;
      }
      if (e.attackTimer <= 0) {
        e._cast = type.castTime;
        game.effect?.('hit', e.x, e.y, { telegraph: true, color: type.ranged?.color });
      }
      return;
    }

    if (e.attackTimer <= 0) {
      fireProjectile(game, e, type, p);
      e.attackTimer = e.attackCooldown;
    }
    return;
  }

  // Melee behaviors (includes coward when not fleeing)
  if (md !== 1) { e.state = 'chase'; return; }

  if (e._windup > 0) {
    e._windup -= dt;
    if (e._windup <= 0) {
      resolveMeleeHit(game, e, type);
      e.attackTimer = e.attackCooldown;
    }
    return;
  }

  if (e.attackTimer <= 0) {
    if (type.windup) {
      e._windup = type.windup;
      game.effect?.('hit', e.x, e.y, { telegraph: true, color: '#ff3b3b' });
    } else {
      game.damagePlayer(e.attack, e);
      e.attackTimer = e.attackCooldown;
    }
  }
}

function updateFlee(game, e, type, dt) {
  const p = game.player;
  if (!p || p.dead) { e.state = 'return'; return; }

  const d = dist(e.x, e.y, p.x, p.y);
  const md = manhattan(e.x, e.y, p.x, p.y);

  if (type.behavior === 'ranged') {
    if (md > 1) {
      e.state = (md <= type.ranged.maxDist && game.hasLineOfSight(e.x, e.y, p.x, p.y)) ? 'attack' : 'chase';
      return;
    }
  } else if (type.behavior === 'coward') {
    if (e.hp >= e.maxHp * (type.fleeHpFrac ?? 0.35) && d > 6) { e.state = 'chase'; return; }
  }

  if (d > e.aggroRange * 1.5) { e.state = 'return'; return; }

  if (e.moveTimer > 0) return;
  let best = null, bestD = -1;
  for (const dir of DIR_LIST) {
    const nx = e.x + dir.x, ny = e.y + dir.y;
    if (!game.isFree(nx, ny)) continue;
    const nd = dist(nx, ny, p.x, p.y);
    if (nd > bestD) { bestD = nd; best = { x: nx, y: ny, dir }; }
  }
  if (best) {
    e.x = best.x; e.y = best.y; e.facing = best.dir;
    e.moveTimer = effMoveCooldown(e, type, false);
  } else {
    e.moveTimer = 0.1;
  }
}

function updateReturn(game, e, type, dt) {
  const p = game.player;
  if (p && !p.dead) {
    const d = dist(e.x, e.y, p.x, p.y);
    if (d <= e.aggroRange && game.hasLineOfSight(e.x, e.y, p.x, p.y)) { e.state = 'chase'; return; }
  }
  if (e.x === e.home.x && e.y === e.home.y) {
    e.state = 'idle';
    const [pmin, pmax] = type.wanderPause || [0.6, 2.0];
    e._wanderTimer = game.rng.range(pmin, pmax);
    return;
  }
  moveAlongPathToward(game, e, type, e.home.x, e.home.y, dt, false);
}

// ---------------------------------------------------------------------------
// Boss AI — unique telegraphed attack patterns per boss, driven by a shared
// notice/phase/gap/attack state machine. All hit checks against the player use the
// float position (p.fx/p.fy, falling back to p.x/p.y) so dodging with the stick is fair.
// ---------------------------------------------------------------------------
const BOSS_ATTACK_GAP = [0.8, 1.5];       // idle/walk gap between attacks, for readability
const BOSS_PHASE2_HP_FRAC = 0.5;
const BOSS_PHASE2_CADENCE_MULT = 0.75;    // ~25% shorter gap between attacks in phase 2
const TELEGRAPH_COLOR = '#ff3b3b';        // every danger zone uses one readable red, whatever the boss/floor colour
const BOSS_FLAVOR = {
  slime_king: 'The ooze rises, crowned and hungry.',
  bone_tyrant: 'Bones rattle. The Tyrant awakens.',
};

function playerPos(p) {
  return { x: p.fx ?? p.x, y: p.fy ?? p.y };
}

// Perpendicular distance of (px,py) from the ray starting at (ox,oy) along unit dir (ux,uy),
// plus how far along the ray the closest point sits (negative/over-length means "off the end").
function lineHit(px, py, ox, oy, ux, uy) {
  const relx = px - ox, rely = py - oy;
  const proj = relx * ux + rely * uy;
  const perp = Math.abs(relx * uy - rely * ux);
  return { proj, perp };
}

// --- Slime King -------------------------------------------------------------------
const SK_HOP_TELEGRAPH = 0.85;
const SK_HOP_RADIUS = 1.8;
const SK_HOP_LEAP_TIME = 0.35;
const SK_HOP_DAMAGE_MULT = 1.5;
const SK_GLOB_TELEGRAPH = 0.35;
const SK_GLOB_COUNT = 8;
const SK_GLOB_COUNT_P2 = 16;
const SK_GLOB_SPEED = 3.4;
const SK_GLOB_RANGE = 8;
const SK_GLOB_DAMAGE_MULT = 0.6;
const SK_SPLIT_COUNT = [3, 4];

function skHopBegin(game, e) {
  const p = game.player;
  const { x: px, y: py } = playerPos(p);
  let tx = Math.round(px), ty = Math.round(py);
  if (!game.isWalkable(tx, ty)) { tx = e.x; ty = e.y; }
  e._hopTargetX = tx;
  e._hopTargetY = ty;
  game.effect('telegraphCircle', px, py, { radius: SK_HOP_RADIUS, duration: SK_HOP_TELEGRAPH, color: TELEGRAPH_COLOR });
  e._atkSub = 'telegraph';
  e._atkTimer = SK_HOP_TELEGRAPH;
}
function skHopTick(game, e, type, dt) {
  const p = game.player;
  if (e._atkSub === 'telegraph') {
    e._atkTimer -= dt;
    if (e._atkTimer <= 0) {
      e._hopFrom = { x: e.x, y: e.y };
      e.x = e._hopTargetX;
      e.y = e._hopTargetY;
      e._hopDur = SK_HOP_LEAP_TIME;
      e._hopTime = SK_HOP_LEAP_TIME; // renderer.js arcs the visual leap over this window
      e._atkSub = 'airborne';
      e._atkTimer = SK_HOP_LEAP_TIME;
    }
    return false;
  }
  // airborne
  e._atkTimer -= dt;
  if (e._atkTimer > 0) return false;
  if (p && !p.dead) {
    const { x: px, y: py } = playerPos(p);
    if (dist(e.x, e.y, px, py) <= SK_HOP_RADIUS + 0.35) {
      game.damagePlayer(Math.round(e.attack * SK_HOP_DAMAGE_MULT), e);
    }
  }
  game.effect('nova', e.x, e.y, { radius: SK_HOP_RADIUS, color: '#3fae62' });
  game.bus?.emit('bossSlam');
  return true;
}

function skGlobBegin(game, e) {
  game.effect('hit', e.x, e.y, { telegraph: true, color: '#4fd67a' });
  e._atkTimer = SK_GLOB_TELEGRAPH;
}
function skGlobTick(game, e, type, dt) {
  e._atkTimer -= dt;
  if (e._atkTimer > 0) return false;
  const count = e._phase >= 2 ? SK_GLOB_COUNT_P2 : SK_GLOB_COUNT;
  e._globToggle = !e._globToggle;
  const baseOffset = e._globToggle ? Math.PI / count : 0; // alternate the ring each cast
  for (let i = 0; i < count; i++) {
    const a = baseOffset + (i / count) * Math.PI * 2;
    game.spawnProjectile({
      x: e.x, y: e.y, dx: Math.cos(a), dy: Math.sin(a),
      speed: SK_GLOB_SPEED, range: SK_GLOB_RANGE, traveled: 0,
      damage: Math.max(1, Math.round(e.attack * SK_GLOB_DAMAGE_MULT)), crit: false, owner: 'enemy',
      color: '#7be89a', size: 0.22, pierce: 0, kind: 'enemyBolt', hit: new Set(),
    });
  }
  return true;
}

// Split fires once immediately on the phase-2 transition (see bossEnterPhase2), but is also a
// low-weight rotation option afterward so phase 2 genuinely gains an extra attack, not just a
// one-off — an occasional smaller top-up of reinforcements.
const SK_SPLIT_TOPUP_COUNT = [2, 3];
function skSplitBegin(game, e, type) { summonMinions(game, e, type, { count: SK_SPLIT_TOPUP_COUNT }); }
function skSplitTick() { return true; }

const SLIME_KING_ATTACKS = [
  { id: 'hopSlam', weight: 3, minPhase: 1, begin: skHopBegin, tick: skHopTick },
  { id: 'globSpray', weight: 2, minPhase: 1, begin: skGlobBegin, tick: skGlobTick },
  { id: 'split', weight: 1, minPhase: 2, begin: skSplitBegin, tick: skSplitTick },
];

// --- Bone Tyrant --------------------------------------------------------------------
const BT_SPEAR_TELEGRAPH = 0.8;
const BT_SPEAR_LEN = 7;
const BT_SPEAR_WIDTH = 1;
const BT_SPEAR_ANGLES = [-25, 0, 25].map((d) => d * Math.PI / 180);
const BT_SPEAR_ANGLES_P2 = [-50, -25, 0, 25, 50].map((d) => d * Math.PI / 180);
const BT_SPEAR_DAMAGE_MULT = 1.0;
const BT_CHARGE_TELEGRAPH = 0.75;
const BT_CHARGE_TILES = 5;
const BT_CHARGE_STEP_TIME = 0.06;
const BT_CHARGE_DAMAGE_MULT = 1.3;
const BT_CHARGE_DAZE = 1.0;
const BT_CHARGE_VULN_MULT = 1.25;
const BT_SPIRAL_DURATION = 2.0;
const BT_SPIRAL_ARMS = 2;
const BT_SPIRAL_RATE = 9; // projectiles/sec, split across arms
const BT_SPIRAL_SPEED = 5.5;
const BT_SPIRAL_RANGE = 9;
const BT_SPIRAL_DAMAGE_MULT = 0.55;
const BT_SPIRAL_TURNS = 2.5;
const BT_SPIRAL_SUMMON_COUNT = [2, 3];

// How far a straight lane from (ox,oy) along unit (ux,uy) runs before hitting a wall, capped at max.
// Spears/charge lanes stop at walls, both visually and for damage.
function laneLength(game, ox, oy, ux, uy, max) {
  const step = 0.25;
  for (let d = step; d <= max; d += step) {
    if (!game.isWalkable(Math.round(ox + ux * d), Math.round(oy + uy * d))) return Math.max(0.5, d - 0.5);
  }
  return max;
}

function btSpearsBegin(game, e) {
  const { x: px, y: py } = playerPos(game.player);
  const base = Math.atan2(py - e.y, px - e.x);
  const angles = e._phase >= 2 ? BT_SPEAR_ANGLES_P2 : BT_SPEAR_ANGLES;
  e._spearLines = angles.map((off) => {
    const a = base + off;
    const ux = Math.cos(a), uy = Math.sin(a);
    return { ux, uy, len: laneLength(game, e.x, e.y, ux, uy, BT_SPEAR_LEN) };
  });
  for (const line of e._spearLines) {
    game.effect('telegraphLine', e.x, e.y, { dx: line.ux, dy: line.uy, length: line.len, width: BT_SPEAR_WIDTH, duration: BT_SPEAR_TELEGRAPH, color: TELEGRAPH_COLOR });
  }
  e._atkTimer = BT_SPEAR_TELEGRAPH;
}
function btSpearsTick(game, e, type, dt) {
  e._atkTimer -= dt;
  if (e._atkTimer > 0) return false;
  const p = game.player;
  if (p && !p.dead) {
    const { x: px, y: py } = playerPos(p);
    for (const line of e._spearLines || []) {
      const { proj, perp } = lineHit(px, py, e.x, e.y, line.ux, line.uy);
      if (proj < -0.4 || proj > line.len + 0.2) continue;
      if (perp <= BT_SPEAR_WIDTH / 2 + 0.3) {
        game.damagePlayer(Math.round(e.attack * BT_SPEAR_DAMAGE_MULT), e);
        break;
      }
    }
  }
  e._spearLines = null;
  game.bus?.emit('bossSlam');
  return true;
}

function btChargeBegin(game, e) {
  const { x: px, y: py } = playerPos(game.player);
  const dx = px - e.x, dy = py - e.y;
  const len = Math.hypot(dx, dy) || 1;
  e._chargeDir = { x: dx / len, y: dy / len };
  const lane = laneLength(game, e.x, e.y, e._chargeDir.x, e._chargeDir.y, BT_CHARGE_TILES);
  game.effect('telegraphLine', e.x, e.y, { dx: e._chargeDir.x, dy: e._chargeDir.y, length: lane, width: 1, duration: BT_CHARGE_TELEGRAPH, color: TELEGRAPH_COLOR });
  e._atkSub = 'telegraph';
  e._atkTimer = BT_CHARGE_TELEGRAPH;
  e._chargeSteps = BT_CHARGE_TILES;
  e._chargeStepTimer = 0;
  e._chargeHit = false;
}
function btFinishCharge(game, e) {
  e._dazedTime = BT_CHARGE_DAZE;
  e._vulnMult = BT_CHARGE_VULN_MULT;
  game.floatText(e.x, e.y - 0.5, 'Dazed', '#ffdd66');
  game.bus?.emit('bossSlam');
  return true;
}
function btChargeTick(game, e, type, dt) {
  const p = game.player;
  if (e._atkSub === 'telegraph') {
    e._atkTimer -= dt;
    if (e._atkTimer <= 0) e._atkSub = 'charging';
    return false;
  }
  e._chargeStepTimer -= dt;
  if (e._chargeStepTimer > 0) return false;
  if (e._chargeSteps <= 0) return btFinishCharge(game, e);
  const nx = Math.round(e.x + e._chargeDir.x), ny = Math.round(e.y + e._chargeDir.y);
  const blocker = game.enemyAt(nx, ny);
  if (!game.isWalkable(nx, ny) || (blocker && blocker !== e)) return btFinishCharge(game, e);
  e.x = nx; e.y = ny;
  e._chargeSteps--;
  e._chargeStepTimer = BT_CHARGE_STEP_TIME;
  if (!e._chargeHit && p && !p.dead) {
    const { x: px, y: py } = playerPos(p);
    if (dist(e.x, e.y, px, py) <= 0.9) {
      game.damagePlayer(Math.round(e.attack * BT_CHARGE_DAMAGE_MULT), e);
      e._chargeHit = true;
    }
  }
  if (e._chargeSteps <= 0) return btFinishCharge(game, e);
  return false;
}

function btSpiralBegin(game, e, type) {
  e._spiralT = 0;
  e._spiralFireAccum = 0;
  e._spiralAngle0 = Math.random() * Math.PI * 2;
  summonMinions(game, e, type, { count: BT_SPIRAL_SUMMON_COUNT });
}
function btSpiralTick(game, e, type, dt) {
  e._spiralT += dt;
  e._spiralFireAccum += dt;
  const interval = 1 / BT_SPIRAL_RATE;
  while (e._spiralFireAccum >= interval && e._spiralT <= BT_SPIRAL_DURATION) {
    e._spiralFireAccum -= interval;
    const frac = e._spiralT / BT_SPIRAL_DURATION;
    const ang = e._spiralAngle0 + frac * Math.PI * 2 * BT_SPIRAL_TURNS;
    for (let arm = 0; arm < BT_SPIRAL_ARMS; arm++) {
      const a = ang + arm * (Math.PI * 2 / BT_SPIRAL_ARMS);
      game.spawnProjectile({
        x: e.x, y: e.y, dx: Math.cos(a), dy: Math.sin(a),
        speed: BT_SPIRAL_SPEED, range: BT_SPIRAL_RANGE, traveled: 0,
        damage: Math.max(1, Math.round(e.attack * BT_SPIRAL_DAMAGE_MULT)), crit: false, owner: 'enemy',
        color: '#cfcfc0', size: 0.2, pierce: 0, kind: 'enemyBolt', hit: new Set(),
      });
    }
  }
  return e._spiralT >= BT_SPIRAL_DURATION;
}

const BONE_TYRANT_ATTACKS = [
  { id: 'boneSpears', weight: 3, minPhase: 1, begin: btSpearsBegin, tick: btSpearsTick },
  { id: 'boneCharge', weight: 2, minPhase: 1, begin: btChargeBegin, tick: btChargeTick },
  { id: 'spiral', weight: 2, minPhase: 2, begin: btSpiralBegin, tick: btSpiralTick },
];

const BOSS_ATTACKS = { slime_king: SLIME_KING_ATTACKS, bone_tyrant: BONE_TYRANT_ATTACKS };

function bossEnterPhase2(game, e, type) {
  e._phase = 2;
  game.effect('nova', e.x, e.y, { radius: 2.5, color: '#ff5555' });
  game.floatText(e.x, e.y - 0.5, 'Enraged!', '#ff5555');
  game.bus?.emit('bossPhase2', { enemy: e });
  game.shake?.(0.3);
  if (type.id === 'slime_king') summonMinions(game, e, type, { count: SK_SPLIT_COUNT });
}

function bossMoveOrIdle(game, e, type, dt) {
  const p = game.player;
  facePlayer(e, p);
  if (dist(e.x, e.y, p.x, p.y) > 2.2) moveAlongPathToward(game, e, type, p.x, p.y, dt, true);
}

function pickBossAttack(game, e, table) {
  const phase = e._phase || 1;
  const inPhase = table.filter((a) => a.minPhase <= phase);
  const notRepeat = inPhase.filter((a) => a.id !== e._lastAttack);
  const pool = notRepeat.length ? notRepeat : inPhase;
  return game.rng.weighted(pool.length ? pool : table, (a) => a.weight);
}

function updateBoss(game, e, type, dt) {
  const p = game.player;
  if (!p || p.dead) return;

  // Intro: fires once, the first time the boss notices (or is debug-provoked toward) the player.
  if (!e._noticed) {
    const d = dist(e.x, e.y, p.x, p.y);
    if (e.provoked || (d <= e.aggroRange && game.hasLineOfSight(e.x, e.y, p.x, p.y))) {
      e._noticed = true;
      game.bus?.emit('bossIntro', { enemy: e });
      game.banner?.(e.name, BOSS_FLAVOR[type.id] || 'A powerful foe blocks your path.');
      game.shake?.(0.35);
    } else {
      return; // dormant until it notices the player
    }
  }

  if (e._phase === 1 && e.hp <= e.maxHp * BOSS_PHASE2_HP_FRAC) bossEnterPhase2(game, e, type);

  facePlayer(e, p);

  const table = BOSS_ATTACKS[type.id];
  if (!table) return; // no pattern table defined for this boss id — sit still rather than throw

  if (e._activeAttack) {
    const atk = table.find((a) => a.id === e._activeAttack);
    const done = atk ? atk.tick(game, e, type, dt) : true;
    if (done) {
      e._lastAttack = e._activeAttack;
      e._activeAttack = null;
      const gap = game.rng.range(BOSS_ATTACK_GAP[0], BOSS_ATTACK_GAP[1]);
      e._gapTimer = e._phase >= 2 ? gap * BOSS_PHASE2_CADENCE_MULT : gap;
    }
    return;
  }

  if (e._gapTimer > 0) {
    e._gapTimer -= dt;
    bossMoveOrIdle(game, e, type, dt);
    return;
  }

  const chosen = pickBossAttack(game, e, table);
  e._activeAttack = chosen.id;
  e._atkSub = null;
  chosen.begin(game, e, type);
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------
export function updateEnemies(game, dt) {
  const enemies = game.enemies;
  if (!enemies || enemies.length === 0) return;
  const p = game.player;

  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    const type = ENEMY_TYPES[e.type];
    if (!type) continue;

    // Cosmetic/status timers always tick.
    if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt);
    if (e.slow > 0) e.slow = Math.max(0, e.slow - dt);
    if (e._kbTime > 0) e._kbTime = Math.max(0, e._kbTime - dt);
    if (e._hopTime > 0) e._hopTime = Math.max(0, e._hopTime - dt); // renderer.js arcs the leap over this
    if (e._dazedTime > 0) {
      e._dazedTime = Math.max(0, e._dazedTime - dt);
      if (e._dazedTime <= 0) e._vulnMult = 1;
    }

    if (e.frozen > 0) {
      e.frozen = Math.max(0, e.frozen - dt);
      continue; // frozen enemies do nothing else
    }

    if (e.moveTimer > 0) e.moveTimer = Math.max(0, e.moveTimer - dt);
    if (type.behavior !== 'boss' && e.attackTimer > 0) e.attackTimer = Math.max(0, e.attackTimer - dt);

    // Reduced think-frequency for far-away idle/wander/return enemies (perf).
    // We accumulate real elapsed time and hand the AI the FULL accumulated dt on the
    // flush tick (not a fixed per-frame dt) so timers still integrate real time correctly
    // and the enemy doesn't appear to freeze — it just decides less often.
    let tickDt = dt;
    if (type.behavior !== 'boss' && (e.state === 'idle' || e.state === 'wander' || e.state === 'return')) {
      const farAway = p && !p.dead && dist(e.x, e.y, p.x, p.y) > FAR_DIST;
      if (farAway) {
        e._thinkAccum += dt;
        if (e._thinkAccum < 0.4) continue;
        tickDt = e._thinkAccum;
        e._thinkAccum = 0;
      } else {
        e._thinkAccum = 0;
      }
    }

    if (type.behavior !== 'boss' && (e.state === 'idle' || e.state === 'wander')) {
      checkAggro(game, e, type);
    }

    if (type.behavior === 'boss') {
      updateBoss(game, e, type, dt);
      continue;
    }

    switch (e.state) {
      case 'idle':
      case 'wander': updateWander(game, e, tickDt, type); break;
      case 'chase': updateChase(game, e, type, dt); break;
      case 'attack': updateAttack(game, e, type, dt); break;
      case 'flee': updateFlee(game, e, type, dt); break;
      case 'return': updateReturn(game, e, type, tickDt); break;
      default: e.state = 'idle';
    }
  }
}
