// Procedural sound effects (Web Audio API, no audio files). Owned by no one module — pure
// self-contained singleton, wired to game.bus by wireAudio(). See DESIGN.md §6 for the bus events.
// Every public method is a silent no-op if the AudioContext isn't created/running and never throws.

const MUTE_KEY = 'dotm.muted';
const MAX_VOICES = 24;
const RESUME_RETRY_MS = 1000; // how often tryResume() re-asks a suspended context to start
const MASTER_VOLUME = 0.8; // peaks measured ~0.1-0.35 of full scale at 0.5; the compressor catches stacking
const NOISE_DUR = 1; // seconds of cached white noise

function loadMuted() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(MUTE_KEY) === '1';
  } catch (e) { /* ignore (private mode, disabled storage, etc.) */ }
  return false;
}

function saveMuted(v) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MUTE_KEY, v ? '1' : '0');
  } catch (e) { /* ignore */ }
}

class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.noiseBuffer = null;
    this.muted = loadMuted();
    this._voices = 0;
    this._lastPlay = new Map(); // sound name -> ms timestamp, for per-sound throttling
    this._unlockBound = false;
    this._lastResumeTry = 0;
    if (typeof window !== 'undefined') {
      this._bindUnlockListeners();
      // Create the context right away: when the browser already allows sound for this site
      // (installed app, site set to allow sound, frequently played site) it starts running with
      // no click at all, so controller-only players get sound. Otherwise it waits suspended.
      this.unlock();
    }
  }

  _bindUnlockListeners() {
    if (this._unlockBound) return;
    this._unlockBound = true;
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
  }

  // Creates the AudioContext (once) and resumes it. Must be called from a user gesture the
  // first time — gamepad input doesn't count as one in browsers, keyboard/mouse does.
  unlock() {
    try {
      if (!this.ctx) {
        const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return;
        const ctx = new AC();
        const master = ctx.createGain();
        master.gain.value = MASTER_VOLUME;
        const compressor = ctx.createDynamicsCompressor();
        master.connect(compressor);
        compressor.connect(ctx.destination);
        this.ctx = ctx;
        this.master = master;
        this.compressor = compressor;
        this._buildNoiseBuffer();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // Harmless resume attempt for devices that can't unlock audio (gamepad). No-op if already
  // running or the context doesn't exist yet.
  tryResume() {
    try {
      if (!this.ctx || this.ctx.state !== 'suspended') return;
      // Throttled: called every frame, and a refused resume() can log a browser warning each time.
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - this._lastResumeTry < RESUME_RETRY_MS) return;
      this._lastResumeTry = now;
      this.ctx.resume().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  _buildNoiseBuffer() {
    try {
      const len = Math.max(1, Math.round(this.ctx.sampleRate * NOISE_DUR));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    } catch (e) { this.noiseBuffer = null; }
  }

  setMuted(v) {
    this.muted = !!v;
    saveMuted(this.muted);
  }
  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // True while sound is wanted but the browser hasn't allowed it yet — browsers only start audio
  // after a click or key press (gamepad buttons don't count), so the HUD shows a hint meanwhile.
  needsGesture() {
    return !this.muted && (!this.ctx || this.ctx.state !== 'running');
  }

  _ready() {
    return !!(this.ctx && this.ctx.state === 'running' && !this.muted && this.noiseBuffer);
  }

  // Gate a sound: checks context readiness, per-sound throttle and the simultaneous-voice cap.
  // Returns false (do nothing) if the sound should be skipped.
  _gate(name, throttleMs, durSec) {
    if (!this._ready()) return false;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const last = this._lastPlay.get(name) || 0;
    if (now - last < throttleMs) return false;
    if (this._voices >= MAX_VOICES) return false;
    this._voices++;
    setTimeout(() => { this._voices = Math.max(0, this._voices - 1); }, Math.max(20, (durSec || 0.2) * 1000) + 80);
    this._lastPlay.set(name, now);
    return true;
  }

  // ±pct random pitch variation so repeated sounds don't sound robotic.
  _pitch(base, pct = 0.06) {
    return base * (1 + (Math.random() * 2 - 1) * pct);
  }

  // Gain node with an exponential attack/decay envelope (never ramps to exactly 0).
  _envGain(t0, peak, attack, hold, release) {
    const g = this.ctx.createGain();
    const a = Math.max(0.002, attack);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    if (hold > 0) g.gain.setValueAtTime(Math.max(0.0002, peak), t0 + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + hold + Math.max(0.01, release));
    return g;
  }

  // Oscillator tone, optionally sweeping frequency, through its own envelope, into master.
  _tone(type, t0, freq0, freq1, dur, peak, opts = {}) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, freq0), t0);
    if (freq1 !== undefined && freq1 !== freq0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq1), t0 + dur);
    }
    if (opts.detune) osc.detune.value = opts.detune;
    const g = this._envGain(t0, peak, opts.attack ?? Math.min(0.015, dur * 0.2), opts.hold ?? 0, opts.release ?? dur);
    let last = g;
    if (opts.lowpass) {
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = opts.lowpass;
      g.connect(filt);
      last = filt;
    }
    osc.connect(g);
    last.connect(this.master);
    const stopAt = t0 + dur + (opts.release ?? dur) + 0.05;
    osc.start(t0);
    osc.stop(stopAt);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); if (last !== g) last.disconnect(); } catch (e) { /* ignore */ } };
    return osc;
  }

  // Filtered white-noise burst through its own envelope, into master.
  _noise(t0, dur, filterType, freq0, freq1, peak, opts = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filt = this.ctx.createBiquadFilter();
    filt.type = filterType;
    filt.Q.value = opts.q ?? 0.9;
    filt.frequency.setValueAtTime(Math.max(10, freq0), t0);
    if (freq1 !== undefined && freq1 !== freq0) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(10, freq1), t0 + dur);
    }
    const g = this._envGain(t0, peak, opts.attack ?? Math.min(0.015, dur * 0.2), opts.hold ?? 0, opts.release ?? dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.master);
    const stopAt = t0 + dur + (opts.release ?? dur) + 0.05;
    src.start(t0);
    src.stop(stopAt);
    src.onended = () => { try { src.disconnect(); filt.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } };
    return src;
  }

  // ---------------------------------------------------------------------
  // Sounds
  // ---------------------------------------------------------------------

  swing() {
    if (!this._gate('swing', 40, 0.15)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._noise(t0, 0.15, 'bandpass', this._pitch(3200, 0.08), 500, 0.32, { q: 1.1, release: 0.1 });
    } catch (e) { /* ignore */ }
  }

  hit(crit) {
    if (!this._gate(crit ? 'crit' : 'hit', 40, 0.15)) return;
    try {
      const t0 = this.ctx.currentTime;
      const base = crit ? this._pitch(200, 0.08) : this._pitch(130, 0.08);
      this._tone('triangle', t0, base, base * 0.5, crit ? 0.1 : 0.07, crit ? 0.55 : 0.32);
      this._noise(t0, 0.045, 'lowpass', 3500, 1200, crit ? 0.22 : 0.14, { release: 0.03 });
      if (crit) {
        // Metallic ring on top for crits.
        this._tone('square', t0, this._pitch(1800, 0.1), undefined, 0.22, 0.1, { attack: 0.004, release: 0.2 });
      }
    } catch (e) { /* ignore */ }
  }

  enemyDeath() {
    if (!this._gate('enemyDeath', 40, 0.22)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('square', t0, this._pitch(420, 0.06), this._pitch(140, 0.06), 0.18, 0.28);
      this._noise(t0 + 0.02, 0.12, 'lowpass', 2500, 400, 0.18, { release: 0.1 });
    } catch (e) { /* ignore */ }
  }

  bossDeath() {
    if (!this._gate('bossDeath', 100, 1.2)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sine', t0, 90, 32, 0.9, 0.6, { attack: 0.02, release: 0.9 });
      this._noise(t0, 1.2, 'lowpass', 900, 80, 0.35, { release: 1.0 });
    } catch (e) { /* ignore */ }
  }

  bolt() {
    if (!this._gate('bolt', 40, 0.2)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sawtooth', t0, this._pitch(280, 0.06), this._pitch(950, 0.06), 0.2, 0.22, { lowpass: 2600, release: 0.12 });
    } catch (e) { /* ignore */ }
  }

  nova() {
    if (!this._gate('nova', 40, 0.5)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._noise(t0, 0.5, 'highpass', 1200, 2600, 0.22, { release: 0.4 });
      const notes = [1800, 2200, 2600, 3100, 3600];
      for (const f of notes) {
        this._tone('sine', t0, this._pitch(f, 0.05), undefined, 0.28, 0.08, { attack: 0.005, release: 0.22, detune: (Math.random() * 2 - 1) * 20 });
      }
    } catch (e) { /* ignore */ }
  }

  dash() {
    if (!this._gate('dash', 40, 0.16)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._noise(t0, 0.16, 'lowpass', 300, 4200, 0.28, { release: 0.1 });
    } catch (e) { /* ignore */ }
  }

  playerHurt() {
    if (!this._gate('playerHurt', 40, 0.15)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('square', t0, this._pitch(220, 0.07), this._pitch(95, 0.07), 0.13, 0.28);
      this._noise(t0, 0.08, 'lowpass', 2000, 600, 0.14, { release: 0.06 });
    } catch (e) { /* ignore */ }
  }

  dodge() {
    if (!this._gate('dodge', 40, 0.08)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._noise(t0, 0.08, 'highpass', 2500, 4500, 0.1, { release: 0.06 });
    } catch (e) { /* ignore */ }
  }

  enemyShot() {
    if (!this._gate('enemyShot', 40, 0.18)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sine', t0, this._pitch(140, 0.08), this._pitch(380, 0.08), 0.18, 0.14, { lowpass: 1400, release: 0.12 });
    } catch (e) { /* ignore */ }
  }

  bossSlam() {
    if (!this._gate('bossSlam', 100, 0.3)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sine', t0, 60, 30, 0.28, 0.55, { attack: 0.005, release: 0.24 });
      this._noise(t0, 0.2, 'lowpass', 700, 150, 0.3, { release: 0.14 });
    } catch (e) { /* ignore */ }
  }

  // Low procedural growl: two detuned sub-bass oscillators sweeping down through a
  // lowpass-filtered noise rumble. Used for the boss intro and the phase-2 "enrage" cue.
  bossRoar() {
    if (!this._gate('bossRoar', 300, 1.1)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sawtooth', t0, this._pitch(85, 0.05), 42, 0.9, 0.5, { attack: 0.03, release: 0.7, lowpass: 700 });
      this._tone('sawtooth', t0 + 0.02, this._pitch(80, 0.05), 38, 0.9, 0.38, { attack: 0.04, release: 0.7, lowpass: 600, detune: -18 });
      this._noise(t0, 0.85, 'lowpass', 900, 180, 0.32, { attack: 0.04, release: 0.6 });
    } catch (e) { /* ignore */ }
  }

  gold() {
    if (!this._gate('gold', 40, 0.2)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('triangle', t0, this._pitch(988, 0.03), undefined, 0.08, 0.16, { attack: 0.004, release: 0.07 });
      this._tone('triangle', t0 + 0.06, this._pitch(1319, 0.03), undefined, 0.1, 0.18, { attack: 0.004, release: 0.09 });
    } catch (e) { /* ignore */ }
  }

  // Coin clink + a soft rising two-note chord — used for both buying and selling at a merchant.
  purchase() {
    if (!this._gate('purchase', 60, 0.35)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('triangle', t0, this._pitch(1046.5, 0.03), undefined, 0.09, 0.15, { attack: 0.004, release: 0.08 });
      this._tone('triangle', t0 + 0.05, this._pitch(1568, 0.03), undefined, 0.1, 0.12, { attack: 0.004, release: 0.09 });
      this._tone('sine', t0 + 0.02, 523.25, undefined, 0.3, 0.12, { attack: 0.01, release: 0.26 });
      this._tone('sine', t0 + 0.02, 659.25, undefined, 0.3, 0.09, { attack: 0.01, release: 0.26 });
    } catch (e) { /* ignore */ }
  }

  itemPickup(rarity) {
    if (!this._gate('itemPickup', 40, 0.4)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('triangle', t0, this._pitch(600, 0.04), this._pitch(760, 0.04), 0.09, 0.16, { attack: 0.004, release: 0.08 });
      const counts = { rare: 2, epic: 3, legendary: 4 };
      const n = counts[rarity] || 0;
      if (n > 0) {
        const base = 880;
        for (let i = 0; i < n; i++) {
          const f = base * Math.pow(2, i / 6); // gentle rising sparkle
          this._tone('sine', t0 + 0.1 + i * 0.07, f, undefined, 0.12, 0.12, { attack: 0.004, release: 0.1 });
        }
      }
    } catch (e) { /* ignore */ }
  }

  potion(kind) {
    if (!this._gate('potion', 40, 0.3)) return;
    try {
      const t0 = this.ctx.currentTime;
      const isMana = kind === 'mana';
      const lo = isMana ? 700 : 450;
      const hi = isMana ? 1100 : 750;
      const blips = 4;
      for (let i = 0; i < blips; i++) {
        const f = lo + Math.random() * (hi - lo);
        this._tone('sine', t0 + i * 0.06, f, f * 0.85, 0.07, isMana ? 0.14 : 0.12, { attack: 0.005, release: 0.05 });
      }
    } catch (e) { /* ignore */ }
  }

  levelUp() {
    if (!this._gate('levelUp', 200, 0.7)) return;
    try {
      const t0 = this.ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
      notes.forEach((f, i) => {
        const t = t0 + i * 0.15;
        this._tone('triangle', t, f, undefined, 0.35, 0.22, { attack: 0.006, release: 0.3 });
        this._tone('square', t, f, undefined, 0.25, 0.07, { attack: 0.006, release: 0.2 });
      });
    } catch (e) { /* ignore */ }
  }

  stairs() {
    if (!this._gate('stairs', 200, 0.8)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._noise(t0, 0.4, 'lowpass', 1800, 200, 0.22, { release: 0.3 });
      this._tone('sine', t0 + 0.05, 130, 80, 0.7, 0.3, { attack: 0.02, release: 0.65 });
    } catch (e) { /* ignore */ }
  }

  playerDeath() {
    if (!this._gate('playerDeath', 500, 1.2)) return;
    try {
      const t0 = this.ctx.currentTime;
      const notes = [440, 415.3, 329.63, 261.63]; // A4, Ab4, E4, C4 — slow descending minor-ish
      notes.forEach((f, i) => {
        this._tone('triangle', t0 + i * 0.28, f, f * 0.9, 0.4, 0.2, { attack: 0.02, release: 0.35 });
      });
    } catch (e) { /* ignore */ }
  }

  uiClick() {
    if (!this._gate('uiClick', 40, 0.05)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('triangle', t0, this._pitch(700, 0.04), 500, 0.04, 0.06, { attack: 0.003, release: 0.03 });
    } catch (e) { /* ignore */ }
  }

  uiOpen() {
    if (!this._gate('uiOpen', 40, 0.06)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('triangle', t0, this._pitch(500, 0.04), 800, 0.06, 0.06, { attack: 0.003, release: 0.05 });
    } catch (e) { /* ignore */ }
  }

  denied() {
    if (!this._gate('denied', 200, 0.12)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('square', t0, 90, undefined, 0.1, 0.12, { attack: 0.004, release: 0.09 });
      this._tone('square', t0, 85, undefined, 0.1, 0.08, { attack: 0.004, release: 0.09, detune: 12 });
    } catch (e) { /* ignore */ }
  }
}

export const sfx = new Sfx();

// ---------------------------------------------------------------------------
// wireAudio — subscribes sfx to the game's bus so gameplay modules stay clean.
// Call once from main.js after `game` (and its bus) exist.
// ---------------------------------------------------------------------------
export function wireAudio(game) {
  if (!game || !game.bus) return;
  const bus = game.bus;

  bus.on('skillUsed', ({ skill }) => {
    switch (skill && skill.id) {
      case 'cleave': sfx.swing(); break;
      case 'arcaneBolt': sfx.bolt(); break;
      case 'frostNova': sfx.nova(); break;
      case 'shadowDash': sfx.dash(); break;
      default: break;
    }
  });

  bus.on('enemyKilled', ({ enemy }) => {
    if (enemy && enemy.behavior === 'boss') sfx.bossDeath();
    else sfx.enemyDeath();
  });

  bus.on('playerDamaged', () => sfx.playerHurt());
  bus.on('playerDodged', () => sfx.dodge());
  bus.on('bossSlam', () => sfx.bossSlam());
  bus.on('bossIntro', () => sfx.bossRoar());
  bus.on('bossPhase2', () => sfx.bossRoar());

  bus.on('goldPickedUp', () => sfx.gold());
  bus.on('itemPickedUp', ({ item }) => sfx.itemPickup(item && item.rarity));
  bus.on('itemBought', () => sfx.purchase());
  bus.on('itemSold', () => sfx.purchase());
  bus.on('potionUsed', ({ kind }) => sfx.potion(kind));
  bus.on('levelUp', () => sfx.levelUp());
  bus.on('playerDied', () => sfx.playerDeath());
  bus.on('denied', () => sfx.denied());
}
