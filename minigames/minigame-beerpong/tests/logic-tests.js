// State-level verification of the rules layer. Run: node tests/logic-tests.js
//
// Every check maps to a section of minigame-beerpong.md. The meter is covered here too —
// it is pure logic, and it has no other home.

import {
  createConfig,
  createGame,
  assignTeams,
  applyThrow,
  advanceAfterThrow,
  beginPower,
  startTurn,
  checkRerack,
  checkGameOver,
  candidateCups,
  remainingCups,
  defendingTeam,
  getTeam,
  getPlayer,
  rackPositions,
  rackExtent,
  suddenDeathPosition,
  perturbAim,
  aimToX,
  powerToY,
  xToAim,
  yToPower,
  throwerFor,
  turnLabel,
  suddenDeathLabel,
  resultLabel,
  FULL_RACK_ROWS,
} from '../src/beerpong.js';

import {
  createMeter,
  tickMeter,
  lockMeter,
  advanceMeter,
  METER_FIXED_STEP,
} from '../src/meter.js';

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------

const results = [];
let failures = 0;
let assertions = 0;

function check(name, fn) {
  const before = failures;
  try {
    fn();
  } catch (err) {
    failures++;
    console.log(`   ✗ threw: ${err.message}`);
    if (process.env.BP_STACK) console.log(err.stack);
  }
  const passed = failures === before;
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}\n`);
}

function ok(cond, msg) {
  assertions++;
  if (!cond) {
    failures++;
    console.log(`   ✗ ${msg}`);
  }
  return cond;
}

function eq(actual, expected, msg) {
  return ok(
    actual === expected,
    `${msg}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`
  );
}

const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (|${a} - ${b}| > ${tol})`);
const note = (m) => console.log(`   · ${m}`);

// ---------------------------------------------------------------------------
// helpers — drive throws without a meter
// ---------------------------------------------------------------------------

/**
 * One throw. `mode` is 'hit' (aim dead centre of the first remaining cup) or 'miss' (lock
 * both meters near zero, which lands well outside the rack).
 */
function throwBall(state, mode, config, cupPicker) {
  const cups = candidateCups(state);
  const cup = cupPicker ? cupPicker(cups) : cups[0];
  const aim = mode === 'hit' && cup ? xToAim(cup.x, config) : 0.02;
  const power = mode === 'hit' && cup ? yToPower(cup.y, config) : 0.02;
  const { newState, throwResult } = applyThrow(beginPower(state), aim, power, config);
  return { state: advanceAfterThrow(newState), throwResult };
}

/** A whole turn from a plan like ['hit', 'miss']. Returns the state after it resolves. */
function runTurn(state, plan, config) {
  let s = state;
  const thrown = [];
  for (const mode of plan) {
    const r = throwBall(s, mode, config);
    thrown.push(r.throwResult);
    s = r.state;
  }
  return { state: s, thrown };
}

const config = createConfig();

console.log(`${'='.repeat(64)}\nBeer Pong — rules layer\n${'='.repeat(64)}\n`);

// ---------------------------------------------------------------------------
// SECTION 3 — setup and team format
// ---------------------------------------------------------------------------

check('CHECK 1 (S3) — team format follows player count and standings', () => {
  const players = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i + 1}`,
      name: `P${i + 1}`,
      standingPoints: 10 - i, // p1 is 1st, p2 2nd, ...
    }));

  const two = assignTeams(players(2));
  eq(two.format, '1v1', '2 players is 1v1');
  eq(two.sides.map((s) => s.join('+')).join(' vs '), 'p1 vs p2', 'the two players are split');

  // 1st plays solo against 2nd + 3rd.
  const three = assignTeams(players(3));
  eq(three.format, '1v2', '3 players is 1v2');
  eq(three.sides[0].join('+'), 'p1', '1st place is the solo side');
  eq(three.sides[1].join('+'), 'p2+p3', '2nd and 3rd are paired against them');

  // 1st + 4th vs 2nd + 3rd.
  const four = assignTeams(players(4));
  eq(four.format, '2v2', '4 players is 2v2');
  eq(four.sides[0].join('+'), 'p1+p4', '1st is paired with 4th');
  eq(four.sides[1].join('+'), 'p2+p3', '2nd is paired with 3rd');

  // Standings ties break on drunkenness — the drunker player ranks higher.
  const tied = assignTeams([
    { id: 'sober', standingPoints: 5, drunkenness: 0.1 },
    { id: 'drunk', standingPoints: 5, drunkenness: 0.9 },
    { id: 'last', standingPoints: 1, drunkenness: 0.5 },
  ]);
  eq(tied.ranked[0], 'drunk', 'the drunker of two tied players ranks higher');
  eq(tied.sides[0].join('+'), 'drunk', 'and therefore takes the solo seat');

  // No standings at all — first game of a session — is a straight shuffle.
  const blank = Array.from({ length: 4 }, (_, i) => ({ id: `q${i + 1}` }));
  const seen = new Set();
  for (let seed = 0; seed < 40; seed++) {
    let a = seed;
    const rng = () => {
      a = (a * 1103515245 + 12345) % 2 ** 31;
      return a / 2 ** 31;
    };
    seen.add(assignTeams(blank, { rng }).sides[0].slice().sort().join('+'));
  }
  ok(seen.size > 1, `with no standings the pairing varies (${seen.size} distinct pairings seen)`);

  let threw = false;
  try { assignTeams(players(5)); } catch { threw = true; }
  ok(threw, '5 players is refused');
});

// ---------------------------------------------------------------------------
// SECTION 4 — rack geometry and re-rack
// ---------------------------------------------------------------------------

check('CHECK 2 (S4) — the rack is a centred 1-2-3-4 triangle', () => {
  const slots = rackPositions(FULL_RACK_ROWS);
  eq(slots.length, 10, 'a full rack is 10 cups');
  eq(slots.filter((s) => s.row === 0).length, 1, 'row 0 is the front tip, 1 cup');
  eq(slots.filter((s) => s.row === 3).length, 4, 'row 3 is the back row, 4 cups');

  for (const row of [0, 1, 2, 3]) {
    const xs = slots.filter((s) => s.row === row).map((s) => s.x);
    near(xs.reduce((a, b) => a + b, 0), 0, 1e-9, `row ${row} is centred on x=0`);
  }
  const ext = rackExtent();
  near(ext.minX, -1.5, 1e-9, 'the back row reaches x=-1.5');
  near(ext.maxX, 1.5, 1e-9, 'and x=+1.5');
  eq(suddenDeathPosition().x, 0, 'the sudden-death cup is centred');
  near(suddenDeathPosition().y, ext.maxY, 1e-9, 'and sits at the back of a full rack');
  note(`rack spans x ${ext.minX}..${ext.maxX}, y ${ext.minY.toFixed(2)}..${ext.maxY.toFixed(2)}`);
});

check('CHECK 3 (S4) — re-rack fires at 6 and 3, once each', () => {
  const team = { cupRack: [], appliedThresholds: [] };
  const withCups = (n) => ({
    cupRack: rackPositions(FULL_RACK_ROWS).map((s, i) => ({ ...s, id: `c${i}`, isSunk: i >= n })),
    appliedThresholds: [],
  });

  eq(checkRerack(withCups(10)), null, '10 cups needs no re-rack');
  eq(checkRerack(withCups(7)), null, '7 cups needs no re-rack');
  eq(checkRerack(withCups(6)).label, '1-2-3', '6 cups re-racks to 1-2-3');
  // The count can skip a threshold inside one turn; <= is what catches that.
  eq(checkRerack(withCups(5)).label, '1-2-3', '5 cups still owes the 6-cup re-rack');
  eq(checkRerack(withCups(3)).label, '1-2-3', 'the 6-step is owed before the 3-step');
  eq(checkRerack({ ...withCups(3), appliedThresholds: [6] }).label, '1-2',
    'once 6 is applied, 3 cups re-racks to 1-2');
  eq(checkRerack({ ...withCups(2), appliedThresholds: [6, 3] }), null,
    'below 3 cups there is nothing left to do');
  eq(checkRerack({ ...withCups(6), appliedThresholds: [6] }), null, 'a threshold fires once only');
  void team;
});

check('CHECK 4 (S4) — a re-rack is deferred to the next turn start, bonus turns included', () => {
  // t1 sinks two cups a turn and keeps the balls, so every re-rack check happens at the
  // start of a bonus turn — the case the spec calls out explicitly.
  let s = createGame({ playerCount: 2, seed: 5 });
  const defenderId = defendingTeam(s).id;
  const remaining = () => remainingCups(getTeam(s, defenderId)).length;
  const backRowY = () => Math.max(...remainingCups(getTeam(s, defenderId)).map((c) => c.y));

  eq(remaining(), 10, 'defender starts with 10 cups');

  // 10 -> 8, still above the threshold.
  s = runTurn(s, ['hit', 'hit'], config).state;
  eq(remaining(), 8, 'two cups down');
  eq(s.activeTeamId, defendingTeam({ ...s, activeTeamId: defenderId }).id,
    'sinking both kept the balls with the same side');
  eq(s.lastRerack, null, 'no re-rack at 8 cups');

  // 8 -> 6. The crossing happens mid-turn; the re-rack lands at the next turn start.
  s = runTurn(s, ['hit', 'hit'], config).state;
  eq(remaining(), 6, 'six cups left');
  ok(s.lastRerack !== null, 're-rack ran at the start of the bonus turn');
  eq(s.lastRerack.label, '1-2-3', 'and re-formed the rack as 1-2-3');

  const ys = remainingCups(getTeam(s, defenderId)).map((c) => c.y);
  eq(new Set(ys.map((y) => y.toFixed(3))).size, 3, 'the six cups now sit in three rows');
  near(backRowY(), rackExtent([1, 2, 3]).maxY, 1e-9, 'the rack is a 3-row triangle');

  // 6 -> 4 -> and the 3-step is owed at 3 or fewer.
  s = runTurn(s, ['hit', 'hit'], config).state;
  eq(remaining(), 4, 'four cups left');
  eq(s.lastRerack, null, 'no second re-rack yet at 4 cups');
  s = runTurn(s, ['hit', 'hit'], config).state;
  eq(remaining(), 2, 'two cups left');
  ok(s.lastRerack !== null && s.lastRerack.label === '1-2',
    'the 3-step re-rack fired at the next turn start, having been skipped from 4 to 2');
  note(`re-rack log: ${s.log.filter((l) => l.startsWith('Rack reset')).join(' | ')}`);
});

// ---------------------------------------------------------------------------
// SECTION 5 — turn flow
// ---------------------------------------------------------------------------

check('CHECK 5 (S5) — two throws a turn; sink both to keep the balls', () => {
  let s = createGame({ playerCount: 2, seed: 9 });
  const firstTeam = s.activeTeamId;

  // Miss, miss -> possession passes.
  s = runTurn(s, ['miss', 'miss'], config).state;
  eq(s.lastTurn.sinks, 0, 'no sinks that turn');
  eq(s.lastTurn.bonus, false, 'no bonus');
  ok(s.activeTeamId !== firstTeam, 'possession passed to the other side');

  // Hit, miss -> still passes.
  const second = s.activeTeamId;
  s = runTurn(s, ['hit', 'miss'], config).state;
  eq(s.lastTurn.sinks, 1, 'one sink is not enough');
  ok(s.activeTeamId !== second, 'possession passed again');

  // Hit, hit -> same side throws again.
  const third = s.activeTeamId;
  s = runTurn(s, ['hit', 'hit'], config).state;
  eq(s.lastTurn.sinks, 2, 'both balls sank');
  eq(s.lastTurn.bonus, true, 'which is a bonus turn');
  eq(s.activeTeamId, third, 'the same side keeps the balls');
  eq(s.throwsThisTurn, 0, 'and the new turn starts with two fresh throws');
});

check('CHECK 6 (S5) — solo sides throw both balls, paired sides alternate and swap lead', () => {
  // 1v1: the same player throws both.
  let solo = createGame({ playerCount: 2, seed: 3 });
  eq(throwerFor(solo, 0), throwerFor(solo, 1), 'a solo side throws both balls itself');

  // 2v2: the pair alternates within a turn.
  const four = Array.from({ length: 4 }, (_, i) => ({
    id: `p${i + 1}`, name: `P${i + 1}`, standingPoints: 10 - i,
  }));
  let s = createGame({ players: four, seed: 3 });
  eq(s.matchFormat, '2v2', 'four players is 2v2');
  const team = getTeam(s, s.activeTeamId);
  eq(team.playerIds.length, 2, 'the active side is a pair');
  ok(throwerFor(s, 0) !== throwerFor(s, 1), 'the two players alternate within the turn');

  // And who leads off swaps the next time that side throws.
  const leadOffs = [];
  for (let i = 0; i < 6; i++) {
    leadOffs.push({ team: s.activeTeamId, lead: s.currentThrowerId });
    s = runTurn(s, ['miss', 'miss'], config).state;
  }
  for (const teamId of new Set(leadOffs.map((l) => l.team))) {
    const mine = leadOffs.filter((l) => l.team === teamId).map((l) => l.lead);
    ok(new Set(mine).size === 2, `${teamId} alternates its lead-off thrower (${mine.join(' -> ')})`);
    ok(mine[0] !== mine[1], `${teamId} does not lead off with the same player twice running`);
  }
  note(`lead-off order: ${leadOffs.map((l) => `${l.team}:${l.lead}`).join(' ')}`);
});

// ---------------------------------------------------------------------------
// SECTION 6 — throw resolution
// ---------------------------------------------------------------------------

check('CHECK 7 (S6) — aim and power map onto the rack, and tolerance decides the hit', () => {
  const s = createGame({ playerCount: 2, seed: 21 });
  const cups = remainingCups(defendingTeam(s));

  // Every cup is reachable: aiming dead centre of it sinks exactly it.
  for (const cup of cups) {
    const r = applyThrow(beginPower(s), xToAim(cup.x, config), yToPower(cup.y, config), config);
    eq(r.throwResult.hitCupId, cup.id, `aiming at ${cup.id} sinks ${cup.id}`);
    near(r.throwResult.distance, 0, 1e-9, `and lands dead centre of it`);
  }

  // The mapping round-trips.
  near(aimToX(xToAim(1.25, config), config), 1.25, 1e-9, 'aim mapping round-trips');
  near(powerToY(yToPower(2.0, config), config), 2.0, 1e-9, 'power mapping round-trips');

  // Just outside the tolerance radius is a miss.
  const tip = cups.find((c) => c.row === 0);
  const justOut = applyThrow(
    beginPower(s),
    xToAim(tip.x + config.toleranceRadius + 0.02, config),
    yToPower(tip.y, config),
    config
  );
  eq(justOut.throwResult.hitCupId, null, 'a throw just outside the tolerance radius misses');

  // Wide tolerance: two cups qualify, the nearer one takes the ball.
  const wide = createConfig({ toleranceRadius: 0.65 });
  const rowOne = cups.filter((c) => c.row === 1).sort((a, b) => a.x - b.x);
  const between = applyThrow(beginPower(s), xToAim(0.1, wide), yToPower(rowOne[0].y, wide), wide);
  eq(between.throwResult.hitCupId, rowOne[1].id,
    'with overlapping tolerances the nearest cup is the one sunk');
});

check('CHECK 8 (S6) — drunkenness perturbs aim only, and not at all when sober', () => {
  const rng = () => 0.99; // near the top of the -1..1 range
  eq(perturbAim(0.5, 0, rng, config), 0.5, 'at drunkenness 0 the aim is untouched');

  const drunk = perturbAim(0.5, 1, rng, config);
  ok(drunk !== 0.5, 'at drunkenness 1 the aim is offset');
  ok(Math.abs(drunk - 0.5) <= config.maxAimOffset + 1e-9,
    `the offset stays within maxAimOffset (${Math.abs(drunk - 0.5).toFixed(4)})`);

  const half = Math.abs(perturbAim(0.5, 0.5, rng, config) - 0.5);
  const full = Math.abs(perturbAim(0.5, 1, rng, config) - 0.5);
  near(half * 2, full, 1e-9, 'the offset scales linearly with drunkenness');

  // Power is untouched at any drunkenness — the whole point of "AIM only".
  const sober = createGame({ playerCount: 2, seed: 4, players: [{ drunkenness: 0 }, { drunkenness: 0 }] });
  const sloshed = createGame({ playerCount: 2, seed: 4, players: [{ drunkenness: 1 }, { drunkenness: 1 }] });
  const power = 0.63;
  const a = applyThrow(beginPower(sober), 0.5, power, config).throwResult;
  const b = applyThrow(beginPower(sloshed), 0.5, power, config).throwResult;
  near(a.target.y, b.target.y, 1e-9, 'the landing depth is identical drunk or sober');
  ok(a.target.x !== b.target.x, 'while the landing x is not');
  eq(a.lockedAim, b.lockedAim, 'both locked the same aim value');
  note(`sober x ${a.target.x.toFixed(3)} vs drunk x ${b.target.x.toFixed(3)} at the same lock`);

  // A drunk player still lands somewhere sane, and the same seed replays identically.
  const replay = applyThrow(beginPower(sloshed), 0.5, power, config).throwResult;
  eq(replay.target.x, b.target.x, 'the same state and lock replays to the same landing');
});

// ---------------------------------------------------------------------------
// SECTION 7 — sudden death
// ---------------------------------------------------------------------------

check('CHECK 9 (S7) — clearing a rack starts sudden death instead of ending the match', () => {
  let s = createGame({ playerCount: 2, seed: 31 });
  const shooter = s.activeTeamId;
  const defenderId = defendingTeam(s).id;

  // Clear all ten cups. Perfect shooting keeps the balls, so this is one long turn chain.
  let guard = 0;
  while (remainingCups(getTeam(s, defenderId)).length > 0 && guard++ < 40) {
    s = throwBall(s, 'hit', config).state;
  }
  eq(remainingCups(getTeam(s, defenderId)).length, 0, 'the rack is empty');
  ok(!checkGameOver(s), 'the match did not end when the rack cleared');
  eq(s.suddenDeathActive, true, 'sudden death is on');
  eq(s.suddenDeathCurrentStreak, 0, 'the clearing shot does not count toward the streak');
  eq(s.suddenDeathTargetStreak, null, 'no target has been set yet');
  eq(candidateCups(s).length, 1, 'there is exactly one cup to shoot at now');
  eq(s.activeTeamId, shooter, 'the clearing side is still shooting');
  note(suddenDeathLabel(s));
});

check('CHECK 10 (S7) — the sudden-death cup respawns and the streak counts hits', () => {
  let s = suddenDeathState(41);
  const shooter = s.activeTeamId;

  s = throwBall(s, 'hit', config).state;
  eq(s.suddenDeathCurrentStreak, 1, 'a hit adds one to the streak');
  eq(candidateCups(s).length, 1, 'and the cup is immediately back');
  s = throwBall(s, 'hit', config).state;
  eq(s.suddenDeathCurrentStreak, 2, 'a second hit continues the streak');
  eq(s.activeTeamId, shooter, 'sinking both balls kept the balls, as in a normal turn');
  eq(s.throwsThisTurn, 0, 'and opened a fresh turn');

  // Streaks survive across bonus turns, and reset when possession changes.
  s = throwBall(s, 'hit', config).state;
  eq(s.suddenDeathCurrentStreak, 3, 'the streak carries across the bonus turn boundary');
  s = throwBall(s, 'miss', config).state;
  eq(s.activeTeamId === shooter, false, 'a miss ended the turn and passed possession');
  eq(s.suddenDeathTargetStreak, 3, "the ended turn's streak became the target");
  eq(s.suddenDeathCurrentStreak, 0, 'and the incoming side starts from zero');
});

check('CHECK 11 (S7) — matching the target raises it; falling short loses', () => {
  let s = suddenDeathState(53);
  const first = s.activeTeamId;

  // First side ends a turn on a streak of 3 — that only sets the bar.
  s = suddenDeathTurn(s, 3);
  eq(s.suddenDeathTargetStreak, 3, 'the first side set the target at 3');
  eq(s.suddenDeathTargetTeamId, first, 'and holds it');
  ok(!checkGameOver(s), 'setting a target does not win the match');

  // Second side matches it exactly — still not a win, the bar just moves.
  const second = s.activeTeamId;
  s = suddenDeathTurn(s, 3);
  ok(!checkGameOver(s), 'matching the target does not win the match either');
  eq(s.suddenDeathTargetStreak, 3, 'the matched streak becomes the standing target');
  eq(s.suddenDeathTargetTeamId, second, 'now held by the side that matched it');
  eq(s.activeTeamId, first, 'and it is back to the other side to answer');

  // First side falls short — the target holder wins.
  s = suddenDeathTurn(s, 1);
  eq(checkGameOver(s), true, 'falling short ends the match immediately');
  eq(s.winnerTeamId, second, 'the side holding the target wins');
  eq(s.loserTeamId, first, 'the side that fell short loses');
  eq(s.finalStreaks.shooter, 1, 'the losing streak is recorded');
  eq(s.finalStreaks.target, 3, 'against the target it missed');
  ok(s.winnerTeamId !== s.loserTeamId, 'there is no tie — someone always wins');
  note(resultLabel(s));
});

check('CHECK 12 (S7) — a beaten target is replaced by the higher streak', () => {
  let s = suddenDeathState(67);
  const first = s.activeTeamId;
  s = suddenDeathTurn(s, 1);
  eq(s.suddenDeathTargetStreak, 1, 'target set at 1');

  const second = s.activeTeamId;
  s = suddenDeathTurn(s, 4);
  eq(s.suddenDeathTargetStreak, 4, 'beating the target raises it to the higher streak');
  eq(s.suddenDeathTargetTeamId, second, 'and hands it to the side that beat it');
  eq(s.activeTeamId, first, 'possession returns to the other side');
  ok(!checkGameOver(s), 'beating a target still does not end the match');
});

// ---------------------------------------------------------------------------
// meter (Template A)
// ---------------------------------------------------------------------------

check('CHECK 13 (S10) — the timing meter sweeps, bounces and locks', () => {
  let m = createMeter({ speed: 1, startPosition: 0, startDirection: 1 });
  eq(m.position, 0, 'starts at 0');
  eq(m.value, null, 'no value before it is locked');

  m = advanceMeter(m, 0.5);
  near(m.position, 0.5, 1e-6, 'half a sweep in half a second at speed 1');
  eq(m.direction, 1, 'still travelling toward 1');

  m = advanceMeter(m, 0.75);
  near(m.position, 0.75, 1e-6, 'bounced off the far end');
  eq(m.direction, -1, 'and is heading back');

  const locked = lockMeter(m);
  eq(locked.isLocked, true, 'locks');
  near(locked.value, locked.position, 1e-9, 'and the value is where the marker stopped');
  eq(lockMeter(locked).value, locked.value, 're-locking changes nothing');
  eq(advanceMeter(locked, 5).position, locked.position, 'a locked meter does not move');

  // Every position stays in range, however coarse the step.
  for (const dt of [1 / 240, 1 / 60, 0.25, 1.7, 9]) {
    let probe = createMeter({ speed: 1.7 });
    for (let i = 0; i < 50; i++) {
      probe = tickMeter(probe, dt);
      if (!(probe.position >= 0 && probe.position <= 1)) break;
    }
    ok(probe.position >= 0 && probe.position <= 1, `stays in 0..1 at dt=${dt}`);
  }

  // A single big step lands where many small ones would — no drift, no parking on an end.
  const coarse = advanceMeter(createMeter({ speed: 1.3 }), 3.7, 3.7);
  let fine = createMeter({ speed: 1.3 });
  for (let i = 0; i < Math.round(3.7 / METER_FIXED_STEP); i++) fine = tickMeter(fine, METER_FIXED_STEP);
  near(coarse.position, fine.position, 1e-6, 'one coarse step matches many fine ones');
});

// ---------------------------------------------------------------------------
// EXTRA — the port contract
// ---------------------------------------------------------------------------

check('EXTRA (S10) — GameState survives a JSON round trip mid-match', () => {
  let s = createGame({ playerCount: 4, seed: 77 });
  s = runTurn(s, ['hit', 'miss'], config).state;
  s = runTurn(s, ['hit', 'hit'], config).state;

  const round = JSON.parse(JSON.stringify(s));
  eq(JSON.stringify(round), JSON.stringify(s), 'the state is plain serializable data');

  // And it keeps playing from the revived copy, identically.
  const fromLive = runTurn(s, ['hit', 'miss'], config).state;
  const fromRevived = runTurn(round, ['hit', 'miss'], config).state;
  eq(JSON.stringify(fromRevived), JSON.stringify(fromLive), 'and plays on identically');

  // Cup positions are plain numbers, which is what the Unreal port remaps.
  const cups = s.teams.flatMap((t) => t.cupRack);
  ok(cups.every((c) => typeof c.x === 'number' && typeof c.y === 'number'),
    'every cup carries plain numeric coordinates');
  ok(cups.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y)), 'all finite');
  note(`${cups.length} cups across both racks, all plain {x, y}`);
});

check('EXTRA — a full match reaches a winner from any seed', () => {
  const lengths = [];
  for (let seed = 1; seed <= 25; seed++) {
    const rng = mulberry(seed * 7919 + 13);
    let s = createGame({ playerCount: 2, seed });
    let throws = 0;
    while (!checkGameOver(s) && throws < 5000) {
      // Roughly a two-in-three shooter, so turns actually end.
      s = throwBall(s, rng() < 0.66 ? 'hit' : 'miss', config).state;
      throws++;
    }
    ok(checkGameOver(s), `seed ${seed} reached a result in ${throws} throws`);
    ok(s.winnerTeamId !== null && s.loserTeamId !== s.winnerTeamId, `seed ${seed} produced one winner`);
    ok(s.suddenDeathActive, `seed ${seed} went through sudden death, as every match must`);
    lengths.push(throws);
  }
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  note(`25 matches, ${Math.min(...lengths)}-${Math.max(...lengths)} throws (mean ${avg.toFixed(0)})`);
});

// ---------------------------------------------------------------------------

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shoot `hits` makes, then miss until the turn actually ends. A turn is two throws, so
 * one miss only ends it on the second ball — driving by "possession changed" instead of
 * by throw count keeps these checks independent of where in a turn sudden death began.
 */
function suddenDeathTurn(state, hits) {
  let s = state;
  const shooter = s.activeTeamId;
  for (let i = 0; i < hits; i++) s = throwBall(s, 'hit', config).state;
  let guard = 0;
  while (s.activeTeamId === shooter && !checkGameOver(s) && guard++ < 10) {
    s = throwBall(s, 'miss', config).state;
  }
  return s;
}

/** A game wound forward to the moment sudden death begins, with the clearer still up. */
function suddenDeathState(seed) {
  let s = createGame({ playerCount: 2, seed });
  const defenderId = defendingTeam(s).id;
  let guard = 0;
  while (remainingCups(getTeam(s, defenderId)).length > 0 && guard++ < 40) {
    s = throwBall(s, 'hit', config).state;
  }
  if (!s.suddenDeathActive) throw new Error('failed to reach sudden death');
  return s;
}

console.log('='.repeat(64));
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log('='.repeat(64));
console.log(
  `${results.filter((r) => r.passed).length}/${results.length} checks passed, ` +
  `${assertions} assertions, ${failures} failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
