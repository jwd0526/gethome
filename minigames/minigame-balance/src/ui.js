// Balance — UI layer. Owns the render loop, keyboard, and the tuning form.
// All physics lives in balance.js; nothing here does arithmetic on lean.

import {
  DEFAULT_CONFIG,
  createConfig,
  createState,
  tick,
  reduceInput,
  setInput,
  dangerLevel,
  leanFraction,
  formatTime,
  FIXED_STEP,
} from './balance.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// tunable parameters — every one of them editable at runtime
// ---------------------------------------------------------------------------

const PARAMS = [
  { key: 'gravityRampRate', label: 'gravityRampRate', min: 1, max: 1.6, step: 0.005,
    note: 'compounding growth per second — biggest lever on run length' },
  { key: 'correctionStrength', label: 'correctionStrength', min: 0.2, max: 8, step: 0.1,
    note: 'acceleration while a direction is held' },
  { key: 'damping', label: 'damping', min: 0, max: 5, step: 0.05,
    note: 'lower = twitchier, higher = floatier' },
  { key: 'baseGravityStart', label: 'baseGravityStart (sober)', min: 0.2, max: 4, step: 0.01,
    note: 'starting pull when sober' },
  { key: 'drunkGravityStart', label: 'drunkGravityStart', min: 0.2, max: 4, step: 0.01,
    note: 'starting pull when drunk' },
  { key: 'initialLeanMagnitude', label: 'initialLeanMagnitude', min: 0.001, max: 0.3, step: 0.001,
    note: 'opening nudge off centre — at exactly 0 nothing ever moves' },
  { key: 'fallThreshold', label: 'fallThreshold', min: 0.2, max: 2, step: 0.05,
    note: '|lean| at or past this ends the run' },
];

// Candidate starting points. These are spread across the ramp-rate range rather than
// derived — the whole point is to play them and see which feels right.
const PRESETS = {
  spec:     { gravityRampRate: 1.02, correctionStrength: 2.5, damping: 1.5 },
  gentle:   { gravityRampRate: 1.06, correctionStrength: 2.5, damping: 1.5 },
  moderate: { gravityRampRate: 1.12, correctionStrength: 2.5, damping: 1.5 },
  steep:    { gravityRampRate: 1.22, correctionStrength: 2.5, damping: 1.3 },
  brutal:   { gravityRampRate: 1.35, correctionStrength: 2.8, damping: 1.1 },
};

// ---------------------------------------------------------------------------
// ui state (deliberately not part of BalanceGameState)
// ---------------------------------------------------------------------------

let config = createConfig();
let state = null;
let running = false;
let rafHandle = null;
let lastFrame = 0;
let accumulator = 0;
let leftHeld = false;
let rightHeld = false;
let best = null;
let runs = [];

// Guards the spiral of death after a tab has been backgrounded: never simulate more than
// a quarter second of catch-up in one frame.
const MAX_FRAME_SECONDS = 0.25;

// Keep in sync with .marker width in styles.css.
const MARKER_WIDTH = 10;

// ---------------------------------------------------------------------------
// tuning form
// ---------------------------------------------------------------------------

function buildParams() {
  const host = $('params');
  host.innerHTML = '';
  for (const p of PARAMS) {
    const wrap = document.createElement('div');
    wrap.className = 'param';

    const label = document.createElement('label');
    label.textContent = p.label;
    label.htmlFor = `num-${p.key}`;

    const field = document.createElement('div');
    field.className = 'field';

    const range = document.createElement('input');
    range.type = 'range';
    range.id = `range-${p.key}`;
    Object.assign(range, { min: p.min, max: p.max, step: p.step, value: config[p.key] });

    const num = document.createElement('input');
    num.type = 'number';
    num.id = `num-${p.key}`;
    num.dataset.param = p.key;
    Object.assign(num, { min: p.min, max: p.max, step: p.step, value: config[p.key] });

    const sync = (value, mirror) => {
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      config = createConfig({ ...config, [p.key]: v });
      mirror.value = String(v);
      markPresetMatch();
    };
    range.addEventListener('input', () => sync(range.value, num));
    num.addEventListener('input', () => sync(num.value, range));

    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = p.note;

    field.append(range, num);
    wrap.append(label, field, note);
    host.appendChild(wrap);
  }
}

function applyPreset(name) {
  config = createConfig({ ...DEFAULT_CONFIG, ...PRESETS[name] });
  for (const p of PARAMS) {
    $(`range-${p.key}`).value = String(config[p.key]);
    $(`num-${p.key}`).value = String(config[p.key]);
  }
  markPresetMatch();
}

// Highlight a preset only while the form still matches it exactly.
function markPresetMatch() {
  for (const btn of document.querySelectorAll('.preset')) {
    const preset = { ...DEFAULT_CONFIG, ...PRESETS[btn.dataset.preset] };
    const matches = PARAMS.every((p) => Math.abs(preset[p.key] - config[p.key]) < 1e-9);
    btn.classList.toggle('active', matches);
  }
}

// ---------------------------------------------------------------------------
// run lifecycle
// ---------------------------------------------------------------------------

function startRun() {
  state = createState({
    config,
    isDrunk: $('is-drunk').checked,
    startingLeanSign: Math.random() < 0.5 ? -1 : 1,
  });
  leftHeld = false;
  rightHeld = false;
  running = true;
  accumulator = 0;
  lastFrame = performance.now();

  $('start').textContent = 'Restart';
  $('bar').classList.remove('fallen');
  setStatus('Balancing…', 'running');
  render();

  cancelAnimationFrame(rafHandle);
  rafHandle = requestAnimationFrame(frame);
}

function endRun() {
  running = false;
  cancelAnimationFrame(rafHandle);
  rafHandle = null;
  $('bar').classList.add('fallen');

  const score = state.finalScore ?? state.elapsedTime;
  if (best === null || score > best) best = score;
  recordRun(score);
  setStatus(`You fell! Survived: ${formatTime(score)} — press Start or Space to go again.`, 'fallen');
  render();
}

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

function frame(nowMs) {
  if (!running) return;

  const elapsed = Math.min((nowMs - lastFrame) / 1000, MAX_FRAME_SECONDS);
  lastFrame = nowMs;
  accumulator += elapsed;

  // Fixed timestep: the physics is identical on a 60 Hz and a 144 Hz display.
  state = setInput(state, reduceInput(leftHeld, rightHeld));
  while (accumulator >= FIXED_STEP && !state.isFallen) {
    state = tick(state, config, FIXED_STEP);
    accumulator -= FIXED_STEP;
  }

  render();
  if (state.isFallen) return endRun();
  rafHandle = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render() {
  if (!state) return;
  const danger = dangerLevel(state, config);

  const marker = $('marker');
  // Inset by the marker's own width so it stays fully inside the bar at both extremes
  // rather than being half-clipped by the overflow at lean = ±1.
  marker.style.left = `calc(${MARKER_WIDTH / 2}px + ${leanFraction(state, config)} * (100% - ${MARKER_WIDTH}px))`;
  // Green at centre through amber to red at the threshold.
  const hue = 145 - 145 * danger;
  marker.style.backgroundColor = `hsl(${hue} 60% ${52 - 8 * danger}%)`;

  $('timer').textContent = formatTime(state.finalScore ?? state.elapsedTime);
  $('gravity').textContent = state.gravityCoefficient.toFixed(3);
  $('lean').textContent = state.lean.toFixed(3);
  $('velocity').textContent = state.leanVelocity.toFixed(3);
  $('input').textContent = state.inputDirection === -1 ? '← left'
    : state.inputDirection === 1 ? 'right →' : '— none';
  $('best').textContent = best === null ? '—' : formatTime(best);
}

function recordRun(score) {
  runs.unshift({
    n: runs.length + 1,
    score,
    isDrunk: state.isDrunk,
    gravityRampRate: config.gravityRampRate,
    correctionStrength: config.correctionStrength,
    damping: config.damping,
    gravityStart: state.isDrunk ? config.drunkGravityStart : config.baseGravityStart,
    initialLean: config.initialLeanMagnitude,
  });
  renderRuns();
}

function renderRuns() {
  const body = $('runs-rows');
  body.innerHTML = '';
  $('runs-empty').classList.toggle('hidden', runs.length > 0);
  $('runs-empty').style.display = runs.length ? 'none' : '';

  for (const r of runs) {
    const tr = document.createElement('tr');
    if (best !== null && Math.abs(r.score - best) < 1e-9) tr.classList.add('best');
    tr.dataset.score = r.score.toFixed(2);
    const cells = [
      String(r.n), formatTime(r.score), r.isDrunk ? 'yes' : 'no',
      r.gravityRampRate.toFixed(3), r.correctionStrength.toFixed(2),
      r.damping.toFixed(2), r.gravityStart.toFixed(2), r.initialLean.toFixed(3),
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// input — reduced to booleans here; the logic layer only ever sees -1/0/1
// ---------------------------------------------------------------------------

const LEFT_KEYS = new Set(['ArrowLeft', 'KeyA']);
const RIGHT_KEYS = new Set(['ArrowRight', 'KeyD']);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    startRun();
    return;
  }
  if (LEFT_KEYS.has(e.code)) { leftHeld = true; e.preventDefault(); }
  else if (RIGHT_KEYS.has(e.code)) { rightHeld = true; e.preventDefault(); }
});

window.addEventListener('keyup', (e) => {
  if (LEFT_KEYS.has(e.code)) { leftHeld = false; e.preventDefault(); }
  else if (RIGHT_KEYS.has(e.code)) { rightHeld = false; e.preventDefault(); }
});

// Releasing focus must not leave a key stuck down.
window.addEventListener('blur', () => { leftHeld = false; rightHeld = false; });

function bindHold(button, set) {
  const down = (e) => { e.preventDefault(); set(true); button.classList.add('pressed'); };
  const up = () => { set(false); button.classList.remove('pressed'); };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointerleave', up);
  button.addEventListener('pointercancel', up);
}
bindHold($('touch-left'), (v) => { leftHeld = v; });
bindHold($('touch-right'), (v) => { rightHeld = v; });

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

$('start').addEventListener('click', startRun);
$('clear-runs').addEventListener('click', () => { runs = []; best = null; renderRuns(); render(); });
for (const btn of document.querySelectorAll('.preset')) {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
}

buildParams();
markPresetMatch();
renderRuns();

// Test hook — lets the browser suite read authoritative state and drive input without
// synthesising key events. No role in gameplay.
window.__bal = {
  getState: () => state,
  getConfig: () => config,
  isRunning: () => running,
  getRuns: () => runs,
  start: startRun,
  setHeld: (left, right) => { leftHeld = left; rightHeld = right; },
  setConfig: (patch) => { config = createConfig({ ...config, ...patch }); },
};
