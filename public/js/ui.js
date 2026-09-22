// HUD, Character panel (C), Inventory panel (I), messages, death/menu screens.
// Owned by the UI agent — see DESIGN.md §13. Injects its own <style>.
// IMPORTANT: game.player / game.map are REPLACED on restart & depth change.
// This module never caches those sub-references across frames — it re-reads
// `this.game.player` / `this.game.map` fresh every time. The `game` object
// itself is assumed stable for the lifetime of this UI instance.

import { ATTRIBUTES, xpForLevel, spendAttribute } from './character.js';
import { upgradeSkill, skillDescription } from './skills.js';
import { equipItem, unequipItem, useItem, dropItem, sellValue, itemTooltip, SLOTS, INVENTORY_SIZE } from './items.js';
import { RARITY, clamp, TILE } from './core.js';

const SKILL_KEY_LABEL = ['1', '2', '3', '4'];
const SKILL_PAD_LABEL = ['A', 'X', 'Y', 'B'];
const PAD_COLOR = { A: '#3ecf5a', B: '#e05a4e', X: '#3e8cf0', Y: '#e0c23e' };

function fmtTime(s) {
  s = Math.max(0, Math.round(s || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtPct(x) { return `${Math.round((x || 0) * 100)}%`; }

function mk(tag, cls, parent, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}

function getRarity(item) {
  if (!item) return RARITY.common;
  if (item.rarity && typeof item.rarity === 'object') return item.rarity;
  return RARITY[item.rarity] || RARITY.common;
}

// Rarity colors are tuned for a dark backdrop (items.js). On our bright, light
// panels a couple of them (esp. pale "common" gray) lose contrast as borders.
// This only adjusts colors WE apply from ui.js (equip/inventory borders) —
// tooltip text colors are handled via a dark header band in CSS instead.
const RARITY_BORDER_FIX = { common: '#8b93a1' };
function rarityBorderColor(item) {
  const r = getRarity(item);
  return RARITY_BORDER_FIX[r.id] || r.color;
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
    this._invCursor = { area: 'grid', index: 0 };
    this._lastInvCursorKey = null;

    this._logLines = []; // {text, color, t}
    this._banner = null; // {title, subtitle, t}

    this._lastMinimapDraw = 0;
    this._lastMapRef = null;

    this._lowHpActive = false;

    this._startActive = false;
    this._startCallback = null;
    this._startFired = false;

    this._pauseActive = false;
    this._pauseCallback = null;

    this._deathActive = false;
    this._deathCallback = null;
    this._deathFired = false;

    this._cache = {};
    this._hoverTooltipItem = null;

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
    this._buildCharacterPanel(root);
    this._buildInventoryPanel(root);
    this._buildTooltip(root);
    this._buildOverlays(root);
  }

  _buildHud(root) {
    const hud = mk('div', 'dm-hud', root);

    // --- top-left ---
    const tl = mk('div', 'dm-topleft', hud);
    const depth = mk('div', 'dm-tl-row dm-depth', tl);
    mk('span', 'dm-tl-icon', depth, '⛏');
    const depthText = mk('span', '', depth, 'Depth 1');
    const gold = mk('div', 'dm-tl-row dm-gold', tl);
    mk('span', 'dm-tl-icon', gold, '🪙');
    const goldText = mk('span', '', gold, '0');
    const kills = mk('div', 'dm-tl-row dm-kills', tl);
    mk('span', 'dm-tl-icon', kills, '💀');
    const killsText = mk('span', '', kills, '0');

    // --- minimap (top-right) ---
    const mmWrap = mk('div', 'dm-minimap-wrap', hud);
    const canvas = mk('canvas', 'dm-minimap', mmWrap);
    canvas.width = 200; canvas.height = 200;
    const mmButtons = mk('div', 'dm-mini-buttons', mmWrap);
    const btnC = mk('button', 'dm-badge dm-badge-c', mmButtons);
    mk('span', 'dm-badge-label', btnC, 'C');
    const plusC = mk('span', 'dm-badge-plus', btnC, '+');
    const btnI = mk('button', 'dm-badge dm-badge-i', mmButtons);
    mk('span', 'dm-badge-label', btnI, 'I');
    btnC.addEventListener('click', () => this.toggleCharacter());
    btnI.addEventListener('click', () => this.toggleInventory());

    // --- vignette ---
    const vignette = mk('div', 'dm-vignette', hud);

    // --- banner ---
    const banner = mk('div', 'dm-banner', hud);
    const bannerTitle = mk('div', 'dm-banner-title', banner);
    const bannerSub = mk('div', 'dm-banner-sub', banner);

    // --- combat log ---
    const log = mk('div', 'dm-log', hud);
    const logLines = [];
    for (let i = 0; i < 6; i++) logLines.push(mk('div', 'dm-log-line', log));

    // --- action bar ---
    const bar = mk('div', 'dm-actionbar', hud);
    const bars = mk('div', 'dm-bars', bar);
    const hpBar = mk('div', 'dm-bar dm-hpbar', bars);
    const hpFill = mk('div', 'dm-bar-fill', hpBar);
    const hpText = mk('div', 'dm-bar-text', hpBar, '0/0');
    const manaBar = mk('div', 'dm-bar dm-manabar', bars);
    const manaFill = mk('div', 'dm-bar-fill', manaBar);
    const manaText = mk('div', 'dm-bar-text', manaBar, '0/0');

    const skillsWrap = mk('div', 'dm-skills', bar);
    const skillSlots = [];
    for (let i = 0; i < 4; i++) {
      const slot = mk('div', 'dm-skill-slot', skillsWrap);
      const sweep = mk('div', 'dm-skill-sweep', slot);
      const icon = mk('div', 'dm-skill-icon', slot, '?');
      const cdText = mk('div', 'dm-skill-cd', slot, '');
      const key = mk('div', 'dm-skill-key', slot, SKILL_KEY_LABEL[i]);
      const cost = mk('div', 'dm-skill-cost', slot, '');
      skillSlots.push({ slot, sweep, icon, cdText, key, cost });
    }

    const potionsWrap = mk('div', 'dm-potions', bar);
    const potHeal = mk('button', 'dm-potion-slot dm-potion-heal', potionsWrap);
    mk('div', 'dm-potion-icon', potHeal, '🧪');
    const potHealCount = mk('div', 'dm-potion-count', potHeal, '0');
    const potHealKey = mk('div', 'dm-potion-key', potHeal, 'H');
    const potMana = mk('button', 'dm-potion-slot dm-potion-mana', potionsWrap);
    mk('div', 'dm-potion-icon', potMana, '🔮');
    const potManaCount = mk('div', 'dm-potion-count', potMana, '0');
    const potManaKey = mk('div', 'dm-potion-key', potMana, 'M');
    potHeal.addEventListener('click', () => this._useFirstPotion('heal'));
    potMana.addEventListener('click', () => this._useFirstPotion('mana'));

    const xpBar = mk('div', 'dm-xpbar', hud);
    const xpFill = mk('div', 'dm-xpbar-fill', xpBar);
    const xpText = mk('div', 'dm-xpbar-text', xpBar, 'Lv 1 — 0/0 XP');

    Object.assign(this.dom, {
      hud, depthText, goldText, killsText,
      canvas, ctx: canvas.getContext('2d'), btnC, plusC, btnI,
      vignette, banner, bannerTitle, bannerSub,
      log, logLines,
      hpFill, hpText, manaFill, manaText,
      skillSlots, potHealCount, potManaCount, potHealKey, potManaKey,
      xpFill, xpText,
    });
  }

  _buildCharacterPanel(root) {
    const panel = mk('div', 'dm-panel dm-character', root);
    const header = mk('div', 'dm-panel-header', panel);
    mk('div', 'dm-panel-title', header, '⚔ Character');
    const closeBtn = mk('button', 'dm-panel-close', header, '✕');
    closeBtn.addEventListener('click', () => this.closeAll());

    const sub = mk('div', 'dm-char-sub', panel);
    const lvlText = mk('div', 'dm-char-level', sub, 'Level 1');
    const xpText = mk('div', 'dm-char-xp', sub, '0 / 0 XP');
    const pointsText = mk('div', 'dm-char-points', sub, '');

    const body = mk('div', 'dm-panel-body', panel);

    const attrSection = mk('div', 'dm-section', body);
    mk('div', 'dm-section-title', attrSection, 'Attributes');
    const attrList = mk('div', 'dm-attr-list', attrSection);
    const attrRows = ATTRIBUTES.map((attr) => {
      const row = mk('div', 'dm-attr-row', attrList);
      row.dataset.attr = attr.id;
      const name = mk('div', 'dm-attr-name', row, attr.name);
      const value = mk('div', 'dm-attr-value', row, '0');
      const plusBtn = mk('button', 'dm-attr-plus', row, '+');
      plusBtn.addEventListener('click', () => this._spendAttr(attr.id));
      row.addEventListener('mouseenter', () => this._showTooltip(row, `<b>${attr.name}</b><br>${attr.description}`));
      row.addEventListener('mouseleave', () => this._hideTooltip());
      return { attr, row, value, plusBtn };
    });

    const derivedSection = mk('div', 'dm-section', body);
    mk('div', 'dm-section-title', derivedSection, 'Derived Stats');
    const derivedList = mk('div', 'dm-derived-list', derivedSection);
    const derivedKeys = ['maxHp', 'maxMana', 'melee', 'spellPower', 'defense', 'critChance', 'critMult', 'moveSpeed', 'hpRegen', 'manaRegen', 'dodgeChance'];
    const derivedLabels = { maxHp: 'Max HP', maxMana: 'Max Mana', melee: 'Melee dmg', spellPower: 'Spell power', defense: 'Defense', critChance: 'Crit chance', critMult: 'Crit multiplier', moveSpeed: 'Move speed', hpRegen: 'HP regen', manaRegen: 'Mana regen', dodgeChance: 'Dodge chance' };
    const derivedRows = {};
    for (const k of derivedKeys) {
      const row = mk('div', 'dm-derived-row', derivedList);
      mk('div', 'dm-derived-name', row, derivedLabels[k]);
      const val = mk('div', 'dm-derived-value', row, '-');
      derivedRows[k] = val;
    }

    const skillSection = mk('div', 'dm-section', body);
    mk('div', 'dm-section-title', skillSection, 'Skills');
    const skillList = mk('div', 'dm-charskill-list', skillSection);
    const skillRows = [];
    for (let i = 0; i < 4; i++) {
      const row = mk('div', 'dm-charskill-row', skillList);
      row.dataset.index = String(i);
      const head = mk('div', 'dm-charskill-head', row);
      const icon = mk('div', 'dm-charskill-icon', head, '');
      const name = mk('div', 'dm-charskill-name', head, '');
      const rank = mk('div', 'dm-charskill-rank', head, '');
      const upgradeBtn = mk('button', 'dm-charskill-upgrade', head, 'Upgrade');
      const desc = mk('div', 'dm-charskill-desc', row, '');
      upgradeBtn.addEventListener('click', () => this._upgradeSkill(i));
      row.addEventListener('mouseenter', () => {
        const p = this.game && this.game.player;
        const sk = p && p.skills && p.skills[i];
        if (sk) this._showTooltip(row, skillDescription(sk, p));
      });
      row.addEventListener('mouseleave', () => this._hideTooltip());
      skillRows.push({ row, icon, name, rank, upgradeBtn, desc });
    }

    this.dom.charPanel = panel;
    this.dom.charLvlText = lvlText;
    this.dom.charXpText = xpText;
    this.dom.charPointsText = pointsText;
    this.dom.attrRows = attrRows;
    this.dom.derivedRows = derivedRows;
    this.dom.charSkillRows = skillRows;
  }

  _buildInventoryPanel(root) {
    const panel = mk('div', 'dm-panel dm-inventory', root);
    const header = mk('div', 'dm-panel-header', panel);
    mk('div', 'dm-panel-title', header, '🎒 Inventory');
    const goldText = mk('div', 'dm-inv-gold', header, '🪙 0');
    const closeBtn = mk('button', 'dm-panel-close', header, '✕');
    closeBtn.addEventListener('click', () => this.closeAll());

    const body = mk('div', 'dm-panel-body dm-inv-body', panel);

    const paperdoll = mk('div', 'dm-paperdoll', body);
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

    const gridWrap = mk('div', 'dm-inv-grid-wrap', body);
    const grid = mk('div', 'dm-inv-grid', gridWrap);
    const cellEls = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const cell = mk('div', 'dm-inv-cell', grid);
      cell.dataset.index = String(i);
      const icon = mk('div', 'dm-inv-icon', cell, '');
      const stack = mk('div', 'dm-inv-stack', cell, '');
      cell.addEventListener('click', (e) => this._clickInvCell(i, e));
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); this._dropInvCell(i); });
      cell.addEventListener('mouseenter', (e) => this._hoverInvCell(i, e));
      cell.addEventListener('mousemove', (e) => this._positionTooltip(e.clientX, e.clientY));
      cell.addEventListener('mouseleave', () => this._hideTooltip());
      cellEls.push({ cell, icon, stack });
    }

    this.dom.invPanel = panel;
    this.dom.invGoldText = goldText;
    this.dom.eqSlots = slotEls;
    this.dom.invCells = cellEls;
  }

  _buildTooltip(root) {
    const tip = mk('div', 'dm-tooltip', root);
    this.dom.tooltip = tip;
  }

  _buildOverlays(root) {
    // Start screen.
    const start = mk('div', 'dm-overlay dm-start', root);
    const startCard = mk('div', 'dm-overlay-card', start);
    mk('div', 'dm-title', startCard, 'DEPTHS OF THE MAZE');
    mk('div', 'dm-tagline', startCard, 'Descend. Fight. Loot. Try not to die.');
    const table = mk('table', 'dm-controls-table', startCard);
    const rows = [
      ['Move', 'WASD / Arrows', 'Left Stick / D-pad'],
      ['Skills 1-4', '1 2 3 4', 'A / X / Y / B'],
      ['Character', 'C', 'Back / RB'],
      ['Inventory', 'I / Tab', 'LB'],
      ['Pause', 'Esc / P', 'Start'],
      ['Confirm', 'Enter / E / Space', 'A'],
      ['Cancel', 'Esc', 'B'],
      ['Drop item', 'Q / Delete', 'X'],
      ['HP Potion', 'H', 'RT'],
      ['Mana Potion', 'M', 'LT'],
    ];
    const thead = mk('tr', '', table);
    mk('th', '', thead, 'Action'); mk('th', '', thead, 'Keyboard'); mk('th', '', thead, 'Controller');
    for (const r of rows) {
      const tr = mk('tr', '', table);
      mk('td', '', tr, r[0]); mk('td', '', tr, r[1]); mk('td', '', tr, r[2]);
    }
    mk('div', 'dm-press-any', startCard, 'Press any key or button to begin');
    const startBtn = mk('button', 'dm-btn dm-btn-primary', startCard, 'Start');
    start.addEventListener('click', () => this._fireStart());
    startBtn.addEventListener('click', (e) => { e.stopPropagation(); this._fireStart(); });

    // Pause screen.
    const pause = mk('div', 'dm-overlay dm-pause', root);
    const pauseCard = mk('div', 'dm-overlay-card', pause);
    mk('div', 'dm-title dm-title-sm', pauseCard, 'Paused');
    const resumeBtn = mk('button', 'dm-btn dm-btn-primary', pauseCard, 'Resume');
    mk('div', 'dm-pause-hint', pauseCard, 'Esc / P / Start to resume');
    const table2 = mk('table', 'dm-controls-table', pauseCard);
    const thead2 = mk('tr', '', table2);
    mk('th', '', thead2, 'Action'); mk('th', '', thead2, 'Keyboard'); mk('th', '', thead2, 'Controller');
    for (const r of rows) {
      const tr = mk('tr', '', table2);
      mk('td', '', tr, r[0]); mk('td', '', tr, r[1]); mk('td', '', tr, r[2]);
    }
    resumeBtn.addEventListener('click', () => { if (this._pauseCallback) this._pauseCallback(); });

    // Death screen.
    const death = mk('div', 'dm-overlay dm-death', root);
    const deathCard = mk('div', 'dm-overlay-card', death);
    mk('div', 'dm-title dm-title-sm', deathCard, 'You Have Fallen');
    const summaryList = mk('div', 'dm-death-summary', deathCard);
    const sDepth = mk('div', 'dm-death-row', summaryList, '');
    const sLevel = mk('div', 'dm-death-row', summaryList, '');
    const sKills = mk('div', 'dm-death-row', summaryList, '');
    const sGold = mk('div', 'dm-death-row', summaryList, '');
    const sTime = mk('div', 'dm-death-row', summaryList, '');
    const retryBtn = mk('button', 'dm-btn dm-btn-primary', deathCard, 'Try Again');
    mk('div', 'dm-pause-hint', deathCard, 'Press Enter / A to try again');
    retryBtn.addEventListener('click', () => this._fireDeath());

    this.dom.start = start;
    this.dom.pause = pause;
    this.dom.death = death;
    this.dom.deathRows = { sDepth, sLevel, sKills, sGold, sTime };
  }

  // =====================================================================
  // Public API — panel toggling
  // =====================================================================
  toggleCharacter() {
    if (this._characterOpen) { this._characterOpen = false; }
    else { this._inventoryOpen = false; this._characterOpen = true; this._charCursor = 0; this._lastCharCursor = -1; }
    this._applyPanelVisibility();
    if (this._characterOpen) this._refreshCharacterPanel();
  }

  toggleInventory() {
    if (this._inventoryOpen) { this._inventoryOpen = false; }
    else { this._characterOpen = false; this._inventoryOpen = true; this._invCursor = { area: 'grid', index: 0 }; this._lastInvCursorKey = null; }
    this._applyPanelVisibility();
    if (this._inventoryOpen) this._refreshInventoryPanel();
  }

  closeAll() {
    this._characterOpen = false;
    this._inventoryOpen = false;
    this._applyPanelVisibility();
    this._hideTooltip();
  }

  isModalOpen() {
    return this._characterOpen || this._inventoryOpen;
  }

  _applyPanelVisibility() {
    this.dom.charPanel.classList.toggle('dm-open', this._characterOpen);
    this.dom.invPanel.classList.toggle('dm-open', this._inventoryOpen);
    if (!this.isModalOpen()) this._hideTooltip();
  }

  // =====================================================================
  // Public API — messages
  // =====================================================================
  log(text, color) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._logLines.push({ text: String(text), color: color || '#4dabf7', t: now });
    if (this._logLines.length > 24) this._logLines.shift();
  }

  banner(title, subtitle) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._banner = { title: title || '', subtitle: subtitle || '', t: now };
  }

  // =====================================================================
  // Public API — screens
  // =====================================================================
  showDeath(summary, onRestart) {
    summary = summary || {};
    this._deathCallback = onRestart;
    this._deathFired = false;
    this._deathActive = true;
    const r = this.dom.deathRows;
    r.sDepth.textContent = `Depth reached: ${summary.depth ?? '-'}`;
    r.sLevel.textContent = `Level: ${summary.level ?? '-'}`;
    r.sKills.textContent = `Kills: ${summary.kills ?? 0}`;
    r.sGold.textContent = `Gold collected: ${summary.gold ?? 0}`;
    r.sTime.textContent = `Time played: ${fmtTime(summary.timePlayed || 0)}`;
    this.dom.death.classList.add('dm-open');
  }

  showPause(onResume) {
    this._pauseCallback = onResume;
    this._pauseActive = true;
    this.dom.pause.classList.add('dm-open');
  }

  hidePause() {
    this._pauseActive = false;
    this.dom.pause.classList.remove('dm-open');
  }

  showStart(onStart) {
    this._startCallback = onStart;
    this._startFired = false;
    this._startActive = true;
    this.dom.start.classList.add('dm-open');
  }

  _fireStart() {
    if (this._startFired) return;
    this._startFired = true;
    this._startActive = false;
    this.dom.start.classList.remove('dm-open');
    const cb = this._startCallback;
    this._startCallback = null;
    if (cb) cb();
  }

  _fireDeath() {
    if (this._deathFired) return;
    this._deathFired = true;
    this._deathActive = false;
    this.dom.death.classList.remove('dm-open');
    const cb = this._deathCallback;
    this._deathCallback = null;
    if (cb) cb();
  }

  // =====================================================================
  // Frame update
  // =====================================================================
  update(game, dt) {
    this.game = game;
    this._tickOverlayInput();
    this._tickBanner();
    this._tickLog();

    if (this._startActive || this._deathActive) return; // HUD not relevant on these screens

    if (!game || !game.player) return;

    this._updateHud(game, dt);
    if (this._characterOpen) this._refreshCharacterPanel();
    if (this._inventoryOpen) this._refreshInventoryPanel();
  }

  _tickOverlayInput() {
    const input = this.input;
    if (!input) return;
    if (this._startActive && !this._startFired) {
      if (input.anyPressed()) this._fireStart();
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
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const age = (now - this._banner.t) / 1000;
    const dur = 2.5;
    if (age >= dur) { this._banner = null; b.style.opacity = '0'; return; }
    let op;
    if (age < 0.3) op = age / 0.3;
    else if (age > dur - 0.6) op = Math.max(0, (dur - age) / 0.6);
    else op = 1;
    if (this.dom.bannerTitle.textContent !== this._banner.title) this.dom.bannerTitle.textContent = this._banner.title;
    if (this.dom.bannerSub.textContent !== this._banner.subtitle) this.dom.bannerSub.textContent = this._banner.subtitle;
    b.style.opacity = String(op);
  }

  _tickLog() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // Drop fully-faded lines from memory.
    while (this._logLines.length && (now - this._logLines[0].t) / 1000 > 8) this._logLines.shift();
    const visible = this._logLines.slice(-6);
    const els = this.dom.logLines;
    // els[0] is the topmost DOM row; newest message goes there, older below.
    for (let i = 0; i < els.length; i++) {
      const line = visible[visible.length - 1 - i];
      const el = els[i];
      if (!line) { el.style.opacity = '0'; continue; }
      const age = (now - line.t) / 1000;
      let op = 1;
      if (age > 5) op = Math.max(0, 1 - (age - 5) / 3);
      if (el.textContent !== line.text) el.textContent = line.text;
      // Message color (often pale, tuned for a dark backdrop) becomes a left
      // accent stripe instead of the text color, which stays dark for
      // readability against the bright scene/panels.
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

  // ---------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------
  _updateHud(game, dt) {
    const p = game.player;
    const c = this._cache;

    // HP / Mana bars.
    const hpPct = clamp(p.hp / Math.max(1, p.stats.maxHp), 0, 1);
    const hpStr = `${Math.round(p.hp)}/${Math.round(p.stats.maxHp)}`;
    if (c.hpPct !== hpPct) { this.dom.hpFill.style.width = `${hpPct * 100}%`; c.hpPct = hpPct; }
    if (c.hpStr !== hpStr) { this.dom.hpText.textContent = hpStr; c.hpStr = hpStr; }

    const manaPct = clamp(p.mana / Math.max(1, p.stats.maxMana), 0, 1);
    const manaStr = `${Math.round(p.mana)}/${Math.round(p.stats.maxMana)}`;
    if (c.manaPct !== manaPct) { this.dom.manaFill.style.width = `${manaPct * 100}%`; c.manaPct = manaPct; }
    if (c.manaStr !== manaStr) { this.dom.manaText.textContent = manaStr; c.manaStr = manaStr; }

    // Low HP vignette.
    const lowHp = hpPct < 0.3 && p.hp > 0;
    if (lowHp !== this._lowHpActive) {
      this._lowHpActive = lowHp;
      this.dom.vignette.classList.toggle('dm-active', lowHp);
    }

    // XP bar.
    const need = xpForLevel(p.level);
    const xpPct = clamp(p.xp / Math.max(1, need), 0, 1);
    const xpStr = `Lv ${p.level} — ${Math.floor(p.xp)}/${need} XP`;
    if (c.xpPct !== xpPct) { this.dom.xpFill.style.width = `${xpPct * 100}%`; c.xpPct = xpPct; }
    if (c.xpStr !== xpStr) { this.dom.xpText.textContent = xpStr; c.xpStr = xpStr; }

    // Top-left.
    const depthStr = `Depth ${game.depth}`;
    if (c.depthStr !== depthStr) { this.dom.depthText.textContent = depthStr; c.depthStr = depthStr; }
    const goldStr = String(p.gold || 0);
    if (c.goldStr !== goldStr) { this.dom.goldText.textContent = goldStr; c.goldStr = goldStr; }
    const killsStr = String((game.stats && game.stats.kills) || 0);
    if (c.killsStr !== killsStr) { this.dom.killsText.textContent = killsStr; c.killsStr = killsStr; }

    // Points-available badge.
    const hasPoints = (p.attrPoints > 0 || p.skillPoints > 0);
    if (c.hasPoints !== hasPoints) { this.dom.plusC.classList.toggle('dm-show', hasPoints); c.hasPoints = hasPoints; }

    // Skill slots.
    const gamepad = this.input && this.input.lastDevice === 'gamepad';
    const skills = p.skills || [];
    for (let i = 0; i < 4; i++) {
      const dom = this.dom.skillSlots[i];
      const sk = skills[i];
      const key = gamepad ? SKILL_PAD_LABEL[i] : SKILL_KEY_LABEL[i];
      const ck = `skill${i}`;
      if (c[ck + 'key'] !== key) {
        dom.key.textContent = key;
        dom.key.style.color = gamepad ? PAD_COLOR[key] : '';
        c[ck + 'key'] = key;
      }
      if (!sk) { if (c[ck + 'icon'] !== '') { dom.icon.textContent = ''; c[ck + 'icon'] = ''; } continue; }
      if (c[ck + 'icon'] !== sk.icon) { dom.icon.textContent = sk.icon; c[ck + 'icon'] = sk.icon; }
      const costStr = sk.manaCost ? String(sk.manaCost) : '';
      if (c[ck + 'cost'] !== costStr) { dom.cost.textContent = costStr; c[ck + 'cost'] = costStr; }
      const frac = clamp((sk.cooldown || 0) / Math.max(0.001, sk.baseCooldown || 1), 0, 1);
      const cdKey = frac.toFixed(3);
      if (c[ck + 'cd'] !== cdKey) {
        dom.sweep.style.background = frac > 0
          ? `conic-gradient(rgba(4,4,8,0.82) ${frac * 360}deg, transparent ${frac * 360}deg)`
          : 'none';
        c[ck + 'cd'] = cdKey;
      }
      const cdText = sk.cooldown > 0.05 ? sk.cooldown.toFixed(1) : '';
      if (c[ck + 'cdtext'] !== cdText) { dom.cdText.textContent = cdText; c[ck + 'cdtext'] = cdText; }
      const afford = p.mana >= (sk.manaCost || 0) && !p.dead;
      const greyed = !afford;
      if (c[ck + 'grey'] !== greyed) { dom.slot.classList.toggle('dm-noafford', greyed); c[ck + 'grey'] = greyed; }
    }

    // Potion counts.
    let healCount = 0, manaCount = 0;
    for (const it of (p.inventory || [])) {
      if (it && it.potion) {
        if (it.potion.heal) healCount += it.stack || 1;
        if (it.potion.mana) manaCount += it.stack || 1;
      }
    }
    if (c.healCount !== healCount) { this.dom.potHealCount.textContent = String(healCount); c.healCount = healCount; }
    if (c.manaCount !== manaCount) { this.dom.potManaCount.textContent = String(manaCount); c.manaCount = manaCount; }

    // Minimap (throttled ~10Hz).
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const mapChanged = game.map !== this._lastMapRef;
    if (mapChanged || now - this._lastMinimapDraw > 100) {
      this._lastMinimapDraw = now;
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
    const scale = Math.min(W / map.width, H / map.height);
    const offX = (W - map.width * scale) / 2;
    const offY = (H - map.height * scale) / 2;
    const cell = Math.max(1, Math.ceil(scale));

    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const idx = map.idx ? map.idx(x, y) : y * map.width + x;
        if (!map.explored[idx]) continue;
        const visible = !!map.visible[idx];
        const tile = map.tiles[idx];
        let color;
        // Bright theme: floors read as sunny sand, walls as cool slate — walls
        // stay darker than floors so the layout reads clearly on a light map.
        if (tile === TILE.WALL) color = visible ? 'rgba(90,99,116,0.92)' : 'rgba(163,171,184,0.6)';
        else color = visible ? 'rgba(255,224,150,0.95)' : 'rgba(230,221,196,0.65)';
        ctx.fillStyle = color;
        ctx.fillRect(offX + x * scale, offY + y * scale, cell, cell);
      }
    }

    // Entrance.
    if (map.entrance) {
      ctx.fillStyle = 'rgba(34,184,207,0.95)';
      ctx.fillRect(offX + map.entrance.x * scale - 1, offY + map.entrance.y * scale - 1, cell + 2, cell + 2);
    }

    // Exits (pulsing).
    const pulse = 0.5 + 0.5 * Math.sin((game.time || 0) * 4);
    if (Array.isArray(map.exits)) {
      for (const ex of map.exits) {
        const exIdx = map.idx ? map.idx(ex.x, ex.y) : ex.y * map.width + ex.x;
        if (!map.explored[exIdx]) continue;
        ctx.fillStyle = `rgba(255, ${Math.round(120 + 60 * pulse)}, 60, ${0.7 + 0.3 * pulse})`;
        const r = cell * 1.6;
        ctx.beginPath();
        ctx.arc(offX + ex.x * scale + cell / 2, offY + ex.y * scale + cell / 2, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Enemies (visible & living only) — red dot with a white ring so it still
    // pops against the light sand-colored floor tiles.
    for (const e of (game.enemies || [])) {
      if (!e || e.dead) continue;
      const eIdx = map.idx ? map.idx(e.x, e.y) : e.y * map.width + e.x;
      if (!map.visible[eIdx]) continue;
      const ex = offX + e.x * scale + cell / 2, ey = offY + e.y * scale + cell / 2, er = Math.max(1.5, cell * 0.6);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ex, ey, er + 1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e03131';
      ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.fill();
    }

    // Player — a saturated blue dot with a white ring; plain white alone would
    // vanish against the now-light minimap background.
    const p = game.player;
    if (p) {
      const px = offX + p.x * scale + cell / 2, py = offY + p.y * scale + cell / 2, pr = Math.max(2, cell * 0.75);
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
    if (spendAttribute(p, attrId)) this._refreshCharacterPanel();
  }

  _upgradeSkill(index) {
    const p = this.game && this.game.player;
    if (!p) return;
    if (upgradeSkill(p, index)) this._refreshCharacterPanel();
  }

  _refreshCharacterPanel() {
    const p = this.game && this.game.player;
    if (!p) return;
    this.dom.charLvlText.textContent = `Level ${p.level}`;
    this.dom.charXpText.textContent = `${Math.floor(p.xp)} / ${xpForLevel(p.level)} XP`;
    const pts = [];
    if (p.attrPoints > 0) pts.push(`${p.attrPoints} attribute point${p.attrPoints === 1 ? '' : 's'}`);
    if (p.skillPoints > 0) pts.push(`${p.skillPoints} skill point${p.skillPoints === 1 ? '' : 's'}`);
    this.dom.charPointsText.textContent = pts.join(' · ');

    for (const row of this.dom.attrRows) {
      row.value.textContent = String(p.base[row.attr.id]);
      row.plusBtn.style.visibility = p.attrPoints > 0 ? 'visible' : 'hidden';
    }

    const s = p.stats || {};
    const set = (k, v) => { this.dom.derivedRows[k].textContent = v; };
    set('maxHp', Math.round(s.maxHp));
    set('maxMana', Math.round(s.maxMana));
    set('melee', `${Math.round(s.meleeMin)}-${Math.round(s.meleeMax)}`);
    set('spellPower', Math.round(s.spellPower));
    set('defense', Math.round(s.defense));
    set('critChance', fmtPct(s.critChance));
    set('critMult', `x${(s.critMult || 1).toFixed(2)}`);
    set('moveSpeed', `${(1 / Math.max(0.001, s.moveCooldown)).toFixed(2)} tiles/s`);
    set('hpRegen', `${(s.hpRegen || 0).toFixed(1)}/s`);
    set('manaRegen', `${(s.manaRegen || 0).toFixed(1)}/s`);
    set('dodgeChance', fmtPct(s.dodgeChance));

    const skills = p.skills || [];
    for (let i = 0; i < this.dom.charSkillRows.length; i++) {
      const row = this.dom.charSkillRows[i];
      const sk = skills[i];
      if (!sk) continue;
      row.icon.textContent = sk.icon || '';
      row.name.textContent = sk.name || '';
      row.rank.textContent = `Rank ${sk.rank}/${sk.maxRank}`;
      row.desc.innerHTML = skillDescription(sk, p);
      row.upgradeBtn.style.visibility = (p.skillPoints > 0 && sk.rank < sk.maxRank) ? 'visible' : 'hidden';
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
      this._refreshInventoryPanel();
    }
  }

  _hoverPaperdoll(index, e) {
    const p = this.game && this.game.player;
    if (!p) return;
    const slotDef = SLOTS[index];
    const item = p.equipment[slotDef.id];
    if (item) {
      this._showTooltip(null, itemTooltip(item, p));
      this._positionTooltip(e.clientX, e.clientY);
    }
  }

  _clickInvCell(index, e) {
    const p = this.game && this.game.player;
    if (!p) return;
    const item = p.inventory[index];
    if (!item) return;
    if (e && e.shiftKey) {
      p.gold = (p.gold || 0) + sellValue(item);
      p.inventory.splice(index, 1);
    } else if (item.type === 'potion') {
      useItem(this.game, item);
    } else {
      equipItem(p, item);
    }
    this._refreshInventoryPanel();
  }

  _dropInvCell(index) {
    const p = this.game && this.game.player;
    if (!p) return;
    const item = p.inventory[index];
    if (!item) return;
    dropItem(this.game, item);
    this._refreshInventoryPanel();
  }

  _hoverInvCell(index, e) {
    const p = this.game && this.game.player;
    if (!p) return;
    const item = p.inventory[index];
    if (item) {
      this._showTooltip(null, itemTooltip(item, p));
      this._positionTooltip(e.clientX, e.clientY);
    }
  }

  _refreshInventoryPanel() {
    const p = this.game && this.game.player;
    if (!p) return;
    this.dom.invGoldText.textContent = `🪙 ${p.gold || 0}`;

    for (const s of this.dom.eqSlots) {
      const item = p.equipment[s.slotDef.id];
      s.icon.textContent = item ? item.icon : (s.slotDef.icon || '?');
      s.el.style.borderColor = item ? rarityBorderColor(item) : '';
      s.el.classList.toggle('dm-filled', !!item);
    }

    for (let i = 0; i < this.dom.invCells.length; i++) {
      const cellDom = this.dom.invCells[i];
      const item = p.inventory[i];
      if (!item) {
        cellDom.icon.textContent = '';
        cellDom.stack.textContent = '';
        cellDom.cell.style.borderColor = '';
        cellDom.cell.classList.remove('dm-filled');
        continue;
      }
      cellDom.icon.textContent = item.icon || '?';
      cellDom.stack.textContent = (item.stack && item.stack > 1) ? String(item.stack) : '';
      const rc = rarityBorderColor(item);
      cellDom.cell.style.borderColor = rc;
      cellDom.cell.style.setProperty('--item-glow', rc);
      cellDom.cell.classList.add('dm-filled');
    }

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
  // Tooltip
  // =====================================================================
  _showTooltip(el, html) {
    const tip = this.dom.tooltip;
    tip.innerHTML = html;
    tip.classList.add('dm-show');
    if (el) {
      const r = el.getBoundingClientRect();
      this._positionTooltip(r.left + r.width / 2, r.top);
    }
  }

  _hideTooltip() {
    this.dom.tooltip.classList.remove('dm-show');
  }

  _positionTooltip(x, y) {
    const tip = this.dom.tooltip;
    const pad = 12;
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
    if (input.pressed('character')) { if (this._characterOpen) this.closeAll(); else this.toggleCharacter(); return; }
    if (input.pressed('inventory')) { if (this._inventoryOpen) this.closeAll(); else this.toggleInventory(); return; }

    if (this._characterOpen) this._handleCharacterInput(input);
    else if (this._inventoryOpen) this._handleInventoryInput(input);
  }

  _handleCharacterInput(input) {
    const list = this._charFocusList();
    if (!list.length) return;
    if (input.pressed('ui_up')) { this._charCursor = (this._charCursor - 1 + list.length) % list.length; this._applyCharacterFocus(); }
    if (input.pressed('ui_down')) { this._charCursor = (this._charCursor + 1) % list.length; this._applyCharacterFocus(); }
    const focused = list[this._charCursor];
    if (focused && this._lastCharCursor !== this._charCursor) {
      this._lastCharCursor = this._charCursor;
      const p = this.game && this.game.player;
      if (focused.kind === 'attr') this._showTooltip(focused.el, `<b>${focused.ref.attr.name}</b><br>${focused.ref.attr.description}`);
      else if (p) {
        const sk = p.skills && p.skills[Number(focused.el.dataset.index)];
        if (sk) this._showTooltip(focused.el, skillDescription(sk, p));
      }
    }
    if (input.pressed('confirm') && focused) {
      const p = this.game && this.game.player;
      if (!p) return;
      this._lastCharCursor = -1; // stats may have changed — force tooltip refresh next frame
      if (focused.kind === 'attr') this._spendAttr(focused.ref.attr.id);
      else this._upgradeSkill(Number(focused.el.dataset.index));
    }
  }

  _handleInventoryInput(input) {
    const cols = 6;
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
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800&display=swap');

#ui { font-family: 'Nunito', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
#ui, #ui * { box-sizing: border-box; }
#ui button { font: inherit; color: inherit; appearance: none; -webkit-appearance: none; background: none; border: none; padding: 0; margin: 0; cursor: pointer; }
#ui table { border-spacing: 0; }
#ui .dm-root { position: absolute; inset: 0; overflow: hidden; }

:root {
  /* Bright, cheerful candy palette to match the re-themed 3D scene. */
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

  --dm-gold: var(--dm-yellow-deep);
  --dm-gold-bright: var(--dm-yellow-deep);
  --dm-hp: #fa5252;
  --dm-hp-light: rgba(255, 227, 227, 0.9);
  --dm-mana: #339af0;
  --dm-mana-light: rgba(231, 245, 255, 0.9);
  --dm-xp: #ffd43b;
  --dm-xp-light: rgba(243, 235, 255, 0.9);

  --dm-panel-bg: linear-gradient(180deg, rgba(255,255,255,0.95), rgba(255,250,240,0.92));
  --dm-panel-border: rgba(77,171,247,0.5);
  --dm-text: #2b2d42;
  --dm-text-dim: #6b7280;
}

.dm-hud { position: absolute; inset: 0; pointer-events: none; }

/* ---------- top-left ---------- */
.dm-topleft {
  position: absolute; top: clamp(10px, 2vmin, 24px); left: clamp(10px, 2vmin, 24px);
  display: flex; flex-direction: column; gap: 4px;
  background: rgba(255,255,255,0.78); border: 2px solid var(--dm-panel-border);
  border-radius: 12px; padding: clamp(6px,1vmin,12px) clamp(10px,1.6vmin,16px);
  backdrop-filter: blur(4px); box-shadow: 0 4px 14px rgba(43,45,66,0.12);
  font-size: clamp(12px, 1.6vmin, 16px); color: var(--dm-text); font-weight: 600;
}
.dm-tl-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.dm-tl-icon { font-size: 1.1em; }
.dm-depth { color: var(--dm-blue-deep); font-family: 'Fredoka', sans-serif; font-weight: 600; }
.dm-gold { color: var(--dm-yellow-deep); }
.dm-kills { color: var(--dm-coral-deep); }

/* ---------- minimap ---------- */
.dm-minimap-wrap {
  position: absolute; top: clamp(10px, 2vmin, 24px); right: clamp(10px, 2vmin, 24px);
  display: flex; flex-direction: column; align-items: center; gap: 6px;
}
.dm-minimap {
  width: clamp(120px, 20vmin, 220px); height: clamp(120px, 20vmin, 220px);
  border-radius: 12px; border: 2px solid var(--dm-panel-border);
  background: rgba(255,255,255,0.6); box-shadow: 0 4px 14px rgba(43,45,66,0.15);
}
.dm-mini-buttons { display: flex; gap: 8px; pointer-events: auto; }
.dm-badge {
  position: relative; pointer-events: auto; cursor: pointer;
  width: clamp(28px, 4vmin, 38px); height: clamp(28px, 4vmin, 38px);
  border-radius: 9px; border: 2px solid var(--dm-panel-border);
  background: rgba(255,255,255,0.82); color: var(--dm-blue-deep);
  font-family: 'Fredoka', sans-serif; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  font-size: clamp(12px, 1.8vmin, 16px);
  transition: background 0.15s, transform 0.1s;
}
.dm-badge:hover { background: rgba(77,171,247,0.22); transform: translateY(-1px); }
.dm-badge-plus {
  position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; border-radius: 50%;
  background: radial-gradient(circle, #fff3bf, #ffd43b); color: #7a4a00; font-size: 11px;
  display: none; align-items: center; justify-content: center; font-weight: 900;
  box-shadow: 0 0 8px 2px rgba(255,212,59,0.8);
  animation: dm-pulse 1.1s ease-in-out infinite;
}
.dm-badge-plus.dm-show { display: flex; }
@keyframes dm-pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.18); opacity: 0.75; } }

/* ---------- vignette ---------- */
.dm-vignette {
  position: absolute; inset: 0; pointer-events: none; opacity: 0;
  box-shadow: inset 0 0 14vmin 3vmin rgba(255,70,70,0.4);
  transition: opacity 0.3s;
}
.dm-vignette.dm-active { opacity: 1; animation: dm-vignette-pulse 1.4s ease-in-out infinite; }
@keyframes dm-vignette-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 0.7; } }

/* ---------- banner ---------- */
.dm-banner {
  position: absolute; top: 18%; left: 50%; transform: translate(-50%, -50%);
  text-align: center; opacity: 0; pointer-events: none; transition: opacity 0.15s linear;
}
.dm-banner-title {
  font-family: 'Fredoka', sans-serif; font-weight: 700; color: var(--dm-coral-deep);
  font-size: clamp(28px, 6vmin, 64px); letter-spacing: 0.04em;
  text-shadow: -2px 0 #fff, 2px 0 #fff, 0 -2px #fff, 0 2px #fff, 0 6px 18px rgba(43,45,66,0.25);
}
.dm-banner-sub {
  font-size: clamp(13px, 2vmin, 20px); color: var(--dm-text); margin-top: 4px; font-weight: 700;
  text-shadow: -1px 0 #fff, 1px 0 #fff, 0 -1px #fff, 0 1px #fff;
}

/* ---------- log ---------- */
.dm-log {
  position: absolute; left: clamp(10px, 2vmin, 24px); bottom: clamp(90px, 14vmin, 150px);
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px; max-width: min(46vw, 520px);
}
.dm-log-line {
  display: inline-block; max-width: 100%;
  font-size: clamp(11px, 1.5vmin, 15px); font-weight: 700; color: var(--dm-text);
  background: rgba(255,255,255,0.88); border-radius: 8px;
  padding: 2px 10px 2px 9px;
  box-shadow: inset 3px 0 0 0 var(--dm-log-accent, #4dabf7), 0 2px 6px rgba(43,45,66,0.15);
  opacity: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ---------- action bar ---------- */
.dm-actionbar {
  position: absolute; bottom: clamp(20px, 3.4vmin, 34px); left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-end; gap: clamp(10px, 1.6vmin, 22px);
  pointer-events: none;
}
.dm-bars { display: flex; flex-direction: column; gap: 6px; width: clamp(140px, 18vmin, 220px); }
.dm-bar {
  position: relative; height: clamp(14px, 2.2vmin, 20px); border-radius: 6px;
  background: rgba(255,255,255,0.55); border: 2px solid rgba(255,255,255,0.7); overflow: hidden;
  box-shadow: 0 2px 6px rgba(43,45,66,0.15);
}
.dm-bar-fill { position: absolute; inset: 0; width: 0%; transition: width 0.15s ease-out; }
.dm-hpbar { background: var(--dm-hp-light); }
.dm-hpbar .dm-bar-fill { background: linear-gradient(180deg, #ff8787, var(--dm-hp)); }
.dm-manabar { background: var(--dm-mana-light); }
.dm-manabar .dm-bar-fill { background: linear-gradient(180deg, #74c0fc, var(--dm-mana)); }
.dm-bar-text {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: clamp(9px, 1.3vmin, 12px); font-weight: 800; color: var(--dm-text);
  text-shadow: 0 1px 0 rgba(255,255,255,0.6);
}

.dm-skills { display: flex; gap: clamp(6px, 1vmin, 12px); }
.dm-skill-slot {
  position: relative; width: clamp(44px, 6.5vmin, 68px); height: clamp(44px, 6.5vmin, 68px);
  border-radius: 12px; background: rgba(255,255,255,0.82); border: 2px solid var(--dm-panel-border);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  box-shadow: 0 3px 8px rgba(43,45,66,0.15);
}
.dm-skill-icon { font-size: clamp(18px, 3vmin, 30px); }
.dm-skill-sweep { position: absolute; inset: 0; pointer-events: none; }
.dm-skill-cd {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: clamp(12px, 2vmin, 18px); font-weight: 800; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.9);
}
.dm-skill-key {
  position: absolute; top: 2px; left: 2px; font-size: clamp(9px, 1.2vmin, 11px);
  color: var(--dm-yellow); font-weight: 800; background: rgba(43,45,66,0.85);
  border-radius: 6px; padding: 0 4px; line-height: 1.4;
}
.dm-skill-cost {
  position: absolute; bottom: 2px; right: 4px; font-size: clamp(9px, 1.2vmin, 11px); font-weight: 800;
  color: var(--dm-blue-deep); text-shadow: 0 1px 0 rgba(255,255,255,0.7);
}
.dm-skill-slot.dm-noafford { filter: grayscale(0.85) opacity(0.5); }

.dm-potions { display: flex; gap: clamp(6px, 1vmin, 12px); }
.dm-potion-slot {
  position: relative; pointer-events: auto; cursor: pointer;
  width: clamp(36px, 5.2vmin, 52px); height: clamp(36px, 5.2vmin, 52px);
  border-radius: 50%; background: rgba(255,255,255,0.82); border: 2px solid var(--dm-panel-border);
  display: flex; align-items: center; justify-content: center; color: var(--dm-text);
  box-shadow: 0 3px 8px rgba(43,45,66,0.15);
}
.dm-potion-heal { border-color: var(--dm-coral); }
.dm-potion-mana { border-color: var(--dm-blue); }
.dm-potion-icon { font-size: clamp(16px, 2.4vmin, 24px); }
.dm-potion-count {
  position: absolute; bottom: -6px; right: -4px; background: rgba(43,45,66,0.88); border-radius: 8px;
  padding: 0 4px; font-size: 10px; font-weight: 700; color: #fff;
}
.dm-potion-key {
  position: absolute; top: -6px; left: -4px; background: rgba(43,45,66,0.88); border-radius: 8px;
  padding: 0 4px; font-size: 9px; font-weight: 700; color: var(--dm-yellow);
}

.dm-xpbar {
  position: absolute; left: 0; right: 0; bottom: 0; height: clamp(6px, 0.8vmin, 10px);
  background: var(--dm-xp-light);
}
.dm-xpbar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, var(--dm-grape), var(--dm-xp)); transition: width 0.2s; }
.dm-xpbar-text {
  position: absolute; right: 10px; bottom: 100%; margin-bottom: 3px;
  font-size: clamp(10px, 1.3vmin, 13px); font-weight: 700; color: var(--dm-text);
  background: rgba(255,255,255,0.85); border-radius: 6px; padding: 1px 8px;
}

/* ---------- panels ---------- */
.dm-panel {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.97);
  width: min(920px, 92vw); max-height: 86vh; overflow-y: auto;
  background: var(--dm-panel-bg); border: 2px solid var(--dm-panel-border); border-radius: 20px;
  box-shadow: 0 20px 60px rgba(77,171,247,0.25), 0 0 0 1px rgba(255,255,255,0.6) inset;
  padding: clamp(14px, 2vmin, 26px);
  color: var(--dm-text);
  pointer-events: none;
  opacity: 0; visibility: hidden;
  transition: opacity 0.15s ease, transform 0.15s ease, visibility 0s linear 0.15s;
}
.dm-panel.dm-open {
  pointer-events: auto; opacity: 1; visibility: visible; transform: translate(-50%, -50%) scale(1);
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.dm-panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.dm-panel-title { font-family: 'Fredoka', sans-serif; font-size: clamp(18px, 2.4vmin, 26px); color: var(--dm-blue-deep); }
.dm-character .dm-panel-title { color: var(--dm-coral-deep); }
.dm-inventory .dm-panel-title { color: var(--dm-grape-deep); }
.dm-panel-close {
  pointer-events: auto; cursor: pointer; background: rgba(43,45,66,0.06); border: 2px solid var(--dm-panel-border);
  color: var(--dm-text); border-radius: 8px; width: 30px; height: 30px; font-weight: 700;
}
.dm-panel-close:hover { background: rgba(43,45,66,0.14); }
.dm-panel-body { display: flex; flex-wrap: wrap; gap: clamp(14px, 2vmin, 28px); }
.dm-section { flex: 1 1 260px; min-width: 220px; }
.dm-section-title {
  font-family: 'Fredoka', sans-serif; color: var(--dm-blue-deep); font-size: clamp(13px, 1.7vmin, 16px);
  border-bottom: 2px solid var(--dm-panel-border); padding-bottom: 4px; margin-bottom: 8px;
}

.dm-char-sub { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; color: var(--dm-text-dim); font-size: clamp(12px,1.5vmin,14px); font-weight: 700; }
.dm-char-points { color: var(--dm-yellow-deep); }

.dm-attr-list, .dm-derived-list, .dm-charskill-list { display: flex; flex-direction: column; gap: 6px; }
.dm-attr-row, .dm-derived-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 5px 8px; border-radius: 8px; background: rgba(43,45,66,0.04);
}
.dm-attr-row.dm-focused, .dm-charskill-row.dm-focused { outline: 2px solid var(--dm-blue-deep); background: rgba(77,171,247,0.15); }
.dm-attr-name, .dm-derived-name { color: var(--dm-text-dim); font-size: clamp(11px,1.4vmin,13px); font-weight: 700; }
.dm-attr-value, .dm-derived-value { font-weight: 800; }
.dm-attr-plus {
  pointer-events: auto; cursor: pointer; visibility: hidden;
  width: 22px; height: 22px; border-radius: 7px; border: 2px solid var(--dm-mint);
  background: rgba(81,207,102,0.2); color: var(--dm-mint-deep); font-weight: 900;
}
.dm-attr-plus:hover { background: rgba(81,207,102,0.4); }

.dm-charskill-row { padding: 6px 8px; border-radius: 10px; background: rgba(43,45,66,0.04); }
.dm-charskill-head { display: flex; align-items: center; gap: 8px; }
.dm-charskill-icon { font-size: 20px; }
.dm-charskill-name { font-weight: 800; flex: 1; }
.dm-charskill-rank { color: var(--dm-text-dim); font-size: 12px; font-weight: 700; }
.dm-charskill-upgrade {
  pointer-events: auto; cursor: pointer; visibility: hidden; font-family: 'Fredoka', sans-serif;
  border: 2px solid var(--dm-mint); background: rgba(81,207,102,0.2); color: var(--dm-mint-deep);
  border-radius: 8px; padding: 3px 8px; font-size: 12px; font-weight: 700;
}
.dm-charskill-upgrade:hover { background: rgba(81,207,102,0.4); }
.dm-charskill-desc { font-size: 12px; color: var(--dm-text-dim); margin-top: 4px; font-weight: 600; }

/* ---------- inventory ---------- */
.dm-inv-gold { color: var(--dm-yellow-deep); font-weight: 800; }
.dm-inv-body { align-items: flex-start; }
.dm-paperdoll {
  display: grid; gap: 8px; flex: 0 0 auto;
  grid-template-columns: repeat(3, clamp(48px, 6.5vmin, 74px));
  grid-template-rows: repeat(4, clamp(48px, 6.5vmin, 74px));
  grid-template-areas:
    ".    helm   ."
    "weapon armor offhand"
    ".    boots  ."
    "ring .      amulet";
}
.dm-eq-slot {
  pointer-events: auto; cursor: pointer; position: relative;
  border: 2px dashed rgba(77,171,247,0.4); border-radius: 12px;
  background: rgba(43,45,66,0.03);
  display: flex; align-items: center; justify-content: center; flex-direction: column;
}
.dm-eq-slot.dm-filled { border-style: solid; }
.dm-eq-slot.dm-focused { outline: 2px solid var(--dm-blue-deep); }
.dm-eq-icon { font-size: clamp(18px, 2.6vmin, 26px); }
.dm-eq-label { position: absolute; bottom: -16px; font-size: 9px; color: var(--dm-text-dim); white-space: nowrap; font-weight: 700; }

.dm-inv-grid-wrap { flex: 1 1 320px; }
.dm-inv-grid {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px;
}
.dm-inv-cell {
  pointer-events: auto; cursor: pointer; position: relative; aspect-ratio: 1;
  border: 2px solid rgba(43,45,66,0.14); border-radius: 10px; background: rgba(43,45,66,0.03);
  display: flex; align-items: center; justify-content: center;
}
.dm-inv-cell.dm-filled { box-shadow: 0 0 8px 1px var(--item-glow, rgba(150,150,150,0.5)); }
.dm-inv-cell.dm-focused { outline: 2px solid var(--dm-blue-deep); }
.dm-inv-icon { font-size: clamp(16px, 2.4vmin, 24px); }
.dm-inv-stack { position: absolute; bottom: 2px; right: 4px; font-size: 10px; font-weight: 800; color: var(--dm-text); text-shadow: 0 1px 1px rgba(255,255,255,0.8); }

/* ---------- tooltip ---------- */
.dm-tooltip {
  position: fixed; z-index: 90; max-width: 280px; pointer-events: none;
  background: rgba(255,255,255,0.97); border: 2px solid var(--dm-panel-border); border-radius: 12px;
  padding: 8px 10px; font-size: 12px; color: var(--dm-text); line-height: 1.4; font-weight: 600;
  opacity: 0; transform: translateY(2px); transition: opacity 0.1s;
  box-shadow: 0 10px 30px rgba(43,45,66,0.25);
}
.dm-tooltip.dm-show { opacity: 1; }
/* items.js supplies rarity/delta colors inline (tuned for a dark backdrop).
   A dark header band behind the name/rarity lines keeps those hues legible
   on our light tooltip; comparison deltas get a colored accent bar instead
   of relying on the raw text color alone for contrast. */
.dm-tooltip .tt-name {
  margin: -8px -10px 0; padding: 8px 10px 2px; background: var(--dm-text);
  border-radius: 10px 10px 0 0; font-size: 13px;
}
.dm-tooltip .tt-rarity {
  margin: 0 -10px 8px; padding: 0 10px 8px; background: var(--dm-text);
  border-radius: 0 0 10px 10px; font-size: 11px; font-weight: 700; opacity: 0.92;
}
.dm-tooltip .tt-primary { font-weight: 700; margin-bottom: 4px; }
.dm-tooltip .tt-stat { color: var(--dm-mint-deep); font-weight: 700; }
.dm-tooltip .tt-stack, .dm-tooltip .tt-ilvl { color: var(--dm-text-dim); font-size: 11px; }
.dm-tooltip .tt-value { color: var(--dm-yellow-deep); font-weight: 800; margin-top: 2px; }
.dm-tooltip .tt-compare { margin-top: 6px; padding-top: 6px; border-top: 2px dashed rgba(43,45,66,0.15); }
.dm-tooltip .tt-cmp-line { font-weight: 800; padding: 1px 0 1px 8px; margin: 2px 0; border-radius: 2px; box-shadow: inset 3px 0 0 0 currentColor; }
.dm-tooltip .tt-compare-empty { color: #6b7280 !important; font-weight: 600; }

/* ---------- overlays ---------- */
.dm-overlay {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: linear-gradient(160deg, rgba(224,242,254,0.95), rgba(255,255,255,0.92));
  pointer-events: none; z-index: 100;
}
.dm-overlay.dm-open { display: flex; pointer-events: auto; }
.dm-pause.dm-open { background: linear-gradient(160deg, rgba(255,255,255,0.55), rgba(224,242,254,0.5)); backdrop-filter: blur(6px); }
.dm-death.dm-open { background: linear-gradient(160deg, rgba(255,214,214,0.95), rgba(255,255,255,0.92)); }
.dm-overlay-card {
  max-width: min(680px, 92vw); max-height: 88vh; overflow-y: auto; text-align: center;
  background: var(--dm-panel-bg); border: 2px solid var(--dm-panel-border); border-radius: 24px;
  padding: clamp(20px, 3vmin, 40px); box-shadow: 0 24px 60px rgba(77,171,247,0.25);
}
.dm-death .dm-overlay-card { border-color: rgba(255,135,135,0.6); box-shadow: 0 24px 60px rgba(255,135,135,0.25); }
.dm-title {
  font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: clamp(28px, 5vmin, 52px); color: var(--dm-coral-deep);
  letter-spacing: 0.05em; text-shadow: 0 3px 0 rgba(255,255,255,0.7), 0 6px 20px rgba(255,135,135,0.35); margin-bottom: 8px;
}
.dm-title-sm { font-size: clamp(22px, 4vmin, 36px); }
.dm-pause .dm-title-sm { color: var(--dm-blue-deep); text-shadow: 0 3px 0 rgba(255,255,255,0.7), 0 6px 20px rgba(77,171,247,0.35); }
.dm-tagline { color: var(--dm-text-dim); margin-bottom: 18px; font-weight: 700; }
.dm-controls-table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: clamp(11px, 1.4vmin, 14px); }
.dm-controls-table th, .dm-controls-table td { padding: 5px 8px; border-bottom: 1px solid rgba(43,45,66,0.1); text-align: left; }
.dm-controls-table th { color: var(--dm-blue-deep); font-family: 'Fredoka', sans-serif; font-weight: 700; }
.dm-controls-table td { color: var(--dm-text); font-weight: 600; }
.dm-press-any { margin-top: 12px; color: var(--dm-text-dim); font-size: 13px; font-weight: 700; animation: dm-blink 1.6s ease-in-out infinite; }
@keyframes dm-blink { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
.dm-pause-hint { color: var(--dm-text-dim); font-size: 12px; margin-top: 8px; font-weight: 700; }
.dm-death-summary { display: flex; flex-direction: column; gap: 4px; margin: 16px 0; font-size: clamp(13px, 1.8vmin, 16px); color: var(--dm-text); font-weight: 700; }
.dm-btn {
  pointer-events: auto; cursor: pointer; font-family: 'Fredoka', sans-serif; font-size: clamp(14px, 1.8vmin, 18px);
  font-weight: 700; padding: 10px 30px; border-radius: 999px; border: none; color: #fff;
  background: linear-gradient(180deg, #69db7c, #51cf66);
  box-shadow: 0 4px 0 #2f9e44, 0 8px 16px rgba(81,207,102,0.35);
  margin-top: 8px; transition: transform 0.1s, box-shadow 0.1s;
}
.dm-btn:hover { transform: translateY(-1px); box-shadow: 0 5px 0 #2f9e44, 0 10px 20px rgba(81,207,102,0.4); }
.dm-btn:active { transform: translateY(2px); box-shadow: 0 2px 0 #2f9e44; }
.dm-btn-primary { font-weight: 800; }

@media (max-width: 700px) {
  .dm-inv-body { flex-direction: column; }
  .dm-paperdoll { margin: 0 auto; }
}
`;
