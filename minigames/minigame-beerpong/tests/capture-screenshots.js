// Recapture screenshots/ from the running app.
// Run: node tests/capture-screenshots.js  (starts its own static server)
//
// Fixed seed, fixed names, and throws driven through the test hook rather than by racing
// the meters, so the same shots come out every time and a rerun is a clean diff.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const PORT = Number(process.env.BP_PORT ?? 8143);
const URL = `http://127.0.0.1:${PORT}/index.html`;

const SEED = 4242;
const NAMES = ['Ann', 'Bo', 'Cy', 'Di'];

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
for (let i = 0; ; i++) {
  try { if ((await fetch(URL)).ok) break; } catch { /* not up yet */ }
  if (i > 40) { server.kill(); throw new Error(`server never came up on ${PORT} (set BP_PORT)`); }
  await new Promise((r) => setTimeout(r, 250));
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 950, height: 1150 } });

async function shot(name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${path.relative(ROOT, file)}`);
}

async function setup({ playerCount = 2, standings = null, drunk = null } = {}) {
  await page.goto(URL);
  await page.click(`.choice[data-count="${playerCount}"]`);
  await page.fill('#seed-input', String(SEED));
  for (let i = 0; i < playerCount; i++) {
    await page.fill(`#name-${i}`, NAMES[i]);
    if (standings) await page.fill(`#standing-${i}`, String(standings[i]));
    if (drunk) await page.fill(`#drunk-${i}`, String(drunk[i]));
  }
}

const settle = () =>
  page.waitForFunction(() => ['idle', 'over'].includes(window.__bp.getMode()), null, { timeout: 5000 });

async function sink() {
  const plan = await page.evaluate(() => window.__bp.aimForCup());
  await page.evaluate((p) => window.__bp.throwAt(p.aim, p.power), plan);
  await settle();
}

async function miss() {
  await page.evaluate(() => window.__bp.throwAt(0.02, 0.02));
  await settle();
}

console.log('capturing beer-pong screenshots:');
try {
  // 1 — setup, showing the standings-driven seeding
  await setup({ playerCount: 4, standings: [12, 9, 6, 3], drunk: [0.1, 0.3, 0.6, 0.9] });
  await shot('1-setup');

  // 2 — the table at the opening throw, both racks full
  await page.click('#start-game');
  await shot('2-match-start');

  // 3 — the aim meter mid-sweep
  await page.evaluate(() => window.__bp.setMeterConfig({ aimSpeed: 0.35 }));
  await page.click('#lock');
  await page.waitForTimeout(700);
  await shot('3-aim-meter');

  // 4 — the power meter, with the locked aim still on screen
  await page.click('#lock');
  await page.waitForTimeout(500);
  await shot('4-power-meter');
  await page.click('#lock');
  await settle();

  // 5 — a throw in flight
  const plan = await page.evaluate(() => window.__bp.aimForCup());
  await page.evaluate((p) => window.__bp.throwAt(p.aim, p.power), plan);
  await page.waitForTimeout(260);
  await shot('5-throw-in-flight');
  await settle();

  // 6 — the re-rack notice, at the turn start it applies to
  await setup({ playerCount: 2 });
  await page.click('#start-game');
  let guard = 0;
  while (guard++ < 20) {
    const st = await page.evaluate(() => window.__bp.getState());
    if (st.lastRerack) break;
    await sink();
  }
  await shot('6-rerack');

  // 7 — sudden death: one respawning cup, streak against streak
  guard = 0;
  while (guard++ < 20 && !(await page.evaluate(() => window.__bp.getState().suddenDeathActive))) {
    await sink();
  }
  await shot('7-sudden-death');

  // 8 — a standing target to beat
  await sink();
  guard = 0;
  while (guard++ < 6 && (await page.evaluate(() => window.__bp.getState().suddenDeathTargetStreak)) === null) {
    await miss();
  }
  await shot('8-sudden-death-target');

  // 9 — the end screen
  guard = 0;
  while (guard++ < 12 && !(await page.evaluate(() => window.__bp.getState().winnerTeamId))) {
    await miss();
  }
  await shot('9-endscreen');
} finally {
  await browser.close();
  server.kill();
}
console.log('done.');
