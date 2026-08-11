// End-to-end checks against the real page in Chromium.
// Run: node tests/browser-tests.js  (starts its own static server)
//
// The logic suite proves the rules. This proves the page actually wires the meters, the
// animation and the table to them — Section 6 makes the visual result part of the spec,
// not a nicety, so "the ball went where aim and power said" is a real assertion here.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BP_PORT ?? 8142);
const URL = `http://127.0.0.1:${PORT}/index.html`;

let failures = 0;
let assertions = 0;
const results = [];

async function check(name, fn) {
  const before = failures;
  console.log(`\n--- ${name}`);
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`   ✗ threw: ${err.message}`);
  }
  const passed = failures === before;
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
}

function ok(cond, msg) {
  assertions++;
  if (!cond) { failures++; console.log(`   ✗ ${msg}`); }
  return cond;
}
const eq = (a, b, msg) => ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (|${a} - ${b}| > ${tol})`);
const note = (m) => console.log(`   · ${m}`);

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
await (async () => {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(URL)).ok && (await fetch(`http://127.0.0.1:${PORT}/src/beerpong.js`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error(`static server never served ${URL} — port ${PORT} taken? (set BP_PORT)`);
})();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 950, height: 1150 } });
page.on('pageerror', (e) => { failures++; console.log(`   ✗ page error: ${e.message}`); });

const stateOf = () => page.evaluate(() => window.__bp.getState());
const modeOf = () => page.evaluate(() => window.__bp.getMode());

async function setupMatch({ playerCount = 2, seed = 4242, drunk = null, standings = null } = {}) {
  await page.goto(URL);
  await page.click(`.choice[data-count="${playerCount}"]`);
  await page.fill('#seed-input', String(seed));
  for (let i = 0; i < playerCount; i++) {
    if (drunk) await page.fill(`#drunk-${i}`, String(drunk[i]));
    if (standings) await page.fill(`#standing-${i}`, String(standings[i]));
  }
  await page.click('#start-game');
  await page.waitForSelector('#screen-match:not(.hidden)');
}

/** Throw at a named cup (or the first legal target) and wait for the animation to finish. */
async function throwAtCup(cupId = null) {
  const plan = await page.evaluate((id) => window.__bp.aimForCup(id), cupId);
  await page.evaluate((p) => window.__bp.throwAt(p.aim, p.power), plan);
  await page.waitForFunction(() => ['idle', 'over'].includes(window.__bp.getMode()), null, { timeout: 5000 });
  return plan;
}

/** Deliberately miss: both meters near zero puts the ball well off the rack. */
async function throwMiss() {
  await page.evaluate(() => window.__bp.throwAt(0.02, 0.02));
  await page.waitForFunction(() => ['idle', 'over'].includes(window.__bp.getMode()), null, { timeout: 5000 });
}

try {
  await check('the page loads, seats the players and opens on the aim meter', async () => {
    await setupMatch({ playerCount: 4, standings: [10, 8, 6, 4] });
    const st = await stateOf();
    eq(st.matchFormat, '2v2', 'four players is a 2v2');
    eq(st.teams[0].playerIds.join('+'), 'p1+p4', 'seeded 1st + 4th against 2nd + 3rd');
    eq(st.teams[1].playerIds.join('+'), 'p2+p3', 'the other pair is 2nd + 3rd');
    eq(st.phase, 'AIM', 'the match opens waiting on an aim');
    eq(await modeOf(), 'idle', 'and nothing is sweeping until Throw is pressed');

    const cups = await page.$$eval('#rack-far .cup', (els) => els.length);
    eq(cups, 10, 'the defending rack is drawn as 10 cups');
    const indicator = await page.textContent('#turn-indicator');
    ok(/Team [AB] — .+ throwing \(Ball 1 of 2\)/.test(indicator), `turn indicator reads "${indicator}"`);
  });

  await check('the meters chain: aim sweeps, locks, then power sweeps', async () => {
    await setupMatch();
    await page.evaluate(() => window.__bp.setMeterConfig({ aimSpeed: 0.6, powerSpeed: 0.6 }));

    await page.click('#lock');
    eq(await modeOf(), 'aim', 'pressing Throw starts the aim meter');
    ok(await page.$eval('#aim-block', (el) => el.classList.contains('live')), 'the aim block is live');
    ok(!(await page.$eval('#power-block', (el) => el.classList.contains('live'))), 'power is not live yet');

    // The marker actually moves.
    const p0 = await page.evaluate(() => window.__bp.getMeter().position);
    await page.waitForTimeout(220);
    const p1 = await page.evaluate(() => window.__bp.getMeter().position);
    ok(p0 !== p1, `the aim marker is sweeping (${p0.toFixed(3)} -> ${p1.toFixed(3)})`);

    await page.click('#lock');
    eq(await modeOf(), 'power', 'locking aim starts the power meter');
    eq((await stateOf()).phase, 'POWER', 'and the phase in GameState follows');
    ok(await page.$eval('#power-block', (el) => el.classList.contains('live')), 'the power block is live');
    const shownAim = await page.textContent('#aim-value');
    ok(/^0\.\d{3}$/.test(shownAim), `the locked aim stays on screen (${shownAim})`);

    await page.click('#lock');
    await page.waitForFunction(() => ['idle', 'over'].includes(window.__bp.getMode()), null, { timeout: 5000 });
    const st = await stateOf();
    eq(st.throwsThisTurn, 1, 'locking power resolved a throw');
    ok(st.lastThrow !== null, 'and recorded a result');
    note(`throw landed at (${st.lastThrow.target.x.toFixed(2)}, ${st.lastThrow.target.y.toFixed(2)})`);
  });

  await check('Space drives the whole chain from the keyboard', async () => {
    await setupMatch();
    await page.keyboard.press('Space');
    eq(await modeOf(), 'aim', 'Space starts the aim meter');
    await page.keyboard.press('Space');
    eq(await modeOf(), 'power', 'Space locks aim and starts power');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => ['idle', 'over'].includes(window.__bp.getMode()), null, { timeout: 5000 });
    eq((await stateOf()).throwsThisTurn, 1, 'Space locks power and throws');
  });

  await check('the ball lands where aim and power said, and the cup disappears', async () => {
    await setupMatch();

    // Aim dead centre of the front cup; the ball must end up on that cup's drawn position.
    const cupBefore = await page.$eval('#rack-far .cup[data-cup-id="c1"]', (el) => ({
      cx: Number(el.getAttribute('cx')), cy: Number(el.getAttribute('cy')),
    }));
    const plan = await page.evaluate(() => window.__bp.aimForCup('c1'));
    const predicted = await page.evaluate((p) => window.__bp.sceneFor(p.aim, p.power), plan);
    near(predicted.x, cupBefore.cx, 0.5, 'the predicted landing x is the cup it was aimed at');
    near(predicted.y, cupBefore.cy, 0.5, 'and the predicted landing y matches too');

    await page.evaluate((p) => window.__bp.throwAt(p.aim, p.power), plan);
    // Mid-flight the ball is visible and moving.
    await page.waitForTimeout(120);
    const mid = await page.$eval('#ball', (el) => ({
      hidden: el.classList.contains('hidden'),
      cx: Number(el.getAttribute('cx')), cy: Number(el.getAttribute('cy')),
    }));
    ok(!mid.hidden, 'the ball is on screen during the throw');
    await page.waitForTimeout(150);
    const later = await page.$eval('#ball', (el) => ({
      cx: Number(el.getAttribute('cx')), cy: Number(el.getAttribute('cy')),
    }));
    ok(mid.cx !== later.cx || mid.cy !== later.cy, 'and it travels across the table');
    ok(later.cy < 126, 'moving away from the thrower toward the far rack');

    await page.waitForFunction(() => window.__bp.getMode() === 'idle', null, { timeout: 5000 });
    const st = await stateOf();
    eq(st.lastThrow.hitCupId, 'c1', 'the cup it was aimed at is the one sunk');
    near(st.lastThrow.target.x, 0, 1e-6, 'the front cup sits on the centre line');

    // The rack redraws without it.
    const stillThere = await page.$$eval('#rack-far .cup[data-cup-id="c1"]',
      (els) => els.map((e) => e.dataset.sunk));
    eq(stillThere[0], 'true', 'the sunk cup is marked sunk in the drawn rack');
    const remaining = await page.$$eval('#rack-far .cup[data-sunk="false"]', (els) => els.length);
    eq(remaining, 9, 'nine cups are still standing');
    note(`ball flew to (${later.cx.toFixed(1)}, ${later.cy.toFixed(1)}) in scene units`);
  });

  await check('a miss lands off the rack and passes the turn after two throws', async () => {
    await setupMatch();
    const first = (await stateOf()).activeTeamId;
    await throwMiss();
    let st = await stateOf();
    eq(st.lastThrow.hitCupId, null, 'the first ball missed');
    eq(st.activeTeamId, first, 'the turn is not over after one ball');
    eq(st.throwsThisTurn, 1, 'one throw used');

    await throwMiss();
    st = await stateOf();
    eq(st.activeTeamId === first, false, 'two misses passed possession');
    eq(st.throwsThisTurn, 0, 'and the incoming side starts a fresh turn');
    const indicator = await page.textContent('#turn-indicator');
    ok(indicator.includes('Ball 1 of 2'), `the indicator resets: "${indicator}"`);
  });

  await check('sinking both balls keeps the turn, and the re-rack notice appears on time', async () => {
    await setupMatch();
    const shooter = (await stateOf()).activeTeamId;

    await throwAtCup();
    await throwAtCup();
    let st = await stateOf();
    eq(st.activeTeamId, shooter, 'sinking both balls kept the balls');
    eq(st.lastTurn.bonus, true, 'recorded as a bonus turn');

    // Keep going to 6 cups: the notice must appear only at a turn start.
    let guard = 0;
    while ((await stateOf()).teams.find((t) => t.id !== shooter).cupRack.filter((c) => !c.isSunk).length > 6
           && guard++ < 12) {
      await throwAtCup();
    }
    st = await stateOf();
    const defender = st.teams.find((t) => t.id !== shooter);
    eq(defender.cupRack.filter((c) => !c.isSunk).length, 6, 'the defending rack is down to six');
    ok(st.lastRerack !== null, 'the re-rack fired at a turn start');
    eq(st.lastRerack.label, '1-2-3', 'and re-formed the rack as 1-2-3');

    const notice = await page.textContent('#rerack-notice');
    ok(!(await page.$eval('#rerack-notice', (el) => el.classList.contains('hidden'))),
      'the re-rack notice is visible');
    ok(notice.includes('1-2-3'), `the notice names the new layout: "${notice}"`);

    // The drawn rack really is three rows now.
    const rows = await page.$$eval('#rack-far .cup[data-sunk="false"]',
      (els) => new Set(els.map((e) => Number(e.getAttribute('cy')).toFixed(1))).size);
    eq(rows, 3, 'the redrawn rack has three rows of cups');
  });

  await check('clearing the rack starts sudden death on screen, and the match plays out', async () => {
    await setupMatch();
    const clearer = (await stateOf()).activeTeamId;

    let guard = 0;
    while (!(await stateOf()).suddenDeathActive && guard++ < 30) await throwAtCup();
    const st = await stateOf();
    ok(st.suddenDeathActive, 'sudden death is on');
    ok(!['GAME_OVER'].includes(st.phase), 'clearing the rack did not end the match');
    eq(st.suddenDeathCurrentStreak, 0, 'the clearing shot did not count toward the streak');
    eq(st.activeTeamId, clearer, 'the clearing side is still shooting');

    const sdCups = await page.$$eval('#rack-far .cup', (els) => els.length);
    eq(sdCups, 1, 'the far side is now a single cup');
    const banner = await page.textContent('#sudden-death');
    ok(/SUDDEN DEATH — Team [AB] streak: 0 \(setting the target\)/.test(banner),
      `the banner matches the spec's wording: "${banner}"`);

    // One hit, then a miss ends the turn and sets the target.
    await throwAtCup();
    eq((await stateOf()).suddenDeathCurrentStreak, 1, 'a hit on the sudden-death cup counts');
    eq(await page.$$eval('#rack-far .cup', (els) => els.length), 1, 'and the cup respawns immediately');

    guard = 0;
    while ((await stateOf()).activeTeamId === clearer && guard++ < 6) await throwMiss();
    let after = await stateOf();
    eq(after.suddenDeathTargetStreak, 1, 'the ended turn set the target at 1');
    const banner2 = await page.textContent('#sudden-death');
    ok(banner2.includes('need 1 to match'), `the banner now names the bar: "${banner2}"`);

    // The other side falls short -> match over, with the spec's end-state sentence.
    guard = 0;
    while (!(await stateOf()).winnerTeamId && guard++ < 8) await throwMiss();
    after = await stateOf();
    eq(after.phase, 'GAME_OVER', 'the match ended');
    eq(after.winnerTeamId, clearer, 'the side holding the target won');
    await page.waitForSelector('#screen-over:not(.hidden)');
    const result = await page.textContent('#result-text');
    ok(/Team [AB] wins! Team [AB]'s streak of \d+ fell short of Team [AB]'s \d+\./.test(result),
      `the end state reads as specified: "${result}"`);
    const winnerRow = await page.$eval('#results-rows tr.winner td', (el) => el.textContent);
    eq(winnerRow, `Team ${clearer === 't1' ? 'A' : 'B'}`, 'the results table marks the winner');
  });

  await check('drunkenness pulls the aim off the lock, and only the aim', async () => {
    // Same seed, same lock, one sober match and one blackout match.
    await setupMatch({ seed: 99, drunk: [0, 0] });
    const soberPlan = await page.evaluate(() => window.__bp.aimForCup('c1'));
    await page.evaluate((p) => window.__bp.throwAt(p.aim, p.power), soberPlan);
    await page.waitForFunction(() => window.__bp.getMode() === 'idle', null, { timeout: 5000 });
    const sober = (await stateOf()).lastThrow;

    await setupMatch({ seed: 99, drunk: [1, 1] });
    await page.evaluate((p) => window.__bp.throwAt(p.aim, p.power), soberPlan);
    await page.waitForFunction(() => window.__bp.getMode() === 'idle', null, { timeout: 5000 });
    const drunk = (await stateOf()).lastThrow;

    eq(sober.lockedAim, drunk.lockedAim, 'both locked the same aim');
    eq(sober.adjustedAim, sober.lockedAim, 'sober aim is used exactly as locked');
    ok(drunk.adjustedAim !== drunk.lockedAim, 'drunk aim is pulled off the lock');
    near(sober.target.y, drunk.target.y, 1e-9, 'depth is untouched by drunkenness');
    ok(sober.target.x !== drunk.target.x, 'but the left-right landing is not');
    note(`sober landed x=${sober.target.x.toFixed(3)}, drunk landed x=${drunk.target.x.toFixed(3)}`);
  });

  await check('the tuning parameters reach the next throw', async () => {
    await setupMatch();
    // A tolerance of almost nothing turns a dead-centre aim into the only way in; widen it
    // and a throw that missed by a hair goes in.
    await page.fill('#num-toleranceRadius', '0.15');
    await page.dispatchEvent('#num-toleranceRadius', 'input');
    eq(await page.evaluate(() => window.__bp.getConfig().toleranceRadius), 0.15,
      'the typed tolerance reached the config');
    eq(await page.inputValue('#range-toleranceRadius'), '0.15', 'and the slider mirrored it');

    // 0.06 of aim is ~0.3 rack units off centre: outside 0.15, comfortably inside 0.6.
    const plan = await page.evaluate(() => window.__bp.aimForCup('c1'));
    await page.evaluate((p) => window.__bp.throwAt(p.aim + 0.06, p.power), plan);
    await page.waitForFunction(() => window.__bp.getMode() === 'idle', null, { timeout: 5000 });
    eq((await stateOf()).lastThrow.hitCupId, null, 'a near miss is a miss at a tight tolerance');

    await page.fill('#num-toleranceRadius', '0.6');
    await page.dispatchEvent('#num-toleranceRadius', 'input');
    await page.evaluate((p) => window.__bp.throwAt(p.aim + 0.06, p.power), plan);
    await page.waitForFunction(() => window.__bp.getMode() === 'idle', null, { timeout: 5000 });
    ok((await stateOf()).lastThrow.hitCupId !== null, 'the same throw goes in at a loose tolerance');
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
