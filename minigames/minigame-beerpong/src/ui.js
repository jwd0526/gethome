// Beer Pong — UI layer. Owns the meters, the throw animation, and the screens.
// Every rule lives in beerpong.js; nothing here decides whether a throw went in.

import {
  DEFAULT_CONFIG,
  createConfig,
  createGame,
  applyThrow,
  advanceAfterThrow,
  beginPower,
  checkGameOver,
  candidateCups,
  remainingCups,
  defendingTeam,
  getTeam,
  getPlayer,
  rackExtent,
  aimToX,
  powerToY,
  turnLabel,
  suddenDeathLabel,
  resultLabel,
  teamName,
  teamRoster,
} from './beerpong.js';

import {
  createMeter,
  lockMeter,
  advanceMeter,
} from './meter.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// scene mapping — rack units to SVG units
//
// The viewBox is 100 wide by 132 tall with the halfway line at y=66. The far rack (the
// one being thrown at) is drawn full size; the near rack is the thrower's own cups, drawn
// smaller because it is context rather than a target.
// ---------------------------------------------------------------------------

const FAR_SCALE = 15;
const FAR_TIP_Y = 54;
const NEAR_SCALE = 10;
const NEAR_TIP_Y = 76;
const BALL_ORIGIN = { x: 50, y: 126 };
const CUP_R = 0.5; // rack units — cups are unit diameter and touching

const farX = (x) => 50 + x * FAR_SCALE;
const farY = (y) => FAR_TIP_Y - y * FAR_SCALE;
const nearX = (x) => 50 + x * NEAR_SCALE;
const nearY = (y) => NEAR_TIP_Y + y * NEAR_SCALE;

const THROW_MS = 720;
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// tunables exposed in the UI (Section 6 calls these out as tune-from-playtesting)
// ---------------------------------------------------------------------------

const PARAMS = [
  { key: 'toleranceRadius', min: 0.15, max: 0.8, step: 0.01,
    note: 'how close to a cup centre counts as in — cups sit 1.0 apart' },
  { key: 'maxAimOffset', min: 0, max: 0.4, step: 0.005,
    note: 'aim drift at drunkenness 1.0, in meter units' },
  { key: 'aimMargin', min: 0.2, max: 2.5, step: 0.05,
    note: 'how far past the rack edge a throw can stray' },
  { key: 'powerMargin', min: 0.2, max: 2.5, step: 0.05,
    note: 'how short or long a throw can land' },
];

const METER_PARAMS = [
  { key: 'aimSpeed', label: 'aim meter speed', min: 0.3, max: 3.5, step: 0.05,
    note: 'sweeps per second — the whole difficulty dial' },
  { key: 'powerSpeed', label: 'power meter speed', min: 0.3, max: 3.5, step: 0.05,
    note: 'sweeps per second for the second meter' },
];

// ---------------------------------------------------------------------------
// ui state (deliberately not part of GameState)
// ---------------------------------------------------------------------------

let state = null;
let config = createConfig();
let meterConfig = { aimSpeed: 1.15, powerSpeed: 1.45 };
let playerCount = 2;

let mode = 'idle'; // idle | aim | power | flying | over
let meter = null;
let lockedAim = null;
let rafHandle = null;
let lastFrame = 0;

// Guards the spiral of death after a backgrounded tab: never sweep more than a quarter
// second of catch-up in one frame.
const MAX_FRAME_SECONDS = 0.25;

// ---------------------------------------------------------------------------
// setup screen
// ---------------------------------------------------------------------------

function renderSetupRows() {
  const rows = $('setup-rows');
  rows.innerHTML = '';
  for (let i = 0; i < playerCount; i++) {
    const tr = document.createElement('tr');

    const num = document.createElement('td');
    num.textContent = String(i + 1);

    const nameCell = document.createElement('td');
    const name = document.createElement('input');
    name.id = `name-${i}`;
    name.value = `Player ${i + 1}`;
    nameCell.appendChild(name);

    const standingCell = document.createElement('td');
    const standing = document.createElement('input');
    standing.id = `standing-${i}`;
    standing.type = 'number';
    standing.step = '1';
    standing.value = '0';
    standingCell.appendChild(standing);

    const drunkCell = document.createElement('td');
    const drunk = document.createElement('input');
    drunk.id = `drunk-${i}`;
    drunk.type = 'number';
    drunk.min = '0';
    drunk.max = '1';
    drunk.step = '0.05';
    drunk.value = '0';
    drunkCell.appendChild(drunk);

    tr.append(num, nameCell, standingCell, drunkCell);
    rows.appendChild(tr);
  }
  for (const btn of document.querySelectorAll('.choice')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.count) === playerCount));
  }
}

function startMatch() {
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: `p${i + 1}`,
      name: $(`name-${i}`).value.trim() || `Player ${i + 1}`,
      standingPoints: Number($(`standing-${i}`).value) || 0,
      drunkenness: Math.max(0, Math.min(1, Number($(`drunk-${i}`).value) || 0)),
    });
  }
  const rawSeed = $('seed-input').value.trim();
  state = createGame({ players, seed: rawSeed === '' ? undefined : Number(rawSeed) });

  mode = 'idle';
  meter = null;
  lockedAim = null;
  show('match');
  renderAll();
  setStatus('Press Throw (or Space) to start the aim meter.');
}

// ---------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------

function show(name) {
  for (const id of ['setup', 'match', 'over']) {
    $(`screen-${id}`).classList.toggle('hidden', id !== name);
  }
}

function setStatus(text, cls = '') {
  const el = $('throw-status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

// ---------------------------------------------------------------------------
// rendering — racks
// ---------------------------------------------------------------------------

function renderAll() {
  renderRacks();
  renderHud();
  renderMeters();
  renderLog();
}

function renderHud() {
  $('turn-indicator').textContent = turnLabel(state);
  $('format-indicator').textContent =
    `${state.matchFormat} — ${state.teams.map((t) => `${teamName(state, t.id)}: ${teamRoster(state, t.id)}`).join('  |  ')}`;

  const sd = suddenDeathLabel(state);
  $('sudden-death').textContent = sd ?? '';
  $('sudden-death').classList.toggle('hidden', !sd);

  // Section 9: the re-rack notice exists to make the deferral timing visible.
  const rerack = state.lastRerack;
  $('rerack-notice').textContent = rerack
    ? `Rack reset to ${rerack.label} — ${teamName(state, rerack.teamId)}'s rack, applied at this turn's start.`
    : '';
  $('rerack-notice').classList.toggle('hidden', !rerack);
}

function renderRacks() {
  const far = $('rack-far');
  const near = $('rack-near');
  far.innerHTML = '';
  near.innerHTML = '';

  if (state.suddenDeathActive) {
    // Section 7: one respawning cup replaces the rack as the target.
    far.appendChild(cupCircle(state.suddenDeathCup, farX, farY, FAR_SCALE, 'sd'));
    far.appendChild(svgText(farX(0), farY(state.suddenDeathCup.y) + FAR_SCALE * CUP_R + 6,
      'sudden-death cup', 'cup-caption'));
    near.appendChild(svgText(nearX(0), nearY(1.2), 'racks are out of play', 'cup-caption'));
    return;
  }

  const defender = defendingTeam(state);
  const attacker = getTeam(state, state.activeTeamId);

  for (const cup of defender.cupRack) {
    far.appendChild(cupCircle(cup, farX, farY, FAR_SCALE, cup.isSunk ? 'sunk' : ''));
  }
  for (const cup of attacker.cupRack) {
    near.appendChild(cupCircle(cup, nearX, nearY, NEAR_SCALE, cup.isSunk ? 'sunk' : ''));
  }

  far.appendChild(svgText(50, 6,
    `${teamName(state, defender.id)} — ${remainingCups(defender).length} cups`, 'rack-label'));
  near.appendChild(svgText(50, 128,
    `${teamName(state, attacker.id)} (throwing) — ${remainingCups(attacker).length} cups`, 'rack-label'));
}

function cupCircle(cup, mapX, mapY, scale, extra) {
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', mapX(cup.x).toFixed(2));
  c.setAttribute('cy', mapY(cup.y).toFixed(2));
  c.setAttribute('r', (CUP_R * scale).toFixed(2));
  c.setAttribute('class', `cup ${extra}`.trim());
  c.dataset.cupId = cup.id;
  c.dataset.sunk = String(Boolean(cup.isSunk));
  return c;
}

function svgText(x, y, text, cls) {
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('class', cls);
  t.setAttribute('text-anchor', 'middle');
  t.textContent = text;
  return t;
}

// ---------------------------------------------------------------------------
// rendering — meters
// ---------------------------------------------------------------------------

function renderMeters() {
  const aimLive = mode === 'aim';
  const powerLive = mode === 'power';

  $('aim-block').classList.toggle('live', aimLive);
  $('power-block').classList.toggle('live', powerLive);
  $('power-block').classList.toggle('waiting', mode === 'idle' || mode === 'aim');

  // A locked aim stays visible while the power meter runs — you can see what you committed
  // to. At rest both markers park at their start edge rather than vanishing.
  const aimPos = aimLive ? meter.position : lockedAim;
  placeMarker('aim-marker', aimPos ?? 0);
  $('aim-value').textContent = aimPos === null || aimPos === undefined ? '—' : aimPos.toFixed(3);

  const powerPos = powerLive ? meter.position : null;
  placeMarker('power-marker', powerPos ?? 1);
  $('power-value').textContent = powerPos === null ? '—' : powerPos.toFixed(3);
}

function placeMarker(id, position) {
  const el = $(id);
  if (position === null || position === undefined) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.style.left = `${(position * 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// the meter loop
// ---------------------------------------------------------------------------

function startMeter(which) {
  mode = which;
  meter = createMeter({
    speed: which === 'aim' ? meterConfig.aimSpeed : meterConfig.powerSpeed,
    // Alternate the starting edge so the two meters in a chain do not feel identical.
    startPosition: which === 'aim' ? 0 : 1,
    startDirection: which === 'aim' ? 1 : -1,
  });
  lastFrame = performance.now();
  cancelAnimationFrame(rafHandle);
  rafHandle = requestAnimationFrame(meterFrame);
  renderMeters();
  updateButton();
}

function meterFrame(nowMs) {
  if (mode !== 'aim' && mode !== 'power') return;
  const elapsed = Math.min((nowMs - lastFrame) / 1000, MAX_FRAME_SECONDS);
  lastFrame = nowMs;
  meter = advanceMeter(meter, elapsed);
  renderMeters();
  rafHandle = requestAnimationFrame(meterFrame);
}

function stopMeterLoop() {
  cancelAnimationFrame(rafHandle);
  rafHandle = null;
}

/** The one action button: start, lock aim, lock power. */
function advance() {
  if (mode === 'idle') {
    startMeter('aim');
    setStatus('Aim: lock it where you want the ball to go left-to-right.', 'live');
    return;
  }
  if (mode === 'aim') {
    meter = lockMeter(meter);
    lockedAim = meter.value;
    state = beginPower(state);
    startMeter('power');
    setStatus('Power: lock it for how far the ball carries.', 'live');
    return;
  }
  if (mode === 'power') {
    meter = lockMeter(meter);
    stopMeterLoop();
    resolveThrow(lockedAim, meter.value);
  }
}

// ---------------------------------------------------------------------------
// throwing
// ---------------------------------------------------------------------------

function resolveThrow(aimValue, powerValue) {
  const { newState, throwResult } = applyThrow(state, aimValue, powerValue, config);
  state = newState;
  mode = 'flying';
  updateButton();
  renderMeters();
  renderRacks();

  // Section 6: the throw has to visibly cash out as a place on the table, not a verdict.
  animateThrow(throwResult, () => {
    state = advanceAfterThrow(state);
    lockedAim = null;
    meter = null;

    if (checkGameOver(state)) {
      mode = 'over';
      showResults();
      return;
    }
    mode = 'idle';
    renderAll();
    updateButton();
    setStatus(throwSummary(throwResult), throwResult.hitCupId ? 'hit' : 'miss');
  });
}

function throwSummary(result) {
  const who = getPlayer(state, result.throwerId).name;
  const drifted = Math.abs(result.adjustedAim - result.lockedAim) > 1e-9
    ? ` (drunk aim pulled it ${result.adjustedAim > result.lockedAim ? 'right' : 'left'})`
    : '';
  if (!result.hitCupId) return `${who} missed${drifted}. Press Throw for the next ball.`;
  if (result.isSuddenDeath) {
    return `${who} hit the sudden-death cup${drifted} — streak ${state.suddenDeathCurrentStreak}.`;
  }
  if (result.clearedRack) return `${who} cleared the rack${drifted}! Sudden death begins.`;
  return `${who} sank it${drifted}. Press Throw for the next ball.`;
}

/**
 * Arc the ball from the thrower to the landing point over ~0.7s, then reveal the outcome.
 * A quadratic Bezier is enough — Section 6 asks for legibility, not physics.
 */
function animateThrow(result, done) {
  const ball = $('ball');
  const from = BALL_ORIGIN;
  const to = { x: farX(result.target.x), y: farY(result.target.y) };
  // Control point above the midpoint: the higher it is, the loftier the arc.
  const control = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 34 };

  ball.classList.remove('hidden');
  showLanding(to, result);

  const start = performance.now();
  const step = (nowMs) => {
    const t = Math.min(1, (nowMs - start) / THROW_MS);
    const inv = 1 - t;
    const x = inv * inv * from.x + 2 * inv * t * control.x + t * t * to.x;
    const y = inv * inv * from.y + 2 * inv * t * control.y + t * t * to.y;
    ball.setAttribute('cx', x.toFixed(2));
    ball.setAttribute('cy', y.toFixed(2));
    // Fake height: the ball swells at the top of its arc.
    ball.setAttribute('r', (2.1 + 1.5 * Math.sin(Math.PI * t)).toFixed(2));

    if (t < 1) {
      requestAnimationFrame(step);
      return;
    }
    landBall(result, done);
  };
  requestAnimationFrame(step);
}

function showLanding(to, result) {
  const landing = $('landing');
  const ring = landing.querySelector('.landing-ring');
  ring.setAttribute('cx', to.x.toFixed(2));
  ring.setAttribute('cy', to.y.toFixed(2));
  ring.setAttribute('r', (config.toleranceRadius * FAR_SCALE).toFixed(2));
  landing.classList.remove('hidden');
  landing.classList.toggle('is-hit', Boolean(result.hitCupId));
}

function landBall(result, done) {
  const ball = $('ball');
  if (result.hitCupId) {
    const cup = document.querySelector(`#rack-far .cup[data-cup-id="${result.hitCupId}"]`);
    if (cup) cup.classList.add('sinking');
    ball.classList.add('dropping');
  } else {
    ball.classList.add('bouncing');
  }

  setTimeout(() => {
    ball.classList.add('hidden');
    ball.classList.remove('dropping', 'bouncing');
    $('landing').classList.add('hidden');
    done();
  }, 380);
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

function showResults() {
  stopMeterLoop();
  $('result-text').textContent = resultLabel(state);
  const rows = $('results-rows');
  rows.innerHTML = '';
  for (const team of state.teams) {
    const tr = document.createElement('tr');
    const isWinner = team.id === state.winnerTeamId;
    if (isWinner) tr.classList.add('winner');
    tr.dataset.teamId = team.id;
    for (const text of [
      teamName(state, team.id),
      teamRoster(state, team.id),
      String(remainingCups(team).length),
      isWinner ? 'WINNER' : '',
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    rows.appendChild(tr);
  }
  $('match-log').textContent = state.log.join('\n');
  show('over');
}

function renderLog() {
  // Newest last, like a running commentary; the box scrolls itself.
  const el = $('throw-log');
  el.textContent = state.log.slice(-12).join('\n');
  el.scrollTop = el.scrollHeight;
}

function updateButton() {
  const btn = $('lock');
  btn.textContent =
    mode === 'idle' ? 'Throw' :
    mode === 'aim' ? 'Lock aim' :
    mode === 'power' ? 'Lock power' : '…';
  btn.disabled = mode === 'flying' || mode === 'over';
}

// ---------------------------------------------------------------------------
// tuning form
// ---------------------------------------------------------------------------

function buildParams() {
  const host = $('params');
  host.innerHTML = '';
  const add = (spec, get, set) => {
    const wrap = document.createElement('div');
    wrap.className = 'param';

    const label = document.createElement('label');
    label.textContent = spec.label ?? spec.key;
    label.htmlFor = `num-${spec.key}`;

    const field = document.createElement('div');
    field.className = 'field';

    const range = document.createElement('input');
    range.type = 'range';
    range.id = `range-${spec.key}`;
    Object.assign(range, { min: spec.min, max: spec.max, step: spec.step, value: get() });

    const num = document.createElement('input');
    num.type = 'number';
    num.id = `num-${spec.key}`;
    num.dataset.param = spec.key;
    Object.assign(num, { min: spec.min, max: spec.max, step: spec.step, value: get() });

    const sync = (value, mirror) => {
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      set(v);
      mirror.value = String(v);
    };
    range.addEventListener('input', () => sync(range.value, num));
    num.addEventListener('input', () => sync(num.value, range));

    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = spec.note;

    field.append(range, num);
    wrap.append(label, field, note);
    host.appendChild(wrap);
  };

  for (const spec of PARAMS) {
    add(spec, () => config[spec.key], (v) => { config = createConfig({ ...config, [spec.key]: v }); });
  }
  for (const spec of METER_PARAMS) {
    add(spec, () => meterConfig[spec.key], (v) => { meterConfig = { ...meterConfig, [spec.key]: v }; });
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

for (const btn of document.querySelectorAll('.choice')) {
  btn.addEventListener('click', () => {
    playerCount = Number(btn.dataset.count);
    renderSetupRows();
  });
}
$('start-game').addEventListener('click', startMatch);
$('lock').addEventListener('click', advance);
$('new-match').addEventListener('click', backToSetup);
$('play-again').addEventListener('click', backToSetup);

function backToSetup() {
  stopMeterLoop();
  state = null;
  mode = 'idle';
  meter = null;
  lockedAim = null;
  show('setup');
  renderSetupRows();
}

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  if ($('screen-match').classList.contains('hidden')) return;
  e.preventDefault();
  if (mode !== 'flying' && mode !== 'over') advance();
});

// A backgrounded tab should not leave a meter sweeping against a stale clock.
window.addEventListener('blur', () => { lastFrame = performance.now(); });

renderSetupRows();
buildParams();
show('setup');

// Test hook — lets the browser suite read authoritative state and drive throws without
// racing the meters. No role in play.
window.__bp = {
  getState: () => state,
  getConfig: () => config,
  getMode: () => mode,
  getMeter: () => meter,
  setConfig: (patch) => { config = createConfig({ ...config, ...patch }); },
  setMeterConfig: (patch) => { meterConfig = { ...meterConfig, ...patch }; },
  // Lock both meters at chosen values and resolve, skipping the sweep entirely.
  throwAt: (aim, power) => {
    if (mode === 'flying' || mode === 'over') return false;
    stopMeterLoop();
    if (state.phase === 'AIM') state = beginPower(state);
    lockedAim = aim;
    resolveThrow(aim, power);
    return true;
  },
  // Aim dead centre of a cup that is currently a legal target.
  aimForCup: (cupId) => {
    const cup = candidateCups(state).find((c) => c.id === cupId) ?? candidateCups(state)[0];
    if (!cup) return null;
    const { minX, maxX, minY, maxY } = rackExtent();
    return {
      aim: (cup.x - (minX - config.aimMargin)) / ((maxX + config.aimMargin) - (minX - config.aimMargin)),
      power: (cup.y - (minY - config.powerMargin)) / ((maxY + config.powerMargin) - (minY - config.powerMargin)),
    };
  },
  sceneFor: (aim, power) => ({
    x: farX(aimToX(aim, config)),
    y: farY(powerToY(power, config)),
  }),
};
