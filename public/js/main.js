// Game glue: owns the game object, main loop, projectiles, pickups and depth transitions.
// See DESIGN.md §6 for the API exposed to other modules.
import { RNG, EventBus, uid, TILE, dist } from './core.js';
import { generateDungeon, computeFOV } from './map.js';
import { Renderer } from './renderer.js';
import { createPlayer, recalcStats, gainXP, mitigate, updatePlayer } from './character.js';
import { createSkillLoadout, useSkill, updateSkills } from './skills.js';
import { spawnEnemies, updateEnemies } from './enemies.js';
import { rollLoot, startingGear, addToInventory, useItem, generateItem } from './items.js';
import { Input } from './input.js';
import { UI } from './ui.js';

const FOV_RADIUS = 9;
const PROJECTILE_STEP = 0.25; // tiles per collision substep

const container = document.getElementById('game');
const fadeEl = document.getElementById('fade');
const renderer = new Renderer(container);
const input = new Input();

// 'title' | 'playing' | 'paused' | 'transition' | 'dead'
let mode = 'title';

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
  paused: false,
  stats: { kills: 0, goldEarned: 0, deepest: 1, timePlayed: 0 },

  isWalkable(x, y) {
    return !!this.map && this.map.isWalkable(x, y);
  },
  isFree(x, y) {
    if (!this.isWalkable(x, y)) return false;
    const p = this.player;
    if (p && !p.dead && p.x === x && p.y === y) return false;
    return !this.enemyAt(x, y);
  },
  enemyAt(x, y) {
    for (const e of this.enemies) if (!e.dead && e.x === x && e.y === y) return e;
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
    enemy.hp -= amount;
    enemy.hitFlash = 0.15;
    if (enemy.state === 'idle' || enemy.state === 'wander' || enemy.state === 'return') enemy.state = 'chase';
    enemy.provoked = true;
    this.floatText(enemy.x, enemy.y, opts.crit ? `${amount}!` : `${amount}`, opts.crit ? '#ffd34f' : '#ffffff');
    this.effect('hit', enemy.x, enemy.y, { color: opts.crit ? '#ffd34f' : '#ffffff' });

    if (enemy.hp <= 0) {
      this.killEnemy(enemy);
      return;
    }
    const kb = opts.knockback;
    if (kb && enemy.behavior !== 'boss' && this.isFree(enemy.x + kb.x, enemy.y + kb.y)) {
      enemy.x += kb.x;
      enemy.y += kb.y;
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
      ui.banner(`${enemy.name} slain!`, 'The depths tremble...');
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
      return;
    }
    p.hp -= amount;
    p.hitFlash = 0.2;
    this.floatText(p.x, p.y, `-${amount}`, '#ff4b4b');
    renderer.shake(Math.min(0.35, 0.08 + amount / Math.max(1, p.stats.maxHp)));
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
      ...p,
      id: p.id ?? uid(),
      dx: p.dx / len, dy: p.dy / len,
      traveled: 0,
      hit: p.hit instanceof Set ? p.hit : new Set(),
    });
  },

  effect(type, x, y, opts) { renderer.spawnEffect(type, x, y, opts || {}); },
  floatText(x, y, text, color) { renderer.floatText(x, y, text, color); },
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
window.__dbg = { renderer, ui, input };

game.bus.on('levelUp', ({ level }) => {
  ui.banner('Level Up!', `You reached level ${level} — press C to spend points`);
});

// ---------------------------------------------------------------------------
// Run / depth lifecycle

function newGame() {
  game.rng = new RNG();
  game.depth = 1;
  game.time = 0;
  game.stats = { kills: 0, goldEarned: 0, deepest: 1, timePlayed: 0 };

  const p = createPlayer();
  p.skills = createSkillLoadout();
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
  p.moveTimer = 0;
  p.facing = ent.dir ? { x: ent.dir.x, y: ent.dir.y } : { x: 0, y: 1 };

  game.enemies = spawnEnemies(game);
  seedTreasure();

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

function updatePlayerMovement() {
  const p = game.player;
  const dir = input.moveDir();
  if (!dir) return;
  // Turning is instant so skills can be aimed before the step completes.
  p.facing = { x: dir.x, y: dir.y };
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
  p.moveTimer = p.stats.moveCooldown;
  onPlayerMoved();
}

function onPlayerMoved() {
  const p = game.player;
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
      g.noPickup = true;
      continue;
    }
    game.effect('pickup', x, y);
    game.groundItems.splice(i, 1);
  }
}

function rarityColor(item) {
  const colors = { common: '#c8c8c8', magic: '#4f8cff', rare: '#ffd34f', epic: '#b44fff', legendary: '#ff8c1a' };
  return colors[item.rarity] || '#ddd';
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
          game.damageEnemy(e, pr.damage, { crit: pr.crit, source: 'ranged', knockback: null });
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
  const potion = p.inventory.find((it) => it && it.type === 'potion' && it.potion && it.potion[kind] > 0);
  if (!potion) {
    game.floatText(p.x, p.y, kind === 'heal' ? 'No health potions' : 'No mana potions', '#aaa');
    return;
  }
  useItem(game, potion);
}

function handleGameplayInput() {
  if (input.pressed('pause')) { pauseGame(); return; }
  if (input.pressed('character')) { ui.toggleCharacter(); return; }
  if (input.pressed('inventory')) { ui.toggleInventory(); return; }
  for (let i = 0; i < 4; i++) {
    if (input.pressed(`skill${i + 1}`)) {
      // Dash reads facing, so apply any held direction first.
      const dir = input.moveDir();
      if (dir) game.player.facing = { x: dir.x, y: dir.y };
      const beforeX = game.player.x, beforeY = game.player.y;
      useSkill(game, i);
      if (game.player.x !== beforeX || game.player.y !== beforeY) onPlayerMoved();
    }
  }
  if (input.pressed('potion')) drinkPotion('heal');
  if (input.pressed('mana_potion')) drinkPotion('mana');
  updatePlayerMovement();
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
  let simDt = 0;

  if (mode === 'playing') {
    if (ui.isModalOpen()) {
      ui.handleInput(game, input); // game is paused while panels are open
    } else {
      simDt = dt;
      game.time += dt;
      game.stats.timePlayed += dt;
      handleGameplayInput();
      if (mode === 'playing') {
        updatePlayer(game, dt);
        updateSkills(game, dt);
        updateEnemies(game, dt);
        updateProjectiles(dt);
        updateDeadEnemies(dt);
        clearNoPickupFlags();
      }
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

ui.showStart(() => newGame());
requestAnimationFrame(tick);
