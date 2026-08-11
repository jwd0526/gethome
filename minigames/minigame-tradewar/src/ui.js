// Trade War — UI layer. Renders state and forwards intents to the rules layer.
// It never decides legality itself: buttons call applyAction and display the result.

import {
  createGame,
  applyAction,
  resolveTimeout,
  beginNextRound,
  startTurnTimer,
  timeRemaining,
  awaitingPlayerId,
  getPlayer,
  standings,
  redactEvent,
  viewFor,
  checkGameOver,
} from './game.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// ui-local state (deliberately NOT part of GameState)
// ---------------------------------------------------------------------------

let state = null;
let screen = 'setup';
let playerCount = 4;
let trade = { giveCardId: null, targetPlayerId: null, takeIndex: null };
let tickHandle = null;

const now = () => Date.now();

// Seat groups around the felt, in the order opponents are dealt into them: the player to
// your left goes west, the one who acts just before you goes east, everyone else north.
const SEAT_GROUPS = ['north', 'west', 'east'];

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
    const nameInput = document.createElement('input');
    nameInput.id = `name-${i}`;
    nameInput.value = `Player ${i + 1}`;
    nameCell.appendChild(nameInput);

    const drunkCell = document.createElement('td');
    const drunkInput = document.createElement('input');
    drunkInput.id = `drunk-${i}`;
    drunkInput.type = 'number';
    drunkInput.min = '0';
    drunkInput.value = String(i);
    drunkCell.appendChild(drunkInput);

    tr.append(num, nameCell, drunkCell);
    rows.appendChild(tr);
  }
  $('count-4').setAttribute('aria-pressed', String(playerCount === 4));
  $('count-6').setAttribute('aria-pressed', String(playerCount === 6));
}

function startGame() {
  const names = [];
  const drunkenness = [];
  for (let i = 0; i < playerCount; i++) {
    names.push($(`name-${i}`).value.trim() || `Player ${i + 1}`);
    drunkenness.push(Number($(`drunk-${i}`).value) || 0);
  }
  const rawSeed = $('seed-input').value.trim();
  state = createGame({
    playerCount,
    names,
    drunkenness,
    seed: rawSeed === '' ? undefined : Number(rawSeed),
  });
  goToPass();
}

// ---------------------------------------------------------------------------
// screen routing
// ---------------------------------------------------------------------------

// 'result' is the post-action beat: same section as the turn, different contents.
const SECTION_FOR = {
  setup: 'setup', pass: 'pass', turn: 'turn', result: 'turn', summary: 'summary', over: 'over',
};

function show(name) {
  screen = name;
  const section = SECTION_FOR[name];
  for (const id of ['setup', 'pass', 'turn', 'summary', 'over']) {
    $(`screen-${id}`).classList.toggle('hidden', id !== section);
  }
  // Hiding the turn screen is not enough on a shared device: leaving the outgoing
  // player's cards in the document means the next player can read them straight out of
  // view-source. Tear the markup down whenever we are not on that screen.
  if (section !== 'turn') clearTurnScreen();
}

function clearTurnScreen() {
  $('own-hand').innerHTML = '';
  for (const group of SEAT_GROUPS) $(`seats-${group}`).innerHTML = '';
  $('you-name').textContent = '';
  $('deck-count').textContent = '—';
  $('discard-count').textContent = '—';
  $('turn-heading').textContent = '';
  $('turn-role').textContent = '';
  $('round-indicator').textContent = '';
  $('timer').textContent = '';
  $('result-panel').classList.add('hidden');
  $('result-text').textContent = '';
  $('turn-notice').textContent = '';
  $('turn-notice').classList.add('hidden');
  clearTradePanel();
  clearError();
}

function goToPass() {
  stopTick();
  const id = awaitingPlayerId(state);
  const player = getPlayer(state, id);
  $('pass-name').textContent = player.name;
  $('pass-name-2').textContent = player.name;
  $('pass-round').textContent =
    `Round ${state.currentRound} of ${state.playerCount} — active player: ` +
    `${getPlayer(state, state.activePlayerId).name}`;
  clearTrade();
  show('pass');
}

function revealHand() {
  // The 15s window opens only once the hand is actually on screen.
  state = startTurnTimer(state, now());
  show('turn');
  renderTurn();
  startTick();
}

function goToSummary() {
  stopTick();
  const summary = state.lastRoundSummary;
  $('summary-heading').textContent = `Round ${summary.round} resolved`;
  const list = $('summary-events');
  list.innerHTML = '';
  for (const e of summary.events) {
    const li = document.createElement('li');
    li.textContent = redactEvent(state, e);
    list.appendChild(li);
  }
  $('continue-round').textContent = checkGameOver(state) ? 'See results' : 'Continue';
  show('summary');
}

function continueFromSummary() {
  if (checkGameOver(state)) return goToGameOver();
  state = beginNextRound(state, now());
  goToPass();
}

function goToGameOver() {
  stopTick();
  const rows = $('results-rows');
  rows.innerHTML = '';
  for (const s of standings(state)) {
    const tr = document.createElement('tr');
    if (s.isWinner) tr.classList.add('winner');
    tr.dataset.playerId = s.id;

    const cells = [s.name, null, String(s.score), String(s.drunkenness),
      s.isWinner ? 'WINNER' : ''];
    for (const [i, text] of cells.entries()) {
      const td = document.createElement('td');
      if (i === 1) {
        // The hand is revealed as chips rather than a string. Spaces between them are
        // explicit so the cell still reads as whitespace-separated labels.
        td.className = 'hand-cell';
        for (const label of s.hand) {
          td.appendChild(buildChip(label));
          td.appendChild(document.createTextNode(' '));
        }
      } else {
        td.textContent = text;
      }
      if (i === 2) td.dataset.score = String(s.score);
      tr.appendChild(td);
    }
    rows.appendChild(tr);
  }
  $('game-log').textContent = state.log.join('\n');
  show('over');
}

// ---------------------------------------------------------------------------
// turn screen
// ---------------------------------------------------------------------------

function suitClass(label) {
  return label.includes('♥') || label.includes('♦') ? 'red' : 'black';
}

/**
 * The face of a real card: rank+suit in the corners, the suit large in the middle.
 * Purely presentational — everything it draws comes from the label the view already
 * gave us, so it can never reveal something the projection withheld.
 */
function buildCardFace(label) {
  const suit = label.slice(-1);

  const faceEl = document.createElement('div');
  faceEl.className = `card-face ${suitClass(label)}`;

  // Kept as `.face` with the bare label as its text: the corner index *is* the label.
  const index = document.createElement('div');
  index.className = 'face';
  index.textContent = label;

  const pip = document.createElement('div');
  pip.className = 'pip';
  pip.textContent = suit;

  const corner = document.createElement('div');
  corner.className = 'index-br';
  corner.textContent = label;

  faceEl.append(index, pip, corner);
  return faceEl;
}

/** A small card face for lists — the end-screen reveal and the trade buttons. */
function buildChip(label) {
  const chip = document.createElement('span');
  chip.className = `chip ${suitClass(label)}`;
  chip.textContent = label;
  return chip;
}

/** A face-down card. Deliberately textless — the pattern is drawn in CSS. */
function buildCardBack() {
  const back = document.createElement('div');
  back.className = 'card-back';
  return back;
}

function renderTurn() {
  const viewerId = awaitingPlayerId(state);
  const view = viewFor(state, viewerId);
  const me = view.players.find((p) => p.id === viewerId);
  const activeName = view.players.find((p) => p.id === view.activePlayerId).name;

  $('round-indicator').textContent =
    `Round ${view.currentRound} of ${view.totalRounds} — Active Player: ${activeName}`;
  $('turn-heading').textContent = `${me.name}, choose your action`;
  $('turn-role').textContent = me.isActiveThisRound
    ? 'You are the active player this round — Force Trade is available to you.'
    : 'You are not the active player this round — Lock or Replace only.';

  // If the active player already traded into this hand this round, say so — the swap has
  // resolved, so the hand on screen is not the one this player last saw.
  const tradedOnMe = state.roundEvents.find(
    (e) => e.type === 'FORCE_TRADE' && e.targetPlayerId === viewerId
  );
  const notice = $('turn-notice');
  notice.classList.toggle('hidden', !tradedOnMe);
  if (tradedOnMe) {
    notice.textContent =
      `${getPlayer(state, tradedOnMe.playerId).name} force-traded you: they took your ` +
      `position ${tradedOnMe.takePosition} and left ${tradedOnMe.giveLabel} there. ` +
      `It is unlocked, so you can still act on it.`;
  }

  $('you-name').textContent = me.name;
  renderPiles(view);
  renderOwnHand(me, { changed: tradedOnMe ? { [tradedOnMe.giveCardId]: 'TRADED TO YOU' } : {} });
  renderOtherHands(view, viewerId);

  // Force Trade controls exist in the DOM only for the active player — a non-active
  // player has no trade buttons to find, not merely hidden ones.
  const isActive = me.isActiveThisRound;
  $('trade-panel').classList.toggle('hidden', !isActive);
  if (isActive) renderTradePanel(view, me);
  else clearTradePanel();

  renderTimer();
}

/**
 * Your seat: live cards in one zone, locked ones banked in a second.
 *
 * Both zones stay inside #own-hand — a locked card is still yours, still on the table and
 * still scored, so hiding it would be lying about the game state. Only its *reach*
 * changes, which is what the split says.
 *
 * `opts.interactive` false renders the hand read-only (the result beat).
 * `opts.changed` maps cardId -> badge text for the card that just changed.
 */
function renderOwnHand(me, opts = {}) {
  const { interactive = true, changed = {} } = opts;
  const container = $('own-hand');
  container.innerHTML = '';

  const live = me.hand.filter((c) => !c.locked);
  const locked = me.hand.filter((c) => c.locked);

  container.append(
    buildZone('live', 'In play', `${live.length} card${live.length === 1 ? '' : 's'} you can still act on`,
      live, { interactive, changed }),
    buildZone('locked', 'Locked', 'final — cannot be replaced, traded away or unlocked',
      locked, { interactive, changed })
  );
}

function buildZone(kind, title, note, cards, opts) {
  const zone = document.createElement('div');
  zone.className = `zone zone-${kind}`;
  zone.dataset.zone = kind;

  const label = document.createElement('div');
  label.className = 'zone-label';
  label.append(title, Object.assign(document.createElement('span'), {
    className: 'zone-note', textContent: ` — ${note}`,
  }));

  const row = document.createElement('div');
  row.className = 'zone-cards';
  if (cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'zone-empty';
    empty.textContent = kind === 'locked' ? 'nothing locked yet' : 'no cards left to act on';
    row.appendChild(empty);
  }
  for (const card of cards) row.appendChild(buildOwnCard(card, opts));

  zone.append(label, row);
  return zone;
}

function buildOwnCard(card, opts = {}) {
  const { interactive = true, changed = {} } = opts;
  const badge = changed[card.id];

  const div = document.createElement('div');
  div.className = `card${card.locked ? ' locked' : ''}${badge ? ' changed' : ''}`;
  div.dataset.cardId = card.id;
  div.dataset.position = String(card.position);
  div.dataset.locked = String(card.locked);
  if (badge) div.dataset.changed = 'true';

  const pos = document.createElement('div');
  pos.className = 'pos';
  pos.textContent = `position ${card.position}`;

  const val = document.createElement('div');
  val.className = 'val';
  val.textContent = `value ${card.value}`;

  div.append(pos, buildCardFace(card.label), val);

  if (badge) {
    const tag = document.createElement('div');
    tag.className = 'change-tag';
    tag.textContent = badge;
    div.appendChild(tag);
  }

  if (card.locked) {
    // The zone it sits in already says locked; the per-card tag is kept for the result
    // beat, where the badge is what the player is being pointed at.
    if (!badge) {
      const tag = document.createElement('div');
      tag.className = 'locked-tag';
      tag.textContent = 'LOCKED';
      div.appendChild(tag);
    }
  } else if (!interactive) {
    const tag = document.createElement('div');
    tag.className = 'val';
    tag.textContent = 'unlocked';
    div.appendChild(tag);
  } else {
    const actions = document.createElement('div');
    actions.className = 'actions';

    const lockBtn = document.createElement('button');
    lockBtn.textContent = 'Lock';
    lockBtn.dataset.action = 'lock';
    lockBtn.dataset.cardId = card.id;
    lockBtn.addEventListener('click', () => submit('LOCK', { cardId: card.id }));

    const replaceBtn = document.createElement('button');
    replaceBtn.textContent = 'Replace';
    replaceBtn.dataset.action = 'replace';
    replaceBtn.dataset.cardId = card.id;
    replaceBtn.addEventListener('click', () => submit('REPLACE', { cardId: card.id }));

    actions.append(lockBtn, replaceBtn);
    div.appendChild(actions);
  }
  return div;
}

/**
 * Deal the opponents into the three seat groups, in seat order starting from the player
 * to the viewer's left: first west, last east, the rest along the north edge. Works for
 * 4 and 6 players without a per-count layout.
 */
function seatAssignment(opponentCount) {
  if (opponentCount <= 1) return ['north'];
  if (opponentCount === 2) return ['west', 'east'];
  return ['west', ...Array(opponentCount - 2).fill('north'), 'east'];
}

function renderOtherHands(view, viewerId) {
  for (const group of SEAT_GROUPS) $(`seats-${group}`).innerHTML = '';

  // Rotate so the seat after the viewer comes first: the table keeps a consistent sense
  // of who is on your left even though the device is passed around.
  const order = view.players.map((p) => p.id);
  const start = order.indexOf(viewerId);
  const opponents = order
    .slice(start + 1)
    .concat(order.slice(0, start))
    .map((id) => view.players.find((p) => p.id === id));
  const groups = seatAssignment(opponents.length);

  for (const [i, p] of opponents.entries()) {
    const wrap = document.createElement('div');
    wrap.className = 'opponent seat';
    wrap.dataset.playerId = p.id;
    if (p.isActiveThisRound) wrap.dataset.active = 'true';

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = p.name;
    if (p.isActiveThisRound) {
      const tag = document.createElement('span');
      tag.className = 'active-tag';
      tag.textContent = '  [ACTIVE]';
      who.appendChild(tag);
    }
    if (p.hasActed) {
      const tag = document.createElement('span');
      tag.className = 'acted-tag';
      tag.textContent = '  [acted]';
      who.appendChild(tag);
    }

    const row = document.createElement('div');
    row.className = 'row';
    // Slots stay in position order even once some are locked. Force Trade is a blind pick
    // *by position*, so reordering an opponent's cards to group the locked ones would
    // scramble the only handle the trader has on them; they are set apart in place
    // instead — greyed, dropped a few pixels, and labelled.
    for (const slot of p.hand) {
      // Face-down: position + locked state only. No id, no rank, no value.
      const s = document.createElement('div');
      s.className = `slot${slot.locked ? ' locked' : ''}`;
      s.dataset.position = String(slot.position);
      s.dataset.locked = String(slot.locked);
      // The back is a sibling, not a wrapper: the slot's own text stays exactly the
      // position (and 'locked'), which is all anyone may learn from it.
      s.appendChild(buildCardBack());
      const posLabel = document.createElement('div');
      posLabel.className = 'slot-pos';
      posLabel.textContent = `[${slot.position}]`;
      s.appendChild(posLabel);
      if (slot.locked) {
        const tag = document.createElement('div');
        tag.className = 'slot-locked';
        tag.textContent = 'locked';
        s.appendChild(tag);
      }
      row.appendChild(s);
    }

    wrap.append(who, row);
    $(`seats-${groups[i]}`).appendChild(wrap);
  }
}

function renderPiles(view) {
  // Hand size scales with the player count, and so does how tight the seats are.
  $('table').dataset.players = String(view.totalRounds);
  $('deck-count').textContent = String(view.deckCount);
  $('discard-count').textContent = String(view.discardCount);
  $('deck-pile').classList.toggle('empty', view.deckCount === 0);
  $('discard-pile').classList.toggle('empty', view.discardCount === 0);
}

function renderTradePanel(view, me) {
  const giveRow = $('trade-give');
  giveRow.innerHTML = '';
  for (const card of me.hand) {
    if (card.locked) continue;
    const b = document.createElement('button');
    b.append(buildChip(card.label), ` (pos ${card.position})`);
    b.dataset.tradeGive = card.id;
    b.classList.toggle('selected', trade.giveCardId === card.id);
    b.addEventListener('click', () => {
      trade.giveCardId = card.id;
      bumpTimer();
      renderTurn();
    });
    giveRow.appendChild(b);
  }

  const targetRow = $('trade-target');
  targetRow.innerHTML = '';
  for (const p of view.players) {
    if (p.id === me.id) continue;
    const b = document.createElement('button');
    b.textContent = p.name;
    b.dataset.tradeTarget = p.id;
    b.classList.toggle('selected', trade.targetPlayerId === p.id);
    b.disabled = !p.hand.some((c) => !c.locked);
    b.addEventListener('click', () => {
      trade.targetPlayerId = p.id;
      trade.takeIndex = null;
      bumpTimer();
      renderTurn();
    });
    targetRow.appendChild(b);
  }

  const takeRow = $('trade-take');
  takeRow.innerHTML = '';
  if (trade.targetPlayerId) {
    const target = view.players.find((p) => p.id === trade.targetPlayerId);
    for (const slot of target.hand) {
      const b = document.createElement('button');
      // Blind: the button shows a position, never a card.
      b.textContent = slot.locked ? `[${slot.position}] locked` : `[${slot.position}]`;
      b.dataset.tradeTake = String(slot.position - 1);
      b.disabled = slot.locked;
      b.classList.toggle('selected', trade.takeIndex === slot.position - 1);
      b.addEventListener('click', () => {
        trade.takeIndex = slot.position - 1;
        bumpTimer();
        renderTurn();
      });
      takeRow.appendChild(b);
    }
  } else {
    const hint = document.createElement('span');
    hint.className = 'sub';
    hint.textContent = 'Pick a target player first.';
    takeRow.appendChild(hint);
  }

  $('confirm-trade').disabled =
    !(trade.giveCardId && trade.targetPlayerId && trade.takeIndex !== null);
}

function clearTrade() {
  trade = { giveCardId: null, targetPlayerId: null, takeIndex: null };
}

function clearTradePanel() {
  $('trade-give').innerHTML = '';
  $('trade-target').innerHTML = '';
  $('trade-take').innerHTML = '';
  $('confirm-trade').disabled = true;
}

// Section 7: the 15s clock restarts at each new decision point, including each
// step of the Force Trade flow.
function bumpTimer() {
  state = startTurnTimer(state, now());
}

// ---------------------------------------------------------------------------
// submitting
// ---------------------------------------------------------------------------

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError() {
  $('error').classList.add('hidden');
  $('error').textContent = '';
}

function submit(actionType, payload) {
  clearError();
  const playerId = awaitingPlayerId(state);
  const result = applyAction(state, { playerId, actionType, payload }, now());
  if (!result.success) {
    showError(result.error);
    return false;
  }
  state = result.newState;
  afterSubmission();
  return true;
}

function confirmTrade() {
  submit('FORCE_TRADE', {
    giveCardId: trade.giveCardId,
    targetPlayerId: trade.targetPlayerId,
    takeIndex: trade.takeIndex,
  });
}

// The acting player sees their own card lock / flip / swap resolve before the device
// moves on. Nothing advances until they acknowledge it.
function afterSubmission() {
  stopTick();
  clearTrade();
  clearError();
  show('result');
  renderResult();
}

function renderResult() {
  const event = state.lastEvent;
  const actorId = event.playerId;
  const view = viewFor(state, actorId);
  const me = view.players.find((p) => p.id === actorId);

  $('round-indicator').textContent =
    `Round ${view.currentRound} of ${view.totalRounds} — Active Player: ` +
    `${view.players.find((p) => p.id === view.activePlayerId).name}`;
  $('timer').textContent = '';
  $('turn-heading').textContent = `${me.name} — action resolved`;
  $('turn-role').textContent = '';
  $('turn-notice').classList.add('hidden');
  $('trade-panel').classList.add('hidden');
  clearTradePanel();

  $('you-name').textContent = me.name;
  renderPiles(view);
  renderOwnHand(me, { interactive: false, changed: changedCards(event) });
  renderOtherHands(view, actorId);

  $('result-text').textContent = resultText(state, event);
  $('result-panel').classList.remove('hidden');
}

/** Which card in the actor's hand to spotlight, and what to call it. */
function changedCards(event) {
  switch (event.type) {
    case 'LOCK':
      return { [event.cardId]: event.auto === 'TIMEOUT' ? 'AUTO-LOCKED' : 'JUST LOCKED' };
    case 'REPLACE':
      return { [event.newCardId]: 'NEW CARD' };
    case 'FORCE_TRADE':
      return { [event.takeCardId]: 'TAKEN — LOCKED' };
    default:
      return {};
  }
}

function resultText(st, event) {
  const name = (id) => getPlayer(st, id).name;
  switch (event.type) {
    case 'LOCK':
      return event.auto === 'TIMEOUT'
        ? `Time ran out. Auto-locked your lowest card, ${event.label} (position ${event.position}). It is final.`
        : `Locked ${event.label} at position ${event.position}. It is final — it cannot be replaced or traded away.`;
    case 'REPLACE':
      return `Discarded ${event.oldLabel} and drew ${event.newLabel} into position ${event.position}. Replacements lock immediately, so this one is final.`;
    case 'FORCE_TRADE':
      return `Gave ${event.giveLabel} to ${name(event.targetPlayerId)} and took their position ${event.takePosition}: ${event.takeLabel}. It locked immediately. ${name(event.targetPlayerId)} still gets their own action this round.`;
    default:
      return 'Action resolved.';
  }
}

function continueFromResult() {
  if (state.phase === 'AWAITING_ACTIONS') goToPass();
  else goToSummary(); // ROUND_RESOLVING or GAME_OVER
}

// ---------------------------------------------------------------------------
// timer
// ---------------------------------------------------------------------------

function renderTimer() {
  const remaining = timeRemaining(state, now());
  const el = $('timer');
  if (remaining === null) {
    el.textContent = '';
    return;
  }
  const secs = Math.ceil(remaining / 1000);
  el.textContent = `${secs}s`;
  el.classList.toggle('urgent', secs <= 5);
}

function startTick() {
  stopTick();
  tickHandle = setInterval(() => {
    if (screen !== 'turn' || state.phase !== 'AWAITING_ACTIONS') return;
    renderTimer();
    if (timeRemaining(state, now()) === 0) {
      const result = resolveTimeout(state, now());
      if (result.success) {
        state = result.newState;
        afterSubmission();
      }
    }
  }, 200);
}

function stopTick() {
  if (tickHandle !== null) clearInterval(tickHandle);
  tickHandle = null;
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

$('count-4').addEventListener('click', () => { playerCount = 4; renderSetupRows(); });
$('count-6').addEventListener('click', () => { playerCount = 6; renderSetupRows(); });
$('start-game').addEventListener('click', startGame);
$('reveal-hand').addEventListener('click', revealHand);
$('result-continue').addEventListener('click', continueFromResult);
$('confirm-trade').addEventListener('click', confirmTrade);
$('reset-trade').addEventListener('click', () => { clearTrade(); renderTurn(); });
$('continue-round').addEventListener('click', continueFromSummary);
$('new-game').addEventListener('click', () => {
  state = null;
  clearTrade();
  show('setup');
  renderSetupRows();
});

renderSetupRows();
show('setup');

// Test hook — lets the browser suite read authoritative state instead of
// re-deriving it from the DOM.
window.__tw = {
  getState: () => state,
  getScreen: () => screen,
  // Force the current turn's timer to expire immediately (no 15s wall-clock wait in tests).
  expireTimer: () => { state = startTurnTimer(state, now() - state.turnDurationMs - 1); },
  // Probe the rules layer directly, bypassing the UI's own affordances, to prove that
  // legality is enforced by the logic and not merely by which buttons get rendered.
  // Read-only: the returned states are discarded.
  tryActions: (actions) =>
    actions.map((a) => {
      const r = applyAction(state, a, now());
      return {
        label: `${a.actionType} ${JSON.stringify(a.payload)}`,
        success: r.success,
        error: r.error ?? null,
      };
    }),
};
