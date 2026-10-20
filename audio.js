// Every sound is synthesized with Web Audio. An <audio> or <video> element would
// take over the iOS audio session and pause the user's music; Web Audio under an
// 'ambient' (or 'transient') session plays on top of it instead.

let ctx = null;
let out = null;
let volume = 1;

export const hasSessionApi = 'audioSession' in navigator;

// iOS reads the session type when audio starts, so set it before the first
// AudioContext exists. Changing it later drops the old context so the next
// sound starts a fresh one under the new type.
export function setSessionType(type) {
  if (hasSessionApi) {
    try { navigator.audioSession.type = type; } catch {}
  }
  if (ctx) {
    ctx.close().catch(() => {});
    ctx = null;
  }
}

function context() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC({ latencyHint: 'interactive' });
  out = master(ctx);
  out.gain.value = volume;
  return ctx;
}

export function setVolume(v) {
  volume = v;
  if (out) out.gain.value = v;
}

// Heavy compression so bells cut through gym noise and music, then a tanh soft
// clipper: the compressor's attack lets hammer transients overshoot, and this
// rounds them off instead of hard-clipping.
export function master(c) {
  const input = c.createGain();
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.knee.value = 6;
  comp.ratio.value = 12;
  comp.attack.value = 0.002;
  comp.release.value = 0.2;
  // Makeup of 2.4 split between this gain and the shaper's ~2x small-signal slope.
  const makeup = c.createGain();
  makeup.gain.value = 1.2;
  const clip = c.createWaveShaper();
  const curve = new Float32Array(2049);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(2 * x) / Math.tanh(2);
  }
  clip.curve = curve;
  clip.oversample = '2x';
  input.connect(comp).connect(makeup).connect(clip).connect(c.destination);
  return input;
}

// Call from a click/touchend handler: iOS only starts audio inside a user gesture.
export function unlock() {
  const c = context();
  if (c.state !== 'running') c.resume().catch(() => {});
  // A one-sample silent buffer played inside the gesture completes the unlock on older iOS.
  const src = c.createBufferSource();
  src.buffer = c.createBuffer(1, 1, c.sampleRate);
  src.connect(c.destination);
  src.start();
}

// iOS suspends or "interrupts" the context in the background; nudge it back.
export function wake() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}

export const ready = () => ctx !== null && ctx.state === 'running';

export function play(name, delay = 0) {
  const sound = SOUNDS[name];
  if (!sound) return;
  const c = context();
  const dest = out;
  if (c.state === 'running') return sound(c, dest, c.currentTime + delay);
  // Suspended: only play if the context comes back promptly, so a backlog of
  // stale bells doesn't fire all at once later.
  const asked = performance.now();
  c.resume().then(() => {
    const late = (performance.now() - asked) / 1000;
    if (late < 0.5) sound(c, dest, c.currentTime + Math.max(0, delay - late));
  }).catch(() => {});
}

// Risset's bell: [frequency ratio, amplitude, decay as a fraction of length, detune Hz].
const PARTIALS = [
  [0.56, 1, 1, 0], [0.56, 0.67, 0.9, 1], [0.92, 1, 0.65, 0], [0.92, 1.8, 0.55, 1.7],
  [1.19, 2.67, 0.325, 0], [1.7, 1.67, 0.35, 0], [2, 1.46, 0.25, 0], [2.74, 1.33, 0.2, 0],
  [3, 1.33, 0.15, 0], [3.76, 1, 0.1, 0], [4.07, 1.33, 0.075, 0],
];

function strike(c, dest, t, length, base = 1100) {
  const bus = c.createGain();
  bus.gain.value = 0.06;
  bus.connect(dest);
  for (const [ratio, amp, decay, detune] of PARTIALS) {
    const end = t + length * decay;
    const osc = c.createOscillator();
    osc.frequency.value = base * ratio + detune;
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(amp, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env).connect(bus);
    osc.start(t);
    osc.stop(end + 0.05);
  }
  // The hammer hit: a short burst of bright noise on top of the tone.
  burst(c, dest, t, 5000, 0.7, 0.35, 0.025);
}

const noiseCache = new WeakMap();

function noise(c) {
  let buf = noiseCache.get(c);
  if (!buf) {
    buf = c.createBuffer(1, Math.floor(c.sampleRate / 2), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseCache.set(c, buf);
  }
  return buf;
}

function burst(c, dest, t, freq, q, gain, decay) {
  const src = c.createBufferSource();
  src.buffer = noise(c);
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const env = c.createGain();
  env.gain.setValueAtTime(gain, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(filter).connect(env).connect(dest);
  src.start(t, Math.random() * 0.3);
  src.stop(t + decay + 0.02);
}

function tone(c, dest, t, type, freq, gain, length, release = 0.03) {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + 0.003);
  env.gain.setValueAtTime(gain, t + Math.max(0.004, length - release));
  env.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(env).connect(dest);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

// Wooden clapper: a resonant noise click plus a short pitched knock.
function clack(c, dest, t) {
  burst(c, dest, t, 2200, 5, 1.5, 0.06);
  tone(c, dest, t, 'sine', 1500, 0.35, 0.045, 0.04);
}

function beep(c, dest, t, freq) {
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 4000;
  filter.connect(dest);
  tone(c, filter, t, 'square', freq, 0.1, 0.16);
}

function buzzer(c, dest, t) {
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2200;
  filter.connect(dest);
  tone(c, filter, t, 'sawtooth', 160, 0.16, 0.8, 0.08);
  tone(c, filter, t, 'sawtooth', 163, 0.16, 0.8, 0.08);
}

function bells(c, d, t, count) {
  for (let i = 0; i < count; i++) strike(c, d, t + i * 0.3, i === count - 1 ? 2.4 : 1.4);
}

// Each takes (context, destination node, start time in context seconds).
export const SOUNDS = {
  bell1: (c, d, t) => strike(c, d, t, 2.6),
  bell2: (c, d, t) => bells(c, d, t, 2),
  bell3: (c, d, t) => bells(c, d, t, 3),
  bell5: (c, d, t) => bells(c, d, t, 5),
  clapper: (c, d, t) => { for (let i = 0; i < 3; i++) clack(c, d, t + i * 0.16); },
  beep: (c, d, t) => beep(c, d, t, 1000),
  beepHigh: (c, d, t) => beep(c, d, t, 1600),
  buzzer: (c, d, t) => buzzer(c, d, t),
};

export const SOUND_NAMES = {
  none: 'None',
  bell1: 'Bell',
  bell2: 'Bell ×2',
  bell3: 'Bell ×3',
  bell5: 'Bell ×5',
  clapper: 'Clapper',
  beep: 'Beep',
  beepHigh: 'High beep',
  buzzer: 'Buzzer',
};
