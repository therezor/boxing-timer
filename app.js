import * as Sound from './audio.js';

const VERSION = 'v1';

const KEY_SETTINGS = 'bt-settings';
const KEY_PRESETS = 'bt-presets';
const KEY_SESSION = 'bt-session';

const DEFAULTS = {
  rounds: 12,
  work: 180,
  rest: 60,
  prep: 10,
  warn: 10,
  countdown: 3,
  sounds: { start: 'bell1', end: 'bell3', final: 'bell5', warn: 'clapper', half: 'none', countdown: 'beep' },
  volume: 100,
  session: 'ambient',
  colors: { idle: '#111111', prep: '#1d4ed8', work: '#15803d', warn: '#c2410c', rest: '#b91c1c', done: '#374151' },
  awake: true,
  showTotal: true,
};

// What a preset stores.
const TIMING = ['rounds', 'work', 'rest', 'prep', 'warn'];

const BUILT_IN = [
  { name: 'Pro boxing', rounds: 12, work: 180, rest: 60, prep: 10, warn: 10 },
  { name: 'Amateur', rounds: 3, work: 180, rest: 60, prep: 10, warn: 10 },
  { name: 'MMA', rounds: 5, work: 300, rest: 60, prep: 10, warn: 10 },
  { name: 'Tabata', rounds: 8, work: 20, rest: 10, prep: 10, warn: 0 },
];

const STEPPERS = [
  { key: 'rounds', label: 'Rounds', min: 1, max: 99, kind: 'count' },
  { key: 'work', label: 'Round length', min: 5, max: 3600, kind: 'time' },
  { key: 'rest', label: 'Rest', min: 0, max: 900, kind: 'time', zero: 'None' },
  { key: 'prep', label: 'Get ready', min: 0, max: 120, kind: 'time', zero: 'Off' },
  { key: 'warn', label: 'Warning before round ends', min: 0, max: 120, kind: 'time', zero: 'Off' },
  { key: 'countdown', label: 'Countdown at end of rest', min: 0, max: 10, kind: 'sec', zero: 'Off' },
];

const SOUND_EVENTS = [
  ['start', 'Round start'],
  ['end', 'Round end'],
  ['final', 'Last round end'],
  ['warn', 'Warning'],
  ['half', 'Halfway'],
  ['countdown', 'Countdown'],
];

const COLOR_KEYS = [
  ['idle', 'Ready'], ['prep', 'Get ready'], ['work', 'Fight'],
  ['warn', 'Warning'], ['rest', 'Rest'], ['done', 'Done'],
];

const TOGGLES = [
  ['awake', 'Keep screen awake'],
  ['showTotal', 'Show total time left'],
];

const LABELS = { idle: 'Ready', prep: 'Get ready', work: 'Fight', warn: 'Fight', rest: 'Rest', done: 'Done' };
const PRIMARY = { idle: 'Start', running: 'Pause', paused: 'Resume', done: 'Again' };

const LOOKAHEAD = 150; // ms: sounds are scheduled this far ahead on the audio clock
const STALE = 1500;    // ms: events older than this were missed while iOS had the app asleep

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const fmt = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const pickTiming = s => Object.fromEntries(TIMING.map(k => [k, s[k]]));

function sanitize(raw) {
  const s = structuredClone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return s;
  for (const { key, min, max } of STEPPERS) {
    const n = Math.round(Number(raw[key]));
    if (Number.isFinite(n)) s[key] = clamp(n, min, max);
  }
  for (const [key] of SOUND_EVENTS) {
    const id = raw.sounds?.[key];
    if (typeof id === 'string' && Object.hasOwn(Sound.SOUND_NAMES, id)) s.sounds[key] = id;
  }
  for (const [key] of COLOR_KEYS) {
    const c = raw.colors?.[key];
    if (/^#[0-9a-f]{6}$/i.test(c)) s.colors[key] = c;
  }
  if (Number.isFinite(raw.volume)) s.volume = clamp(Math.round(raw.volume), 0, 100);
  if (raw.session === 'ambient' || raw.session === 'transient') s.session = raw.session;
  for (const [key] of TOGGLES) if (typeof raw[key] === 'boolean') s[key] = raw[key];
  return s;
}

function loadPresets() {
  const list = store.get(KEY_PRESETS);
  if (!Array.isArray(list)) return [];
  return list
    .filter(p => p && typeof p.name === 'string' && p.name.trim())
    .map(p => ({ name: p.name.trim().slice(0, 24), ...pickTiming(sanitize(p)) }));
}

// The whole session as phases plus the sounds that mark them, in ms from the start.
function buildTimeline(s) {
  const phases = [];
  let t = 0;
  const add = (kind, sec, round) => {
    if (sec <= 0) return;
    phases.push({ kind, round, start: t, dur: sec * 1000 });
    t += sec * 1000;
  };
  add('prep', s.prep, 1);
  for (let r = 1; r <= s.rounds; r++) {
    add('work', s.work, r);
    if (r < s.rounds) add('rest', s.rest, r + 1);
  }

  const events = [];
  phases.forEach((p, i) => {
    const end = p.start + p.dur;
    if (p.kind === 'work') {
      // With no rest, the previous round's end bell already marks this start.
      if (phases[i - 1]?.kind !== 'work') events.push({ at: p.start, type: 'start' });
      events.push({ at: p.start + p.dur / 2, type: 'half' });
      if (s.warn > 0 && s.warn * 1000 < p.dur) events.push({ at: end - s.warn * 1000, type: 'warn' });
      events.push({ at: end, type: p.round === s.rounds ? 'final' : 'end' });
    } else {
      const ticks = Math.min(s.countdown, Math.ceil(p.dur / 1000) - 1);
      for (let k = ticks; k >= 1; k--) events.push({ at: end - k * 1000, type: 'countdown' });
    }
  });
  events.sort((a, b) => a.at - b.at);
  return { phases, events, total: t };
}

let settings = sanitize(store.get(KEY_SETTINGS));
let presets = loadPresets();
let tl = buildTimeline(settings);

// Time is derived from the wall clock, never counted down, so it stays right
// after iOS freezes the page (screen lock, app switch).
let mode = 'idle'; // idle | running | paused | done
let base = 0;      // active ms before resumedAt
let resumedAt = 0; // Date.now() at the last start/resume
let nextEvent = 0;
let raf = 0;

const now = () => Date.now();
const elapsed = () => (mode === 'running' ? base + now() - resumedAt : base);
const phaseAt = e => tl.phases.find(p => e < p.start + p.dur);
const signature = () => [settings.rounds, settings.work, settings.rest, settings.prep].join();

function firstEventFrom(t) {
  const i = tl.events.findIndex(ev => ev.at >= t);
  return i < 0 ? tl.events.length : i;
}

function start() {
  mode = 'running';
  base = 0;
  resumedAt = now();
  nextEvent = 0;
  afterChange();
}

function pause() {
  base = elapsed();
  mode = 'paused';
  afterChange();
}

function resume() {
  resumedAt = now();
  mode = 'running';
  afterChange();
}

function reset() {
  mode = 'idle';
  base = 0;
  nextEvent = 0;
  afterChange();
}

function finish() {
  mode = 'done';
  base = tl.total;
  nextEvent = tl.events.length;
  afterChange();
}

// Jump to the end of the current phase; the sound at that boundary still plays.
function skip() {
  if (mode !== 'running' && mode !== 'paused') return;
  const p = phaseAt(elapsed());
  const target = p ? p.start + p.dur : tl.total;
  if (mode === 'paused' && target >= tl.total) return finish();
  base = target;
  resumedAt = now();
  nextEvent = firstEventFrom(target);
  afterChange();
}

function afterChange() {
  saveSession();
  keepAwake(mode === 'running' && settings.awake);
  $('reset-note').hidden = !(mode === 'running' || mode === 'paused');
  cancelAnimationFrame(raf);
  if (mode === 'running') {
    const frame = () => {
      tick();
      if (mode === 'running') raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
  render();
}

function tick() {
  const e = elapsed();
  fire(e);
  if (e >= tl.total) return finish();
  render();
}

function fire(e) {
  const events = tl.events;
  while (nextEvent < events.length && events[nextEvent].at <= e + LOOKAHEAD) {
    const ev = events[nextEvent++];
    if (ev.at < e - STALE) continue;
    const id = settings.sounds[ev.type];
    console.debug('[bt] sound', ev.type, id, Math.round(ev.at));
    Sound.play(id, Math.max(0, ev.at - e) / 1000);
  }
}

function saveSession() {
  if (mode === 'running' || mode === 'paused') {
    store.set(KEY_SESSION, { mode, base, resumedAt, sig: signature() });
  } else {
    store.del(KEY_SESSION);
  }
}

// If iOS evicted the app mid-session, pick up where the clock says we are.
function restoreSession() {
  const s = store.get(KEY_SESSION);
  if (!s || s.sig !== signature() || (s.mode !== 'running' && s.mode !== 'paused')) return;
  mode = s.mode;
  base = Number(s.base) || 0;
  resumedAt = Number(s.resumedAt) || now();
  if (elapsed() >= tl.total) {
    mode = 'idle';
    base = 0;
    store.del(KEY_SESSION);
    return;
  }
  nextEvent = firstEventFrom(elapsed());
}

let lock = null; // pending or granted wake lock promise

async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  if (on && !lock) {
    if (document.visibilityState !== 'visible') return;
    const p = lock = navigator.wakeLock.request('screen').catch(() => null);
    const sentinel = await p;
    if (!sentinel) {
      if (lock === p) lock = null;
      return;
    }
    sentinel.addEventListener('release', () => { if (lock === p) lock = null; });
    if (lock !== p) sentinel.release(); // switched off while the request was pending
  } else if (!on && lock) {
    const p = lock;
    lock = null;
    (await p)?.release();
  }
}

// ---- Rendering ----

const $ = id => document.getElementById(id);
const el = {
  round: $('round'), phase: $('phase'), time: $('time'), bar: $('bar-fill'),
  total: $('total'), primary: $('primary'), skip: $('skip'), reset: $('reset'),
  hint: $('sound-hint'), theme: document.querySelector('meta[name="theme-color"]'),
};
const shown = {};
let silentSince = 0;

function put(key, value, apply) {
  if (shown[key] === value) return;
  shown[key] = value;
  apply(value);
}

function view() {
  const s = settings;
  if (mode === 'idle') {
    return {
      kind: 'idle', label: LABELS.idle, remain: s.work * 1000, frac: 0,
      round: `${s.rounds} × ${fmt(s.work)}${s.rest ? ` · ${fmt(s.rest)} rest` : ''}`,
      total: `Total ${fmt(Math.ceil(tl.total / 1000))}`,
    };
  }
  const e = Math.min(elapsed(), tl.total);
  const p = mode === 'done' ? null : phaseAt(e);
  if (!p) {
    return { kind: 'done', label: LABELS.done, remain: 0, frac: 1, round: `${s.rounds} rounds done`, total: '' };
  }
  const remain = p.start + p.dur - e;
  const kind = p.kind === 'work' && s.warn > 0 && remain <= s.warn * 1000 ? 'warn' : p.kind;
  return {
    kind,
    label: mode === 'paused' ? 'Paused' : LABELS[kind],
    remain,
    frac: (e - p.start) / p.dur,
    round: p.kind === 'work' ? `Round ${p.round} / ${s.rounds}` : `Next: round ${p.round} / ${s.rounds}`,
    total: `${fmt(Math.ceil((tl.total - e) / 1000))} left`,
  };
}

// Picks black or white text, whichever reads better on the phase color.
function inkFor(hex) {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#111111' : '#ffffff';
}

function paint(kind) {
  const bg = settings.colors[kind];
  document.body.style.setProperty('--bg', bg);
  document.body.style.setProperty('--fg', inkFor(bg));
  document.body.dataset.kind = kind;
  el.theme.content = bg;
}

function render() {
  const v = view();
  put('kind', v.kind, paint);
  put('paused', mode === 'paused', p => document.body.classList.toggle('paused', p));
  put('label', v.label, t => { el.phase.textContent = t; });
  put('time', fmt(Math.ceil(v.remain / 1000)), t => { el.time.textContent = t; });
  put('round', v.round, t => { el.round.textContent = t; });
  put('total', settings.showTotal ? v.total : '', t => { el.total.textContent = t; });
  put('mode', mode, m => {
    el.primary.textContent = PRIMARY[m];
    el.skip.disabled = m === 'idle' || m === 'done';
    el.reset.disabled = m === 'idle';
  });
  el.bar.style.transform = `scaleX(${v.frac})`;

  // Restored after an eviction, or the context never unlocked: audio needs a tap.
  const silent = mode === 'running' && !Sound.ready();
  silentSince = silent ? silentSince || now() : 0;
  put('hint', silent && now() - silentSince > 800, show => { el.hint.hidden = !show; });
}

// ---- Settings ----

function updateSettings(patch) {
  const before = signature();
  settings = sanitize({ ...settings, ...patch });
  store.set(KEY_SETTINGS, settings);
  tl = buildTimeline(settings);
  Sound.setVolume(settings.volume / 100);
  if (shown.kind) paint(shown.kind);
  if (signature() !== before && mode !== 'idle') {
    reset();
  } else {
    nextEvent = firstEventFrom(mode === 'running' ? elapsed() + LOOKAHEAD + 1 : elapsed());
    afterChange();
  }
  syncSettings();
}

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(cls, text, label) {
  const b = h('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}

// Tap steps once; holding repeats and speeds up. A scroll that starts on the
// button cancels without changing anything.
function holdToRepeat(btn, action) {
  let timer = 0;
  let held = false;
  const stop = () => { clearTimeout(timer); timer = 0; };
  btn.addEventListener('pointerdown', () => {
    stop();
    held = false;
    let delay = 350;
    const again = () => {
      held = true;
      if (!action()) return;
      delay = Math.max(40, delay * 0.8);
      timer = setTimeout(again, delay);
    };
    timer = setTimeout(again, delay);
  });
  btn.addEventListener('pointerup', () => {
    const tap = timer && !held;
    stop();
    if (tap) action();
  });
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('click', e => { if (e.detail === 0) action(); }); // keyboard
}

// Finer steps for short times, coarser for long ones.
function timeStep(v, dir) {
  const x = dir > 0 ? v : v - 1;
  return x < 60 ? 5 : x < 600 ? 15 : 60;
}

function bump(st, dir) {
  const v = settings[st.key];
  const step = st.kind === 'time' ? timeStep(v, dir) : 1;
  const raw = dir > 0 ? Math.floor(v / step) * step + step : Math.ceil(v / step) * step - step;
  const next = clamp(raw, st.min, st.max);
  if (next === v) return false;
  updateSettings({ [st.key]: next });
  return true;
}

function showValue(st, v) {
  if (v === 0 && st.zero) return st.zero;
  if (st.kind === 'time') return fmt(v);
  if (st.kind === 'sec') return `${v} s`;
  return String(v);
}

const stepperEls = {};
const soundEls = {};
const colorEls = {};
const toggleEls = {};

function buildSettings() {
  for (const st of STEPPERS) {
    const row = h('div', 'row');
    const minus = button('step', '−', `Less ${st.label}`);
    const plus = button('step', '+', `More ${st.label}`);
    const val = h('output', 'val');
    holdToRepeat(minus, () => bump(st, -1));
    holdToRepeat(plus, () => bump(st, 1));
    row.append(h('span', 'label', st.label), minus, val, plus);
    $('steppers').append(row);
    stepperEls[st.key] = { val, minus, plus };
  }

  for (const [key, label] of SOUND_EVENTS) {
    const row = h('div', 'row');
    const select = h('select', 'select');
    select.setAttribute('aria-label', `${label} sound`);
    for (const [id, name] of Object.entries(Sound.SOUND_NAMES)) {
      const opt = h('option', null, name);
      opt.value = id;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      updateSettings({ sounds: { ...settings.sounds, [key]: select.value } });
      Sound.play(select.value);
    });
    const test = button('play', '▶', `Play ${label} sound`);
    test.addEventListener('click', () => Sound.play(settings.sounds[key]));
    row.append(h('span', 'label', label), select, test);
    $('sounds').append(row);
    soundEls[key] = { select, test };
  }

  const volume = $('volume');
  volume.addEventListener('input', () => updateSettings({ volume: Number(volume.value) }));
  volume.addEventListener('change', () => Sound.play('beep'));

  for (const b of document.querySelectorAll('[data-session]')) {
    b.addEventListener('click', () => {
      Sound.setSessionType(b.dataset.session);
      Sound.unlock();
      updateSettings({ session: b.dataset.session });
      Sound.play('bell1');
    });
  }

  for (const [key, label] of COLOR_KEYS) {
    const wrap = h('label', 'swatch');
    const input = h('input');
    input.type = 'color';
    input.addEventListener('input', () => updateSettings({ colors: { ...settings.colors, [key]: input.value } }));
    wrap.append(input, h('span', null, label));
    $('colors').append(wrap);
    colorEls[key] = input;
  }
  const resetColors = button('pill small', 'Reset colors');
  resetColors.addEventListener('click', () => updateSettings({ colors: { ...DEFAULTS.colors } }));
  $('colors').append(resetColors);

  for (const [key, label] of TOGGLES) {
    const row = h('label', 'row toggle');
    const input = h('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.addEventListener('change', () => updateSettings({ [key]: input.checked }));
    row.append(h('span', 'label', label), input);
    $('toggles').append(row);
    toggleEls[key] = input;
  }

  $('save-preset').addEventListener('click', savePreset);
  $('preset-name').addEventListener('keydown', e => { if (e.key === 'Enter') savePreset(); });

  // Two taps, so a stray touch can't wipe everything.
  const restore = $('restore');
  let armed = 0;
  restore.addEventListener('click', () => {
    if (!armed) {
      restore.textContent = 'Tap again to restore defaults';
      armed = setTimeout(() => { armed = 0; restore.textContent = 'Restore defaults'; }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    restore.textContent = 'Restore defaults';
    if (settings.session !== DEFAULTS.session) {
      Sound.setSessionType(DEFAULTS.session);
      Sound.unlock();
    }
    updateSettings(structuredClone(DEFAULTS));
  });
}

function savePreset() {
  const input = $('preset-name');
  const name = input.value.trim().slice(0, 24) || `${settings.rounds} × ${fmt(settings.work)}`;
  presets = [...presets.filter(p => p.name !== name), { name, ...pickTiming(settings) }];
  store.set(KEY_PRESETS, presets);
  input.value = '';
  input.blur();
  renderPresets();
}

function renderPresets() {
  const box = $('presets');
  box.replaceChildren();
  const all = [...BUILT_IN.map(p => ({ ...p, builtIn: true })), ...presets];
  for (const p of all) {
    const active = TIMING.every(k => p[k] === settings[k]);
    const chip = h('div', active ? 'chip active' : 'chip');
    const main = button('chip-main');
    main.append(h('strong', null, p.name), h('small', null, `${p.rounds} × ${fmt(p.work)}${p.rest ? ` / ${fmt(p.rest)}` : ''}`));
    main.addEventListener('click', () => updateSettings(pickTiming(p)));
    chip.append(main);
    if (!p.builtIn) {
      const del = button('chip-x', '×', `Delete preset ${p.name}`);
      del.addEventListener('click', () => {
        presets = presets.filter(q => q.name !== p.name);
        store.set(KEY_PRESETS, presets);
        renderPresets();
      });
      chip.append(del);
    }
    box.append(chip);
  }
}

function syncSettings() {
  for (const st of STEPPERS) {
    const v = settings[st.key];
    const { val, minus, plus } = stepperEls[st.key];
    val.textContent = showValue(st, v);
    minus.disabled = v <= st.min;
    plus.disabled = v >= st.max;
  }
  for (const [key] of SOUND_EVENTS) {
    soundEls[key].select.value = settings.sounds[key];
    soundEls[key].test.disabled = settings.sounds[key] === 'none';
  }
  $('volume').value = settings.volume;
  $('volume-out').textContent = `${settings.volume}%`;
  for (const b of document.querySelectorAll('[data-session]')) {
    b.setAttribute('aria-checked', String(b.dataset.session === settings.session));
  }
  for (const [key] of COLOR_KEYS) colorEls[key].value = settings.colors[key];
  for (const [key] of TOGGLES) toggleEls[key].checked = settings[key];
  renderPresets();
}

// ---- Wiring ----

const dialog = $('settings');

el.primary.addEventListener('click', () => {
  if (mode === 'running') pause();
  else if (mode === 'paused') resume();
  else start();
});
el.reset.addEventListener('click', reset);
el.skip.addEventListener('click', skip);

$('open-settings').addEventListener('click', () => {
  syncSettings();
  dialog.showModal();
});
$('close-settings').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

// iOS only starts audio (and grants wake locks) inside a user gesture, so every
// tap anywhere doubles as an unlock. pointerdown doesn't count as one on iOS.
for (const type of ['touchend', 'click']) {
  document.addEventListener(type, () => {
    Sound.unlock();
    if (mode === 'running' && settings.awake) keepAwake(true);
  }, { capture: true, passive: true });
}

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !dialog.open) {
    e.preventDefault();
    Sound.unlock();
    el.primary.click();
  }
});

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  Sound.wake();
  keepAwake(mode === 'running' && settings.awake);
  render();
}
document.addEventListener('visibilitychange', onVisible);
window.addEventListener('pageshow', onVisible);

Sound.setSessionType(settings.session);
Sound.setVolume(settings.volume / 100);
$('version').textContent = VERSION;
$('session-row').hidden = !Sound.hasSessionApi;
buildSettings();
syncSettings();
restoreSession();
afterChange();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
