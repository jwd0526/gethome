// Verifies dist/trade-war.html actually plays over file:// with no server and no
// external files. Run: node build.js && node tests/dist-smoke.js

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE_URL = `file://${path.join(ROOT, 'dist', 'trade-war.html')}`;

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) { failures++; console.log(`   ✗ ${msg}`); } else { console.log(`   ✓ ${msg}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`failed request: ${r.url()}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

console.log(`loading ${FILE_URL}`);
await page.goto(FILE_URL);

ok(await page.isVisible('#count-4'), 'setup screen renders from file://');
ok(await page.evaluate(() => !!window.__tw), 'inlined module executed');
ok(
  await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(20, 22, 26)'),
  'inlined CSS applied'
);

// Only the document itself should ever be fetched.
const requests = [];
page.on('request', (r) => {
  if (r.resourceType() !== 'document') requests.push(`${r.resourceType()} ${r.url()}`);
});

for (const playerCount of [4, 6]) {
  await page.goto(FILE_URL);
  await page.click(`#count-${playerCount}`);
  await page.fill('#seed-input', '4242');
  await page.click('#start-game');

  let guard = 0;
  for (;;) {
    if (++guard > 400) throw new Error('did not finish');
    const s = await page.evaluate(() => window.__tw.getScreen());
    if (s === 'over') break;
    if (s === 'pass') { await page.click('#reveal-hand'); continue; }
    if (s === 'result') { await page.click('#result-continue'); continue; }
    if (s === 'summary') { await page.click('#continue-round'); continue; }
    const id = await page.$eval('#own-hand .card[data-locked="false"]', (e) => e.dataset.cardId);
    await page.click(`button[data-action="lock"][data-card-id="${id}"]`);
  }

  const rows = await page.$$eval('#results-rows tr', (trs) =>
    trs.map((tr) => ({ name: tr.children[0].textContent, score: Number(tr.children[2].textContent), win: tr.children[4].textContent }))
  );
  ok(rows.length === playerCount, `${playerCount}p game played to the end screen (${rows.map((r) => `${r.name}=${r.score}`).join(' ')})`);
  ok(rows.filter((r) => r.win === 'WINNER').length === 1, `${playerCount}p produced exactly one winner`);
}

ok(requests.length === 0, `no external resource requested (${requests.length} beyond the document)`);
ok(problems.length === 0, `no page errors or failed requests${problems.length ? `: ${problems.join('; ')}` : ''}`);

await browser.close();
console.log(failures === 0 ? '\nOK — dist/trade-war.html is self-contained and playable.' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
