# Depths of the Maze

Top-down, real-time dungeon crawler in three.js. No build step. Each level is a dungeon of large
hand-feeling rooms — some pillared, L-shaped, or cave-shaped — linked by doorways and short
corridors, rendered with procedural flagstone/brick/wood textures, torches, and soft contact
shadows under the player and enemies.

## Play
```
python serve.py        # then open http://127.0.0.1:8765/
```
(Any static server works; `serve.py` just disables caching so edits show up on reload.)

The game itself is plain static files (`public/index.html`, `public/js/`) with no build step needed for
local play. The Astro scaffold (`package.json`, `astro.config.mjs`) wraps them only so the project can be
deployed from a host that expects a framework project:
```
npm install
npm run build     # outputs the static files as-is to dist/
npm run preview   # serve the build locally at http://localhost:4321/
```

## Controls
| Action | Keyboard | Controller |
|---|---|---|
| Move (orthogonal) | WASD / Arrows | Left stick / D-pad |
| Cleave · Arcane Bolt · Frost Nova · Shadow Dash | 1 · 2 · 3 · 4 | A · X · Y · B |
| Character sheet | C | Back / RB |
| Inventory | I / Tab | LB |
| Health / Mana potion | H / M | RT / LT |
| Pause | Esc / P | Start |

Inventory: click = equip/use, right-click = drop, shift-click = salvage for gold. Walking into an enemy attacks it.

## Layout
See `DESIGN.md` for the full module contract. `js/main.js` is the glue/loop; each other module in `js/` is a
self-contained system (map, renderer, textures, character, skills, enemies, items, input, ui).
`js/textures.js` builds the procedural canvas textures (floor, walls, wood, glow/shadow sprites)
that `js/renderer.js` applies to the level geometry.

Dev helpers in the browser console: `game` (live state), `__step(n)` (advance n frames manually), `__dbg`.
