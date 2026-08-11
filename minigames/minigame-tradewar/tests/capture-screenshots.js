// Recapture screenshots/ from the running app.
// Run: node tests/capture-screenshots.js  (starts its own static server)
//
// Every shot is driven by real clicks against a fixed seed and fixed names, so the same
// hands come out every time and a rerun is a clean diff rather than a reshuffle.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const PORT = Number(process.env.TW_PORT ?? 8138);
const URL = `http://127.0.0.1:${PORT}/index.html`;

const SEED = 4242;
const NAMES = ['Ann', 'Bo', 'Cy', 'Di'];

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
for (let i = 0; ; i++) {
  try { if ((await fetch(URL)).ok) break; } catch { /* not up yet */ }
  if (i > 40) { server.kill(); throw new Error(`server never came up on ${PORT} (set TW_PORT)`); }
  await new Promise((r) => setTimeout(r, 250));
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });

const screenOf = () => page.evaluate(() => window.__tw.getScreen());
const stateOf = () => page.evaluate(() => window.__tw.getState());
const esc = (s) => s.replace(/"/g, '\\"');

async function shot(name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${path.relative(ROOT, file)}`);
}

async function setup({ playerCount = 4 } = {}) {
  await page.goto(URL);
  await page.click(`#count-${playerCount}`);
  await page.fill('#seed-input', String(SEED));
  for (let i = 0; i < playerCount && i < NAMES.length; i++) {
    await page.fill(`#name-${i}`, NAMES[i]);
    await page.fill(`#drunk-${i}`, String(i * 3));
  }
}

/** Lock the lowest unlocked card for whoever is on the clock. */
async function lockOne() {
  const id = await page.evaluate(() => {
    const st = window.__tw.getState();
    const me = st.players.find((p) => p.id === st.submissionOrder[st.submissionIndex]);
    return me.hand.find((c) => !c.locked).id;
  });
  await page.click(`button[data-action="lock"][data-card-id="${esc(id)}"]`);
}

/** Click forward until the named screen, acting where an action is required. */
async function advanceTo(target, { max = 60 } = {}) {
  for (let i = 0; i < max; i++) {
    const s = await screenOf();
    if (s === target) return;
    if (s === 'pass') await page.click('#reveal-hand');
    else if (s === 'turn') await lockOne();
    else if (s === 'result') await page.click('#result-continue');
    else if (s === 'summary') await page.click('#continue-round');
    else break;
  }
  if ((await screenOf()) !== target) throw new Error(`never reached the ${target} screen`);
}

console.log('capturing trade-war screenshots:');
try {
  // 1 — setup
  await setup();
  await shot('1-setup');

  // 2 — handoff interstitial
  await page.click('#start-game');
  await shot('2-pass');

  // 3 — the table, seen by the active player (Force Trade available)
  await page.click('#reveal-hand');
  await shot('3-turn-active');

  // 4 — a Force Trade in flight, mid-tween
  await page.click('[data-trade-give]');
  await page.click('[data-trade-target]');
  await page.click('[data-trade-take]:not([disabled])');
  await page.click('#confirm-trade');
  await page.waitForTimeout(230);
  await shot('4-trade-in-flight');

  // 5 — the same trade, resolved and badged
  await page.waitForTimeout(700);
  await shot('5-result-trade');

  // 6 — the player who was traded on, with the notice explaining it
  await page.click('#result-continue');
  await page.click('#reveal-hand');
  await shot('6-traded-on-notice');

  // 7 — a Replace resolving: old card to the discard, new one off the deck
  const replaceId = await page.evaluate(() => {
    const st = window.__tw.getState();
    const me = st.players.find((p) => p.id === st.submissionOrder[st.submissionIndex]);
    return me.hand.find((c) => !c.locked).id;
  });
  await page.click(`button[data-action="replace"][data-card-id="${esc(replaceId)}"]`);
  await page.waitForTimeout(800);
  await shot('7-result-replace');

  // 8 — round summary (shared screen, faces redacted)
  await page.click('#result-continue');
  await advanceTo('summary');
  await shot('8-summary');

  // 9 — a mid-game table with both zones populated
  await page.click('#continue-round');
  for (let i = 0; i < 30; i++) {
    const s = await screenOf();
    if (s === 'turn' && (await stateOf()).currentRound >= 3) break;
    if (s === 'pass') await page.click('#reveal-hand');
    else if (s === 'turn') await lockOne();
    else if (s === 'result') await page.click('#result-continue');
    else if (s === 'summary') await page.click('#continue-round');
    else break;
  }
  await shot('9-turn-midgame-zones');

  // 10 — final results
  await advanceTo('over');
  await shot('10-endscreen');

  // 11 — the 6-player table, which seats three players along the north edge
  await setup({ playerCount: 6 });
  await page.click('#start-game');
  await page.click('#reveal-hand');
  await shot('11-table-6-players');
} finally {
  await browser.close();
  server.kill();
}
console.log('done.');
