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
| `js/ui.js` | UI agent | HUD, Character panel (C), Inventory panel (I), messages, death/menu screens. Injects its own CSS. |

## 4. Coordinates & conventions
- Grid tiles. Tile `(x, y)` ↔ world `(x, 0, y)` in three.js; 1 world unit per tile. Tile centers are at integer coords.
- `y` grows **down/south** on screen. "Up" key = `y - 1`.
- Orthogonal movement only (4 directions). Facing is one of `{x:0,y:-1} {x:0,y:1} {x:-1,y:0} {x:1,y:0}`.
- Logical positions of player/enemies are **integers** (`x`, `y`). Renderer smooths visuals itself (lerps meshes toward logical pos).
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
  floatText(x, y, text, color),// forwards to renderer.floatText
  log(text, color),            // forwards to ui.log
  dropLoot(x, y, list),        // push items/gold to groundItems near (x,y)
  hasLineOfSight(x0,y0,x1,y1), // uses map
}
```
### 6.1 Projectile
```js
{ id, x, y /*float*/, dx, dy /*unit dir*/, speed /*tiles/s*/, range /*tiles*/, traveled,
  damage, crit, owner:'player'|'enemy', color:'#hex', size /*0.1-0.5*/, pierce:0, kind:'arrow'|'bolt'|'fireball'|'enemyBolt', hit:Set }
```
main.js moves projectiles, stops them at walls, and calls damageEnemy / damagePlayer on hit.

## 7. Map (map.js)
```js
export function generateDungeon(depth, rng) -> map
export function computeFOV(map, x, y, radius)   // updates map.visible (clears first) and ORs into map.explored
map = {
  width, height,               // grows with depth, cropped to the used area: ~ 50x50 at depth 1 up to ~ 85x85 (never > 90)
  tiles: Uint8Array(width*height),       // TILE values
  visible: Uint8Array(width*height),     // 1 = currently in FOV
  explored: Uint8Array(width*height),    // 1 = ever seen
  rooms: [{ id, x, y, w, h, cx, cy, size:'small'|'medium'|'large', doors:[{x,y}], kind:'normal'|'start'|'exit'|'treasure'|'boss' }],
  entrance: {x, y, dir, front, freestanding?}, // ENTRANCE tile: a cubby in the start room's wall (up-stairs);
                               // dir = unit step from the cubby into the room, front = floor tile in front (player spawn)
  exits: [{x, y, dir, front, freestanding?}],  // 1-3 EXIT cubbies (down-stairs), far from entrance; walking in descends
  idx(x,y), inBounds(x,y), get(x,y), isWalkable(x,y), isOpaque(x,y),
  spawnCandidates(rng, count, minDistFromEntrance) -> [{x,y,roomId}] // floor tiles for enemies/loot
  hasLineOfSight(x0,y0,x1,y1)
}
```
Requirements: classic "large rooms linked together" layout — NOT a maze. 10–16 rooms per level (count grows with depth),
mostly medium/large (8x8 .. 18x14) plus a few small ones; room interiors are ~90%+ of all floor. Room shapes: rectangles,
pillared halls (isolated single WALL pillars, never blocking), L-shapes, two overlapping rectangles, rounded caves.
`x,y,w,h` is the room's bounding box; `cx,cy` is always a walkable floor tile of that room.
Algorithm: growth placement — each new room is attached to an existing room on one side, either sharing a wall (single
doorway in the common wall) or 3–7 tiles away with a short straight corridor; these parent links form the spanning tree.
Then a few extra links between nearby rooms add loops, and rooms are topped up to 2–4 links (large) / 1–3 (medium),
capped at 4/3/2 (large/medium/small). Corridors are short, straight or L-shaped, 1 wide (some straight ones widen to 2
between 1-wide doorways), always join two rooms (no dead ends), and never touch any other space. Every room doorway is a
TILE.DOOR. A BFS safety net guarantees all floor is reachable from the entrance; outer border always WALL.
Deterministic for a given rng.

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
  stats: { maxHp, maxMana, meleeMin, meleeMax, rangedMin, rangedMax, spellPower, defense, critChance, critMult,
           moveCooldown /*s per tile, ~0.14*/, hpRegen, manaRegen /*per s*/, dodgeChance },
  equipment: { weapon:null, offhand:null, helm:null, armor:null, boots:null, ring:null, amulet:null },
  inventory: [],               // max 24 item objects (INVENTORY_SIZE exported)
  skills: [skill, skill, skill, skill],        // from skills.js createSkillLoadout()
  moveTimer:0, invuln:0, hitFlash:0, dead:false, buffs:[]
}
```

## 9. Skills (skills.js)
```js
export function createSkillLoadout() -> [4 skill objects]
export function useSkill(game, index) -> bool  // checks cooldown/mana/dead; performs effect via game API; sets cooldown
export function updateSkills(game, dt)
export function upgradeSkill(player, index) -> bool   // spends 1 skillPoint, rank++ (max 5)
export function skillDescription(skill, player) -> string  // for tooltips / C panel
skill = { id, key:'1'..'4', name, icon /*emoji*/, description, type:'melee'|'ranged'|'special'|'dodge',
          rank:1, maxRank:5, cooldown /*current timer*/, baseCooldown, manaCost }
```
Slots: 1 Cleave (melee arc on facing tile + the two tiles beside it, knockback) · 2 Arcane Bolt (projectile, piercing at higher ranks)
· 3 Frost Nova (AoE radius ~2.5, damage + slow/freeze enemies, mana heavy) · 4 Shadow Dash (dash up to 3 tiles in facing dir through
free tiles, 0.4s invuln, short CD).

## 10. Enemies (enemies.js)
```js
export const ENEMY_TYPES = {...}
export function spawnEnemies(game) -> enemies[]   // uses game.map, game.depth, game.rng; boss on every 5th depth
export function updateEnemies(game, dt)
enemy = { id, type, name, x, y, facing, hp, maxHp, attack, defense, xp, gold:[min,max], level,
          moveCooldown, moveTimer, attackCooldown, attackTimer, aggroRange, behavior:'melee'|'ranged'|'coward'|'swarm'|'boss',
          state:'idle'|'wander'|'chase'|'flee'|'attack'|'return', home:{x,y},
          visual:{ shape:'slime'|'skeleton'|'bat'|'goblin'|'spider'|'mage'|'ogre'|'boss', color:'#hex', scale },
          slow:0 /*timer*/, frozen:0, hitFlash:0, dead:false, deathTimer:0, elite:bool }
```
Behaviors: idle/wander near home; chase when player within aggroRange + line of sight; give up after losing player; cowards flee
at low HP (or always keep distance); ranged keep 3–5 tiles away and shoot `enemyBolt` projectiles; bosses have patterns.
Enemies attack adjacent (orthogonal) player via `game.damagePlayer(amount, enemy)`. Pathfinding: BFS/A* on grid, occupancy via `game.isFree`.

## 11. Items (items.js)
```js
export const INVENTORY_SIZE = 24
export function generateItem(depth, rng, opts={}) -> item   // opts {slot, rarity, type}
export function rollLoot(enemy, depth, rng) -> [item|{type:'gold',amount}]
export function equipItem(player, item) -> bool   // from inventory; swaps with equipped; recalcStats
export function unequipItem(player, slot) -> bool
export function useItem(game, item) -> bool       // potions: heal/mana; consumed
export function dropItem(game, item)              // from inventory to ground at player
export function sellValue(item)
export function itemTooltip(item, player) -> HTML string (with compare vs equipped)
export function startingGear() -> {equipment, inventory}
item = { id, name, type:'weapon'|'offhand'|'helm'|'armor'|'boots'|'ring'|'amulet'|'potion', slot, rarity, icon /*emoji*/,
         itemLevel, stats:{ str, dex, int, vit, def, armor, damageMin, damageMax, spellPower, maxHp, maxMana, critChance, hpRegen, manaRegen, moveSpeed },
         potion:{ heal, mana } (potions only), stack (potions), value, weaponKind:'sword'|'axe'|'mace'|'dagger'|'staff'|'bow' }
```
Only non-zero stats present. Rarity multiplies stats & adds affixes; names like "Rare Vicious Axe of the Bear".

## 12. Input (input.js)
```js
export class Input {
  constructor()                  // attaches listeners
  update()                       // call once per frame BEFORE reading; polls gamepads, computes pressed edges
  moveDir() -> {x,y}|null        // orthogonal only; most recently pressed direction wins; WASD, arrows, D-pad, left stick (deadzone .5)
  pressed(action) -> bool        // true only on the frame the action went down
  held(action) -> bool
  lastDevice: 'keyboard'|'gamepad'
}
actions: 'skill1'..'skill4' (1-4 / J K L Space? / gamepad A,X,B,Y → 1,2,3,4 respectively: A=skill1 Cleave, X=skill2 Bolt, Y=skill3 Nova, B=skill4 Dash)
         'character' (C / gamepad Back/View or RB), 'inventory' (I / gamepad LB), 'pause' (Esc, P / Start),
         'ui_up','ui_down','ui_left','ui_right' (arrows/WASD/dpad edges), 'confirm' (Enter/E / A), 'cancel' (Esc / B), 'drop' (Q/Delete / X),
         'potion' (H / R? → use first health potion; gamepad LT), 'mana_potion' (M / gamepad RT)
```

## 13. UI (ui.js)
```js
export class UI {
  constructor(game, input)      // builds DOM under #ui, injects <style>
  update(game, dt)              // refresh HUD (cheap; only touch DOM when values change)
  toggleCharacter(); toggleInventory(); closeAll(); isModalOpen() -> bool
  handleInput(game, input)      // navigation inside open panels (gamepad/keyboard), called by main when modal open
  log(text, color)              // combat/event log (last ~6 lines, fade)
  banner(title, subtitle)       // big centered fading text (e.g. "Depth 3")
  showDeath(summary, onRestart) ; showPause(onResume) ; hidePause()
  showStart(onStart)            // title screen with controls help
}
```
HUD: HP orb/bar, Mana bar, XP bar with level, depth indicator, gold, 4 skill slots with cooldown sweep + mana cost + key hint
(show gamepad glyphs when input.lastDevice==='gamepad'), minimap (draw map.explored/visible on a <canvas>, player dot, exits, enemies
visible), potion counts, pending attr/skill point indicator ("C" badge).
Character panel: attributes with + buttons, derived stats, skill ranks with upgrade buttons and descriptions.
Inventory panel: paperdoll equipment slots + 24-slot grid, rarity-colored borders, hover tooltips with comparison, click=equip/use,
right-click or drop action=drop, shift-click=sell (to gold, "salvage"). Full keyboard/gamepad navigation.

## 14. Renderer (renderer.js)
```js
export class Renderer {
  constructor(container)        // WebGLRenderer, scene, camera, lights, resize listener
  buildMap(map, depth)          // (re)build level geometry: floor tiles, walls (InstancedMesh), entrance/exit markers, torches; theme tint per depth
  update(game, dt)              // sync meshes to game.player / enemies / groundItems / projectiles (Map<obj.id, mesh>; create/remove as needed),
                                // lerp positions, facing rotation, hit flash, death anim, fog-of-war from map.visible/explored, camera follow
  render()
  spawnEffect(type, x, y, opts) // 'slash'(opts.dir), 'nova'(opts.radius), 'dash'(opts.from), 'hit', 'death', 'levelup', 'heal', 'pickup', 'exit'
  floatText(x, y, text, color)  // rising fading damage numbers (DOM or sprite)
  shake(intensity)
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

## 15. Events (bus)
`enemyKilled {enemy}` · `playerDamaged {amount, source}` · `playerDied` · `levelUp {level}` · `itemPickedUp {item}` ·
`goldPickedUp {amount}` · `depthChanged {depth}` · `skillUsed {skill}` · `statsChanged`

## 16. Balance targets
- Depth 1 enemies die in 2–3 Cleaves; player survives ~8–10 hits from depth-appropriate enemies.
- Level ~1 per floor early. xpForLevel(L) ≈ 50 * L^1.5.
- Enemy stats scale ~12%/depth; elites (10%) ×2 HP, ×1.3 dmg, better loot. Boss every 5 depths.
- Per level: +5 attr points? No — +3 attribute points, +1 skill point.
