// Save/continue persistence. Owned by the Producer agent — see DESIGN.md §6 for the game object shape.
// Pure localStorage wrapper: every access is guarded since storage can be unavailable (private
// browsing, quota, etc). Never throws.

const SAVE_KEY = 'dotm.save.v2';
const SAVE_VERSION = 2;
// Older formats (e.g. 'dotm.save.v1') are never migrated or read (DESIGN §17.3) — the title screen treats them
// exactly like no save. They're left untouched in storage rather than deleted.

// Player fields that persist across a save/continue. Transient combat/position state
// (x/y/fx/fy/aim/facing/moveTimer/invuln/hitFlash/dead/_noManaFlashTimer) is intentionally dropped, as are
// skill cooldowns (player.skillCooldowns) and skill *definitions* — only which skills are known, their ranks and the
// loadout (player.skillState) persist, so a continued run always uses current balance numbers.
const PERSIST_FIELDS = ['name', 'level', 'xp', 'attrPoints', 'skillPoints', 'gold', 'base', 'hp', 'mana', 'equipment', 'inventory',
  'skillState', 'bossesDefeated',
  'activeHealPotionId', 'activeManaPotionId']; // hotbar potion pins; missing = unpinned

// Saves the current run. No-op if there is no live player or the player is dead (a dead run
// shouldn't be continuable — playerDied() clears the save instead).
export function saveRun(game) {
  try {
    const p = game && game.player;
    if (!p || p.dead) return;
    const player = {};
    for (const k of PERSIST_FIELDS) player[k] = p[k];
    const data = {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      depth: game.depth,
      stats: game.stats,
      player,
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (e) { /* storage unavailable or full — ignore, run just won't be persisted */ }
}

// Returns the parsed save data, or null if there is none or it's corrupt/unreadable/an
// unknown version (in which case it's cleared so it doesn't linger).
export function loadRun() {
  let raw = null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch (e) {
    return null;
  }
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    clearSave();
    return null;
  }
  if (!data || data.version !== SAVE_VERSION || !data.player) {
    clearSave();
    return null;
  }
  return data;
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
}
