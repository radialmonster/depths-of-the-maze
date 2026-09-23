// Keyboard + Gamepad abstraction. Owned by the UI agent — see DESIGN.md §12.
// Pure input layer: no DOM beyond window listeners, no game logic.
import { DIRS } from './core.js';

// ---------------------------------------------------------------------------
// Mapping tables (see DESIGN.md §12 for the authoritative action list).
// ---------------------------------------------------------------------------

// Keyboard action -> array of e.code values. Movement/ui-direction codes are
// handled separately via the held-state system (see DIR_KEYS below) so they
// are deliberately NOT listed here.
const ACTION_KEYS = {
  skill1: ['Digit1', 'Numpad1'],
  skill2: ['Digit2', 'Numpad2'],
  skill3: ['Digit3', 'Numpad3'],
  skill4: ['Digit4', 'Numpad4'],
  character: ['KeyC'],
  inventory: ['KeyI', 'Tab'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'KeyE', 'Space'],
  cancel: ['Escape'],
  drop: ['KeyQ', 'Delete'],
  potion: ['KeyH'],
  mana_potion: ['KeyM'],
  mute: ['KeyU'], // 'M' is already bound to mana_potion, so mute uses U instead
};

// Gamepad action -> array of standard-mapping button indices.
const ACTION_BUTTONS = {
  skill1: [0],  // A
  skill2: [2],  // X
  skill3: [3],  // Y
  skill4: [1],  // B
  character: [8, 4], // Back/View or LB
  inventory: [5],    // RB
  pause: [9],        // Start
  confirm: [0],      // A
  cancel: [1],       // B
  drop: [2],         // X
  potion: [6],       // LT
  mana_potion: [7],  // RT
  tab_prev: [4],     // LB — cycles panel tabs while a panel is open
  tab_next: [5],     // RB
};

// Directional keys used for both orthogonal movement and ui_* navigation.
const DIR_KEYS = {
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
};
const DIR_BUTTONS = { up: 12, down: 13, left: 14, right: 15 };
const DIR_NAMES = ['up', 'down', 'left', 'right'];

// Keys whose default browser behavior (scrolling, tab focus change) we suppress.
const PREVENT_DEFAULT_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
]);

const GAMEPAD_DEADZONE = 0.5;
const STICK_DEADZONE = 0.22; // radial deadzone for analog (free) movement
const UI_REPEAT_DELAY = 0.35; // seconds before first auto-repeat
const UI_REPEAT_INTERVAL = 0.12; // seconds between subsequent auto-repeats

// Reverse map: keyboard code -> [action, ...]
const CODE_TO_ACTIONS = {};
for (const action in ACTION_KEYS) {
  for (const code of ACTION_KEYS[action]) {
    (CODE_TO_ACTIONS[code] || (CODE_TO_ACTIONS[code] = [])).push(action);
  }
}
// Reverse map: gamepad button index -> [action, ...]
const BUTTON_TO_ACTIONS = {};
for (const action in ACTION_BUTTONS) {
  for (const btn of ACTION_BUTTONS[action]) {
    (BUTTON_TO_ACTIONS[btn] || (BUTTON_TO_ACTIONS[btn] = [])).push(action);
  }
}

export class Input {
  constructor() {
    this.lastDevice = 'keyboard';

    // Keyboard state.
    this._heldKeys = new Set();       // codes currently down
    this._kbQueue = [];               // queued non-repeat keydown codes, flushed in update()

    // Cross-device directional held-state (combined keyboard + dpad + stick).
    this._dirHeldNow = { up: false, down: false, left: false, right: false };
    this._dirHeldPrev = { up: false, down: false, left: false, right: false };
    this._dirRepeatTimer = { up: 0, down: 0, left: 0, right: 0 };
    this._moveStack = []; // stack of dir names, most-recently-pressed last

    // This-frame results.
    this._frameEdges = new Set();     // action names that went down this frame
    this._anyEdgeThisFrame = false;

    // Gamepad state (per button index -> pressed bool from previous poll).
    this._padButtonsPrev = {};
    this._padButtonsNow = {};

    this._lastTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this._onKeyDown = (e) => {
      this.lastDevice = 'keyboard';
      if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
      if (!this._heldKeys.has(e.code)) {
        this._heldKeys.add(e.code);
        this._anyEdgeThisFrame = true;
        if (!e.repeat) this._kbQueue.push(e.code);
      }
    };
    this._onKeyUp = (e) => {
      if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
      this._heldKeys.delete(e.code);
    };
    this._onBlur = () => {
      this._heldKeys.clear();
      this._kbQueue.length = 0;
      this._moveStack.length = 0;
      this._dirHeldNow = { up: false, down: false, left: false, right: false };
      this._dirHeldPrev = { up: false, down: false, left: false, right: false };
      this._dirRepeatTimer = { up: 0, down: 0, left: 0, right: 0 };
    };

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp, { passive: false });
    window.addEventListener('blur', this._onBlur);
  }

  // -------------------------------------------------------------------
  // update() — call once per frame BEFORE reading pressed()/moveDir()/etc.
  // -------------------------------------------------------------------
  update() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = Math.max(0, Math.min(0.25, (now - this._lastTime) / 1000));
    this._lastTime = now;

    this._frameEdges = new Set();
    this._anyEdgeThisFrame = false;

    // --- Flush queued keyboard edges (non-movement actions) ---
    // Codes pressed since last frame also count as held this frame, so quick taps
    // (keydown+keyup between two frames) still produce a movement step.
    const tapped = new Set(this._kbQueue);
    if (this._kbQueue.length) {
      for (const code of this._kbQueue) {
        const actions = CODE_TO_ACTIONS[code];
        if (actions) for (const a of actions) this._frameEdges.add(a);
        this._anyEdgeThisFrame = true;
      }
      this._kbQueue.length = 0;
    }

    // --- Keyboard directional held-state ---
    const kbDir = { up: false, down: false, left: false, right: false };
    for (const dir of DIR_NAMES) {
      for (const code of DIR_KEYS[dir]) {
        if (this._heldKeys.has(code) || tapped.has(code)) { kbDir[dir] = true; break; }
      }
    }

    // --- Poll gamepad ---
    let padDir = { up: false, down: false, left: false, right: false };
    const pads = (typeof navigator !== 'undefined' && navigator.getGamepads) ? navigator.getGamepads() : [];
    let pad = null;
    for (let i = 0; i < pads.length; i++) { if (pads[i]) { pad = pads[i]; break; } }
    this._stick = null;

    this._padButtonsPrev = this._padButtonsNow;
    this._padButtonsNow = {};

    if (pad) {
      let padActive = false;

      // Face/shoulder/trigger buttons.
      for (let i = 0; i < pad.buttons.length; i++) {
        const pressed = !!(pad.buttons[i] && pad.buttons[i].pressed);
        this._padButtonsNow[i] = pressed;
        if (pressed) padActive = true;
        const wasPressed = !!this._padButtonsPrev[i];
        if (pressed && !wasPressed) {
          const actions = BUTTON_TO_ACTIONS[i];
          if (actions) for (const a of actions) this._frameEdges.add(a);
          this._anyEdgeThisFrame = true;
        }
      }

      // D-pad (buttons 12-15) feed the directional held-state too.
      for (const dir of DIR_NAMES) {
        const btn = DIR_BUTTONS[dir];
        if (this._padButtonsNow[btn]) padDir[dir] = true;
      }

      // Left stick: dominant axis wins, deadzone 0.5.
      const ax = pad.axes[0] || 0;
      const ay = pad.axes[1] || 0;
      // Free-movement vector: radial deadzone, magnitude rescaled to 0..1.
      const len = Math.hypot(ax, ay);
      if (len > STICK_DEADZONE) {
        const mag = Math.min(1, (len - STICK_DEADZONE) / (1 - STICK_DEADZONE));
        this._stick = { x: ax / len, y: ay / len, mag };
        padActive = true;
      }
      if (Math.abs(ax) > Math.abs(ay)) {
        if (Math.abs(ax) > GAMEPAD_DEADZONE) { padDir[ax < 0 ? 'left' : 'right'] = true; padActive = true; }
      } else {
        if (Math.abs(ay) > GAMEPAD_DEADZONE) { padDir[ay < 0 ? 'up' : 'down'] = true; padActive = true; }
      }

      if (padActive) this.lastDevice = 'gamepad';
    }

    // --- Combine directional sources ---
    this._dirHeldNow = {
      up: kbDir.up || padDir.up,
      down: kbDir.down || padDir.down,
      left: kbDir.left || padDir.left,
      right: kbDir.right || padDir.right,
    };

    // --- Transitions: movement stack + ui_* edges with auto-repeat ---
    for (const dir of DIR_NAMES) {
      const now2 = this._dirHeldNow[dir];
      const was = this._dirHeldPrev[dir];
      if (now2 && !was) {
        // Fresh press.
        const idx = this._moveStack.indexOf(dir);
        if (idx !== -1) this._moveStack.splice(idx, 1);
        this._moveStack.push(dir);
        this._dirRepeatTimer[dir] = UI_REPEAT_DELAY;
        this._frameEdges.add('ui_' + dir);
        this._anyEdgeThisFrame = true;
      } else if (!now2 && was) {
        // Released.
        const idx = this._moveStack.indexOf(dir);
        if (idx !== -1) this._moveStack.splice(idx, 1);
        this._dirRepeatTimer[dir] = 0;
      } else if (now2 && was) {
        // Held: auto-repeat for menu navigation.
        this._dirRepeatTimer[dir] -= dt;
        if (this._dirRepeatTimer[dir] <= 0) {
          this._frameEdges.add('ui_' + dir);
          this._dirRepeatTimer[dir] = UI_REPEAT_INTERVAL;
        }
      }
    }
    this._dirHeldPrev = this._dirHeldNow;
  }

  // -------------------------------------------------------------------
  // moveDir() -> {x,y}|null   Orthogonal only; most-recently-pressed held
  // direction wins (stack-based), works uniformly for keyboard/dpad/stick.
  // -------------------------------------------------------------------
  moveDir() {
    if (!this._moveStack.length) return null;
    const dir = this._moveStack[this._moveStack.length - 1];
    const v = DIRS[dir];
    return v ? { x: v.x, y: v.y } : null;
  }

  // -------------------------------------------------------------------
  // analogMove() -> {x,y,mag}|null   Left-stick direction (unit vector) and
  // push strength 0..1, for free (non-tile) movement. Null inside the deadzone.
  // -------------------------------------------------------------------
  analogMove() {
    return this.stickOverride || this._stick || null; // stickOverride: debug/testing hook
  }

  // -------------------------------------------------------------------
  // pressed(action) -> true only on the frame the action went down.
  // -------------------------------------------------------------------
  pressed(action) {
    return this._frameEdges.has(action);
  }

  // -------------------------------------------------------------------
  // held(action) -> true while the underlying control is down.
  // -------------------------------------------------------------------
  held(action) {
    if (action.startsWith('ui_')) {
      const dir = action.slice(3);
      return !!this._dirHeldNow[dir];
    }
    const codes = ACTION_KEYS[action];
    if (codes) {
      for (const c of codes) if (this._heldKeys.has(c)) return true;
    }
    const buttons = ACTION_BUTTONS[action];
    if (buttons) {
      for (const b of buttons) if (this._padButtonsNow[b]) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // anyPressed() -> true on a frame where ANY key/button/stick-direction
  // newly went down. For title screens ("press any key to begin").
  // -------------------------------------------------------------------
  anyPressed() {
    return this._anyEdgeThisFrame;
  }
}
