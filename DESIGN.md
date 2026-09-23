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
| `js/shop.js` | Producer | Merchant placement, stock, pricing, buy/sell transactions (§17.4) |

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
actions: 'skill1'..'skill4' (1-4 / J K L Space? / gamepad A,X,B,Y → 1,2,3,4 respectively: A=skill1 Cleave, X=skill2 Bolt, Y=skill3 Nova, B=skill4 Dash)
         'character' (C / gamepad Back/View or LB), 'inventory' (I / gamepad RB), 'pause' (Esc, P / Start),
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
`bossTelegraph {enemy, attack}` (a boss begins a telegraphed attack)

## 16. Balance targets
- Depth 1 enemies die in 2–3 Cleaves; player survives ~8–10 hits from depth-appropriate enemies.
- Level ~1 per floor early. xpForLevel(L) ≈ 50 * L^1.5.
- Enemy stats scale ~12%/depth; elites (10%) ×2 HP, ×1.3 dmg, better loot. Boss every 5 depths.
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
  tiles/s). Box collision (half-size 0.3) slides along walls; a corner assist eases the player into doorways/corridors.
- Pushing within ~40° toward an adjacent enemy holds position and swings Cleave; a clearly sideways push walks around it.
- Arcane Bolt fires along the exact stick angle (`player.aim`); Cleave/Dash use the nearest 4-way `facing`.
- Keys: 1-4 skills · H / LT health potion · M / RT mana potion · C / LB character · I, Tab / RB bag · E, Enter, Space / A
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
- localStorage `dotm.save.v1` (versioned). Saves on entering every depth and on `pagehide` / tab hidden while playing.
- Persists the player (level, xp, points, gold, attributes, equipment, inventory, skill ranks, hp/mana) and run stats —
  never positions or timers. Continue regenerates a fresh layout for the saved depth. Death deletes the save.
- Title screen: with a save → "Continue — Depth N · Level L" (default) and "New Game"; random keys don't start anything.

### 17.4 Merchant & economy (shop.js)
- A merchant stands on **every** depth, in a room kept clear of enemies (fallback: start room). No log line announces it.
- Stock is fresh each depth and never carries over: health + mana potions (unlimited), 4 magic-or-better items and one
  **Featured** premium item (rare; epic chance rises with depth), all at exact item level depth + 1.
- Enemies don't respawn, so gold can't be ground on a level. Intended tension: if you can't afford the Featured item,
  skip shopping and save for the next depth's merchant.
- Pricing: buy = value × 1.3, sell = value × 0.35. Featured markup rises with item level so it costs ~2.5-3.5 depths of
  typical income at every depth; regular gear ~1-1.5 depths; potions cheap. Estimated income ≈ 35g (d1), 120g (d5), 260g (d10).

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

### 17.6 Elements & resistances
- Damage has an **element**: physical, arcane, frost, fire, poison, lightning (fire/poison/lightning reserved for future
  skills and gear). Skills are tagged with an element (Cleave physical, Arcane Bolt arcane, Frost Nova frost) — resistances
  never refer to specific skills.
- Status effects are separate keys: freeze, slow (future: burn, poison).
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

### 17.8 Item compare & quick-equip (Bag)
- `compareGear(item, player)` (items.js) simulates wearing the item via `recalcStats` on a copy of the player and diffs the
  stats you actually play with (melee avg, spell power, defense, max HP/mana, crit, dodge, move speed, regen) — not raw
  affixes. Each stat's change is relative to its current value (with a floor so tiny bases don't explode).
- Verdict: **▲ Upgrade** (all gains, or mixed with net > +3%), **▼ Downgrade** (mirror), **↕ Trade-off** (mixed, within ±3%).
  Mixed-but-clear verdicts say "(with trade-offs)" in the tooltip.
- Shown as a corner badge on Bag cells and on shop **Buy** cells (not Sell), a verdict line in the item tooltip, and a
  live `now → after` preview (green/red) in the Bag's Gear Stats list for the hovered / gamepad-focused item.
- **Quick-equip**: R / gamepad Y in the Bag, or the "▲ Equip upgrades" button, equips the single best ▲ item per slot.
  Click / A still equips one item.
- Character/Bag/Shop panels are laid out ~1000px wide and scaled up (never down, max 1.75×) to fit the window
  (`--dm-panel-scale`, measured from the panel's natural height).
