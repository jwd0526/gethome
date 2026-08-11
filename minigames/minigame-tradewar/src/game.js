// Trade War — rules/state layer.
//
// Pure logic. No DOM, no timers, no framework coupling. Everything in GameState is
// JSON-shaped (strings, numbers, booleans, arrays, plain objects) so the whole state
// survives JSON.stringify/parse round-trips and maps ~1:1 onto a C++ struct later.
//
// Contract that survives the Unreal port:
//   applyAction(state, { playerId, actionType, payload }, now) -> { success, newState, error? }
//   checkGameOver(state) -> bool
//   computeScores(state) -> { [playerId]: number }

export const TURN_DURATION_MS = 15000;

const RANKS = [
  ['A', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
  ['8', 8], ['9', 9], ['10', 10], ['J', 11], ['Q', 12], ['K', 13],
];
const SUITS = ['♠', '♥', '♦', '♣']; // spade heart diamond club

// ---------------------------------------------------------------------------
// helpers
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

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const [rank, value] of RANKS) {
      deck.push({ id: `${rank}${suit}`, rank, suit, value, locked: false, ownerId: null });
    }
  }
  return deck;
}

// State is plain data by construction, so this both clones and asserts serializability.
function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

export function cardLabel(card) {
  return `${card.rank}${card.suit}`;
}

export function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) || null;
}

function findCard(player, cardId) {
  const index = player ? player.hand.findIndex((c) => c.id === cardId) : -1;
  return index === -1 ? null : { card: player.hand[index], index };
}

export function unlockedCards(player) {
  return player.hand.filter((c) => !c.locked);
}

// Lowest value wins; ties broken by lowest hand position so the fallback is deterministic.
export function lowestUnlockedCard(player) {
  let best = null;
  for (const card of player.hand) {
    if (card.locked) continue;
    if (best === null || card.value < best.value) best = card;
  }
  return best;
}

/** Whose submission the game is currently waiting on (null unless AWAITING_ACTIONS). */
export function awaitingPlayerId(state) {
  if (state.phase !== 'AWAITING_ACTIONS') return null;
  return state.submissionOrder[state.submissionIndex] ?? null;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

/**
 * Section 3 — Setup. N = playerCount = cards per hand = number of rounds.
 * `seed`, `names`, `drunkenness` and `roundOrder` are injectable so tests can pin a game.
 */
export function createGame(opts = {}) {
  const playerCount = opts.playerCount ?? 4;
  if (playerCount !== 4 && playerCount !== 6) {
    throw new Error('playerCount must be 4 or 6');
  }

  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = makeRng(seed);
  const names =
    opts.names ?? Array.from({ length: playerCount }, (_, i) => `Player ${i + 1}`);

  const deck = shuffle(buildDeck(), rng);
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const id = `p${i + 1}`;
    const hand = [];
    for (let c = 0; c < playerCount; c++) {
      const card = deck.pop();
      card.ownerId = id;
      card.locked = false;
      hand.push(card);
    }
    players.push({
      id,
      name: names[i] ?? `Player ${i + 1}`,
      hand,
      drunkenness: opts.drunkenness ? opts.drunkenness[i] ?? 0 : Math.floor(rng() * 11),
      isActiveThisRound: false,
    });
  }

  const roundOrder = opts.roundOrder ?? shuffle(players.map((p) => p.id), rng);

  const state = {
    seed,
    playerCount,
    players,
    deck,
    discard: [],
    currentRound: 1,
    activePlayerId: roundOrder[0],
    roundOrder,
    phase: 'AWAITING_ACTIONS',
    actionsThisRound: {},
    roundEvents: [],
    lastEvent: null,
    // Pass-and-play submission queue: active player first, then seating order.
    submissionOrder: [],
    submissionIndex: 0,
    turnDurationMs: opts.turnDurationMs ?? TURN_DURATION_MS,
    timerEndsAt: null,
    lastRoundSummary: null,
    scores: null,
    winnerId: null,
    log: [],
  };

  beginRound(state, opts.now ?? 0);
  return state;
}

// Mutates `state` in place — only ever called on a state we already own (fresh or cloned).
function beginRound(state, now) {
  const activeId = state.roundOrder[state.currentRound - 1];
  state.activePlayerId = activeId;
  state.phase = 'AWAITING_ACTIONS';
  state.actionsThisRound = {};
  state.roundEvents = [];
  state.lastEvent = null;
  state.submissionIndex = 0;
  state.timerEndsAt = null;

  for (const p of state.players) p.isActiveThisRound = p.id === activeId;

  const seat = state.players.map((p) => p.id);
  const start = seat.indexOf(activeId);
  state.submissionOrder = seat.slice(start).concat(seat.slice(0, start));

  state.log.push(
    `--- Round ${state.currentRound} of ${state.playerCount} — active: ${
      getPlayer(state, activeId).name
    } ---`
  );
}

/**
 * Opens the 15s window for the player currently on the clock. The UI calls this when a
 * hand is actually revealed (not while the pass-the-device interstitial is up), and again
 * at each Force Trade step, per Section 7's "resets at each new decision point".
 */
export function startTurnTimer(state, now) {
  const next = clone(state);
  if (next.phase !== 'AWAITING_ACTIONS') return next;
  next.timerEndsAt = now + next.turnDurationMs;
  return next;
}

export function timeRemaining(state, now) {
  if (state.phase !== 'AWAITING_ACTIONS' || state.timerEndsAt === null) return null;
  return Math.max(0, state.timerEndsAt - now);
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function reject(state, error) {
  return { success: false, newState: state, error };
}

/**
 * Section 4/5 — submit one action for one player.
 *
 * Actions are *collected* here, not applied: every player submits against the same
 * round-start state, and the whole round resolves at once (FORCE_TRADE -> REPLACE -> LOCK)
 * when the last player has submitted. That is what makes the round genuinely simultaneous
 * and makes Force Trade's blind-by-position pick unambiguous.
 */
export function applyAction(state, action, now = 0) {
  if (state.phase === 'GAME_OVER') return reject(state, 'Game is over.');
  if (state.phase !== 'AWAITING_ACTIONS') {
    return reject(state, 'Not accepting actions right now.');
  }

  const { playerId, actionType, payload = {} } = action || {};
  const player = getPlayer(state, playerId);
  if (!player) return reject(state, `Unknown player: ${playerId}`);

  const expected = awaitingPlayerId(state);
  if (playerId !== expected) {
    return reject(state, `It is not ${player.name}'s turn to submit.`);
  }
  if (state.actionsThisRound[playerId]) {
    return reject(state, `${player.name} already acted this round.`);
  }

  let record;
  switch (actionType) {
    case 'LOCK':
      record = validateLock(state, player, payload);
      break;
    case 'REPLACE':
      record = validateReplace(state, player, payload);
      break;
    case 'FORCE_TRADE':
      record = validateForceTrade(state, player, payload);
      break;
    default:
      return reject(state, `Unknown action type: ${actionType}`);
  }
  if (record.error) return reject(state, record.error);

  return { success: true, newState: commitSubmission(state, record.action, now) };
}

function validateLock(state, player, payload) {
  const found = findCard(player, payload.cardId);
  if (!found) return { error: 'That card is not in your hand.' };
  if (found.card.locked) return { error: 'That card is already locked.' };
  return {
    action: { playerId: player.id, actionType: 'LOCK', payload: { cardId: payload.cardId } },
  };
}

function validateReplace(state, player, payload) {
  const found = findCard(player, payload.cardId);
  if (!found) return { error: 'That card is not in your hand.' };
  if (found.card.locked) return { error: 'That card is already locked — it cannot be replaced.' };
  if (state.deck.length === 0) return { error: 'Deck is empty.' };
  return {
    action: { playerId: player.id, actionType: 'REPLACE', payload: { cardId: payload.cardId } },
  };
}

function validateForceTrade(state, player, payload) {
  if (player.id !== state.activePlayerId) {
    return { error: 'Only the active player may Force Trade.' };
  }
  const give = findCard(player, payload.giveCardId);
  if (!give) return { error: 'The card you are giving is not in your hand.' };
  if (give.card.locked) return { error: 'You cannot give away a locked card.' };

  if (payload.targetPlayerId === player.id) {
    return { error: 'You cannot Force Trade with yourself.' };
  }
  const target = getPlayer(state, payload.targetPlayerId);
  if (!target) return { error: 'Unknown trade target.' };

  // Blind-by-position: the UI picks a slot index, which resolves to whichever card
  // physically occupies that position in the target's hand right now.
  let takeCardId = payload.takeCardId;
  if (takeCardId === undefined && Number.isInteger(payload.takeIndex)) {
    const atIndex = target.hand[payload.takeIndex];
    if (!atIndex) return { error: 'That position does not exist in the target hand.' };
    takeCardId = atIndex.id;
  }

  const take = findCard(target, takeCardId);
  if (!take) return { error: 'That card is not in the target hand.' };
  if (take.card.locked) return { error: 'You cannot take a locked card.' };

  return {
    action: {
      playerId: player.id,
      actionType: 'FORCE_TRADE',
      payload: {
        giveCardId: payload.giveCardId,
        targetPlayerId: target.id,
        takeCardId,
        takeIndex: take.index,
      },
    },
  };
}

function commitSubmission(state, record, now) {
  const next = clone(state);
  const events = [];

  // Resolve the action now, so the acting player watches their own card lock, flip or
  // swap before the device is passed on. Section 4.3's ordering guarantee is preserved by
  // turn order rather than by batching: the active player is always submissionOrder[0],
  // so a FORCE_TRADE always lands before any other player acts this round.
  resolveRecord(next, record, events);

  next.actionsThisRound[record.playerId] = record;
  next.roundEvents.push(...events);
  next.lastEvent = events[events.length - 1] ?? null;
  next.log.push(...events.map((e) => describeEvent(next, e)));
  next.submissionIndex += 1;
  next.timerEndsAt = null;

  if (next.submissionIndex >= next.submissionOrder.length) finishRound(next);
  return next;
}

function resolveRecord(state, record, events) {
  if (record.actionType === 'FORCE_TRADE') resolveForceTrade(state, record, events);
  else if (record.actionType === 'REPLACE') resolveReplace(state, record, events);
  else resolveLock(state, record, events);
}

/** Section 7 — timer expiry fallback: auto-LOCK the lowest-value unlocked card. */
export function resolveTimeout(state, now) {
  if (state.phase !== 'AWAITING_ACTIONS') return reject(state, 'No turn is in progress.');
  if (state.timerEndsAt === null) return reject(state, 'Timer has not been started.');
  if (now < state.timerEndsAt) return reject(state, 'Timer has not expired yet.');

  const playerId = awaitingPlayerId(state);
  const player = getPlayer(state, playerId);
  const card = lowestUnlockedCard(player);
  if (!card) {
    // Unreachable in a legal game (unlocked count is always N - roundsCompleted), but the
    // rules layer should never hard-fail on it.
    return reject(state, 'No unlocked card to auto-lock.');
  }

  const record = {
    playerId,
    actionType: 'LOCK',
    payload: { cardId: card.id },
    autoResolved: 'TIMEOUT',
  };
  return { success: true, newState: commitSubmission(state, record, now), autoLockedCardId: card.id };
}

// ---------------------------------------------------------------------------
// round resolution
// ---------------------------------------------------------------------------

function finishRound(state) {
  state.phase = 'ROUND_RESOLVING';
  state.lastRoundSummary = { round: state.currentRound, events: state.roundEvents.slice() };
  if (state.currentRound >= state.playerCount) endGame(state);
}

function resolveForceTrade(state, record, events) {
  const actor = getPlayer(state, record.playerId);
  const target = getPlayer(state, record.payload.targetPlayerId);
  const give = findCard(actor, record.payload.giveCardId);
  const take = findCard(target, record.payload.takeCardId);
  if (!give || !take || give.card.locked || take.card.locked) {
    events.push({ type: 'FORCE_TRADE_FAILED', playerId: actor.id, targetPlayerId: target.id });
    return;
  }

  // Swap in place so hand positions stay stable — position is the whole point of the
  // blind pick, so neither side's slots may shift underneath a future round's read.
  const giveCard = give.card;
  const takeCard = take.card;

  giveCard.ownerId = target.id;
  giveCard.locked = false; // does NOT lock for the receiver
  takeCard.ownerId = actor.id;
  takeCard.locked = true; // locks immediately for the trader

  actor.hand[give.index] = takeCard;
  target.hand[take.index] = giveCard;

  events.push({
    type: 'FORCE_TRADE',
    playerId: actor.id,
    targetPlayerId: target.id,
    givePosition: give.index + 1,
    takePosition: take.index + 1,
    giveCardId: giveCard.id,
    giveLabel: cardLabel(giveCard),
    takeCardId: takeCard.id,
    takeLabel: cardLabel(takeCard),
  });
}

function resolveReplace(state, record, events) {
  const player = getPlayer(state, record.playerId);
  const found = findCard(player, record.payload.cardId);
  if (!found || found.card.locked) return void fallbackLock(state, player, events, 'Replace');
  if (state.deck.length === 0) return void fallbackLock(state, player, events, 'Replace');

  const old = found.card;
  const drawn = state.deck.pop();
  drawn.ownerId = player.id;
  drawn.locked = true; // replacements auto-lock
  player.hand[found.index] = drawn; // in-place: hand length and positions are stable
  state.discard.push(old);

  events.push({
    type: 'REPLACE',
    playerId: player.id,
    position: found.index + 1,
    oldCardId: old.id,
    oldLabel: cardLabel(old),
    newCardId: drawn.id,
    newLabel: cardLabel(drawn),
  });
}

function resolveLock(state, record, events) {
  const player = getPlayer(state, record.playerId);
  const found = findCard(player, record.payload.cardId);
  if (!found || found.card.locked) return void fallbackLock(state, player, events, 'Lock');

  found.card.locked = true;
  events.push({
    type: 'LOCK',
    playerId: player.id,
    position: found.index + 1,
    cardId: found.card.id,
    label: cardLabel(found.card),
    auto: record.autoResolved ?? null,
  });
}

// Defensive only. Validation and resolution now happen in the same instant, so a chosen
// card cannot be traded out from under its owner between the two. Kept so the rules layer
// degrades to a legal move instead of silently skipping a turn if that ever changes.
function fallbackLock(state, player, events, what) {
  const card = lowestUnlockedCard(player);
  if (!card) {
    events.push({ type: 'NO_LEGAL_ACTION', playerId: player.id, intended: what });
    return;
  }
  card.locked = true;
  events.push({
    type: 'LOCK',
    playerId: player.id,
    position: player.hand.indexOf(card) + 1,
    cardId: card.id,
    label: cardLabel(card),
    auto: 'TARGET_TRADED_AWAY',
    intended: what,
  });
}

/**
 * Full-detail event text — for the log, tests and debugging. NOT for the shared screen:
 * it names card faces. The UI renders `redactEvent` instead between rounds.
 */
export function describeEvent(state, e) {
  const name = (id) => getPlayer(state, id)?.name ?? id;
  switch (e.type) {
    case 'FORCE_TRADE':
      return `${name(e.playerId)} force-traded ${e.giveLabel} to ${name(e.targetPlayerId)} for their position ${e.takePosition} (${e.takeLabel}, now locked).`;
    case 'FORCE_TRADE_FAILED':
      return `${name(e.playerId)}'s Force Trade could not resolve.`;
    case 'REPLACE':
      return `${name(e.playerId)} replaced ${e.oldLabel} with ${e.newLabel} (auto-locked).`;
    case 'LOCK':
      if (e.auto === 'TIMEOUT') return `${name(e.playerId)} locked ${e.label} (auto — timer expired).`;
      if (e.auto === 'TARGET_TRADED_AWAY')
        return `${name(e.playerId)}'s ${e.intended} target was traded away — locked ${e.label} instead.`;
      return `${name(e.playerId)} locked ${e.label}.`;
    case 'NO_LEGAL_ACTION':
      return `${name(e.playerId)}'s ${e.intended} had no legal target.`;
    default:
      return `${e.type}`;
  }
}

/**
 * Shared-screen event text. Says what happened and at which *position*, never which card —
 * Section 7 keeps faces private to their owner, and the trade's take is revealed only by
 * the trader looking at their own hand next round.
 */
export function redactEvent(state, e) {
  const name = (id) => getPlayer(state, id)?.name ?? id;
  switch (e.type) {
    case 'FORCE_TRADE':
      return `${name(e.playerId)} force-traded a card to ${name(e.targetPlayerId)}, taking their position ${e.takePosition} (locked immediately).`;
    case 'FORCE_TRADE_FAILED':
      return `${name(e.playerId)}'s Force Trade could not resolve.`;
    case 'REPLACE':
      return `${name(e.playerId)} replaced position ${e.position} with a fresh card (auto-locked).`;
    case 'LOCK':
      if (e.auto === 'TIMEOUT')
        return `${name(e.playerId)} ran out of time — auto-locked their lowest card (position ${e.position}).`;
      if (e.auto === 'TARGET_TRADED_AWAY')
        return `${name(e.playerId)}'s chosen card was traded away — locked position ${e.position} instead.`;
      return `${name(e.playerId)} locked position ${e.position}.`;
    case 'NO_LEGAL_ACTION':
      return `${name(e.playerId)} had no legal action.`;
    default:
      return `${e.type}`;
  }
}

/** Advance past the round summary into the next round (or leave a finished game alone). */
export function beginNextRound(state, now = 0) {
  if (state.phase !== 'ROUND_RESOLVING') return state;
  const next = clone(state);
  next.currentRound += 1;
  beginRound(next, now);
  return next;
}

// ---------------------------------------------------------------------------
// end game
// ---------------------------------------------------------------------------

// Section 6 — force-lock stragglers, score, pick a winner.
function endGame(state) {
  for (const p of state.players) {
    for (const c of p.hand) {
      if (!c.locked) {
        c.locked = true;
        state.log.push(`End of game: ${p.name}'s ${cardLabel(c)} force-locked.`);
      }
    }
    p.isActiveThisRound = false;
  }

  state.scores = computeScores(state);
  state.winnerId = determineWinner(state);
  state.phase = 'GAME_OVER';
  state.timerEndsAt = null;
  state.log.push(
    `GAME OVER — winner: ${getPlayer(state, state.winnerId).name} (${
      state.scores[state.winnerId]
    })`
  );
}

export function computeScores(state) {
  const scores = {};
  for (const p of state.players) {
    scores[p.id] = p.hand.reduce((sum, c) => sum + c.value, 0);
  }
  return scores;
}

/** Highest sum wins; ties go to the higher drunkenness value. */
export function determineWinner(state) {
  const scores = state.scores ?? computeScores(state);
  let best = null;
  for (const p of state.players) {
    if (best === null) {
      best = p;
      continue;
    }
    const s = scores[p.id];
    const bs = scores[best.id];
    if (s > bs || (s === bs && p.drunkenness > best.drunkenness)) best = p;
  }
  return best ? best.id : null;
}

export function checkGameOver(state) {
  return state.phase === 'GAME_OVER';
}

/** Ranked standings for the end screen. */
export function standings(state) {
  const scores = state.scores ?? computeScores(state);
  return state.players
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: scores[p.id],
      drunkenness: p.drunkenness,
      hand: p.hand.map((c) => cardLabel(c)),
      isWinner: p.id === state.winnerId,
    }))
    .sort((a, b) => b.score - a.score || b.drunkenness - a.drunkenness);
}

/**
 * Redacted view for the pass-and-play screen: only `viewerId` ever gets card faces.
 * The UI renders from this, so opponents' values are not merely hidden by CSS — they
 * are never in the DOM at all.
 */
export function viewFor(state, viewerId) {
  return {
    phase: state.phase,
    currentRound: state.currentRound,
    totalRounds: state.playerCount,
    activePlayerId: state.activePlayerId,
    awaitingPlayerId: awaitingPlayerId(state),
    viewerId,
    timerEndsAt: state.timerEndsAt,
    deckCount: state.deck.length,
    // Counts only. What is *in* the discard stays private: faces are never public, so the
    // pile is drawn face-down like every other card nobody owns.
    discardCount: state.discard.length,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      drunkenness: p.drunkenness,
      isActiveThisRound: p.isActiveThisRound,
      hasActed: Boolean(state.actionsThisRound[p.id]),
      hand: p.hand.map((c, i) =>
        p.id === viewerId
          ? { position: i + 1, id: c.id, label: cardLabel(c), value: c.value, locked: c.locked }
          : { position: i + 1, locked: c.locked }
      ),
    })),
  };
}
