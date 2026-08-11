// Physics-layer checks. Run: node tests/logic-tests.js

import {
  DEFAULT_CONFIG,
  createConfig,
  createState,
  tick,
  advance,
  reduceInput,
  setInput,
  dangerLevel,
  leanFraction,
  FIXED_STEP,
} from '../src/balance.js';

let failures = 0;
let assertions = 0;
const results = [];

function check(name, fn) {
  const before = failures;
  try {
    fn();
  } catch (err) {
    failures++;
    console.log(`   ✗ threw: ${err.message}`);
  }
  const passed = failures === before;
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}\n`);
}

function ok(cond, msg) {
  assertions++;
  if (!cond) { failures++; console.log(`   ✗ ${msg}`); }
  return cond;
}
const eq = (a, b, msg) => ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const close = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (expected ~${b}, got ${a})`);
const note = (m) => console.log(`   · ${m}`);

const cfg = createConfig();

// ---------------------------------------------------------------------------

check('input reduces to -1 / 0 / +1, both-held cancels', () => {
  eq(reduceInput(true, false), -1, 'left only = -1');
  eq(reduceInput(false, true), 1, 'right only = +1');
  eq(reduceInput(false, false), 0, 'neither = 0');
  eq(reduceInput(true, true), 0, 'both = 0');
});

check('tick is pure — it never mutates the state it was given', () => {
  const before = createState({ config: cfg });
  const snapshot = JSON.stringify(before);
  const after = tick(setInput(before, 1), cfg, FIXED_STEP);
  eq(JSON.stringify(before), snapshot, 'input state untouched');
  ok(after !== before, 'a new object is returned');
  ok(after.lean !== before.lean, 'the new state actually advanced');
});

check('state and config are plain serializable data', () => {
  let s = createState({ config: cfg });
  s = advance(s, cfg, 2);
  const round = JSON.parse(JSON.stringify(s));
  eq(JSON.stringify(round), JSON.stringify(s), 'state survives a JSON round-trip');
  for (const [k, v] of Object.entries(s)) {
    ok(['number', 'boolean', 'object'].includes(typeof v), `state.${k} is a primitive (${typeof v})`);
  }
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    eq(typeof v, 'number', `config.${k} is a number`);
  }
  // A deserialized state keeps simulating identically.
  const a = advance(s, cfg, 1);
  const b = advance(round, cfg, 1);
  eq(JSON.stringify(a), JSON.stringify(b), 'resumed state matches');
});

check('simulation is deterministic for identical inputs', () => {
  const run = () => {
    let s = createState({ config: cfg, startingLeanSign: 1 });
    for (let i = 0; i < 600; i++) s = tick(setInput(s, i % 40 < 20 ? -1 : 0), cfg, FIXED_STEP);
    return s;
  };
  eq(JSON.stringify(run()), JSON.stringify(run()), 'two identical runs produce identical state');
});

check('a run starting exactly centred with no velocity never moves (why initialLean exists)', () => {
  const dead = createState({ config: cfg, initialLean: 0 });
  eq(dead.lean, 0, 'starts at exactly 0');
  const after = advance(dead, cfg, 60);
  eq(after.lean, 0, 'still 0 after a simulated minute of no input');
  eq(after.isFallen, false, 'never falls');
  note('gravityForce = coefficient x lean, so it is exactly 0 at centre — hence the opening nudge');

  const nudged = createState({ config: cfg });
  ok(Math.abs(nudged.lean) > 0, `default start is off-centre (${nudged.lean})`);
  ok(advance(nudged, cfg, 60).isFallen, 'a nudged run with no input does fall');
});

check('gravity pulls away from centre and grows with lean', () => {
  const near = advance(createState({ config: cfg, initialLean: 0.05 }), cfg, 1);
  const far = advance(createState({ config: cfg, initialLean: 0.4 }), cfg, 1);
  ok(near.lean > 0.05, 'a small positive lean grows');
  ok(far.lean > 0.4, 'a large positive lean grows too');
  ok(far.lean - 0.4 > near.lean - 0.05, 'the further off-centre, the faster it runs away');

  const mirrored = advance(createState({ config: cfg, initialLean: 0.05, startingLeanSign: -1 }), cfg, 1);
  close(mirrored.lean, -near.lean, 1e-12, 'the physics is symmetric about centre');
});

check('difficulty ramps at gravityRampRate ^ elapsed, identically drunk or sober', () => {
  const sober = createState({ config: cfg });
  const drunk = createState({ config: cfg, isDrunk: true });
  eq(sober.gravityCoefficient, cfg.baseGravityStart, 'sober starts at baseGravityStart');
  eq(drunk.gravityCoefficient, cfg.drunkGravityStart, 'drunk starts at drunkGravityStart');

  // Isolate the ramp: a run pinned at exactly lean 0 never moves and never falls, so the
  // coefficient can be compared against start x rate^t with no falling-tick edge case.
  const t = 10;
  const s10 = advance(createState({ config: cfg, initialLean: 0 }), cfg, t);
  const d10 = advance(createState({ config: cfg, initialLean: 0, isDrunk: true }), cfg, t);
  ok(!s10.isFallen && !d10.isFallen, 'both reference runs survived the full window');
  close(s10.elapsedTime, t, 1e-9, 'elapsed matches the window');
  const expectedSober = cfg.baseGravityStart * Math.pow(cfg.gravityRampRate, s10.elapsedTime);
  close(s10.gravityCoefficient, expectedSober, 1e-6, 'sober coefficient follows start x rate^t');

  // Same curve shape: the ratio between drunk and sober is constant over time.
  const ratio0 = cfg.drunkGravityStart / cfg.baseGravityStart;
  close(d10.gravityCoefficient / s10.gravityCoefficient, ratio0, 1e-6,
    'drunk stays a fixed multiple of sober — harder start, not a steeper curve');
  note(`drunk/sober ratio held at ${ratio0.toFixed(4)} across ${t}s`);
});

check('holding a direction pushes back against the lean', () => {
  const start = createState({ config: cfg, initialLean: 0.3 });
  const drifting = advance(start, cfg, 1);
  const corrected = advance(setInput(start, -1), cfg, 1);
  ok(corrected.lean < drifting.lean, 'holding left slows or reverses a rightward lean');
  note(`no input: ${drifting.lean.toFixed(3)}   holding left: ${corrected.lean.toFixed(3)}`);
});

check('overcorrection is emergent — no special case needed', () => {
  // Hold left far too long from a small rightward lean: cross centre, then get pulled left.
  let s = setInput(createState({ config: cfg, initialLean: 0.05 }), -1);
  let crossed = false;
  let leanAtCross = null;
  for (let i = 0; i < 1200 && !s.isFallen; i++) {
    const prev = s.lean;
    s = tick(s, cfg, FIXED_STEP);
    if (!crossed && prev > 0 && s.lean <= 0) { crossed = true; leanAtCross = s.lean; }
  }
  ok(crossed, 'held correction drove the lean through centre');
  // Now release: gravity should keep pulling it further negative, not recentre it.
  const released = advance(setInput({ ...s, lean: -0.2, leanVelocity: 0, isFallen: false }, 0), cfg, 1);
  ok(released.lean < -0.2, 'past centre, the same term now pulls the other way');
  note(`crossed centre at lean ${leanAtCross.toFixed(4)}; released at -0.2 drifted to ${released.lean.toFixed(3)}`);
});

check('the run ends at |lean| >= fallThreshold, and the falling tick is not scored', () => {
  let s = createState({ config: cfg, initialLean: 0.9 });
  let prev = s;
  let steps = 0;
  while (!s.isFallen && steps++ < 100000) { prev = s; s = tick(s, cfg, FIXED_STEP); }

  ok(s.isFallen, 'the run ended');
  close(Math.abs(s.lean), cfg.fallThreshold, 1e-9, 'lean clamped to the threshold for readout');
  eq(s.finalScore, prev.elapsedTime, 'score is the time before the falling tick — that tick is not credited');
  eq(s.elapsedTime, prev.elapsedTime, 'elapsedTime did not advance on the falling tick');

  const frozen = tick(s, cfg, FIXED_STEP);
  eq(frozen, s, 'ticking a fallen state is a no-op');
  note(`fell after ${s.finalScore.toFixed(2)}s from a 0.9 starting lean with no input`);
});

check('a lower fallThreshold ends the run sooner', () => {
  const tight = createConfig({ fallThreshold: 0.5 });
  const wide = createConfig({ fallThreshold: 1.0 });
  const a = advance(createState({ config: tight }), tight, 300);
  const b = advance(createState({ config: wide }), wide, 300);
  ok(a.isFallen && b.isFallen, 'both runs ended');
  ok(a.finalScore < b.finalScore, `tighter threshold falls sooner (${a.finalScore.toFixed(2)}s vs ${b.finalScore.toFixed(2)}s)`);
});

check('a steeper ramp ends the run sooner; correction strength arrests a lean harder', () => {
  const noInputRun = (overrides) => {
    const c = createConfig(overrides);
    return advance(createState({ config: c }), c, 600).finalScore;
  };
  const slow = noInputRun({ gravityRampRate: 1.02 });
  const fast = noInputRun({ gravityRampRate: 1.35 });
  ok(fast < slow, `steeper ramp falls sooner (${fast.toFixed(2)}s vs ${slow.toFixed(2)}s)`);

  // Stronger correction arrests a lean harder. Deliberately measured over a short window,
  // not as time-to-fall: holding a direction indefinitely is a losing move at any strength,
  // and a *stronger* hold overcorrects off the opposite edge sooner, per the check above.
  const afterHolding = (correctionStrength, seconds) => {
    const c = createConfig({ correctionStrength });
    return advance(setInput(createState({ config: c, initialLean: 0.3 }), -1), c, seconds);
  };
  const weak = afterHolding(1, 0.5);
  const strong = afterHolding(4, 0.5);
  ok(strong.lean < weak.lean, 'stronger correction pulls the lean back further in the same time');
  ok(strong.leanVelocity < weak.leanVelocity, 'and builds more leftward velocity');
  note(`0.5s holding left from +0.3 — correction 1: ${weak.lean.toFixed(3)}, correction 4: ${strong.lean.toFixed(3)}`);

  // The flip side, stated as its own expectation: a permanent hold kills you faster when
  // it is stronger, because you cross centre sooner and gravity takes the other side.
  const holdToDeath = (correctionStrength) => {
    const c = createConfig({ correctionStrength });
    let s = setInput(createState({ config: c, initialLean: 0.3 }), -1);
    let steps = 0;
    while (!s.isFallen && steps++ < 120000) s = tick(s, c, FIXED_STEP);
    return s.finalScore;
  };
  const [d1, d4] = [holdToDeath(1), holdToDeath(4)];
  ok(d4 < d1, `never releasing dies sooner at higher strength (${d4.toFixed(2)}s vs ${d1.toFixed(2)}s)`);
  note('overcorrection is punished, not rewarded — holding is not a strategy');
});

check('render helpers stay in range', () => {
  const s = createState({ config: cfg });
  close(leanFraction({ ...s, lean: 0 }, cfg), 0.5, 1e-12, 'centre maps to 0.5');
  close(leanFraction({ ...s, lean: -1 }, cfg), 0, 1e-12, 'left edge maps to 0');
  close(leanFraction({ ...s, lean: 1 }, cfg), 1, 1e-12, 'right edge maps to 1');
  close(leanFraction({ ...s, lean: 5 }, cfg), 1, 1e-12, 'beyond the edge clamps');
  eq(dangerLevel({ ...s, lean: 0 }, cfg), 0, 'no danger at centre');
  eq(dangerLevel({ ...s, lean: -1 }, cfg), 1, 'full danger at the threshold');
  eq(dangerLevel({ ...s, lean: 9 }, cfg), 1, 'danger clamps at 1');
});

check('fixed stepping makes the result frame-rate independent', () => {
  // Same wall-clock duration, delivered in different sized chunks.
  const c = cfg;
  const base = createState({ config: c, startingLeanSign: 1 });
  const smooth = advance(base, c, 3, FIXED_STEP);
  let chunky = base;
  for (let i = 0; i < 3; i++) chunky = advance(chunky, c, 1, FIXED_STEP);
  close(chunky.lean, smooth.lean, 1e-9, 'lean matches whether advanced in 1s or 3s calls');
  close(chunky.elapsedTime, smooth.elapsedTime, 1e-9, 'elapsed matches');
});

// ---------------------------------------------------------------------------

console.log('='.repeat(60));
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log('='.repeat(60));
console.log(`${results.filter((r) => r.passed).length}/${results.length} checks passed, ${assertions} assertions, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
