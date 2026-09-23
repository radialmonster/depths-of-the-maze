// HUD, Character panel (C), Inventory panel (I), messages, death/menu screens.
// Owned by the UI agent — see DESIGN.md §13. Injects its own <style>.
// IMPORTANT: game.player / game.map are REPLACED on restart & depth change.
// This module never caches those sub-references across frames — it re-reads
// `this.game.player` / `this.game.map` fresh every time. The `game` object
// itself is assumed stable for the lifetime of this UI instance.

import { ATTRIBUTES, xpForLevel, spendAttribute } from './character.js';
import { upgradeSkill, skillDescription } from './skills.js';
import { equipItem, unequipItem, useItem, dropItem, sellValue, itemTooltip, compareGear, equipUpgrades, SLOTS, INVENTORY_SIZE } from './items.js';
import { buyFromMerchant, sellToMerchant, nearbyMerchant, shopPrice } from './shop.js';
import { RARITY, clamp, TILE, ELEMENTS, ELEMENT_ORDER } from './core.js';
import { ENEMY_TYPES } from './enemies.js';
import { sfx } from './audio.js';

const SKILL_KEY_LABEL = ['1', '2', '3', '4'];
const SKILL_PAD_LABEL = ['A', 'X', 'Y', 'B'];
const PAD_COLOR = {
  A: '#3ecf5a', B: '#e05a4e', X: '#3e8cf0', Y: '#e0c23e',
  // PlayStation face-button colors, keyed by the glyph padLabel() produces.
  '✕': '#7ea6e0', '○': '#e0525b', '□': '#d884c0', '△': '#3fbfa0',
};

// Xbox-style canonical button name -> PlayStation label. Button MAPPING never changes,
// only what's shown (DESIGN.md §17.1). 'D-pad' and 'L-Stick' are intentionally absent —
// they read the same on every pad.
const PS_PAD_LABEL = { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', Start: 'Options', Back: 'Create' };

// Translate a canonical (Xbox-style) button name for display, given the active pad style.
// Exported so other modules (main.js banners, etc.) can label controller buttons consistently.
export function padLabel(name, style) {
  return (style === 'playstation' && PS_PAD_LABEL[name]) || name;
}
const INV_COLS = 8;

const HIT_VIGNETTE_DURATION = 0.35;   // seconds the on-hit red pulse takes to fade out
const HIT_VIGNETTE_MAX_OPACITY = 0.85; // opacity at frac = 1 (a hit for the player's full HP)
const RESIST_TAG_THRESHOLD = 0.2;      // |resist| at/above this shows up on the boss bar

// "Weak: Frost, Fire · Resists: Physical" — built once per boss from ENEMY_TYPES[id].resist,
// each element name tinted with its ELEMENTS color so the tag doubles as a quick-read legend.
function describeResistHTML(typeId) {
  const resist = ENEMY_TYPES[typeId]?.resist;
  if (!resist) return '';
  const weak = [], strong = [];
  for (const key of ELEMENT_ORDER) {
    const v = resist[key];
    if (v == null) continue;
    const el = ELEMENTS[key];
    const span = `<span style="color:${el.color}">${el.name}</span>`;
    if (v >= RESIST_TAG_THRESHOLD) strong.push(span);
    else if (v <= -RESIST_TAG_THRESHOLD) weak.push(span);
  }
  const parts = [];
  if (weak.length) parts.push(`Weak: ${weak.join(', ')}`);
  if (strong.length) parts.push(`Resists: ${strong.join(', ')}`);
  return parts.join(' &middot; ');
}

// Potion flask drawn as SVG (emoji potions render in platform colors — 🧪 is green on Windows).
const POTION_LIQUID = { heal: '#f03e3e', mana: '#1c7ed6' };
function potionIconSvg(kind) {
  const liquid = POTION_LIQUID[kind] || POTION_LIQUID.heal;
  return `<svg class="dm-potion-svg" viewBox="0 0 32 32" width="1em" height="1em" aria-hidden="true">`
    + `<path d="M13 6.5h6v5.2a9.5 9.5 0 1 1-6 0z" fill="#eef6ff"/>`
    + `<path d="M8.4 15H23.6A9.5 9.5 0 1 1 8.4 15z" fill="${liquid}"/>`
    + `<path d="M13 6.5h6v5.2a9.5 9.5 0 1 1-6 0z" fill="none" stroke="#2b2d42" stroke-width="1.6" stroke-linejoin="round"/>`
    + `<rect x="12" y="2.3" width="8" height="4.6" rx="1.3" fill="#b07a42" stroke="#2b2d42" stroke-width="1.4"/>`
    + `<ellipse cx="11.6" cy="20" rx="1.5" ry="3.2" fill="#fff" opacity="0.75"/>`
    + `<circle cx="19" cy="19" r="1.2" fill="#fff" opacity="0.55"/><circle cx="17" cy="23.5" r="0.8" fill="#fff" opacity="0.45"/>`
    + `</svg>`;
}
function potionKindOf(item) {
  return item && item.type === 'potion' ? (item.potion && item.potion.mana > 0 && !(item.potion.heal > 0) ? 'mana' : 'heal') : null;
}

const ATTR_ICON ={ str: '💪', dex: '🎯', int: '🧠', vit: '❤️', def: '🛡️' };

const DERIVED = [
  { k: 'maxHp', label: 'Max HP', icon: '❤️' },
  { k: 'maxMana', label: 'Max Mana', icon: '💧' },
  { k: 'melee', label: 'Melee', icon: '⚔️' },
  { k: 'spellPower', label: 'Spell Power', icon: '✨' },
  { k: 'defense', label: 'Defense', icon: '🛡️' },
  { k: 'dodgeChance', label: 'Dodge', icon: '🌀' },
  { k: 'critChance', label: 'Crit Chance', icon: '🎯' },
  { k: 'critMult', label: 'Crit Damage', icon: '💥' },
  { k: 'hpRegen', label: 'HP Regen', icon: '🩹' },
  { k: 'manaRegen', label: 'Mana Regen', icon: '🔹' },
  { k: 'moveSpeed', label: 'Move Speed', icon: '👟' },
];
// Subset shown under the backpack so gear changes can be judged without switching tabs.
const GEAR_STATS = ['melee', 'spellPower', 'defense', 'maxHp', 'maxMana', 'critChance', 'dodgeChance', 'moveSpeed'];

// [action, keyboard keys, controller buttons]
const CONTROLS = [
  ['Move', ['W', 'A', 'S', 'D'], ['L-Stick', 'D-pad']],
  ['Skills', ['1', '2', '3', '4'], ['A', 'X', 'Y', 'B']],
  ['Health potion', ['H'], ['LT']],
  ['Mana potion', ['M'], ['RT']],
  ['Trade', ['E'], ['A']],
  ['Character', ['C'], ['LB']],
  ['Inventory', ['I'], ['RB']],
  ['Pause', ['Esc'], ['Start']],
  ['Drop item', ['Q'], ['X']],
];

// Derived-stat display text/value, shared by the Character panel, Gear Stats and the gear preview.
function derivedText(k, s) {
  s = s || {};
  switch (k) {
    case 'maxHp': return String(Math.round(s.maxHp));
    case 'maxMana': return String(Math.round(s.maxMana));
    case 'melee': return `${Math.round(s.meleeMin)}–${Math.round(s.meleeMax)}`;
    case 'spellPower': return String(Math.round(s.spellPower));
    case 'defense': return String(Math.round(s.defense));
    case 'critChance': return fmtPct(s.critChance);
    case 'critMult': return `×${(s.critMult || 1).toFixed(2)}`;
    case 'moveSpeed': return `${(1 / Math.max(0.001, s.moveCooldown)).toFixed(1)}/s`;
    case 'hpRegen': return `${(s.hpRegen || 0).toFixed(1)}/s`;
    case 'manaRegen': return `${(s.manaRegen || 0).toFixed(1)}/s`;
    case 'dodgeChance': return fmtPct(s.dodgeChance);
    default: return '-';
  }
}
function derivedValue(k, s) {
  if (k === 'melee') return s.meleeMin + s.meleeMax;
  if (k === 'moveSpeed') return -s.moveCooldown;
  return s[k] || 0;
}

// Corner badge on bag/shop cells: ▲ upgrade, ▼ downgrade, ↕ trade-off; hidden for potions / no change.
const CMP_GLYPH = { up: '▲', down: '▼', mixed: '↕' };
function setCmpBadge(el, gc) {
  const v = gc && CMP_GLYPH[gc.verdict] ? gc.verdict : '';
  if (el.dataset.v === v) return;
  el.dataset.v = v;
  el.textContent = v ? CMP_GLYPH[v] : '';
  el.className = v ? `dm-cmp dm-cmp-${v}` : 'dm-cmp';
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtPct(x) { return `${Math.round((x || 0) * 100)}%`; }

function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

function mk(tag, cls, parent, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}

function kbd(parent, text, cls) {
  return mk('span', `dm-kbd${cls ? ' ' + cls : ''}`, parent, text);
}

// Restart a one-shot CSS animation class.
function flash(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function getRarity(item) {
  if (!item) return RARITY.common;
  if (item.rarity && typeof item.rarity === 'object') return item.rarity;
  return RARITY[item.rarity] || RARITY.common;
}

// Rarity colors are tuned for a dark backdrop (items.js). On our bright panels
// the pale "common" gray loses contrast as a border, so nudge it darker.
const RARITY_BORDER_FIX = { common: '#9aa2b1' };
function rarityBorderColor(item) {
  const r = getRarity(item);
  return RARITY_BORDER_FIX[r.id] || r.color;
}

// `padEls`, if given, collects {el, name} for every controller-button cell so the caller
// can re-label the (once-built) table when the active pad's style changes.
function buildControlsTable(parent, padEls) {
  const table = mk('div', 'dm-controls', parent);
  const head = mk('div', 'dm-controls-row dm-controls-head', table);
  mk('div', '', head, '');
  mk('div', '', head, '⌨ Keyboard');
  mk('div', '', head, '🎮 Controller');
  for (const [action, keys, pad] of CONTROLS) {
    const row = mk('div', 'dm-controls-row', table);
    mk('div', 'dm-controls-action', row, action);
    const k = mk('div', 'dm-controls-keys', row);
    for (const key of keys) kbd(k, key);
    const g = mk('div', 'dm-controls-keys', row);
    for (const b of pad) {
      const el = kbd(g, b, 'dm-kbd-pad');
      if (PAD_COLOR[b]) el.style.color = PAD_COLOR[b];
      if (padEls) padEls.push({ el, name: b });
    }
  }
  return table;
}

// Re-label a set of {el, name} pad-button cells (from buildControlsTable) for the given style.
function relabelPadEls(padEls, style) {
  for (const { el, name } of padEls) {
    const label = padLabel(name, style);
    if (el.textContent !== label) el.textContent = label;
    el.style.color = PAD_COLOR[label] || '';
  }
}

let stylesInjected = false;

export class UI {
  constructor(game, input) {
    this.game = game;
    this.input = input;

    this.root = document.getElementById('ui');
    if (!this.root) {
      // Defensive fallback — main.js is expected to provide #ui.
      this.root = document.createElement('div');
      this.root.id = 'ui';
      document.body.appendChild(this.root);
      console.error('[ui] #ui element missing — created a fallback div. main.js should provide it.');
    }

    this._characterOpen = false;
    this._inventoryOpen = false;
    this._charCursor = 0;
    this._lastCharCursor = -1;
    this._charColSwitchArmed = true;
    this._invCursor = { area: 'grid', index: 0 };
    this._lastInvCursorKey = null;

    this._shopOpen = false;
    this._shopMerchant = null;
    this._shopTab = 'buy';
    this._shopCursor = 0;
    this._lastShopCursorKey = null;
    this._shopList = [];

    this._logLines = []; // {text, color, t, count}
    this._banner = null; // {title, subtitle, t}

    this._lastMinimapDraw = 0;
    this._lastMapRef = null;

    this._lowHpActive = false;
    this._hpTrail = 1;
    this._hpTrailHold = 0;

    this._bossId = null;       // id of the boss the top HUD bar is currently tracking, or null
    this._bossBarShown = false;
    this._bossHpTrail = 1;
    this._bossHpTrailHold = 0;
    this._prevBossHpPct = null;

    this._hitFlashTimer = 0; // counts down HIT_VIGNETTE_DURATION after a pulseHit() call
    this._hitFlashPeak = 0;  // damage-fraction (0..1) driving this pulse's peak opacity

    this._startActive = false;
    this._startOnNew = null;
    this._startOnContinue = null;
    this._startFired = false;
    this._startSave = null;   // {depth, level} when a save exists, else null
    this._startCursor = 0;    // 0 = Continue, 1 = New Game (only relevant with a save)

    this._pauseActive = false;
    this._pauseCallback = null;

    this._deathActive = false;
    this._deathCallback = null;
    this._deathFired = false;

    this._cache = {};
    this._padEls = []; // {el, name} for once-built controller-button cells (controls tables) — see relabelPadEls

    this._injectStyles();
    this._buildDom();
  }

  // =====================================================================
  // Style injection
  // =====================================================================
  _injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.setAttribute('data-dm-ui', '1');
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
  }

  // =====================================================================
  // DOM construction
  // =====================================================================
  _buildDom() {
    const root = mk('div', 'dm-root', this.root);
    this.dom = { root };

    this._buildHud(root);
    const scrim = mk('div', 'dm-scrim', root);
    scrim.addEventListener('click', () => this.closeAll());
    this.dom.scrim = scrim;
    this._buildCharacterPanel(root);
    this._buildInventoryPanel(root);
    this._buildShopPanel(root);
    this._buildTooltip(root);
    this._buildOverlays(root);
    this._updatePanelScale();
    window.addEventListener('resize', () => {
      this._updatePanelScale();
      if (this._characterOpen || this._inventoryOpen) this._syncPanelSize();
    });
  }

  // Panels are laid out ~1000px wide and scaled up (never down) to fill big windows. Height uses the
  // Character/Bag window's measured unscaled height (offsetHeight ignores the transform).
  _updatePanelScale() {
    const h = Math.max(520, this._panelNaturalH || 640);
    const z = Math.min((window.innerWidth - 48) / 1000, (window.innerHeight - 64) / h);
    this.root.style.setProperty('--dm-panel-scale', clamp(z, 1, 1.75).toFixed(3));
  }

  _buildHud(root) {
    const hud = mk('div', 'dm-hud', root);

    // --- top-left: player plate ---
    const plate = mk('div', 'dm-plate', hud);
    const lvl = mk('div', 'dm-lvl', plate);
    const lvlInner = mk('div', 'dm-lvl-inner', lvl);
    mk('div', 'dm-lvl-cap', lvlInner, 'LV');
    const lvlNum = mk('div', 'dm-lvl-num', lvlInner, '1');
    const info = mk('div', 'dm-plate-info', plate);
    const depthText = mk('div', 'dm-plate-depth', info, 'Depth 1');
    const chips = mk('div', 'dm-plate-chips', info);
    const goldChip = mk('div', 'dm-chip dm-chip-gold', chips);
    mk('span', 'dm-chip-icon', goldChip, '🪙');
    const goldText = mk('span', '', goldChip, '0');
    const killsChip = mk('div', 'dm-chip dm-chip-kills', chips);
    mk('span', 'dm-chip-icon', killsChip, '💀');
    const killsText = mk('span', '', killsChip, '0');
    const pointsPill = mk('button', 'dm-points-pill', hud);
    pointsPill.addEventListener('click', () => this.toggleCharacter());

    // --- minimap (top-right) ---
    const mmWrap = mk('div', 'dm-minimap-wrap', hud);
    const mmCard = mk('div', 'dm-minimap-card', mmWrap);
    const canvas = mk('canvas', 'dm-minimap', mmCard);
    canvas.width = 220; canvas.height = 220;
    const mmLegend = mk('div', 'dm-mm-legend', mmCard);
    for (const [cls, label] of [['you', 'You'], ['foe', 'Foe'], ['exit', 'Stairs'], ['merchant', 'Merchant']]) {
      const l = mk('span', 'dm-mm-key', mmLegend);
      mk('i', `dm-mm-dot dm-mm-${cls}`, l);
      l.appendChild(document.createTextNode(label));
    }
    const mmButtons = mk('div', 'dm-mini-buttons', mmWrap);
    const btnC = mk('button', 'dm-menubtn', mmButtons);
    mk('span', 'dm-menubtn-icon', btnC, '⚔️');
    mk('span', 'dm-menubtn-label', btnC, 'Character');
    const btnCKey = kbd(btnC, 'C');
    const plusC = mk('span', 'dm-menubtn-plus', btnC, '+');
    const btnI = mk('button', 'dm-menubtn', mmButtons);
    mk('span', 'dm-menubtn-icon', btnI, '🎒');
    mk('span', 'dm-menubtn-label', btnI, 'Bag');
    const bagCount = mk('span', 'dm-menubtn-count', btnI, '0/24');
    const btnIKey = kbd(btnI, 'I');
    btnC.addEventListener('click', () => this.toggleCharacter());
    btnI.addEventListener('click', () => this.toggleInventory());

    // --- boss HP bar (top center, clear of the plate and minimap) ---
    const bossBar = mk('div', 'dm-bossbar', hud);
    const bossName = mk('div', 'dm-bossbar-name', bossBar, '');
    const bossTrack = mk('div', 'dm-bossbar-track', bossBar);
    const bossTrail = mk('div', 'dm-bossbar-trail', bossTrack);
    const bossFill = mk('div', 'dm-bossbar-fill', bossTrack);
    mk('div', 'dm-bossbar-notch', bossTrack);
    const bossResist = mk('div', 'dm-bossbar-resist', bossBar, '');
    const bossPhase = mk('div', 'dm-bossbar-phase', bossBar, '');

    // --- vignette ---
    const vignette = mk('div', 'dm-vignette', hud);
    // Separate element for the brief on-hit pulse (see pulseHit()) so its opacity is driven
    // directly frame-by-frame without fighting the low-HP element's CSS class/transition.
    const hitVignette = mk('div', 'dm-vignette dm-hit-vignette', hud);

    // --- banner ---
    const banner = mk('div', 'dm-banner', hud);
    mk('div', 'dm-banner-rule', banner);
    const bannerTitle = mk('div', 'dm-banner-title', banner);
    const bannerSub = mk('div', 'dm-banner-sub', banner);

    // --- merchant trade prompt ---
    const tradePrompt = mk('div', 'dm-trade-prompt', hud, 'Trade — E');

    // --- "sound is locked" hint (browsers need a click/key before audio can start) ---
    const soundHint = mk('div', 'dm-sound-hint', hud, '🔇 Click or press any key to turn on sound');

    // --- combat log ---
    const log = mk('div', 'dm-log', hud);
    const logLines = [];
    for (let i = 0; i < 6; i++) logLines.push(mk('div', 'dm-log-line', log));

    // --- action dock ---
    const dock = mk('div', 'dm-dock', hud);
    const row = mk('div', 'dm-dock-row', dock);

    const bars = mk('div', 'dm-bars', row);
    const mkBar = (cls, label) => {
      const bar = mk('div', `dm-bar ${cls}`, bars);
      const trail = mk('div', 'dm-bar-trail', bar);
      const fill = mk('div', 'dm-bar-fill', bar);
      mk('div', 'dm-bar-shine', bar);
      mk('div', 'dm-bar-label', bar, label);
      const text = mk('div', 'dm-bar-text', bar, '0 / 0');
      return { bar, trail, fill, text };
    };
    const hp = mkBar('dm-hpbar', 'HP');
    const mana = mkBar('dm-manabar', 'MP');

    const skillsWrap = mk('div', 'dm-skills', row);
    const skillSlots = [];
    for (let i = 0; i < 4; i++) {
      const slot = mk('div', 'dm-skill-slot', skillsWrap);
      const icon = mk('div', 'dm-skill-icon', slot, '?');
      const sweep = mk('div', 'dm-skill-sweep', slot);
      const cdText = mk('div', 'dm-skill-cd', slot, '');
      const key = mk('div', 'dm-skill-key', slot, SKILL_KEY_LABEL[i]);
      const cost = mk('div', 'dm-skill-cost', slot, '');
      slot.addEventListener('mouseenter', () => {
        const p = this.game && this.game.player;
        const sk = p && p.skills && p.skills[i];
        if (sk) this._showTooltip(slot, this._skillTooltip(sk, p), 'above');
      });
      slot.addEventListener('mouseleave', () => this._hideTooltip());
      slot.addEventListener('animationend', () => slot.classList.remove('dm-ready-flash'));
      skillSlots.push({ slot, sweep, icon, cdText, key, cost });
    }

    mk('div', 'dm-dock-sep', row);

    const potionsWrap = mk('div', 'dm-potions', row);
    const mkPotion = (cls, kind, key) => {
      const btn = mk('button', `dm-potion-slot ${cls}`, potionsWrap);
      mk('div', 'dm-potion-icon', btn).innerHTML = potionIconSvg(kind);
      const count = mk('div', 'dm-potion-count', btn, '0');
      const k = mk('div', 'dm-potion-key', btn, key);
      return { btn, count, key: k };
    };
    const potHeal = mkPotion('dm-potion-heal', 'heal', 'H');
    const potMana = mkPotion('dm-potion-mana', 'mana', 'M');
    potHeal.btn.addEventListener('click', () => this._useFirstPotion('heal'));
    potMana.btn.addEventListener('click', () => this._useFirstPotion('mana'));

    const xpBar = mk('div', 'dm-xpbar', dock);
    const xpFill = mk('div', 'dm-xpbar-fill', xpBar);
    const xpText = mk('div', 'dm-xpbar-text', dock, 'Level 1 · 0 / 0 XP');

    goldChip.addEventListener('animationend', () => goldChip.classList.remove('dm-bump'));
    lvl.addEventListener('animationend', () => lvl.classList.remove('dm-bump'));

    Object.assign(this.dom, {
      hud, lvl, lvlNum, depthText, goldChip, goldText, killsText, pointsPill,
      canvas, ctx: canvas.getContext('2d'), btnC, btnCKey, plusC, btnI, btnIKey, bagCount,
      bossBar, bossName, bossTrack, bossTrail, bossFill, bossResist, bossPhase,
      vignette, hitVignette, banner, bannerTitle, bannerSub, tradePrompt, soundHint,
      log, logLines,
      hp, mana,
      skillSlots, potHeal, potMana,
      xpFill, xpText,
    });
  }

  _buildPanelShell(root, cls, active) {
    const panel = mk('div', `dm-panel ${cls}`, root);
    const header = mk('div', 'dm-panel-header', panel);
    const tabs = mk('div', 'dm-tabs', header);
    const tabC = mk('button', `dm-tab${active === 'char' ? ' dm-tab-active' : ''}`, tabs);
    mk('span', '', tabC, '⚔️ Character');
    const tabCKey = kbd(tabC, 'C');
    const tabI = mk('button', `dm-tab${active === 'inv' ? ' dm-tab-active' : ''}`, tabs);
    mk('span', '', tabI, '🎒 Inventory');
    const tabIKey = kbd(tabI, 'I');
    tabC.addEventListener('click', () => { if (!this._characterOpen) this.toggleCharacter(); });
    tabI.addEventListener('click', () => { if (!this._inventoryOpen) this.toggleInventory(); });
    const extra = mk('div', 'dm-panel-extra', header);
    const closeBtn = mk('button', 'dm-panel-close', header, '✕');
    closeBtn.title = 'Close (Esc)';
    closeBtn.addEventListener('click', () => this.closeAll());
    const body = mk('div', 'dm-panel-body', panel);
    const foot = mk('div', 'dm-panel-foot', panel);
    return { panel, header, extra, body, foot, tabKeys: [tabCKey, tabIKey] };
  }

  _buildCharacterPanel(root) {
    const shell = this._buildPanelShell(root, 'dm-character', 'char');
    const { panel, extra, body } = shell;

    const summary = mk('div', 'dm-char-summary', extra);
    const lvlText = mk('div', 'dm-char-level', summary, 'Level 1');
    const xpWrap = mk('div', 'dm-char-xp', summary);
    const xpFill = mk('div', 'dm-char-xp-fill', xpWrap);
    const xpText = mk('div', 'dm-char-xp-text', summary, '0 / 0 XP');

    // Attributes
    const attrSection = mk('div', 'dm-section', body);
    const attrHead = mk('div', 'dm-section-title', attrSection);
    mk('span', '', attrHead, 'Attributes');
    const attrPoints = mk('span', 'dm-points-badge', attrHead, '');
    const attrList = mk('div', 'dm-attr-list', attrSection);
    const attrRows = ATTRIBUTES.map((attr) => {
      const row = mk('div', 'dm-attr-row', attrList);
      row.dataset.attr = attr.id;
      mk('div', 'dm-attr-icon', row, ATTR_ICON[attr.id] || '◆');
      const text = mk('div', 'dm-attr-text', row);
      mk('div', 'dm-attr-name', text, attr.name);
      mk('div', 'dm-attr-desc', text, attr.description);
      const value = mk('div', 'dm-attr-value', row, '0');
      const plusBtn = mk('button', 'dm-plus', row, '+');
      plusBtn.title = `Spend a point on ${attr.name}`;
      plusBtn.addEventListener('click', () => this._spendAttr(attr.id));
      return { attr, row, value, plusBtn };
    });

    // Derived
    const derivedSection = mk('div', 'dm-section', body);
    mk('div', 'dm-section-title', derivedSection, 'Stats');
    const derivedList = mk('div', 'dm-derived-list', derivedSection);
    const derivedRows = {};
    for (const d of DERIVED) {
      const row = mk('div', 'dm-derived-row', derivedList);
      mk('div', 'dm-derived-icon', row, d.icon);
      mk('div', 'dm-derived-name', row, d.label);
      derivedRows[d.k] = mk('div', 'dm-derived-value', row, '-');
    }

    // Skills
    const skillSection = mk('div', 'dm-section dm-section-skills', body);
    const skillHead = mk('div', 'dm-section-title', skillSection);
    mk('span', '', skillHead, 'Skills');
    const skillPoints = mk('span', 'dm-points-badge', skillHead, '');
    const skillList = mk('div', 'dm-charskill-list', skillSection);
    const skillRows = [];
    for (let i = 0; i < 4; i++) {
      const row = mk('div', 'dm-charskill-row', skillList);
      row.dataset.index = String(i);
      const icon = mk('div', 'dm-charskill-icon', row, '');
      const key = mk('div', 'dm-charskill-key', icon, SKILL_KEY_LABEL[i]);
      const main = mk('div', 'dm-charskill-main', row);
      const head = mk('div', 'dm-charskill-head', main);
      const name = mk('div', 'dm-charskill-name', head, '');
      const pips = mk('div', 'dm-pips', head);
      const desc = mk('div', 'dm-charskill-desc', main, '');
      const upgradeBtn = mk('button', 'dm-plus dm-plus-wide', row, 'Upgrade');
      upgradeBtn.addEventListener('click', () => this._upgradeSkill(i));
      skillRows.push({ row, icon, key, name, pips, pipEls: [], upgradeBtn, desc });
    }

    Object.assign(this.dom, {
      charPanel: panel, charShell: shell,
      charLvlText: lvlText, charXpFill: xpFill, charXpText: xpText,
      attrPoints, skillPoints, attrRows, derivedRows, charSkillRows: skillRows,
    });
  }

  _buildInventoryPanel(root) {
    const shell = this._buildPanelShell(root, 'dm-inventory', 'inv');
    const { panel, extra, body } = shell;
    shell.body.classList.add('dm-inv-body');

    const goldText = mk('div', 'dm-inv-gold', extra, '🪙 0');

    const left = mk('div', 'dm-inv-col', body);
    mk('div', 'dm-section-title', left, 'Equipped');
    const paperdoll = mk('div', 'dm-paperdoll', left);
    mk('div', 'dm-paperdoll-figure', paperdoll, '🧍');
    const slotEls = SLOTS.map((slotDef, i) => {
      const el = mk('div', 'dm-eq-slot', paperdoll);
      el.style.gridArea = slotDef.id;
      el.dataset.index = String(i);
      const icon = mk('div', 'dm-eq-icon', el, slotDef.icon || '?');
      const label = mk('div', 'dm-eq-label', el, slotDef.name || slotDef.id);
      el.addEventListener('click', () => this._clickPaperdoll(i));
      el.addEventListener('mouseenter', (e) => this._hoverPaperdoll(i, e));
      el.addEventListener('mousemove', (e) => this._positionTooltip(e.clientX, e.clientY));
      el.addEventListener('mouseleave', () => this._hideTooltip());
      return { el, icon, label, slotDef };
    });

    const right = mk('div', 'dm-inv-col dm-inv-col-grid', body);
    const gridHead = mk('div', 'dm-section-title', right);
    mk('span', '', gridHead, 'Backpack');
    const capText = mk('span', 'dm-inv-cap', gridHead, `0 / ${INVENTORY_SIZE}`);
    const upBtn = mk('button', 'dm-inv-upbtn', gridHead);
    mk('span', '', upBtn, '▲ Equip upgrades');
    const upBtnKey = mk('span', 'dm-kbd', upBtn, 'R');
    upBtn.addEventListener('click', () => this._quickEquip());
    const grid = mk('div', 'dm-inv-grid', right);
    const cellEls = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const cell = mk('div', 'dm-inv-cell', grid);
      cell.dataset.index = String(i);
      const icon = mk('div', 'dm-inv-icon', cell, '');
      const stack = mk('div', 'dm-inv-stack', cell, '');
      const cmp = mk('div', 'dm-cmp', cell, '');
      cell.addEventListener('click', (e) => this._clickInvCell(i, e));
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); this._dropInvCell(i); });
      cell.addEventListener('mouseenter', (e) => this._hoverInvCell(i, e));
      cell.addEventListener('mousemove', (e) => this._positionTooltip(e.clientX, e.clientY));
      cell.addEventListener('mouseleave', () => { this._hideTooltip(); this._previewGear(null); });
      cellEls.push({ cell, icon, stack, cmp });
    }

    mk('div', 'dm-section-title dm-inv-stats-title', right, 'Gear Stats');
    const statsList = mk('div', 'dm-derived-list dm-inv-stats', right);
    const gearStatRows = {};
    for (const k of GEAR_STATS) {
      const def = DERIVED.find((x) => x.k === k);
      const row = mk('div', 'dm-derived-row', statsList);
      mk('div', 'dm-derived-icon', row, def.icon);
      mk('div', 'dm-derived-name', row, def.label);
      gearStatRows[k] = mk('div', 'dm-derived-value', row, '-');
    }

    Object.assign(this.dom, {
      invPanel: panel, invShell: shell, invGoldText: goldText, invCapText: capText,
      eqSlots: slotEls, invCells: cellEls, gearStatRows, invUpBtn: upBtn, invUpBtnKey: upBtnKey,
    });
  }

  // Standalone modal (not a Character/Inventory tab): its own header with Buy/Sell tabs,
  // reusing the same panel shell classes and inventory-grid cell styling so it feels native.
  _buildShopPanel(root) {
    const panel = mk('div', 'dm-panel dm-shop', root);
    const header = mk('div', 'dm-panel-header', panel);

    const tabs = mk('div', 'dm-tabs', header);
    const tabBuy = mk('button', 'dm-tab dm-tab-active', tabs);
    mk('span', '', tabBuy, '🛒 Buy');
    const tabSell = mk('button', 'dm-tab', tabs);
    mk('span', '', tabSell, '💰 Sell');
    tabBuy.addEventListener('click', () => this._setShopTab('buy'));
    tabSell.addEventListener('click', () => this._setShopTab('sell'));

    const extra = mk('div', 'dm-panel-extra', header);
    mk('div', 'dm-shop-title', extra, '🧙 Merchant');
    const goldText = mk('div', 'dm-inv-gold', extra, '🪙 0');
    const closeBtn = mk('button', 'dm-panel-close', header, '✕');
    closeBtn.title = 'Close (Esc)';
    closeBtn.addEventListener('click', () => this.closeAll());

    const body = mk('div', 'dm-panel-body dm-shop-body', panel);
    const grid = mk('div', 'dm-inv-grid dm-shop-grid', body);
    const cellEls = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const cell = mk('div', 'dm-inv-cell dm-shop-cell', grid);
      cell.dataset.index = String(i);
      const badge = mk('div', 'dm-shop-badge', cell, '★ Featured');
      const icon = mk('div', 'dm-inv-icon', cell, '');
      const stack = mk('div', 'dm-inv-stack', cell, '');
      const price = mk('div', 'dm-shop-price', cell, '');
      const cmp = mk('div', 'dm-cmp', cell, '');
      cell.addEventListener('click', () => this._clickShopCell(i));
      cell.addEventListener('mouseenter', (e) => this._hoverShopCell(i, e));
      cell.addEventListener('mousemove', (e) => this._positionTooltip(e.clientX, e.clientY));
      cell.addEventListener('mouseleave', () => this._hideTooltip());
      cellEls.push({ cell, icon, stack, price, badge, cmp });
    }

    const foot = mk('div', 'dm-panel-foot', panel);

    Object.assign(this.dom, {
      shopPanel: panel, shopTabBuy: tabBuy, shopTabSell: tabSell,
      shopGoldText: goldText, shopCells: cellEls, shopFoot: foot,
    });
  }

  _buildTooltip(root) {
    this.dom.tooltip = mk('div', 'dm-tooltip', root);
  }

  _buildOverlays(root) {
    // Start screen.
    const start = mk('div', 'dm-overlay dm-start', root);
    const startCard = mk('div', 'dm-overlay-card dm-start-card', start);
    mk('div', 'dm-title-eyebrow', startCard, '⚔  A dungeon crawler  ⚔');
    const title = mk('div', 'dm-title', startCard);
    mk('span', 'dm-title-small', title, 'Depths of the');
    mk('span', 'dm-title-big', title, 'MAZE');
    mk('div', 'dm-tagline', startCard, 'Descend. Fight. Loot. Try not to die.');
    const startBtnRow = mk('div', 'dm-start-btn-row', startCard);
    const continueBtn = mk('button', 'dm-btn dm-btn-primary dm-start-hide', startBtnRow, 'Continue');
    const startBtn = mk('button', 'dm-btn dm-btn-primary', startBtnRow, 'Enter the Maze');
    const pressAny = mk('div', 'dm-press-any', startCard, 'or press any key / button');
    const startHint = mk('div', 'dm-hint dm-start-hide', startCard, '');
    // Browsers only allow audio after a click/key press, and gamepad buttons don't count.
    const startSound = mk('div', 'dm-start-sound', startCard, '🎮 Playing with a controller? Click anywhere once to turn on sound.');
    buildControlsTable(startCard, this._padEls);
    mk('div', 'dm-hint', startCard, 'Walk into enemies to attack · Find the glowing stairs to descend · Every 5th depth hides a boss');
    // Backdrop click only starts a fresh run when there's nothing to accidentally overwrite.
    start.addEventListener('click', () => { if (!this._startSave) this._fireStart('new'); });
    continueBtn.addEventListener('click', (e) => { e.stopPropagation(); this._fireStart('continue'); });
    startBtn.addEventListener('click', (e) => { e.stopPropagation(); this._fireStart('new'); });

    // Pause screen.
    const pause = mk('div', 'dm-overlay dm-pause', root);
    const pauseCard = mk('div', 'dm-overlay-card', pause);
    mk('div', 'dm-title dm-title-sm', pauseCard, 'Paused');
    const pauseStats = mk('div', 'dm-pause-stats', pauseCard, '');
    const resumeBtn = mk('button', 'dm-btn dm-btn-primary', pauseCard, 'Resume');
    // Music on/off (persisted by audio.js in localStorage `dotm.music`); U still mutes everything.
    const musicBtn = mk('button', 'dm-btn dm-btn-secondary dm-music-btn', pauseCard, '');
    musicBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sfx.toggleMusic();
      this._syncMusicBtn();
      sfx.uiClick();
    });
    const pauseResumeHint = mk('div', 'dm-hint', pauseCard, 'Esc / P / Start to resume · U to mute sound');
    mk('div', 'dm-hint', pauseCard, 'Progress saves automatically at each new depth');
    buildControlsTable(pauseCard, this._padEls);
    resumeBtn.addEventListener('click', () => { if (this._pauseCallback) this._pauseCallback(); });

    // Death screen.
    const death = mk('div', 'dm-overlay dm-death', root);
    const deathCard = mk('div', 'dm-overlay-card', death);
    mk('div', 'dm-death-skull', deathCard, '💀');
    mk('div', 'dm-title dm-title-sm', deathCard, 'You Have Fallen');
    const deathCause = mk('div', 'dm-tagline', deathCard, '');
    const summaryGrid = mk('div', 'dm-death-summary', deathCard);
    const tile = (icon, label) => {
      const t = mk('div', 'dm-stat-tile', summaryGrid);
      mk('div', 'dm-stat-icon', t, icon);
      const v = mk('div', 'dm-stat-value', t, '-');
      mk('div', 'dm-stat-label', t, label);
      return v;
    };
    const sDepth = tile('⛏️', 'Depth');
    const sLevel = tile('⭐', 'Level');
    const sKills = tile('💀', 'Kills');
    const sGold = tile('🪙', 'Gold');
    const sTime = tile('⏱️', 'Time');
    const retryBtn = mk('button', 'dm-btn dm-btn-primary', deathCard, 'Try Again');
    const deathRetryHint = mk('div', 'dm-hint', deathCard, 'Press Enter / A to try again');
    retryBtn.addEventListener('click', () => this._fireDeath());

    this.dom.start = start;
    this.dom.continueBtn = continueBtn;
    this.dom.startBtn = startBtn;
    this.dom.pressAny = pressAny;
    this.dom.startHint = startHint;
    this.dom.startSound = startSound;
    this.dom.pause = pause;
    this.dom.pauseStats = pauseStats;
    this.dom.pauseResumeHint = pauseResumeHint;
    this.dom.musicBtn = musicBtn;
    this.dom.death = death;
    this.dom.deathCause = deathCause;
    this.dom.deathRetryHint = deathRetryHint;
    this.dom.deathRows = { sDepth, sLevel, sKills, sGold, sTime };
  }

  // =====================================================================
  // Public API — panel toggling
  // =====================================================================
  toggleCharacter() {
    if (this._characterOpen) { this._characterOpen = false; sfx.uiClick(); }
    else { this._inventoryOpen = false; this._characterOpen = true; this._charCursor = 0; this._lastCharCursor = -1; this._charColSwitchArmed = true; sfx.uiOpen(); }
    if (this._characterOpen) this._syncPanelSize();
    this._applyPanelVisibility();
  }

  toggleInventory() {
    if (this._inventoryOpen) { this._inventoryOpen = false; sfx.uiClick(); }
    else {
      this._characterOpen = false; this._inventoryOpen = true; this._invCursor = { area: 'grid', index: 0 };
      // Gamepad users get the cursor tooltip immediately; keyboard/mouse users only once they move the cursor.
      this._lastInvCursorKey = this.input && this.input.lastDevice === 'gamepad' ? null : 'grid:0';
      sfx.uiOpen();
    }
    if (this._inventoryOpen) this._syncPanelSize();
    this._applyPanelVisibility();
  }

  openShop(merchant) {
    if (!merchant) return;
    this._characterOpen = false;
    this._inventoryOpen = false;
    this._shopOpen = true;
    this._shopMerchant = merchant;
    this._shopTab = 'buy';
    this._shopCursor = 0;
    // Gamepad users get the cursor tooltip immediately; keyboard/mouse users only once they move the cursor.
    this._lastShopCursorKey = this._initialShopCursorKey();
    sfx.uiOpen();
    this._applyPanelVisibility();
    this._refreshShopPanel();
  }

  _cycleTab(dir) {
    const tabs = [() => this.toggleCharacter(), () => this.toggleInventory()];
    const cur = this._characterOpen ? 0 : 1;
    tabs[(cur + dir + tabs.length) % tabs.length]();
    this._hideTooltip();
  }

  // Character and Inventory are tabs of one window: give both the taller one's natural height so
  // switching tabs never resizes it. Hidden panels are still laid out (visibility), so both measure.
  _syncPanelSize() {
    const d = this.dom;
    if (!d.charPanel || !d.invPanel) return;
    this._refreshCharacterPanel();
    this._refreshInventoryPanel();
    const panels = [d.charPanel, d.invPanel];
    for (const el of panels) el.style.height = '';
    this.root.style.setProperty('--dm-panel-scale', '1'); // measure at 1x so max-height can't clip
    const h = Math.max(...panels.map((el) => el.offsetHeight));
    for (const el of panels) el.style.height = `${h}px`;
    this._panelNaturalH = h;
    this._updatePanelScale();
  }

  closeAll() {
    this._characterOpen = false;
    this._inventoryOpen = false;
    if (this._shopOpen) sfx.uiClick();
    this._shopOpen = false;
    this._shopMerchant = null;
    this._applyPanelVisibility();
    this._hideTooltip();
  }

  isModalOpen() {
    return this._characterOpen || this._inventoryOpen || this._shopOpen;
  }

  _applyPanelVisibility() {
    this.dom.charPanel.classList.toggle('dm-open', this._characterOpen);
    this.dom.invPanel.classList.toggle('dm-open', this._inventoryOpen);
    this.dom.shopPanel.classList.toggle('dm-open', this._shopOpen);
    this.dom.scrim.classList.toggle('dm-open', this.isModalOpen());
    this._hideTooltip();
  }

  // =====================================================================
  // Public API — messages
  // =====================================================================
  log(text, color) {
    text = String(text);
    color = color || '#4dabf7';
    const t = now();
    const last = this._logLines[this._logLines.length - 1];
    if (last && last.text === text && t - last.t < 4000) {
      last.count++;
      last.t = t;
      return;
    }
    this._logLines.push({ text, color, t, count: 1 });
    if (this._logLines.length > 24) this._logLines.shift();
  }

  banner(title, subtitle) {
    this._banner = { title: title || '', subtitle: subtitle || '', t: now() };
    flash(this.dom.banner, 'dm-banner-in');
  }

  // Brief red vignette pulse when the player takes a hit, scaled by how much of their max HP
  // the hit cost (0..1). Independent of the slow low-HP pulse driven by _updateHud().
  pulseHit(frac) {
    this._hitFlashPeak = Math.max(this._hitFlashPeak, clamp(frac, 0, 1));
    this._hitFlashTimer = HIT_VIGNETTE_DURATION;
  }

  // =====================================================================
  // Public API — screens
  // =====================================================================
  showDeath(summary, onRestart) {
    summary = summary || {};
    this._deathCallback = onRestart;
    this._deathFired = false;
    this._deathActive = true;
    this._hideTooltip();
    const r = this.dom.deathRows;
    r.sDepth.textContent = String(summary.depth ?? '-');
    r.sLevel.textContent = String(summary.level ?? '-');
    r.sKills.textContent = String(summary.kills ?? 0);
    r.sGold.textContent = String(summary.gold ?? 0);
    r.sTime.textContent = fmtTime(summary.timePlayed || 0);
    this.dom.deathCause.textContent = summary.killedBy
      ? `Slain by ${summary.killedBy} on depth ${summary.depth ?? '?'}.`
      : `Your journey ended on depth ${summary.depth ?? '?'}.`;
    this.dom.death.classList.add('dm-open');
  }

  showPause(onResume) {
    this._pauseCallback = onResume;
    this._pauseActive = true;
    this._hideTooltip();
    sfx.uiOpen();
    const g = this.game, p = g && g.player;
    this.dom.pauseStats.textContent = p
      ? `Depth ${g.depth} · Level ${p.level} · ${(g.stats && g.stats.kills) || 0} kills · ${fmtTime(g.stats && g.stats.timePlayed)}`
      : '';
    this._syncMusicBtn();
    this.dom.pause.classList.add('dm-open');
  }

  _syncMusicBtn() {
    if (this.dom.musicBtn) this.dom.musicBtn.textContent = sfx.musicEnabled() ? '♪ Music: On' : '♪ Music: Off';
  }

  hidePause() {
    this._pauseActive = false;
    this.dom.pause.classList.remove('dm-open');
    sfx.uiClick();
  }

  // showStart({ onNew, onContinue, save }) — save is {depth, level} when a save exists (shows
  // a Continue/New Game chooser), or falsy to keep the single "Enter the Maze" behavior.
  showStart({ onNew, onContinue, save } = {}) {
    this._startOnNew = onNew;
    this._startOnContinue = onContinue;
    this._startSave = save || null;
    this._startFired = false;
    this._startActive = true;
    this._startCursor = 0; // default focus: Continue, when present
    this.dom.start.classList.add('dm-open');
    this.dom.hud.classList.add('dm-hidden');
    this._renderStartButtons();
  }

  _renderStartButtons() {
    const d = this.dom;
    const save = this._startSave;
    d.continueBtn.classList.toggle('dm-start-hide', !save);
    if (save) d.continueBtn.textContent = `Continue — Depth ${save.depth} · Level ${save.level}`;
    d.startBtn.textContent = save ? 'New Game' : 'Enter the Maze';
    d.startBtn.className = `dm-btn ${save ? 'dm-btn-secondary' : 'dm-btn-primary'}`;
    d.pressAny.classList.toggle('dm-start-hide', !!save);
    d.startHint.classList.toggle('dm-start-hide', !save);
    if (save) d.startHint.textContent = 'New Game replaces your saved run';
    this._syncStartFocus();
  }

  _syncStartFocus() {
    const d = this.dom;
    d.continueBtn.classList.toggle('dm-focused', !!this._startSave && this._startCursor === 0);
    d.startBtn.classList.toggle('dm-focused', !!this._startSave && this._startCursor === 1);
  }

  _fireStart(which) {
    if (this._startFired) return;
    this._startFired = true;
    this._startActive = false;
    this.dom.start.classList.remove('dm-open');
    this.dom.hud.classList.remove('dm-hidden');
    const cb = which === 'continue' ? this._startOnContinue : this._startOnNew;
    this._startOnNew = null;
    this._startOnContinue = null;
    if (cb) cb();
  }

  _fireDeath() {
    if (this._deathFired) return;
    this._deathFired = true;
    this._deathActive = false;
    this.dom.death.classList.remove('dm-open');
    this._hpTrail = 1;
    this._bossId = null;
    this._bossBarShown = false;
    this.dom.bossBar.classList.remove('dm-show');
    const cb = this._deathCallback;
    this._deathCallback = null;
    if (cb) cb();
  }

  // =====================================================================
  // Frame update
  // =====================================================================
  update(game, dt) {
    this.game = game;
    this._updateControllerLabels();
    this._tickOverlayInput();
    this._tickBanner();
    this._tickLog();

    if (this._startActive) {
      // Only nag controller players, and only while the browser is still holding audio back.
      const pads = (navigator.getGamepads && [...navigator.getGamepads()].some(Boolean)) || this.input?.lastDevice === 'gamepad';
      const show = sfx.needsGesture() && pads;
      if (this._cache.startSoundShow !== show) {
        this.dom.startSound.classList.toggle('dm-show', show);
        this._cache.startSoundShow = show;
      }
    }
    if (this._startActive || this._deathActive) return; // HUD not relevant on these screens

    if (!game || !game.player) return;

    this._updateDeviceHints();
    this._updateHud(game, dt);
    this._updateBossBar(game, dt);
    this._updateTradePrompt(game);
    const needSound = sfx.needsGesture();
    if (this._cache.soundHintShow !== needSound) {
      this.dom.soundHint.classList.toggle('dm-show', needSound);
      this._cache.soundHintShow = needSound;
    }
    if (this._characterOpen) this._refreshCharacterPanel();
    if (this._inventoryOpen) this._refreshInventoryPanel();
    if (this._shopOpen) this._refreshShopPanel();
  }

  // Small floating HUD prompt shown while standing near a merchant and no panel is open.
  _updateTradePrompt(game) {
    const near = !this.isModalOpen() && !!nearbyMerchant(game);
    if (this._cache.tradePromptShow !== near) {
      this.dom.tradePrompt.classList.toggle('dm-show', near);
      this._cache.tradePromptShow = near;
    }
    if (near) {
      const gamepad = !!(this.input && this.input.lastDevice === 'gamepad');
      const style = (this.input && this.input.padStyle) || 'xbox';
      const text = gamepad ? `Trade — ${padLabel('A', style)}` : 'Trade — E';
      if (this._cache.tradePromptText !== text) {
        this.dom.tradePrompt.textContent = text;
        this._cache.tradePromptText = text;
      }
    }
  }

  // Top-of-screen boss HP bar: shown once a boss has noticed the player (enemies.js sets
  // `_noticed`), hidden (with a fade) once it dies or a new depth/run replaces game.enemies.
  _updateBossBar(game, dt) {
    const d = this.dom;
    const boss = (game.enemies || []).find((e) => e.behavior === 'boss' && !e.dead && e._noticed);
    if (!boss) {
      if (this._bossBarShown) { this._bossBarShown = false; d.bossBar.classList.remove('dm-show'); }
      this._bossId = null;
      return;
    }
    if (this._bossId !== boss.id) {
      this._bossId = boss.id;
      const startPct = clamp(boss.hp / Math.max(1, boss.maxHp), 0, 1);
      this._bossHpTrail = startPct;
      this._prevBossHpPct = startPct;
      this._bossHpTrailHold = 0;
      d.bossName.textContent = boss.name;
      d.bossResist.innerHTML = describeResistHTML(boss.type);
      flash(d.bossBar, 'dm-bossbar-in');
    }
    if (!this._bossBarShown) { this._bossBarShown = true; d.bossBar.classList.add('dm-show'); }

    const hpPct = clamp(boss.hp / Math.max(1, boss.maxHp), 0, 1);
    d.bossFill.style.width = `${hpPct * 100}%`;
    if (this._prevBossHpPct != null && hpPct < this._prevBossHpPct) this._bossHpTrailHold = 0.45;
    this._prevBossHpPct = hpPct;
    if (this._bossHpTrail < hpPct) this._bossHpTrail = hpPct;
    else if (this._bossHpTrail > hpPct) {
      if (this._bossHpTrailHold > 0) this._bossHpTrailHold -= dt;
      else this._bossHpTrail = Math.max(hpPct, this._bossHpTrail - dt * 0.5);
    }
    d.bossTrail.style.width = `${this._bossHpTrail * 100}%`;
    d.bossPhase.textContent = (boss._phase || 1) >= 2 ? 'PHASE 2' : '';
  }

  _tickOverlayInput() {
    const input = this.input;
    if (!input) return;
    if (this._startActive && !this._startFired) {
      if (this._startSave) {
        // Two-button chooser: no "any key" start (that could fire either action by accident).
        if (input.pressed('ui_up') || input.pressed('ui_left')) { this._startCursor = 0; this._syncStartFocus(); }
        if (input.pressed('ui_down') || input.pressed('ui_right')) { this._startCursor = 1; this._syncStartFocus(); }
        if (input.pressed('confirm')) this._fireStart(this._startCursor === 0 ? 'continue' : 'new');
      } else if (input.anyPressed()) {
        this._fireStart('new');
      }
    }
    if (this._pauseActive) {
      if (input.pressed('pause') || input.pressed('confirm')) {
        if (this._pauseCallback) this._pauseCallback();
      }
    }
    if (this._deathActive && !this._deathFired) {
      if (input.pressed('confirm')) this._fireDeath();
    }
  }

  _tickBanner() {
    const b = this.dom.banner;
    if (!this._banner) {
      if (b.style.opacity !== '0') b.style.opacity = '0';
      return;
    }
    const age = (now() - this._banner.t) / 1000;
    const dur = 2.8;
    if (age >= dur) { this._banner = null; b.style.opacity = '0'; return; }
    let op;
    if (age < 0.25) op = age / 0.25;
    else if (age > dur - 0.6) op = Math.max(0, (dur - age) / 0.6);
    else op = 1;
    if (this.dom.bannerTitle.textContent !== this._banner.title) this.dom.bannerTitle.textContent = this._banner.title;
    if (this.dom.bannerSub.textContent !== this._banner.subtitle) this.dom.bannerSub.textContent = this._banner.subtitle;
    b.classList.toggle('dm-banner-nosub', !this._banner.subtitle);
    b.style.opacity = String(op);
  }

  _tickLog() {
    const t = now();
    // Drop fully-faded lines from memory.
    while (this._logLines.length && (t - this._logLines[0].t) / 1000 > 8) this._logLines.shift();
    const visible = this._logLines.slice(-6);
    const els = this.dom.logLines;
    // Oldest at the top, newest at the bottom (closest to the action bar).
    for (let i = 0; i < els.length; i++) {
      const line = visible[i - (els.length - visible.length)];
      const el = els[i];
      if (!line) { if (el.style.opacity !== '0') el.style.opacity = '0'; continue; }
      const age = (t - line.t) / 1000;
      let op = 1;
      if (age > 5) op = Math.max(0, 1 - (age - 5) / 3);
      const txt = line.count > 1 ? `${line.text}  ×${line.count}` : line.text;
      if (el.textContent !== txt) el.textContent = txt;
      // Message color (often pale, tuned for a dark backdrop) becomes an accent
      // stripe rather than the text color, which stays dark for readability.
      if (el.dataset.accent !== line.color) { el.style.setProperty('--dm-log-accent', line.color); el.dataset.accent = line.color; }
      el.style.opacity = String(op);
    }
  }

  _useFirstPotion(kind) {
    const p = this.game && this.game.player;
    if (!p) return;
    const item = (p.inventory || []).find((it) => it && it.potion && it.potion[kind] > 0);
    if (item) useItem(this.game, item);
  }

  _skillTooltip(sk, p) {
    const cost = sk.manaCost ? `<span class="tt-pill tt-pill-mana">💧 ${sk.manaCost} mana</span>` : '<span class="tt-pill">No cost</span>';
    const cd = sk.baseCooldown ? `<span class="tt-pill">⏱ ${(+sk.baseCooldown).toFixed(1)}s</span>` : '';
    return `<div class="tt-title">${sk.icon || ''} ${sk.name || ''} <span class="tt-rank">Rank ${sk.rank}/${sk.maxRank}</span></div>`
      + `<div class="tt-body">${skillDescription(sk, p)}</div><div class="tt-pills">${cost}${cd}</div>`;
  }

  // ---------------------------------------------------------------------
  // Controller-style-dependent labels: the once-built controls tables (title/pause)
  // and the always-visible death/pause hints show both keyboard AND pad instructions
  // regardless of lastDevice, so they only need to re-label when padStyle itself changes.
  // ---------------------------------------------------------------------
  _updateControllerLabels() {
    const style = (this.input && this.input.padStyle) || 'xbox';
    if (this._cache.padStyle === style) return;
    this._cache.padStyle = style;
    relabelPadEls(this._padEls, style);
    const d = this.dom;
    if (d.pauseResumeHint) d.pauseResumeHint.textContent = `Esc / P / ${padLabel('Start', style)} to resume · U to mute sound`;
    if (d.deathRetryHint) d.deathRetryHint.textContent = `Press Enter / ${padLabel('A', style)} to try again`;
    // The gamepad-only hints below cache on `gamepad` alone (see _updateDeviceHints); force
    // them to recompute now that the style under that cached gamepad state has changed.
    this._cache.gamepad = undefined;
  }

  // ---------------------------------------------------------------------
  // Device-dependent key hints
  // ---------------------------------------------------------------------
  _updateDeviceHints() {
    const gamepad = !!(this.input && this.input.lastDevice === 'gamepad');
    if (this._cache.gamepad === gamepad) return;
    this._cache.gamepad = gamepad;
    const style = (this.input && this.input.padStyle) || 'xbox';
    const d = this.dom;
    d.btnCKey.textContent = gamepad ? padLabel('LB', style) : 'C';
    d.btnIKey.textContent = gamepad ? padLabel('RB', style) : 'I';
    d.potHeal.key.textContent = gamepad ? padLabel('LT', style) : 'H';
    d.potMana.key.textContent = gamepad ? padLabel('RT', style) : 'M';
    for (const shell of [d.charShell, d.invShell]) {
      shell.tabKeys[0].textContent = gamepad ? padLabel('LB', style) : 'C';
      shell.tabKeys[1].textContent = gamepad ? padLabel('RB', style) : 'I';
    }
    for (let i = 0; i < 4; i++) {
      const k = d.charSkillRows[i].key;
      const key = gamepad ? padLabel(SKILL_PAD_LABEL[i], style) : SKILL_KEY_LABEL[i];
      k.textContent = key;
      k.style.color = gamepad ? (PAD_COLOR[key] || '') : '';
    }
    const hint = (pairs) => pairs.map(([k, a]) => `<span class="dm-foot-item"><span class="dm-kbd">${k}</span>${a}</span>`).join('');
    const lbrb = `${padLabel('LB', style)} / ${padLabel('RB', style)}`;
    d.charShell.foot.innerHTML = gamepad
      ? hint([['D-pad ↑↓', 'Navigate'], ['D-pad ←→', 'Attributes / Skills'], [padLabel('A', style), 'Spend point'], [lbrb, 'Switch tab'], [padLabel('B', style), 'Close']])
      : hint([['Click +', 'Spend point'], ['↑↓', 'Navigate'], ['←→', 'Attributes / Skills'], ['Enter', 'Spend'], ['I', 'Inventory'], ['Esc', 'Close']]);
    d.invShell.foot.innerHTML = gamepad
      ? hint([['D-pad', 'Navigate'], [padLabel('A', style), 'Equip / Use'], [padLabel('Y', style), 'Equip upgrades'], [padLabel('X', style), 'Drop'], [lbrb, 'Switch tab'], [padLabel('B', style), 'Close']])
      : hint([['Click', 'Equip / Use'], ['R', 'Equip upgrades'], ['Q / Right-click', 'Drop'], ['Shift+Click', 'Salvage for gold'], ['Esc', 'Close']]);
    d.invUpBtnKey.textContent = gamepad ? padLabel('Y', style) : 'R';
  }

  // ---------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------
  _updateHud(game, dt) {
    const p = game.player;
    const c = this._cache;
    const d = this.dom;

    // HP bar + delayed "damage trail" that drains after a short hold.
    const hpPct = clamp(p.hp / Math.max(1, p.stats.maxHp), 0, 1);
    const hpStr = `${Math.max(0, Math.ceil(p.hp))} / ${Math.round(p.stats.maxHp)}`;
    if (c.hpPct !== hpPct) {
      if (c.hpPct != null && hpPct < c.hpPct) this._hpTrailHold = 0.45;
      if (c.hpPct != null && hpPct > c.hpPct + 0.02) flash(d.hp.bar, 'dm-heal-flash');
      d.hp.fill.style.width = `${hpPct * 100}%`;
      c.hpPct = hpPct;
    }
    if (this._hpTrail < hpPct) this._hpTrail = hpPct;
    else if (this._hpTrail > hpPct) {
      if (this._hpTrailHold > 0) this._hpTrailHold -= dt;
      else this._hpTrail = Math.max(hpPct, this._hpTrail - dt * 0.6);
    }
    const trailKey = this._hpTrail.toFixed(3);
    if (c.hpTrail !== trailKey) { d.hp.trail.style.width = `${this._hpTrail * 100}%`; c.hpTrail = trailKey; }
    if (c.hpStr !== hpStr) { d.hp.text.textContent = hpStr; c.hpStr = hpStr; }

    const manaPct = clamp(p.mana / Math.max(1, p.stats.maxMana), 0, 1);
    const manaStr = `${Math.floor(p.mana)} / ${Math.round(p.stats.maxMana)}`;
    if (c.manaPct !== manaPct) {
      d.mana.fill.style.width = `${manaPct * 100}%`;
      d.mana.trail.style.width = `${manaPct * 100}%`;
      c.manaPct = manaPct;
    }
    if (c.manaStr !== manaStr) { d.mana.text.textContent = manaStr; c.manaStr = manaStr; }

    // Low HP vignette + pulsing bar.
    const lowHp = hpPct < 0.3 && p.hp > 0;
    if (lowHp !== this._lowHpActive) {
      this._lowHpActive = lowHp;
      d.vignette.classList.toggle('dm-active', lowHp);
      d.hp.bar.classList.toggle('dm-critical', lowHp);
    }

    // Brief red pulse on the separate hit-vignette element, triggered by pulseHit().
    if (this._hitFlashTimer > 0) {
      this._hitFlashTimer = Math.max(0, this._hitFlashTimer - dt);
      const t = this._hitFlashTimer / HIT_VIGNETTE_DURATION; // 1 -> 0
      d.hitVignette.style.opacity = String(this._hitFlashPeak * HIT_VIGNETTE_MAX_OPACITY * t * t);
      if (this._hitFlashTimer <= 0) this._hitFlashPeak = 0;
    }

    // XP: dock bar + level ring on the player plate.
    const need = xpForLevel(p.level);
    const xpPct = clamp(p.xp / Math.max(1, need), 0, 1);
    const xpStr = `Level ${p.level} · ${Math.floor(p.xp)} / ${need} XP`;
    if (c.xpPct !== xpPct) {
      d.xpFill.style.width = `${xpPct * 100}%`;
      d.lvl.style.setProperty('--xp', `${xpPct * 360}deg`);
      c.xpPct = xpPct;
    }
    if (c.xpStr !== xpStr) { d.xpText.textContent = xpStr; c.xpStr = xpStr; }
    if (c.level !== p.level) {
      if (c.level != null && p.level > c.level) flash(d.lvl, 'dm-bump');
      d.lvlNum.textContent = String(p.level);
      c.level = p.level;
    }

    // Top-left.
    const depthStr = `Depth ${game.depth}`;
    if (c.depthStr !== depthStr) { d.depthText.textContent = depthStr; c.depthStr = depthStr; }
    const gold = p.gold || 0;
    if (c.gold !== gold) {
      if (c.gold != null && gold > c.gold) flash(d.goldChip, 'dm-bump');
      d.goldText.textContent = gold.toLocaleString();
      c.gold = gold;
    }
    const killsStr = String((game.stats && game.stats.kills) || 0);
    if (c.killsStr !== killsStr) { d.killsText.textContent = killsStr; c.killsStr = killsStr; }

    // Unspent points.
    const totalPts = (p.attrPoints || 0) + (p.skillPoints || 0);
    const gamepad = !!(this.input && this.input.lastDevice === 'gamepad');
    const style = (this.input && this.input.padStyle) || 'xbox';
    const ptsStr = totalPts > 0 ? `✦ ${totalPts} point${totalPts === 1 ? '' : 's'} to spend · ${gamepad ? padLabel('LB', style) : 'C'}` : '';
    if (c.ptsStr !== ptsStr) {
      d.pointsPill.textContent = ptsStr;
      d.pointsPill.classList.toggle('dm-show', totalPts > 0);
      d.plusC.classList.toggle('dm-show', totalPts > 0);
      c.ptsStr = ptsStr;
    }

    // Bag capacity.
    const used = (p.inventory || []).filter(Boolean).length;
    const bagStr = `${used}/${INVENTORY_SIZE}`;
    if (c.bagStr !== bagStr) {
      d.bagCount.textContent = bagStr;
      d.bagCount.classList.toggle('dm-full', used >= INVENTORY_SIZE);
      c.bagStr = bagStr;
    }

    // Skill slots.
    const skills = p.skills || [];
    for (let i = 0; i < 4; i++) {
      const dom = d.skillSlots[i];
      const sk = skills[i];
      const key = gamepad ? padLabel(SKILL_PAD_LABEL[i], style) : SKILL_KEY_LABEL[i];
      const ck = `skill${i}`;
      if (c[ck + 'key'] !== key) {
        dom.key.textContent = key;
        dom.key.style.color = gamepad ? (PAD_COLOR[key] || '') : '';
        c[ck + 'key'] = key;
      }
      if (!sk) { if (c[ck + 'icon'] !== '') { dom.icon.textContent = ''; c[ck + 'icon'] = ''; } continue; }
      if (c[ck + 'icon'] !== sk.icon) { dom.icon.textContent = sk.icon; c[ck + 'icon'] = sk.icon; }
      const costStr = sk.manaCost ? String(sk.manaCost) : '';
      if (c[ck + 'cost'] !== costStr) {
        dom.cost.textContent = costStr;
        dom.cost.style.display = costStr ? '' : 'none';
        c[ck + 'cost'] = costStr;
      }
      const frac = clamp((sk.cooldown || 0) / Math.max(0.001, sk.baseCooldown || 1), 0, 1);
      const cdKey = frac.toFixed(3);
      if (c[ck + 'cd'] !== cdKey) {
        dom.sweep.style.background = frac > 0
          ? `conic-gradient(rgba(20,24,40,0.72) ${frac * 360}deg, transparent ${frac * 360}deg)`
          : 'none';
        c[ck + 'cd'] = cdKey;
      }
      const onCd = sk.cooldown > 0.05;
      const cdText = onCd ? (sk.cooldown >= 10 ? Math.ceil(sk.cooldown).toString() : sk.cooldown.toFixed(1)) : '';
      if (c[ck + 'cdtext'] !== cdText) { dom.cdText.textContent = cdText; c[ck + 'cdtext'] = cdText; }
      if (c[ck + 'oncd'] !== onCd) {
        if (c[ck + 'oncd'] && !onCd) flash(dom.slot, 'dm-ready-flash');
        dom.slot.classList.toggle('dm-oncd', onCd);
        c[ck + 'oncd'] = onCd;
      }
      const noMana = p.mana < (sk.manaCost || 0) || p.dead;
      if (c[ck + 'grey'] !== noMana) { dom.slot.classList.toggle('dm-noafford', noMana); c[ck + 'grey'] = noMana; }
    }

    // Potion counts.
    let healCount = 0, manaCount = 0;
    for (const it of (p.inventory || [])) {
      if (it && it.potion) {
        if (it.potion.heal) healCount += it.stack || 1;
        if (it.potion.mana) manaCount += it.stack || 1;
      }
    }
    if (c.healCount !== healCount) {
      d.potHeal.count.textContent = String(healCount);
      d.potHeal.btn.classList.toggle('dm-empty', healCount === 0);
      c.healCount = healCount;
    }
    if (c.manaCount !== manaCount) {
      d.potMana.count.textContent = String(manaCount);
      d.potMana.btn.classList.toggle('dm-empty', manaCount === 0);
      c.manaCount = manaCount;
    }

    // Minimap (throttled ~10Hz).
    const t = now();
    const mapChanged = game.map !== this._lastMapRef;
    if (mapChanged || t - this._lastMinimapDraw > 100) {
      this._lastMinimapDraw = t;
      this._lastMapRef = game.map;
      this._drawMinimap(game);
    }
  }

  _drawMinimap(game) {
    const map = game.map;
    const ctx = this.dom.ctx;
    const W = this.dom.canvas.width, H = this.dom.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!map) return;
    // Fit the view to the explored region (at least MIN_SPAN tiles across) so
    // the map stays readable early in a level instead of a tiny speck.
    const MIN_SPAN = 28;
    let x0 = map.width, y0 = map.height, x1 = -1, y1 = -1;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!map.explored[map.idx ? map.idx(x, y) : y * map.width + x]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = map.width - 1; y1 = map.height - 1; }
    const span = Math.max(MIN_SPAN, x1 - x0 + 3, y1 - y0 + 3);
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
    const pad = 8;
    const scale = (Math.min(W, H) - pad * 2) / span;
    const offX = W / 2 - cx * scale;
    const offY = H / 2 - cy * scale;
    const cell = Math.max(1, Math.ceil(scale));

    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const idx = map.idx ? map.idx(x, y) : y * map.width + x;
        if (!map.explored[idx]) continue;
        const visible = !!map.visible[idx];
        const tile = map.tiles[idx];
        let color;
        // Floors read as warm sand, walls as cool slate; unlit areas are washed out.
        if (tile === TILE.WALL) color = visible ? '#4b5468' : 'rgba(120,130,150,0.75)';
        else color = visible ? '#ffe39a' : 'rgba(226,216,190,0.8)';
        ctx.fillStyle = color;
        ctx.fillRect(offX + x * scale, offY + y * scale, cell, cell);
      }
    }

    // Entrance.
    if (map.entrance) {
      ctx.fillStyle = 'rgba(34,184,207,0.95)';
      ctx.fillRect(offX + map.entrance.x * scale - 1, offY + map.entrance.y * scale - 1, cell + 2, cell + 2);
    }

    // Exits (pulsing ring).
    const pulse = 0.5 + 0.5 * Math.sin((game.time || 0) * 4);
    if (Array.isArray(map.exits)) {
      for (const ex of map.exits) {
        const exIdx = map.idx ? map.idx(ex.x, ex.y) : ex.y * map.width + ex.x;
        if (!map.explored[exIdx]) continue;
        const cx = offX + ex.x * scale + cell / 2, cy = offY + ex.y * scale + cell / 2;
        ctx.strokeStyle = `rgba(247,103,7,${0.35 + 0.4 * pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, cell * (1.8 + pulse * 1.2), 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#f76707';
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(2.5, cell * 1.2), 0, Math.PI * 2); ctx.fill();
      }
    }

    // Merchant (once its tile has been explored).
    for (const n of (game.npcs || [])) {
      if (!n || n.type !== 'merchant') continue;
      const nIdx = map.idx ? map.idx(n.x, n.y) : n.y * map.width + n.x;
      if (!map.explored[nIdx]) continue;
      const nx = offX + n.x * scale + cell / 2, ny = offY + n.y * scale + cell / 2;
      const nr = Math.max(2.2, cell * 0.75);
      ctx.fillStyle = '#5c3c00';
      ctx.beginPath(); ctx.arc(nx, ny, nr + 1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd43b';
      ctx.beginPath(); ctx.arc(nx, ny, nr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5c3c00';
      ctx.font = `${Math.max(6, cell * 1.1)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('$', nx, ny + 0.5);
    }

    // Enemies (visible & living only).
    for (const e of (game.enemies || [])) {
      if (!e || e.dead) continue;
      const eIdx = map.idx ? map.idx(e.x, e.y) : e.y * map.width + e.x;
      if (!map.visible[eIdx]) continue;
      const ex = offX + e.x * scale + cell / 2, ey = offY + e.y * scale + cell / 2;
      const er = Math.max(1.8, cell * (e.behavior === 'boss' ? 1.1 : 0.6));
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ex, ey, er + 1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = e.behavior === 'boss' ? '#9c36b5' : '#e03131';
      ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.fill();
    }

    // Player, with a small facing wedge.
    const p = game.player;
    if (p) {
      const px = offX + (p.fx ?? p.x) * scale + cell / 2, py = offY + (p.fy ?? p.y) * scale + cell / 2, pr = Math.max(2.5, cell * 0.8);
      const f = p.aim || p.facing || { x: 0, y: 1 };
      ctx.fillStyle = 'rgba(28,126,214,0.35)';
      ctx.beginPath();
      ctx.moveTo(px, py);
      const a = Math.atan2(f.y, f.x);
      ctx.arc(px, py, pr * 3.2, a - 0.55, a + 0.55);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(px, py, pr + 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1c7ed6';
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------------------------------------------------------------------
  // Character panel
  // ---------------------------------------------------------------------
  _spendAttr(attrId) {
    const p = this.game && this.game.player;
    if (!p) return;
    if (spendAttribute(p, attrId)) {
      const row = this.dom.attrRows.find((r) => r.attr.id === attrId);
      if (row) flash(row.value, 'dm-bump');
      this._refreshCharacterPanel();
    }
  }

  _upgradeSkill(index) {
    const p = this.game && this.game.player;
    if (!p) return;
    if (upgradeSkill(p, index)) {
      const row = this.dom.charSkillRows[index];
      if (row) flash(row.icon, 'dm-bump');
      this._refreshCharacterPanel();
    }
  }

  // Writes formatted derived stats into whichever of `rows` (k -> value element) exist.
  _fillDerived(rows, s) {
    for (const k in rows) {
      const el = rows[k], v = derivedText(k, s);
      if (el.textContent !== v) el.textContent = v;
      el.classList.remove('dm-up', 'dm-down');
    }
  }

  _refreshCharacterPanel() {
    const p = this.game && this.game.player;
    if (!p) return;
    const d = this.dom;
    const need = xpForLevel(p.level);
    d.charLvlText.textContent = `Level ${p.level}`;
    d.charXpText.textContent = `${Math.floor(p.xp)} / ${need} XP`;
    d.charXpFill.style.width = `${clamp(p.xp / Math.max(1, need), 0, 1) * 100}%`;

    const ap = p.attrPoints || 0, sp = p.skillPoints || 0;
    d.attrPoints.textContent = ap > 0 ? `${ap} point${ap === 1 ? '' : 's'}` : '';
    d.attrPoints.classList.toggle('dm-show', ap > 0);
    d.skillPoints.textContent = sp > 0 ? `${sp} point${sp === 1 ? '' : 's'}` : '';
    d.skillPoints.classList.toggle('dm-show', sp > 0);

    for (const row of d.attrRows) {
      const v = String(p.base[row.attr.id]);
      if (row.value.textContent !== v) row.value.textContent = v;
      row.row.classList.toggle('dm-can-spend', ap > 0);
    }

    this._fillDerived(d.derivedRows, p.stats);

    const skills = p.skills || [];
    for (let i = 0; i < d.charSkillRows.length; i++) {
      const row = d.charSkillRows[i];
      const sk = skills[i];
      if (!sk) continue;
      if (row.icon.firstChild && row.icon.firstChild.nodeType === 3) {
        if (row.icon.firstChild.nodeValue !== sk.icon) row.icon.firstChild.nodeValue = sk.icon || '';
      } else {
        row.icon.insertBefore(document.createTextNode(sk.icon || ''), row.icon.firstChild);
      }
      if (row.name.textContent !== sk.name) row.name.textContent = sk.name || '';
      if (row.pipEls.length !== sk.maxRank) {
        row.pips.textContent = '';
        row.pipEls = [];
        for (let r = 0; r < sk.maxRank; r++) row.pipEls.push(mk('i', 'dm-pip', row.pips));
      }
      row.pipEls.forEach((el, r) => el.classList.toggle('dm-on', r < sk.rank));
      row.pips.title = `Rank ${sk.rank} / ${sk.maxRank}`;
      const desc = skillDescription(sk, p);
      if (row._desc !== desc) { row.desc.innerHTML = desc; row._desc = desc; }
      const canUp = sp > 0 && sk.rank < sk.maxRank;
      const maxed = sk.rank >= sk.maxRank;
      row.upgradeBtn.textContent = maxed ? 'Max' : 'Upgrade';
      row.upgradeBtn.disabled = !canUp;
      row.upgradeBtn.classList.toggle('dm-maxed', maxed);
      row.row.classList.toggle('dm-can-spend', canUp);
    }

    this._applyCharacterFocus();
  }

  _applyCharacterFocus() {
    const focusables = this._charFocusList();
    for (let i = 0; i < focusables.length; i++) {
      focusables[i].el.classList.toggle('dm-focused', i === this._charCursor);
    }
  }

  _charFocusList() {
    const list = this.dom.attrRows.map((r) => ({ el: r.row, kind: 'attr', ref: r }));
    for (const r of this.dom.charSkillRows) list.push({ el: r.row, kind: 'skill', ref: r });
    return list;
  }

  // ---------------------------------------------------------------------
  // Inventory panel
  // ---------------------------------------------------------------------
  _clickPaperdoll(index) {
    const p = this.game && this.game.player;
    if (!p) return;
    const slotDef = SLOTS[index];
    if (p.equipment[slotDef.id]) {
      unequipItem(p, slotDef.id);
      this._hideTooltip();
      this._refreshInventoryPanel();
    }
  }

  _hoverPaperdoll(index, e) {
    const p = this.game && this.game.player;
    if (!p) return;
    const slotDef = SLOTS[index];
    const item = p.equipment[slotDef.id];
    if (item) {
      this._showTooltip(null, itemTooltip(item, p) + '<div class="tt-action">Click to unequip</div>');
      this._positionTooltip(e.clientX, e.clientY);
    }
  }

  _clickInvCell(index, e) {
    const p = this.game && this.game.player;
    if (!p) return;
    const item = p.inventory[index];
    if (!item) return;
    if (e && e.shiftKey) {
      const value = sellValue(item);
      p.gold = (p.gold || 0) + value;
      p.inventory.splice(index, 1);
      this.log(`Salvaged ${item.name} for ${value}g.`, '#f08c00');
    } else if (item.type === 'potion') {
      useItem(this.game, item);
    } else {
      equipItem(p, item);
      const slot = this.dom.eqSlots.find((s) => s.slotDef.id === item.slot);
      if (slot) flash(slot.el, 'dm-bump');
    }
    this._hideTooltip();
    this._previewItem = null;
    this._refreshInventoryPanel();
  }

  _dropInvCell(index) {
    const p = this.game && this.game.player;
    if (!p) return;
    const item = p.inventory[index];
    if (!item) return;
    dropItem(this.game, item);
    this._hideTooltip();
    this._refreshInventoryPanel();
  }

  _hoverInvCell(index, e) {
    const p = this.game && this.game.player;
    if (!p) return;
    const item = p.inventory[index];
    if (item) {
      const action = item.type === 'potion' ? 'Click to drink' : 'Click to equip';
      this._showTooltip(null, itemTooltip(item, p) + `<div class="tt-action">${action} · Right-click to drop · Shift+click to salvage</div>`);
      this._positionTooltip(e.clientX, e.clientY);
    }
    this._previewGear(item || null);
  }

  // Gear Stats list under the backpack: show "now → with item" for the hovered/focused bag item.
  _previewGear(item) {
    const p = this.game && this.game.player;
    if (!p) return;
    this._previewItem = item;
    const gc = item ? compareGear(item, p) : null;
    const rows = this.dom.gearStatRows;
    for (const k of GEAR_STATS) {
      const el = rows[k];
      const now = derivedText(k, p.stats);
      const next = gc ? derivedText(k, gc.after) : now;
      const dir = next === now ? 0 : Math.sign(derivedValue(k, gc.after) - derivedValue(k, p.stats));
      const txt = dir ? `${now} → ${next}` : now;
      if (el.textContent !== txt) el.textContent = txt;
      el.classList.toggle('dm-up', dir > 0);
      el.classList.toggle('dm-down', dir < 0);
    }
  }

  _quickEquip() {
    const p = this.game && this.game.player;
    if (!p) return;
    const done = equipUpgrades(p);
    this._hideTooltip();
    this._previewItem = null;
    if (done.length) {
      for (const item of done) {
        const slot = this.dom.eqSlots.find((s) => s.slotDef.id === item.slot);
        if (slot) flash(slot.el, 'dm-bump');
      }
      this.log(done.length === 1 ? `Equipped ${done[0].name}.` : `Equipped ${done.length} upgrades.`, '#51cf66');
    } else {
      this.log('No upgrades in your bag.', '#9aa3bd');
    }
    this._refreshInventoryPanel();
  }

  _refreshInventoryPanel() {
    const p = this.game && this.game.player;
    if (!p) return;
    const d = this.dom;
    const goldStr = `🪙 ${(p.gold || 0).toLocaleString()}`;
    if (d.invGoldText.textContent !== goldStr) d.invGoldText.textContent = goldStr;
    const used = (p.inventory || []).filter(Boolean).length;
    const capStr = `${used} / ${INVENTORY_SIZE}`;
    if (d.invCapText.textContent !== capStr) d.invCapText.textContent = capStr;
    d.invCapText.classList.toggle('dm-full', used >= INVENTORY_SIZE);

    for (const s of d.eqSlots) {
      const item = p.equipment[s.slotDef.id];
      const icon = item ? item.icon : (s.slotDef.icon || '?');
      if (s.icon.textContent !== icon) s.icon.textContent = icon;
      const rc = item ? rarityBorderColor(item) : '';
      s.el.style.borderColor = rc;
      s.el.style.setProperty('--item-glow', rc || 'transparent');
      s.el.classList.toggle('dm-filled', !!item);
    }

    let upgrades = 0;
    for (let i = 0; i < d.invCells.length; i++) {
      const cellDom = d.invCells[i];
      const item = p.inventory[i];
      if (!item) {
        if (cellDom.iconKey) { cellDom.icon.textContent = ''; cellDom.iconKey = ''; }
        if (cellDom.stack.textContent) cellDom.stack.textContent = '';
        cellDom.cell.style.borderColor = '';
        cellDom.cell.classList.remove('dm-filled');
        setCmpBadge(cellDom.cmp, null);
        continue;
      }
      // Potions use the drawn flask (red/blue); everything else keeps its emoji icon.
      const potionKind = potionKindOf(item);
      const iconKey = potionKind ? `potion:${potionKind}` : (item.icon || '?');
      if (cellDom.iconKey !== iconKey) {
        if (potionKind) cellDom.icon.innerHTML = potionIconSvg(potionKind);
        else cellDom.icon.textContent = iconKey;
        cellDom.iconKey = iconKey;
      }
      const stack = (item.stack && item.stack > 1) ? String(item.stack) : '';
      if (cellDom.stack.textContent !== stack) cellDom.stack.textContent = stack;
      const rc = rarityBorderColor(item);
      cellDom.cell.style.borderColor = rc;
      cellDom.cell.style.setProperty('--item-glow', rc);
      cellDom.cell.classList.add('dm-filled');
      const gc = compareGear(item, p);
      setCmpBadge(cellDom.cmp, gc);
      if (gc && gc.verdict === 'up') upgrades++;
    }
    d.invUpBtn.disabled = upgrades === 0;

    this._fillDerived(d.gearStatRows, p.stats);
    this._previewGear(this._previewItem && p.inventory.includes(this._previewItem) ? this._previewItem : null);
    this._applyInventoryFocus();
  }

  _applyInventoryFocus() {
    for (const s of this.dom.eqSlots) s.el.classList.remove('dm-focused');
    for (const c of this.dom.invCells) c.cell.classList.remove('dm-focused');
    if (this._invCursor.area === 'paperdoll') {
      const s = this.dom.eqSlots[this._invCursor.index];
      if (s) s.el.classList.add('dm-focused');
    } else {
      const c = this.dom.invCells[this._invCursor.index];
      if (c) c.cell.classList.add('dm-focused');
    }
  }

  // =====================================================================
  // Shop panel
  // =====================================================================
  _setShopTab(tab) {
    if (this._shopTab === tab) return;
    this._shopTab = tab;
    this._shopCursor = 0;
    this._lastShopCursorKey = this._initialShopCursorKey();
    this.dom.shopTabBuy.classList.toggle('dm-tab-active', tab === 'buy');
    this.dom.shopTabSell.classList.toggle('dm-tab-active', tab === 'sell');
    this._hideTooltip();
    sfx.uiClick();
    this._refreshShopPanel();
  }

  _shopBuyList() {
    const m = this._shopMerchant;
    if (!m || !m.stock) return [];
    const list = [];
    if (m.stock.featured) list.push({ kind: 'featured', index: 0, item: m.stock.featured });
    if (m.stock.heal) list.push({ kind: 'heal', index: 0, item: m.stock.heal });
    if (m.stock.mana) list.push({ kind: 'mana', index: 0, item: m.stock.mana });
    m.stock.gear.forEach((item, i) => list.push({ kind: 'gear', index: i, item }));
    return list;
  }

  _shopSellList() {
    const p = this.game && this.game.player;
    if (!p) return [];
    const list = [];
    (p.inventory || []).forEach((item, i) => { if (item) list.push({ kind: 'sell', index: i, item }); });
    return list;
  }

  _shopEntryPrice(entry) {
    return this._shopTab === 'buy' ? shopPrice(entry.kind, entry.item) : sellValue(entry.item);
  }

  _clickShopCell(i) {
    const entry = this._shopList[i];
    if (!entry) return;
    if (this._shopTab === 'buy') this._buyShopEntry(entry);
    else this._sellShopEntry(entry);
  }

  _buyShopEntry(entry) {
    const res = buyFromMerchant(this.game, this._shopMerchant, entry.kind, entry.index);
    if (res.ok) {
      this.log(`Bought ${res.item.name} for ${res.price}g.`, '#2f9e44');
      this.game.bus.emit('itemBought', { item: res.item, price: res.price });
    } else {
      const p = this.game.player;
      const msg = res.reason === 'full' ? 'Your bag is full' : res.reason === 'gold' ? 'Not enough gold' : 'Sold out';
      this.game.floatText(p.x, p.y, msg, '#ff9955');
      this.game.bus.emit('denied');
    }
    this._hideTooltip();
    this._refreshShopPanel();
  }

  _sellShopEntry(entry) {
    const res = sellToMerchant(this.game, entry.index);
    if (res.ok) {
      this.log(`Sold ${res.item.name} for ${res.price}g.`, '#2f9e44');
      this.game.bus.emit('itemSold', { item: res.item, price: res.price });
    }
    this._hideTooltip();
    this._refreshShopPanel();
  }

  _hoverShopCell(i, e) {
    const entry = this._shopList[i];
    if (!entry) return;
    const p = this.game && this.game.player;
    const label = this._shopTab === 'buy' ? `Buy for ${this._shopEntryPrice(entry)}g` : `Sell for ${this._shopEntryPrice(entry)}g`;
    this._showTooltip(null, itemTooltip(entry.item, p) + `<div class="tt-action">${label}</div>`);
    this._positionTooltip(e.clientX, e.clientY);
  }

  _refreshShopPanel() {
    const p = this.game && this.game.player;
    const m = this._shopMerchant;
    if (!p || !m) return;
    const d = this.dom;
    const goldStr = `🪙 ${(p.gold || 0).toLocaleString()}`;
    if (d.shopGoldText.textContent !== goldStr) d.shopGoldText.textContent = goldStr;

    const list = this._shopTab === 'buy' ? this._shopBuyList() : this._shopSellList();
    this._shopList = list;
    const gold = p.gold || 0;

    for (let i = 0; i < d.shopCells.length; i++) {
      const cellDom = d.shopCells[i];
      const entry = list[i];
      if (!entry) {
        cellDom.cell.style.display = 'none';
        continue;
      }
      cellDom.cell.style.display = '';
      const item = entry.item;
      const potionKind = potionKindOf(item);
      if (potionKind) cellDom.icon.innerHTML = potionIconSvg(potionKind);
      else cellDom.icon.textContent = item.icon || '?';
      const rc = rarityBorderColor(item);
      cellDom.cell.style.borderColor = rc;
      cellDom.cell.style.setProperty('--item-glow', rc);
      cellDom.cell.classList.add('dm-filled');
      cellDom.cell.classList.toggle('dm-shop-featured', entry.kind === 'featured');
      const stack = (this._shopTab === 'sell' && item.stack && item.stack > 1) ? String(item.stack) : '';
      cellDom.stack.textContent = stack;
      const price = this._shopEntryPrice(entry);
      cellDom.price.textContent = `${price}g`;
      setCmpBadge(cellDom.cmp, this._shopTab === 'buy' ? compareGear(item, p) : null);
      const noAfford = this._shopTab === 'buy' && gold < price;
      cellDom.cell.classList.toggle('dm-shop-noafford', noAfford);
    }
    this._applyShopFocus();
    this._updateShopFoot();
  }

  _updateShopFoot() {
    const gamepad = !!(this.input && this.input.lastDevice === 'gamepad');
    const style = (this.input && this.input.padStyle) || 'xbox';
    const hint = (pairs) => pairs.map(([k, a]) => `<span class="dm-foot-item"><span class="dm-kbd">${k}</span>${a}</span>`).join('');
    const text = gamepad
      ? hint([['D-pad', 'Navigate'], [padLabel('A', style), this._shopTab === 'buy' ? 'Buy' : 'Sell'], [`${padLabel('LB', style)} / ${padLabel('RB', style)}`, 'Switch tab'], [padLabel('B', style), 'Close']])
      : hint([['Click', this._shopTab === 'buy' ? 'Buy' : 'Sell'], ['Arrows', 'Navigate'], ['Enter', this._shopTab === 'buy' ? 'Buy' : 'Sell'], ['Tab', 'Switch tab'], ['Esc', 'Close']]);
    if (this.dom.shopFoot.innerHTML !== text) this.dom.shopFoot.innerHTML = text;
  }

  // Cursor key that counts as "tooltip already shown" for a freshly opened shop / tab: null for gamepad
  // (show it right away), the first cell for keyboard/mouse (wait until the cursor actually moves).
  _initialShopCursorKey() {
    return this.input && this.input.lastDevice === 'gamepad' ? null : `${this._shopTab}:0`;
  }

  _applyShopFocus() {
    for (const c of this.dom.shopCells) c.cell.classList.remove('dm-focused');
    const c = this.dom.shopCells[this._shopCursor];
    if (c && c.cell.style.display !== 'none') c.cell.classList.add('dm-focused');
  }

  _handleShopInput(input) {
    // LB/RB (tab_prev/tab_next) and the keyboard Inventory key (I / Tab) both cycle Buy/Sell —
    // the shop has no separate panel to switch to, so that hotkey is repurposed here.
    if (input.pressed('tab_prev') || input.pressed('tab_next') || input.pressed('inventory')) {
      this._setShopTab(this._shopTab === 'buy' ? 'sell' : 'buy');
      return;
    }

    const list = this._shopList;
    if (!list.length) return;
    const cols = INV_COLS;
    const rows = Math.max(1, Math.ceil(list.length / cols));
    let row = Math.floor(this._shopCursor / cols), col = this._shopCursor % cols;
    if (input.pressed('ui_left')) col = Math.max(0, col - 1);
    if (input.pressed('ui_right')) col = Math.min(cols - 1, col + 1);
    if (input.pressed('ui_up')) row = Math.max(0, row - 1);
    if (input.pressed('ui_down')) row = Math.min(rows - 1, row + 1);
    this._shopCursor = clamp(row * cols + col, 0, list.length - 1);
    this._applyShopFocus();

    const cursorKey = `${this._shopTab}:${this._shopCursor}`;
    if (cursorKey !== this._lastShopCursorKey) {
      this._lastShopCursorKey = cursorKey;
      const entry = list[this._shopCursor];
      const cellDom = this.dom.shopCells[this._shopCursor];
      if (entry && cellDom) {
        const p = this.game.player;
        const label = this._shopTab === 'buy' ? `Buy for ${this._shopEntryPrice(entry)}g` : `Sell for ${this._shopEntryPrice(entry)}g`;
        this._showTooltip(cellDom.cell, itemTooltip(entry.item, p) + `<div class="tt-action">${label}</div>`);
      } else this._hideTooltip();
    }

    if (input.pressed('confirm')) {
      this._clickShopCell(this._shopCursor);
      this._lastShopCursorKey = null;
    }
  }

  // =====================================================================
  // Tooltip
  // =====================================================================
  _showTooltip(el, html, placement) {
    const tip = this.dom.tooltip;
    tip.innerHTML = html;
    tip.classList.add('dm-show');
    if (el) {
      const r = el.getBoundingClientRect();
      if (placement === 'above') {
        const t = tip.getBoundingClientRect();
        const left = clamp(r.left + r.width / 2 - t.width / 2, 12, window.innerWidth - t.width - 12);
        tip.style.left = `${left}px`;
        tip.style.top = `${Math.max(12, r.top - t.height - 10)}px`;
      } else {
        this._positionTooltip(r.right, r.top);
      }
    }
  }

  _hideTooltip() {
    this.dom.tooltip.classList.remove('dm-show');
  }

  _positionTooltip(x, y) {
    const tip = this.dom.tooltip;
    const pad = 14;
    const rect = tip.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + rect.width > window.innerWidth - pad) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = y - rect.height - pad;
    left = Math.max(pad, left);
    top = Math.max(pad, top);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  // =====================================================================
  // Keyboard / gamepad navigation while a panel is open.
  // =====================================================================
  handleInput(game, input) {
    this.game = game;
    this.input = input;

    if (input.pressed('cancel')) { this.closeAll(); return; }

    // Start/P should still pause even while a panel is open (Esc is handled above via
    // 'cancel' and never reaches here, so this never double-fires close+pause on Esc).
    if (input.pressed('pause')) { this.closeAll(); return 'pause'; }

    // The shop is a standalone modal: while it's open, LB/RB/I/Tab switch its own Buy/Sell
    // tabs instead of opening Character/Inventory on top of it.
    if (this._shopOpen) { this._handleShopInput(input); return; }

    // Controller bumpers cycle tabs (checked first: they also map to character/inventory).
    if (input.pressed('tab_prev') || input.pressed('tab_next')) { this._cycleTab(input.pressed('tab_next') ? 1 : -1); return; }
    if (input.pressed('character')) { if (this._characterOpen) this.closeAll(); else this.toggleCharacter(); return; }
    if (input.pressed('inventory')) { if (this._inventoryOpen) this.closeAll(); else this.toggleInventory(); return; }

    if (this._characterOpen) this._handleCharacterInput(input);
    else if (this._inventoryOpen) this._handleInventoryInput(input);
  }

  _handleCharacterInput(input) {
    const list = this._charFocusList();
    if (!list.length) return;
    // Two columns: attributes (left) and skills (right). Up/down move within the current column
    // (wrapping), left/right jump across to the same row of the other column.
    const cur = list[this._charCursor] || list[0];
    const column = (kind) => list.map((e, i) => (e.kind === kind ? i : -1)).filter((i) => i >= 0);
    const col = column(cur.kind);
    const row = Math.max(0, col.indexOf(this._charCursor));
    let next = this._charCursor;
    if (input.pressed('ui_up')) next = col[(row - 1 + col.length) % col.length];
    if (input.pressed('ui_down')) next = col[(row + 1) % col.length];
    // Column jump is a single toggle, not a scroll — ui_left/ui_right auto-repeat while held
    // (same as up/down) would otherwise flip it back and forth every ~120ms on a held press.
    // Only react to the first edge of a hold; re-arm once both directions are released.
    if (!input.held('ui_left') && !input.held('ui_right')) this._charColSwitchArmed = true;
    else if ((input.pressed('ui_left') || input.pressed('ui_right')) && this._charColSwitchArmed) {
      this._charColSwitchArmed = false;
      const other = column(cur.kind === 'attr' ? 'skill' : 'attr');
      if (other.length) next = other[Math.min(row, other.length - 1)];
    }
    if (next !== this._charCursor) { this._charCursor = next; this._applyCharacterFocus(); }
    const focused = list[this._charCursor];
    if (focused && this._lastCharCursor !== this._charCursor) {
      this._lastCharCursor = this._charCursor;
      if (focused.el.scrollIntoView) focused.el.scrollIntoView({ block: 'nearest' });
    }
    if (input.pressed('confirm') && focused) {
      const p = this.game && this.game.player;
      if (!p) return;
      if (focused.kind === 'attr') this._spendAttr(focused.ref.attr.id);
      else this._upgradeSkill(Number(focused.el.dataset.index));
    }
  }

  _handleInventoryInput(input) {
    const cols = INV_COLS;
    const rows = Math.ceil(INVENTORY_SIZE / cols);
    const cur = this._invCursor;

    if (cur.area === 'paperdoll') {
      if (input.pressed('ui_up')) cur.index = Math.max(0, cur.index - 1);
      if (input.pressed('ui_down')) cur.index = Math.min(SLOTS.length - 1, cur.index + 1);
      if (input.pressed('ui_right')) { cur.area = 'grid'; cur.index = 0; }
    } else {
      let col = cur.index % cols, row = Math.floor(cur.index / cols);
      if (input.pressed('ui_left')) { if (col === 0) { cur.area = 'paperdoll'; cur.index = Math.min(SLOTS.length - 1, row); } else col--; }
      if (input.pressed('ui_right')) col = Math.min(cols - 1, col + 1);
      if (input.pressed('ui_up')) row = Math.max(0, row - 1);
      if (input.pressed('ui_down')) row = Math.min(rows - 1, row + 1);
      if (cur.area === 'grid') cur.index = clamp(row * cols + col, 0, INVENTORY_SIZE - 1);
    }
    this._applyInventoryFocus();

    const p = this.game && this.game.player;
    if (!p) return;

    // Tooltip for highlighted item (only re-render when the cursor actually moved).
    const cursorKey = `${cur.area}:${cur.index}`;
    if (cursorKey !== this._lastInvCursorKey) {
      this._lastInvCursorKey = cursorKey;
      if (cur.area === 'paperdoll') {
        const slotDef = SLOTS[cur.index];
        const item = slotDef && p.equipment[slotDef.id];
        const el = this.dom.eqSlots[cur.index] && this.dom.eqSlots[cur.index].el;
        if (item && el) this._showTooltip(el, itemTooltip(item, p)); else this._hideTooltip();
      } else {
        const item = p.inventory[cur.index];
        const el = this.dom.invCells[cur.index] && this.dom.invCells[cur.index].cell;
        if (item && el) this._showTooltip(el, itemTooltip(item, p)); else this._hideTooltip();
      }
      this._previewGear(cur.area === 'grid' ? (p.inventory[cur.index] || null) : null);
    }
    if (input.pressed('quick_equip')) {
      this._quickEquip();
      this._lastInvCursorKey = null;
    }

    if (input.pressed('confirm')) {
      if (cur.area === 'paperdoll') this._clickPaperdoll(cur.index);
      else this._clickInvCell(cur.index);
      this._lastInvCursorKey = null; // contents changed — force tooltip refresh next frame
    }
    if (input.pressed('drop') && cur.area === 'grid') {
      this._dropInvCell(cur.index);
      this._lastInvCursorKey = null;
    }
  }
}

const CSS_TEXT = `
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800;900&display=swap');

#ui { font-family: 'Nunito', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
#ui, #ui * { box-sizing: border-box; }
/* Zero-specificity reset so every .dm-* button class below can style buttons. */
:where(#ui) button { font: inherit; color: inherit; appearance: none; -webkit-appearance: none; background: none; border: none; padding: 0; margin: 0; cursor: pointer; }
#ui .dm-root { position: absolute; inset: 0; overflow: hidden; }

:root {
  --dm-blue: #4dabf7;
  --dm-blue-deep: #1c7ed6;
  --dm-yellow: #ffd43b;
  --dm-yellow-deep: #f08c00;
  --dm-coral: #ff8787;
  --dm-coral-deep: #e8590c;
  --dm-mint: #51cf66;
  --dm-mint-deep: #2f9e44;
  --dm-grape: #b197fc;
  --dm-grape-deep: #7048e8;

  --dm-ink: #232838;          /* dark navy for keycaps, tooltips, bar tracks */
  --dm-ink-soft: #3a4058;
  --dm-card: rgba(255,255,255,0.92);
  --dm-card-solid: #fffdf8;
  --dm-line: rgba(35,40,56,0.10);
  --dm-edge: #d7e3f2;         /* card borders */
  --dm-drop: 0 3px 0 rgba(35,40,56,0.10), 0 10px 24px rgba(35,40,56,0.14);
  --dm-text: #2b2d42;
  --dm-text-dim: #6b7280;
  --dm-gutter: clamp(10px, 2vmin, 22px);
}

.dm-hud { position: absolute; inset: 0; pointer-events: none; transition: opacity 0.3s; }
.dm-hud.dm-hidden { opacity: 0; }

/* ---------- shared bits ---------- */
.dm-kbd {
  display: inline-flex; align-items: center; justify-content: center; min-width: 1.7em; height: 1.7em; padding: 0 0.45em;
  border-radius: 6px; background: var(--dm-ink); color: #ffe8a3; font-weight: 800; font-size: 0.72em; line-height: 1;
  box-shadow: 0 2px 0 #0e1120; font-family: 'Nunito', sans-serif; white-space: nowrap;
}
.dm-kbd-pad { border-radius: 999px; }
@keyframes dm-bump-kf { 0% { transform: scale(1); } 35% { transform: scale(1.18); } 100% { transform: scale(1); } }
.dm-bump { animation: dm-bump-kf 0.35s ease-out; }

/* ---------- top-left player plate ---------- */
.dm-plate {
  position: absolute; top: var(--dm-gutter); left: var(--dm-gutter);
  display: flex; align-items: center; gap: 10px;
  background: var(--dm-card); border: 2px solid var(--dm-edge); border-radius: 999px 18px 18px 999px;
  padding: 5px 16px 5px 5px; box-shadow: var(--dm-drop); backdrop-filter: blur(6px);
}
.dm-lvl {
  --xp: 0deg;
  width: clamp(48px, 7vmin, 62px); height: clamp(48px, 7vmin, 62px); border-radius: 50%; flex: 0 0 auto;
  padding: 4px; background: conic-gradient(var(--dm-grape-deep) var(--xp), #e6e0fb var(--xp));
  transition: background 0.3s;
}
.dm-lvl-inner {
  width: 100%; height: 100%; border-radius: 50%; background: linear-gradient(160deg, #8c6cf2, #5f3dc4);
  display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff;
  box-shadow: inset 0 -3px 0 rgba(0,0,0,0.18), inset 0 2px 0 rgba(255,255,255,0.25);
}
.dm-lvl-cap { font-size: 9px; font-weight: 900; letter-spacing: 0.1em; opacity: 0.8; line-height: 1; }
.dm-lvl-num { font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: clamp(18px, 2.8vmin, 24px); line-height: 1; }
.dm-plate-info { display: flex; flex-direction: column; gap: 3px; }
.dm-plate-depth { font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: clamp(15px, 2.2vmin, 20px); color: var(--dm-blue-deep); line-height: 1.1; }
.dm-plate-chips { display: flex; gap: 6px; }
.dm-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px 1px 5px; border-radius: 999px;
  font-weight: 800; font-size: clamp(11px, 1.5vmin, 14px); background: rgba(35,40,56,0.05);
}
.dm-chip-icon { font-size: 1em; }
.dm-chip-gold { color: #b35c00; background: #fff3d1; }
.dm-chip-kills { color: #c92a2a; background: #ffe7e7; }
.dm-points-pill {
  position: absolute; top: calc(var(--dm-gutter) + clamp(64px, 9vmin, 80px)); left: var(--dm-gutter);
  display: none; pointer-events: auto; padding: 5px 12px; border-radius: 999px;
  background: linear-gradient(180deg, #ffe066, #fcc419); color: #5c3c00; font-weight: 900; font-size: clamp(11px, 1.5vmin, 13px);
  box-shadow: 0 3px 0 #e8a200, 0 0 18px rgba(255,212,59,0.7); animation: dm-glow 1.6s ease-in-out infinite;
}
.dm-points-pill.dm-show { display: inline-block; }
.dm-points-pill:hover { filter: brightness(1.05); transform: translateY(-1px); }
@keyframes dm-glow { 0%,100% { box-shadow: 0 3px 0 #e8a200, 0 0 8px rgba(255,212,59,0.4); } 50% { box-shadow: 0 3px 0 #e8a200, 0 0 22px rgba(255,212,59,0.95); } }

/* ---------- minimap ---------- */
.dm-minimap-wrap {
  position: absolute; top: var(--dm-gutter); right: var(--dm-gutter);
  display: flex; flex-direction: column; align-items: stretch; gap: 8px; width: clamp(130px, 21vmin, 220px);
}
.dm-minimap-card {
  background: var(--dm-card); border: 2px solid var(--dm-edge); border-radius: 16px; overflow: hidden;
  box-shadow: var(--dm-drop); backdrop-filter: blur(6px);
}
.dm-minimap { display: block; width: 100%; aspect-ratio: 1; background: radial-gradient(circle at 50% 45%, #f4f9ff, #e3edf9); }
.dm-mm-legend {
  display: flex; justify-content: center; gap: 10px; padding: 4px 6px 5px; border-top: 1px solid var(--dm-line);
  font-size: 10px; font-weight: 800; color: var(--dm-text-dim);
}
.dm-mm-key { display: inline-flex; align-items: center; gap: 4px; }
.dm-mm-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; box-shadow: 0 0 0 1.5px #fff, 0 0 0 2.5px rgba(35,40,56,0.15); }
.dm-mm-you { background: #1c7ed6; } .dm-mm-foe { background: #e03131; } .dm-mm-exit { background: #f76707; } .dm-mm-merchant { background: #ffd43b; }
.dm-mini-buttons { display: flex; flex-direction: column; gap: 6px; pointer-events: auto; }
.dm-menubtn {
  position: relative; display: flex; align-items: center; gap: 6px; padding: 5px 8px;
  background: var(--dm-card); border: 2px solid var(--dm-edge); border-radius: 12px; box-shadow: var(--dm-drop);
  font-weight: 800; font-size: clamp(11px, 1.4vmin, 13px); color: var(--dm-text);
  transition: transform 0.1s, background 0.15s;
}
.dm-menubtn .dm-kbd { font-size: 0.8em; }
.dm-menubtn-icon {
  width: 24px; height: 24px; flex: 0 0 auto; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 14px; background: #e7f5ff; box-shadow: inset 0 -2px 0 rgba(35,40,56,0.08);
}
.dm-menubtn:last-child .dm-menubtn-icon { background: #f3f0ff; }
.dm-menubtn:hover { background: #fff; transform: translateY(-1px); }
.dm-menubtn:active { transform: translateY(1px); }
.dm-menubtn-label { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-menubtn-count { font-size: 0.85em; color: var(--dm-text-dim); font-weight: 800; }
.dm-menubtn-count.dm-full { color: #e03131; }
.dm-menubtn-plus {
  position: absolute; top: -8px; right: -6px; width: 20px; height: 20px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #fff3bf, #fcc419); color: #7a4a00; font-size: 14px; line-height: 1;
  display: none; align-items: center; justify-content: center; font-weight: 900; border: 2px solid #fff;
  box-shadow: 0 0 10px 2px rgba(255,212,59,0.85); animation: dm-pulse 1.1s ease-in-out infinite;
}
.dm-menubtn-plus.dm-show { display: flex; }
@keyframes dm-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.18); } }

/* ---------- boss HP bar (top center) ---------- */
.dm-bossbar {
  position: absolute; top: var(--dm-gutter); left: 50%;
  width: clamp(260px, 42vmin, 640px);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  opacity: 0; pointer-events: none; visibility: hidden;
  transform: translate(-50%, -16px) scale(0.94);
  transition: opacity 0.35s ease, transform 0.35s cubic-bezier(.2,1.4,.4,1), visibility 0s linear 0.35s;
}
.dm-bossbar.dm-show {
  opacity: 1; visibility: visible; transform: translate(-50%, 0) scale(1);
  transition: opacity 0.35s ease, transform 0.35s cubic-bezier(.2,1.4,.4,1);
}
.dm-bossbar-in { animation: dm-bossbar-pop 0.5s cubic-bezier(.2,1.4,.4,1); }
@keyframes dm-bossbar-pop {
  0% { transform: translate(-50%, -20px) scale(0.85); }
  55% { transform: translate(-50%, 4px) scale(1.04); }
  100% { transform: translate(-50%, 0) scale(1); }
}
.dm-bossbar-name {
  font-family: 'Fredoka', sans-serif; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  font-size: clamp(13px, 2vmin, 19px); color: #ffe8a3;
  text-shadow: 0 2px 0 rgba(0,0,0,0.55), 0 0 10px rgba(0,0,0,0.45);
}
.dm-bossbar-track {
  position: relative; width: 100%; height: clamp(14px, 2.2vmin, 20px); border-radius: 8px;
  background: var(--dm-ink); overflow: hidden;
  box-shadow: inset 0 2px 4px rgba(0,0,0,0.4), 0 0 0 2px rgba(255,232,163,0.55), 0 4px 14px rgba(0,0,0,0.35);
}
.dm-bossbar-trail { position: absolute; inset: 0; width: 0%; background: #ffe066; }
.dm-bossbar-fill { position: absolute; inset: 0; width: 0%; background: linear-gradient(180deg, #ff6b6b, #c92a2a); transition: width 0.15s ease-out; }
.dm-bossbar-notch { position: absolute; top: -2px; bottom: -2px; left: 50%; width: 2px; background: rgba(255,255,255,0.8); box-shadow: 0 0 4px rgba(0,0,0,0.5); }
.dm-bossbar-resist {
  min-height: 1.1em; font-size: clamp(9px, 1.2vmin, 11px); font-weight: 800;
  color: #e8e8f0; text-shadow: 0 1px 0 rgba(0,0,0,0.6); letter-spacing: 0.02em;
}
.dm-bossbar-phase {
  height: 1.2em; font-size: clamp(9px, 1.3vmin, 11px); font-weight: 900; letter-spacing: 0.12em;
  color: #ff8787; text-shadow: 0 1px 0 rgba(0,0,0,0.55);
}

/* ---------- vignette ---------- */
.dm-vignette {
  position: absolute; inset: 0; pointer-events: none; opacity: 0;
  box-shadow: inset 0 0 16vmin 4vmin rgba(240,50,50,0.45);
  transition: opacity 0.3s;
}
.dm-vignette.dm-active { opacity: 1; animation: dm-vignette-pulse 1.2s ease-in-out infinite; }
@keyframes dm-vignette-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 0.8; } }
/* Opacity is driven frame-by-frame from JS (pulseHit()/_updateHud), not CSS transitions/classes. */
.dm-hit-vignette { opacity: 0; box-shadow: inset 0 0 18vmin 5vmin rgba(255,25,25,0.9); transition: none; }

/* ---------- banner ---------- */
.dm-banner {
  position: absolute; top: 17%; left: 50%; transform: translate(-50%, -50%);
  text-align: center; opacity: 0; pointer-events: none; transition: opacity 0.15s linear;
  display: flex; flex-direction: column; align-items: center;
}
.dm-banner-in .dm-banner-title { animation: dm-banner-pop 0.45s cubic-bezier(.2,1.4,.4,1); }
@keyframes dm-banner-pop { 0% { transform: scale(0.6); letter-spacing: 0.3em; } 100% { transform: scale(1); letter-spacing: 0.04em; } }
.dm-banner-rule { display: none; }
.dm-banner-title {
  font-family: 'Fredoka', sans-serif; font-weight: 700; color: var(--dm-coral-deep);
  font-size: clamp(30px, 6.5vmin, 68px); letter-spacing: 0.04em; line-height: 1.05;
  -webkit-text-stroke: 0; paint-order: stroke fill;
  text-shadow: 0 3px 0 #fff, 0 -2px 0 #fff, 3px 0 0 #fff, -3px 0 0 #fff, 2px 2px 0 #fff, -2px 2px 0 #fff, 0 8px 22px rgba(43,45,66,0.28);
}
.dm-banner-sub {
  margin-top: 8px; padding: 4px 16px; border-radius: 999px; background: rgba(35,40,56,0.82); color: #fff;
  font-size: clamp(12px, 1.8vmin, 17px); font-weight: 800; box-shadow: 0 4px 14px rgba(35,40,56,0.25);
}
.dm-banner-nosub .dm-banner-sub { display: none; }

/* ---------- merchant trade prompt ---------- */
.dm-trade-prompt {
  position: absolute; left: 50%; bottom: 128px; transform: translate(-50%, 6px);
  font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: clamp(13px, 1.9vmin, 17px);
  color: #ffe8a3; background: rgba(28,32,48,0.88); border: 2px solid #ffd43b; border-radius: 999px;
  padding: 7px 18px; box-shadow: 0 4px 0 rgba(20,24,40,0.35);
  opacity: 0; pointer-events: none; visibility: hidden;
  transition: opacity 0.15s, transform 0.15s, visibility 0s linear 0.15s;
}
.dm-trade-prompt.dm-show { opacity: 1; visibility: visible; transform: translate(-50%, 0); transition: opacity 0.15s, transform 0.15s; }

/* ---------- title screen: controller sound note ---------- */
.dm-start-sound {
  display: none; margin: 10px auto 0; padding: 6px 14px; width: fit-content; border-radius: 999px;
  font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 14px;
  color: #7a4b00; background: #fff4d6; border: 1.5px solid #ffd43b;
}
.dm-start-sound.dm-show { display: block; }

/* ---------- sound locked hint ---------- */
.dm-sound-hint {
  position: absolute; left: 20px; top: 104px;
  font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: clamp(12px, 1.6vmin, 15px);
  color: #fff; background: rgba(28,32,48,0.78); border-radius: 999px; padding: 6px 14px;
  opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 0.3s, visibility 0s linear 0.3s;
}
.dm-sound-hint.dm-show { opacity: 1; visibility: visible; transition: opacity 0.3s; }

/* ---------- log ---------- */
.dm-log {
  position: absolute; left: var(--dm-gutter); bottom: var(--dm-gutter);
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px; max-width: min(30vw, 420px);
}
.dm-log-line {
  display: inline-block; max-width: 100%;
  font-size: clamp(11px, 1.45vmin, 14px); font-weight: 700; color: var(--dm-text);
  background: rgba(255,255,255,0.9); border-radius: 8px;
  padding: 3px 10px 3px 11px;
  box-shadow: inset 4px 0 0 0 var(--dm-log-accent, #4dabf7), 0 2px 6px rgba(43,45,66,0.12);
  opacity: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity 0.2s;
}

/* ---------- action dock ---------- */
.dm-dock {
  position: absolute; bottom: var(--dm-gutter); left: 50%; transform: translateX(-50%);
  background: var(--dm-card); border: 2px solid var(--dm-edge); border-radius: 20px;
  box-shadow: var(--dm-drop); backdrop-filter: blur(8px);
  padding: clamp(8px, 1.2vmin, 12px) clamp(10px, 1.4vmin, 14px) 0; overflow: hidden;
}
.dm-dock-row { display: flex; align-items: center; gap: clamp(8px, 1.3vmin, 14px); }
.dm-dock-sep { width: 2px; align-self: stretch; margin: 4px 0; background: var(--dm-line); border-radius: 2px; }

.dm-bars { display: flex; flex-direction: column; gap: 6px; width: clamp(150px, 22vmin, 240px); }
.dm-bar {
  position: relative; height: clamp(18px, 2.6vmin, 24px); border-radius: 8px;
  background: var(--dm-ink); overflow: hidden;
  box-shadow: inset 0 2px 4px rgba(0,0,0,0.35), 0 0 0 2px #fff;
}
.dm-bar-trail, .dm-bar-fill { position: absolute; top: 0; bottom: 0; left: 0; width: 0%; border-radius: 6px; }
.dm-bar-fill { transition: width 0.15s ease-out; }
.dm-bar-trail { background: #ffe066; }
.dm-bar-shine { position: absolute; left: 0; right: 0; top: 0; height: 45%; background: linear-gradient(180deg, rgba(255,255,255,0.35), rgba(255,255,255,0)); pointer-events: none; }
.dm-hpbar .dm-bar-fill { background: linear-gradient(180deg, #ff6b6b, #e03131); }
.dm-manabar .dm-bar-fill { background: linear-gradient(180deg, #4dabf7, #1971c2); }
.dm-manabar .dm-bar-trail { background: transparent; }
.dm-bar-label, .dm-bar-text {
  position: absolute; top: 0; bottom: 0; display: flex; align-items: center;
  font-size: clamp(10px, 1.4vmin, 13px); font-weight: 900; color: #fff;
  text-shadow: 0 1px 0 rgba(0,0,0,0.55), 0 0 3px rgba(0,0,0,0.4);
}
.dm-bar-label { left: 8px; letter-spacing: 0.06em; opacity: 0.9; }
.dm-bar-text { right: 8px; font-variant-numeric: tabular-nums; }
.dm-hpbar.dm-critical { animation: dm-critical 0.8s ease-in-out infinite; }
@keyframes dm-critical { 0%,100% { box-shadow: inset 0 2px 4px rgba(0,0,0,0.35), 0 0 0 2px #fff; } 50% { box-shadow: inset 0 2px 4px rgba(0,0,0,0.35), 0 0 0 2px #fff, 0 0 14px 3px rgba(255,60,60,0.85); } }
.dm-heal-flash .dm-bar-fill { animation: dm-heal 0.5s ease-out; }
@keyframes dm-heal { 0% { filter: brightness(1.8) saturate(0.6); } 100% { filter: none; } }

.dm-skills { display: flex; gap: clamp(6px, 1vmin, 10px); }
.dm-skill-slot {
  position: relative; pointer-events: auto; cursor: help;
  width: clamp(46px, 7vmin, 66px); height: clamp(46px, 7vmin, 66px);
  border-radius: 14px; background: linear-gradient(180deg, #ffffff, #eef4fc);
  border: 2px solid #c5d6ea; box-shadow: 0 3px 0 #c5d6ea;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  transition: transform 0.1s, filter 0.2s;
}
.dm-skill-slot:hover { transform: translateY(-2px); }
.dm-skill-icon { font-size: clamp(20px, 3.2vmin, 30px); filter: drop-shadow(0 2px 1px rgba(0,0,0,0.15)); }
.dm-skill-sweep { position: absolute; inset: 0; pointer-events: none; }
.dm-skill-cd {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-family: 'Fredoka', sans-serif; font-size: clamp(14px, 2.3vmin, 20px); font-weight: 700; color: #fff;
  text-shadow: 0 1px 3px rgba(0,0,0,0.9); font-variant-numeric: tabular-nums;
}
.dm-skill-key {
  position: absolute; top: 3px; left: 3px; min-width: 16px; text-align: center;
  font-size: clamp(9px, 1.2vmin, 11px); color: #ffe8a3; font-weight: 900; background: var(--dm-ink);
  border-radius: 5px; padding: 0 4px; line-height: 1.5;
}
.dm-skill-cost {
  position: absolute; bottom: 3px; right: 3px; font-size: clamp(9px, 1.2vmin, 11px); font-weight: 900;
  color: #fff; background: #1c7ed6; border-radius: 5px; padding: 0 4px; line-height: 1.5;
}
.dm-skill-slot.dm-oncd .dm-skill-icon { opacity: 0.55; }
.dm-skill-slot.dm-noafford { filter: grayscale(0.7); }
.dm-skill-slot.dm-noafford .dm-skill-icon { opacity: 0.45; }
.dm-skill-slot.dm-noafford .dm-skill-cost { background: #e03131; }
.dm-skill-slot.dm-ready-flash { animation: dm-ready 0.45s ease-out; }
@keyframes dm-ready { 0% { box-shadow: 0 3px 0 #c5d6ea, 0 0 0 0 rgba(255,212,59,0.95); border-color: #fcc419; } 100% { box-shadow: 0 3px 0 #c5d6ea, 0 0 0 10px rgba(255,212,59,0); } }

.dm-potions { display: flex; gap: clamp(6px, 1vmin, 10px); }
.dm-potion-slot {
  position: relative; pointer-events: auto; cursor: pointer;
  width: clamp(42px, 6.2vmin, 58px); height: clamp(42px, 6.2vmin, 58px);
  border-radius: 50%; display: flex; align-items: center; justify-content: center;
  transition: transform 0.1s, filter 0.2s;
}
.dm-potion-heal { background: radial-gradient(circle at 40% 35%, #fff5f5, #ffc9c9); border: 2px solid #ff8787; box-shadow: 0 3px 0 #ff8787; }
.dm-potion-mana { background: radial-gradient(circle at 40% 35%, #f0f8ff, #bfe0ff); border: 2px solid #4dabf7; box-shadow: 0 3px 0 #4dabf7; }
.dm-potion-svg { display: block; filter: drop-shadow(0 2px 1px rgba(0,0,0,0.18)); }
.dm-potion-slot:hover { transform: translateY(-2px); }
.dm-potion-slot:active { transform: translateY(1px); }
.dm-potion-slot.dm-empty { filter: grayscale(1); opacity: 0.55; }
.dm-potion-icon { font-size: clamp(22px, 3.3vmin, 32px); }
.dm-potion-count {
  position: absolute; bottom: -3px; right: -3px; min-width: 18px; text-align: center; background: var(--dm-ink); border-radius: 999px;
  padding: 0 5px; font-size: 11px; font-weight: 900; color: #fff; border: 2px solid #fff; line-height: 1.35;
}
.dm-potion-key {
  position: absolute; top: -4px; left: -4px; background: var(--dm-ink); border-radius: 5px;
  padding: 0 4px; font-size: 9px; font-weight: 900; color: #ffe8a3; line-height: 1.5;
}

.dm-xpbar {
  position: relative; height: 6px; margin: clamp(8px, 1.1vmin, 11px) calc(-1 * clamp(10px, 1.4vmin, 14px)) 0;
  background: #ebe5fb;
}
.dm-xpbar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #9775fa, #cc5de8, #ffd43b); transition: width 0.3s; }
.dm-xpbar-text {
  position: absolute; left: 50%; bottom: 7px; transform: translate(-50%, 50%); opacity: 0;
  font-size: 11px; font-weight: 800; color: #fff; background: var(--dm-grape-deep); border-radius: 999px; padding: 1px 10px;
  white-space: nowrap; transition: opacity 0.15s; pointer-events: none;
}
.dm-dock:hover .dm-xpbar-text { opacity: 1; }

/* ---------- scrim + panels ---------- */
.dm-scrim {
  position: absolute; inset: 0; background: rgba(28,34,56,0.38); backdrop-filter: blur(3px);
  opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 0.18s, visibility 0s linear 0.18s;
}
.dm-scrim.dm-open { opacity: 1; visibility: visible; pointer-events: auto; transition: opacity 0.18s; }

.dm-panel {
  --z: var(--dm-panel-scale, 1);
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -48%) scale(calc(var(--z) * 0.98));
  width: min(980px, calc((100vw - 24px) / var(--z))); max-height: calc((100vh - 32px) / var(--z));
  display: flex; flex-direction: column;
  background: var(--dm-card-solid); border: 2px solid var(--dm-edge); border-radius: 22px;
  box-shadow: 0 4px 0 rgba(35,40,56,0.12), 0 30px 80px rgba(20,26,50,0.35);
  color: var(--dm-text); pointer-events: none; opacity: 0; visibility: hidden; overflow: hidden;
  transition: opacity 0.16s ease, transform 0.16s ease, visibility 0s linear 0.16s;
}
.dm-panel.dm-open {
  pointer-events: auto; opacity: 1; visibility: visible; transform: translate(-50%, -50%) scale(var(--z));
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.dm-panel-header {
  display: flex; align-items: center; gap: 12px; padding: 12px 14px 0 14px;
  background: linear-gradient(180deg, #eef5ff, #f7faff); border-bottom: 2px solid var(--dm-edge); flex-wrap: wrap;
}
.dm-tabs { display: flex; gap: 4px; align-self: flex-end; }
.dm-tab {
  display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; margin-bottom: -2px;
  font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: clamp(14px, 1.9vmin, 17px); color: var(--dm-text-dim);
  border: 2px solid transparent; border-bottom: none; border-radius: 12px 12px 0 0;
}
.dm-tab:hover { color: var(--dm-text); background: rgba(255,255,255,0.6); }
.dm-tab.dm-tab-active { background: var(--dm-card-solid); border-color: var(--dm-edge); color: var(--dm-blue-deep); }
.dm-tab .dm-kbd { font-size: 0.7em; }
.dm-panel-extra { flex: 1; display: flex; justify-content: flex-end; align-items: center; padding-bottom: 8px; min-width: 0; }
.dm-panel-close {
  width: 34px; height: 34px; margin-bottom: 8px; border-radius: 10px; font-weight: 900; font-size: 14px;
  background: #fff; border: 2px solid var(--dm-edge); color: var(--dm-text-dim); box-shadow: 0 2px 0 var(--dm-edge);
}
.dm-panel-close:hover { color: #e03131; border-color: #ffa8a8; }
.dm-panel-body {
  flex: 1 1 auto; align-content: flex-start;
  display: flex; flex-wrap: wrap; gap: clamp(14px, 2vmin, 24px); padding: clamp(14px, 2vmin, 22px);
  overflow-y: auto; min-height: 0;
}
.dm-panel-foot {
  display: flex; flex-wrap: wrap; gap: 6px 16px; justify-content: center; padding: 8px 14px;
  border-top: 1px solid var(--dm-line); background: #f7f9fc; font-size: 12px; font-weight: 700; color: var(--dm-text-dim);
}
.dm-foot-item { display: inline-flex; align-items: center; gap: 6px; }
.dm-foot-item .dm-kbd { font-size: 10px; height: 1.9em; }

.dm-section { flex: 1 1 250px; min-width: 230px; }
.dm-section-skills { flex-basis: 300px; }
.dm-section-title {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-family: 'Fredoka', sans-serif; font-weight: 600; color: var(--dm-ink-soft); font-size: clamp(13px, 1.7vmin, 15px);
  text-transform: uppercase; letter-spacing: 0.08em; padding-bottom: 6px; margin-bottom: 10px; border-bottom: 2px solid var(--dm-line);
}
.dm-points-badge {
  display: none; font-family: 'Nunito', sans-serif; text-transform: none; letter-spacing: 0; font-size: 12px; font-weight: 900;
  color: #5c3c00; background: linear-gradient(180deg, #ffe066, #fcc419); padding: 1px 9px; border-radius: 999px;
  box-shadow: 0 0 10px rgba(255,212,59,0.7);
}
.dm-points-badge.dm-show { display: inline-block; }

.dm-char-summary { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 13px; color: var(--dm-text-dim); }
.dm-char-level { font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: 16px; color: var(--dm-grape-deep); }
.dm-char-xp { width: clamp(80px, 14vmin, 160px); height: 8px; border-radius: 999px; background: #ebe5fb; overflow: hidden; }
.dm-char-xp-fill { height: 100%; width: 0; background: linear-gradient(90deg, #9775fa, #cc5de8); border-radius: 999px; }

.dm-attr-list, .dm-charskill-list { display: flex; flex-direction: column; gap: 6px; }
.dm-attr-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 10px; border-radius: 12px;
  background: #f3f6fb; border: 2px solid transparent; transition: background 0.15s, border-color 0.15s;
}
.dm-attr-icon { font-size: 18px; width: 24px; text-align: center; }
.dm-attr-text { flex: 1; min-width: 0; }
.dm-attr-name { font-weight: 800; font-size: 14px; }
.dm-attr-desc { font-size: 11px; font-weight: 600; color: var(--dm-text-dim); line-height: 1.3; }
.dm-attr-value { font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: 20px; min-width: 28px; text-align: right; color: var(--dm-ink); }
.dm-plus {
  width: 28px; height: 28px; border-radius: 9px; flex: 0 0 auto; font-weight: 900; font-size: 16px; line-height: 1;
  color: #fff; background: linear-gradient(180deg, #69db7c, #40c057); box-shadow: 0 3px 0 #2f9e44;
  display: none; align-items: center; justify-content: center; transition: transform 0.08s, filter 0.15s;
}
.dm-plus:hover:not(:disabled) { filter: brightness(1.07); transform: translateY(-1px); }
.dm-plus:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 1px 0 #2f9e44; }
.dm-can-spend .dm-plus, .dm-plus-wide { display: inline-flex; }
.dm-plus-wide { width: auto; padding: 0 12px; font-size: 12px; font-family: 'Fredoka', sans-serif; font-weight: 600; }
.dm-plus:disabled { background: #e9ecef; color: #adb5bd; box-shadow: 0 3px 0 #dee2e6; cursor: default; }
.dm-plus.dm-maxed { background: linear-gradient(180deg, #b197fc, #7950f2); color: #fff; box-shadow: 0 3px 0 #5f3dc4; }
.dm-attr-row.dm-can-spend { background: #f4fce3; border-color: #c0eb75; }
.dm-attr-row.dm-focused, .dm-charskill-row.dm-focused { border-color: var(--dm-blue-deep); background: #e7f5ff; }

.dm-derived-list { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.dm-derived-row {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 10px; background: #f3f6fb; min-width: 0;
}
.dm-derived-icon { font-size: 13px; width: 18px; text-align: center; }
.dm-derived-name { flex: 1; color: var(--dm-text-dim); font-size: 11px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-derived-value { font-weight: 900; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }

.dm-charskill-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 8px; border-radius: 14px; background: #f3f6fb;
  border: 2px solid transparent; transition: background 0.15s, border-color 0.15s;
}
.dm-charskill-row.dm-can-spend { background: #f4fce3; border-color: #c0eb75; }
.dm-charskill-icon {
  position: relative; flex: 0 0 auto; width: 44px; height: 44px; border-radius: 12px; font-size: 22px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #fff, #eef4fc); border: 2px solid #c5d6ea; box-shadow: 0 2px 0 #c5d6ea;
}
.dm-charskill-key {
  position: absolute; top: -6px; left: -6px; font-size: 9px; font-weight: 900; color: #ffe8a3; background: var(--dm-ink);
  border-radius: 5px; padding: 0 4px; line-height: 1.5;
}
.dm-charskill-main { flex: 1; min-width: 0; }
.dm-charskill-head { display: flex; align-items: center; gap: 8px; }
.dm-charskill-name { font-weight: 900; font-size: 14px; flex: 1; }
.dm-pips { display: flex; gap: 3px; }
.dm-pip { width: 9px; height: 9px; border-radius: 3px; background: #dee2e6; box-shadow: inset 0 -1px 0 rgba(0,0,0,0.1); }
.dm-pip.dm-on { background: linear-gradient(180deg, #ffd43b, #f59f00); }
.dm-charskill-desc { font-size: 12px; color: var(--dm-text-dim); margin-top: 2px; font-weight: 600; line-height: 1.35; }

/* ---------- inventory ---------- */
.dm-inv-gold { font-weight: 900; color: #b35c00; background: #fff3d1; padding: 3px 12px; border-radius: 999px; font-size: 14px; }
.dm-inv-body { align-items: flex-start; flex-wrap: nowrap; }
.dm-inv-col { flex: 0 0 auto; }
.dm-inv-col-grid { flex: 1 1 auto; min-width: 0; }
.dm-inv-stats-title { margin-top: clamp(14px, 2vmin, 20px); }
.dm-inv-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.dm-inv-cap { font-family: 'Nunito', sans-serif; letter-spacing: 0; text-transform: none; font-size: 12px; font-weight: 800; color: var(--dm-text-dim); }
.dm-inv-cap.dm-full { color: #e03131; }
.dm-paperdoll {
  --slot: clamp(54px, 7.4vmin, 70px);
  position: relative; display: grid; gap: 8px; padding: 10px; border-radius: 16px;
  background: radial-gradient(ellipse at 50% 40%, #eef5ff, #e2ebf7);
  grid-template-columns: repeat(3, var(--slot));
  grid-template-rows: repeat(4, var(--slot));
  grid-template-areas:
    ".      helm   ."
    "weapon armor  offhand"
    ".      boots  ."
    "ring   .      amulet";
}
.dm-paperdoll-figure {
  grid-row: 3 / 5; grid-column: 2; align-self: end; justify-self: center; font-size: calc(var(--slot) * 0.9);
  opacity: 0.12; pointer-events: none; filter: grayscale(1);
}
.dm-eq-slot {
  pointer-events: auto; cursor: pointer; position: relative;
  border: 2px dashed #b9cbe2; border-radius: 14px; background: rgba(255,255,255,0.55);
  display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 1px;
  transition: transform 0.1s, background 0.15s;
}
.dm-eq-slot:hover { transform: translateY(-1px); background: #fff; }
.dm-eq-slot .dm-eq-icon { font-size: calc(var(--slot) * 0.36); opacity: 0.3; filter: grayscale(1); line-height: 1.1; }
.dm-eq-slot.dm-filled {
  border-style: solid; border-width: 3px;
  background: linear-gradient(160deg, color-mix(in srgb, var(--item-glow) 22%, #fff), #fff 70%);
  box-shadow: 0 3px 0 color-mix(in srgb, var(--item-glow) 45%, #c5d6ea);
}
.dm-eq-slot.dm-filled .dm-eq-icon { opacity: 1; filter: drop-shadow(0 2px 1px rgba(0,0,0,0.15)); }
.dm-eq-slot.dm-focused { outline: 3px solid var(--dm-blue-deep); outline-offset: 2px; }
.dm-eq-label { font-size: 9px; color: var(--dm-text-dim); white-space: nowrap; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }

.dm-inv-grid {
  --cell: clamp(46px, 6.6vmin, 64px);
  display: grid; grid-template-columns: repeat(${INV_COLS}, minmax(0, 1fr)); gap: 7px;
}
.dm-inv-cell {
  pointer-events: auto; cursor: pointer; position: relative; aspect-ratio: 1;
  border: 2px solid #dde5f0; border-radius: 12px; background: #f3f6fb;
  display: flex; align-items: center; justify-content: center; transition: transform 0.1s;
  box-shadow: inset 0 2px 3px rgba(35,40,56,0.05);
}
.dm-inv-cell:hover { transform: translateY(-1px); border-color: #b9cbe2; }
.dm-inv-cell.dm-filled {
  border-width: 3px;
  background: linear-gradient(160deg, color-mix(in srgb, var(--item-glow) 24%, #fff), #fff 75%);
  box-shadow: 0 3px 0 color-mix(in srgb, var(--item-glow) 45%, #c5d6ea);
}
.dm-inv-cell.dm-focused { outline: 3px solid var(--dm-blue-deep); outline-offset: 2px; }
.dm-inv-icon { font-size: calc(var(--cell) * 0.46); filter: drop-shadow(0 2px 1px rgba(0,0,0,0.15)); }
.dm-inv-stack {
  position: absolute; bottom: 2px; right: 3px; font-size: 10px; font-weight: 900; color: #fff;
  background: var(--dm-ink); border-radius: 5px; padding: 0 4px; line-height: 1.45;
}
.dm-inv-stack:empty { display: none; }
.dm-cmp {
  position: absolute; top: 2px; left: 3px; min-width: 15px; height: 15px; border-radius: 5px;
  font-size: 10px; font-weight: 900; line-height: 15px; text-align: center; color: #fff; pointer-events: none;
  box-shadow: 0 1px 0 rgba(0,0,0,0.2);
}
.dm-cmp:empty { display: none; }
.dm-cmp-up { background: #2f9e44; }
.dm-cmp-down { background: #e03131; }
.dm-cmp-mixed { background: #f08c00; }
.dm-derived-value.dm-up { color: #2f9e44; }
.dm-derived-value.dm-down { color: #e03131; }
.dm-inv-upbtn {
  pointer-events: auto; cursor: pointer; margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
  font: 800 11px 'Nunito', sans-serif; color: #fff; background: #2f9e44; border: 0; border-radius: 999px;
  padding: 3px 5px 3px 10px; text-transform: none; letter-spacing: 0;
}
.dm-inv-upbtn:hover { filter: brightness(1.08); }
.dm-inv-upbtn:disabled { background: #adb5bd; cursor: default; filter: none; }
.dm-inv-upbtn .dm-kbd { font-size: 10px; height: 1.7em; }

/* ---------- shop ---------- */
.dm-shop-title { font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: clamp(15px, 2vmin, 19px); color: var(--dm-ink); }
.dm-shop-body { flex-wrap: nowrap; }
.dm-shop-grid { flex: 1 1 auto; }
.dm-shop-cell { padding-bottom: 14px; }
.dm-shop-price {
  position: absolute; left: 0; right: 0; bottom: 2px; text-align: center;
  font-size: 10px; font-weight: 900; color: #5c3c00; background: #ffe066; border-radius: 0 0 10px 10px;
  padding: 1px 0;
}
.dm-shop-cell.dm-shop-noafford .dm-shop-price { color: #fff; background: #e03131; }
.dm-shop-cell.dm-shop-noafford { opacity: 0.55; }
.dm-shop-cell .dm-inv-stack { bottom: 16px; }
.dm-shop-badge {
  display: none; position: absolute; top: -9px; left: 50%; transform: translateX(-50%); z-index: 1;
  font-size: 8.5px; font-weight: 900; color: #5c3c00; background: linear-gradient(180deg, #ffe066, #fcc419);
  border-radius: 999px; padding: 1px 7px; white-space: nowrap; box-shadow: 0 2px 0 rgba(0,0,0,0.15);
}
.dm-shop-cell.dm-shop-featured {
  border-width: 3px; box-shadow: 0 0 0 2px #ffd43b, 0 0 14px 2px rgba(255,212,59,0.55);
}
.dm-shop-cell.dm-shop-featured .dm-shop-badge { display: block; }

/* ---------- tooltip (dark, so items.js' dark-tuned rarity/delta colors read well) ---------- */
.dm-tooltip {
  position: fixed; z-index: 90; max-width: 290px; pointer-events: none;
  background: rgba(30,34,50,0.97); border: 2px solid #4a5270; border-radius: 12px;
  padding: 9px 12px; font-size: 12px; color: #e9ecf5; line-height: 1.45; font-weight: 600;
  opacity: 0; transition: opacity 0.1s;
  box-shadow: 0 12px 32px rgba(10,14,30,0.4);
}
.dm-tooltip.dm-show { opacity: 1; }
.dm-tooltip b { color: #fff; }
.dm-tooltip .tt-name { font-family: 'Fredoka', sans-serif; font-size: 15px; font-weight: 600 !important; line-height: 1.2; }
.dm-tooltip .tt-rarity { font-size: 11px; font-weight: 800; opacity: 0.85; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.12); }
.dm-tooltip .tt-primary { font-weight: 800; color: #fff; margin-bottom: 2px; }
.dm-tooltip .tt-stat { color: #8ce99a; font-weight: 700; }
.dm-tooltip .tt-stack, .dm-tooltip .tt-ilvl { color: #9aa3bd; font-size: 11px; margin-top: 4px; }
.dm-tooltip .tt-value { color: #ffd43b; font-weight: 800; }
.dm-tooltip .tt-compare { margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.18); }
.dm-tooltip .tt-cmp-line { font-weight: 800; }
.dm-tooltip .tt-verdict { font-weight: 900; margin-bottom: 3px; }
.dm-tooltip .tt-verdict-note { font-weight: 700; font-size: 11px; opacity: 0.8; }
.dm-tooltip .tt-compare-empty { color: #9aa3bd !important; font-weight: 600; }
.dm-tooltip .tt-action { margin-top: 7px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.12); color: #9aa3bd; font-size: 10.5px; font-weight: 700; }
.dm-tooltip .tt-title { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 15px; color: #fff; display: flex; align-items: center; gap: 6px; }
.dm-tooltip .tt-rank { margin-left: auto; font-family: 'Nunito', sans-serif; font-size: 11px; font-weight: 800; color: #ffd43b; }
.dm-tooltip .tt-body { margin-top: 4px; color: #cfd5e6; }
.dm-tooltip .tt-pills { display: flex; gap: 6px; margin-top: 7px; }
.dm-tooltip .tt-pill { font-size: 11px; font-weight: 800; padding: 1px 8px; border-radius: 999px; background: rgba(255,255,255,0.1); }
.dm-tooltip .tt-pill-mana { background: rgba(77,171,247,0.25); color: #a5d8ff; }

/* ---------- overlays ---------- */
.dm-overlay {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center; padding: 16px;
  background:
    radial-gradient(circle at 20% 15%, rgba(255,236,153,0.55), transparent 40%),
    radial-gradient(circle at 85% 90%, rgba(177,151,252,0.35), transparent 45%),
    linear-gradient(160deg, rgba(208,235,255,0.97), rgba(243,240,255,0.96));
  pointer-events: none; z-index: 100;
}
.dm-overlay.dm-open { display: flex; pointer-events: auto; animation: dm-fade-in 0.3s ease-out; }
@keyframes dm-fade-in { from { opacity: 0; } to { opacity: 1; } }
.dm-pause.dm-open { background: rgba(28,34,56,0.45); backdrop-filter: blur(6px); }
.dm-death.dm-open {
  background: radial-gradient(circle at 50% 40%, rgba(255,245,245,0.9), rgba(255,201,201,0.95) 70%, rgba(224,49,49,0.55));
  animation: dm-fade-in 0.6s ease-out;
}
.dm-overlay-card {
  width: min(620px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; text-align: center;
  background: var(--dm-card-solid); border: 2px solid var(--dm-edge); border-radius: 26px;
  padding: clamp(20px, 3.4vmin, 38px); box-shadow: 0 5px 0 rgba(35,40,56,0.1), 0 30px 80px rgba(28,34,56,0.28);
  animation: dm-card-in 0.35s cubic-bezier(.2,1.3,.4,1);
}
@keyframes dm-card-in { from { transform: translateY(14px) scale(0.97); opacity: 0; } to { transform: none; opacity: 1; } }
.dm-death .dm-overlay-card { border-color: #ffc9c9; }
.dm-title-eyebrow { font-size: 12px; font-weight: 900; letter-spacing: 0.2em; text-transform: uppercase; color: var(--dm-text-dim); }
.dm-title {
  font-family: 'Fredoka', sans-serif; font-weight: 700; color: var(--dm-coral-deep); line-height: 1;
  text-shadow: 0 4px 0 #ffd8a8, 0 10px 26px rgba(232,89,12,0.25); margin: 6px 0 10px;
  font-size: clamp(28px, 5vmin, 48px);
}
.dm-title-small { display: block; font-size: 0.55em; color: var(--dm-blue-deep); text-shadow: 0 3px 0 #d0ebff; letter-spacing: 0.04em; }
.dm-title-big { display: block; font-size: 1.9em; letter-spacing: 0.12em; }
.dm-title-sm { font-size: clamp(26px, 4.4vmin, 40px); }
.dm-pause .dm-title-sm { color: var(--dm-blue-deep); text-shadow: 0 4px 0 #d0ebff; }
.dm-tagline { color: var(--dm-text-dim); margin-bottom: 16px; font-weight: 800; font-size: clamp(13px, 1.8vmin, 16px); }
.dm-pause-stats { color: var(--dm-text-dim); font-weight: 800; font-size: 13px; margin-bottom: 12px; }
.dm-press-any { margin-top: 10px; color: var(--dm-text-dim); font-size: 12px; font-weight: 800; animation: dm-blink 1.6s ease-in-out infinite; }
@keyframes dm-blink { 0%,100% { opacity: 0.45; } 50% { opacity: 1; } }
.dm-hint { color: var(--dm-text-dim); font-size: 12px; margin-top: 10px; font-weight: 700; }

.dm-controls { margin: 18px 0 4px; border-radius: 14px; background: #f3f6fb; padding: 6px 12px; text-align: left; }
.dm-controls-row {
  display: grid; grid-template-columns: 1.1fr 1fr 1fr; align-items: center; gap: 8px; padding: 5px 0;
  border-bottom: 1px solid var(--dm-line); font-size: clamp(12px, 1.5vmin, 14px); font-weight: 800;
}
.dm-controls-row:last-child { border-bottom: none; }
.dm-controls-head { font-family: 'Fredoka', sans-serif; font-weight: 600; color: var(--dm-blue-deep); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
.dm-controls-keys { display: flex; flex-wrap: wrap; gap: 4px; }
.dm-controls .dm-kbd { font-size: 11px; height: 22px; min-width: 22px; }

.dm-death-skull { font-size: clamp(40px, 7vmin, 60px); line-height: 1; animation: dm-bob 2.4s ease-in-out infinite; }
@keyframes dm-bob { 0%,100% { transform: translateY(0) rotate(-4deg); } 50% { transform: translateY(-6px) rotate(4deg); } }
.dm-death-summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 6px 0 20px; }
.dm-stat-tile { background: #fff5f5; border: 2px solid #ffe3e3; border-radius: 14px; padding: 10px 4px 8px; }
.dm-stat-icon { font-size: 18px; }
.dm-stat-value { font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: clamp(18px, 2.6vmin, 24px); color: var(--dm-ink); }
.dm-stat-label { font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dm-text-dim); }

.dm-btn {
  pointer-events: auto; cursor: pointer; font-family: 'Fredoka', sans-serif; font-size: clamp(16px, 2.1vmin, 20px);
  font-weight: 600; padding: 12px 36px; border-radius: 999px; color: #fff; letter-spacing: 0.02em;
  background: linear-gradient(180deg, #69db7c, #40c057);
  box-shadow: 0 5px 0 #2f9e44, 0 10px 22px rgba(64,192,87,0.35);
  margin-top: 6px; transition: transform 0.1s, box-shadow 0.1s, filter 0.15s;
  text-shadow: 0 1px 0 rgba(0,0,0,0.15);
}
.dm-btn:hover { transform: translateY(-2px); filter: brightness(1.05); box-shadow: 0 7px 0 #2f9e44, 0 14px 26px rgba(64,192,87,0.4); }
.dm-btn:active { transform: translateY(3px); box-shadow: 0 2px 0 #2f9e44, 0 4px 10px rgba(64,192,87,0.3); }
.dm-music-btn { margin-left: 10px; padding-left: 24px; padding-right: 24px; }
.dm-btn-secondary {
  background: linear-gradient(180deg, #dee2e6, #ced4da); color: var(--dm-ink); text-shadow: none;
  box-shadow: 0 5px 0 #adb5bd, 0 10px 22px rgba(33,37,41,0.15);
}
.dm-btn-secondary:hover { box-shadow: 0 7px 0 #adb5bd, 0 14px 26px rgba(33,37,41,0.18); }
.dm-btn-secondary:active { box-shadow: 0 2px 0 #adb5bd, 0 4px 10px rgba(33,37,41,0.15); }
.dm-death .dm-btn { background: linear-gradient(180deg, #ff8787, #fa5252); box-shadow: 0 5px 0 #c92a2a, 0 10px 22px rgba(250,82,82,0.35); }
.dm-death .dm-btn:hover { box-shadow: 0 7px 0 #c92a2a, 0 14px 26px rgba(250,82,82,0.4); }
.dm-death .dm-btn:active { box-shadow: 0 2px 0 #c92a2a; }
.dm-start-btn-row { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-top: 6px; }
.dm-start-btn-row .dm-btn { margin-top: 0; }
.dm-start-hide { display: none !important; }
.dm-start-btn-row .dm-btn.dm-focused { outline: 3px solid var(--dm-blue-deep); outline-offset: 4px; }

/* ---------- small screens ---------- */
@media (max-width: 900px) {
  .dm-log { display: none; }
}
@media (max-width: 720px) {
  .dm-inv-body { flex-direction: column; align-items: stretch; flex-wrap: wrap; }
  .dm-inv-col { align-self: center; }
  .dm-inv-col-grid { align-self: stretch; }
  .dm-inv-grid { --cell: clamp(34px, 9vw, 56px); gap: 5px; }
  .dm-inv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dm-death-summary { grid-template-columns: repeat(3, 1fr); }
  .dm-mm-legend { display: none; }
  .dm-menubtn-label { display: none; }
  .dm-dock { max-width: calc(100vw - 16px); }
  .dm-bossbar { width: clamp(200px, 58vw, 380px); }
  .dm-bars { width: 110px; }
  .dm-tab { padding: 8px 10px; }
  .dm-tab .dm-kbd { display: none; }
}
`;
