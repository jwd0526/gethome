// Beer Pong — rules/state layer.
//
// Pure logic. No DOM, no timers, no rendering. Everything in GameState is JSON-shaped
// (strings, numbers, booleans, arrays, plain objects) so the whole state survives
// JSON.stringify/parse and maps ~1:1 onto a C++ struct later.
//
// Cup positions are plain {x, y} in a rack-local space (Section 10): the Unreal port
// remaps the coordinate space, it does not redesign the data.
//
// Contract that survives the port:
//   applyThrow(state, aimValue, powerValue) -> { newState, throwResult }
//   startTurn(state)                        -> newState   (runs the re-rack check)
//   checkRerack(team)                       -> CupSlot[] | null
//
// Section references are to minigame-beerpong.md.

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Section 6 tunables. Defaults are playtest starting points, not spec constants. */
export const DEFAULT_CONFIG = {
  // Tolerance radius in rack units, where adjacent cups sit 1.0 apart. Below 0.5 a throw
  // has to land inside the cup's own footprint; above 0.5 neighbouring tolerances overlap
  // and the nearest cup wins.
  toleranceRadius: 0.42,

  // Section 6: aim offset at drunkenness 1.0, in meter units (the aim meter runs 0..1
  // across the throwing lane). 0.09 is a little under one cup-width of drift at the full
  // rack, so a sober player is never nudged and a blackout player is rarely accurate.
  maxAimOffset: 0.09,

  // How far past the rack the meters can send a ball. Without margin every throw would
  // land somewhere on the rack and misses would be impossible.
  aimMargin: 1.0,
  powerMargin: 0.9,
};

export function createConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// rack geometry
// ---------------------------------------------------------------------------

// Cups are unit-diameter and touching, so a row sits sqrt(3)/2 behind the one in front.
const ROW_GAP = Math.sqrt(3) / 2;

/** Section 4: 10 cups is rows of 1-2-3-4 front to back; re-racks are prefixes of that. */
export const FULL_RACK_ROWS = [1, 2, 3, 4];
const RERACK_STEPS = [
  { threshold: 6, rows: [1, 2, 3], label: '1-2-3' },
  { threshold: 3, rows: [1, 2], label: '1-2' },
];

/**
 * Slot positions for a triangle of `rows`, front row first. x is centred on 0 and grows
 * to the right; y grows toward the back. Row r holds r+1 cups.
 */
export function rackPositions(rows = FULL_RACK_ROWS) {
  const slots = [];
  for (const [row, count] of rows.entries()) {
    for (let col = 0; col < count; col++) {
      slots.push({
        row,
        col,
        x: col - (count - 1) / 2,
        y: row * ROW_GAP,
      });
    }
  }
  return slots;
}

/** The x/y span a full rack occupies — the fixed frame the meters map onto. */
export function rackExtent(rows = FULL_RACK_ROWS) {
  const slots = rackPositions(rows);
  return {
    minX: Math.min(...slots.map((s) => s.x)),
    maxX: Math.max(...slots.map((s) => s.x)),
    minY: Math.min(...slots.map((s) => s.y)),
    maxY: Math.max(...slots.map((s) => s.y)),
  };
}

/** Section 7: the sudden-death cup sits centred, at the back of a full rack. */
export function suddenDeathPosition() {
  const { maxY } = rackExtent();
  return { x: 0, y: maxY };
}

function buildRack(rows = FULL_RACK_ROWS) {
  return rackPositions(rows).map((slot, i) => ({
    id: `c${i + 1}`,
    row: slot.row,
    col: slot.col,
    x: slot.x,
    y: slot.y,
    isSunk: false,
  }));
}

export function remainingCups(team) {
  return team.cupRack.filter((c) => !c.isSunk);
}

/**
 * Section 4 — which layout this rack owes, or null if none is due.
 *
 * The check is `remaining <= threshold`, not `=== threshold`: a turn's two throws can take
 * a rack from 7 to 5 and skip the number entirely, and the spec's own example expects that
 * case to re-rack. `appliedThresholds` keeps each step to once per game.
 */
export function checkRerack(team) {
  const remaining = remainingCups(team).length;
  for (const step of RERACK_STEPS) {
    if (remaining <= step.threshold && !team.appliedThresholds.includes(step.threshold)) {
      return step;
    }
  }
  return null;
}

/**
 * Re-pack the surviving cups into `rows`, filling front to back, left to right. A layout
 * can hold more slots than there are cups left (5 cups into the 6-slot 1-2-3); the tail
 * slots simply go unused, which is how a real rack is re-formed.
 */
function repack(team, step) {
  const survivors = remainingCups(team);
  const slots = rackPositions(step.rows);
  const cupRack = survivors.map((cup, i) => {
    const slot = slots[i] ?? slots[slots.length - 1];
    return { ...cup, row: slot.row, col: slot.col, x: slot.x, y: slot.y };
  });
  return {
    ...team,
    cupRack,
    appliedThresholds: [...team.appliedThresholds, step.threshold],
  };
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

// Seeded PRNG (mulberry32) so a game can be reproduced exactly from its seed.
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Section 3 — seed the two sides from session standings.
 *
 * 3 players: 1st solo against 2nd + 3rd. 4 players: 1st + 4th against 2nd + 3rd. Ties on
 * standing points are broken by drunkenness (drunker ranks higher), the same tiebreak the
 * rest of the game uses. With no standings at all it is a straight shuffle — the first
 * game of a session has nothing to seed from.
 */
export function assignTeams(players, { rng = Math.random } = {}) {
  const count = players.length;
  if (count < 2 || count > 4) throw new Error('beer pong seats 2, 3 or 4 players');

  const hasStandings = players.some((p) => (p.standingPoints ?? 0) !== 0);
  const ranked = hasStandings
    ? players.slice().sort((a, b) =>
        (b.standingPoints ?? 0) - (a.standingPoints ?? 0) ||
        (b.drunkenness ?? 0) - (a.drunkenness ?? 0))
    : shuffle(players, rng);

  const ids = ranked.map((p) => p.id);
  if (count === 2) return { format: '1v1', sides: [[ids[0]], [ids[1]]], ranked: ids };
  if (count === 3) return { format: '1v2', sides: [[ids[0]], [ids[1], ids[2]]], ranked: ids };
  return { format: '2v2', sides: [[ids[0], ids[3]], [ids[1], ids[2]]], ranked: ids };
}

/**
 * Section 3 — a fresh match. `players` is [{ id, name, drunkenness, standingPoints }].
 * `seed`, and the team split itself, are injectable so tests and the tuning harness can
 * pin a match exactly.
 */
export function createGame(opts = {}) {
  const players = (opts.players ?? defaultPlayers(opts.playerCount ?? 2)).map((p, i) => ({
    id: p.id ?? `p${i + 1}`,
    name: p.name ?? `Player ${i + 1}`,
    teamId: null,
    drunkenness: clamp01(p.drunkenness ?? 0),
    standingPoints: p.standingPoints ?? 0,
  }));

  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = makeRng(seed);
  const assignment = opts.assignment ?? assignTeams(players, { rng });

  const teams = assignment.sides.map((playerIds, i) => ({
    id: `t${i + 1}`,
    playerIds,
    cupRack: buildRack(),
    appliedThresholds: [],
    // Section 5.2: who throws first alternates turn to turn, so a paired side splits
    // first-throw reps evenly across a game.
    firstThrowerIndex: 0,
  }));
  for (const team of teams) {
    for (const id of team.playerIds) {
      players.find((p) => p.id === id).teamId = team.id;
    }
  }

  const state = {
    seed,
    rngCursor: 0,
    players,
    teams,
    matchFormat: assignment.format,
    rankedPlayerIds: assignment.ranked,
    activeTeamId: teams[0].id,
    currentThrowerId: null,
    throwsThisTurn: 0,
    sinksThisTurn: 0,
    turnBonusPending: false,
    turnNumber: 0,
    suddenDeathActive: false,
    suddenDeathCup: null,
    suddenDeathCurrentStreak: 0,
    suddenDeathTargetStreak: null,
    suddenDeathTargetTeamId: null,
    phase: 'AIM',
    lastThrow: null,
    lastRerack: null,
    lastTurn: null,
    winnerTeamId: null,
    loserTeamId: null,
    finalStreaks: null,
    log: [],
  };

  return startTurn(state);
}

function defaultPlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));
}

// ---------------------------------------------------------------------------
// turn flow
// ---------------------------------------------------------------------------

export function getTeam(state, teamId) {
  return state.teams.find((t) => t.id === teamId) ?? null;
}

export function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) ?? null;
}

/** The side being thrown at: the one that is not active. */
export function defendingTeam(state) {
  return state.teams.find((t) => t.id !== state.activeTeamId);
}

/**
 * Section 5.1 — open a turn. The re-rack check runs here and only here, which is what
 * makes the deferral in Section 4 fall out for free: a rack that crossed a threshold
 * mid-turn is re-formed when the next turn opens, bonus turns included.
 */
export function startTurn(state) {
  const next = clone(state);
  if (next.phase === 'GAME_OVER') return next;

  next.turnNumber += 1;
  next.throwsThisTurn = 0;
  next.sinksThisTurn = 0;
  // lastRerack is turn-scoped — the notice belongs to the turn it applied to. lastThrow is
  // not: it is "the most recent throw", and clearing it at a turn boundary would blank the
  // result of the very throw that ended the turn.
  next.lastRerack = null;

  // Sudden death has one respawning cup and no rack to re-form (Section 7).
  if (!next.suddenDeathActive) {
    const defenderIndex = next.teams.findIndex((t) => t.id !== next.activeTeamId);
    const step = checkRerack(next.teams[defenderIndex]);
    if (step) {
      next.teams[defenderIndex] = repack(next.teams[defenderIndex], step);
      next.lastRerack = { teamId: next.teams[defenderIndex].id, label: step.label };
      next.log.push(`Rack reset to ${step.label} for ${next.teams[defenderIndex].id}.`);
    }
  }

  next.currentThrowerId = throwerFor(next, 0);
  next.phase = 'AIM';
  return next;
}

/**
 * Section 5.2 — who throws ball `throwIndex` of this turn. A solo side throws both; a
 * paired side alternates, starting from whichever of the two is up first this turn.
 */
export function throwerFor(state, throwIndex) {
  const team = getTeam(state, state.activeTeamId);
  if (team.playerIds.length === 1) return team.playerIds[0];
  return team.playerIds[(team.firstThrowerIndex + throwIndex) % team.playerIds.length];
}

// ---------------------------------------------------------------------------
// throw resolution
// ---------------------------------------------------------------------------

/**
 * Section 6 — map a meter reading onto the throwing lane.
 *
 * The mapping is fixed to the *full* rack's extent plus a margin, deliberately not to the
 * current rack's width. Pinning it to the live rack would make a re-racked rack easier to
 * hit per meter unit, which inverts what a re-rack is: the cups get closer together, the
 * lane does not get narrower.
 */
export function aimToX(aimValue, config = DEFAULT_CONFIG) {
  const { minX, maxX } = rackExtent();
  return lerp(minX - config.aimMargin, maxX + config.aimMargin, aimValue);
}

export function powerToY(powerValue, config = DEFAULT_CONFIG) {
  const { minY, maxY } = rackExtent();
  return lerp(minY - config.powerMargin, maxY + config.powerMargin, powerValue);
}

/** Inverse of aimToX — what a player would have to lock to aim at a given cup. */
export function xToAim(x, config = DEFAULT_CONFIG) {
  const { minX, maxX } = rackExtent();
  return invLerp(minX - config.aimMargin, maxX + config.aimMargin, x);
}

export function yToPower(y, config = DEFAULT_CONFIG) {
  const { minY, maxY } = rackExtent();
  return invLerp(minY - config.powerMargin, maxY + config.powerMargin, y);
}

/**
 * Section 6 — the drunkenness perturbation, applied to aim and to aim only.
 *
 * Returns the adjusted aim in meter units. At drunkenness 0 this is the identity, so a
 * sober player's aim is exactly what they locked.
 */
export function perturbAim(aimValue, drunkenness, rng, config = DEFAULT_CONFIG) {
  if (!drunkenness) return aimValue;
  const offset = (rng() * 2 - 1) * config.maxAimOffset * drunkenness;
  return aimValue + offset;
}

/** The cups a throw could currently sink. */
export function candidateCups(state) {
  if (state.suddenDeathActive) return state.suddenDeathCup ? [state.suddenDeathCup] : [];
  return remainingCups(defendingTeam(state));
}

/**
 * Section 6 — resolve one throw. Returns the new state plus a throwResult the renderer
 * animates; the logic itself never draws anything (Section 10).
 *
 * The rng is drawn from the game's own seeded stream so a whole match replays from its
 * seed, and `rngCursor` keeps that stream inside serializable state.
 */
/**
 * The AIM -> POWER half of a throw. The meters are chained (spec Template A, ×2), and the
 * phase lives in GameState rather than in the UI, so which meter is live is authoritative
 * state rather than something the renderer remembers on the side.
 */
export function beginPower(state) {
  if (state.phase !== 'AIM') return state;
  return { ...state, phase: 'POWER' };
}

export function applyThrow(state, aimValue, powerValue, config = DEFAULT_CONFIG) {
  if (state.phase === 'GAME_OVER') {
    return { newState: state, throwResult: null, error: 'The match is over.' };
  }

  const next = clone(state);
  const thrower = getPlayer(next, next.currentThrowerId);
  const rng = makeRng(next.seed + next.rngCursor);
  next.rngCursor += 1;

  const adjustedAim = perturbAim(aimValue, thrower.drunkenness, rng, config);
  const x = aimToX(adjustedAim, config);
  const y = powerToY(powerValue, config);

  // Nearest cup inside the tolerance radius. Nearest matters once the radius is wide
  // enough for two cups to both qualify — the ball lands in one cup, not in both.
  let hit = null;
  let bestDistance = Infinity;
  for (const cup of candidateCups(next)) {
    const d = Math.hypot(cup.x - x, cup.y - y);
    if (d <= config.toleranceRadius && d < bestDistance) {
      bestDistance = d;
      hit = cup;
    }
  }

  const throwResult = {
    throwerId: thrower.id,
    ballIndex: next.throwsThisTurn,
    lockedAim: aimValue,
    adjustedAim,
    power: powerValue,
    target: { x, y },
    hitCupId: hit ? hit.id : null,
    distance: hit ? bestDistance : null,
    isSuddenDeath: next.suddenDeathActive,
    clearedRack: false,
  };

  next.throwsThisTurn += 1;
  if (hit) {
    next.sinksThisTurn += 1;
    if (next.suddenDeathActive) {
      // Section 7: the cup respawns instantly — it is a streak target, not a cup to clear.
      next.suddenDeathCurrentStreak += 1;
    } else {
      const defenderIndex = next.teams.findIndex((t) => t.id !== next.activeTeamId);
      const defender = next.teams[defenderIndex];
      next.teams[defenderIndex] = {
        ...defender,
        cupRack: defender.cupRack.map((c) => (c.id === hit.id ? { ...c, isSunk: true } : c)),
      };
      if (remainingCups(next.teams[defenderIndex]).length === 0) {
        // Section 7: clearing the rack starts sudden death, it does not end the match.
        // The state flips here; the log line is written after the shot that caused it.
        throwResult.clearedRack = true;
        beginSuddenDeath(next);
      }
    }
  }

  next.lastThrow = throwResult;
  next.log.push(describeThrow(next, throwResult));
  if (throwResult.clearedRack) {
    next.log.push('SUDDEN DEATH — rack cleared; one cup, streak against streak.');
  }
  next.phase = 'RESOLVE_THROW';
  return { newState: next, throwResult };
}

/** Section 7 — flip to the single respawning target. The clearing shot itself scores 0. */
function beginSuddenDeath(state) {
  state.suddenDeathActive = true;
  state.suddenDeathCup = { id: 'sd', row: 0, col: 0, ...suddenDeathPosition(), isSunk: false };
  state.suddenDeathCurrentStreak = 0;
}

/**
 * Section 5.5 — close out a throw. Either the next ball is up, or the turn ends.
 * Call after each applyThrow.
 */
export function advanceAfterThrow(state) {
  const next = clone(state);
  if (next.phase === 'GAME_OVER') return next;

  if (next.throwsThisTurn < 2) {
    next.currentThrowerId = throwerFor(next, next.throwsThisTurn);
    next.phase = 'AIM';
    return next;
  }
  return endTurn(next);
}

/**
 * Section 5.5 — resolve the turn. Sinking both balls returns them and repeats the turn for
 * the same side; anything else passes possession.
 */
function endTurn(state) {
  const next = state;
  const bonus = next.sinksThisTurn === 2;
  const team = getTeam(next, next.activeTeamId);

  next.lastTurn = {
    teamId: next.activeTeamId,
    sinks: next.sinksThisTurn,
    bonus,
    streak: next.suddenDeathCurrentStreak,
  };
  next.turnBonusPending = bonus;

  // Section 5.2 — a paired side swaps who leads off. This fires on bonus turns too: a
  // repeat turn is a turn, and leaving the lead-off with one player through a long bonus
  // chain is exactly the uneven split the rule exists to prevent.
  if (team.playerIds.length > 1) {
    const index = next.teams.findIndex((t) => t.id === team.id);
    next.teams[index] = {
      ...team,
      firstThrowerIndex: (team.firstThrowerIndex + 1) % team.playerIds.length,
    };
  }

  if (bonus) {
    next.phase = 'RESOLVE_TURN';
    return startTurn(next);
  }

  // Section 7: a turn ending during sudden death is where the streak is judged.
  if (next.suddenDeathActive) return resolveSuddenDeathTurn(next);

  next.activeTeamId = defendingTeam(next).id;
  next.phase = 'RESOLVE_TURN';
  return startTurn(next);
}

/**
 * Section 7 — a sudden-death turn just ended. Matching the standing target does not win;
 * it only raises the bar and hands it back. Falling short loses on the spot.
 */
function resolveSuddenDeathTurn(state) {
  const next = state;
  const streak = next.suddenDeathCurrentStreak;
  const target = next.suddenDeathTargetStreak;
  const shooterId = next.activeTeamId;

  if (target === null || streak >= target) {
    next.suddenDeathTargetStreak = streak;
    next.suddenDeathTargetTeamId = shooterId;
    next.log.push(
      target === null
        ? `${shooterId} set the sudden-death target at ${streak}.`
        : `${shooterId} matched ${target} with ${streak} — new target is ${streak}.`
    );
    next.suddenDeathCurrentStreak = 0;
    next.activeTeamId = defendingTeam(next).id;
    next.phase = 'RESOLVE_TURN';
    return startTurn(next);
  }

  next.winnerTeamId = next.suddenDeathTargetTeamId;
  next.loserTeamId = shooterId;
  next.finalStreaks = { shooter: streak, target };
  next.phase = 'GAME_OVER';
  next.log.push(
    `${shooterId}'s streak of ${streak} fell short of ${target} — ${next.winnerTeamId} wins.`
  );
  return next;
}

export function checkGameOver(state) {
  return state.phase === 'GAME_OVER';
}

// ---------------------------------------------------------------------------
// derived readouts (for rendering — still pure)
// ---------------------------------------------------------------------------

/** "Team A" / "Team B" — the side, not its roster. */
export function teamName(state, teamId) {
  const index = state.teams.findIndex((t) => t.id === teamId);
  return index === -1 ? teamId : `Team ${String.fromCharCode(65 + index)}`;
}

/** Who is on the side, for the setup and end screens. */
export function teamRoster(state, teamId) {
  const team = getTeam(state, teamId);
  if (!team) return '';
  return team.playerIds.map((id) => getPlayer(state, id).name).join(' + ');
}

/** Section 9 — the turn indicator line. */
export function turnLabel(state) {
  if (state.phase === 'GAME_OVER') return 'Match over';
  const thrower = getPlayer(state, state.currentThrowerId);
  const ball = Math.min(state.throwsThisTurn + 1, 2);
  return `${teamName(state, state.activeTeamId)} — ${thrower.name} throwing (Ball ${ball} of 2)`;
}

/** Section 9 — the sudden-death readout. */
export function suddenDeathLabel(state) {
  if (!state.suddenDeathActive) return null;
  const who = teamName(state, state.activeTeamId);
  const streak = state.suddenDeathCurrentStreak;
  if (state.suddenDeathTargetStreak === null) {
    return `SUDDEN DEATH — ${who} streak: ${streak} (setting the target)`;
  }
  const holder = teamName(state, state.suddenDeathTargetTeamId);
  const need = state.suddenDeathTargetStreak;
  return `SUDDEN DEATH — ${who} streak: ${streak} (need ${need} to match ${holder})`;
}

/** Section 9 — the end-state line. */
export function resultLabel(state) {
  if (state.phase !== 'GAME_OVER') return null;
  const { shooter, target } = state.finalStreaks;
  return `${teamName(state, state.winnerTeamId)} wins! ` +
    `${teamName(state, state.loserTeamId)}'s streak of ${shooter} fell short of ` +
    `${teamName(state, state.winnerTeamId)}'s ${target}.`;
}

function describeThrow(state, result) {
  const who = getPlayer(state, result.throwerId).name;
  const where = `(${result.target.x.toFixed(2)}, ${result.target.y.toFixed(2)})`;
  if (!result.hitCupId) return `${who} missed ${where}.`;
  if (result.isSuddenDeath) {
    return `${who} hit the sudden-death cup ${where} — streak ${state.suddenDeathCurrentStreak}.`;
  }
  return `${who} sank ${result.hitCupId} ${where}.`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// State is plain data by construction, so this both clones and asserts serializability.
function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

const lerp = (a, b, t) => a + (b - a) * t;
const invLerp = (a, b, v) => (v - a) / (b - a);
const clamp01 = (n) => Math.max(0, Math.min(1, n));
