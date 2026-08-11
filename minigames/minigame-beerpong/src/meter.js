// Template A — the timing meter.
//
// A marker sweeps back and forth across a track; the player locks it; the locked position
// is the result. That is the whole mechanic, and it is the same one Bottle Flip, Axe
// Throwing and Last Round Pour are specified to use (spec Section 10). Nothing in this
// file knows about beer pong, cups, or the DOM — it is deliberately game-agnostic so the
// other three Template A games can take it as-is.
//
// Contract:
//   createMeter(config) -> MeterState
//   tickMeter(state, dt) -> newState          (pure; dt in seconds)
//   lockMeter(state)     -> newState          (value frozen at the current position)
//
// State is plain JSON-shaped data, so it survives a stringify/parse round trip and maps
// onto a C++ struct in the Unreal port without redesign.

/**
 * `speed` is sweeps per second, where one sweep is a single pass across the track. A
 * marker therefore returns to where it started every 2/speed seconds.
 */
export const DEFAULT_METER_CONFIG = {
  speed: 1.1,
  // Where the marker starts. 0 is one end of the track, 1 the other.
  startPosition: 0,
  // +1 sweeps toward 1, -1 toward 0.
  startDirection: 1,
};

export function createMeter(config = {}) {
  const merged = { ...DEFAULT_METER_CONFIG, ...config };
  return {
    position: clampUnit(merged.startPosition),
    direction: merged.startDirection >= 0 ? 1 : -1,
    speed: merged.speed,
    isLocked: false,
    value: null,
  };
}

/**
 * Advance the sweep by `dt` seconds. Pure: returns a new state.
 *
 * The bounce is computed by reflection rather than by clamping and flipping, so a single
 * large dt (a backgrounded tab, or a coarse fixed step) lands in the same place a hundred
 * small ones would. Clamping would silently park the marker on an end instead.
 */
export function tickMeter(state, dt) {
  if (state.isLocked) return state;

  const travelled = state.position + state.direction * state.speed * dt;
  const { position, direction } = reflect(travelled, state.direction);
  return { ...state, position, direction };
}

/** Freeze the marker. `value` is the result the game reads; re-locking is a no-op. */
export function lockMeter(state) {
  if (state.isLocked) return state;
  return { ...state, isLocked: true, value: state.position };
}

/**
 * Fold a position back into [0, 1] by reflecting off each end, tracking which way the
 * marker ends up travelling. Handles any overshoot, including several sweeps' worth.
 */
function reflect(position, direction) {
  let p = position;
  let d = direction;

  // Each fold consumes one end. The loop runs at most ceil(overshoot) times.
  let guard = 0;
  while (p < 0 || p > 1) {
    if (++guard > 1000) return { position: clampUnit(p), direction: d };
    if (p < 0) {
      p = -p;
      d = 1;
    } else {
      p = 2 - p;
      d = -1;
    }
  }
  return { position: p, direction: d };
}

function clampUnit(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Advance a meter by `seconds` in fixed sub-steps. The UI accumulates real frame time and
 * calls this, so the sweep runs at the same rate on a 60 Hz and a 144 Hz display.
 */
export function advanceMeter(state, seconds, fixedStep = METER_FIXED_STEP) {
  let next = state;
  let remaining = seconds;
  let guard = 0;
  while (remaining > 1e-9 && !next.isLocked) {
    if (++guard > 100000) break;
    const step = Math.min(fixedStep, remaining);
    next = tickMeter(next, step);
    remaining -= step;
  }
  return next;
}

export const METER_FIXED_STEP = 1 / 120;
