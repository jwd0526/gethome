// Balance Game — rules/physics layer.
//
// Pure logic. No DOM, no rAF, no key handling. State and config are plain JSON-shaped
// data (numbers and booleans only), so the whole thing ports to Unreal's Tick() as a
// near-direct transliteration.
//
// Contract:
//   tick(state, config, dt) -> newState
//   reduceInput(leftHeld, rightHeld) -> -1 | 0 | 1
//
// Section references are to minigame-balance.md.

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Section 6 defaults. `gravityRampRate` is the tuned value — see TUNING.md. */
export const DEFAULT_CONFIG = {
  fallThreshold: 1.0,
  correctionStrength: 2.5,
  damping: 1.5,
  baseGravityStart: 1.05,
  drunkGravityStart: 1.07,
  gravityRampRate: 1.02,

  // Not in Section 2/6, but required: gravityForce is proportional to lean, so a run
  // starting at exactly lean 0 with zero velocity has zero force acting on it and would
  // stand still forever. Every run needs a nudge off dead centre to have a game at all.
  initialLeanMagnitude: 0.02,
};

export function createConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/**
 * Section 2 — BalanceGameState.
 * `startingLeanSign` (+1/-1) is injectable so tests and the tuning harness can pin a run;
 * the UI passes a random one.
 */
export function createState(opts = {}) {
  const config = opts.config ?? DEFAULT_CONFIG;
  const isDrunk = Boolean(opts.isDrunk);
  const sign = opts.startingLeanSign ?? 1;
  const magnitude = opts.initialLean ?? config.initialLeanMagnitude;

  return {
    lean: sign * magnitude,
    leanVelocity: 0,
    gravityCoefficient: isDrunk ? config.drunkGravityStart : config.baseGravityStart,
    elapsedTime: 0,
    inputDirection: 0,
    isFallen: false,
    isDrunk,
    finalScore: null,
  };
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

/**
 * Section 4 / Section 8 — the boundary where platform input becomes a single number.
 * Takes booleans, never key events: nothing platform-shaped reaches the physics.
 * Both held or neither held cancels to 0.
 */
export function reduceInput(leftHeld, rightHeld) {
  if (leftHeld === rightHeld) return 0;
  return leftHeld ? -1 : 1;
}

/** Pure setter, so callers never mutate state in place. */
export function setInput(state, inputDirection) {
  if (state.inputDirection === inputDirection) return state;
  return { ...state, inputDirection };
}

// ---------------------------------------------------------------------------
// physics
// ---------------------------------------------------------------------------

/**
 * Section 3 — one physics step. Pure: returns a new state, never mutates the input.
 *
 * Step order matters and follows the spec exactly, including that the fall check happens
 * *before* elapsedTime accumulates — the tick you fall on does not count toward the score.
 */
export function tick(state, config, dt) {
  if (state.isFallen) return state;

  const next = { ...state };

  // 1. Difficulty ramp. Same growth rate drunk or sober — drunk starts harder, not steeper.
  next.gravityCoefficient = state.gravityCoefficient * Math.pow(config.gravityRampRate, dt);

  // 2. Forces. gravityForce always shares lean's sign, so it pulls *away* from centre and
  //    vanishes at centre. Overcorrection needs no special case: push past 0 and the same
  //    term flips and starts pulling you the other way.
  const gravityForce = next.gravityCoefficient * state.lean;
  const inputForce = config.correctionStrength * state.inputDirection;
  const netAcceleration = gravityForce + inputForce;

  // 3. Integrate velocity, then damp.
  next.leanVelocity = state.leanVelocity + netAcceleration * dt;
  next.leanVelocity *= 1 - config.damping * dt;

  // 4. Integrate position.
  next.lean = state.lean + next.leanVelocity * dt;

  // 5. Fall check, before the time credit.
  if (Math.abs(next.lean) >= config.fallThreshold) {
    next.lean = Math.sign(next.lean) * config.fallThreshold; // clamp for a clean readout
    next.isFallen = true;
    next.finalScore = next.elapsedTime;
    return next;
  }

  next.elapsedTime = state.elapsedTime + dt;
  return next;
}

/**
 * Advance a run by `seconds` in fixed sub-steps. Fixed stepping keeps the simulation
 * deterministic and frame-rate independent — the UI accumulates real time and calls this,
 * so a 144 Hz monitor and a 60 Hz monitor play the identical game.
 */
export function advance(state, config, seconds, fixedStep = FIXED_STEP) {
  let next = state;
  let remaining = seconds;
  let guard = 0;
  while (remaining > 1e-9 && !next.isFallen) {
    if (++guard > 100000) break;
    const step = Math.min(fixedStep, remaining);
    next = tick(next, config, step);
    remaining -= step;
  }
  return next;
}

export const FIXED_STEP = 1 / 120;

// ---------------------------------------------------------------------------
// derived readouts (for rendering — still pure)
// ---------------------------------------------------------------------------

/** 0 at centre, 1 at the fall threshold. Drives the marker colour. */
export function dangerLevel(state, config) {
  return Math.min(1, Math.abs(state.lean) / config.fallThreshold);
}

/**
 * Signed lean as a -1..1 fraction of the fall threshold: -1 fully left, 0 centred,
 * +1 fully right. Drives the character's tilt.
 */
export function tiltFraction(state, config) {
  const clamped = Math.max(-config.fallThreshold, Math.min(config.fallThreshold, state.lean));
  return clamped / config.fallThreshold;
}

/** Marker position as a 0..1 fraction across the bar, 0.5 = centred. */
export function leanFraction(state, config) {
  return (tiltFraction(state, config) + 1) / 2;
}

export function formatTime(seconds) {
  return `${seconds.toFixed(1)}s`;
}
