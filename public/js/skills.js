// The 4 player skills: Cleave, Arcane Bolt, Frost Nova, Shadow Dash. Owned by the Character agent — see DESIGN.md §9.
// Uses ONLY the game API in DESIGN §6 (game.enemyAt, enemiesInRadius, damageEnemy, spawnProjectile, effect,
// floatText, log, isFree, isWalkable, rng, bus, player).

import { computeDamage } from './character.js';
import { applyResist } from './enemies.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
const RANK_DAMAGE_BONUS = 0.15;   // +15% damage per rank (rank 1 = base, so multiplier = 1 + (rank-1)*0.15)
const RANK_COOLDOWN_REDUCTION = 0.05; // -5% cooldown per rank

const CLEAVE_BASE_CD = 0.45;
const CLEAVE_MANA = 0;

const BOLT_BASE_CD = 0.6;
const BOLT_MANA = 6;
const BOLT_SPEED = 14;
const BOLT_RANGE = 10;

const NOVA_BASE_CD = 6.0;
const NOVA_MANA = 20;
const NOVA_BASE_RADIUS = 2.5;
const NOVA_RADIUS_PER_RANK = 0.25;
const NOVA_FROZEN_BASE = 1.2;
const NOVA_FROZEN_PER_RANK = 0.15;
const NOVA_SLOW = 3.0;

const DASH_BASE_CD = 2.5;
const DASH_MANA = 5;
const DASH_BASE_TILES = 3;
const DASH_INVULN_BASE = 0.4;
const DASH_INVULN_PER_RANK = 0.05;

const NO_MANA_FLASH_THROTTLE = 0.6; // seconds between "No mana" float texts

function rankMult(rank) { return 1 + (rank - 1) * RANK_DAMAGE_BONUS; }
function cooldownForRank(baseCd, rank) {
  return Math.max(0.1, baseCd * Math.pow(1 - RANK_COOLDOWN_REDUCTION, rank - 1));
}

// ---------------------------------------------------------------------------
// createSkillLoadout
// ---------------------------------------------------------------------------
export function createSkillLoadout() {
  return [
    {
      id: 'cleave', key: '1', name: 'Cleave', icon: '⚔️',
      description: 'Melee arc hitting the tile in front and the two beside it.',
      type: 'melee', rank: 1, maxRank: 5, cooldown: 0, baseCooldown: CLEAVE_BASE_CD, manaCost: CLEAVE_MANA,
    },
    {
      id: 'arcaneBolt', key: '2', name: 'Arcane Bolt', icon: '🔮',
      description: 'Fires a piercing bolt of arcane energy.',
      type: 'ranged', rank: 1, maxRank: 5, cooldown: 0, baseCooldown: BOLT_BASE_CD, manaCost: BOLT_MANA,
    },
    {
      id: 'frostNova', key: '3', name: 'Frost Nova', icon: '❄️',
      description: 'Damages and freezes/slows all nearby enemies.',
      type: 'special', rank: 1, maxRank: 5, cooldown: 0, baseCooldown: NOVA_BASE_CD, manaCost: NOVA_MANA,
    },
    {
      id: 'shadowDash', key: '4', name: 'Shadow Dash', icon: '💨',
      description: 'Dash forward through free tiles, briefly invulnerable.',
      type: 'dodge', rank: 1, maxRank: 5, cooldown: 0, baseCooldown: DASH_BASE_CD, manaCost: DASH_MANA,
    },
  ];
}

// ---------------------------------------------------------------------------
// useSkill
// ---------------------------------------------------------------------------
export function useSkill(game, index) {
  const player = game.player;
  if (!player || player.dead) return false;
  const skill = player.skills && player.skills[index];
  if (!skill) return false;

  if (skill.cooldown > 0) return false;

  if (skill.manaCost > 0 && player.mana < skill.manaCost) {
    if (player._noManaFlashTimer <= 0) {
      if (typeof game.floatText === 'function') game.floatText(player.x, player.y, 'No mana', '#6af');
      try { game.bus && game.bus.emit('denied'); } catch (e) { /* ignore */ }
      player._noManaFlashTimer = NO_MANA_FLASH_THROTTLE;
    }
    return false;
  }

  let performed = false;
  switch (skill.id) {
    case 'cleave': performed = castCleave(game, player, skill); break;
    case 'arcaneBolt': performed = castArcaneBolt(game, player, skill); break;
    case 'frostNova': performed = castFrostNova(game, player, skill); break;
    case 'shadowDash': performed = castShadowDash(game, player, skill); break;
    default: performed = false;
  }

  if (!performed) return false;

  player.mana = Math.max(0, player.mana - skill.manaCost);
  skill.cooldown = cooldownForRank(skill.baseCooldown, skill.rank);
  try { game.bus && game.bus.emit('skillUsed', { skill }); } catch (e) { /* ignore */ }
  return true;
}

// ---------------------------------------------------------------------------
// updateSkills — tick cooldowns
// ---------------------------------------------------------------------------
export function updateSkills(game, dt) {
  const player = game.player;
  if (!player || !Array.isArray(player.skills)) return;
  for (const skill of player.skills) {
    if (skill.cooldown > 0) skill.cooldown = Math.max(0, skill.cooldown - dt);
  }
}

// ---------------------------------------------------------------------------
// upgradeSkill
// ---------------------------------------------------------------------------
export function upgradeSkill(player, index) {
  if (!player || player.skillPoints <= 0) return false;
  const skill = player.skills && player.skills[index];
  if (!skill) return false;
  if (skill.rank >= skill.maxRank) return false;
  skill.rank += 1;
  player.skillPoints -= 1;
  return true;
}

// ---------------------------------------------------------------------------
// skillDescription — human string with current numbers
// ---------------------------------------------------------------------------
export function skillDescription(skill, player) {
  const stats = (player && player.stats) || {};
  const rank = skill.rank;
  switch (skill.id) {
    case 'cleave': {
      const mult = rankMult(rank);
      const lo = Math.max(1, Math.round((stats.meleeMin ?? 1) * mult));
      const hi = Math.max(lo + 1, Math.round((stats.meleeMax ?? 3) * mult));
      const kb = rank >= 3 ? ' Knockback on hit.' : ' Knockback on crit.';
      return `Deals ${lo}-${hi} damage to 3 tiles in front.${kb}`;
    }
    case 'arcaneBolt': {
      const mult = rankMult(rank);
      const lo = Math.max(1, Math.round((stats.rangedMin ?? 1) * mult));
      const hi = Math.max(lo + 1, Math.round((stats.rangedMax ?? 3) * mult));
      const pierce = rank >= 5 ? 2 : rank >= 3 ? 1 : 0;
      const pierceStr = pierce > 0 ? ` Pierces ${pierce} enemy${pierce > 1 ? 'ies' : ''}.` : '';
      return `Fires a bolt dealing ${lo}-${hi} damage.${pierceStr} Costs ${skill.manaCost} mana.`;
    }
    case 'frostNova': {
      const radius = (NOVA_BASE_RADIUS + (rank - 1) * NOVA_RADIUS_PER_RANK).toFixed(2);
      const mult = rankMult(rank);
      const power = Math.round((stats.spellPower ?? 5) * mult);
      const freeze = (NOVA_FROZEN_BASE + (rank - 1) * NOVA_FROZEN_PER_RANK).toFixed(1);
      return `Deals ~${power} damage to all enemies within ${radius} tiles, freezing them for ${freeze}s and slowing after. Costs ${skill.manaCost} mana.`;
    }
    case 'shadowDash': {
      const tiles = rank >= 4 ? DASH_BASE_TILES + 1 : DASH_BASE_TILES;
      const invuln = (DASH_INVULN_BASE + (rank - 1) * DASH_INVULN_PER_RANK).toFixed(2);
      return `Dash up to ${tiles} tiles, gaining ${invuln}s of invulnerability. Costs ${skill.manaCost} mana.`;
    }
    default:
      return skill.description || '';
  }
}

// ---------------------------------------------------------------------------
// Skill implementations
// ---------------------------------------------------------------------------

function facingOf(player) {
  const f = player.facing || { x: 0, y: 1 };
  return { x: f.x || 0, y: f.y || 0 };
}

// Perpendicular direction to a facing dir (for cleave's side tiles).
function perpOf(facing) {
  // rotate 90deg: (x,y) -> (-y, x)
  return { x: -facing.y, y: facing.x };
}

function castCleave(game, player, skill) {
  const facing = facingOf(player);
  const perp = perpOf(facing);
  const fx = player.x + facing.x, fy = player.y + facing.y;
  const targets = [
    { x: fx, y: fy },
    { x: fx + perp.x, y: fy + perp.y },
    { x: fx - perp.x, y: fy - perp.y },
  ];

  const mult = rankMult(skill.rank);
  let hitAny = false;
  const rng = game.rng;
  const critChance = player.stats.critChance;
  const critMult = player.stats.critMult;

  for (const t of targets) {
    const enemy = typeof game.enemyAt === 'function' ? game.enemyAt(t.x, t.y) : null;
    if (!enemy) continue;
    hitAny = true;
    const power = rng.range(player.stats.meleeMin, player.stats.meleeMax) * mult;
    const { amount, crit } = computeDamage(power, enemy.defense, rng, critChance, critMult);
    const doKnockback = skill.rank >= 3 || crit;
    const opts = { crit, source: 'melee', element: 'physical' };
    if (doKnockback) opts.knockback = { x: facing.x, y: facing.y };
    if (typeof game.damageEnemy === 'function') game.damageEnemy(enemy, amount, opts);
  }

  if (typeof game.effect === 'function') game.effect('slash', player.x + facing.x, player.y + facing.y, { dir: facing });
  return true; // consumes cooldown/mana even on a whiff, matching a real "swing"
}

function castArcaneBolt(game, player, skill) {
  const facing = facingOf(player);
  const rng = game.rng;
  const mult = rankMult(skill.rank);
  const power = rng.range(player.stats.rangedMin, player.stats.rangedMax) * mult;
  const critChance = player.stats.critChance;
  const critMult = player.stats.critMult;
  // Precompute final damage (ignoring target defense — ranged/spell damage bypasses armor per contract note);
  // crit is rolled here so main.js/renderer can react to it (e.g. bigger float text) without recomputing.
  const crit = rng.chance(critChance);
  let amount = power * (1 + rng.range(-0.15, 0.15));
  if (crit) amount *= critMult;
  amount = Math.max(1, Math.round(amount));

  const pierce = skill.rank >= 5 ? 2 : skill.rank >= 3 ? 1 : 0;
  // Analog stick play aims freely (player.aim) from the free-movement position (fx/fy).
  const aim = player.aim || facing;

  if (typeof game.spawnProjectile === 'function') {
    game.spawnProjectile({
      x: player.fx ?? player.x, y: player.fy ?? player.y,
      dx: aim.x, dy: aim.y,
      speed: BOLT_SPEED,
      range: BOLT_RANGE,
      damage: amount,
      crit,
      power: true,
      owner: 'player',
      color: '#a86bff',
      size: 0.22,
      pierce,
      kind: 'bolt',
      element: 'arcane',
    });
  }
  return true;
}

function castFrostNova(game, player, skill) {
  const radius = NOVA_BASE_RADIUS + (skill.rank - 1) * NOVA_RADIUS_PER_RANK;
  const mult = rankMult(skill.rank);
  const rng = game.rng;
  const critChance = player.stats.critChance;
  const critMult = player.stats.critMult;

  const enemies = typeof game.enemiesInRadius === 'function' ? game.enemiesInRadius(player.x, player.y, radius) : [];
  const frozen = NOVA_FROZEN_BASE + (skill.rank - 1) * NOVA_FROZEN_PER_RANK;

  for (const enemy of enemies) {
    const power = player.stats.spellPower * mult;
    const { amount, crit } = computeDamage(power, enemy.defense, rng, critChance, critMult);
    if (typeof game.damageEnemy === 'function') game.damageEnemy(enemy, amount, { crit, source: 'spell', element: 'frost' });
    // Status-effect durations scale by the target's resist to that effect (enemies.js
    // ENEMY_TYPES.resist) — e.g. Bone Tyrant shrugs off most of the freeze/slow, Slime King
    // barely resists either. Regular enemies have no resist table, so this is a no-op for them.
    enemy.frozen = applyResist(enemy, 'freeze', frozen);
    enemy.slow = applyResist(enemy, 'slow', NOVA_SLOW);
  }

  if (typeof game.effect === 'function') game.effect('nova', player.x, player.y, { radius });
  return true; // always "goes off" even with 0 targets in range — it's still a mana-spending AoE pulse
}

function castShadowDash(game, player, skill) {
  const facing = facingOf(player);
  if (facing.x === 0 && facing.y === 0) return false;

  const maxTiles = skill.rank >= 4 ? DASH_BASE_TILES + 1 : DASH_BASE_TILES;
  const oldX = player.x, oldY = player.y;
  let steps = 0;
  let cx = player.x, cy = player.y;

  for (let i = 1; i <= maxTiles; i++) {
    const nx = player.x + facing.x * i;
    const ny = player.y + facing.y * i;
    if (typeof game.isFree === 'function' ? !game.isFree(nx, ny) : false) break;
    if (typeof game.isWalkable === 'function' && !game.isWalkable(nx, ny)) break;
    cx = nx; cy = ny;
    steps++;
  }

  if (steps === 0) return false; // fully blocked: no cooldown/mana consumed

  player.x = cx;
  player.y = cy;
  player.invuln = Math.max(player.invuln || 0, DASH_INVULN_BASE + (skill.rank - 1) * DASH_INVULN_PER_RANK);

  if (typeof game.effect === 'function') game.effect('dash', cx, cy, { from: { x: oldX, y: oldY } });
  return true;
}
