// Procedural sound effects (Web Audio API, no audio files). Owned by no one module — pure
// self-contained singleton, wired to game.bus by wireAudio(). See DESIGN.md §6 for the bus events.
// Every public method is a silent no-op if the AudioContext isn't created/running and never throws.
// Also owns the procedural music (music.js) once the AudioContext exists: `sfx.music`.
//
// Output graph:  SFX voices -> master (SFX bus) -> sfx compressor ─┐
//                music.js bus ──────────────────────────────────────┼─> limiter -> out (mute) -> speakers
//                reverb sends -> convolver -> reverb return ─────────┘
import { Music } from './music.js';

const MUTE_KEY = 'dotm.muted';
const MAX_VOICES = 24;
const RESUME_RETRY_MS = 1000; // how often tryResume() re-asks a suspended context to start
const MASTER_VOLUME = 0.8; // SFX bus. Peaks measured ~0.1-0.35 of full scale; the compressor catches stacking
const NOISE_DUR = 1; // seconds of cached white noise
const REVERB_SECONDS = 2.4;   // procedural impulse-response length
const REVERB_RETURN = 0.55;   // wet level of the shared reverb
const SFX_SEND = 0.18;        // default reverb send for SFX that ask for "send: true"
const FOOTSTEP_PEAK = 0.05;   // footsteps stay barely-there
const FOOTSTEP_THROTTLE_MS = 140;

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
        compressor.threshold.value = -18;
        compressor.knee.value = 12;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.2;
        // Brick-wall-ish limiter on the final mix (SFX + music + reverb) so nothing ever clips.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.12;
        const out = ctx.createGain();
        out.gain.value = this.muted ? 0 : 1;
        master.connect(compressor);
        compressor.connect(limiter);
        limiter.connect(out);
        out.connect(ctx.destination);
        this.ctx = ctx;
        this.master = master;
        this.compressor = compressor;
        this.limiter = limiter;
        this.out = out;
        this.liveNodes = 0; // SFX nodes still playing (leak check)
        this._buildNoiseBuffer();
        this._buildReverb();
        try { this.music = new Music(ctx, limiter, this.reverbIn, this); } catch (e) { this.music = null; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // Shared reverb: a convolver fed with a procedurally generated, darkened stereo noise tail.
  _buildReverb() {
    try {
      const ctx = this.ctx;
      const len = Math.round(ctx.sampleRate * REVERB_SECONDS);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const x = i / len;
          lp += 0.35 * ((Math.random() * 2 - 1) - lp); // one-pole low-pass: darker, softer tail
          d[i] = lp * Math.pow(1 - x, 2.6) * (i < 90 ? i / 90 : 1);
        }
      }
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      const ret = ctx.createGain();
      ret.gain.value = REVERB_RETURN;
      const input = ctx.createGain();
      input.connect(conv);
      conv.connect(ret);
      ret.connect(this.limiter);
      this.reverbIn = input;
    } catch (e) { this.reverbIn = null; }
  }

  // Called every frame from main.js; the music decides its own state from the game.
  musicObserve(game, mode, modalOpen) {
    if (this.music) this.music.observe(game, mode, modalOpen);
  }

  musicEnabled() { return this.music ? this.music.enabled : true; }
  toggleMusic() { return this.music ? this.music.toggle() : true; }

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
    try {
      if (this.out) {
        const t = this.ctx.currentTime;
        this.out.gain.cancelScheduledValues(t);
        this.out.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.03);
      }
    } catch (e) { /* ignore */ }
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
    // opts.lowpass (Hz) kept for compatibility; opts.filter = {type, freq, q} for anything else.
    const fo = opts.filter || (opts.lowpass ? { type: 'lowpass', freq: opts.lowpass } : null);
    if (fo) {
      const filt = this.ctx.createBiquadFilter();
      filt.type = fo.type || 'lowpass';
      filt.frequency.value = fo.freq;
      if (fo.q !== undefined) filt.Q.value = fo.q;
      g.connect(filt);
      last = filt;
    }
    osc.connect(g);
    last.connect(this.master);
    const send = this._send(last, opts.send);
    const stopAt = t0 + dur + (opts.release ?? dur) + 0.05;
    osc.start(t0);
    osc.stop(stopAt);
    const n = 2 + (last !== g ? 1 : 0) + (send ? 1 : 0);
    this.liveNodes += n;
    osc.onended = () => {
      try { osc.disconnect(); g.disconnect(); if (last !== g) last.disconnect(); if (send) send.disconnect(); } catch (e) { /* ignore */ }
      this.liveNodes -= n;
    };
    return osc;
  }

  // Optional reverb send from a voice's last node. `amount`: true = SFX_SEND, or a number.
  _send(node, amount) {
    if (!amount || !this.reverbIn) return null;
    const s = this.ctx.createGain();
    s.gain.value = amount === true ? SFX_SEND : amount;
    node.connect(s);
    s.connect(this.reverbIn);
    return s;
  }

  // Filtered white-noise burst through its own envelope, into master.
  _noise(t0, dur, filterType, freq0, freq1, peak, opts = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true; // long bursts (boss death, stairs) outlast the 1s cached buffer
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
    const send = this._send(g, opts.send);
    const stopAt = t0 + dur + (opts.release ?? dur) + 0.05;
    // Random offset into the cached noise so repeats never sound byte-identical.
    src.start(t0, Math.random() * Math.max(0, NOISE_DUR - 0.5));
    src.stop(stopAt);
    const n = 3 + (send ? 1 : 0);
    this.liveNodes += n;
    src.onended = () => {
      try { src.disconnect(); filt.disconnect(); g.disconnect(); if (send) send.disconnect(); } catch (e) { /* ignore */ }
      this.liveNodes -= n;
    };
    return src;
  }

  // ---------------------------------------------------------------------
  // Sounds
  // ---------------------------------------------------------------------

  // Random float in [a, b).
  _rand(a, b) { return a + Math.random() * (b - a); }

  // Cleave: a whoosh sweeping down + a soft air body; now and then a faint blade "shing".
  swing() {
    if (!this._gate('swing', 40, 0.16)) return;
    try {
      const t0 = this.ctx.currentTime;
      const f = this._pitch(2600, 0.12);
      this._noise(t0, 0.16, 'bandpass', f * 1.3, f * 0.25, 0.26, { q: 1.4, attack: 0.02, release: 0.1 });
      this._noise(t0, 0.12, 'lowpass', 650, 250, 0.1, { attack: 0.015, release: 0.08 });
      if (Math.random() < 0.45) this._tone('sine', t0 + 0.02, this._pitch(3400, 0.1), undefined, 0.04, 0.02, { attack: 0.003, release: 0.09 });
    } catch (e) { /* ignore */ }
  }

  // Layered impact: transient click + body thud + mid crunch, flavoured by element.
  // `dull` = point-blank weapon shot (§17.12): a quieter, muffled thud with no bright layers.
  hit(crit, element, dull = false) {
    if (this.music) this.music.notifyCombat();
    if (dull) { this._dullHit(); return; }
    if (!this._gate(crit ? 'crit' : 'hit', 40, 0.2)) return;
    try {
      const t0 = this.ctx.currentTime;
      const el = element || 'physical';
      this._noise(t0, 0.012, 'highpass', 2500, 2500, crit ? 0.26 : 0.17, { attack: 0.001, release: 0.02 });
      const base = this._pitch(crit ? 175 : 140, 0.1);
      this._tone('sine', t0, base, base * 0.4, crit ? 0.12 : 0.08, crit ? 0.5 : 0.34, { attack: 0.002, release: crit ? 0.1 : 0.07 });
      this._noise(t0, 0.05, 'bandpass', this._pitch(1100, 0.2), 500, crit ? 0.2 : 0.13, { q: 1.2, release: 0.04 });
      if (el === 'arcane') {
        const f = this._pitch(1500, 0.08);
        this._tone('sine', t0 + 0.01, f, f * 1.2, 0.1, 0.045, { attack: 0.004, release: 0.12, detune: 10, send: true });
        this._tone('sine', t0 + 0.01, f * 1.5, f * 1.8, 0.1, 0.03, { attack: 0.004, release: 0.12, detune: -10, send: true });
      } else if (el === 'frost') {
        const pings = [2637, 3136, 3520, 3951];
        for (let k = 0; k < 2; k++) {
          this._tone('triangle', t0 + k * 0.03, pings[(Math.random() * 4) | 0], undefined, 0.03, 0.035, { attack: 0.002, release: 0.16, send: true });
        }
      } else {
        this._tone('triangle', t0, this._pitch(85, 0.1), 48, 0.07, 0.16, { attack: 0.002, release: 0.06 });
      }
      if (crit) {
        // Metallic ring (inharmonic partials) + a short upward zing.
        const f = this._pitch(1250, 0.05);
        this._tone('sine', t0, f, undefined, 0.02, 0.07, { attack: 0.002, release: 0.28, send: true });
        this._tone('sine', t0, f * 2.76, undefined, 0.02, 0.035, { attack: 0.002, release: 0.18 });
        this._tone('square', t0 + 0.01, 900, 1800, 0.05, 0.03, { attack: 0.003, release: 0.05, lowpass: 3000 });
      }
    } catch (e) { /* ignore */ }
  }

  _dullHit() {
    if (!this._gate('hitDull', 40, 0.12)) return;
    try {
      const t0 = this.ctx.currentTime;
      const base = this._pitch(110, 0.1);
      this._tone('sine', t0, base, base * 0.5, 0.06, 0.2, { attack: 0.003, release: 0.05 });
      this._noise(t0, 0.04, 'lowpass', this._pitch(700, 0.15), 300, 0.08, { release: 0.03 });
    } catch (e) { /* ignore */ }
  }

  // Bow Shot release: a plucked-string twang (quick downward pitch) + a short airy arrow hiss.
  bowShot() {
    if (!this._gate('bowShot', 40, 0.18)) return;
    try {
      const t0 = this.ctx.currentTime;
      const f = this._pitch(220, 0.08);
      this._tone('triangle', t0, f * 1.6, f, 0.09, 0.2, { attack: 0.002, release: 0.08 });
      this._tone('sawtooth', t0, f * 3.2, f * 2, 0.05, 0.035, { attack: 0.002, release: 0.05, lowpass: 2200 });
      this._noise(t0 + 0.01, 0.14, 'bandpass', this._pitch(4200, 0.15), 2400, 0.09, { q: 1.1, attack: 0.01, release: 0.1 });
    } catch (e) { /* ignore */ }
  }

  // Spark (wand): a light, quick arcane zap — a short upward chirp + a tiny crackle. Deliberately smaller and
  // drier than Arcane Bolt's cast (no long shimmer tail), since it's the free filler fired constantly.
  spark() {
    if (!this._gate('spark', 40, 0.16)) return;
    try {
      const t0 = this.ctx.currentTime;
      const f = this._pitch(900, 0.1);
      this._tone('square', t0, f, f * 2.2, 0.06, 0.05, { attack: 0.002, release: 0.04, lowpass: 3500 });
      this._tone('sine', t0, f * 2, f * 3.4, 0.07, 0.04, { attack: 0.002, release: 0.06, detune: 8, send: 0.15 });
      this._noise(t0, 0.05, 'highpass', 5000, 7000, 0.06, { attack: 0.001, release: 0.03 });
    } catch (e) { /* ignore */ }
  }

  // Staff Sweep: a broader, lower whoosh than Cleave's swing (the staff goes all the way around), with the arcane
  // detuned-shimmer layer (§17.2) riding on top so it reads as a caster weapon.
  staffSweep() {
    if (!this._gate('staffSweep', 40, 0.2)) return;
    try {
      const t0 = this.ctx.currentTime;
      const f = this._pitch(1500, 0.1);
      this._noise(t0, 0.24, 'bandpass', f * 0.6, f * 1.6, 0.26, { q: 1.1, attack: 0.03, release: 0.12 });
      this._noise(t0, 0.18, 'lowpass', 500, 220, 0.12, { attack: 0.02, release: 0.1 });
      const s = this._pitch(1200, 0.06);
      this._tone('sine', t0 + 0.04, s, s * 1.25, 0.16, 0.03, { attack: 0.02, release: 0.14, detune: 12, send: 0.25 });
      this._tone('sine', t0 + 0.04, s * 1.5, s * 1.9, 0.16, 0.022, { attack: 0.02, release: 0.14, detune: -12, send: 0.25 });
    } catch (e) { /* ignore */ }
  }

  // Squelchy pop + puff, a faint "confirm" ping; elites get an extra sub boom.
  enemyDeath(elite) {
    if (!this._gate('enemyDeath', 40, 0.25)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('triangle', t0, this._pitch(380, 0.12), this._pitch(90, 0.1), 0.2, 0.24, { attack: 0.003, release: 0.14 });
      this._noise(t0 + 0.01, 0.18, 'lowpass', this._pitch(2200, 0.15), 300, 0.15, { release: 0.14 });
      this._tone('sine', t0 + 0.05, this._pitch(1320, 0.03), undefined, 0.02, 0.03, { attack: 0.003, release: 0.12 });
      if (elite) {
        this._tone('sine', t0, 75, 34, 0.3, 0.32, { attack: 0.004, release: 0.25, send: 0.25 });
      }
    } catch (e) { /* ignore */ }
  }

  // Long boom, collapsing rumble and scattered rubble.
  bossDeath() {
    if (!this._gate('bossDeath', 100, 1.6)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sine', t0, 90, 28, 1.0, 0.6, { attack: 0.02, release: 1.0 });
      this._tone('sawtooth', t0 + 0.05, 380, 55, 0.9, 0.1, { attack: 0.02, release: 0.8, lowpass: 900, send: 0.3 });
      this._noise(t0, 1.4, 'lowpass', 1200, 60, 0.34, { release: 1.1, send: 0.4 });
      for (let k = 0; k < 6; k++) {
        this._noise(t0 + this._rand(0.12, 1.2), 0.04, 'bandpass', this._rand(300, 900), undefined, this._rand(0.06, 0.12), { q: 2, release: 0.05 });
      }
    } catch (e) { /* ignore */ }
  }

  // Arcane Bolt: rising bandpassed saw + detuned shimmer pair + airy sparkle.
  bolt() {
    if (!this._gate('bolt', 40, 0.22)) return;
    try {
      const t0 = this.ctx.currentTime;
      const f = this._pitch(300, 0.08);
      this._tone('sawtooth', t0, f, f * 3.3, 0.18, 0.13, { filter: { type: 'bandpass', freq: 1400, q: 1.2 }, release: 0.1 });
      this._tone('sine', t0, f * 3, f * 6, 0.16, 0.07, { detune: 12, release: 0.12, send: true });
      this._tone('sine', t0, f * 4.5, f * 9, 0.16, 0.045, { detune: -12, release: 0.14, send: true });
      this._noise(t0, 0.14, 'highpass', 5000, 8000, 0.045, { release: 0.1 });
    } catch (e) { /* ignore */ }
  }

  // Frost Nova: icy hiss burst, low whump, and a scatter of crystalline pings.
  nova() {
    if (!this._gate('nova', 40, 0.6)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._noise(t0, 0.45, 'highpass', 1500, 4000, 0.17, { attack: 0.01, release: 0.35, send: 0.3 });
      this._tone('sine', t0, 160, 70, 0.2, 0.28, { attack: 0.004, release: 0.15 });
      const pent = [2093, 2349.3, 2637, 3136, 3520, 4186];
      for (let k = 0; k < 5; k++) {
        const f = pent[(Math.random() * pent.length) | 0];
        this._tone(k % 2 ? 'sine' : 'triangle', t0 + k * 0.025 + this._rand(0, 0.02), f, undefined, 0.02, 0.045,
          { attack: 0.002, release: this._rand(0.25, 0.45), detune: this._rand(-15, 15), send: 0.3 });
      }
      for (let k = 0; k < 3; k++) {
        this._noise(t0 + this._rand(0.05, 0.3), 0.01, 'highpass', 6000, undefined, 0.05, { attack: 0.001, release: 0.015 });
      }
    } catch (e) { /* ignore */ }
  }

  // Shadow Dash: rushing band-swept whoosh with a sub push and a short airy tail.
  dash() {
    if (!this._gate('dash', 40, 0.25)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._noise(t0, 0.2, 'bandpass', 400, 3500, 0.26, { q: 0.8, attack: 0.03, release: 0.12 });
      this._tone('sine', t0, 90, 55, 0.12, 0.16, { attack: 0.01, release: 0.1 });
      this._noise(t0 + 0.12, 0.1, 'highpass', 3000, 1500, 0.05, { release: 0.08 });
    } catch (e) { /* ignore */ }
  }

  // Thud + a short filtered "grunt" + scrape.
  playerHurt() {
    if (!this._gate('playerHurt', 40, 0.18)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sine', t0, this._pitch(150, 0.1), 60, 0.1, 0.34, { attack: 0.002, release: 0.08 });
      this._tone('sawtooth', t0, this._pitch(210, 0.1), this._pitch(120, 0.1), 0.12, 0.12, { filter: { type: 'bandpass', freq: this._pitch(600, 0.15), q: 2 }, release: 0.08 });
      this._noise(t0, 0.07, 'lowpass', 1800, 500, 0.12, { release: 0.06 });
    } catch (e) { /* ignore */ }
  }

  dodge() {
    if (!this._gate('dodge', 40, 0.1)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._noise(t0, 0.08, 'highpass', 2500, 4500, 0.08, { release: 0.06 });
      this._noise(t0 + 0.02, 0.07, 'bandpass', 1800, 900, 0.05, { q: 1.5, release: 0.05 });
    } catch (e) { /* ignore */ }
  }

  enemyShot() {
    if (!this._gate('enemyShot', 40, 0.18)) return;
    try {
      const t0 = this.ctx.currentTime;
      const f = this._pitch(140, 0.1);
      this._tone('sine', t0, f, f * 2.7, 0.18, 0.13, { lowpass: 1400, release: 0.12 });
      this._noise(t0, 0.05, 'bandpass', this._pitch(1200, 0.2), 600, 0.04, { q: 1.5, release: 0.04 });
    } catch (e) { /* ignore */ }
  }

  // Sub boom + crunch + scattered debris ticks.
  bossSlam() {
    if (!this._gate('bossSlam', 100, 0.45)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sine', t0, 70, 28, 0.35, 0.58, { attack: 0.004, release: 0.28 });
      this._noise(t0, 0.28, 'lowpass', 900, 120, 0.32, { release: 0.18, send: 0.3 });
      for (let k = 0; k < 4; k++) {
        this._noise(t0 + this._rand(0.08, 0.4), 0.02, 'bandpass', this._rand(1500, 3500), undefined, 0.05, { q: 2, release: 0.03 });
      }
    } catch (e) { /* ignore */ }
  }

  // Wind-up warning as a boss begins a telegraphed attack: a low swell under two rising blips.
  bossTelegraph() {
    if (!this._gate('bossTelegraph', 350, 0.35)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sine', t0, 110, 150, 0.3, 0.1, { attack: 0.08, release: 0.15 });
      this._tone('triangle', t0, 330, 440, 0.07, 0.07, { attack: 0.004, release: 0.06, lowpass: 2000 });
      this._tone('triangle', t0 + 0.11, 440, 587, 0.08, 0.08, { attack: 0.004, release: 0.08, lowpass: 2200 });
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
      this._noise(t0, 0.85, 'lowpass', 900, 180, 0.32, { attack: 0.04, release: 0.6, send: 0.35 });
      // Throaty formant on top so it reads as a voice, not just rumble.
      this._tone('sawtooth', t0 + 0.05, this._pitch(120, 0.06), 70, 0.8, 0.14, { attack: 0.08, release: 0.5, filter: { type: 'bandpass', freq: 450, q: 4 } });
    } catch (e) { /* ignore */ }
  }

  // Coin clinks (inharmonic pairs, more for bigger piles) then a small two-note shine.
  gold(amount) {
    if (!this._gate('gold', 40, 0.3)) return;
    try {
      const t0 = this.ctx.currentTime;
      const n = amount >= 100 ? 4 : amount >= 25 ? 3 : 2;
      for (let k = 0; k < n; k++) {
        const t = t0 + k * 0.05 + this._rand(0, 0.015);
        const f = this._pitch(2400, 0.12);
        this._tone('sine', t, f, undefined, 0.01, 0.07, { attack: 0.002, release: 0.12 });
        this._tone('sine', t, f * 2.76, undefined, 0.01, 0.025, { attack: 0.002, release: 0.06 });
      }
      const ts = t0 + n * 0.05;
      this._tone('triangle', ts, this._pitch(988, 0.02), undefined, 0.06, 0.1, { attack: 0.004, release: 0.07 });
      this._tone('triangle', ts + 0.06, this._pitch(1319, 0.02), undefined, 0.08, 0.11, { attack: 0.004, release: 0.12, send: true });
    } catch (e) { /* ignore */ }
  }

  // Coin cascade + a warm major chord — used for both buying and selling at a merchant.
  purchase() {
    if (!this._gate('purchase', 60, 0.5)) return;
    try {
      const t0 = this.ctx.currentTime;
      for (let k = 0; k < 4; k++) {
        const f = this._pitch(2200, 0.15);
        this._tone('sine', t0 + k * 0.04 + this._rand(0, 0.012), f, undefined, 0.01, 0.06, { attack: 0.002, release: 0.1 });
      }
      this._tone('triangle', t0 + 0.12, this._pitch(1046.5, 0.02), undefined, 0.09, 0.12, { attack: 0.004, release: 0.1 });
      this._tone('triangle', t0 + 0.17, this._pitch(1568, 0.02), undefined, 0.1, 0.1, { attack: 0.004, release: 0.14, send: true });
      for (const f of [523.25, 659.25, 783.99]) {
        this._tone('sine', t0 + 0.12, f, undefined, 0.3, 0.06, { attack: 0.02, release: 0.35, send: true });
      }
    } catch (e) { /* ignore */ }
  }

  // Leather/cloth thump for everything; magic+ adds a rising pentatonic chime (more notes per
  // rarity), epic/legendary add a shimmer swell, legendary a low bloom.
  itemPickup(rarity) {
    if (!this._gate('itemPickup', 40, 0.6)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._noise(t0, 0.06, 'lowpass', 900, 300, 0.13, { release: 0.05 });
      this._tone('triangle', t0, this._pitch(520, 0.05), this._pitch(700, 0.05), 0.08, 0.12, { attack: 0.003, release: 0.07 });
      const counts = { magic: 1, rare: 2, epic: 3, legendary: 5 };
      const n = counts[rarity] || 0;
      const pent = [0, 2, 4, 7, 9, 12];
      for (let i = 0; i < n; i++) {
        const f = 880 * Math.pow(2, pent[i] / 12);
        const t = t0 + 0.08 + i * 0.07;
        this._tone('triangle', t, f, undefined, 0.05, 0.08, { attack: 0.003, release: 0.18, send: true });
        this._tone('sine', t, f * 2, undefined, 0.03, 0.025, { attack: 0.003, release: 0.1 });
      }
      if (rarity === 'epic' || rarity === 'legendary') {
        const t = t0 + 0.08 + n * 0.07;
        this._tone('sine', t, 1760, undefined, 0.15, 0.035, { attack: 0.1, release: 0.6, detune: 8, send: 0.4 });
        this._tone('sine', t, 1760 * 1.5, undefined, 0.15, 0.025, { attack: 0.1, release: 0.6, detune: -8, send: 0.4 });
      }
      if (rarity === 'legendary') {
        this._tone('sine', t0 + 0.05, 110, 82, 0.4, 0.16, { attack: 0.05, release: 0.5, send: 0.3 });
      }
    } catch (e) { /* ignore */ }
  }

  // Glugs (quick rising bubbles) then a shimmer: warm triad for health, cool high one for mana.
  potion(kind) {
    if (!this._gate('potion', 40, 0.6)) return;
    try {
      const t0 = this.ctx.currentTime;
      const isMana = kind === 'mana';
      for (let i = 0; i < 3; i++) {
        const f = this._rand(280, 480);
        this._tone('sine', t0 + i * 0.07 + this._rand(0, 0.015), f, f * 1.9, 0.05, 0.1, { attack: 0.004, release: 0.04 });
      }
      const chord = isMana ? [783.99, 987.77, 1174.66] : [523.25, 659.25, 783.99];
      chord.forEach((f, i) => {
        this._tone(isMana ? 'sine' : 'triangle', t0 + 0.24 + i * 0.05, f, undefined, 0.08, 0.05,
          { attack: 0.01, release: 0.3, detune: isMana ? 7 : 0, send: true });
      });
    } catch (e) { /* ignore */ }
  }

  // Fanfare arpeggio, a sparkle wash and a sustained chord bloom (music ducks under it).
  levelUp() {
    if (!this._gate('levelUp', 200, 1.2)) return;
    try {
      const t0 = this.ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
      notes.forEach((f, i) => {
        const t = t0 + i * 0.12;
        this._tone('triangle', t, f, undefined, 0.25, 0.2, { attack: 0.006, release: 0.25 });
        this._tone('square', t, f, undefined, 0.15, 0.05, { attack: 0.006, release: 0.15, lowpass: 3500 });
      });
      const tc = t0 + 0.48;
      for (const f of notes) this._tone('sine', tc, f, undefined, 0.3, 0.06, { attack: 0.02, hold: 0.15, release: 0.9, send: 0.35 });
      this._noise(t0 + 0.3, 0.5, 'highpass', 6000, 9000, 0.04, { attack: 0.2, release: 0.5, send: 0.3 });
    } catch (e) { /* ignore */ }
  }

  // Three descending footfalls, a stone rumble and a whoosh into the dark.
  stairs() {
    if (!this._gate('stairs', 200, 1.0)) return;
    try {
      const t0 = this.ctx.currentTime;
      for (let k = 0; k < 3; k++) {
        const t = t0 + k * 0.14;
        this._tone('sine', t, 120 - k * 15, (120 - k * 15) * 0.6, 0.06, 0.18, { attack: 0.003, release: 0.06 });
        this._noise(t, 0.04, 'lowpass', 800, 300, 0.08, { release: 0.04 });
      }
      this._noise(t0, 0.9, 'lowpass', 400, 120, 0.12, { attack: 0.2, release: 0.6, send: 0.3 });
      this._noise(t0 + 0.1, 0.4, 'bandpass', 1800, 300, 0.1, { q: 0.8, release: 0.3 });
      this._tone('sine', t0 + 0.05, 130, 70, 0.7, 0.22, { attack: 0.02, release: 0.65 });
    } catch (e) { /* ignore */ }
  }

  playerDeath() {
    if (!this._gate('playerDeath', 500, 1.6)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('sine', t0, 80, 30, 0.6, 0.4, { attack: 0.005, release: 0.6 });
      this._noise(t0, 0.5, 'lowpass', 900, 100, 0.2, { release: 0.4, send: 0.3 });
      const notes = [440, 415.3, 329.63, 261.63]; // A4, Ab4, E4, C4 — slow descending minor-ish
      notes.forEach((f, i) => {
        this._tone('triangle', t0 + 0.15 + i * 0.28, f, f * 0.9, 0.4, 0.18, { attack: 0.02, release: 0.4, send: 0.3 });
      });
    } catch (e) { /* ignore */ }
  }

  // Soft woody tick (also used to close panels).
  uiClick() {
    if (!this._gate('uiClick', 40, 0.06)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('triangle', t0, this._pitch(1200, 0.05), 700, 0.02, 0.05, { attack: 0.002, release: 0.03 });
      this._tone('sine', t0, this._pitch(440, 0.03), 330, 0.03, 0.035, { attack: 0.002, release: 0.04 });
    } catch (e) { /* ignore */ }
  }

  // Two-note lift plus a faint paper swish.
  uiOpen() {
    if (!this._gate('uiOpen', 40, 0.12)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('triangle', t0, this._pitch(660, 0.03), undefined, 0.04, 0.05, { attack: 0.003, release: 0.05 });
      this._tone('triangle', t0 + 0.045, this._pitch(880, 0.03), undefined, 0.05, 0.05, { attack: 0.003, release: 0.07 });
      this._noise(t0, 0.08, 'highpass', 3000, 5000, 0.02, { release: 0.05 });
    } catch (e) { /* ignore */ }
  }

  denied() {
    if (!this._gate('denied', 200, 0.2)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._tone('square', t0, 110, undefined, 0.07, 0.08, { attack: 0.004, release: 0.06, lowpass: 900 });
      this._tone('square', t0 + 0.09, 92, undefined, 0.08, 0.08, { attack: 0.004, release: 0.08, lowpass: 800, detune: 12 });
    } catch (e) { /* ignore */ }
  }

  // Barely-there footfall per tile moved (so it follows movement speed), alternating feet.
  footstep() {
    if (!this._gate('footstep', FOOTSTEP_THROTTLE_MS, 0.06)) return;
    try {
      const t0 = this.ctx.currentTime;
      this._foot = !this._foot;
      const f = this._pitch(this._foot ? 95 : 84, 0.06);
      this._tone('sine', t0, f, f * 0.6, 0.035, FOOTSTEP_PEAK, { attack: 0.002, release: 0.04 });
      this._noise(t0, 0.03, 'lowpass', this._pitch(1300, 0.2), 400, FOOTSTEP_PEAK * 0.6, { release: 0.03 });
    } catch (e) { /* ignore */ }
  }

  // Merchant in trade range: a warm little shop-bell "ding-dong" and a coin jingle.
  merchantGreet() {
    if (!this._gate('merchantGreet', 8000, 0.8)) return;
    try {
      const t0 = this.ctx.currentTime;
      [[987.77, 0], [783.99, 0.18]].forEach(([f, dt]) => {
        this._tone('sine', t0 + dt, f, undefined, 0.02, 0.07, { attack: 0.003, release: 0.6, send: 0.35 });
        this._tone('sine', t0 + dt, f * 2.4, undefined, 0.02, 0.018, { attack: 0.003, release: 0.25 });
      });
      for (let k = 0; k < 2; k++) {
        this._tone('sine', t0 + 0.36 + k * 0.05, this._pitch(2400, 0.12), undefined, 0.01, 0.035, { attack: 0.002, release: 0.08 });
      }
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
      case 'bowShot': sfx.bowShot(); break;
      case 'spark': sfx.spark(); break;
      case 'staffSweep': sfx.staffSweep(); break;
      case 'arcaneBolt': sfx.bolt(); break;
      case 'frostNova': sfx.nova(); break;
      case 'shadowDash': sfx.dash(); break;
      default: break;
    }
  });

  const duck = (kind) => { if (sfx.music) sfx.music.duckFor(kind); };

  bus.on('enemyKilled', ({ enemy }) => {
    if (sfx.music) sfx.music.notifyCombat();
    if (enemy && enemy.behavior === 'boss') {
      sfx.bossDeath();
      duck('bossDeath');
      if (sfx.music) sfx.music.victory();
    } else sfx.enemyDeath(!!(enemy && enemy.elite));
  });

  bus.on('playerDamaged', () => { if (sfx.music) sfx.music.notifyCombat(); sfx.playerHurt(); });
  bus.on('playerDodged', () => sfx.dodge());
  bus.on('bossSlam', () => sfx.bossSlam());
  bus.on('bossTelegraph', () => sfx.bossTelegraph());
  bus.on('bossIntro', () => { sfx.bossRoar(); duck('bossRoar'); });
  bus.on('bossPhase2', () => { sfx.bossRoar(); duck('bossRoar'); });

  bus.on('goldPickedUp', ({ amount } = {}) => sfx.gold(amount || 0));
  bus.on('itemPickedUp', ({ item }) => sfx.itemPickup(item && item.rarity));
  bus.on('itemBought', () => sfx.purchase());
  bus.on('itemSold', () => sfx.purchase());
  bus.on('potionUsed', ({ kind }) => sfx.potion(kind));
  bus.on('levelUp', () => { sfx.levelUp(); duck('levelUp'); });
  bus.on('playerDied', () => { sfx.playerDeath(); duck('playerDeath'); });
  bus.on('denied', () => sfx.denied());
}
