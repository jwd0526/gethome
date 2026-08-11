// Proves the built single file actually plays over file://.
// Run: node tests/dist-smoke.js   (or npm run test:dist, which builds first)
//
// The bundle concatenates three modules into one scope, so it can break in ways the source
// tree never does — a name collision between two modules' private helpers is a SyntaxError
// that only exists in the build. Loading the real artifact is the only thing that catches
// that class of bug.

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'beer-pong.html');

if (!existsSync(DIST)) {
  console.error(`no build at ${DIST} — run: node build.js`);
  process.exit(1);
}

let failures = 0;
const ok = (cond, msg) => {
  console.log(`   ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 950, height: 1150 } });

const pageErrors = [];
const failedRequests = [];
const external = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));
page.on('request', (r) => { if (r.url() !== pathToFileURL(DIST).href) external.push(r.url()); });

try {
  await page.goto(pathToFileURL(DIST).href);
  ok(await page.isVisible('#start-game'), 'the setup screen renders from the single file');

  await page.click('.choice[data-count="2"]');
  await page.fill('#seed-input', '4242');
  await page.click('#start-game');
  await page.waitForSelector('#screen-match:not(.hidden)');
  ok(true, 'a match starts');

  // Play it out: sink when we can, miss on a schedule so turns actually end.
  let throws = 0;
  while (throws < 400) {
    const over = await page.evaluate(() => window.__bp.getState().phase === 'GAME_OVER');
    if (over) break;
    const shouldHit = throws % 3 !== 2;
    if (shouldHit) {
      const plan = await page.evaluate(() => window.__bp.aimForCup());
      await page.evaluate((p) => window.__bp.throwAt(p.aim, p.power), plan);
    } else {
      await page.evaluate(() => window.__bp.throwAt(0.02, 0.02));
    }
    await page.waitForFunction(() => ['idle', 'over'].includes(window.__bp.getMode()), null, { timeout: 5000 });
    throws++;
  }

  const st = await page.evaluate(() => window.__bp.getState());
  ok(st.phase === 'GAME_OVER', `the match played to a result in ${throws} throws`);
  ok(st.suddenDeathActive, 'through sudden death, as every match must be');
  ok(Boolean(st.winnerTeamId) && st.winnerTeamId !== st.loserTeamId, 'with exactly one winner');

  await page.waitForSelector('#screen-over:not(.hidden)');
  const result = await page.textContent('#result-text');
  ok(/wins!/.test(result), `the end screen reports it: "${result}"`);

  ok(external.length === 0, `no external resource requested (${external.length} beyond the document)`);
  ok(pageErrors.length === 0 && failedRequests.length === 0,
    `no page errors or failed requests${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}

console.log(
  failures === 0
    ? '\nOK — dist/beer-pong.html is self-contained and playable.'
    : `\n${failures} failure(s).`
);
process.exit(failures === 0 ? 0 : 1);
