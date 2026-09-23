We're working on "Depths of the Maze", a browser dungeon crawler in N:\Projects\game2 dungeon crawler.
Read DESIGN.md first, especially §17, "Game design decisions (living notes)". When I make a design
call, update §17 in the same turn.

Project facts:
- Plain JS modules in public/js: main.js (loop and glue), renderer.js (three.js scene and effects),
  models.js (procedural meshes), ui.js (HUD and panels, CSS in the CSS_TEXT string), map.js, items.js
  (includes compareGear/equipUpgrades), enemies.js (AI, bosses, elements), skills.js, character.js,
  input.js (keyboard + gamepad, padStyle xbox/playstation), audio.js (procedural SFX, limiter,
  reverb), music.js (adaptive procedural music; tunables at the top), save.js, shop.js.
  The Astro setup only exists so the host can build it.
- Deploy: pushing to main on GitHub (radialmonster/depths-of-the-maze) auto-deploys via FlyWP to
  https://depths-of-the-maze-oncwly.flywp.xyz/. Only commit or push when I say so. NextDNS blocks
  that domain from the shell, so check the live site in the browser, not with curl.
- Local testing: ONE server only, on port 8765. It's already running as a hidden process that
  survives terminal crashes. Check whether 8765 is listening before starting anything. If it's down,
  start it hidden: Start-Process python 'serve.py','8765' -WindowStyle Hidden, with SHOT_DIR set to
  a scratch folder. Agents must reuse it and never start their own.
- In the page: window.game, window.__dbg (renderer, ui, input, music, spawnMerchant(),
  spawnBoss(id), modelGallery(), clearGallery()), window.__step(frames) advances the game when the
  tab is in the background, and __dbg.input.stickOverride = {x, y, mag} fakes the analog stick.
  Fake a controller by overriding navigator.getGamepads. Screenshots: ALWAYS downscale them
  (scale ≤ 0.5 or PIL thumbnail 1200); full-size reads crashed sessions.
- Controller: LB/L1 = Character, RB/R1 = Bag (they switch tabs inside panels), LT/RT = potions,
  A/✕ = Cleave or Trade, Y/△ in the Bag = equip upgrades. Start pauses, even from panels.
  Keyboard: U mutes; E trades; R equips upgrades.
- Windows Terminal keeps crashing (Windows.UI.Xaml.dll, likely from controller input), which kills
  the session. If a session dies, check the Application event log (ID 1000) before blaming anything.
  Never kill processes or close terminals, windows or tabs, and put that rule in every agent brief.
- Working style: you are the orchestrator/PM. Send every task, even one-line fixes, to agents:
  Sonnet for light tasks, Opus for detailed ones, with thorough briefs (files, lines, acceptance
  checks, the hard rules above). Review and test their work in the running game before telling me
  it's done.

Done and deployed (latest commit 423ca6e): Bag item compare (▲/▼/↕ badges, stat preview,
quick-equip), bigger scaled panels, controller fixes, PlayStation button labels, adaptive
procedural music plus rebuilt SFX, and a black stairs fade. The boss and deep-floor music haven't
been listened to yet.

Remaining ideas, in order:
7. Room variety (treasure rooms, trapped rooms, shrines with buffs, different looks by depth)
8. Minimap markers for dropped rare-or-better loot
Small: make the pause screen's "♪ Music: On/Off" toggle reachable by controller and keyboard.

Open decision: keep 1-3 down stairs per level or switch to exactly one.

Next goal: #7, room variety. Read the relevant code first (map.js, renderer.js), propose a short
plan, then delegate it and test it in the running game before telling me it's done.
