// Procedural adaptive music (Web Audio only — no files, no libraries). Owned by audio.js: the
// Sfx singleton creates one Music once its AudioContext exists (`sfx.music`). main.js feeds it
// the game state every frame through `sfx.musicObserve(game, mode, modalOpen)` (cheap: it only
// compares numbers, throttled to OBSERVE_MS). All sound is scheduled ahead on the AudioContext
// clock by a setTimeout lookahead scheduler, so frame rate / hit-stop / background tabs never
// affect timing. See DESIGN.md §17.2 for the design.
//
// Layers (each a GainNode, crossfaded): ambient (pads + bass + bell motif), combat (soft drums +
// pulse bass), merchant (music-box arpeggio), boss (own drums/ostinato/pads), drone (death screen).
// Music states: title · explore · boss · death. Combat/merchant are intensity layers on explore.

import { mulberry32, clamp } from './core.js';

// ---------------------------------------------------------------------------------------------
// Tunables — everything a listener might want to tweak lives here.
// ---------------------------------------------------------------------------------------------
const MUSIC_VOLUME = 0.42;        // music bus level (SFX bus is 0.8) — keeps music well under SFX
const MUSIC_REVERB_SEND = 0.55;   // how much of the music goes to the shared reverb
const MUSIC_KEY = 'dotm.music';   // localStorage: '0' = music off (pause-screen toggle)

// Scheduler
const TICK_MS = 40;               // scheduler wake-up interval
const LOOKAHEAD = 0.3;            // seconds scheduled ahead while visible
const HIDDEN_LOOKAHEAD = 1.6;     // hidden tabs clamp timers to ~1s, so look further ahead
const MAX_STEPS_PER_TICK = 48;    // hard cap so a stalled timer can never burst-schedule
const OBSERVE_MS = 150;           // how often game state is re-evaluated

// Layer levels and fades (seconds)
const LEVEL = { ambient: 1, combat: 0.85, merchant: 0.7, boss: 1, drone: 0.9 };
const STATE_FADE = 2.2;           // title <-> explore <-> boss crossfades
const COMBAT_FADE_IN = 1.2;
const COMBAT_FADE_OUT = 3.0;
const COMBAT_HOLD = 4.0;          // combat layer stays this long after the last combat signal
const COMBAT_RANGE = 11;          // tiles: aggro'd enemies closer than this count as combat
const MERCHANT_MUSIC_RANGE = 6;   // tiles: merchant layer fades in inside this radius
const MERCHANT_FADE = 2.5;
const DEATH_FADE = 1.4;
const DRONE_FADE_IN = 6;          // death drone swells in under the sting
const AMBIENT_UNDER_COMBAT = 0.8; // ambient dips slightly while the combat layer plays

// Pause / open panel: low-pass + dip
const PAUSE_CUTOFF = 650;
const PAUSE_GAIN = 0.6;
const PAUSE_TAU = 0.12;

// Ducking under big SFX moments: [gain, hold seconds]
const DUCK = {
  bossRoar: [0.35, 1.1],
  levelUp: [0.45, 1.3],
  playerDeath: [0.3, 1.2],
  bossDeath: [0.35, 1.4],
};
const DUCK_ATTACK_TAU = 0.03;
const DUCK_RELEASE_TAU = 0.45;

// Depth variation: brightness/tempo/key move toward dark as depth grows.
const DARK_FULL_DEPTH = 22;       // depth at which the "darkness" curve bottoms out (matches §17.4b)
const ROOT_TOP = 50;              // MIDI root at depth 1 (D3)
const ROOT_DROP = 7;              // semitones lower by DARK_FULL_DEPTH
const BPM_TOP = 68;
const BPM_DROP = 12;
const CUTOFF_TOP = 2300;          // pad low-pass at depth 1
const CUTOFF_BOTTOM = 850;        // pad low-pass at DARK_FULL_DEPTH

// Boss track
const BOSS_BPM = 96;
const BOSS_BPM_P2 = 110;

// Voice levels (per-voice peaks, inside their layer)
const PAD_PEAK = 0.05;            // per oscillator
const BASS_PEAK = 0.13;
const BELL_PEAK = 0.085;
const BELL_ECHO_SEND = 0.32;
const BELL_ECHO_FEEDBACK = 0.34;
const MUSICBOX_PEAK = 0.05;
const KICK_PEAK = 0.34;
const PULSE_PEAK = 0.07;

const MODES = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};
// Chord-degree preference (scale degree index -> weight). Diminished triads are filtered out.
const DEGREE_WEIGHTS = [4, 1, 2, 3, 2, 3, 2];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function loadEnabled() {
  try { return typeof localStorage === 'undefined' || localStorage.getItem(MUSIC_KEY) !== '0'; } catch (e) { return true; }
}
function saveEnabled(v) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(MUSIC_KEY, v ? '1' : '0'); } catch (e) { /* ignore */ }
}

// Semitones above the tonic for scale-degree index d (can go past one octave / below zero).
function sc(scale, d) {
  const n = scale.length;
  return scale[((d % n) + n) % n] + 12 * Math.floor(d / n);
}

function makeMotif(rng) {
  const n = 3 + Math.floor(rng() * 4);
  const notes = [];
  let at = 0;
  let deg = pick(rng, [0, 2, 4, 4, 7]);
  for (let i = 0; i < n && at < 28; i++) {
    notes.push({ at, deg, len: pick(rng, [3, 4, 6, 8]) });
    at += pick(rng, [2, 3, 4, 4, 6]);
    deg = clamp(deg + pick(rng, [-2, -1, -1, 1, 1, 2, 3, -3]), -2, 9);
  }
  return notes;
}

// Seeded per depth: same depth number always gets the same key/character.
function depthParams(depth) {
  const rng = mulberry32(0x9E3779B1 ^ Math.imul(depth + 7, 2654435761));
  const dark = clamp((depth - 1) / DARK_FULL_DEPTH, 0, 1);
  let mode;
  if (depth <= 3) mode = 'dorian';
  else if (depth <= 8) mode = rng() < 0.25 ? 'dorian' : 'aeolian';
  else if (depth <= 15) mode = rng() < 0.5 ? 'aeolian' : 'phrygian';
  else mode = 'phrygian';
  const root = clamp(Math.round(ROOT_TOP - dark * ROOT_DROP) + pick(rng, [-2, -1, -1, 0, 0, 1]), 41, 52);
  return {
    name: `depth${depth}`,
    seed: Math.floor(rng() * 1e9),
    dark,
    mode,
    scale: MODES[mode],
    root,
    bpm: Math.round(BPM_TOP - dark * BPM_DROP + pick(rng, [-3, -1, 0, 1, 3])),
    cutoff: CUTOFF_TOP - dark * (CUTOFF_TOP - CUTOFF_BOTTOM),
    padWave: dark < 0.35 ? 'triangle' : 'sawtooth',
    density: 0.62 - dark * 0.28,              // chance a phrase slot plays melody
    bellBright: 0.32 - dark * 0.18,           // 2nd-partial level of the bell
    chordBars: dark > 0.5 ? pick(rng, [2, 3, 3]) : pick(rng, [2, 2, 3]),
    motifs: [makeMotif(rng), makeMotif(rng), makeMotif(rng)],
    weights: DEGREE_WEIGHTS.map((w) => w * (0.6 + rng() * 0.8)),
  };
}

const TITLE_PARAMS = (() => {
  const p = depthParams(1);
  const rng = mulberry32(424242);
  return {
    ...p, name: 'title', mode: 'dorian', scale: MODES.dorian, root: 50, bpm: 60, cutoff: 2700,
    padWave: 'triangle', density: 0.55, bellBright: 0.36, chordBars: 3,
    motifs: [makeMotif(rng), makeMotif(rng), makeMotif(rng)], seed: 4242,
  };
})();

// ---------------------------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------------------------
export class Music {
  // ctx: AudioContext · dest: node the music bus feeds (the limiter) · reverbIn: shared reverb
  // input · host: the Sfx singleton (for mute state and the cached noise buffer).
  constructor(ctx, dest, reverbIn, host) {
    this.ctx = ctx;
    this.host = host;
    this.enabled = loadEnabled();
    this.nodes = 0;              // live scheduled nodes (leak check: must stay bounded)
    this.stats = { steps: 0, resyncs: 0, maxLateMs: 0, capped: 0 };
    this.state = 'off';
    this.p = TITLE_PARAMS;
    this.rng = mulberry32(TITLE_PARAMS.seed);
    this.depth = 0;
    this.bossPhase = 1;
    this.modal = false;
    this._bpm = this.p.bpm;
    this._targetBpm = this.p.bpm;
    this._stepIdx = 0;
    this._nextTime = 0;
    this._needResync = true;
    this._queue = [];            // [{step, fn}] melody notes waiting for their step
    this._chordStart = -1e9;
    this._chordCount = 0;
    this._degree = 0;
    this._chord = [0, 3, 7];     // current chord, semitones above p.root
    this._forceChord = true;
    this._phraseStart = -1e9;
    this._lastCombat = -1e9;
    this._lastObserve = 0;
    this._combatPat = null;
    this._droneNext = 0;

    // Graph: layers -> mix -> pauseLP -> duck -> pause -> bus -> dest (+ reverb send)
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.bus = g(this.enabled ? MUSIC_VOLUME : 0);
    this.pauseGain = g(1);
    this.duck = g(1);
    this.pauseLP = ctx.createBiquadFilter();
    this.pauseLP.type = 'lowpass';
    this.pauseLP.frequency.value = 20000;
    this.pauseLP.Q.value = 0.5;
    this.mix = g(1);
    this.mix.connect(this.pauseLP);
    this.pauseLP.connect(this.duck);
    this.duck.connect(this.pauseGain);
    this.stingBus = g(1);
    this.stingBus.connect(this.pauseGain); // stings are not ducked (they play on the big moments)
    this.pauseGain.connect(this.bus);
    this.bus.connect(dest);
    if (reverbIn) {
      this.revSend = g(MUSIC_REVERB_SEND);
      this.bus.connect(this.revSend);
      this.revSend.connect(reverbIn);
    }
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 2048;
    this.bus.connect(this.meter);

    this.layers = {};
    for (const name of Object.keys(LEVEL)) {
      const node = g(0);
      node.connect(this.mix);
      this.layers[name] = { node, target: 0, offAt: 0, fresh: false };
    }
    // Bell echo: bellBus -> ambient (dry) and -> delay loop -> ambient.
    this.bellBus = g(1);
    this.bellBus.connect(this.layers.ambient.node);
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.6;
    this.delayFb = g(BELL_ECHO_FEEDBACK);
    this.delayLP = ctx.createBiquadFilter();
    this.delayLP.type = 'lowpass';
    this.delayLP.frequency.value = 2200;
    this.echoSend = g(BELL_ECHO_SEND);
    this.bellBus.connect(this.echoSend);
    this.echoSend.connect(this.delay);
    this.delay.connect(this.delayLP);
    this.delayLP.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayLP.connect(this.layers.ambient.node);

    this._tickBound = () => this._tick();
    this._timer = setTimeout(this._tickBound, TICK_MS);
  }

  // ------------------------------------------------------------------ public API
  setEnabled(v) {
    this.enabled = !!v;
    saveEnabled(this.enabled);
    const t = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setTargetAtTime(this.enabled ? MUSIC_VOLUME : 0, t, 0.2);
    if (this.enabled) { this._forceChord = true; this._needResync = true; }
  }
  toggle() { this.setEnabled(!this.enabled); return this.enabled; }

  notifyCombat() { this._lastCombat = nowMs(); }

  duckFor(kind) {
    const d = DUCK[kind];
    if (!d) return;
    const t = this.ctx.currentTime;
    const gp = this.duck.gain;
    gp.cancelScheduledValues(t);
    gp.setTargetAtTime(d[0], t, DUCK_ATTACK_TAU);
    gp.setTargetAtTime(1, t + d[1], DUCK_RELEASE_TAU);
  }

  // Boss killed: bright resolving swell, then explore music comes back via observe().
  victory() {
    if (!this._canPlay()) return;
    const t = this.ctx.currentTime + 0.35;
    const r = this.p.root + 12;
    this._voice(t, {
      dest: this.stingBus, peak: 0.035, a: 0.5, hold: 1.4, r: 3.5,
      filter: { f0: 600, f1: 3200, f2: 900, t1: 0.9 },
      oscs: [0, 4, 7, 11, 14].flatMap((s) => [{ type: 'triangle', freq: mtof(r + s), detune: -5 }, { type: 'sine', freq: mtof(r + s), detune: 5 }]),
    });
    [0, 4, 7, 12, 16, 19].forEach((s, i) => this._bell(t + 0.25 + i * 0.14, r + 12 + s, 0.9, this.stingBus));
  }

  // Called every frame by main.js; re-evaluates at most every OBSERVE_MS.
  observe(game, mode, modalOpen) {
    const modal = mode === 'paused' || !!modalOpen;
    if (modal !== this.modal) this._setModal(modal);
    const now = nowMs();
    if (now - this._lastObserve < OBSERVE_MS) return;
    this._lastObserve = now;

    if (mode === 'title') { this._goState('title'); return; }
    if (mode === 'dead') { this._goState('death'); return; }
    if (!game || !game.player) return;
    if (mode === 'transition') return; // keep whatever is playing through the stairs fade

    const p = game.player;
    const px = p.fx ?? p.x, py = p.fy ?? p.y;
    let boss = null;
    let combat = false;
    for (const e of game.enemies || []) {
      if (e.dead || e._gallery) continue;
      if (e.behavior === 'boss') { if (e._noticed) boss = e; continue; }
      if ((e.state === 'chase' || e.state === 'attack' || e.state === 'flee') &&
          Math.abs(e.x - px) + Math.abs(e.y - py) <= COMBAT_RANGE * 1.4 &&
          Math.hypot(e.x - px, e.y - py) <= COMBAT_RANGE) combat = true;
    }
    if (combat) this._lastCombat = now;
    const combatOn = now - this._lastCombat < COMBAT_HOLD * 1000;
    let merchantOn = false;
    for (const n of game.npcs || []) {
      if (n.type === 'merchant' && Math.hypot(n.x - px, n.y - py) <= MERCHANT_MUSIC_RANGE) merchantOn = true;
    }

    if (game.depth !== this.depth) {
      this.depth = game.depth;
      if (this.state !== 'title') this._setParams(depthParams(this.depth));
    }
    if (boss) {
      this.bossPhase = boss._phase || 1;
      this._targetBpm = this.bossPhase >= 2 ? BOSS_BPM_P2 : BOSS_BPM;
      this._goState('boss');
    } else {
      this._goState('explore');
      this._layer('combat', combatOn ? LEVEL.combat : 0, combatOn ? COMBAT_FADE_IN : COMBAT_FADE_OUT);
      this._layer('merchant', merchantOn && !combatOn ? LEVEL.merchant : 0, MERCHANT_FADE);
      this._layer('ambient', LEVEL.ambient * (combatOn ? AMBIENT_UNDER_COMBAT : 1), combatOn ? COMBAT_FADE_IN : COMBAT_FADE_OUT);
    }
  }

  debugInfo() {
    const layers = {};
    for (const [k, L] of Object.entries(this.layers)) layers[k] = { target: +L.target.toFixed(2), value: +L.node.gain.value.toFixed(3) };
    let rms = 0, peak = 0;
    try {
      const buf = new Float32Array(this.meter.fftSize);
      this.meter.getFloatTimeDomainData(buf);
      for (const v of buf) { rms += v * v; peak = Math.max(peak, Math.abs(v)); }
      rms = Math.sqrt(rms / buf.length);
    } catch (e) { /* ignore */ }
    return {
      state: this.state, ctx: this.ctx.state, enabled: this.enabled, muted: !!this.host.muted,
      params: this.p.name, mode: this.p.mode, root: this.p.root, bpm: this._bpm, bossPhase: this.bossPhase,
      modal: this.modal, pauseCutoff: Math.round(this.pauseLP.frequency.value), layers, duck: +this.duck.gain.value.toFixed(3),
      nodes: this.nodes, queue: this._queue.length, step: this._stepIdx,
      aheadSec: +(this._nextTime - this.ctx.currentTime).toFixed(3),
      stats: { ...this.stats }, rms: +rms.toFixed(4), peak: +peak.toFixed(4),
    };
  }

  // ------------------------------------------------------------------ state machine
  _goState(s) {
    if (s === this.state) return;
    const prev = this.state;
    this.state = s;
    if (s === 'title') {
      this._setParams(TITLE_PARAMS);
      this._targetBpm = TITLE_PARAMS.bpm;
      this._layers({ ambient: LEVEL.ambient }, prev === 'off' ? 1.5 : STATE_FADE);
    } else if (s === 'explore') {
      if (prev === 'title' || prev === 'death' || prev === 'off' || this.p === TITLE_PARAMS) this._setParams(depthParams(this.depth || 1));
      this._targetBpm = this.p.bpm;
      this._layers({ ambient: LEVEL.ambient }, STATE_FADE);
    } else if (s === 'boss') {
      this._layers({ boss: LEVEL.boss }, prev === 'explore' ? 1.2 : STATE_FADE);
    } else if (s === 'death') {
      this._layers({}, DEATH_FADE);
      this._deathSting();
      this._layer('drone', LEVEL.drone, DRONE_FADE_IN);
      this._droneNext = this._stepIdx + 4;
    }
  }

  _setParams(p) {
    if (this.p === p) return;
    this.p = p;
    this.rng = mulberry32(p.seed ^ (this._chordCount * 7919));
    this._forceChord = true;
    if (this.state !== 'boss') this._targetBpm = p.bpm;
  }

  // Sets every layer: listed ones to their level, the rest to 0.
  _layers(levels, fade) {
    for (const k of Object.keys(this.layers)) this._layer(k, levels[k] || 0, fade);
  }

  _layer(name, target, fade) {
    const L = this.layers[name];
    if (Math.abs(L.target - target) < 1e-3) return;
    const t = this.ctx.currentTime;
    const gp = L.node.gain;
    const wasOn = L.target > 0 || t < L.offAt;
    gp.cancelScheduledValues(t);
    gp.setValueAtTime(gp.value, t);
    gp.linearRampToValueAtTime(target, t + fade);
    L.target = target;
    L.offAt = target > 0 ? Infinity : t + fade + 4; // keep scheduling tails until faded out
    if (target > 0 && !wasOn) L.fresh = true;
  }

  _on(name) {
    const L = this.layers[name];
    return L.target > 0 || this.ctx.currentTime < L.offAt;
  }

  _setModal(modal) {
    this.modal = modal;
    const t = this.ctx.currentTime;
    this.pauseLP.frequency.cancelScheduledValues(t);
    this.pauseLP.frequency.setTargetAtTime(modal ? PAUSE_CUTOFF : 20000, t, PAUSE_TAU * (modal ? 1 : 2));
    this.pauseGain.gain.cancelScheduledValues(t);
    this.pauseGain.gain.setTargetAtTime(modal ? PAUSE_GAIN : 1, t, PAUSE_TAU * 2);
  }

  _canPlay() {
    return this.ctx.state === 'running' && this.enabled && !this.host.muted && !!this.host.noiseBuffer;
  }

  // ------------------------------------------------------------------ scheduler
  _stepDur() { return 60 / this._bpm / 4; }

  _tick() {
    this._timer = setTimeout(this._tickBound, TICK_MS);
    try {
      if (!this._canPlay()) { this._needResync = true; return; }
      const now = this.ctx.currentTime;
      const hidden = typeof document !== 'undefined' && document.hidden;
      const ahead = hidden ? HIDDEN_LOOKAHEAD : LOOKAHEAD;
      if (this._needResync) {
        this._needResync = false;
        this._nextTime = now + 0.06;
        this._forceChord = true;
      } else if (this._nextTime < now + 0.005) {
        // Timer ran late (background tab, long GC): skip the missed steps — never pile them up —
        // but keep the step grid so bar/chord positions stay aligned.
        const sd = this._stepDur();
        const missed = Math.ceil((now + 0.02 - this._nextTime) / sd);
        this.stats.resyncs++;
        this.stats.maxLateMs = Math.max(this.stats.maxLateMs, Math.round((now - this._nextTime) * 1000));
        this._stepIdx += missed;
        this._nextTime += missed * sd;
        this._queue = this._queue.filter((q) => q.step >= this._stepIdx);
      }
      let n = 0;
      while (this._nextTime < now + ahead) {
        if (n++ >= MAX_STEPS_PER_TICK) { this.stats.capped++; break; }
        this._step(this._stepIdx, this._nextTime);
        this._stepIdx++;
        this.stats.steps++;
        this._nextTime += this._stepDur();
      }
    } catch (e) {
      // Never let a scheduling bug kill the loop (or the game).
      if (!this._errLogged) { this._errLogged = true; console.warn('[music]', e); }
    }
  }

  _step(i, t) {
    if (i % 16 === 0 && this._bpm !== this._targetBpm) {
      this._bpm = this._targetBpm;
      this.delay.delayTime.setTargetAtTime(Math.min(1.5, 3 * this._stepDur()), t, 0.2);
    }
    if (this._on('ambient')) this._ambientStep(i, t);
    if (this._on('combat')) this._combatStep(i, t);
    if (this._on('merchant')) this._merchantStep(i, t);
    if (this._on('boss')) this._bossStep(i, t);
    if (this._on('drone')) this._droneStep(i, t);
    if (this._queue.length) {
      const due = [];
      this._queue = this._queue.filter((q) => (q.step <= i ? (due.push(q), false) : true));
      for (const q of due) q.fn(t);
    }
    for (const L of Object.values(this.layers)) L.fresh = false;
  }

  // ------------------------------------------------------------------ ambient (pads, bass, bells)
  _nextDegree() {
    const p = this.p, rng = this.rng;
    this._chordCount++;
    // Return home every few chords so the harmony keeps a centre.
    if (this._chordCount % (4 + Math.floor(rng() * 3)) === 0 && this._degree !== 0) return 0;
    const opts = [];
    for (let d = 0; d < 7; d++) {
      if (d === this._degree) continue;
      if (sc(p.scale, d + 4) - sc(p.scale, d) !== 7) continue; // skip diminished triads
      opts.push(d);
    }
    let total = 0;
    for (const d of opts) total += p.weights[d];
    let r = rng() * total;
    for (const d of opts) { r -= p.weights[d]; if (r <= 0) return d; }
    return 0;
  }

  _ambientStep(i, t) {
    const p = this.p, rng = this.rng, L = this.layers.ambient;
    const sd = this._stepDur();
    const chordSteps = p.chordBars * 16;
    if ((L.fresh || this._forceChord) && i % 4 === 0 || i - this._chordStart >= chordSteps) {
      const restart = L.fresh || this._forceChord || this._chordCount === 0; // new key/state: start on the tonic
      this._forceChord = false;
      this._chordStart = i;
      const d = restart ? 0 : this._nextDegree();
      if (restart) this._chordCount++;
      this._degree = d;
      const s = p.scale;
      const shift = sc(s, d) > 7 ? -12 : 0; // keep chord roots within ~a sixth of the tonic
      const root = sc(s, d) + shift, third = sc(s, d + 2) + shift, fifth = sc(s, d + 4) + shift;
      const add = rng() < 0.4 ? sc(s, d + 8) + shift : fifth + 12; // add9 or octave fifth
      this._chord = [root, third, fifth];
      const notes = [root, fifth, third + 12, add].map((x) => p.root + x);
      const dur = chordSteps * sd;
      const merchant = this.layers.merchant.target > 0;
      const cutoff = p.cutoff * (merchant ? 1.3 : 1) * (0.85 + rng() * 0.3);
      const a = Math.min(2.5, dur * 0.3);
      this._voice(t, {
        dest: L.node, peak: PAD_PEAK, a, hold: dur - a, r: 3.2,
        filter: { f0: cutoff * 0.45, f1: cutoff, f2: cutoff * 0.5, t1: a + dur * 0.35, q: 0.9 },
        oscs: notes.flatMap((m, k) => [
          { type: p.padWave, freq: mtof(m), detune: -7 + k * 2 },
          { type: 'sine', freq: mtof(m), detune: 6 - k * 2, gain: 0.8 },
        ]),
      });
      const bassM = p.root - 12 + root;
      this._voice(t, {
        dest: L.node, peak: BASS_PEAK * (0.85 + p.dark * 0.3), a: 1.2, hold: dur - 1.2, r: 2.5,
        filter: { f0: 300, q: 0.5 },
        oscs: [{ type: 'sine', freq: mtof(bassM) }, { type: 'triangle', freq: mtof(bassM + 12), gain: 0.18 }],
      });
    }

    // Melody: every 2 bars choose motif / variation / wander / rest.
    if (i % 16 === 0 && i - this._phraseStart >= 32) {
      this._phraseStart = i;
      const r = rng();
      const dens = p.density * (this.layers.combat.target > 0 ? 0.6 : 1);
      if (r < dens) this._queuePhrase(i, r < dens * 0.45 ? 'motif' : r < dens * 0.8 ? 'vary' : 'wander');
    }
  }

  _queuePhrase(i, kind) {
    const p = this.p, rng = this.rng;
    const base = p.root + 12;
    let notes;
    if (kind === 'wander') {
      const tones = [0, 2, 4, 7].map((x) => x + this._degree);
      notes = [];
      let at = pick(rng, [0, 2, 4]);
      const n = 2 + Math.floor(rng() * 3);
      for (let k = 0; k < n && at < 30; k++) { notes.push({ at, deg: pick(rng, tones), len: 6 }); at += pick(rng, [4, 6, 8]); }
    } else {
      const m = pick(rng, p.motifs);
      const shift = rng() < 0.45 ? this._degree : 0;
      notes = m.map((x) => ({ ...x, deg: x.deg + shift }));
      if (kind === 'vary') {
        const v = rng();
        if (v < 0.3) notes = notes.map((x) => ({ ...x, deg: 2 * notes[0].deg - x.deg })); // inversion
        else if (v < 0.6) notes = notes.filter((_, k) => k === 0 || rng() > 0.3);           // drop notes
        else notes = notes.map((x) => ({ ...x, at: x.at + 2 }));                            // shift rhythm
        if (rng() < 0.4) notes[notes.length - 1].deg = this._degree + pick(rng, [0, 2, 4]); // resolve to chord
      }
    }
    for (const n of notes) {
      let midi = base + sc(p.scale, n.deg);
      while (midi > base + 19) midi -= 12;
      const vel = 0.65 + rng() * 0.35;
      this._queue.push({ step: i + n.at, fn: (t) => this._bell(t, midi, vel) });
    }
  }

  _bell(t, midi, vel, dest) {
    const p = this.p;
    const f = mtof(midi);
    const r = 2.2 + (1 - p.dark) * 0.8;
    this._voice(t, {
      dest: dest || this.bellBus, peak: BELL_PEAK * vel, a: 0.006, r,
      oscs: [
        { type: 'sine', freq: f },
        { type: 'sine', freq: f * 2.0, detune: 4, gain: p.bellBright },
        { type: 'triangle', freq: f * 3.01, gain: p.bellBright * 0.25 },
      ],
    });
  }

  // ------------------------------------------------------------------ combat layer
  _combatStep(i, t) {
    const s = i % 16;
    if (s === 0 || !this._combatPat) {
      this._combatPat = pick(this.rng, [
        { kick: [0, 10], tom: [12], shake: 2 },
        { kick: [0, 8], tom: [14], shake: 2 },
        { kick: [0, 6, 10], tom: [], shake: 2 },
        { kick: [0, 10], tom: [4, 12], shake: 4 },
      ]);
    }
    const pat = this._combatPat;
    const L = this.layers.combat.node;
    if (pat.kick.includes(s)) this._kick(t, L, s === 0 ? 1 : 0.7);
    if (pat.tom.includes(s)) this._tom(t, L, 0.6, 130);
    if (s % pat.shake === pat.shake / 2 || (pat.shake === 2 && s % 2 === 1 && this.rng() < 0.15)) this._hat(t, L, s % 4 === 2 ? 0.5 : 0.3);
    if (s % 2 === 0) {
      const root = this.p.root - 12 + this._chord[0];
      const note = s === 12 && this.rng() < 0.5 ? root + 7 : root;
      this._pulse(t, L, note, s % 4 === 0 ? 1 : 0.6);
    }
  }

  _kick(t, dest, vel) {
    this._voice(t, {
      dest, peak: KICK_PEAK * vel, a: 0.003, r: 0.32,
      oscs: [{ type: 'sine', freq: 115, f1: 42, sweep: 0.12 }],
    });
  }

  _tom(t, dest, vel, f) {
    this._voice(t, {
      dest, peak: 0.2 * vel, a: 0.003, r: 0.35,
      oscs: [{ type: 'triangle', freq: f * (0.97 + Math.random() * 0.06), f1: f * 0.6, sweep: 0.25 }],
    });
    this._noiseHit(t, dest, { peak: 0.05 * vel, r: 0.12, type: 'bandpass', f: 900, q: 1 });
  }

  _hat(t, dest, vel) {
    this._noiseHit(t, dest, { peak: 0.045 * vel, r: 0.05, type: 'highpass', f: 6500 + Math.random() * 1500, q: 0.7 });
  }

  _pulse(t, dest, midi, vel) {
    const sd = this._stepDur();
    this._voice(t, {
      dest, peak: PULSE_PEAK * vel, a: 0.01, hold: sd * 0.8, r: sd * 1.4,
      filter: { f0: 900, f1: 260, t1: sd * 1.5, q: 3 },
      oscs: [{ type: 'sawtooth', freq: mtof(midi), detune: -5 }, { type: 'sawtooth', freq: mtof(midi), detune: 5 }],
    });
  }

  // ------------------------------------------------------------------ merchant layer
  _merchantStep(i, t) {
    const s = i % 32;
    if (s % 4 !== 0 || this.rng() < 0.2) return;
    const pattern = [0, 1, 2, 3, 2, 1, 3, 1];
    const tones = [this._chord[0], this._chord[1], this._chord[2], this._chord[0] + 12];
    const m = this.p.root + 24 + tones[pattern[(s / 4) % pattern.length]];
    const f = mtof(m);
    this._voice(t, {
      dest: this.layers.merchant.node, peak: MUSICBOX_PEAK * (0.7 + this.rng() * 0.3), a: 0.004, r: 1.1,
      oscs: [{ type: 'triangle', freq: f }, { type: 'sine', freq: f * 4.0, gain: 0.12 }],
    });
  }

  // ------------------------------------------------------------------ boss layer
  _bossStep(i, t) {
    const s = i % 32;
    const p2 = this.bossPhase >= 2;
    const L = this.layers.boss;
    const dest = L.node;
    const root = this.p.root - 12;
    const sd = this._stepDur();
    if (L.fresh) this._tom(t, dest, 1.2, 70); // arrival hit

    const kicks = p2 ? [0, 3, 6, 8, 11, 16, 19, 22, 24, 27, 30] : [0, 6, 8, 16, 22, 24];
    if (kicks.includes(s)) this._kick(t, dest, s % 8 === 0 ? 1 : 0.75);
    if ([12, 28].includes(s) || (p2 && [14, 30].includes(s))) this._tom(t, dest, 0.9, s % 16 === 12 ? 150 : 110);
    if (p2 ? s % 2 === 0 : s % 4 === 2) this._hat(t, dest, s % 4 === 2 ? 0.8 : 0.45);

    // Ostinato on 8ths (phrygian: the b2 is the menace).
    if (s % 2 === 0) {
      const seq = p2 ? [0, 0, 1, 0, 0, 3, 1, 0, 0, 0, 1, 0, 5, 3, 1, -2] : [0, 0, 12, 0, 1, 0, 0, -2, 0, 0, 12, 0, 3, 1, 0, -2];
      const m = root + seq[s / 2];
      this._voice(t, {
        dest, peak: 0.09, a: 0.005, hold: sd * 0.9, r: sd * 1.6,
        filter: { f0: p2 ? 1800 : 1300, f1: 280, t1: sd * 1.6, q: 5 },
        oscs: [{ type: 'sawtooth', freq: mtof(m), detune: -6 }, { type: 'square', freq: mtof(m), detune: 6, gain: 0.5 }],
      });
    }
    // Dark pad every 2 bars.
    if (s === 0) {
      const k = Math.floor(i / 32) % 4;
      const chords = p2 ? [[0, 3, 7], [1, 5, 8], [0, 3, 7], [-2, 1, 5]] : [[0, 3, 7], [0, 3, 7], [-4, 0, 3], [-2, 1, 5]];
      const dur = 32 * sd;
      this._voice(t, {
        dest, peak: 0.035, a: 0.8, hold: dur - 0.8, r: 1.5,
        filter: { f0: 500, f1: p2 ? 1600 : 1100, f2: 500, t1: dur * 0.5, q: 1 },
        oscs: chords[k].flatMap((x) => [{ type: 'sawtooth', freq: mtof(root + 12 + x), detune: -8 }, { type: 'sawtooth', freq: mtof(root + 12 + x), detune: 8 }]),
      });
      if (p2) {
        // Brass-ish stab on the downbeat in phase 2.
        this._voice(t, {
          dest, peak: 0.03, a: 0.01, hold: 0.12, r: 0.5,
          filter: { f0: 3000, f1: 600, t1: 0.4, q: 2 },
          oscs: [0, 3, 7].map((x) => ({ type: 'sawtooth', freq: mtof(root + 24 + chords[k][0] + x) })),
        });
      }
    }
  }

  // ------------------------------------------------------------------ death
  _deathSting() {
    if (!this._canPlay()) return;
    const t = this.ctx.currentTime + 0.05;
    const r = this.p.root - 12;
    this._voice(t, {
      dest: this.stingBus, peak: 0.035, a: 0.25, hold: 1.0, r: 3.5,
      filter: { f0: 1800, f1: 1400, f2: 180, t1: 0.3, q: 1.5 },
      oscs: [0, 1, 7, 13, 15].flatMap((x) => [{ type: 'sawtooth', freq: mtof(r + x), detune: -9 }, { type: 'triangle', freq: mtof(r + x), detune: 9 }]),
    });
    this._bell(t + 0.1, r + 12, 1, this.stingBus);
    this._bell(t + 1.9, r + 11, 0.8, this.stingBus);
  }

  _droneStep(i, t) {
    if (i < this._droneNext) return;
    const sd = this._stepDur();
    this._droneNext = i + 32;
    const dur = 32 * sd + 3;
    const r = this.p.root - 12;
    this._voice(t, {
      dest: this.layers.drone.node, peak: 0.07, a: 3.5, hold: dur - 3.5, r: 4.5,
      filter: { f0: 220, f1: 480, f2: 200, t1: dur * 0.5, q: 1 },
      oscs: [
        { type: 'sine', freq: mtof(r) }, { type: 'sine', freq: mtof(r), detune: 7 },
        { type: 'triangle', freq: mtof(r + 7), detune: -4, gain: 0.5 }, { type: 'sawtooth', freq: mtof(r - 12), gain: 0.3 },
      ],
    });
    if (this.rng() < 0.5) this._bell(t + sd * 8, r + 24 + pick(this.rng, [0, 3, 7]), 0.5, this.layers.drone.node);
  }

  // ------------------------------------------------------------------ voices
  // One scheduled note: N oscillators -> (optional filter) -> envelope -> dest. All nodes are
  // disconnected when the last oscillator ends, and `this.nodes` tracks what is still alive.
  _voice(t, o) {
    const ctx = this.ctx;
    const a = Math.max(0.003, o.a ?? 0.01), hold = Math.max(0, o.hold ?? 0), r = Math.max(0.02, o.r ?? 0.3);
    const end = t + a + hold + r;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(o.peak, t + a);
    if (hold > 0) env.gain.setValueAtTime(o.peak, t + a + hold);
    env.gain.setTargetAtTime(0, t + a + hold, r / 5);
    env.connect(o.dest);
    let head = env, filt = null;
    if (o.filter) {
      filt = ctx.createBiquadFilter();
      filt.type = o.filter.type || 'lowpass';
      filt.Q.value = o.filter.q ?? 0.7;
      const f = filt.frequency;
      f.setValueAtTime(o.filter.f0, t);
      if (o.filter.f1) f.linearRampToValueAtTime(o.filter.f1, t + (o.filter.t1 ?? a));
      if (o.filter.f2) f.linearRampToValueAtTime(o.filter.f2, end);
      filt.connect(env);
      head = filt;
    }
    let count = 1 + (filt ? 1 : 0);
    const parts = [];
    for (const v of o.oscs) {
      const osc = ctx.createOscillator();
      osc.type = v.type;
      osc.frequency.setValueAtTime(v.freq, t);
      if (v.f1) osc.frequency.exponentialRampToValueAtTime(v.f1, t + (v.sweep ?? 0.1));
      if (v.detune) osc.detune.value = v.detune;
      let g = null;
      if (v.gain !== undefined && v.gain !== 1) {
        g = ctx.createGain();
        g.gain.value = v.gain;
        osc.connect(g);
        g.connect(head);
      } else osc.connect(head);
      osc.start(t);
      osc.stop(end + 0.05);
      parts.push([osc, g]);
      count += g ? 2 : 1;
    }
    this.nodes += count;
    let left = parts.length;
    for (const [osc, g] of parts) {
      osc.onended = () => {
        try { osc.disconnect(); if (g) g.disconnect(); } catch (e) { /* ignore */ }
        if (--left === 0) {
          try { env.disconnect(); if (filt) filt.disconnect(); } catch (e) { /* ignore */ }
          this.nodes -= count;
        }
      };
    }
  }

  _noiseHit(t, dest, o) {
    const buf = this.host.noiseBuffer;
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = o.type;
    filt.frequency.value = o.f;
    filt.Q.value = o.q ?? 0.7;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(o.peak, t + 0.002);
    env.gain.setTargetAtTime(0, t + 0.002, o.r / 5);
    src.connect(filt);
    filt.connect(env);
    env.connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + o.r + 0.05);
    this.nodes += 3;
    src.onended = () => {
      try { src.disconnect(); filt.disconnect(); env.disconnect(); } catch (e) { /* ignore */ }
      this.nodes -= 3;
    };
  }
}
