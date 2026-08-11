// State-level verification of the rules layer. Run: node tests/logic-tests.js
//
// Covers checks 1-9 against the pure logic module (check 10 and the click-through half
// of 1/2/4 live in tests/browser-tests.js).

import {
  createGame,
  applyAction,
  resolveTimeout,
  beginNextRound,
  startTurnTimer,
  awaitingPlayerId,
  getPlayer,
  computeScores,
  checkGameOver,
  standings,
  determineWinner,
  lowestUnlockedCard,
  viewFor,
  cardLabel,
} from '../src/game.js';

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------

let currentCheck = '';
const results = [];
let failures = 0;
let assertions = 0;

function check(name, fn) {
  currentCheck = name;
  const before = failures;
  try {
    fn();
  } catch (err) {
    failures++;
    console.log(`   ✗ threw: ${err.message}`);
    if (process.env.TW_STACK) console.log(err.stack);
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

function note(msg) {
  console.log(`   · ${msg}`);
}

const RANK_VALUES = { A: 1, J: 11, Q: 12, K: 13 };
const expectedValue = (rank) => RANK_VALUES[rank] ?? Number(rank);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function must(result, what) {
  if (!result.success) throw new Error(`${what} unexpectedly rejected: ${result.error}`);
  return result.newState;
}

/**
 * Drive a whole game. `policy(state, playerId, isActive)` returns an action payload.
 * Returns { state, usage } where usage tracks which action types each player used.
 */
function playGame(state, policy) {
  const usage = { LOCK: new Set(), REPLACE: new Set(), FORCE_TRADE: new Set() };
  let guard = 0;

  while (!checkGameOver(state)) {
    if (++guard > 500) throw new Error('game did not terminate');

    if (state.phase === 'ROUND_RESOLVING') {
      state = beginNextRound(state, 0);
      continue;
    }
    const playerId = awaitingPlayerId(state);
    const isActive = playerId === state.activePlayerId;
    const action = policy(state, playerId, isActive);
    const result = applyAction(state, { playerId, ...action }, 0);
    if (!result.success) throw new Error(`policy produced illegal action: ${result.error}`);
    usage[action.actionType].add(playerId);
    state = result.newState;
  }
  return { state, usage };
}

/** Active player force-trades; everyone else alternates Lock/Replace by seat + round. */
function mixedPolicy(state, playerId, isActive) {
  const player = getPlayer(state, playerId);
  const unlocked = player.hand.filter((c) => !c.locked);

  if (isActive) {
    const target = state.players.find(
      (p) => p.id !== playerId && p.hand.some((c) => !c.locked)
    );
    if (target && unlocked.length > 0) {
      const takeIndex = target.hand.findIndex((c) => !c.locked);
      return {
        actionType: 'FORCE_TRADE',
        payload: { giveCardId: unlocked[0].id, targetPlayerId: target.id, takeIndex },
      };
    }
  }
  const seat = state.players.findIndex((p) => p.id === playerId);
  const useReplace = (seat + state.currentRound) % 2 === 0;
  return {
    actionType: useReplace ? 'REPLACE' : 'LOCK',
    payload: { cardId: unlocked[0].id },
  };
}

// ---------------------------------------------------------------------------
// CHECK 1 + 2 + 4 (logic level) — full games, all action types, rotation
// ---------------------------------------------------------------------------

function fullGameCheck(playerCount, seed) {
  const start = createGame({ playerCount, seed });

  // Rotation: every player active exactly once across N rounds.
  eq(start.roundOrder.length, playerCount, 'roundOrder length == N');
  eq(new Set(start.roundOrder).size, playerCount, 'each player appears in roundOrder exactly once');

  const activeSeen = [];
  let state = start;
  let rounds = 0;
  const nonActiveTradeRejections = [];

  // Replay manually so we can observe each round boundary.
  while (!checkGameOver(state)) {
    if (state.phase === 'ROUND_RESOLVING') {
      state = beginNextRound(state, 0);
      continue;
    }
    if (activeSeen[state.currentRound - 1] === undefined) {
      activeSeen[state.currentRound - 1] = state.activePlayerId;
      rounds = Math.max(rounds, state.currentRound);
    }
    const playerId = awaitingPlayerId(state);
    const isActive = playerId === state.activePlayerId;

    // Check 4b: a non-active player attempting FORCE_TRADE must be rejected.
    if (!isActive) {
      const victim = state.players.find((p) => p.id !== playerId && p.hand.some((c) => !c.locked));
      const mine = getPlayer(state, playerId).hand.find((c) => !c.locked);
      if (victim && mine) {
        const bad = applyAction(
          state,
          {
            playerId,
            actionType: 'FORCE_TRADE',
            payload: { giveCardId: mine.id, targetPlayerId: victim.id, takeIndex: 0 },
          },
          0
        );
        nonActiveTradeRejections.push(bad);
      }
    }

    const action = mixedPolicy(state, playerId, isActive);
    state = must(applyAction(state, { playerId, ...action }, 0), action.actionType);
  }

  eq(rounds, playerCount, `game ran exactly N=${playerCount} rounds`);
  eq(new Set(activeSeen).size, playerCount, 'every player was active exactly once');
  ok(
    nonActiveTradeRejections.length > 0 &&
      nonActiveTradeRejections.every(
        (r) => !r.success && /Only the active player/.test(r.error)
      ),
    `all ${nonActiveTradeRejections.length} non-active Force Trade attempts rejected`
  );
  note(`${nonActiveTradeRejections.length} non-active Force Trade attempts, all rejected`);
  note(`active order: ${activeSeen.map((id) => getPlayer(state, id).name).join(' → ')}`);
  return state;
}

check('CHECK 1a — full 4-player game start to finish', () => {
  const state = fullGameCheck(4, 12345);
  eq(state.phase, 'GAME_OVER', 'phase is GAME_OVER');
  eq(state.players.length, 4, '4 players');
  for (const p of state.players) eq(p.hand.length, 4, `${p.name} still holds N=4 cards`);
});

check('CHECK 1b — full 6-player game start to finish', () => {
  const state = fullGameCheck(6, 987);
  eq(state.phase, 'GAME_OVER', 'phase is GAME_OVER');
  eq(state.players.length, 6, '6 players');
  for (const p of state.players) eq(p.hand.length, 6, `${p.name} still holds N=6 cards`);
});

check('CHECK 2 — LOCK, REPLACE and FORCE_TRADE each used by multiple players', () => {
  for (const [playerCount, seed] of [[4, 12345], [6, 987]]) {
    const { usage } = playGame(createGame({ playerCount, seed }), mixedPolicy);
    for (const type of ['LOCK', 'REPLACE', 'FORCE_TRADE']) {
      ok(usage[type].size >= 2, `${playerCount}p: ${type} used by >=2 distinct players (was ${usage[type].size})`);
      note(`${playerCount}p ${type}: ${[...usage[type]].join(', ')}`);
    }
  }
});

// ---------------------------------------------------------------------------
// CHECK 3 — Force Trade correctness
// ---------------------------------------------------------------------------

check('CHECK 3 — Force Trade is blind-by-position, gives unlocked, takes locked', () => {
  const state = createGame({ playerCount: 4, seed: 4242, roundOrder: ['p1', 'p2', 'p3', 'p4'] });
  const actor = getPlayer(state, 'p1');
  const target = getPlayer(state, 'p3');

  const POSITION = 3; // 1-indexed, as the UI shows it
  const cardAtPosition = target.hand[POSITION - 1];
  const giveCard = actor.hand[0];
  note(`p1 gives ${cardLabel(giveCard)}; p3 position ${POSITION} physically holds ${cardLabel(cardAtPosition)}`);

  let next = must(
    applyAction(
      state,
      {
        playerId: 'p1',
        actionType: 'FORCE_TRADE',
        payload: { giveCardId: giveCard.id, targetPlayerId: 'p3', takeIndex: POSITION - 1 },
      },
      0
    ),
    'FORCE_TRADE'
  );

  // The recorded payload must resolve the position to that exact physical card.
  eq(next.actionsThisRound.p1.payload.takeCardId, cardAtPosition.id,
    'position resolved to the card physically occupying that slot');

  // Finish the round so the trade resolves.
  for (const pid of ['p2', 'p3', 'p4']) {
    const p = getPlayer(next, pid);
    const card = p.hand.find((c) => !c.locked);
    next = must(applyAction(next, { playerId: pid, actionType: 'LOCK', payload: { cardId: card.id } }, 0), 'LOCK');
  }

  const actorAfter = getPlayer(next, 'p1');
  const targetAfter = getPlayer(next, 'p3');

  const taken = actorAfter.hand.find((c) => c.id === cardAtPosition.id);
  ok(taken, 'trader now holds the card that occupied the chosen position');
  eq(taken?.locked, true, 'taken card is LOCKED immediately for the trader');
  eq(taken?.ownerId, 'p1', 'taken card ownerId updated to trader');

  const given = targetAfter.hand.find((c) => c.id === giveCard.id);
  ok(given, 'receiver now holds the given card');
  eq(given?.locked, false, 'given card is UNLOCKED for the receiver');
  eq(given?.ownerId, 'p3', 'given card ownerId updated to receiver');

  ok(!actorAfter.hand.some((c) => c.id === giveCard.id), 'given card left the trader hand');
  ok(!targetAfter.hand.some((c) => c.id === cardAtPosition.id), 'taken card left the receiver hand');

  // Position stability: the swap happens in place, so slot indices stay meaningful.
  eq(targetAfter.hand[POSITION - 1].id, giveCard.id, 'swap is in place — receiver slot 3 now holds the given card');
  eq(actorAfter.hand.length, 4, 'trader hand size unchanged');
  eq(targetAfter.hand.length, 4, 'receiver hand size unchanged');

  // The same position on a later read points at whatever now physically sits there.
  eq(viewFor(next, 'p3').players.find((p) => p.id === 'p3').hand[POSITION - 1].id, giveCard.id,
    'a later blind read of position 3 sees the new physical occupant');
});

check('CHECK 3b — a Force Trade always resolves before any other player acts', () => {
  // Actions now resolve on submission so each player sees their own result. Section 4.3's
  // "FORCE_TRADE first" therefore rests on turn order: the active player must always be
  // the round's first submitter, in every round of both formats.
  for (const playerCount of [4, 6]) {
    let state = createGame({ playerCount, seed: 616 + playerCount });
    let roundsChecked = 0;
    let tradesSeen = 0;

    const auditRound = (st) => {
      const events = st.lastRoundSummary?.events ?? [];
      const tradeAt = events.findIndex((e) => e.type === 'FORCE_TRADE');
      if (tradeAt === -1) return;
      tradesSeen++;
      eq(tradeAt, 0, `${playerCount}p round ${st.lastRoundSummary.round}: trade is the first resolved event`);
    };

    while (!checkGameOver(state)) {
      if (state.phase === 'ROUND_RESOLVING') {
        auditRound(state);
        state = beginNextRound(state, 0);
        continue;
      }
      if (Object.keys(state.actionsThisRound).length === 0) {
        eq(state.submissionOrder[0], state.activePlayerId,
          `${playerCount}p round ${state.currentRound}: active player submits first`);
        eq(awaitingPlayerId(state), state.activePlayerId,
          `${playerCount}p round ${state.currentRound}: nobody acts before the active player`);
        roundsChecked++;
      }
      const playerId = awaitingPlayerId(state);
      const action = mixedPolicy(state, playerId, playerId === state.activePlayerId);
      state = must(applyAction(state, { playerId, ...action }, 0), action.actionType);
    }
    auditRound(state); // final round
    eq(roundsChecked, playerCount, `${playerCount}p: checked every round`);
    ok(tradesSeen > 0, `${playerCount}p: trades actually happened and were audited (${tradesSeen})`);
    note(`${playerCount}p: ${tradesSeen} rounds contained a Force Trade, each resolved first`);
  }
});

// ---------------------------------------------------------------------------
// CHECK 5 — timer expiry fallback
// ---------------------------------------------------------------------------

check('CHECK 5 — 15s expiry auto-locks the lowest-value unlocked card', () => {
  let state = createGame({ playerCount: 4, seed: 777, roundOrder: ['p1', 'p2', 'p3', 'p4'] });
  const T0 = 1_000_000;
  state = startTurnTimer(state, T0);
  eq(state.timerEndsAt, T0 + 15000, 'timer window is 15s');

  const early = resolveTimeout(state, T0 + 14999);
  eq(early.success, false, 'timeout before expiry is rejected');

  const player = getPlayer(state, 'p1');
  const lowest = lowestUnlockedCard(player);
  note(`p1 hand: ${player.hand.map(cardLabel).join(' ')} — lowest = ${cardLabel(lowest)} (${lowest.value})`);

  const fired = resolveTimeout(state, T0 + 15000);
  eq(fired.success, true, 'timeout fires at expiry');
  eq(fired.autoLockedCardId, lowest.id, 'auto-locked the lowest-value unlocked card');
  let next = fired.newState;
  eq(next.actionsThisRound.p1.actionType, 'LOCK', 'recorded action is LOCK');
  eq(next.actionsThisRound.p1.autoResolved, 'TIMEOUT', 'recorded as timer-resolved');

  // Confirm it actually locks once the round resolves.
  for (const pid of ['p2', 'p3', 'p4']) {
    const card = getPlayer(next, pid).hand.find((c) => !c.locked);
    next = must(applyAction(next, { playerId: pid, actionType: 'LOCK', payload: { cardId: card.id } }, 0), 'LOCK');
  }
  const after = getPlayer(next, 'p1').hand.find((c) => c.id === lowest.id);
  eq(after.locked, true, `${cardLabel(lowest)} is locked after the round resolved`);

  // And that no other p1 card got locked by the fallback.
  eq(getPlayer(next, 'p1').hand.filter((c) => c.locked).length, 1, 'exactly one card locked for p1');
});

// ---------------------------------------------------------------------------
// CHECK 6 — locked-card enforcement
// ---------------------------------------------------------------------------

check('CHECK 6 — locked cards cannot be locked, replaced, given or taken', () => {
  let state = createGame({ playerCount: 4, seed: 5150, roundOrder: ['p1', 'p2', 'p3', 'p4'] });

  // Round 1: p1 locks hand[0], p3 locks hand[0]. Everyone else locks too.
  const p1Target = getPlayer(state, 'p1').hand[0];
  const p3Target = getPlayer(state, 'p3').hand[0];
  for (const pid of ['p1', 'p2', 'p3', 'p4']) {
    const card = getPlayer(state, pid).hand[0];
    state = must(applyAction(state, { playerId: pid, actionType: 'LOCK', payload: { cardId: card.id } }, 0), 'LOCK');
  }
  state = beginNextRound(state, 0);
  eq(getPlayer(state, 'p1').hand[0].locked, true, 'p1 position 1 is locked going into round 2');
  eq(getPlayer(state, 'p3').hand[0].locked, true, 'p3 position 1 is locked going into round 2');

  // Round 2 active player is p2, so p2 acts first. Park p1's attempts by acting as p2 last.
  eq(state.activePlayerId, 'p2', 'round 2 active player is p2');

  // p2 (active) tries to GIVE a locked card and to TAKE a locked card.
  const p2Locked = getPlayer(state, 'p2').hand.find((c) => c.locked);
  const p2Unlocked = getPlayer(state, 'p2').hand.find((c) => !c.locked);

  const giveLocked = applyAction(state, {
    playerId: 'p2', actionType: 'FORCE_TRADE',
    payload: { giveCardId: p2Locked.id, targetPlayerId: 'p3', takeIndex: 1 },
  }, 0);
  eq(giveLocked.success, false, 'giving a locked card is rejected');
  note(`give-locked error: "${giveLocked.error}"`);

  const takeLocked = applyAction(state, {
    playerId: 'p2', actionType: 'FORCE_TRADE',
    payload: { giveCardId: p2Unlocked.id, targetPlayerId: 'p3', takeIndex: 0 },
  }, 0);
  eq(takeLocked.success, false, 'taking a locked card (position 1) is rejected');
  note(`take-locked error: "${takeLocked.error}"`);
  eq(getPlayer(state, 'p3').hand[0].id, p3Target.id, 'p3 position 1 unchanged by the rejected trade');

  // LOCK / REPLACE on an already-locked card.
  const lockLocked = applyAction(state, {
    playerId: 'p2', actionType: 'LOCK', payload: { cardId: p2Locked.id },
  }, 0);
  eq(lockLocked.success, false, 'locking an already-locked card is rejected');
  note(`lock-locked error: "${lockLocked.error}"`);

  const replaceLocked = applyAction(state, {
    playerId: 'p2', actionType: 'REPLACE', payload: { cardId: p2Locked.id },
  }, 0);
  eq(replaceLocked.success, false, 'replacing a locked card is rejected');
  note(`replace-locked error: "${replaceLocked.error}"`);

  // Rejected actions must not mutate state at all.
  for (const r of [giveLocked, takeLocked, lockLocked, replaceLocked]) {
    eq(r.newState, state, 'rejected action returned the state unchanged (same reference)');
  }
  eq(JSON.stringify(state.actionsThisRound), '{}', 'no action was recorded for round 2 yet');

  // p1's locked card is also untouchable when p1's turn comes.
  state = must(applyAction(state, { playerId: 'p2', actionType: 'LOCK', payload: { cardId: p2Unlocked.id } }, 0), 'LOCK');
  eq(awaitingPlayerId(state), 'p3', 'submission order advanced to p3');
  for (const pid of ['p3', 'p4']) {
    const c = getPlayer(state, pid).hand.find((x) => !x.locked);
    state = must(applyAction(state, { playerId: pid, actionType: 'LOCK', payload: { cardId: c.id } }, 0), 'LOCK');
  }
  const p1Lock = applyAction(state, { playerId: 'p1', actionType: 'LOCK', payload: { cardId: p1Target.id } }, 0);
  eq(p1Lock.success, false, 'p1 cannot re-lock their locked card');
  const p1Replace = applyAction(state, { playerId: 'p1', actionType: 'REPLACE', payload: { cardId: p1Target.id } }, 0);
  eq(p1Replace.success, false, 'p1 cannot replace their locked card');
});

// ---------------------------------------------------------------------------
// CHECK 7 — end-of-round-N auto-lock and no further actions
// ---------------------------------------------------------------------------

check('CHECK 7 — after round N every card is locked and actions are refused', () => {
  const { state } = playGame(createGame({ playerCount: 4, seed: 2024 }), mixedPolicy);

  eq(state.phase, 'GAME_OVER', 'phase is GAME_OVER');
  eq(state.currentRound, 4, 'stopped at round N');

  let total = 0;
  for (const p of state.players) {
    for (const c of p.hand) {
      total++;
      eq(c.locked, true, `${p.name}'s ${cardLabel(c)} is locked`);
    }
  }
  eq(total, 16, 'all 16 cards accounted for');

  // In legal play the end-of-game sweep is a safety net that never has work to do: every
  // action type retires exactly one unlocked card per player per round (a Force Trade
  // target loses their taken card but receives an unlocked one, then still acts), so
  // unlocked count == N - roundsCompleted for everyone. Sweep coverage is checked below.
  const forced = state.log.filter((l) => l.includes('force-locked'));
  eq(forced.length, 0, 'natural play leaves no stragglers for the sweep');

  // Every action type is now refused.
  for (const actionType of ['LOCK', 'REPLACE', 'FORCE_TRADE']) {
    const r = applyAction(state, {
      playerId: 'p1',
      actionType,
      payload: { cardId: state.players[0].hand[0].id, targetPlayerId: 'p2', takeIndex: 0, giveCardId: state.players[0].hand[0].id },
    }, 0);
    eq(r.success, false, `${actionType} refused after game over`);
  }
  eq(beginNextRound(state, 0), state, 'beginNextRound is a no-op on a finished game');
  eq(awaitingPlayerId(state), null, 'nobody is on the clock');
});

check('CHECK 7b — a straggler unlocked at the end of round N is force-locked', () => {
  let s = createGame({ playerCount: 4, seed: 2024, roundOrder: ['p1', 'p2', 'p3', 'p4'] });

  const lockOne = (st, pid) => {
    const card = getPlayer(st, pid).hand.find((c) => !c.locked);
    return must(applyAction(st, { playerId: pid, actionType: 'LOCK', payload: { cardId: card.id } }, 0), 'LOCK');
  };

  // Rounds 1-3 normally.
  for (let r = 1; r <= 3; r++) {
    for (const pid of s.submissionOrder.slice()) s = lockOne(s, pid);
    s = beginNextRound(s, 0);
  }
  eq(s.currentRound, 4, 'at round N');

  // Inject a straggler: hand p3 back an extra unlocked card so one cannot be retired
  // by their single remaining action.
  const straggler = getPlayer(s, 'p3').hand.find((c) => c.locked);
  straggler.locked = false;
  eq(getPlayer(s, 'p3').hand.filter((c) => !c.locked).length, 2, 'p3 enters round N with 2 unlocked cards');
  note(`straggler planted: p3's ${cardLabel(straggler)}`);

  for (const pid of s.submissionOrder.slice()) s = lockOne(s, pid);

  eq(s.phase, 'GAME_OVER', 'game ended after round N');
  for (const p of s.players) {
    for (const c of p.hand) eq(c.locked, true, `${p.name}'s ${cardLabel(c)} is locked after the sweep`);
  }
  const forced = s.log.filter((l) => l.includes('force-locked'));
  eq(forced.length, 1, 'exactly one card was force-locked by the sweep');
  note(`sweep log: ${forced[0]}`);

  const r = applyAction(s, { playerId: 'p3', actionType: 'LOCK', payload: { cardId: straggler.id } }, 0);
  eq(r.success, false, 'no further actions accepted after the sweep');
});

// ---------------------------------------------------------------------------
// CHECK 8 — scoring and win condition
// ---------------------------------------------------------------------------

check('CHECK 8 — scores equal the sum of the actual cards held; highest sum wins', () => {
  for (const [playerCount, seed] of [[4, 31337], [6, 8888]]) {
    const { state } = playGame(createGame({ playerCount, seed }), mixedPolicy);

    // Independently re-derive every value from the card's rank, then re-sum by hand.
    const manual = {};
    for (const p of state.players) {
      let sum = 0;
      for (const c of p.hand) {
        eq(c.value, expectedValue(c.rank), `${cardLabel(c)} value matches its rank`);
        sum += c.value;
      }
      manual[p.id] = sum;
      note(`${p.name}: ${p.hand.map(cardLabel).join(' ')} = ${sum} (drunk ${p.drunkenness})`);
    }

    const reported = computeScores(state);
    for (const p of state.players) {
      eq(reported[p.id], manual[p.id], `${p.name} reported score matches hand sum`);
      eq(state.scores[p.id], manual[p.id], `${p.name} stored score matches hand sum`);
    }

    // No duplicate cards anywhere in play.
    const allIds = state.players.flatMap((p) => p.hand.map((c) => c.id));
    eq(new Set(allIds).size, allIds.length, 'no duplicate cards across all hands');

    const max = Math.max(...Object.values(manual));
    eq(manual[state.winnerId], max, `winner holds the max score (${max})`);
    eq(standings(state)[0].id, state.winnerId, 'standings are sorted with the winner first');
    note(`${playerCount}p winner: ${getPlayer(state, state.winnerId).name} with ${max}`);
  }
});

// ---------------------------------------------------------------------------
// CHECK 9 — tiebreak by drunkenness
// ---------------------------------------------------------------------------

check('CHECK 9 — tied top scores break toward higher drunkenness', () => {
  // Construct the tie directly on a finished state so the tie is exact and intentional.
  const { state } = playGame(
    createGame({ playerCount: 4, seed: 606, drunkenness: [1, 9, 4, 2] }),
    mixedPolicy
  );

  // Rebuild p1 and p2 hands to an identical, hand-checked total.
  const forceHand = (playerId, ranks) => {
    const p = getPlayer(state, playerId);
    p.hand = ranks.map((rank, i) => ({
      id: `${rank}-${playerId}-${i}`,
      rank,
      suit: '♠',
      value: expectedValue(rank),
      locked: true,
      ownerId: playerId,
    }));
  };
  forceHand('p1', ['K', 'Q', '2', '3']); // 13+12+2+3 = 30
  forceHand('p2', ['J', 'J', '4', '4']); // 11+11+4+4 = 30
  forceHand('p3', ['2', '2', '2', '2']); // 8
  forceHand('p4', ['3', '3', '3', '3']); // 12

  const scores = computeScores(state);
  eq(scores.p1, 30, 'p1 sums to 30');
  eq(scores.p2, 30, 'p2 sums to 30');
  ok(scores.p1 === scores.p2 && scores.p1 > scores.p3 && scores.p1 > scores.p4,
    'p1 and p2 are tied at the top');

  state.scores = scores;
  const recomputed = { ...state, scores };
  // determineWinner is exercised through the same path the engine uses.
  const winner = standings(recomputed)[0];
  note(`p1 drunk ${getPlayer(state, 'p1').drunkenness}, p2 drunk ${getPlayer(state, 'p2').drunkenness}`);

  // Direct assertion on the winner-selection rule:
  eq(determineWinner(recomputed), 'p2', 'higher drunkenness (p2: 9 vs p1: 1) wins the tie');
  eq(winner.id, 'p2', 'standings put the tiebreak winner first');

  // Flip drunkenness and confirm the tiebreak follows it, not seat order.
  const flipped = JSON.parse(JSON.stringify(recomputed));
  getPlayer(flipped, 'p1').drunkenness = 12;
  getPlayer(flipped, 'p2').drunkenness = 9;
  eq(determineWinner(flipped), 'p1', 'tiebreak follows drunkenness after flipping it');
});

// ---------------------------------------------------------------------------
// CHECK 10 (logic half) — the redacted view carries no opponent card data
// ---------------------------------------------------------------------------

check('CHECK 10a — viewFor() exposes card faces only to the viewer', () => {
  const state = createGame({ playerCount: 6, seed: 4711 });
  const view = viewFor(state, 'p2');
  const serialized = JSON.stringify(view);

  for (const p of view.players) {
    for (const slot of p.hand) {
      if (p.id === 'p2') {
        ok(slot.label !== undefined && slot.value !== undefined, 'viewer sees own faces');
      } else {
        eq(slot.label, undefined, `${p.id} slot has no label`);
        eq(slot.value, undefined, `${p.id} slot has no value`);
        eq(slot.id, undefined, `${p.id} slot has no card id`);
        ok(slot.position !== undefined, `${p.id} slot still exposes its position`);
      }
    }
  }

  // No opponent card id may appear anywhere in the serialized view.
  let leaked = 0;
  for (const p of state.players) {
    if (p.id === 'p2') continue;
    for (const c of p.hand) if (serialized.includes(c.id)) leaked++;
  }
  eq(leaked, 0, 'no opponent card id appears anywhere in the redacted view');
});

// ---------------------------------------------------------------------------
// serializability (Section 9 requirement)
// ---------------------------------------------------------------------------

check('EXTRA — GameState survives a JSON round-trip mid-game', () => {
  let state = createGame({ playerCount: 4, seed: 99 });
  state = must(applyAction(state, {
    playerId: awaitingPlayerId(state),
    actionType: 'LOCK',
    payload: { cardId: getPlayer(state, awaitingPlayerId(state)).hand[0].id },
  }, 0), 'LOCK');

  const round = JSON.parse(JSON.stringify(state));
  eq(JSON.stringify(round), JSON.stringify(state), 'state is JSON-identical after a round trip');
  const resumed = must(applyAction(round, {
    playerId: awaitingPlayerId(round),
    actionType: 'REPLACE',
    payload: { cardId: getPlayer(round, awaitingPlayerId(round)).hand[0].id },
  }, 0), 'REPLACE');
  ok(resumed.phase === 'AWAITING_ACTIONS', 'a deserialized state keeps playing');
});

// ---------------------------------------------------------------------------

console.log('='.repeat(64));
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log('='.repeat(64));
console.log(`${results.filter((r) => r.passed).length}/${results.length} checks passed, ${assertions} assertions, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
