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
| Character sheet | C | LB / Back (always opens Character, regardless of pending points) |
| Inventory | I / Tab | RB |
| Skills (loadout + rank-ups) | K | LB, then RB (no dedicated pad button — LB opens Character, RB then cycles to Skills) |
| Switch Character / Skills / Bag tab | Tab | LB / RB (cycles all three while any tab is open) |
| Health / Mana potion | 5 / 6 | LT / RT |
| Pause | Esc / P | Start |

Inventory: click = equip/use, right-click = drop, shift-click (or G / gamepad L3) = salvage for gold. Walking into
an enemy attacks it.

## Ideas / possible improvements
- [x] **Automated tests** for the pure-math modules — done: `test/*.test.js` (skills, combat, items, unlock; run via
      `npm test`), covering skill/slot resolution, cooldown math, two-handed itemization, compareGear, damage rows,
      Bow Shot/Spark/Staff Sweep, and the unlock system's drop/rank math. Still worth extending as new pure logic
      (e.g. shop pricing) gets touched.
- [ ] **Audit for more "falsy zero" bugs** like the `someDir || 1` pattern found in `renderer.js` (a real `0`
      direction/angle/percentage component gets silently replaced by a non-zero fallback). Worth a full sweep of
      `public/js/*.js`, especially direction/velocity math in `enemies.js`/`main.js`.
- [x] **More build diversity for ranged/AoE.** Done via the weapon-kind/skill-loadout system (DESIGN.md §17.9/§17.10)
      and unlocking (§17.11): Bow Shot, Spark, Staff Sweep, Volley, Fireball, Chain Lightning, Glob Burst and Bone
      Charge all now exist, giving dex/int builds real divergent choices.
- [ ] **Attribute *and* skill respec.** Attribute points (str/dex/int/vit/def) are still permanent; now that skill
      ranks are also per-skill (not per-slot), trying an unlocked alternative skill has the same "committed choice"
      risk. A gold-cost respec (maybe via the merchant, alongside Buyback) covering both would make experimenting
      with builds — and with newly-unlocked skills — less risky.
- [ ] **More shop depth.** No reroll/reforge on gear affixes yet — could pair well with the existing salvage-to-gold
      path now that Buyback gives selling more of a safety net.
- [ ] **Magical weapon affixes** (e.g. a "Bow of Fire"), for any weapon kind, not just bows. Likely smaller than it
      sounds: skills are already element-tagged and enemies already have per-element resist/vulnerability
      (DESIGN.md §17.6), so this is mostly "let a weapon affix grant/override the wielder's attack-skill element,"
      not a new system. Needs a decision on whether an elemental weapon hit stays physical (reduced by armor) or
      acts like a spell (bypasses armor) — see §17.12's armor-vs-spell rule.
- [ ] **Balance playtesting pass** on everything Phases 4-6 shipped, verified by agents but not yet played through
      for feel: Arcane Bolt's damage after losing its old dex contribution (biggest drop is early game, ~20% at
      level 1); whether a bow archer can too-easily kite melee-only enemies now that Cleave's brush-past is gone;
      staff vs. wand+orb in actual play (the ≥1.1x math checks out, the feel doesn't yet); and whether the unlock
      pacing (boss books guaranteed, 45% hidden-room chance, 20%/3% repeat-kill odds) feels earned or too fast/slow.
- [ ] **Spear weapon** (2H melee/str, the reserved `melee2h` class in `WEAPON_KIND_INFO` — DESIGN.md §17.9). Currently
      empty; a spear's attack was floated as a 2-tile line thrust, distinct from Cleave's 3-tile arc.
- [ ] **Minimap icons for chests and hidden-room doors.** Flagged by the phase that built them (DESIGN.md §17.11) —
      currently invisible on the minimap even after a hidden door is revealed.
- [ ] **Talent / branching skill upgrades**, beyond the current flat +15% dmg/-5% CD per rank — a deeper alternative
      to (or pairing with) the respec idea above, letting a skill's rank-up choices diverge rather than just scale.
- [ ] **More bosses.** Only Slime King (5, 15…) and Bone Tyrant (10, 20…) exist; a third would also unlock a third
      boss-unique skill book.

## In-progress design discussion: bows, two-handed weapons, skill loadouts
Not yet implemented — this is a running log of an ongoing design conversation (with an Opus research agent) so it
survives even if the session that produced it is lost. Nothing below is committed to; treat it as the current state
of the discussion, not a spec.

**Starting problem:** a bow can be equipped to the weapon slot, but combat stays melee-only — equipping it doesn't
change how the player attacks.

### Where the code stands today (as of this discussion)
- Walking into an enemy, and pressing skill key 1, both just cast Cleave (`useSkill(game, 0)` in `main.js`) — there is
  no separate "basic attack", skill slot 1 *is* the weapon attack.
- A bow today is really just a weak melee weapon: its damage feeds `meleeMin/Max` like any other weapon.
- "Ranged" damage currently only exists on Arcane Bolt (`rangedMin/Max` = spellPower×0.8 + dex×0.2).
- Plumbing that already exists but is unused for bows: an `'arrow'` projectile kind + renderer support, a bow hero
  model, and `assistAim()` (dex aim-assist) written to work for any ranged skill.

### Round 1 — options for making bows actually shoot
Considered: (A) a dedicated Ranged slot bound to skill key 2 (replacing Arcane Bolt), (B) **skill 1 becomes
weapon-type-aware** — melee weapon → Cleave, bow → an arrow shot, same slot/key, (C) every weapon kind eventually
gets its own skill-1 behavior, (D) a Diablo-2-style dual weapon-set swap button.
**Recommended: B.** Smallest change, no new slot/save migration, keeps Arcane Bolt, and gives dex a payoff (bow
damage/crit/aim-assist) separate from int (spells) — which is the README's existing "more build diversity" goal.
Option A was rejected: it would make dex and int compete for the same hotkey, the opposite of the diversity goal.

### User's answers to round 1's open questions, and where they led
1. **Point-blank bump-attack with a bow:** low end of the weapon's damage range.
2. **Two-handed weapons (raised while answering "does a bow lock the off-hand?"):** bows obviously can't be used with
   a shield, so they should be **two-handed** — locking the off-hand, but hitting harder, costing more, and rolling
   more attributes than one-handed weapons to compensate. Also floated: a staff as a two-handed melee weapon, and
   each two-handed weapon type getting its own unique skill-1 behavior (not just "melee vs ranged").
3. **Anti-kiting cost:** none for now (cooldown similar to melee's current one) — but leave room for future
   cooldown-reduction upgrades/affixes; don't hardcode anything that would make that awkward later.
4. **Armor interaction:** arrows should be reduced by enemy armor/defense, like Cleave (physical). Bypassing armor
   stays exclusive to real magic spells (like Arcane Bolt).
5. **Rank-3 bonus (fan-of-3 vs pierce):** maybe both can coexist, as either a per-item bow property or a
   character-level upgrade/choice, rather than one fixed universal behavior.
6. **Quick-equip:** should never silently swap melee↔bow (since that would also silently clear the off-hand) — flag
   it distinctly, or give separate melee/ranged quick-equip options.

### Round 2 — findings after digging into equip/affix/pricing code
- **Itemization for two-handed weapons is cheap** (base stats, affix count, price are all per-weapon-kind table
  values) — the **equip flow is the hard part**: swapping in a 2H weapon must evict the off-hand (refuse if the bag
  is full), `equipUpgrades` currently equips weapon and off-hand as separate steps that would fight each other, and
  `compareGear` needs to account for the lost off-hand slot, or a bow looks like a free upgrade.
- **"Two-handed" should be a property of weapon *kind*** (bow = 2H, sword/axe/mace/dagger = 1H), not an independent
  flag — keeps the single `weaponKind` lookup driving both hands and skill-1 behavior.
- **Staff: leave it one-handed for now.** Making it 2H breaks the existing staff+orb caster combo. A future 2H melee
  weapon should be a **new kind (spear)** — skill 1 becomes a 2-tile line thrust — rather than repurposing staff.
- **Ship bow-only first**, not all-weapon-kinds-get-unique-skill-1 — each new skill-1 mode needs its own balance/
  VFX/sound/rank-bonus; prove the pipeline once before repeating it.
- **Cooldown:** add a `cooldownReduction` stat now (starts at 0%, capped ~40%) plus one shared cooldown-calc
  function, so future upgrades have a hook. Flagged a real latent bug: the HUD cooldown sweep divides by
  `baseCooldown`, which would desync once per-weapon cooldowns or reduction exist — fix by storing the actual
  cooldown used at cast time.
- **Fan-of-3 vs pierce:** do it as bow item affixes ("Splitting" / "Piercing", normally mutually exclusive, both
  allowed only on legendaries as a chase item) — fits the existing `AFFIX_POOL` system; a skill-upgrade *choice*
  would need a whole new branching system that doesn't exist yet.
- **Quick-equip:** stays within the player's *current* weapon mode (melee-only or bow-only); switching mode is
  always a manual click. Cross-mode upgrades get a neutral "⇄ Ranged/Melee" badge instead of ▲, with the lost
  off-hand's stats shown in red in the tooltip.
- **Point-blank shots:** penalize by distance (using the arrow's traveled distance), not by how the shot was
  triggered — so walking into an enemy and pressing 1 next to one behave identically. Also suggested disabling the
  brush-past auto-attack specifically for bows (it would otherwise spam weak point-blank shots while kiting).

### Round 3 — reframed by a bigger ask: player-chosen skill loadouts
User wants to eventually let players unlock new skills over time and choose which skill occupies each slot, but each
slot keeps a fixed **category/intent**: 1 = attack, 2 = spell, 3 = special, 4 = dodge/movement.

- **Reconciled with round 2, not replacing it:** weapon kind decides *which list* of attack skills is eligible for
  slot 1 (melee list vs ranged list); the player decides *which skill from that list* is active, remembered
  separately per weapon class (e.g. `loadout.attack = { melee: 'cleave', ranged: 'bowShot' }`). Equip a bow → slot 1
  auto-shows your saved ranged pick, so walking into an enemy never hits a "dead" slot. Each weapon kind's default
  attack (Cleave for melee, Bow Shot for bows) is always known/available, never something that must be unlocked —
  unlockable skills are alternatives on top, not the ticket to use a weapon class. Only slot 1 is weapon-gated;
  slots 2-4 ignore equipped weapon.
- **Category rules each new skill must follow:** Attack = no mana cost, short cooldown, uses weapon damage, must work
  when triggered by walking into an adjacent enemy. Spell = costs mana, scales with int/spell power, ignores armor,
  has an element. Special = long cooldown, high impact, usually AoE/CC. Movement = repositions the player, usually
  with brief invulnerability/escape utility.
- **Splitting affix → dropped in favor of a skill:** the 3-arrow fan becomes its own selectable ranged-attack skill
  ("Volley": 3 arrows in a fan, ~60% damage each, slightly longer cooldown) since it changes *how you play*, which
  is what a skill choice is for. Piercing stays an item affix (+1 enemy pierced, works with any shot skill) since
  it's a numbers change, which fits loot. Rule of thumb going forward: **skills decide an attack's shape, affixes
  change how well it does that shape.**
- **How skills unlock — best fit for the existing code: skill books as items** (new item type, e.g. `'tome'`);
  `useItem`/drops/bag/tooltips/selling/buyback all work with no new systems. Suggested pacing: rare enemy drops,
  occasional merchant Featured-slot stock, guaranteed on every boss kill. Duplicate books sell for gold but don't add
  rank (so skill power isn't luck-based). Level-up "pick 1 of 2" and quests were considered but need new
  UI/systems that don't exist yet — left for later.
- **Biggest open call — where skill ranks live:**
  - *Ranks per slot* (current model: slot 1's rank applies to whatever's equipped in it) — trying a new skill stays
    free/strong immediately, no respec needed, and matches round 2's promise that swapping weapons doesn't waste
    points. Weaker "build identity" feel.
  - *Ranks per skill* (Cleave rank 3, Volley rank 1, tracked separately) — stronger identity ("my rank-5 Frost
    Nova"), but trying alternatives becomes costly and practically needs a respec system (already on the README's
    idea list) to not feel punishing.
  - **Leaning: ranks per slot for now**, revisit ranks-per-skill + respec together later.
- **Phasing suggested:** Phase 1 — invisible groundwork (a skill registry: id/category/eligible weapon
  kinds/aimed-or-not; saves store only ids+ranks). Phase 2 — bow ships exactly per round 2's plan, no picker yet
  (plays identically to before this round existed). Phase 3 — skill books + a picker UI, shipped alongside at least
  one alternative skill per category (~4-5 new skills total: Volley, one melee alternative, a fire spell, a
  lightning special) so the picker isn't empty.
- **Save format:** needs a v2 (`knownSkills`, per-weapon-class loadout choice, per-slot ranks) with v1 migration
  (existing 4 skills become known+slotted at their current rank); unknown skill ids on load fall back to that
  category's default so future skill removal can't break old saves.
- **UI:** build the picker into the existing Character panel skill rows, no new panel; a free controller button
  (e.g. Y — A is already "upgrade", left/right already switches Attributes/Skills columns) opens a short list of
  known skills for that category. A skill swapped into a slot should start on cooldown (or a short lockout) so
  players can't swap-to-reset cooldowns.

### Open questions nobody has answered yet
From round 2: (1) staff — stay 1H caster forever, or eventually a 2H "battle staff"? (2) character-screen stat line —
replace "Melee" with "Ranged" when a bow's equipped, or show both always? (3) bow rank-3 bonus — knockback (matches
Cleave, aids kiting) or range/arrow-speed (safer)? (4) legendary bows with both Splitting *and* Piercing — fun chase
item or too strong? (5) confirm disabling brush-past auto-shot for bows specifically.
From round 3: (1) **ranks per slot vs per skill — the most important open call.** (2) should the weapon-class attack
choice be remembered per class (bow pick persists across re-equips) or a single choice you redo by hand after every
weapon swap? (3) skill-unlock source — skill books (recommended) vs level-up choices as the main path? (4) OK to drop
the Splitting affix now that Volley exists as a skill? (5) does the picker ship together with the first alternative
skills (Phase 3 as one release), or ship attack-only alternatives earlier?

### Suggested implementation order (not yet started)
1. Skill kind/category groundwork (registry, weapon-kind → eligible attack list, `aimed` property) — no visible
   change yet.
2. Bow: two-handed equip flow (evict off-hand, bag-full refusal, locked off-hand slot + tooltip in UI, log messages),
   arrow damage finished at hit time (armor applied, point-blank-by-distance penalty, crit rolled at release), dex
   scaling for bow damage, single cooldown function + `cooldownReduction` stat (0 for now) + HUD sweep fix,
   quick-equip mode-locking + "⇄" badge, `compareGear` accounting for the lost off-hand.
3. Skill books (item type, loot table entries, boss guaranteed drop, merchant Featured stock) + save v2 + migration.
4. Skill picker UI in the Character panel + first alternative skills per category (Volley, a melee alternative, a
   fire spell, a lightning special) + Piercing bow affix.
5. Deferred beyond that: spear / battle-staff kind, per-one-handed-kind unique attacks, ranks-per-skill + respec,
   talent/branching upgrades, more than 4 slots or free slot placement, attribute-gated skills.

## Layout
See `DESIGN.md` for the full module contract. `js/main.js` is the glue/loop; each other module in `js/` is a
self-contained system (map, renderer, textures, character, skills, enemies, items, input, ui).
`js/textures.js` builds the procedural canvas textures (floor, walls, wood, glow/shadow sprites)
that `js/renderer.js` applies to the level geometry.

Dev helpers in the browser console: `game` (live state), `__step(n)` (advance n frames manually), `__dbg`.
