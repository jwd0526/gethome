// End-to-end verification against the real UI in Chromium.
// Run: node tests/browser-tests.js   (starts its own static server on :8080)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TW_PORT ?? 8137);
const URL = `http://127.0.0.1:${PORT}/index.html`;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const results = [];
let failures = 0;
let assertions = 0;

async function check(name, fn) {
  const before = failures;
  console.log(`\n--- ${name}`);
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`   ✗ threw: ${err.message}`);
    if (process.env.TW_STACK) console.log(err.stack);
  }
  const passed = failures === before;
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
}

function ok(cond, msg) {
  assertions++;
  if (!cond) {
    failures++;
    console.log(`   ✗ ${msg}`);
  }
  return cond;
}

function eq(a, b, msg) {
  return ok(a === b, `${msg}\n       expected: ${JSON.stringify(b)}\n       actual:   ${JSON.stringify(a)}`);
}

const note = (m) => console.log(`   · ${m}`);

// ---------------------------------------------------------------------------
// page driving
// ---------------------------------------------------------------------------

const screenOf = (page) => page.evaluate(() => window.__tw.getScreen());
const stateOf = (page) => page.evaluate(() => window.__tw.getState());

async function setupGame(page, { playerCount, seed, names, drunk }) {
  await page.goto(URL);
  await page.click(`#count-${playerCount}`);
  if (seed !== undefined) await page.fill('#seed-input', String(seed));
  for (let i = 0; i < playerCount; i++) {
    if (names) await page.fill(`#name-${i}`, names[i]);
    if (drunk) await page.fill(`#drunk-${i}`, String(drunk[i]));
  }
  await page.click('#start-game');
  eq(await screenOf(page), 'pass', 'landed on the pass interstitial after starting');
}

/** Read the turn screen exactly as a human sees it. */
async function readTurn(page) {
  return page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent ?? '';
    const ownHand = [...document.querySelectorAll('#own-hand .card')].map((el) => ({
      cardId: el.dataset.cardId,
      position: Number(el.dataset.position),
      locked: el.dataset.locked === 'true',
      label: el.querySelector('.face').textContent,
      hasLockBtn: !!el.querySelector('button[data-action="lock"]'),
      hasReplaceBtn: !!el.querySelector('button[data-action="replace"]'),
    }));
    const others = [...document.querySelectorAll('#other-hands .opponent')].map((el) => ({
      playerId: el.dataset.playerId,
      name: el.querySelector('.who').textContent,
      slots: [...el.querySelectorAll('.slot')].map((s) => s.textContent),
    }));
    return {
      roundIndicator: text('#round-indicator'),
      heading: text('#turn-heading'),
      role: text('#turn-role'),
      timer: text('#timer'),
      tradePanelHidden: document.getElementById('trade-panel').classList.contains('hidden'),
      tradeButtonCount: document.querySelectorAll(
        '[data-trade-give],[data-trade-target],[data-trade-take]'
      ).length,
      ownHand,
      others,
    };
  });
}

async function reveal(page) {
  await page.click('#reveal-hand');
  await page.waitForSelector('#screen-turn:not(.hidden)');
}

/** Click through whatever beats stand between here and the next player's turn screen. */
async function advanceToTurn(page) {
  for (let i = 0; i < 20; i++) {
    const s = await screenOf(page);
    if (s === 'turn' || s === 'over') return s;
    if (s === 'result') await page.click('#result-continue');
    else if (s === 'summary') await page.click('#continue-round');
    else if (s === 'pass') await reveal(page);
    else throw new Error(`unexpected screen: ${s}`);
  }
  throw new Error('could not reach a turn screen');
}

async function clickLock(page, cardId) {
  await page.click(`button[data-action="lock"][data-card-id="${CSS_esc(cardId)}"]`);
}
async function clickReplace(page, cardId) {
  await page.click(`button[data-action="replace"][data-card-id="${CSS_esc(cardId)}"]`);
}
// Card ids contain suit glyphs; quote them for the attribute selector.
const CSS_esc = (s) => s.replace(/"/g, '\\"');

async function clickForceTrade(page, { giveCardId, targetPlayerId, takeIndex }) {
  await page.click(`[data-trade-give="${CSS_esc(giveCardId)}"]`);
  await page.click(`[data-trade-target="${targetPlayerId}"]`);
  await page.click(`[data-trade-take="${takeIndex}"]`);
  await page.click('#confirm-trade');
}

/**
 * Play until the game-over screen, asking `decide(turn, state, page)` what to do on each
 * turn. Every step goes through real clicks. Returns a transcript.
 */
async function playThrough(page, decide, opts = {}) {
  const transcript = { rounds: [], actives: [], usage: { LOCK: new Set(), REPLACE: new Set(), FORCE_TRADE: new Set() } };
  let guard = 0;

  for (;;) {
    if (++guard > 400) throw new Error('UI game did not terminate');
    const screen = await screenOf(page);

    if (screen === 'over') break;

    if (screen === 'pass') {
      if (opts.onPass) await opts.onPass(page);
      await reveal(page);
      continue;
    }
    if (screen === 'result') {
      if (opts.onResult) await opts.onResult(page);
      await page.click('#result-continue');
      continue;
    }
    if (screen === 'summary') {
      if (opts.onSummary) await opts.onSummary(page);
      await page.click('#continue-round');
      continue;
    }

    const state = await stateOf(page);
    const turn = await readTurn(page);
    const viewerId = state.submissionOrder[state.submissionIndex];
    const round = state.currentRound;

    if (!transcript.actives[round - 1]) {
      transcript.actives[round - 1] = state.activePlayerId;
      transcript.rounds.push({ round, indicator: turn.roundIndicator });
    }
    if (opts.onTurn) await opts.onTurn(page, turn, state, viewerId);

    const decision = await decide(turn, state, viewerId, page);
    if (decision === 'WAIT') continue; // caller handles it (e.g. timer expiry)

    transcript.usage[decision.actionType].add(viewerId);
    if (decision.actionType === 'LOCK') await clickLock(page, decision.cardId);
    else if (decision.actionType === 'REPLACE') await clickReplace(page, decision.cardId);
    else await clickForceTrade(page, decision);
  }
  return transcript;
}

async function readResults(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#results-rows tr')].map((tr) => ({
      playerId: tr.dataset.playerId,
      name: tr.children[0].textContent,
      hand: tr.children[1].textContent.trim().split(/\s+/),
      score: Number(tr.children[2].textContent),
      drunk: Number(tr.children[3].textContent),
      marker: tr.children[4].textContent,
    }))
  );
}

// A decision policy expressible as clicks: active player force-trades, others alternate.
function mixedDecision(turn, state, viewerId) {
  const unlocked = turn.ownHand.filter((c) => !c.locked);
  const isActive = viewerId === state.activePlayerId;

  if (isActive && !turn.tradePanelHidden) {
    const target = state.players.find(
      (p) => p.id !== viewerId && p.hand.some((c) => !c.locked)
    );
    if (target && unlocked.length) {
      return {
        actionType: 'FORCE_TRADE',
        giveCardId: unlocked[0].cardId,
        targetPlayerId: target.id,
        takeIndex: target.hand.findIndex((c) => !c.locked),
      };
    }
  }
  const seat = state.players.findIndex((p) => p.id === viewerId);
  const useReplace = (seat + state.currentRound) % 2 === 0;
  return { actionType: useReplace ? 'REPLACE' : 'LOCK', cardId: unlocked[0].cardId };
}

// ---------------------------------------------------------------------------

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
});

// Don't start clicking against a server that never came up — a 404 would otherwise show
// up as eight unrelated selector timeouts.
await (async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) {
        const js = await fetch(`http://127.0.0.1:${PORT}/src/game.js`);
        if (js.ok) return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error(`static server never served ${URL} — is port ${PORT} taken? (set TW_PORT)`);
})();
console.log(`serving ${ROOT} at ${URL}`);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => {
  failures++;
  console.log(`   ✗ page error: ${err.message}`);
});

try {
  // -------------------------------------------------------------------------
  // CHECK 1 + 2 + 4 — full games at both player counts, all actions, rotation
  // -------------------------------------------------------------------------

  for (const playerCount of [4, 6]) {
    await check(`CHECK 1/2/4 (UI) — full ${playerCount}-player game clicked start to finish`, async () => {
      const names = Array.from({ length: playerCount }, (_, i) => `P${i + 1}`);
      await setupGame(page, { playerCount, seed: 555 + playerCount, names, drunk: names.map((_, i) => i) });

      const privacyViolations = [];
      const nonActiveTradeControls = [];

      const transcript = await playThrough(page, mixedDecision, {
        onTurn: async (pg, turn, state, viewerId) => {
          // CHECK 4: only the active player has Force Trade controls in the DOM.
          if (viewerId !== state.activePlayerId) {
            if (!turn.tradePanelHidden || turn.tradeButtonCount > 0) {
              nonActiveTradeControls.push({ round: state.currentRound, viewerId, count: turn.tradeButtonCount });
            }
          }
          // CHECK 10: nobody else's card faces are anywhere in the document.
          const leaked = await pg.evaluate((vid) => {
            const st = window.__tw.getState();
            const html = document.documentElement.innerHTML;
            const bad = [];
            for (const p of st.players) {
              if (p.id === vid) continue;
              for (const c of p.hand) if (html.includes(c.id)) bad.push(`${p.id}:${c.id}`);
            }
            return bad;
          }, viewerId);
          if (leaked.length) privacyViolations.push({ viewerId, leaked });
        },
      });

      // Rotation
      eq(transcript.actives.length, playerCount, `ran exactly ${playerCount} rounds`);
      eq(new Set(transcript.actives).size, playerCount, 'every player was the active player exactly once');
      note(`round indicators seen:`);
      for (const r of transcript.rounds) note(`    "${r.indicator}"`);

      // Action coverage
      for (const type of ['LOCK', 'REPLACE', 'FORCE_TRADE']) {
        ok(transcript.usage[type].size >= 2, `${type} clicked by >=2 distinct players (was ${transcript.usage[type].size})`);
        note(`${type} clicked by: ${[...transcript.usage[type]].join(', ')}`);
      }

      eq(nonActiveTradeControls.length, 0, 'no non-active player ever had Force Trade controls');
      eq(privacyViolations.length, 0, 'no opponent card ever appeared in the DOM');

      eq(await screenOf(page), 'over', 'reached the end screen');
      const rows = await readResults(page);
      eq(rows.length, playerCount, 'end screen lists every player');
    });
  }

  // -------------------------------------------------------------------------
  // CHECK 10 — hand privacy at the pass interstitial
  // -------------------------------------------------------------------------

  await check('CHECK 10 (UI) — the incoming hand is not on screen before "reveal"', async () => {
    await setupGame(page, { playerCount: 4, seed: 4242 });
    let interstitialsChecked = 0;
    let violations = 0;

    await playThrough(page, mixedDecision, {
      onPass: async (pg) => {
        const r = await pg.evaluate(() => {
          const st = window.__tw.getState();
          const nextId = st.submissionOrder[st.submissionIndex];
          const next = st.players.find((p) => p.id === nextId);
          const visible = document.body.innerText;
          const html = document.documentElement.innerHTML;
          return {
            nextName: next.name,
            turnScreenHidden: document.getElementById('screen-turn').classList.contains('hidden'),
            // Not one card face of ANY player may be on screen or in the document.
            visibleLeaks: st.players.flatMap((p) => p.hand).filter((c) => visible.includes(c.id)).map((c) => c.id),
            domLeaks: st.players.flatMap((p) => p.hand).filter((c) => html.includes(c.id)).map((c) => c.id),
            promptsFor: document.getElementById('pass-name').textContent,
          };
        });
        interstitialsChecked++;
        if (!r.turnScreenHidden || r.visibleLeaks.length || r.domLeaks.length) {
          violations++;
          console.log(`   ✗ leak at interstitial for ${r.nextName}: ${JSON.stringify(r)}`);
        }
        if (r.promptsFor !== r.nextName) {
          violations++;
          console.log(`   ✗ interstitial named ${r.promptsFor}, expected ${r.nextName}`);
        }
      },
    });

    ok(interstitialsChecked >= 16, `checked every handoff (${interstitialsChecked} interstitials)`);
    eq(violations, 0, 'no hand was visible or present in the DOM before its reveal step');
  });

  // -------------------------------------------------------------------------
  // CHECK 3 — Force Trade through the UI
  // -------------------------------------------------------------------------

  await check('CHECK 3 (UI) — blind slots show no values; trade resolves by position', async () => {
    await setupGame(page, { playerCount: 4, seed: 4242, names: ['Ann', 'Bo', 'Cy', 'Di'] });
    await reveal(page);

    const before = await stateOf(page);
    const turn = await readTurn(page);
    const traderId = before.activePlayerId;
    eq(before.submissionOrder[0], traderId, 'active player acts first in pass-and-play order');
    ok(!turn.tradePanelHidden, 'active player sees the Force Trade panel');

    // Slots must be position-only.
    for (const other of turn.others) {
      for (const [i, slotText] of other.slots.entries()) {
        ok(/^\[\d+\](locked)?$/.test(slotText.trim()), `opponent slot renders as position only: "${slotText}"`);
        eq(slotText.trim().startsWith(`[${i + 1}]`), true, 'slot is labelled with its 1-indexed position');
      }
    }

    const targetId = before.players.find((p) => p.id !== traderId).id;
    const target = before.players.find((p) => p.id === targetId);
    const POSITION = 3;
    const physicalCard = target.hand[POSITION - 1];
    const giveCard = before.players.find((p) => p.id === traderId).hand.find((c) => !c.locked);
    note(`${before.players.find(p=>p.id===traderId).name} gives ${giveCard.id}; ${target.name} slot ${POSITION} physically holds ${physicalCard.id}`);

    // The take buttons carry only an index — no card identity.
    await page.click(`[data-trade-give="${CSS_esc(giveCard.id)}"]`);
    await page.click(`[data-trade-target="${targetId}"]`);
    const takeLabels = await page.$$eval('[data-trade-take]', (els) => els.map((e) => e.textContent));
    for (const t of takeLabels) ok(/^\[\d+\]( locked)?$/.test(t), `take button is blind: "${t}"`);

    await page.click(`[data-trade-take="${POSITION - 1}"]`);
    await page.click('#confirm-trade');

    // Finish the round so the trade resolves.
    for (;;) {
      const s = await screenOf(page);
      if (s === 'summary') break;
      if (s === 'pass') { await reveal(page); continue; }
      if (s === 'result') { await page.click('#result-continue'); continue; }
      const t = await readTurn(page);
      await clickLock(page, t.ownHand.find((c) => !c.locked).cardId);
    }

    const after = await stateOf(page);
    const trader = after.players.find((p) => p.id === traderId);
    const receiver = after.players.find((p) => p.id === targetId);

    const taken = trader.hand.find((c) => c.id === physicalCard.id);
    ok(taken, 'trader received the card that physically occupied position 3');
    eq(taken?.locked, true, 'taken card locked immediately for the trader');
    const given = receiver.hand.find((c) => c.id === giveCard.id);
    ok(given, 'receiver got the given card');
    eq(given?.locked, false, 'given card is unlocked for the receiver');
    eq(receiver.hand[POSITION - 1].id, giveCard.id, 'positions stayed stable (in-place swap)');

    // The shared summary must not name any card.
    const summaryText = await page.$eval('#summary-events', (el) => el.innerText);
    const named = [...before.players.flatMap((p) => p.hand)].filter((c) => summaryText.includes(c.id));
    eq(named.length, 0, 'round summary names positions, never card faces');
    note(`summary: ${summaryText.replace(/\n/g, ' | ')}`);
  });

  // -------------------------------------------------------------------------
  // CHECK 6 — locked-card enforcement in the UI
  // -------------------------------------------------------------------------

  await check('CHECK 6 (UI) — locked cards offer no controls and reject actions', async () => {
    await setupGame(page, { playerCount: 4, seed: 5150 });
    // Round 1: everyone locks their first card.
    for (;;) {
      const s = await screenOf(page);
      if (s === 'summary') break;
      if (s === 'pass') { await reveal(page); continue; }
      if (s === 'result') { await page.click('#result-continue'); continue; }
      const t = await readTurn(page);
      await clickLock(page, t.ownHand.find((c) => !c.locked).cardId);
    }
    await page.click('#continue-round');
    await reveal(page);

    const turn = await readTurn(page);
    const lockedCards = turn.ownHand.filter((c) => c.locked);
    ok(lockedCards.length >= 1, `viewer has ${lockedCards.length} locked card(s) in round 2`);
    for (const c of lockedCards) {
      eq(c.hasLockBtn, false, `no Lock button rendered for locked ${c.label}`);
      eq(c.hasReplaceBtn, false, `no Replace button rendered for locked ${c.label}`);
    }
    const lockedTags = await page.$$eval('#own-hand .locked-tag', (els) => els.map((e) => e.textContent));
    eq(lockedTags.length, lockedCards.length, 'every locked card shows a LOCKED tag');

    // Opponent locked slots are not selectable as trade targets.
    const st = await stateOf(page);
    const viewerId = st.submissionOrder[st.submissionIndex];
    if (viewerId === st.activePlayerId) {
      const targetId = st.players.find((p) => p.id !== viewerId).id;
      await page.click(`[data-trade-give="${CSS_esc(turn.ownHand.find((c) => !c.locked).cardId)}"]`);
      await page.click(`[data-trade-target="${targetId}"]`);
      const buttons = await page.$$eval('[data-trade-take]', (els) =>
        els.map((e) => ({ idx: e.dataset.tradeTake, disabled: e.disabled, text: e.textContent }))
      );
      const target = st.players.find((p) => p.id === targetId);
      for (const b of buttons) {
        eq(b.disabled, target.hand[Number(b.idx)].locked, `slot ${Number(b.idx) + 1} disabled iff locked`);
      }
      note(`take buttons: ${buttons.map((b) => `${b.text}${b.disabled ? '(disabled)' : ''}`).join(' ')}`);
    }

    // And the rules layer rejects it even if the UI is bypassed.
    const rejections = await page.evaluate(() => {
      const st = window.__tw.getState();
      const vid = st.submissionOrder[st.submissionIndex];
      const me = st.players.find((p) => p.id === vid);
      const lockedCard = me.hand.find((c) => c.locked);
      const otherLocked = st.players.find((p) => p.id !== vid).hand.findIndex((c) => c.locked);
      const unlocked = me.hand.find((c) => !c.locked);
      const target = st.players.find((p) => p.id !== vid);
      return window.__tw.tryActions([
        { playerId: vid, actionType: 'LOCK', payload: { cardId: lockedCard.id } },
        { playerId: vid, actionType: 'REPLACE', payload: { cardId: lockedCard.id } },
        { playerId: vid, actionType: 'FORCE_TRADE', payload: { giveCardId: lockedCard.id, targetPlayerId: target.id, takeIndex: 0 } },
        { playerId: vid, actionType: 'FORCE_TRADE', payload: { giveCardId: unlocked.id, targetPlayerId: target.id, takeIndex: otherLocked } },
      ]);
    });
    for (const r of rejections) {
      eq(r.success, false, `rejected: ${r.label}`);
      note(`${r.label} → "${r.error}"`);
    }
  });

  // -------------------------------------------------------------------------
  // CHECK 5 — real 15-second timer expiry
  // -------------------------------------------------------------------------

  await check('CHECK 5 (UI) — letting the real 15s timer run out auto-locks the lowest card', async () => {
    await setupGame(page, { playerCount: 4, seed: 777 });
    await reveal(page);

    const before = await stateOf(page);
    const viewerId = before.submissionOrder[before.submissionIndex];
    const me = before.players.find((p) => p.id === viewerId);
    const lowest = me.hand.filter((c) => !c.locked).reduce((a, b) => (b.value < a.value ? b : a));
    note(`${me.name} hand: ${me.hand.map((c) => `${c.id}(${c.value})`).join(' ')} — lowest ${lowest.id}`);

    const t0 = await page.textContent('#timer');
    ok(/^1[45]s$/.test(t0.trim()), `timer starts at 15s (showed "${t0}")`);

    await new Promise((r) => setTimeout(r, 4000));
    const t4 = await page.textContent('#timer');
    note(`after 4s the timer reads "${t4}"`);
    ok(Number(t4.replace('s', '')) < Number(t0.replace('s', '')), 'timer counts down');

    // Do nothing at all for the rest of the window.
    await page.waitForFunction(() => window.__tw.getScreen() !== 'turn', null, { timeout: 20000 });
    const elapsed = 'expired';
    note(`screen moved on without any input (${elapsed})`);

    const after = await stateOf(page);
    const record = after.actionsThisRound[viewerId];
    ok(record, 'an action was recorded for the idle player');
    eq(record?.actionType, 'LOCK', 'auto action is LOCK');
    eq(record?.autoResolved, 'TIMEOUT', 'recorded as a timer resolution');
    eq(record?.payload.cardId, lowest.id, `auto-locked the lowest-value card (${lowest.id})`);
    eq(await screenOf(page), 'result', 'the idle player is shown what was auto-locked');

    const autoText = await page.textContent('#result-text');
    ok(autoText.includes('Time ran out'), `result explains the timeout: "${autoText}"`);
    ok(autoText.includes(lowest.id), 'result names the auto-locked card');
    const autoBadge = await page.$eval(`#own-hand .card[data-card-id="${CSS_esc(lowest.id)}"]`, (el) => ({
      badge: el.querySelector('.change-tag')?.textContent,
      locked: el.dataset.locked,
    }));
    eq(autoBadge.locked, 'true', 'the auto-locked card is shown locked');
    eq(autoBadge.badge, 'AUTO-LOCKED', 'the auto-locked card is badged');

    await page.click('#result-continue');
    eq(await screenOf(page), 'pass', 'advanced to the next player handoff');

    // Timer restarts fresh for the next player.
    await reveal(page);
    const t = await page.textContent('#timer');
    ok(/^1[45]s$/.test(t.trim()), `next player gets a fresh 15s window (showed "${t}")`);
  });

  // -------------------------------------------------------------------------
  // CHECK 7 + 8 — end screen: everything locked, sums correct, highest wins
  // -------------------------------------------------------------------------

  await check('CHECK 7/8 (UI) — end screen locks everything and scores correctly', async () => {
    const names = ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Fay'];
    await setupGame(page, { playerCount: 6, seed: 31337, names, drunk: [1, 2, 3, 4, 5, 6] });
    await playThrough(page, mixedDecision);

    const state = await stateOf(page);
    eq(state.phase, 'GAME_OVER', 'phase GAME_OVER');
    const allLocked = state.players.every((p) => p.hand.every((c) => c.locked));
    ok(allLocked, 'every card in every hand is locked');

    // No action is possible any more, via the rules layer.
    const post = await page.evaluate(() =>
      window.__tw.tryActions([
        { playerId: 'p1', actionType: 'LOCK', payload: { cardId: window.__tw.getState().players[0].hand[0].id } },
        { playerId: 'p1', actionType: 'REPLACE', payload: { cardId: window.__tw.getState().players[0].hand[0].id } },
      ])
    );
    for (const r of post) eq(r.success, false, `post-game ${r.label} refused ("${r.error}")`);

    // Score the end-screen table by hand from the revealed cards.
    const VAL = { A: 1, J: 11, Q: 12, K: 13 };
    const rows = await readResults(page);
    for (const row of rows) {
      const sum = row.hand.reduce((acc, label) => {
        const rank = label.slice(0, -1);
        return acc + (VAL[rank] ?? Number(rank));
      }, 0);
      eq(row.score, sum, `${row.name}: table sum matches the revealed hand ${row.hand.join(' ')}`);
      const stateHand = state.players.find((p) => p.name === row.name).hand.map((c) => `${c.rank}${c.suit}`);
      eq(row.hand.join(' '), stateHand.join(' '), `${row.name}: revealed hand matches state`);
    }

    const max = Math.max(...rows.map((r) => r.score));
    const winners = rows.filter((r) => r.marker === 'WINNER');
    eq(winners.length, 1, 'exactly one WINNER marker');
    eq(winners[0].score, max, `winner ${winners[0].name} holds the top score ${max}`);
    eq(rows[0].marker, 'WINNER', 'winner is listed first');
    note(rows.map((r) => `${r.name}=${r.score}${r.marker ? ' *' : ''}`).join('  '));
  });

  // -------------------------------------------------------------------------
  // CHECK 11 — the acting player sees the card change before the turn ends
  // -------------------------------------------------------------------------

  await check('CHECK 11 (UI) — each action visibly resolves before the device is passed', async () => {
    await setupGame(page, { playerCount: 4, seed: 4242, names: ['Ann', 'Bo', 'Cy', 'Di'] });
    await reveal(page);

    // --- FORCE_TRADE (active player acts first) ---
    const s0 = await stateOf(page);
    const traderId = s0.activePlayerId;
    const targetId = s0.players.find((p) => p.id !== traderId).id;
    const target = s0.players.find((p) => p.id === targetId);
    const give = s0.players.find((p) => p.id === traderId).hand.find((c) => !c.locked);
    const willTake = target.hand[2];

    await clickForceTrade(page, { giveCardId: give.id, targetPlayerId: targetId, takeIndex: 2 });
    eq(await screenOf(page), 'result', 'trade lands on the result beat, not the handoff');

    let hand = (await readTurn(page)).ownHand;
    const takenCard = hand.find((c) => c.cardId === willTake.id);
    ok(takenCard, `the taken card ${willTake.id} is now visibly in the trader's hand`);
    eq(takenCard?.locked, true, 'shown as locked');
    ok(!hand.some((c) => c.cardId === give.id), `the given card ${give.id} is visibly gone`);
    let badge = await page.$eval(`#own-hand .card[data-card-id="${CSS_esc(willTake.id)}"] .change-tag`, (e) => e.textContent);
    eq(badge, 'TAKEN — LOCKED', 'taken card is badged');
    let text = await page.textContent('#result-text');
    ok(text.includes(willTake.id) && text.includes(give.id), `result names both cards: "${text}"`);
    ok(await page.isVisible('#result-continue'), 'nothing advances until acknowledged');

    // The trade target, when they reveal, sees the swap already applied and is told.
    for (let i = 0; i < 10; i++) {
      await advanceToTurn(page);
      const st = await stateOf(page);
      if (st.submissionOrder[st.submissionIndex] === targetId) break;
      const t = await readTurn(page);
      await clickLock(page, t.ownHand.find((c) => !c.locked).cardId);
    }
    eq((await stateOf(page)).submissionOrder[(await stateOf(page)).submissionIndex], targetId,
      'reached the trade target\'s turn');
    const notice = await page.textContent('#turn-notice');
    ok(notice.includes('position 3'), `trade target is told which slot was taken: "${notice}"`);
    ok(notice.includes(give.id), 'trade target is told which card they received');
    const received = (await readTurn(page)).ownHand.find((c) => c.cardId === give.id);
    ok(received, 'received card is visibly in their hand');
    eq(received?.locked, false, 'and is unlocked, so they can still act on it');

    // --- REPLACE ---
    const beforeReplace = await stateOf(page);
    const meId = beforeReplace.submissionOrder[beforeReplace.submissionIndex];
    const toReplace = beforeReplace.players.find((p) => p.id === meId).hand.find((c) => !c.locked);
    const deckBefore = beforeReplace.deck.length;
    await clickReplace(page, toReplace.id);
    eq(await screenOf(page), 'result', 'replace lands on the result beat');

    const afterReplace = await stateOf(page);
    eq(afterReplace.deck.length, deckBefore - 1, 'a card was actually drawn');
    hand = (await readTurn(page)).ownHand;
    ok(!hand.some((c) => c.cardId === toReplace.id), `discarded ${toReplace.id} is visibly gone`);
    const drawn = hand.find((c) => c.cardId === afterReplace.lastEvent.newCardId);
    ok(drawn, `the drawn card ${afterReplace.lastEvent.newCardId} is visible immediately`);
    eq(drawn?.locked, true, 'drawn card shown locked');
    badge = await page.$eval(`#own-hand .card[data-card-id="${CSS_esc(drawn.cardId)}"] .change-tag`, (e) => e.textContent);
    eq(badge, 'NEW CARD', 'drawn card is badged');
    text = await page.textContent('#result-text');
    ok(text.includes(toReplace.id) && text.includes(drawn.cardId), `result names both cards: "${text}"`);

    // --- LOCK ---
    await advanceToTurn(page);
    const beforeLock = await readTurn(page);
    const lockTarget = beforeLock.ownHand.find((c) => !c.locked);
    eq(lockTarget.locked, false, 'card starts unlocked with buttons');
    eq(lockTarget.hasLockBtn, true, 'Lock button present before acting');
    await clickLock(page, lockTarget.cardId);
    eq(await screenOf(page), 'result', 'lock lands on the result beat');

    const lockedNow = (await readTurn(page)).ownHand.find((c) => c.cardId === lockTarget.cardId);
    eq(lockedNow.locked, true, `${lockTarget.cardId} is visibly locked`);
    eq(lockedNow.hasLockBtn, false, 'its buttons are gone');
    badge = await page.$eval(`#own-hand .card[data-card-id="${CSS_esc(lockTarget.cardId)}"] .change-tag`, (e) => e.textContent);
    eq(badge, 'JUST LOCKED', 'locked card is badged');
    text = await page.textContent('#result-text');
    ok(text.includes(lockTarget.cardId), `result names the locked card: "${text}"`);
    note(`lock result: "${text}"`);
  });

  // -------------------------------------------------------------------------
  // CHECK 12 — the table: seats, zones, piles, and cards in flight
  // -------------------------------------------------------------------------

  await check('CHECK 12 (UI) — the table seats everyone, splits the zones and tracks the piles', async () => {
    await setupGame(page, { playerCount: 6, seed: 4242 });
    await reveal(page);

    const readTable = () => page.evaluate(() => {
      const seatOf = (el) => el.closest('.seat-group')?.classList.contains('north') ? 'north'
        : el.closest('.seat-group')?.classList.contains('west') ? 'west'
        : el.closest('.seat-group')?.classList.contains('east') ? 'east' : null;
      const zoneCards = (zone) =>
        [...document.querySelectorAll(`#own-hand .zone-${zone} .card`)].map((el) => el.dataset.cardId);
      return {
        seats: [...document.querySelectorAll('#other-hands .opponent')].map((el) => ({
          playerId: el.dataset.playerId,
          group: seatOf(el),
          positions: [...el.querySelectorAll('.slot')].map((s) => Number(s.dataset.position)),
          lockedPositions: [...el.querySelectorAll('.slot[data-locked="true"]')]
            .map((s) => Number(s.dataset.position)),
        })),
        live: zoneCards('live'),
        locked: zoneCards('locked'),
        allOwn: [...document.querySelectorAll('#own-hand .card')].map((el) => el.dataset.cardId),
        deckLabel: document.getElementById('deck-count').textContent,
        discardLabel: document.getElementById('discard-count').textContent,
        ghosts: document.querySelectorAll('#fly-layer .fly').length,
      };
    });

    let table = await readTable();
    let st = await stateOf(page);
    const viewerId = st.submissionOrder[st.submissionIndex];

    // Every opponent has a seat, and it is somewhere on the felt.
    eq(table.seats.length, st.playerCount - 1, 'every opponent has a seat');
    eq(new Set(table.seats.map((s) => s.playerId)).size, table.seats.length, 'no player seated twice');
    ok(!table.seats.some((s) => s.playerId === viewerId), 'the viewer is not seated as an opponent');
    ok(table.seats.every((s) => s.group !== null), 'every seat landed in a seat group');
    note(`seating: ${table.seats.map((s) => `${s.playerId}:${s.group}`).join(' ')}`);
    ok(new Set(table.seats.map((s) => s.group)).size >= 2, 'seats are spread around the felt, not stacked in one group');

    // Piles read from the same numbers the rules layer holds.
    eq(table.deckLabel, String(st.deck.length), 'deck count on the felt matches the deck');
    eq(table.discardLabel, String(st.discard.length), 'discard count on the felt matches the discard');

    // Zones partition the hand: nothing lost, nothing duplicated.
    const handIds = st.players.find((p) => p.id === viewerId).hand.map((c) => c.id);
    eq(table.live.length + table.locked.length, handIds.length, 'the two zones account for the whole hand');
    eq(new Set(table.allOwn).size, handIds.length, '#own-hand still addresses every card');
    eq([...table.live, ...table.locked].sort().join(' '), [...handIds].sort().join(' '),
      'the zones hold exactly the cards in hand');
    eq(table.locked.length, 0, 'nothing is banked on the opening turn');

    // Play into round 2, so the player we land on has already banked something and some
    // opponents show locked slots.
    let acted = 0;
    for (let i = 0; i < 40; i++) {
      const s = await screenOf(page);
      if (s === 'over') break;
      if (s === 'turn' && (await stateOf(page)).currentRound >= 2) break;
      if (s === 'turn') {
        const i = acted++;
        const t = await readTurn(page);
        // Replace once to move the piles, otherwise lock.
        if (i === 0) await clickReplace(page, t.ownHand.find((c) => !c.locked).cardId);
        else await clickLock(page, t.ownHand.find((c) => !c.locked).cardId);
        // A resolution should put at least one card in the air.
        ok((await readTable()).ghosts > 0, `action ${i + 1} animated a card across the table`);
      } else if (s === 'result') await page.click('#result-continue');
      else if (s === 'pass') {
        // Nothing may survive the handoff — a ghost mid-flight least of all.
        eq(await page.$$eval('#fly-layer .fly', (els) => els.length), 0,
          'the fly layer is torn down at the handoff');
        await reveal(page);
      } else if (s === 'summary') await page.click('#continue-round');
    }

    await advanceToTurn(page);
    table = await readTable();
    st = await stateOf(page);
    const viewer2 = st.submissionOrder[st.submissionIndex];
    const hand2 = st.players.find((p) => p.id === viewer2).hand;

    ok(table.locked.length > 0, `${table.locked.length} card(s) banked in the locked zone by now`);
    eq(table.live.join(' '), hand2.filter((c) => !c.locked).map((c) => c.id).join(' '),
      'the live zone holds exactly the unlocked cards');
    eq(table.locked.join(' '), hand2.filter((c) => c.locked).map((c) => c.id).join(' '),
      'the locked zone holds exactly the locked cards');

    // D9: opponent slots stay in position order even once some of them are locked, because
    // Force Trade picks blind *by position*.
    const withLocks = table.seats.filter((s) => s.lockedPositions.length > 0);
    ok(withLocks.length > 0, `${withLocks.length} opponent seat(s) now show locked slots`);
    for (const seat of table.seats) {
      eq(seat.positions.join(','), seat.positions.map((_, i) => i + 1).join(','),
        `${seat.playerId}'s slots are still in position order`);
      const stateLocked = st.players.find((p) => p.id === seat.playerId).hand
        .map((c, i) => (c.locked ? i + 1 : null)).filter(Boolean);
      eq(seat.lockedPositions.join(','), stateLocked.join(','),
        `${seat.playerId}'s locked slots are the ones the state says are locked`);
    }

    // The piles moved, and still agree with the state.
    eq(table.deckLabel, String(st.deck.length), 'deck count still matches after play');
    eq(table.discardLabel, String(st.discard.length), 'discard count still matches after play');
    ok(st.discard.length > 0, `the replace put ${st.discard.length} card(s) on the discard`);
    note(`deck ${table.deckLabel}, discard ${table.discardLabel}, ` +
      `zones ${table.live.length} live / ${table.locked.length} locked`);
  });

  // -------------------------------------------------------------------------
  // CHECK 9 — tiebreak, played out for real in the UI
  // -------------------------------------------------------------------------

  await check('CHECK 9 (UI) — a real tied game is won by the drunker player', async () => {
    // Seed 1 at 4 players deals P2 and P3 hands that both total 25. With every player
    // simply locking, final hands == dealt hands, so the game ends genuinely tied.
    // P3 is drunker, and is seated *after* P2, so seat order cannot explain a P3 win.
    await setupGame(page, {
      playerCount: 4,
      seed: 1,
      names: ['Ann', 'Bo', 'Cy', 'Di'],
      drunk: [5, 2, 9, 1],
    });

    await playThrough(page, (turn) => ({
      actionType: 'LOCK',
      cardId: turn.ownHand.find((c) => !c.locked).cardId,
    }));

    const rows = await readResults(page);
    note(rows.map((r) => `${r.name}: ${r.hand.join(' ')} = ${r.score} (drunk ${r.drunk})`).join('\n     '));

    const max = Math.max(...rows.map((r) => r.score));
    const tied = rows.filter((r) => r.score === max);
    eq(tied.length, 2, `exactly two players tied at the top score of ${max}`);
    eq(new Set(tied.map((t) => t.name)).size, 2, 'the tie is between two distinct players');

    const winner = rows.find((r) => r.marker === 'WINNER');
    const drunkest = tied.reduce((a, b) => (b.drunk > a.drunk ? b : a));
    eq(winner.name, drunkest.name, `winner is the drunker tied player (${drunkest.name}, drunk ${drunkest.drunk})`);
    eq(winner.name, 'Cy', 'Cy (drunk 9) beats Bo (drunk 2) on the tiebreak');
    ok(
      rows.findIndex((r) => r.name === 'Bo') > rows.findIndex((r) => r.name === 'Cy'),
      'the tiebreak, not seat order, decided it (Bo is seated before Cy)'
    );
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${'='.repeat(64)}`);
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log('='.repeat(64));
console.log(`${results.filter((r) => r.passed).length}/${results.length} checks passed, ${assertions} assertions, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
