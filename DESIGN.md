# DEPTHS OF THE MAZE — Game Design & Module Contract

Producer: Opus (orchestrator). Module builders: Sonnet agents.
**This document is the contract. Do not change the public API of your module without the producer's approval. Do not edit files you don't own.**

## 1. Pitch
Real-time, top-down, grid-based dungeon crawler rendered with three.js. Descend through procedurally generated
maze-like floors (small + large rooms, winding corridors, rooms with multiple doorways). Each floor has one entrance
and 1–3 exit stairs; stepping on an exit goes one "Depth" deeper (harder enemies, better loot). Kill enemies, gain XP,
level up, spend attribute + skill points (C), manage gear (I). Die → run summary → restart.

## 2. Tech
- No build step. Plain ES modules, served statically (`python -m http.server 8000`).
- three.js from CDN via import map in `index.html`: `import * as THREE from 'three';` (v0.160.0).
- The game fills the full browser viewport at any size (canvas 100vw×100vh, handles resize + devicePixelRatio capped at 2).
- All DOM UI (HUD, panels) is absolutely positioned HTML over the canvas.

## 3. Files & owners
| File | Owner | Purpose |
|---|---|---|
| `index.html` | Producer | Shell, import map, `#game` container, `#ui` root |
| `js/core.js` | Producer | TILE enum, RNG, EventBus, DIRS, uid, helpers |
| `js/main.js` | Producer | Game object, loop, glue, projectiles, pickups, depth transition |
| `js/map.js` | Map agent | Dungeon generation + FOV |
| `js/renderer.js` | Renderer agent | three.js scene, meshes, camera, effects, floating text |
| `js/character.js` | Character agent | Player creation, stats, XP/levels, damage formulas |
| `js/skills.js` | Character agent | The 4 skills, cooldowns, ranks |
| `js/enemies.js` | Enemy agent | Enemy types, spawning, AI (wander/chase/flee/ranged/boss) |
| `js/items.js` | Loot agent | Item generation, rarities, loot tables, equip/use/drop |
| `js/input.js` | UI agent | Keyboard + Gamepad abstraction |
| `js/ui.js` | UI agent | HUD, Character panel (C), Inventory panel (I), Shop panel, boss HP bar, messages, death/menu screens. Injects its own CSS. |
| `js/audio.js` | Producer | Procedural Web Audio sound effects, mute, `wireAudio(game)` bus wiring (§17.2) |
| `js/music.js` | Producer | Procedural adaptive music, owned by audio.js as `sfx.music` (§17.2) |
| `js/save.js` | Producer | localStorage save/continue (§17.3) |
| `js/shop.js` | Producer | Merchant placement, stock, pricing, buy/sell/buyback transactions (§17.4) |

## 4. Coordinates & conventions
- Grid tiles. Tile `(x, y)` ↔ world `(x, 0, y)` in three.js; 1 world unit per tile. Tile centers are at integer coords.
- `y` grows **down/south** on screen. "Up" key = `y - 1`.
- Keyboard / d-pad move the player tile-by-tile (4 directions). The gamepad left stick moves **freely** (see §17.1).
  `facing` is always one of `{x:0,y:-1} {x:0,y:1} {x:-1,y:0} {x:1,y:0}` (tile skills use it); `aim` is the exact stick
  direction (unit vector) or null.
- Logical positions of enemies are **integers** (`x`, `y`). The player has integer `x`,`y` (its tile, used by AI, FOV,
  pickups, stairs, melee range) plus float `fx`,`fy` (its free-movement position; `x = round(fx)`). Renderer smooths visuals
  itself (lerps meshes toward logical pos; the player toward `fx/fy`).
- Projectiles have **float** positions in tile units.
- Time: `dt` in seconds. All cooldowns/timers are in seconds and count **down** to 0.

## 5. core.js (exists — read it)
```js
TILE = { WALL:0, FLOOR:1, DOOR:2, ENTRANCE:3, EXIT:4 }
DIRS = { up, down, left, right }  // {x,y}
DIR_LIST = [up, down, left, right]
class RNG { constructor(seed); next(); int(min,max) /*inclusive*/; range(min,max); chance(p); pick(arr); weighted(arr, w=>number); shuffle(arr) }
class EventBus { on(evt, fn); off(evt, fn); emit(evt, data) }
uid()                         // unique incrementing int
clamp(v,a,b), lerp(a,b,t), manhattan(ax,ay,bx,by), dist(ax,ay,bx,by)
RARITY = { common, magic, rare, epic, legendary } each {id, name, color:'#hex', weight, statMult, affixes}
```

## 6. The `game` object (built in main.js, passed to everyone)
```js
game = {
  rng: RNG, bus: EventBus,
  depth: 1,                    // dungeon floor number (the user calls this "level" of the dungeon)
  time: 0,                     // seconds since start
  map,                         // see §7
  player,                      // see §8
  enemies: [],                 // see §9 — dead enemies are removed by main.js after renderer death anim (enemy.dead=true, enemy.deathTimer)
  groundItems: [],             // [{id, x, y, item}] item is an item object (§10) or {type:'gold', amount}
  projectiles: [],             // see §6.1
  paused: false,
  stats: { kills, goldEarned, deepest, timePlayed },   // run summary

  // --- API provided by main.js (call these, don't reimplement) ---
  isWalkable(x, y),            // map walkable (not WALL, in bounds)
  isFree(x, y),                // walkable AND no living enemy AND not player tile
  enemyAt(x, y),               // living enemy on tile or null
  enemiesInRadius(x, y, r),    // living enemies with dist <= r (euclidean, tiles)
  damageEnemy(enemy, amount, opts), // opts {crit:bool, knockback:{x,y}|null, source:'melee'|'ranged'|'spell'} — applies defense? NO: amount is final; call character.computeDamage first. Handles hit flash, float text, death, xp, loot.
  damagePlayer(amount, source),// raw incoming damage; main applies player defense via character.mitigate() and invuln
  spawnProjectile(p),          // see §6.1
  effect(type, x, y, opts),    // forwards to renderer.spawnEffect
  floatText(x, y, text, color, opts), // forwards to renderer.floatText; opts.size (px) optional
  log(text, color),            // forwards to ui.log
  dropLoot(x, y, list),        // push items/gold to groundItems near (x,y)
  hasLineOfSight(x0,y0,x1,y1), // uses map
}
```
### 6.1 Projectile
```js
{ id, x, y /*float*/, ox, oy /*origin tile, float — for point-blank distance*/, dx, dy /*unit dir*/,
  speed /*tiles/s*/, range /*tiles*/, traveled,
  damage, pointBlankDamage /*dmg used if it hits within POINT_BLANK_RANGE (~1.5) of ox,oy*/, crit,
  applyDefense /*bool — true = reduced by target defense like a melee hit (weapon shots); false = ignores defense (spells)*/,
  slow:{pct,dur}|null /*applied to the enemy on hit, via applySlow(), see §17.6*/,
  owner:'player'|'enemy', color:'#hex', size /*0.1-0.5*/, pierce:0,
  explode:{radius,color}|null /*bursts where it stops (enemy, wall, max range): `damage` to every enemy in radius + LOS*/,
  kind:'arrow'|'spark'|'bolt'|'fireball'|'glob'|'enemyBolt',
  hit:Set /*may be SHARED by several projectiles of one cast (Volley, Glob Burst): an enemy is hit once per cast*/ }
```
main.js moves projectiles, stops them at walls, and calls damageEnemy / damagePlayer on hit. Damage and crit are rolled
when the projectile is fired (so the crit feel happens at release); `applyDefense` and the point-blank check are
resolved at hit time (see §17.12). The point-blank distance is measured from `ox,oy` to the **target's tile**, not the
projectile's current position (with 0.25-tile substeps an arrow enters a tile 2 away at exactly 1.5 tiles).

## 7. Map (map.js)
```js
export function generateDungeon(depth, rng, opts?) -> map  // opts.prevArchetype: previous depth's map.archetype (§17.13)
                                                           // opts.merchant: merchant depth -> reserve a merchant room (§17.4)
export function computeFOV(map, x, y, radius)   // updates map.visible (clears first) and ORs into map.explored
map = {
  width, height,               // grows with depth, cropped to the used area (§17.13/§17.14 grow this further than
                                // the old ~50x50 -> ~85x85 curve; still never > 90, §17.14's headroom check confirmed why)
  tiles: Uint8Array(width*height),       // TILE values
  visible: Uint8Array(width*height),     // 1 = currently in FOV
  explored: Uint8Array(width*height),    // 1 = ever seen
  archetype,                    // this depth's generation profile (§17.13) — 'halls'|'catacombs'|'caverns'|'keep'|'wings'
  populatedFloor,               // floor-tile count used for general spawning (§17.16): excludes treasure-wing rooms
                                 // and the boss arena, which are populated separately
  rooms: [{ id, x, y, w, h, cx, cy, size:'small'|'medium'|'large'|'grand', shape, doors:[{x,y}],
             kind:'normal'|'start'|'exit'|'treasure'|'boss'|'merchant',
             treasureTier?:'cache'|'hoard'|'vault' /*treasure rooms only, §17.14*/,
             arena?:bossTypeId /*boss room only — which BOSS_ARENAS entry it used, §17.15*/,
             hidden?, secretDoor?:{x,y} /*hidden treasure room only, §17.11/§17.14*/,
             chests?:[{x,y}] /*treasure rooms: chest spots (main.js makes them chest NPCs)*/,
             antechamber?:true /*a Vault's guard room: kind 'treasure', treasureTier 'vault', no chests*/,
             antechamberId? /*on a Vault that sits behind an antechamber: that room's id*/ }],
             // shape is the room-shape function's own id (rect/pillars/Lshape/overlap/cave/cross/octagon/gallery/
             // ringHall/splitHall/cavern, §17.13; boss arenas: sump/ossuaryHall/arena, §17.15) — carried through so a future visual/texture pass has a real hook,
             // same idea as archetype/treasureTier/arena; none of these fields currently change rendering
  entrance: {x, y, dir, front, freestanding?}, // ENTRANCE tile: a cubby in the start room's wall (up-stairs);
                               // dir = unit step from the cubby into the room, front = floor tile in front (player spawn)
  exits: [{x, y, dir, front, freestanding?}],  // 1-3 EXIT cubbies (down-stairs), far from entrance; walking in descends
  secrets: [{x, y, roomId, revealed}],   // hidden treasure-room doorways: WALL tiles until revealed (§17.11/§17.14)
  secretAt(x,y), revealSecret(x,y) -> secret|null,  // reveal = WALL -> DOOR (main.js calls it, then renderer.revealTile)
  idx(x,y), inBounds(x,y), get(x,y), isWalkable(x,y), isOpaque(x,y),
  spawnCandidates(rng, count, minDistFromEntrance) -> [{x,y,roomId}] // floor tiles for enemies/loot — never in the
                               // start room, a treasure wing, the merchant room or the boss arena; ordered so any
                               // prefix spreads over rooms in proportion to their area (§17.16)
  roomTiles(roomId) -> [{x,y}], roomAt(x,y) -> room|null,  // a room's own FLOOR tiles / which room a floor tile is in
  merchantRoomId,              // opts.merchant: the merchant's room (kind 'merchant'; the start room if no normal room)
  baseRoomCount,               // rooms[0..baseRoomCount) are growth rooms; the rest are treasure wings
  treasureRolled: {tiers, antechamber},  // what the §17.14 roll asked for (placement-failure measurement, §17.17)
  hasLineOfSight(x0,y0,x1,y1)
}
```
Requirements: classic "large rooms linked together" layout — NOT a maze; room interiors are ~90%+ of all floor.
Base room count: `min(22, 11 + floor((depth-1)*0.6))` — 11 at depth 1, up to 22 by depth 20+ (raised from the old
10-16 cap once §17.14's headroom check confirmed 24-28 rooms place at a 100% success rate within the existing 86-tile
generation cap). Treasure-room wings (§17.14) and the boss arena (§17.15) add more rooms on top of this base count,
and are placed by a different mechanism (leaf-attachment / seed-room) than the base growth pass below.
`x,y,w,h` is the room's bounding box; `cx,cy` is always a walkable floor tile of that room.

**Base algorithm (unchanged): growth placement.** Each new room is attached to an existing room on one side, either
sharing a wall (single doorway in the common wall) or 3–7 tiles away with a short straight corridor; these parent
links form the spanning tree. Then a few extra links between nearby rooms add loops, and rooms are topped up to 2–4
links (large) / 1–3 (medium), capped at 4/3/2 (large/medium/small). Corridors are short, straight or L-shaped, 1 wide
(some straight ones widen to 2 between 1-wide doorways), always join two rooms (no dead ends from this pass — dead
ends are now created deliberately, only by treasure wings, §17.14), and never touch any other space. Every room
doorway is a TILE.DOOR. A BFS safety net guarantees all floor is reachable from the entrance; outer border always
WALL. Deterministic for a given rng.

**What varies per depth now (§17.13):** room-shape catalog, size mix (small/medium/large weights), corridor-gap
distribution, loop fraction, and the parent-weighting function are no longer fixed constants — they're set by the
depth's `archetype`, so different floors actually feel structurally different, not just re-skinned with the same
shape distribution.

**Generation pipeline order** (changed by §17.14/§17.15 — wings/arena need real detour-from-entrance data, which
didn't exist until after the old crop step):
1. base growth placement (rooms + spanning-tree links)
2. loop pass + link top-up
3. BFS connectivity safety net
4. choose start room, exits, and (on boss depths) the arena — then BFS again on the *uncropped* grid to rank every
   room's detour distance from the entrance (§17.14/§17.15 both need this ranking)
5. attach treasure wings as leaves, ordered Vault first then Hoards then Caches (a leaf has exactly one door, so it
   can never alter any start-to-exit path or invalidate step 4's ranking)
6. apply the hidden-room modifier (§17.11/§17.14) to one eligible Cache/Hoard
7. crop to the used bounding box, shifting entrance/exits/secrets to match — this step moved to *last*; it used to
   run right after placement

Implementation notes (Phase 2): step 4 also picks the merchant room (opts.merchant) before any wing attaches. Just
before step 5 the canvas is padded by up to 8 tiles a side (never past 90) so wings on edge rooms have room to
grow; the final crop trims what stays unused. After the crop, chest spots are chosen and the spawn caches built.
"Detour" = `dE(room) + dX(room) − dE(exit)` for the exit that minimizes it (0 = on a shortest entrance→exit route);
the entrance field is recomputed once the exit cubbies exist.

## 8. Player (character.js)
```js
export function createPlayer() -> player
export function recalcStats(player)            // recompute player.stats from base attrs + level + equipment + skill ranks; clamp hp/mana
export function xpForLevel(level)              // xp needed to go from level to level+1
export function gainXP(game, amount)           // adds xp, handles multiple level-ups, emits 'levelUp', grants points, full heal on level up
export function spendAttribute(player, attr)   // attr in 'str'|'dex'|'int'|'vit'|'def'; returns bool
export function computeDamage(power, targetDefense, rng, critChance, critMult) -> {amount, crit}
export function mitigate(player, rawAmount) -> number   // incoming dmg after player defense
export function updatePlayer(game, dt)         // regen, timers (invuln, buffs, hitFlash, moveTimer)
player = {
  id, x, y, facing:{x,y}, name:'Hero',
  level:1, xp:0, attrPoints:0, skillPoints:0, gold:0,
  base: { str, dex, int, vit, def },           // spendable attributes
  hp, mana,
  stats: { maxHp, maxMana,
           meleeMin, meleeMax,  // weapon dmg + STR*0.8; null when the equipped weapon's role isn't melee (§17.9)
           rangedMin, rangedMax, // weapon dmg + (DEX or INT)*0.8; null when the role isn't ranged
           spellPower, defense, critChance, critMult,
           moveCooldown /*s per tile, ~0.14*/, hpRegen, manaRegen /*per s*/, dodgeChance,
           cooldownReduction /*0..0.4, clamps effectiveCooldown() — see §17.10*/,
           autoAimAssist /*0..0.20, dex-driven aim nudge for any skill with aimed:true, see §17.5*/,
           pierce /*extra enemies each Bow Shot arrow passes through — bow-only Piercing affix, §17.9*/ },
  equipment: { weapon:null, offhand:null, helm:null, armor:null, boots:null, ring:null, amulet:null },
  inventory: [],               // max 24 item objects (INVENTORY_SIZE exported)
  skillState: {
    known: { [skillId]: rank },     // learned skills and their individual ranks (1-5) — see §17.10
    loadout: {
      attack: { melee1h, melee2h, bow, wand, staff },  // skill id assigned to slot 1 per weapon class
      spell, special, movement,                        // skill id assigned to slots 2-4
    },
  },
  skillCooldowns: { [skillId]: { t, max } },  // NOT saved — current cooldown timer per skill id
  bossesDefeated: [bossTypeId],   // saved; drives boss-unique skill-book drops, see §17.11
  moveTimer:0, invuln:0, hitFlash:0, dead:false, buffs:[]
}
```

## 9. Skills (skills.js)

### Registry
Skill **definitions** are static data keyed by id, never saved (so a save never freezes old balance numbers):
```js
SKILL_DEFS = { [id]: {
  id, name, icon /*emoji*/, description,
  category: 'attack'|'spell'|'special'|'movement',   // decides which HUD slot (1-4) it can occupy
  classes,      // attack skills only: which weapon classes (§17.9) can use this skill — e.g. ['bow']
  aimed,        // bool — true = eligible for dex/int aim-assist (§17.5), uses this skill's own range
  element,      // 'physical'|'arcane'|'frost'|'fire'|'poison'|'lightning'
  baseCooldown, manaCost,
  rankPerks,    // per-rank bonuses beyond the shared curve (see below)
  cast(game, player, skill, rank),  // performs the effect via the game API
} }
```
Every weapon **class** (`melee1h`, `melee2h`, `bow`, `wand`, `staff` — see §17.9) has exactly one default attack skill
that is always known and eligible with no unlock required (Cleave, Thrust, Bow Shot, Spark, Staff Sweep). Slots 2-4
each have a default with no weapon requirement (Arcane Bolt, Frost Nova, Shadow Dash). **This is a permanent rule,
enforced at startup with a loud error if violated, and covered by a unit test**: every slot must always resolve to a
usable skill no matter what's equipped or known — a weapon-restricted skill can only ever add an option, never be a
slot's only option (§17.10).

### API
```js
export function activeSkill(player, slotIndex) -> skillDef   // resolves what's actually in a slot right now (§17.10)
export function useSkill(game, index) -> bool   // checks cooldown/mana/dead; calls activeSkill(...).cast(...); sets cooldown
export function updateSkills(game, dt)          // ticks player.skillCooldowns
export function upgradeSkill(player, skillId) -> bool   // spends 1 skillPoint, that skill's known rank++ (max 5)
export function assignSkill(player, categoryOrClass, skillId) -> bool  // Skills-tab picker: sets loadout.attack[class] or loadout[category]
                                                //   (known skill of the right category; for a class the skill must list that class, but the
                                                //   class need not be the equipped one). 'attack' itself is not a valid target — pass a class.
export function learnSkill(player, skillId) -> bool     // from a skill book: new skill -> known at rank 1 AND +1 skillPoint (§17.11);
                                                //   already known -> +1 rank; false (book not consumed) at max rank / unknown id
export function attackSkillForClass(player, cls) -> skillDef  // slot-1 resolution for any class (activeSkill uses it for the equipped one)
export function knownSkills(player, category) -> skillDef[]  // known skills of a category, registry order (Skills-tab list)
export function skillEligible(player, def, category, cls) -> bool  // the eligibility rule activeSkill and the Skills tab share
export function skillDescription(skillId, rank, player) -> string  // for tooltips / Skills tab
export function effectiveCooldown(skillDef, rank, player) -> number  // base * 0.95^(rank-1) * (1 - clamp(cooldownReduction,0,0.4))
export function boltDamageRange(player) -> {min,max}   // Arcane Bolt's pre-rank damage from spellPower (x0.8 / x1.2), §17.9
// Skill books (§17.11):
export const GENERIC_BOOK_POOL, BOSS_SKILL_BOOKS          // derived from each def's `unlock`
export function bossBookDrops(bossType, bossesDefeated, rng) -> [skillId]  // first kill: unique; repeat: 20% generic / 3% unique
export function randomGenericBook(rng) -> skillId|null   // treasure chests
export function readSkillBook(player, skillId) -> {ok, isNew, rank, name, reason}  // learnSkill + what happened
export function skillBookInfo(skillId, player) -> {name, icon, categoryLabel, requires, description, unique, rank, maxRank}
```
`useSkill`/the HUD/the bump-attack in main.js only ever go through `activeSkill()` — none of them know which concrete
skill id is in a slot.

### Rank curve
Every skill shares +15% damage/rank and −5% cooldown/rank (via `effectiveCooldown`); each skill's `rankPerks` layers
extra effects on top at specific ranks (e.g. Cleave/Staff Sweep gain knockback on every hit at rank 3, not just crits;
Bow Shot gains an on-hit slow at rank 3; Arcane Bolt pierces +1 enemy at rank 3 and +1 more at rank 5).

### Slots and their category rules
Every skill in a category must follow that category's rules, so a new addition never needs special-casing elsewhere:

| Slot | Category | Default skill | Rules |
|---|---|---|---|
| 1 | Attack | Weapon-class-dependent (§17.9) | No mana cost; short cooldown; uses weapon damage; must work when triggered by walking into an adjacent enemy |
| 2 | Spell | Arcane Bolt | Costs mana; ignores armor (`applyDefense:false`); has an element |
| 3 | Special | Frost Nova | Long cooldown; high impact (area damage or crowd control) |
| 4 | Movement | Shadow Dash | Moves the player; gives brief invulnerability or an escape |

Launch attack skills: **Cleave** (1H melee, str; arc on facing tile + the two beside it, knockback), **Bow Shot**
(bow, dex; ranged, armor-reduced, point-blank penalty, rank-3 slow — §17.12), **Spark** (wand, int; free/no-mana
short-range (4 tiles) arcane shot, armor-reduced, same point-blank penalty as Bow Shot, rank 3: +1 tile range; aims
along `player.aim` like Arcane Bolt), **Staff Sweep** (staff, int; hits all 8 surrounding tiles, knockback straight
away from the player on crit — every hit from rank 3, like Cleave; 0.6s base cooldown).
Spell/special/movement at launch: **Arcane Bolt** (projectile, piercing at higher ranks), **Frost Nova** (AoE radius
~2.5, damage + slow/freeze, mana heavy), **Shadow Dash** (dash up to 3 tiles through free tiles, 0.4s invuln, short CD).
**Unlockable skills** (§17.11 — never known by default, never a default; learned from skill books; each definition
has `unlock: 'generic' | { boss: enemyTypeId }`): **Volley** (attack, bow — 3-arrow fan at 60% bow damage, one shared
hit set per volley, 0.7s CD; rank 3: 5 arrows), **Fireball** (spell, fire — bursts on impact, radius 1.5 (+0.5 at rank 3),
Arcane Bolt's spell-power damage to each target, 12 mana, 1.4s CD), **Chain Lightning** (special, lightning — nearest
enemy in sight within 6, then up to 3 jumps (+1 at rank 3 and 5) of ≤3.5 tiles, −20% per jump, armor applies like
Frost Nova; no target = no cost), **Blink** (movement, arcane — instant teleport up to 2 tiles (+1 at rank 3) along the
free aim, over enemies but never through walls, no invulnerability, 6 mana, 1.2s CD) — the generic pool, one per slot
category; and the boss-unique **Glob Burst** (special, poison, Slime King — a ring of 8 (12 at rank 3) axis-aligned
globs, spell-power ×0.7, each slowing 35% for 2s, one shared hit set, 18 mana, 7s CD) and **Bone Charge** (movement,
physical, Bone Tyrant — charge up to 4 tiles (+1 at rank 3) along facing, 90% weapon damage to each enemy in the
lane and shoving it to a free side tile; stops in front of anything it can't move (bosses); no invulnerability, 8 mana,
5s CD).
See §17.10 for the loadout/unlock system these plug into.

## 10. Enemies (enemies.js)
```js
export const ENEMY_TYPES = {...}
export function spawnEnemies(game) -> enemies[]   // uses game.map, game.depth, game.rng; boss on every 5th depth
export function spawnDensity(depth), computeSpawnCount(depth, populatedFloor)  // general-population count (§17.16)
export function updateEnemies(game, dt)
enemy = { id, type, name, x, y, facing, hp, maxHp, attack, defense, xp, gold:[min,max], level,
          moveCooldown, moveTimer, attackCooldown, attackTimer, aggroRange, behavior:'melee'|'ranged'|'coward'|'swarm'|'boss',
          state:'idle'|'wander'|'chase'|'flee'|'attack'|'return', home:{x,y},
          visual:{ shape:'slime'|'skeleton'|'bat'|'goblin'|'spider'|'mage'|'ogre'|'boss', color:'#hex', scale },
          slow:0 /*timer*/, slowPct:0 /*0..0.75, current slow strength — see applySlow() in §17.12*/,
          frozen:0, hitFlash:0, dead:false, deathTimer:0, elite:bool,
          bossGuard?, treasureGuard?:tier, warden?, exitSentry? /*spawn-role tags; untagged non-boss = general population*/ }
```
Behaviors: idle/wander near home; chase when player within aggroRange + line of sight; give up after losing player; cowards flee
at low HP (or always keep distance); ranged keep 3–5 tiles away and shoot `enemyBolt` projectiles; bosses have patterns.
Enemies attack adjacent (orthogonal) player via `game.damagePlayer(amount, enemy)`. Pathfinding: BFS/A* on grid, occupancy via `game.isFree`.
`effMoveCooldown = moveCooldown / (1 - slowPct)`, capped at `slowPct <= 0.75` so nothing is ever fully immobilized (§17.6).

## 11. Items (items.js)
```js
export const INVENTORY_SIZE = 24
export function generateItem(depth, rng, opts={}) -> item   // opts {slot, rarity, type}
export function rollLoot(enemy, depth, rng, opts={}) -> [item|{type:'gold',amount}]  // opts.bossesDefeated: boss skill-book drops (§17.11)
export function createSkillBook(skillId, depth) -> item  // type 'skillbook'; boss-unique = legendary, generic = rare
export function setSkillBookHooks({info, read, bossDrops})  // registered by skills.js (import cycle, like setAttackSkillResolver)
export function equipItem(player, item, log?) -> bool // from inventory; swaps with equipped; handles 2H off-hand eviction (§17.9); recalcStats.
                                                  //   optional log(text,color) gets the 2H refusal / eviction messages
export function equipCheck(player, item) -> {ok, reason?, evicts?}  // the 2H equip rules without side effects
export function enforceTwoHanded(player) -> item|null  // legacy saves (bow + off-hand): off-hand -> bag; returned if the bag is full
export const WEAPON_KIND_INFO; weaponKindInfo(kind); weaponInfo(item); weaponClassOf(item); isTwoHanded(item)  // §17.9
export function unequipItem(player, slot) -> bool
export function useItem(game, item) -> bool       // potions: heal/mana; skillbook: learnSkill(); consumed
export function dropItem(game, item)              // from inventory to ground at player
export function sellValue(item)
export function itemTooltip(item, player) -> HTML string (with compare vs equipped)
export function startingGear() -> {equipment, inventory}
item = { id, name, type:'weapon'|'offhand'|'helm'|'armor'|'boots'|'ring'|'amulet'|'potion'|'skillbook',
         slot, rarity, icon /*emoji*/,
         itemLevel, stats:{ str, dex, int, vit, def, armor, damageMin, damageMax, spellPower, maxHp, maxMana, critChance, hpRegen, manaRegen, moveSpeed, pierce },
         potion:{ heal, mana } (potions only), stack (potions), value,
         weaponKind:'sword'|'axe'|'mace'|'dagger'|'staff'|'bow'|'wand',  // ('spear' reserved for later, not itemized yet — §17.9
         skillId (skillbook only) }             // which skill this book teaches; unique-boss books are legendary-coloured
```
Only non-zero stats present. Rarity multiplies stats & adds affixes; names like "Rare Vicious Axe of the Bear". Skill
books are never merchant stock, and can be sold/bought back like any item. See §17.9 for weapon-kind itemization and
§17.11 for how skill books are obtained.

## 12. Input (input.js)
```js
export class Input {
  constructor()                  // attaches listeners
  update()                       // call once per frame BEFORE reading; polls gamepads, computes pressed edges
  moveDir() -> {x,y}|null        // orthogonal only; most recently pressed direction wins; WASD, arrows, D-pad, left stick (deadzone .5)
  analogMove() -> {x,y,mag}|null // left stick unit direction + push 0..1 for free movement (radial deadzone .22); null in deadzone.
                                 // `stickOverride = {x,y,mag}` forces it (testing hook)
  pressed(action) -> bool        // true only on the frame the action went down
  held(action) -> bool
  lastDevice: 'keyboard'|'gamepad'
  padStyle: 'xbox'|'playstation'  // set from the id of the gamepad producing input, whenever lastDevice
                                   // becomes 'gamepad'; PlayStation if id matches /dualsense|dualshock|playstation|054c/i
                                   // (the DualSense reports "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)").
                                   // Button MAPPING never changes — only ui.js label glyphs (see §17.1).
}
actions: 'skill1'..'skill4' (1-4 / gamepad A,X,B,Y → 1,2,3,4; the skill each slot casts is resolved live via
         `activeSkill()` — §9 — so which concrete skill A/X/B/Y triggers depends on equipped weapon + loadout, not a
         fixed name)
         'character' (C / gamepad Back/View or LB — from gameplay the pad opens whichever tab has unspent points, §13),
         'skills' (K — opens the Skills tab directly, §17.10; no pad button: LB then RB),
         'inventory' (I, Tab / gamepad RB), 'tab_prev'/'tab_next' (LB/RB, and Tab = tab_next — cycle window tabs;
         checked before character/inventory while a window is open), 'pause' (Esc, P / Start),
         'ui_up','ui_down','ui_left','ui_right' (arrows/WASD/dpad edges), 'confirm' (Enter/E / A), 'cancel' (Esc / B), 'drop' (Q/Delete / X),
         'potion' (5 / gamepad LT), 'mana_potion' (6 / gamepad RT) → drink items.js `activePotion(player, kind)`:
         the pinned stack if any, else the strongest stack of that kind (see §17.8b),
         'quick_equip' (R / Y, Bag only), 'pin_potion' (F / gamepad LT or RT, Bag only: pin/unpin focused potion),
         'rank_up' (R, =/+, Numpad + / Y, Skills tab only: spend a skill point on the focused skill),
         'salvage' (G / gamepad L3, Bag only: sell the focused item for gold — the non-mouse path to what
         Shift+Click already does, since gamepad/keyboard-confirm never carries a shiftKey)
```

## 13. UI (ui.js)
```js
export class UI {
  constructor(game, input)      // builds DOM under #ui, injects <style>
  update(game, dt)              // refresh HUD (cheap; only touch DOM when values change)
  toggleCharacter(); toggleSkills(); toggleInventory(); closeAll(); isModalOpen() -> bool
  openPendingPointsTab()        // HUD points badge + pad LB: Character if any attribute points (or none), else Skills
  handleInput(game, input)      // navigation inside open panels (gamepad/keyboard), called by main when modal open
  log(text, color)              // combat/event log (last ~6 lines, fade)
  banner(title, subtitle)       // big centered fading text (e.g. "Depth 3")
  showDeath(summary, onRestart) ; showPause(onResume) ; hidePause()
  showStart(onStart)            // title screen with controls help
}
```
HUD: HP orb/bar, Mana bar, XP bar with level, depth indicator, gold, 4 skill slots (icon/name/cooldown sweep/mana cost
resolved live via `activeSkill()`, §9) with key hint (show gamepad glyphs when input.lastDevice==='gamepad'), minimap
(draw map.explored/visible on a <canvas>, player dot, exits, enemies visible), potion counts, pending attr/skill point
indicator (routes to the Character tab for attribute points, the Skills tab for skill points). One pill shows both
counts ("✦ 2 attribute + 1 skill points to spend · C"); click / pad LB go to Character while any attribute points are
pending, else to Skills. The minimap's menu buttons are Character (C) · Skills (K) · Bag (I), each with a "+" marker
when that tab has points to spend.
Three tabs in one window — **Character | Skills | Bag** (LB/RB or Tab cycle all three, like the shop's Buy/Sell/Buyback):
- Character: attributes with + buttons, derived stats (now 3 damage rows: Melee / Ranged / Spell Power — §17.9; the
  role you aren't using shows dimmed "—").
- **Skills** (new, K opens it directly): left side = the 4 slot cards (skill in each, rank, cooldown, mana cost; the
  Attack card is labelled by the equipped weapon's class and also shows the other classes' current assignments);
  right side = known skills for the selected slot's category, eligible ones first, weapon-locked ones dimmed with
  "Requires {weapon}". Click/A assigns a skill to the slot; +/Y spends a rank point. See §17.10. This is the only
  place skills are ranked up (the Character tab no longer has a skills section).
  Navigation: up/down within a column (on the cards this also changes the selected slot), right/left between cards
  and list, A/Enter on a card enters its list, Y/R/+ on a card ranks up the skill in that slot. The Attack card's
  class row is a set of chips (hidden while only one weapon class exists); clicking one — or X/Q — switches which
  class's pick the list edits, so a class's assignment can be set while another weapon is equipped (§17.10).
  Weapon-locked rows can still be ranked up but not assigned.
- Bag: paperdoll equipment slots (off-hand shown locked + tooltip while a two-handed weapon is equipped, §17.9) +
  24-slot grid, rarity-colored borders, hover tooltips with comparison, click=equip/use, right-click or drop
  action=drop, shift-click=sell (to gold, "salvage"; also G / gamepad L3 on the cursor-focused cell, since
  Shift+Click has no non-mouse equivalent — `_salvageInvCell()` in ui.js is the single shared path for both).
  Full keyboard/gamepad navigation.

## 14. Renderer (renderer.js)
```js
export class Renderer {
  constructor(container)        // WebGLRenderer, scene, camera, lights, resize listener
  buildMap(map, depth)          // (re)build level geometry: floor tiles, walls (InstancedMesh), entrance/exit markers, torches; theme tint per depth
  update(game, dt)              // sync meshes to game.player / enemies / groundItems / projectiles (Map<obj.id, mesh>; create/remove as needed),
                                // lerp positions, facing rotation, hit flash, death anim, fog-of-war from map.visible/explored, camera follow
  render()
  spawnEffect(type, x, y, opts) // 'slash'(opts.dir), 'nova'(opts.radius), 'sweep' (Staff Sweep ring + hero swing), 'dash'(opts.from, opts.color),
                                //   'chain'(opts.points [{x,y}], opts.color — Chain Lightning arcs), 'blink'(opts.from),
                                //   'hit', 'death', 'levelup', 'heal', 'pickup', 'exit'
  floatText(x, y, text, color)  // rising fading damage numbers (DOM or sprite)
  shake(intensity)
  revealTile(x, y)              // hides one wall block + adds a door frame in its place, with a shimmer effect;
                                 // used when a hidden treasure-room door is discovered (§17.11)
}
```
Look: angled top-down perspective camera (~55–65° pitch) following the player smoothly; stylized low-poly; dark dungeon with warm
torchlight around player (PointLight following player) + cool ambient; walls are extruded blocks; unexplored = black, explored but not
visible = dim, visible = lit. Enemies/items only shown when their tile is visible. Target 60fps on big maps (InstancedMesh, few lights).

Textures (`js/textures.js`, renderer-owned): all procedural `CanvasTexture`s built once at startup (`getTextures()`, cached, ~0.5s),
light/neutral so the per-instance theme colour tints them; colour maps sRGB, normal/roughness maps linear, anisotropy ≤8.
- Floor: 512² flagstone atlas (2×2 cells of different stone layouts) + normal + roughness map. Per-instance `aCell` attribute picks a cell,
  the instance matrix is rotated by a random multiple of 90° (deterministic per tile/depth) → 16 looks per tile. Per-instance `aEdge`/`aCorner`
  wall masks drive fake ambient occlusion along wall-adjacent edges in the fragment shader (`onBeforeCompile`).
- Walls: material array on the box groups — sides use a brick-course texture with **world-space UVs** (continuous along a wall; baked AO band
  at the base), top face uses a separate cap-stone atlas (also `aCell` + random rotation).
- Instance colour = theme colour × small per-tile shade × fog state (HIDDEN = zero-scale matrix, DIM = lerp 55% to sky, LIT = full).
- Decor: wood-plank door jambs with iron bands, iron-bracket torches with additive layered flame + glow sprite (tinted `theme.torch`),
  soft blob contact shadows under player/enemies. Shared materials are flagged `userData.shared` so `_disposeDecor` skips them.

Character models (`js/models.js`, renderer-owned): procedural hero, every enemy shape (kobold / skeleton archer are variants
of goblin / skeleton), Slime King, Bone Tyrant and the merchant, plus their idle/walk/attack animations. Static parts sharing a
material are baked into cached vertex-coloured geometries (shared by all instances, never disposed); materials are always
per instance (hit flash / freeze tint). The hero's held weapon/off-hand mirror `equipment.weapon.weaponKind` /
`equipment.offhand.offhandKind` (unarmed falls back to a sword). Elites: gold floor ring + floating gold gem. Red stays
reserved for attack telegraphs, so no model uses red floor decals. Debug: `__dbg.modelGallery()` / `__dbg.clearGallery()`.

## 15. Events (bus)
`enemyKilled {enemy}` · `playerDamaged {amount, source}` · `playerDodged` · `playerDied` · `levelUp {level}` ·
`itemPickedUp {item}` · `goldPickedUp {amount}` · `depthChanged {depth}` · `skillUsed {skill}` · `statsChanged` ·
`potionUsed {kind:'heal'|'mana'}` · `denied` (no mana / no potion / bag full / can't afford) · `bossSlam` ·
`itemBought {item, price}` · `itemSold {item, price}` · `bossIntro {enemy}` · `bossPhase2 {enemy}` ·
`bossTelegraph {enemy, attack}` (a boss begins a telegraphed attack) · `skillLearned {skillId, isNew, rank}` (a skill
book was read) · `secretFound {x, y}` (a hidden doorway revealed) · `chestOpened {chest}`

## 16. Balance targets
- Depth 1 enemies die in 2–3 Cleaves; player survives ~8–10 hits from depth-appropriate enemies.
- Level ~1 per floor early. xpForLevel(L) ≈ 50 * L^1.5.
- Enemy stats scale ~12%/depth; elites (10%) ×2 HP, ×1.3 dmg, better loot. Boss every 5 depths.
- Enemy **count** scales with floor size, not just depth, since maps now grow with depth (§17.13/§17.16):
  `density(depth) = 1.36 + 0.065·(depth-1)` enemies per 100 populated floor tiles.
- Per level: +5 attr points? No — +3 attribute points, +1 skill point.
- Gear: base stats and value grow **every item level** (linear formulas in items.js). Attribute stats (str/dex/int/vit/def)
  keep one decimal so each level reads as an upgrade. Randomness (rarity, affixes, ±1 item level on drops) is welcome, but
  depth N+1 gear must be better *on average* than depth N.
- Potions deliberately stay in three tiers — Minor / Normal / Greater (depth 1-3 / 4-7 / 8+) with clearly different amounts.
  Do not convert them to a per-level curve.

## 17. Game design decisions (living notes)
Decisions made with the user while building. Keep this section current — when a design call is made, record it here.

### 17.1 Movement & controls
- Gamepad left stick = free analog movement (radial deadzone 0.22, speed ∝ stick push, top speed = 1 / moveCooldown
  tiles/s). Box collision (half-size 0.3) slides along walls **and along enemies** (movement is applied one axis at a
  time, so a blocked axis doesn't stop the other) — a corner assist eases the player into doorways/corridors (not
  applied when the thing ahead is an enemy).
- Pushing within ~40° toward an adjacent enemy holds position and attacks (slot 1, via `activeSkill` — §9); a clearly
  sideways push walks/slides around it instead, with no attack. If the player makes **zero** movement progress on
  both axes this frame while an enemy occupies the facing tile ("fully stuck" — typically a diagonal push in a
  1-wide corridor/doorway where the enemy blocks one axis and a wall blocks the other), that also counts as an
  attack. This replaces an earlier "brush-past" rule that attacked on any incidental collision-block regardless of
  aim; that fired on the ordinary "walk around an enemy" gesture (an accidental swing for melee, an accidental
  point-blank arrow for a bow) and was removed. Don't widen the 40° cone — that would effectively bring it back.
- Arcane Bolt and Spark (the caster shots) fire along the exact stick angle (`player.aim`); tile-based attack skills
  (Cleave, Bow Shot, Staff Sweep) and Dash use the nearest 4-way `facing`.
- Keys: 1-4 skills · 5 / LT health potion · 6 / RT mana potion (H/M are no longer bound) · C / LB character ·
  I, Tab / RB bag · E, Enter, Space / A
  confirm & **Trade** (near a merchant A trades instead of Cleaving) · U mute · Esc, P / Start pause.
  In the shop, Tab / I or LB / RB switch Buy / Sell.
- Character panel: D-pad / arrow left-right jumps between Attributes and Skills once per press (no auto-repeat).
  Start / P while any panel is open closes it and pauses; Esc / B only closes. Bag: Q / X drops, R / Y equips upgrades.
- Controller labels follow the pad in use: a PlayStation pad (id matches DualSense/DualShock/Sony vendor 054c) shows
  ✕ ○ □ △, L1/R1, L2/R2, Options, Create; anything else shows Xbox labels (A B X Y, LB/RB, LT/RT, Start). Same buttons,
  only the labels change.

### 17.2 Audio (audio.js)
- All sound is procedural Web Audio — no audio files. `sfx` singleton; `wireAudio(game)` maps bus events to sounds.
- Browsers only start audio after a key/mouse gesture; gamepad buttons don't count. The AudioContext is created at page
  load, so wherever the browser already allows sound (installed app, site allowed in browser settings, high media
  engagement) it runs with no click at all. Otherwise it unlocks on the first key/click. While locked: the title card
  shows a controller note (only if a gamepad is present) and the HUD shows "🔇 Click or press any key to turn on sound".
  Mute (U) persists in localStorage `dotm.muted`.
- Per-sound throttles and a voice cap keep multi-hits (Frost Nova on a crowd, 16-shot sprays) from stacking into one loud blast.
- Mix: SFX bus (0.8) → gentle compressor; music bus (0.42) sits well under it; both plus a shared procedural reverb go
  through a final limiter (−3 dB), then a mute gain. U mutes everything (music too).
- SFX are layered (transient + body + element colour: arcane shimmer, frost crystal pings, physical thud) with random
  pitch and noise offsets so repeats differ. Extras: soft footstep per tile moved (throttled), boss wind-up tone on every
  telegraphed attack (`bossTelegraph` bus event), shop-bell greeting when a merchant comes into trade range. Gold clinks
  scale with pile size; pickup chimes scale with rarity.
- **Music** (music.js, owned by `sfx.music`): procedural, scheduled ahead on the AudioContext clock by a setTimeout
  lookahead scheduler (0.3 s visible, 1.6 s hidden tab). A late timer skips the missed steps instead of piling them up.
  main.js calls `sfx.musicObserve(game, mode, modalOpen)` each frame (throttled to 150 ms). It starts by itself whenever
  the context is running, including when it's already unlocked at page load.
  - States: **title** (bright dorian) · **explore** (pads, bass drone, sparse bell motif with echo) · **boss** (own
    96 bpm drums + phrygian ostinato + dark pads; 110 bpm, denser drums and brass stabs in phase 2) · **death** (dissonant
    sting, then a low drone under the death screen). Boss kill plays a bright resolving sting, then explore returns.
    State crossfades take ~1-2.5 s.
  - Layers over explore: **combat** (soft kick/tom/shaker and a pulse bass) fades in while an aggro'd enemy (chase /
    attack / flee) is within 11 tiles, or on any hit / player damage / kill, and fades out 4 s after the last signal.
    **merchant** (music-box arpeggio, slightly warmer pads) plays within 6 tiles of a merchant when not in combat.
  - Depth: each depth number seeds its key, progression weights, motifs and tempo. Deeper = darker: dorian (1-3) →
    aeolian → aeolian/phrygian → phrygian (16+), root drops ~7 semitones, tempo 68 → ~56 bpm, pad low-pass 2300 → 850 Hz,
    fewer melody phrases, by depth 22 (same curve as §17.4b).
  - Long form: chords change every 2-3 bars along a weighted Markov walk that returns home every 4-6 chords. Every 2 bars
    the melody plays a motif, a variation (inversion, dropped notes, shifted rhythm), a wander over chord tones, or rests.
  - Ducking: music dips under the boss roar, level up, boss death and player death. Pause or any open panel low-passes
    (650 Hz) and dips the music.
  - Pause screen has a **♪ Music: On/Off** button (mouse only), persisted in localStorage `dotm.music`.
  - All tunables are named constants at the top of music.js / audio.js. `__dbg.music` shows the state, layer gains,
    scheduler stats, output RMS/peak and live node counts (music `nodes`, `sfxNodes`).

### 17.3 Save / continue (save.js)
- localStorage `dotm.save.v2` (versioned). Saves on entering every depth and on `pagehide` / tab hidden while playing.
- Persists the player (level, xp, points, gold, attributes, equipment, inventory, `skillState` — known skills + ranks
  + loadout, `bossesDefeated`, hp/mana) and run stats — never positions, timers or skill *definitions* (so a
  continued run always uses current balance numbers, not whatever was live when the save was written). Continue
  regenerates a fresh layout for the saved depth (including re-rolling which rooms are hidden treasure rooms — see
  §17.11). Death deletes the save.
- **v1 → v2: no migration.** There's nothing worth preserving across this format change; any v1 save found in
  storage is simply discarded, same as no save at all.
- Loading is forgiving: unknown skill ids in `known`/`loadout` (e.g. a skill later removed/renamed) are dropped,
  and any loadout slot that ends up unresolvable falls back to that slot/class's default — see §17.10's
  guaranteed-skill rule.
- Title screen: with a save → "Continue — Depth N · Level L" (default) and "New Game"; random keys don't start anything.

### 17.4 Merchant & economy (shop.js)
- A merchant stands on **every** depth, in a room kept clear of enemies (fallback: start room). No log line announces it.
  **Merchant room (Phase 2 addition):** map.js reserves the room itself (`generateDungeon` opts.merchant, main.js passes
  `isMerchantDepth`): `room.kind = 'merchant'`, picked the same way shop.js always did (a random 'normal' room from the
  half farthest from the entrance, straight-line), *before* treasure wings attach so a wing never hangs off it. The whole
  room gets no spawn candidates, is excluded from `populatedFloor`, and enemies.js's general placement (bat-swarm spill,
  boss/exit guards) refuses its tiles too. No normal room -> the start room hosts it (already spawn-free).
  `placeMerchant` uses `map.merchantRoomId`; its old pick only runs for maps generated without the flag.
  `MERCHANT_ENEMY_CLEARANCE` (3 tiles) stays as a harmless safety margin just outside the walls; treasure guards are
  exempt from it (they're in their own walled wing).
- Stock is fresh each depth and never carries over: health + mana potions (unlimited), 4 regular gear items and one
  **Featured** premium item, all at exact item level depth + 1. **Stock rarity steps up with depth**
  (`STOCK_RARITY_STEPS` in shop.js), at the first two boss milestones:

  | Depths | Regular gear floor | Featured | Featured one tier up (`featuredUpChance`) |
  |---|---|---|---|
  | 1-4 | magic | rare | epic, `0.05 + 0.02·depth`: 7% at d1 → 13% at d4 |
  | 5-9 | rare | epic | legendary, 15% at d5 → 23% at d9 |
  | 10+ | epic | epic | legendary, 25% at d10 → 45% at d20 (cap 50%) |

  Depths 1-4 are exactly the old stock (same RNG calls). The reason is the late-game gold surplus, see "Late-game gold
  surplus" below: the character's own loot outgrows a magic-floor merchant by ~depth 6, so the stock has to keep up
  with what is actually being worn or gold has nothing to go to.
- Enemies don't respawn, so gold can't be ground on a level. Intended tension: if you can't afford the Featured item,
  skip shopping and save for the next depth's merchant.
- Pricing: sell = value × 0.35 always. Buy: potions stay flat at value × 1.3 (`BUY_MULT`, §16 — never a per-level
  curve). Regular gear and the Featured item each get their own markup on top of that base (`regularGearPriceMult`/
  `featuredPriceMult` in shop.js, both multiplying `buyPrice`, i.e. on top of the 1.3): Featured `1.5 + 0.13·(ilvl-1)`,
  the "save up for it" pick; regular gear exactly **1.0 through item level 5** (the depth 1-4 stock — the part the
  treasure tiers fixed, left untouched) then `+0.05` per level (1.05 at depth 5, 1.8 at depth 20). Measured Featured
  price: ~220g at d3 / ~1.1k at d8 / ~2.9k at d15 / ~4.7k at d20, ~1-1.5 depths of income, affordable on arrival
  47% / 72% / 86% / 88% of the time (it was ~100% from d5 on before the fix below — no "save for it" tension left).
  *History:* the gear markup first shipped as `1.3 + 0.05·(ilvl-1)`; the 1.3 stacked on `BUY_MULT` (1.69× value at
  depth 1) and silently cut depth-1 "can afford anything" from 42% to 23% (d2 89% → 79%). Fixed to 1.0 at shallow
  levels; the balance test now asserts shallow gear costs exactly `buyPrice`.
- **Late-game gold surplus — root cause and fix (sim-measured, §17.17; 500 runs, explore 0.7).** Once the §17.14
  treasure tiers landed, gold on hand at the merchant reached ~4.2k at d10 / ~23.6k at d20 with ~0.6 purchases per
  shop. The first fix (the gear markup alone) only reached 3.6k / 19.6k. Investigation:
  - *Where the gold comes from* (d19, a non-boss depth): sold loot 1665 (54%), chest gold 1079 (35%), mob gold 334
    (11%). Boss depths add a spike (boss gold + its 3-5 rare+ items sold).
  - *Supply was never short.* The whole gear stock's price exceeded a depth's income at every depth (d10 ~2.4k vs
    ~0.9-1.9k, d20 ~6.3k vs ~3.1-4.3k). Buying everything would have gone broke. Tripling the regular slots by d20
    (4 + depth/2) only halved unspent gold (d20 18.3k → 9.5k) and it still grew ~1.2k/depth — *not* the dominant driver.
  - *Demand was.* By d6 the character already wore ~3.4 epic/legendary items of 7 (d10: 5.1, d20: 6.5), mostly from
    elites, Hoards/Vaults and bosses, while the stock was a magic floor at depth+1. Stock items that were an actual
    upgrade: 2.8 of 5 at d4 → 1.5 at d6 → 1.0 at d10 → 0.6 at d20. Gold piled up because nothing was worth buying.
  - *Fix:* stock rarity steps (table above), which restores demand at the source. Result vs. the committed-before
    state (gear markup only) and the original pre-markup baseline: gold on hand d8 1.9k/2.2k → **1.6k**, d10
    3.6k/4.2k → **3.1k**, d15 9.5k/11.4k → **5.5k**, d20 19.6k/23.6k → **9.3k**; gold left after shopping d10
    3.0k/3.8k → **1.6k**, d20 18.4k/22.9k → **6.3k**. The better yardstick is gold on hand measured in Featured prices
    (`onHandVsFeatured` in the sim): it was 3.1× at d5, 5.3× at d10, 7.5× at d15, 9.5× at d20 and still climbing;
    now **1.4-2.35× from d5 through d20**, i.e. the pile scales with prices instead of compounding. Items bought per
    shop 0.6-1.5 → 1.2-1.9, stock upgrades 0.6-2.0 → 1.5-2.7. Depths 1-4: identical to the pre-markup baseline (0
    drift, e.g. d1 "can afford anything" 42%, d3 95%, d4 100%).
  - *Cost:* gold now converts into power instead of sitting idle — the simulated character ends a bit stronger:
    melee +7-9% / defense +5-6% / max HP +4-8% at d10-20 vs before. Watch this in playtesting; the softer fallback is to
    drop the epic step (rare floor from d5 only), which the sim put at d20 unspent gold ~7.9k (vs 6.3k) and less creep.
  - *Rejected levers (sim-measured):* **trimming income** — even removing *all* chest gold from d5 on only got d20
    unspent gold to 8.9k and it kept growing ~1k/depth, because demand was the problem; cutting the sell rate to 20%
    got 11.6k *and* hurt depths 1-2 (d1 "afford anything" down another third, 25% → 16%). **Bigger stock** — above. **A reroll/reforge or
    respec gold sink** (README ideas) — respec is a one-off, not a recurring drain; reroll is an open-ended gamble
    whose drain is whatever the sim policy assumes (any "reroll until broke" policy reads as "fixed"), and affix
    magnitudes here are fixed by item level, so a reroll mostly reshuffles which stats — a good *complement* for later
    (it would soak the remaining ~1-2 Featured prices of savings), not the fix for "the merchant sells nothing I
    want". **More markup** — the first attempt; price doesn't create demand.
- **Buyback** tab (Buy / Sell / Buyback; LB/RB or Tab cycle all three): everything sold on the Sell tab lands there,
  newest first, at exactly what it sold for (no markup — a misclick safety net). Potion stacks come back whole.
  Capped at the last 12 sales (`MERCHANT_BUYBACK_CAP`, FIFO). Lives on the merchant (`merchant.buyback`), so it resets
  with the stock every depth (and on Continue). Bag shift+click salvage bypasses it.

### 17.4b Look & atmosphere
- The background/fog behind the map is each depth theme's sky colour blended (in sRGB) toward a deep dusk tone
  (`themeSky` in renderer.js), and it gets darker the deeper you go: slate blue at depth 1, charcoal around 15,
  near-black from ~22. Explored-but-not-visible tiles fade toward that colour too.
- Changing depth (stairs) fades the screen to **black** and back (`#fade` in index.html), never white.

### 17.5 Combat feel
- Every hit: white flash, visual recoil + squash away from the attacker. Knockback is an eased shove.
- Hit-stop freezes the whole sim briefly (crit 45ms, kill 60ms, boss hit 50ms, boss kill 150ms); input still registers.
- Camera shake: crit, boss hit, light on kills (shakes take the max, never stack). Crits: bigger popping numbers + sparks.
- Player hit: red screen-edge pulse scaled by damage fraction.
- **Aim assist** (`stats.autoAimAssist` = dex × 0.001, cap 0.20 at 200 dex): applies to **any** skill whose definition
  has `aimed:true` (§9) — at launch that's Arcane Bolt, Bow Shot, Volley and Spark. `assistAim()` in skills.js reads
  the active skill's own range rather than a hardcoded one, so it works for whichever aimed skill occupies whichever
  slot. On cast, the fire direction is blended by that fraction toward the closest living enemy within the skill's
  range, inside a 40° half-angle cone of the aim, and in line of sight. Only the initial direction is nudged (max
  ~8°) — the projectile then flies straight, no homing, so enemies can still sidestep. No target = fires exactly
  where aimed. Not a lock-on; keep it small. Character screen describes this to the player simply as "Improves Aim"
  (no skill name, no numbers); its icon is 🧭 (moved off 🏹 once Ranged got its own stat row — see §17.9).

### 17.6 Elements & resistances
- Damage has an **element**: physical, arcane, frost, fire, poison, lightning (fire/poison/lightning first used by the
  Phase 6 unlockable skills — Fireball, Glob Burst, Chain Lightning; still unused on gear). Skills are tagged with an element (Cleave physical, Arcane Bolt arcane, Frost Nova frost) — resistances
  never refer to specific skills.
- Status effects are separate keys: freeze, slow (future: burn, poison). Slow has a **strength** (`slowPct`, §10):
  applying a new slow only overwrites the current one if it's stronger (or equal but longer) — see `applySlow()` in §17.12.
- Enemy types may define `resist` per element/effect: positive = resist, negative = weakness. Always clamped to
  −75%..+80% — **nothing is ever fully immune**, and there are no blanket hard rules (e.g. no global "bosses can't be frozen").
- Hits that are notably resisted / super-effective are tagged on the damage number; bosses list weaknesses/resists on their HP bar.

### 17.7 Bosses
- Boss every 5th depth (Slime King 5, 15…; Bone Tyrant 10, 20…). Top-of-screen HP bar with a phase notch; intro banner + roar.
- Phase 2 at 50% HP: faster cadence (~25%) and an extra attack. Every attack is telegraphed on the ground (~0.7-1.0s)
  and dodgeable; hit checks use the player's free-movement position. All telegraphs use one readable red
  (`TELEGRAPH_COLOR`), never the boss's own colour, and lanes stop at walls.
- Slime King: Hop Slam (leaps onto a marked circle), Glob Spray (8-projectile ring, 16 in phase 2), Split into 3-4
  slimes on entering phase 2 plus occasional smaller splits after. Resist `{ physical: 0.25, frost: -0.3, freeze: 0.3 }`.
- Bone Tyrant: Bone Spears (3 fanned lanes, 5 in phase 2), Bone Charge (up to 5 tiles; then Dazed, +25% damage taken
  for 1s), Spiral + skeletons in phase 2. Resist `{ arcane: 0.3, physical: -0.25, fire: -0.2, freeze: 0.6, slow: 0.5 }`.
- Boss HP bar lists weaknesses/resists in element colours, e.g. "Weak: Frost · Resists: Physical".
- Guaranteed loot: at least one rare-or-better item (epic ~25-35%, legendary ~5-10%, rising with depth) plus a health potion.
- **Boss room is now a dedicated, per-boss-shaped arena, not whichever room the boss happened to land in** — see
  §17.15. Reaching the boss/its arena is optional, same as before: descending was never gated on the boss, and stays
  that way.

### 17.8 Item compare & quick-equip (Bag)
- `compareGear(item, player)` (items.js) simulates wearing the item via `recalcStats` on a copy of the player and diffs the
  stats you actually play with (melee avg, ranged avg, arrow pierce, spell power, defense, max HP/mana, crit, dodge, move speed, regen) — not raw
  affixes. Each stat's change is relative to its current value (with a floor so tiny bases don't explode).
- Verdict: **▲ Upgrade** (all gains, or mixed with net > +3%), **▼ Downgrade** (mirror), **↕ Trade-off** (mixed, within ±3%).
  Mixed-but-clear verdicts say "(with trade-offs)" in the tooltip. Two more (§17.9): **⇄** (a weapon of a different
  class — never ranked up/down) and `blocked` (an off-hand while a two-handed weapon is held: no badge, a 🔒 verdict
  line). A damage row that is `null` on either side (melee with a bow, ranged with a sword) is "not applicable" and
  skipped, never compared as a real 0.
- Shown as a corner badge on Bag cells and on shop **Buy** cells (not Sell), a verdict line in the item tooltip, and a
  live `now → after` preview (green/red) in the Bag's Gear Stats list for the hovered / gamepad-focused item.
- Bag's Gear Stats list = the Character screen's Derived list: all 12 stats, same order, both built from `DERIVED`
  (ui.js) — the only stat key list, so the two can't drift. No curated subset.
- **Quick-equip**: R / gamepad Y in the Bag, or the "▲ Equip upgrades" button, equips the single best ▲ item per slot.
  Click / A still equips one item.
- Character/Bag/Shop panels are laid out ~1000px wide and scaled up (never down, max 1.75×) to fit the window
  (`--dm-panel-scale`, measured from the panel's natural height).

### 17.8b Hotbar potion choice (5 / 6)
- Potion sizes never merge, so a bag can hold several health (or mana) stacks. 5 / LT and 6 / RT (and clicking the HUD
  slots) drink `activePotion(player, kind)` (items.js): the **pinned** stack if it's still in the bag, else the
  **strongest** stack (largest restore amount, then item level) — not bag order, so a better pickup is used right away.
- **Pin** = `player.activeHealPotionId` / `activeManaPotionId` (item id, persisted in the save; missing in old saves = unpinned).
  Use it to save big potions: pin the small stack and keep drinking it.
- UI lives on the Bag: potion cells use the compare-badge corner for a ☆ pin button (own click target, so click-to-drink,
  Shift+click salvage and right-click drop are unchanged). ★ gold = pinned (cell gets a gold ring); solid ☆ = the current
  auto pick; faint ☆ on hover = pinnable. Toggle with the ☆, F (hovered/focused cell) or gamepad LT / RT (the same
  triggers that drink). The item tooltip says which potion the key drinks first; the HUD slot tooltip does too.
- Pinned stack drained → pin moves to another stack of the same size if one exists, else clears (back to strongest).
  Dropped/sold pinned stack → stale id is ignored, same fallback.

### 17.9 Weapon kinds, classes & itemization
Two independent properties per weapon kind — never confuse them:
- **Hands** (1H/2H): controls only whether the off-hand slot can be used, and which item tier the weapon uses.
- **Role** → **class**: controls what slot 1 does and which attribute it scales with. A weapon's **class** is what
  slot-1 attack-choice memory (§17.10) keys off — not the exact kind, so e.g. swapping sword→axe doesn't reset your
  attack pick, only swapping to a different *class* (e.g. sword→bow) does.

| Kind | Hands | Role | Class | Default attack | Scales with | Off-hand |
|---|---|---|---|---|---|---|
| sword, axe, mace, dagger | 1H | Melee, physical | `melee1h` | Cleave | str | Allowed |
| *(unarmed)* | — | Melee, physical | `melee1h` | Cleave (fists) | str | Allowed |
| spear *(reserved, not built yet)* | 2H | Melee, physical | `melee2h` | Thrust | str | Locked |
| bow | 2H | Ranged, physical | `bow` | Bow Shot | dex | Locked |
| wand | 1H | Ranged, caster | `wand` | Spark | int | Allowed (orb, tome, shield) |
| staff | 2H | Melee, caster | `staff` | Staff Sweep | int | Locked |

Driven from a single `WEAPON_KIND_INFO` table in items.js (`{ bow: { hands:2, cls:'bow', role:'ranged', scale:'dex',
defaultAttack:'bowShot' }, … }`); character.js's damage-row split, skills.js's attack eligibility, the equip rules
below, and the held-weapon model all read from it — never hardcode a kind-by-kind check elsewhere.

**Damage rows (character.js):** a weapon's damage feeds only the row matching its own role, scaled by that class's
attribute × 0.8 (same factor as melee's existing `STR_MELEE_SCALE`) — `meleeMin/Max` for melee-role weapons (incl.
staff), `rangedMin/Max` for ranged-role weapons (bow, wand). A bow's damage no longer feeds `meleeMin/Max` (it used
to). Arcane Bolt's damage is computed in its own skill definition from spell power, not from `rangedMin/Max`.

**Two-handed itemization tier** (compensates for losing the off-hand): base stats ×1.5, +1 affix at every rarity,
price ×1.4 (set at the weapon-type level so shop Featured/buyback pricing follow automatically). Staff's spell power
must be ≥1.1× a same-level wand+orb combo, or wand+orb strictly dominates and staff never gets picked.

**Equip rules:**
- Equipping a 2H weapon while an off-hand is equipped needs one free bag slot (to hold the evicted off-hand); refuse
  with "Bag full: no room for your {off-hand}" if there isn't one. On success, log "{off-hand} unequipped (two-handed
  weapon)".
- Equipping an off-hand while a 2H weapon is equipped is refused outright ("Can't equip: {weapon} is two-handed") —
  it does not silently unequip the weapon.
- The off-hand paperdoll slot renders locked (with a tooltip explaining why) while a 2H weapon is equipped.
- `compareGear` for a 2H weapon compares "weapon + empty off-hand" against "current weapon + current off-hand", so
  the lost off-hand's stats are never invisible to the upgrade verdict.
- A melee↔ranged↔caster class swap never shows the ▲ upgrade badge — it shows a neutral **⇄** badge instead
  ("Switches your attack to {skill}. Two-handed: unequips {off-hand}.", lost off-hand stats shown in red in preview).
- **Quick-equip** (R/Y) only ever considers weapons of the currently-equipped weapon's *class* (sword→axe fine,
  sword→bow never auto-swaps), and skips the off-hand step entirely while a 2H weapon is equipped — this also avoids
  the weapon-then-offhand quick-equip steps undoing each other.

**Implementation notes (Phase 4 — bow):**
- `WEAPON_KIND_INFO` has real entries only for sword/axe/mace/dagger (`melee1h`) and bow. Any kind not in the table —
  at the time only **staff** (Phase 5 gave it an entry) — and unarmed use `FALLBACK_WEAPON_INFO` (1H, melee, str, `melee1h`, Cleave), i.e. staff keeps
  behaving exactly as before until Phase 5 adds its entry. skills.js derives `WEAPON_CLASSES` and
  `CLASS_DEFAULT_ATTACK` from this table + fallback (the old `KIND_CLASS` shim is gone), and the registry validator
  checks each entry's `defaultAttack` matches its class default.
- Bow rolls **no** baseline `spellPower` — decided as a pure dex weapon, to keep str/melee, dex/bow, int/caster a
  clean three-way split. The generic "of Power" affix can still roll `spellPower` onto a bow (or any weapon) as a
  random bonus, same as any other item — only the guaranteed base-stat entry was removed.
- A point-blank hit (§17.12) never crits: it uses the bottom of the roll, so the release crit is dropped for that hit.
- **Piercing** (bow-only prefix, `kinds:['bow']` on the affix): +1 `pierce` stat → `player.stats.pierce` → added to
  each Bow Shot arrow's existing projectile `pierce` field. Not shown as a Derived row, but counted by `compareGear`.
- The swap text names the class's *current* attack pick (`attackSkillForClass`), which skills.js registers into
  items.js via `setAttackSkillResolver` (items.js can't import skills.js without an import cycle).
- Saves from before bows were two-handed can hold bow + off-hand: Continue moves the off-hand to the bag
  (`enforceTwoHanded`), or drops it at the player's feet if the bag is full.

**Implementation notes (Phase 5 — wand/staff):**
- Adding a weapon kind = one `WEAPON_KIND_INFO` row (`wand: {hands:1, cls:'wand', role:'ranged', scale:'int',
  defaultAttack:'spark'}`, `staff: {hands:2, cls:'staff', role:'melee', scale:'int', defaultAttack:'staffSweep'}`) + its
  default attack in `SKILL_DEFS` + items.js data (`WEAPON_KINDS`, `ICONS`, `WEAPON_NAMES` tier names, a
  `weaponBaseStats` case) + a `buildHeld` case (models.js, plus a `_gripRest` angle) and a ground-loot case
  (renderer.js `_buildItemModel`'s switch) + a `skillUsed` sound in `wireAudio`. Everything else followed with no
  code change: character.js's damage rows (generic on `info.role`/`info.scale` — confirmed, no Phase 4 bug), the 2H
  itemization tier / price and equip rules (staff now evicts the off-hand, is refused with a full bag, locks the off-hand
  slot), `WEAPON_CLASSES`/`CLASS_DEFAULT_ATTACK`, the registry validator, the Skills tab class chips and "Requires
  {class}" dimming, compareGear's ⇄ swap and quick-equip's same-class rule.
- The fallback now only covers unarmed and unknown kinds (e.g. from a future/old save). `FALLBACK_WEAPON_INFO` is kept.
- **Spark** reuses Bow Shot's weapon-shot plumbing via a shared `rollWeaponShot(player, rank, rng)` (release roll off
  `rangedMin/Max` × rank, crit at release, `pointBlankDamage` = bottom of the roll), `applyDefense:true`, `ox/oy`, and
  main.js's existing `projectileHitDamage` at impact — no parallel mechanism. Projectile `kind:'spark'` (small bright
  elongated mote in renderer.js). Range 4 (+1 at rank 3; aim assist uses the ranked range). Because a wand's ranged row
  is mostly `int × 0.8` with a narrow weapon spread, Spark's point-blank floor is only ~5-10% under its average (e.g. 27 vs a 27-31 roll at L10, 25 int) — the
  penalty is real but mild for wands (bows have a wider spread). Tune `weaponBaseStats('wand')` spread if it should bite
  harder.
- **Staff Sweep** is Cleave's damage path (per-target `rng.range(meleeMin, meleeMax) × rank` → `computeDamage` → armor at
  hit, `source:'melee'`) over `SWEEP_OFFSETS` (the 8 neighbours) instead of an arc. Knockback vector = the tile offset
  (diagonals push diagonally); `damageEnemy` only moves it if the destination is free. Effect `'sweep'` (violet ring,
  radius 1.6, + hero swing).
- **Wand base stats** (1H, no tier mult): damage `1 + L×0.6` to `+1.5 + L×0.25` above that, spellPower `1.5 + L×0.7`,
  int `1 + L×0.4`. Wand and staff keep baseline spell power (they're the caster weapons — the Phase 4 "no baseline spell
  power" rule is bow-only).
- **Staff spell power raised** from `2 + L×1.0` to `3 + L×1.35` (then ×1.5 as 2H) to satisfy the ≥1.1× rule above.
  With the old formula a staff was only ~0.88-0.94× a wand + orb (~0.99-1.03× counting int). Now (common, before
  affixes) staff raw spell power
  `4.5 + 2.025L` vs wand+orb `3.5 + 1.6L` ≈ **1.27×** at every level; counting int (the Spell Power stat adds int × 0.8)
  staff ≈ 1.31-1.32× vs wand+orb and ≈ 1.18-1.22× vs wand+tome (the stronger combo once int counts). Covered for
  L1-60 by test/items.test.js via the exported `baseStatsFor(type, kind, lvl)`.
- Staff icon changed 🪄 → 🦯 (🪄 is now the wand). Saved items keep their generated icon, so Continue re-derives weapon
  icons from the current table (`refreshItemIcon`, main.js restore). A pre-Phase-5 save holding a staff + off-hand gets
  the off-hand moved to the bag by the existing `enforceTwoHanded`.
- Attack-skill tooltips only quote numbers while their own class is held (`heldBy` in skills.js) — with four classes
  a wand's ranged row was showing up as Bow Shot's damage, and a staff's melee row as Cleave's.
- Strength/Intelligence attribute descriptions now say which weapons they scale (str: sword/axe/mace/dagger; int: wand
  and staff damage).

### 17.10 Skill slots & the loadout system
Slots keep a fixed category (attack/spell/special/movement, §9) but which concrete skill occupies each one is
player-chosen from the skills they know, via the Skills tab (§13). Two layers, kept separate:
- **Weapon class decides which attack skills are *eligible*** for slot 1 (only `classes` matching the equipped
  weapon's class, §17.9).
- **The player decides which *eligible* skill is active**, and that choice is remembered **per weapon class**
  (`loadout.attack.bow`, `loadout.attack.melee1h`, etc.) — so re-equipping a bow always restores whatever you last
  picked for bow, with no manual re-selection after a weapon swap. The Skills tab can also set a class's assignment
  while a different weapon is equipped.
- Slots 2-4 aren't weapon-gated at all; their `loadout[category]` is a single global choice.

**Guaranteed-skill rule (permanent, not just a launch detail):** every slot must always resolve to a usable skill,
regardless of equipped gear or what's been unlocked. Every weapon class's default attack, and every category's
default (Arcane Bolt/Frost Nova/Shadow Dash), are always known — never behind an unlock. Any future weapon-restricted
skill in slots 2-4 (e.g. a hypothetical "requires a staff" spell) can only ever **add** an eligible option to that
slot — it can never be the slot's only option, since that would leave players without that weapon with nothing
usable. If a player's current assignment for a slot becomes ineligible (e.g. they picked a bow-only skill for the
attack slot, then equip a sword), that slot falls back to the new weapon/category's default; the assignment itself is
kept and comes back once eligible again. Enforced at startup (loud error if any class/category lacks an
unconditional default) and covered by a unit test, alongside `activeSkill()` resolution and `effectiveCooldown` math
(the README already flags these pure-math modules as worth testing).

**Ranks are per skill**, not per slot: `player.skillState.known[skillId]` tracks each known skill's own rank (1-5)
independently, so e.g. Cleave and Volley rank up separately even though both can occupy slot 1. Trying an
alternative skill therefore starts it at rank 1 even if your current pick is higher-ranked — accepted tradeoff, in
exchange for stronger per-skill identity; a skill/attribute respec (already on the README's idea list) is a natural
future pairing if this feels punishing in practice. **Attribute scaling stays tied to the slot's category** (§9's
table), not to the individual skill occupying it.

No cooldown penalty on swapping which skill occupies a slot — going into the Skills tab to change it is already
enough friction; each skill just keeps ticking its own independent cooldown (`player.skillCooldowns[skillId]`)
whether or not it's currently slotted.

### 17.11 Skill unlocking
No random enemy drops. Three sources, all via the `skillbook` item type (§11):
- **Boss-unique book**: guaranteed the first time a given boss type is killed **this run** (`player.bossesDefeated`,
  saved; since death deletes the save — §17.3 — this is inherently "once per run", not persisted across runs/deaths —
  that's a deliberately deferred, separate roguelite-progression feature, not built now).
- **Repeat kill of an already-defeated boss** (first possible at depth 15/20, since bosses only repeat every 5
  depths): a small chance (~20%) at a random book from the generic pool, and a much smaller chance (~3%) at another
  copy of that boss's own unique book.
- **Hidden treasure room chest**: a **concealment modifier applied to one Cache- or Hoard-tier treasure room**
  (§17.14), not a separate room type of its own. That room's single doorway (every treasure room is a purpose-built
  leaf with exactly one door, §17.14) starts as a wall tile flagged `secret` instead of a normal door; never applied
  to a Vault (a Vault's cost is its guards, not concealment — sealing guards inside it would be a softlock risk) and
  never to the start/exit/boss/merchant room. ~35% chance per depth from depth 2 on (~1 book every 3 depths). When
  the player is within 1 tile of the secret wall and it's in view, it reveals (via `renderer.revealTile`, §14) with
  a shimmer + sound + "You found a hidden passage." log line. That room's chest(s) additionally hold one random
  generic-pool book, on top of whatever its tier already grants (§17.14).
- **Duplicate books** (already known): give **+1 rank** instead of nothing (capped at 5) — otherwise duplicates,
  which will happen often while the generic pool is small, are dead weight.
- **Learning any brand-new skill also grants +1 free skill point** — softens the "boss reward arrives at rank 1 next
  to my rank-4 main skill" feeling without making boss-unique skills numerically stronger (which would just make them
  strictly-better rather than different).
- Books are tooltip-labeled with category + weapon requirement (e.g. "Attack · requires Bow") and can be learned
  (used) even without the required weapon equipped — they just show greyed out in the Skills tab until you equip it.

**Implementation notes (Phase 6):**
- Six unlockable skills (§9): generic pool Volley / Fireball / Chain Lightning / Blink (one per slot category, so no
  picker is ever empty once something is unlocked), boss-unique Glob Burst (Slime King) / Bone Charge (Bone Tyrant).
  Boss type ids are the `ENEMY_TYPES` keys (`slime_king`, `bone_tyrant`) — that is what `player.bossesDefeated` holds.
  The registry validator now also rejects a default that is marked unlockable.
- `learnSkill` already did new = rank 1 + 1 skill point / duplicate = +1 rank / refuse at rank 5 (Phase 2); unchanged.
  A max-rank book is **not consumed** (the log says it's mastered, the tooltip says "sell it").
- Skill book item: `createSkillBook` in items.js, icon 📕, value 60 + 4×lvl (generic) / 120 + 4×lvl (unique), `stats:{}`.
  Reading goes through `useItem` (Bag click / A). skills.js registers `setSkillBookHooks` (items.js can't import it).
- Boss drops ride the existing boss loot path: `rollLoot(enemy, depth, rng, { bossesDefeated })` appends the books
  after the guaranteed rare+ item and health potion; `killEnemy` then records the boss type and logs
  "{boss} dropped Skill Book: …".
- Treasure rooms, original Phase 6 version: previously any small room, 50% of depths, hidden-roll raised to 45%
  (`HIDDEN_ROOM_CHANCE`) as a workaround because only ~75% of layouts had a dead-end room to tag. **Superseded by
  §17.14**: treasure rooms are now purpose-built leaf wings, so every depth that rolls one gets a genuine single-door
  dead end by construction — the 45% workaround no longer applies. `HIDDEN_ROOM_CHANCE` reverts to the originally
  intended **35%**; leaving it at 45% after wings guarantee dead ends would have silently pushed book pacing ~29%
  faster than designed (caught during the §17.14 design pass, not by a live bug). Hidden rooms get no spawn
  candidates, and main.js removes any enemy standing in one before applying the modifier.
- **Built (Phase 2):** `HIDDEN_ROOM_CHANCE = 0.35`, `TREASURE_ROOM_CHANCE` removed. The modifier rolls once per depth
  from depth 2 and picks one Cache/Hoard wing that is a verified dead end; measured 34.1% of depths over 6000 floors
  (the ~3% shortfall is depths whose only wing is a Vault). A hidden room gets no guards; its first chest adds the
  book via items.js `rollChestContents(..., {hidden:true})` (skills.js registers a `randomGeneric` book hook).
- Reveal: checked in `onPlayerMoved` after FOV — Chebyshev distance ≤ 1 from the player's tile and `map.visible`.
  `renderer.revealTile` works because buildMap gives each unrevealed secret a hidden floor slab up front (an
  InstancedMesh can't grow); reveal drops the wall instance, shows the slab, adds the door frame, gold ring + motes.
- Chest: **deviation** — `models.js` had no standalone chest, only a tiny one baked into the merchant's rug; `buildChest()`
  is a full-size version of that same design (wood box, iron bands, rounded lid on a hinge that swings open, gold latch,
  soft glow while closed), turned to face the doorway. It's a `{type:'chest', opened}` NPC; `nearbyChest` (shop.js,
  next to `nearbyMerchant`) + confirm opens it; the HUD prompt reads "Open — E / A". `dropLoot` now never places an
  item on an NPC's tile, so the book lands beside the chest (and is picked up at once if that's the player's tile).
- Glob Burst's ring is axis-aligned (not randomly offset like the King's alternating ring): with a random offset,
  enemies straight out from the player sat between spokes, which felt broken on a tile grid.
- New sounds (procedural, audio.js): one per new skill, a Fireball burst, hidden passage (stone grind + chime), chest
  open, skill learned.

### 17.12 Combat: armor on weapon shots, point-blank, and slow strength
- **Weapon-role projectiles** (Bow Shot, Volley, Spark — Spark is `element:'arcane'` but still a weapon attack) set `applyDefense:true` and are reduced by the target's
  defense at hit time, the same formula as a melee hit (`× 100/(100+def)`) — consistent with "physical/weapon damage
  is mitigated by armor, spells bypass it" (§17.6). Damage and crit are still rolled at *release* so the crit feel
  stays there; only the defense reduction (and point-blank check, below) happens on impact. True spells (Arcane Bolt,
  a future Fireball) keep `applyDefense:false` and bypass armor — that exception is now reserved for spells specifically,
  not "anything ranged".
- **Point-blank penalty**: a weapon-role projectile that hits within `POINT_BLANK_RANGE` (~1.5 tiles) of where it was
  fired (`ox,oy`, §6.1) uses `pointBlankDamage` (the bottom of that weapon's damage range) instead of its rolled
  damage, then applies defense as above. Applies identically whether the shot came from walking into an adjacent
  enemy, an aimed-push, the "fully stuck" rule (§17.1), or pressing the skill key at close range — trigger method
  never matters, only distance. Feel: duller hit sound + smaller grey damage number.
- **Slow gets a strength value** (`enemy.slowPct`, §10) instead of the old on/off timer: `applySlow(enemy, pct, dur)`
  only overwrites the current slow if `pct` is stronger, or equal and `dur` is longer — so a weaker slow can never
  interrupt/shorten a stronger one already active. Resistance keeps shortening *duration* as it already does
  (`applyResist`), not strength. Frost Nova stays 50% (unchanged); Bow Shot's rank-3 perk applies ~20-25% for ~0.6s —
  deliberately much weaker than Nova, with room left above the bow for a possible future "Cripple" skill. Global cap
  75% (§17.6's "nothing is ever fully immune").
- Implementation notes (Phase 3): `applySlow` / `MAX_SLOW_PCT` live in enemies.js and apply the `'slow'` resist to the
  duration *before* the stronger/longer comparison; the timer running out resets `slowPct` to 0. The armor formula is
  one shared helper, `reduceByDefense()` in character.js (used by `computeDamage`, `mitigate`, and projectile hits);
  `projectileHitDamage(pr, hitX, hitY, def)` + `POINT_BLANK_RANGE` (1.5, inclusive, straight-line from `ox,oy`) resolve
  a projectile hit. A weapon shot with no `pointBlankDamage` just uses `damage` up close. main.js passes
  `opts.pointBlank` to `damageEnemy`: a point-blank hit shows a smaller (12px) grey number, plays `sfx.hit(..., dull)`
  (a quiet muffled thud) and never crits. Phase 4 changed the distance check to use the target enemy's tile, not the
  projectile position (see §6.1) — otherwise every 2-tile shot counted as point-blank.
  "Fully stuck" (§17.1) uses the 4-way `facing`, so in a diagonal wedge it only attacks when the push is at least as
  much toward the enemy's axis as toward the wall (push mostly into the wall = facing the wall = no attack).

### 17.13 Map variety & archetypes
Maps were structurally uniform: every depth drew from the same fixed size mix (S18/M44/L38), the same shape weights,
a compact/blob-shaped topology (parent rooms weighted `1/(1+links)`), and a fixed 25% loop fraction — depth only
changed room *count*, not *feel*. Fixed by making those constants per-depth instead of global.

- **Archetype** (`map.archetype`, picked per depth, never repeating the previous depth's): sets size mix, shape
  weights, corridor-gap distribution, loop fraction, and the parent-weighting function. All of the base growth
  algorithm (§7) is unchanged — an archetype only swaps which constants it's called with.

  | Archetype | Size mix S/M/L | Shapes favored | Topology |
  |---|---|---|---|
  | **Halls** | 18/44/38 (today's) | today's catalog, evenly | today's baseline blob |
  | **Catacombs** | 45/45/10 | rect, cross, T | cluster mode ~40% (below), 50% shared-wall gap, 35% loops; rooms stay ≥5×5, still not a maze |
  | **Caverns** | 10/40/50 | cave, cavern ~60% | 45% shared-wall gap, more 2-wide corridors |
  | **Keep** | today's | rect, pillars, ring hall, gallery | 15% loops, a grand seed room (below) |
  | **Wings** | today's | today's | parents weighted toward the *deepest* spanning-tree nodes (long branches instead of a compact blob); gap 5-12; 15% loops — produces long walks and natural treasure-wing pockets |

- **New room shapes** (masks inside `makeShape`; `canPlace`/`placeRoom`/`connect` handle any mask already, so these
  are additions to the shape catalog, not new placement logic):
  - **cross / T**: centred overlapping rectangles.
  - **octagon**: a rectangle with 2-3 tile chamfered corners.
  - **gallery**: 3-5 × 14-22, a long hall — breaks the "everything is roughly square" pattern.
  - **ring hall**: a large rectangle with a solid 3×3+ core. Needs one guard: the core tiles must be marked in the
    shape (like `pillars` already marks its single-tile pillars) so `doorSlots` never offers a core-wall tile as a
    door slot.
  - **split hall**: a partial dividing wall with 1-2 gaps — incidentally gives ranged builds (§17.12) real cover.
  - **cavern**: cellular-automata blob, largest connected component kept, with enough straight edge that `doorSlots`
    still finds a 3-tile straight run to place a door on.
- **Cluster mode**: during growth, after placing a small room, a chance to keep attaching more small rooms *to it*
  at gap 1 — reuses `placeRoom`/`connect` unchanged, produces cell-block/crypt-row/barracks-suite groupings.
- **Landmark seed room**: on non-boss depths, the first room (placed near the map centre, §7) can roll "grand"
  (20-26 × 14-20, ring or pillars) instead of the normal size roll, giving the floor a recognisable centrepiece. On
  boss depths the seed room is the boss arena instead (§17.15) — the two are mutually exclusive per depth.
- **Room count**: base curve raised to `min(22, 11 + floor((depth-1)*0.6))` (§7) — confirmed headroom: 24-28 rooms
  place at 100% success within the existing 86-tile generation cap, cropping to ~81-82 tiles, ~2ms per map.

**Implementation notes (built — archetypes, shapes, cluster mode, grand seed, room count; §17.14/§17.15 not yet):**
- **No-repeat mechanism:** `generateDungeon` stays pure, so it can't remember the last floor itself — it takes
  `opts.prevArchetype` (main.js passes the outgoing `game.map.archetype`) and `pickArchetype(rng, prev)` draws
  uniformly from the other four. After a save/continue the restored depth has no "previous" in memory, so a repeat
  across that one boundary is possible (the archetype isn't saved; not worth a save-format change).
- **Table interpretations** (the table doesn't pin these, so they're choices, recorded here): "Halls/Wings — today's
  catalog, evenly" is read as the *full* post-§17.13 catalog at even weights (otherwise octagon and split hall would
  never appear anywhere). "Favored" shapes take a share of each size category's roll: Catacombs rect+cross 75%,
  Keep rect/pillars/ringHall 2 : gallery 1 at 75% (gallery at equal weight made 1 in 4 Keep medium rooms a gallery),
  Caverns cave+cavern 72% of the medium/large roll, which lands ~57-60% of all Caverns rooms since small rooms can't be
  caves. Unstated values: Wings shared-wall chance 20%; Caverns 2-wide corridor chance 60% (vs 30%); grand seed chance
  20% on non-Keep archetypes, 100% on Keep (always off on boss depths).
- **Shapes & size classes:** small = rect/cross; medium adds Lshape/overlap/cave/octagon/gallery/splitHall/cavern;
  large adds pillars/ringHall; grand = ringHall/pillars. "cross / T" is one shape id, `cross` (a T is its variant),
  matching §7's id list; the old internal `'L'` id became `Lshape` to match too. Galleries keep the rolled size label
  (medium/large) for link caps. `'grand'` rooms use the large link cap/targets and are excluded from start rooms.
- **Core tiles** (the ring-hall guard): every shape carries `core` — its ring-hall centre, split-hall divider, and any
  enclosed rock found automatically (pillars, cavern islands). A `reserved` grid marks them on placement; doorSlots,
  corridor validation, corridor widening, stair cubbies and other rooms' placement all refuse reserved tiles.
- **Cavern:** ellipse-biased noise, 4 CA passes, spike trim, largest 4-connected component, 0-2 small rock islands;
  rejected unless it fills ≥45% of its box and has a door slot facing all four ways (12 tries, then falls back to
  `cave` — ~0-6% of rolls, medium boxes being the tighter case).
- **Cluster mode:** on trigger, 2-4 more small rooms at gap 1, each attached to the newest cluster member (70%) or a
  random one that still has link room — the small-room link cap of 2 means "all attached to the first room" could
  only ever add one, so the cluster grows as rows/branches instead.
- **Wings parent weight:** `(1 + treeDepth)²`. Measured effect is modest (~+10% entrance-to-exit walk vs Halls at
  equal canvas size) because the unchanged link top-up pass re-joins neighbouring branches; revisit if Wings doesn't
  read as "long branches" in play.
- **Measured** (1200 floors, depths 1-30): 99.8-99.9% of floors place the full room count (the rare miss is a
  wide-gap Wings layout); generation p50 ~1.7 ms, p99 ~8 ms. Side effect on §17.11's hidden room: more rooms mean more
  dead ends, so hidden rooms now land on ~38% of depths (was ~33%) and any treasure room on ~62% (was ~54%) — left
  alone since §17.14 replaces this selection anyway.

### 17.14 Treasure tiers: Cache / Hoard / Vault
Replaces the single flat "one treasure room" concept (the original, pre-tier Phase 6 version, §17.11) with three
tiers, so treasure rooms vary in richness and difficulty instead of all being the same reward. **Exactly three
tiers** — item-level offsets only move in whole levels (±1-2), so a 4th tier would sit under one item level from its
neighbor and be indistinguishable to the player.

| | **Cache** (low) | **Hoard** (medium) | **Vault** (high) |
|---|---|---|---|
| Room | new small room (leaf) | new medium room (leaf) | new large room (leaf), optional antechamber from depth 6 (below) |
| Route | leaf off any non-start/boss/merchant room | leaf off a room in the more-off-path half by BFS detour from entrance | leaf off a room in the top third by detour, far half from entrance |
| Chests | 1 | 1-2 | 2-3 |
| Items/chest | 1 | 2 | 2-3 |
| Item level (`generateItem`'s `opts.itemLevel`, not a shifted `depth`) | depth − 1 (clamped ≥1), ±1 jitter | depth, ±1 jitter (same as a normal mob drop) | depth + 1..2, no downward jitter |
| Rarity | normal roll | `opts.elite: true` | `opts.elite: true` + one item per chest at `opts.minRarity: 'rare'` |
| Gold | `int(10,20)·depth` | `int(20,40)·depth` (today's `seedTreasure` amount) | `int(40,70)·depth` |
| Extras | — | 50% chance of a potion | 1 guaranteed potion |
| Guards (§17.16 budget, not on top of it) | `int(0,2)`, depth-level, default ~10% elite | `int(2,3)`, depth-level, 25% elite | `3 + floor(depth/8)` capped at 6 + 1 guaranteed elite "Vault Warden", depth+1 level — **all from the current depth's own enemy pool, never a next-depth preview** |
| Minimum depth | 1 | 1 | 3 |

**Why `opts.itemLevel`, not a shifted `depth` argument:** shifting `depth` moves the legendary-rarity gate too
(`depth < 4` zeroes legendary weight) and barely moves rarity odds anyway (`depthFactor = depth/20`, so +2 depth is
only +0.1 to that factor) — `opts.itemLevel` isolates "how good is the gear" from "how good is my luck," which is
what a tier should control.

**Tier spawn weights drift with depth** the same way rarity odds already do: `t = clamp((depth-1)/19, 0, 1)`, Cache
60%→40%, Hoard 30%→40%, Vault 10%→20%. **At most one Vault per depth**, so it stays an event, not a routine stop.

**Room count per depth** (max rooms that can roll, independent of tier): `min(5, round(5·(1-e^(-depth/4))))` — 1/2/3
at depths 1-3 (matches the user's own anchor points exactly), saturating at 5 by depth 10 rather than growing
linearly forever. From depth 2 the first slot always fills; each additional slot beyond the first fills at 50%.

**Loot volume is a deliberate ~2x increase from depth 3 on** (confirmed intentional — addresses "can't afford
anything at the merchant early," §17.4): treasure items roughly matched mob-drop item count under the richer
version (e.g. depth 10: ~7.4 treasure items vs ~6.0 mob-drop items), vs. the old single-treasure-room baseline of
~1.25 items/depth regardless of depth. The 24-slot bag and per-depth merchant (§17.4, `MERCHANT_DEPTH_INTERVAL = 1`)
are the pressure points to watch if this turns out to be too much — the fix is trimming Hoard/Vault items-per-chest,
not the item-level anchors.

**Gold amounts deliberately left as-is** despite the late-game gold surplus they feed (chest gold is ~35% of income
at d19, sold loot ~54%, §17.4). Trimming them was measured and rejected: even zero chest gold from depth 5 on left
d20 with ~8.9k unspent gold, still growing ~1k/depth, because the surplus came from the merchant having nothing worth
buying, not from too much income — fixed on the demand side instead (§17.4 stock-rarity steps). Early depths depend
on this gold (d3 chest gold is ~47% of income; "can afford anything" at d3 is 95% with the tiers vs 74% without).

**Vault antechamber** (from depth 6, 50% of Vaults, only when placement succeeds — otherwise a plain single-room
Vault): a medium guard room attached as a leaf of the parent, with the Vault itself a leaf of the antechamber (two
doors total, still never touches any start-to-exit path). 60% of the Vault's guards wait in the antechamber, the
warden + the rest wait by the chests. Makes a Vault's difficulty about the *route* (fight, then loot) rather than
fighting inside the loot room. Capped at 2 rooms/depth, only on depths that already rolled a Vault.

**Hidden-room interaction:** see §17.11 — hidden is a concealment *modifier* applicable to one Cache or Hoard (never
a Vault), not a 4th tier. A Vault book chance was considered and rejected: it would add only ~10% more total books
(too small to register as a reward) and blur a cleaner identity — books come from secrets and bosses, gear comes
from Vaults (full audit in §17.11's implementation notes).

**Implementation split, from `main.js` into pure functions** (needed for §17.17's simulation harness, and generally
better factoring): chest-content rolling (`seedTreasure`/`openChest` today) moves to something like
`rollChestContents(tier, depth, rng)` in items.js; tier guard spawning joins `spawnEnemies`.

**Implementation notes (Phase 2 — built):**
- map.js: `treasureRoomSlots`, `treasureTierWeights`, `rollTreasureTiers` (sorted Vault → Hoards → Caches),
  `rollChestCount`; items.js: `CHEST_LOOT`, `treasureItemLevel`, `rollChestContents(tier, depth, rng, {first, hidden})`;
  enemies.js: `treasureGuardPlan`, `enemyPoolForDepth`; guards spawn inside `spawnEnemies`. `seedTreasure` and the
  floor-scattered loot are gone; all treasure is in chests, rolled when opened.
- **Interpretations** (the table doesn't pin these): depth 1's single slot fills at 50% (the spec only guarantees the
  first slot "from depth 2"; 50% is also the old flat treasure-room odds). Gold and the potion roll are per *room*, so
  they go in the room's first chest; items/chest applies to every chest. Vault guards other than the warden use the
  default elite rate. The warden is named "Vault Warden (<type>)" and waits nearest a chest; guards never stand on
  a chest's four sides unless nothing else is free (in play, guards could otherwise box a chest in). Potions are 65%
  health, like mob drops.
- **Routes:** each tier tries its pool, then looser ones if nothing there takes a leaf: Vault = top third by detour ∩
  far half by entrance distance → top third → off-path half → any; Hoard = off-path half → any; Cache = any.
  Parents are 'normal'/'exit' base rooms (never start/boss/merchant/another wing); unused parents and parents under
  their link cap are tried first. Measured over 6000 floors: Vaults 83% strict / 93% top third; Hoards 98% off-path half.
- **Antechamber:** attempted up to 4 times (each rolled back via a full carve snapshot if its Vault then fails), else a
  plain Vault. Placement: Cache 100%, Hoard 99.5%, Vault 98.3% of rolls; antechamber 89.5% of rolls (3000 floors).
- **Realized Vault share** is below the nominal weight because of the one-Vault cap (e.g. depth 20: 15.8% of treasure
  rooms vs the 20% weight) — the cap was written into the spec, so this is expected, not tuned away.
- **Guards are on top of the general count**, which §17.16 (Phase 4, built) now sets as `density × populatedFloor`
  (already excluding the wings).
- Generation: p50 ~2.1 ms, p99 ~9.5 ms (was ~1.7 / ~8 before wings). Maps can now reach 90 tiles (was 86) when a wing
  sits on the edge.

### 17.15 Boss arenas
**Confirmed real, not a one-off complaint:** measured over 1000+ generated layouts, depth 5 (Slime King's first
appearance) put the boss in a room with less than an 80-tile floor 34% of the time, and a *small* room 12% of the
time — because the boss room was picked as "the largest bounding box among the far third's still-normal rooms," a
pool that's sometimes just 1-3 rooms, with no minimum-size floor and no protection against pillared/cave/L-shaped
rooms whose actual clear area (excluding pillars/cave irregularity) is much smaller than their bounding box.

**Minimum arena requirements, derived from the boss's own attack numbers (§17.7), not guessed:**
- Glob Spray's 16-projectile phase-2 ring only spreads to a dodgeable ~2 tiles between projectiles around radius
  ≥5 — the player needs ~5-8 tiles of standoff room.
- Hop Slam's radius-1.8 telegraphed circle needs ~2.5 tiles of clear floor around the player to sidestep.
- Bone Spears' ±50° (phase 2) fanned lanes are ~7 tiles long and nearly touch each other by distance 4 — the player
  needs either lateral room to step between lanes or >7 tiles of distance.
- Guards/summons (2-4 normal-boss guards, 3-4 Slime King splits, 2-3 Bone Tyrant skeletons) all share the room, so
  it can't just be sized for a 1v1.
- **Minimum: 16×13 interior (≥180 floor tiles), with a clear core of ≥9×9** (no pillar within 4 tiles of the boss's
  spawn point) — holds the player ~7 tiles out with room to still move laterally. Today's existing "large" size
  category (12-18×10-14, §7) can fall under this, which is why arenas need their own size class rather than a tag
  bolted onto the existing large-room roll.

**Placement: the boss arena is the seed room** (§7's first-placed room, near the map centre) on boss depths, instead
of being searched for afterward. A room placed first on an empty canvas always fits — this is why arenas don't use
the leaf-wing mechanism §17.14 uses for treasure (a first-placed room can't fail to place the way a late leaf can).
Its link cap is 2 with doors on opposite short ends, so the rest of the level grows outward from both sides. The
start room is then picked from the third of rooms farthest from the arena (as today), and exits exclude the arena
room — so the arena still ends up far from where the player enters, just now guaranteed to be properly sized.

**Per-boss arena shapes** (`BOSS_ARENAS` table in map.js; `bossForDepth(depth)` moves from enemies.js to core.js
since map.js may only import from core.js, and both enemies.js and map.js need to know which boss a depth has):
- **Slime King — "Sump":** a round open cavern, smooth ellipse ~17-19×15-17, open centre. A few isolated pillar
  islands sit ≥6 tiles from centre as cover, not obstruction. Radius ~8 roughly matches Glob Spray's range, so the
  ring's danger reads consistently no matter which direction the player retreats.
- **Bone Tyrant — "Ossuary Hall":** a long hall, ~20-24×13-15, with a two-row colonnade 3 tiles in from each long
  wall and a clear central aisle. Length gives room to outrun the 7-tile spear lanes; the pillars are tactical using
  behavior that already exists — spear lanes stop at walls, and Bone Charge hitting a pillar ends the charge early
  and applies Dazed (+25% damage taken, §17.7) the same as missing a charge normally does. Baiting a charge into a
  pillar becomes a real, learnable play, not new mechanics.
- **Future bosses:** each gets one `BOSS_ARENAS` entry; a generic fallback (17×15 rectangle, clear core) covers any
  boss without a custom entry yet.
- **Population:** the arena is excluded from general spawn candidates — only the boss and its 2-4 guards spawn
  there. Treasure wings never attach to it. Tagged `room.kind = 'boss'`, `room.arena = bossTypeId` (§7) as the hook
  for a future visual/theming pass — deliberately not built this pass (no textures/graphics work, per the original
  brief). `room.size` stays `'large'` so existing size-based logic elsewhere keeps working.
- **Reaching the arena stays optional** — descending was never gated on the boss (`descend()`), and stays that way.

**Implementation notes (Phase 3 — built):**
- core.js: `BOSS_DEPTH_INTERVAL`, `isBossDepth(depth)`, `bossForDepth(depth)` (was enemies.js `pickBossId`; same
  mapping on boss depths, and it now returns `null` on non-boss depths). map.js: `BOSS_ARENAS`, `GENERIC_ARENA`,
  `ARENA_MIN`, `ARENA_LINK_CAP`, `ARENA_SHAPES`, `arenaSpec`, `makeArenaShape(rng, bossId)`, `arenaStats(shape)`,
  `arenaMeetsMinimum(shape)`, `arenaDoorSides(shape)`.
- **Shape ids:** `room.shape` is `'sump'` / `'ossuaryHall'` / `'arena'` (generic). `room.arena` is always the boss type
  id, including on the generic fallback (the shape id tells you whether a custom entry was used).
- **Ossuary Hall colonnade breaks at the centre (deviation):** a 13-15 wide hall with pillar rows 3 tiles in from each
  long wall puts every pillar 3-4 tiles from the centre row, which is inside the required clear 9x9 core. The core
  requirement is the hard minimum, so the colonnade leaves a 9+ tile open crossing at the centre. Pillars (a pillar
  every other tile) stand only in the two end bays, at least 5 tiles from the boss's spawn point. The central aisle
  between the rows and the 3-wide side aisles are kept as specified.
- **Sump:** a smooth threshold ellipse (17-19 x 15-17), plus 3-4 single or 1x2 rock islands 6-6.8 tiles out on the four
  diagonals, so none stands in front of an end doorway. Each island has a full ring of open floor. Measured floor is
  201-252 tiles (p50 ~220); the clear core is always radius 4.
- **Every arena shape is validated:** it is rebuilt until `arenaMeetsMinimum` holds (box, floor, clear-core radius >= 4
  around room.cx/cy, and a door slot on each short end). The generic rectangle is the last resort (0 fallbacks in 10k
  rolls).
- **Doorways:** the arena carries a link cap of 2 and its door slots are limited to the two long-axis ends, one
  doorway per end. Right after placement, one room is grown off each end before normal growth starts. Measured over
  2400 boss floors: every arena got 2 links, always on opposite ends. Loops and link top-ups can't add more.
- **Room count:** the arena is one room *on top of* the base count (`targetRoomCount(depth) + 1` on boss depths), as
  §7 says, so a boss floor keeps the same number of populated rooms as a non-boss floor.
- **Start room:** the old code did *not* pick the start room "from the third farthest from the boss". It picked a random
  non-large room, and the boss room was chosen later from the far third of the exits' distance ranking. So on boss depths
  the start room is now a random small/medium room from the third of rooms farthest (BFS walking distance) from the
  arena, falling back to the farthest small/medium room (2399/2400 floors used the far third). Non-boss depths are unchanged.
- **Population:** the arena is excluded from `populatedFloor` and `spawnCandidates`, and general spawns (incl. bat
  swarms, exit sentries) keep out of it. The boss spawns on the arena centre; its 2-4 guards are placed only on arena
  tiles and carry `enemy.bossGuard = true`. Since §17.16 (Phase 4) they are on top of the general count (before, the
  general fill loop counted them against its total).
- **Measured** (12,000 floors, depths 1-30, 400 seeded runs): 0 failures on minimum size / clear core / shape-per-boss /
  doors / wings / stairs / merchant / spawn / reachability. Grand seed rooms unaffected (36% of non-boss depths, 100% of
  non-boss Keep depths). Generation p50 2.2 ms / p99 ~10.7 ms overall; boss depths p50 2.5 ms / p99 ~13 ms (+0.4 ms
  p50 vs before: one extra room plus the arena).

### 17.16 Enemy density scales with floor size, not just depth
`computeSpawnCount(depth)` (enemies.js) used to depend only on depth, which made sense while every floor was
roughly the same size — but §17.13/§17.14/§17.15 all make floors bigger, so a depth-only count would spread thinner
as maps grow. Measured implied density on today's layouts (enemies per 100 floor tiles, excluding the start room):
depth 1 ≈ 1.39, depth 5 ≈ 1.71, depth 10 ≈ 1.87, depth 20 ≈ 2.59 (a curve that was already implicitly drifting
upward, just never made explicit).

**New formula:** `count = round(density(depth) × map.populatedFloor / 100)`, where `density(depth) = 1.36 +
0.065·(depth-1)`. `map.populatedFloor` (§7) excludes treasure-wing rooms and the boss arena, which get their own
guard counts instead (§17.14/§17.15). On today's (pre-§17.13) layout sizes this formula reproduces today's counts
within ±2, preserving the §16 "2-3 Cleaves per kill, survive 8-10 hits" calibration — it only diverges as floors
actually get bigger. Confirmed target numbers at the new floor sizes: depth 10 → 30 general enemies (+6-7 treasure
guards on top), depth 20 → 54 (+7) — both confirmed as the intended late-game intensity, not something to level off.

Distribution keeps the existing `spawnCandidates` system (75% rooms / 25% corridors, plus bat swarms) unchanged,
with candidates spread per room proportional to room area so a large map fills evenly instead of clumping.

**Implementation notes (Phase 4 — built):**
- enemies.js: `DENSITY_BASE` 1.36, `DENSITY_PER_DEPTH` 0.065, `spawnDensity(depth)`, `computeSpawnCount(depth,
  populatedFloor)`. A map with no `populatedFloor` (hand-built test maps only) falls back to the old depth curve.
- **What the count covers:** the regular fill loop (incl. bat-swarm members) now counts only the enemies *it* places.
  Before, it filled until `enemies.length` hit the count, so the boss + boss guards were counted inside it. Boss +
  guards, treasure guards and the exit sentries (0-3, 50% per exit room, as before) are all on top. Sentries are now
  tagged `exitSentry` so tools can separate them; "general" = every enemy with none of the role tags.
- **Per-room spread:** `spawnCandidates` shuffles each room's tiles and keys the k-th of n at `(k+u)/n` (u random per
  room), then sorts. Every prefix of the list (spawnEnemies consumes it front to back) holds about the same share of
  each room's floor. Room and corridor picks are interleaved the same way. Measured: the larger half of the rooms
  holds the same share of general room spawns as of floor (within 1-2 points).
- **Measured** (500 floors/depth, main.js-equivalent setup incl. the merchant clearance): density lands within ±1% of
  `density(depth)` at every depth 1-30. General enemies (mean): d1 11.2, d5 14.3, d10 22.8, d15 32.7, d20 42.8,
  d25 48.1, d30 53.6; plus ~1 exit sentry and 1-7 treasure guards.
- **OPEN — the formula and the confirmed targets disagree.** The targets above (d10 → 30, d20 → 54) are what the
  formula gives on the *total* floor of today's maps (d10 ~1717 tiles → 33, d20 ~2171 → 56). `populatedFloor` is much
  smaller (d10 ~1170, d20 ~1650): the wings, the arena and the merchant room are excluded, and a boss depth's arena
  alone is ~220-300 tiles. With the formula as written the counts are ~22.8 / ~42.8. Built as written (formula + the
  ±10% test). Hitting 30/54 needs a decision: scale the density coefficients by ~1.3, or count against total floor.
  Not tuned.

### 17.17 Balance simulation harness
A `npm test`-style check can catch a formula regressing, but can't answer "does depth-10 loot actually feel
generous, and can a player afford the depth-10 merchant" — that needs many simulated runs, not one hand-traced
example. The design rule that makes this possible: **every random roll worth measuring lives in a pure, exported
function** (already true of `generateDungeon`, `spawnEnemies`, `createEnemy`, `rollLoot`, `generateItem`,
`sellValue`, `generateMerchantStock`/`shopPrice`, `createPlayer`/`recalcStats`, `equipUpgrades`/`compareGear` — the
same DOM-free property the existing `test/*.test.js` files already rely on; §17.14's chest-roll extraction is the
one piece that still needs to move out of main.js for this to cover treasure too).

- **Layer 1 — floor statistics** (fixed seeds, depths 1-30 × N runs): room count, populated floor, map size, enemy
  count/density/elite share, treasure count/tier mix/chest+item counts/rarity/item-level-vs-depth per tier, gold and
  potions from mobs vs. chests, books per source, boss-arena size and clear-core size, wing/antechamber placement
  failure rate, generation time (p50/p99).
- **Layer 2 — run economy**: a simple player-policy model over depths 1-20, parameterized by how much of the floor
  the policy explores (**confirmed: 70% explore is the right default**, not a full clear). Per depth: loot everything
  the policy reaches → `equipUpgrades` → sell the rest at `sellValue` (35%) → record gold on hand and **how many of
  that depth's `generateMerchantStock` items the player can actually afford** (this is a direct measurement of the
  "can't afford anything early" complaint that started this whole design pass, §17.4) → track bag-fullness pressure,
  gear-score growth per depth, and XP level vs. the §16 "~1 level per floor" target.
- **Tooling:** `npm run sim` (a separate, slower tool — `node tools/sim.js --depths 1-20 --runs 500 [--explore 0.7]
  [--json out.json] [--compare test/sim/baseline.json]`), printing per-depth mean/p10/p90 and diffing against a
  committed baseline so any future balance change shows its drift immediately. **Not** part of `npm test` (too slow/
  statistical for that). A smaller, fast companion, `test/balance.test.js`, *does* join `npm test`'s chain — fixed
  seeds, N≈50 (a few seconds), asserting bands rather than exact numbers: every treasure room/arena is a genuine
  single-door leaf (or seed room, for the arena), no room qualifies as a boss room under §17.15's minimum size, at
  most one Vault/depth, hidden-book rate lands between 30-40%, item-level offsets are exact per tier, enemy density
  is within ±10% of `density(depth)`, treasure items/depth are within ±25% of the §17.14 design table, and mean
  generation time stays under 10ms.

**Implementation notes (Phase 4 — built):**
- **Prerequisite held:** the whole chain (`generateDungeon` → `spawnEnemies` → `placeMerchant`/`generateMerchantStock`
  → `rollLoot`/`rollChestContents` → `createPlayer`/`gainXP`/`equipUpgrades`/`sellValue`) already ran in plain Node
  after Phase 2. Nothing had to be extracted. Importing skills.js registers the skill-book hooks (books).
- Files: `tools/simlib.js` (shared pure core: `floorSample`, `simulateRun`, `buildFloor`, `designTreasureItems`,
  `tierLevelRange`, `placedArenaStats`; `buildFloor` mirrors main.js loadDepth incl. the merchant clearance filter),
  `tools/sim.js` (CLI), `test/balance.test.js` (in `npm test`, ~4 s: 50 floors × depths 1-20 + a 3-run Layer-2 smoke
  test), `test/sim/baseline.json` (500 runs, seed 1). `npm run sim` compares against the baseline;
  `npm run sim:baseline` rewrites it. Extra flags: `--floor-depths` (Layer 1 range, default 1-30), `--seed`,
  `--no-buy`, `--no-treasure` (Layer 2 counterfactual: never opens a chest), `--threshold` (drift flag, default 10%),
  `--quiet`. The runs are deterministic, so an unchanged codebase compares at exactly 0 drift. Timing metrics are
  never flagged.
- **Layer 2 policy** (simple on purpose): rooms visited in random order (start first; the boss arena always) until
  `explore` of room floor is covered. A Vault behind an antechamber is one unit with it. A hidden room is found with
  p = explore × 0.5, and corridor enemies are met with p = explore. Everything met is killed (xp) and looted; books
  are read on the spot. Bag full → quick-equip, then keep the more valuable item (counted as overflow). At each
  merchant: `equipUpgrades` → sell all unequipped gear + surplus potions (> 10 per kind at the current size, and older
  sizes) → record gold and how many of the 4 regular + featured items are affordable → buy stock items that
  `compareGear` calls an upgrade, best first, while gold lasts (selling what they replace). No potion buying or use,
  no attribute spending.
- **Interpretation:** "no room qualifies as a boss room under §17.15's minimum size" is tested as "every boss room
  meets the minimum (measured on the placed room), exactly one on boss depths, none elsewhere".
- **First baseline findings (500 runs, explore 0.7):**
  - *Early merchant affordability* (the §17.4 complaint): can afford at least one stock item d1 30% / d2 80% / d3 94%
    / d4 99%; the featured item d3 46% / d4 68% / d5 98%. The `--no-treasure` counterfactual: d1 11% / d2 48% / d3 74%,
    featured 0% until d4. The treasure tiers roughly triple gold on hand by d3 (224 vs 76).
  - *From depth 5 gold piles up:* income d5 776 / d10 1790 / d20 4230 (the §17.4 estimate was 120 / 260 at d5/d10).
    Mob gold alone (~100 at d9) still matches that estimate; chest gold and selling loot make up the rest. All 4
    regular items are affordable from d5 on, and gold on hand reaches ~4k at d10 / ~22k at d20, with only ~1 upgrade
    per shop to buy.
  - *Levels lag the "~1 level per floor" target:* level 2.8 at d3 (on target), 7.1 at d10, 12.9 at d20.
  - *Bag pressure is low:* the bag overflows on <5% of depths up to d14, and 12-20% on the deep boss depths (15, 20).
  - *Follow-up — fixed (§17.4 "Late-game gold surplus"):* the surplus was a demand problem (the character outgrows a
    magic-floor stock by ~d6), not supply or income. Merchant stock rarity now steps up at d5/d10; gold on hand is
    now 1.4-2.35 Featured prices from d5 to d20 (was 3.1× → 9.5×), ~3.1k at d10 / ~9.3k at d20; depths 1-4 unchanged.
    Metrics added for this: `stockTotal` (the whole gear stock's price — "supply"), `onHandVsFeatured` (gold on hand in
    Featured prices — the surplus yardstick, table column `hand/feat`), `gearRarity` (mean rarity index worn, 0 common
    .. 4 legendary; column `gearRar`). The baseline was regenerated with the fix.
  - Treasure items/depth run 0-10% under the design table (the one-Vault cap). Antechamber placement fails 10-19% of
    rolls at depths 18-30 (Phase 2 measured 10.5% overall); wings fail < 2%. Generation p50 2.1 ms / p99 10.1 ms.
