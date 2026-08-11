// End-to-end checks against the real page in Chromium.
// Run: node tests/browser-tests.js  (starts its own static server)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BAL_PORT ?? 8140);
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
const note = (m) => console.log(`   · ${m}`);

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
await (async () => {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(URL)).ok && (await fetch(`http://127.0.0.1:${PORT}/src/balance.js`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error(`static server never served ${URL} — port ${PORT} taken? (set BAL_PORT)`);
})();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
page.on('pageerror', (e) => { failures++; console.log(`   ✗ page error: ${e.message}`); });

const state = () => page.evaluate(() => window.__bal.getState());
const config = () => page.evaluate(() => window.__bal.getConfig());

/** Degrees out of an SVG transform, ignoring any translate the fallen pose adds. */
const rotationOf = (id) => page.evaluate((elId) => {
  const t = document.getElementById(elId).getAttribute('transform') ?? '';
  const m = /rotate\(\s*(-?[\d.]+)/.exec(t);
  return m ? Number(m[1]) : null;
}, id);

try {
  await check('page loads and the marker starts centred', async () => {
    await page.goto(URL);
    ok(await page.isVisible('#start'), 'start button visible');
    eq(await page.textContent('#timer'), '0.0s', 'timer starts at zero');
    eq(await state(), null, 'no run in progress before start');
    const params = await page.$$eval('.param input[type="number"]', (els) => els.map((e) => e.dataset.param));
    note(`editable parameters: ${params.join(', ')}`);
    ok(params.length === 7, 'every tunable parameter is exposed in the UI');
  });

  await check('a run starts, time advances, and the marker moves', async () => {
    await page.click('#start');
    ok(await page.evaluate(() => window.__bal.isRunning()), 'run is live');
    const s0 = await state();
    ok(Math.abs(s0.lean) > 0, `starts off-centre (lean ${s0.lean.toFixed(3)})`);

    await page.waitForTimeout(600);
    const s1 = await state();
    ok(s1.elapsedTime > 0, `elapsed advanced to ${s1.elapsedTime.toFixed(2)}s`);
    ok(s1.gravityCoefficient > s0.gravityCoefficient, 'gravity ramped');
    ok(Math.abs(s1.lean) > Math.abs(s0.lean), 'lean drifted away from centre with no input');

    // Check rendered geometry against the real lean, sampled from a live run — poking
    // state directly is pointless because the render loop overwrites it every frame.
    const sample = () => page.evaluate(() => {
      const m = document.getElementById('marker').getBoundingClientRect();
      const bar = document.getElementById('bar').getBoundingClientRect();
      return {
        lean: window.__bal.getState().lean,
        centre: m.left + m.width / 2 - bar.left,
        barWidth: bar.width,
        markerWidth: m.width,
        inside: m.left >= bar.left - 0.5 && m.right <= bar.right + 0.5,
      };
    });

    // With no input the lean drifts steadily outward, sweeping a range of real positions.
    const samples = [];
    for (let i = 0; i < 12; i++) {
      samples.push(await sample());
      await page.waitForTimeout(80);
    }

    const threshold = (await config()).fallThreshold;
    let worstError = 0;
    for (const s of samples) {
      const clamped = Math.max(-threshold, Math.min(threshold, s.lean));
      const expected = s.markerWidth / 2 + ((clamped / threshold + 1) / 2) * (s.barWidth - s.markerWidth);
      worstError = Math.max(worstError, Math.abs(s.centre - expected));
      ok(s.inside, `marker inside the bar at lean ${s.lean.toFixed(3)}`);
    }
    ok(worstError < 1.5, `marker tracks lean across ${samples.length} samples (worst error ${worstError.toFixed(2)}px)`);

    const spread = Math.max(...samples.map((s) => s.centre)) - Math.min(...samples.map((s) => s.centre));
    // Deliberately loose: early drift is slow, and the per-sample accuracy check above is
    // what actually proves the mapping. This only guards against a frozen marker.
    ok(spread > 1, `marker visibly moved during the run (${spread.toFixed(1)}px of travel)`);
    note(`lean ${samples[0].lean.toFixed(3)} -> ${samples.at(-1).lean.toFixed(3)}, marker travelled ${spread.toFixed(1)}px`);
  });

  await check('the figure leans with the lean, and topples when the run ends', async () => {
    await page.goto(URL);
    eq(await rotationOf('figure'), 0, 'figure stands upright before a run');
    eq(await rotationOf('arms'), 0, 'arms are level before a run');

    // Start well off centre with little damping so the samples sweep most of the way to
    // the threshold. On the spec defaults a run drifts too slowly to say much.
    await page.evaluate(() => window.__bal.setConfig({
      initialLeanMagnitude: 0.25, damping: 0.2, baseGravityStart: 2.2,
    }));
    await page.click('#start');
    await page.waitForTimeout(150);

    // The figure is a linear readout of tiltFraction, so angle / (lean / threshold) is the
    // same constant at every sample. Testing the ratio rather than a hardcoded 34° means
    // the check survives a retune of how far the figure leans.
    const threshold = (await config()).fallThreshold;
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const [s, deg] = [await state(), await rotationOf('figure')];
      if (!s.isFallen) samples.push({ lean: s.lean, deg });
      await page.waitForTimeout(90);
    }
    ok(samples.length >= 6, `collected ${samples.length} standing samples`);
    const swept = Math.abs(samples.at(-1).lean - samples[0].lean) / threshold;
    ok(swept > 0.3, `samples sweep a real range of the bar (${(swept * 100).toFixed(0)}% of threshold)`);

    const ratios = samples.map((s) => s.deg / (s.lean / threshold));
    const spread = Math.max(...ratios) - Math.min(...ratios);
    ok(spread < 0.5, `tilt stays linear in lean (ratio spread ${spread.toFixed(3)}°)`);
    const perFullLean = ratios[0];
    ok(perFullLean > 5 && perFullLean < 75,
      `full lean tilts the figure a sane amount (${perFullLean.toFixed(1)}°)`);
    for (const s of samples) {
      ok(Math.sign(s.deg) === Math.sign(s.lean) || s.deg === 0,
        `tilt leans the same way as lean (${s.lean.toFixed(3)} -> ${s.deg.toFixed(1)}°)`);
      ok(Math.abs(s.deg) <= Math.abs(perFullLean) + 1e-6, 'tilt never exceeds the full-lean angle');
    }
    note(`lean ${samples[0].lean.toFixed(3)} -> ${samples.at(-1).lean.toFixed(3)}, ` +
      `tilt ${samples[0].deg.toFixed(1)}° -> ${samples.at(-1).deg.toFixed(1)}°`);

    // Let it fall.
    await page.waitForFunction(() => window.__bal.getState().isFallen, null, { timeout: 30000 });
    await page.waitForTimeout(50);
    const fallenDeg = await rotationOf('figure');
    ok(await page.$eval('#scene', (el) => el.classList.contains('fallen')), 'scene shows the fallen state');
    ok(Math.abs(fallenDeg) > Math.abs(perFullLean),
      `the topple goes past any standing lean (${fallenDeg.toFixed(1)}° vs ${perFullLean.toFixed(1)}°)`);
    eq(Math.sign(fallenDeg), Math.sign((await state()).lean), 'falls the way it was leaning');
    eq(await rotationOf('arms'), 0, 'arms stop swinging once the run is over');
  });

  await check('the arms swing against the direction being held', async () => {
    // A fresh gentle run: on a steep one the fall lands before a hold can be observed.
    await page.goto(URL);
    await page.click('#start');
    await page.waitForTimeout(100);

    await page.evaluate(() => window.__bal.setHeld(true, false));
    await page.waitForTimeout(120);
    const leftArms = await rotationOf('arms');
    await page.evaluate(() => window.__bal.setHeld(false, true));
    await page.waitForTimeout(120);
    const rightArms = await rotationOf('arms');
    await page.evaluate(() => window.__bal.setHeld(false, false));
    await page.waitForTimeout(120);
    const noneArms = await rotationOf('arms');

    ok(await page.evaluate(() => window.__bal.isRunning()), 'the run was still live throughout');
    ok(leftArms !== 0 && rightArms !== 0,
      `arms swing while a direction is held (${leftArms}° left, ${rightArms}° right)`);
    eq(Math.sign(leftArms), -Math.sign(rightArms), 'the two directions swing opposite ways');
    eq(noneArms, 0, 'arms return level when nothing is held');
  });

  await check('held keys reach the physics as -1 / 0 / +1', async () => {
    await page.click('#start');
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(150);
    eq((await state()).inputDirection, -1, 'ArrowLeft held reads as -1');
    eq(await page.textContent('#input'), '← left', 'HUD shows left');

    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(150);
    eq((await state()).inputDirection, 0, 'both held cancels to 0');

    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(150);
    eq((await state()).inputDirection, 1, 'right alone reads as +1');

    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(150);
    eq((await state()).inputDirection, 0, 'releasing everything returns to 0');

    // Letter keys work too.
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(150);
    eq((await state()).inputDirection, -1, 'KeyA held reads as -1');
    await page.keyboard.up('KeyA');
  });

  await check('holding the correct direction actually fights the lean', async () => {
    await page.click('#start');
    await page.waitForTimeout(400);
    const before = await state();
    const pushingLeft = before.lean > 0;
    const correcting = pushingLeft ? 'ArrowLeft' : 'ArrowRight';

    await page.keyboard.down(correcting);
    await page.waitForTimeout(250);
    const after = await state();
    await page.keyboard.up(correcting);

    // Signed, not absolute: a correction that works can carry the lean straight through
    // centre and out the other side, which would read as a *larger* |lean|. Direction of
    // travel is the honest measure of "did my input do anything".
    const moved = after.lean - before.lean;
    ok(pushingLeft ? moved < 0 : moved > 0,
      `holding ${correcting} moved lean ${moved.toFixed(3)} (from ${before.lean.toFixed(3)} to ${after.lean.toFixed(3)})`);
    ok(pushingLeft ? after.leanVelocity < 0 : after.leanVelocity > 0,
      `velocity points the corrective way (${after.leanVelocity.toFixed(3)})`);
    note(`lean ${before.lean.toFixed(3)} -> ${after.lean.toFixed(3)} while holding ${correcting}`);

    // Releasing hands control back to gravity, which resumes pulling away from centre.
    const released = await state();
    await page.waitForTimeout(250);
    const drifting = await state();
    if (!drifting.isFallen) {
      ok(Math.abs(drifting.lean) > Math.abs(released.lean) || drifting.leanVelocity !== 0,
        'after release, gravity keeps acting');
    }
  });

  await check('a fall ends the run, reports the time, and logs it', async () => {
    // Make the fall quick and certain rather than waiting on a slow default run.
    await page.evaluate(() => window.__bal.setConfig({ gravityRampRate: 1.5, initialLeanMagnitude: 0.6 }));
    await page.click('#start');
    await page.waitForFunction(() => !window.__bal.isRunning(), null, { timeout: 20000 });

    const s = await state();
    ok(s.isFallen, 'state reports fallen');
    ok(Math.abs(s.lean) >= (await config()).fallThreshold - 1e-9, 'lean reached the threshold');
    ok(s.finalScore !== null && s.finalScore >= 0, `final score recorded (${s.finalScore.toFixed(2)}s)`);

    const status = await page.textContent('#status');
    ok(status.includes('You fell!'), `fall message shown: "${status}"`);
    ok(status.includes(s.finalScore.toFixed(1)), 'message quotes the survival time');
    eq(await page.textContent('#timer'), `${s.finalScore.toFixed(1)}s`, 'timer freezes at the final score');
    ok(await page.$eval('#bar', (el) => el.classList.contains('fallen')), 'bar shows the fallen state');

    const rows = await page.$$eval('#runs-rows tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
    ok(rows.length >= 1, `run log has ${rows.length} row(s)`);
    note(`latest log row: ${rows[0].join(' | ')}`);
    eq(rows[0][3], (await config()).gravityRampRate.toFixed(3), 'log records the ramp rate the run used');
  });

  await check('parameter edits reach the physics on the next run', async () => {
    await page.goto(URL);

    // Type a value into the number field, as a person tuning would.
    await page.fill('#num-correctionStrength', '5.5');
    await page.dispatchEvent('#num-correctionStrength', 'input');
    eq((await config()).correctionStrength, 5.5, 'config picked up the typed value');
    eq(await page.inputValue('#range-correctionStrength'), '5.5', 'slider mirrored the number field');

    // And the slider mirrors back.
    await page.fill('#range-damping', '3');
    await page.dispatchEvent('#range-damping', 'input');
    eq((await config()).damping, 3, 'config picked up the slider value');
    eq(await page.inputValue('#num-damping'), '3', 'number field mirrored the slider');

    await page.click('#start');
    await page.waitForTimeout(200);
    // The live run must be using the edited numbers, not the defaults.
    const c = await config();
    eq(c.correctionStrength, 5.5, 'run uses the edited correctionStrength');
    eq(c.damping, 3, 'run uses the edited damping');
  });

  await check('presets load, and the drunk toggle changes the starting gravity', async () => {
    await page.goto(URL);
    for (const preset of ['spec', 'gentle', 'moderate', 'steep', 'brutal']) {
      await page.click(`.preset[data-preset="${preset}"]`);
      const c = await config();
      const active = await page.$eval(`.preset[data-preset="${preset}"]`, (el) => el.classList.contains('active'));
      ok(active, `${preset} marks itself active when loaded`);
      note(`${preset.padEnd(9)} ramp ${c.gravityRampRate}  correction ${c.correctionStrength}  damping ${c.damping}`);
    }

    await page.click('.preset[data-preset="spec"]');
    const c = await config();

    await page.click('#start');
    eq((await state()).gravityCoefficient, c.baseGravityStart, 'sober run starts at baseGravityStart');
    eq((await state()).isDrunk, false, 'flagged sober');

    await page.check('#is-drunk');
    await page.click('#start');
    eq((await state()).gravityCoefficient, c.drunkGravityStart, 'drunk run starts at drunkGravityStart');
    eq((await state()).isDrunk, true, 'flagged drunk');
    ok(c.drunkGravityStart > c.baseGravityStart, 'drunk starts harder');
  });

  await check('restarting mid-run resets cleanly', async () => {
    await page.goto(URL);
    await page.click('#start');
    await page.waitForTimeout(500);
    const mid = await state();
    ok(mid.elapsedTime > 0.2, 'a run was underway');

    await page.click('#start');
    const fresh = await state();
    ok(fresh.elapsedTime < mid.elapsedTime, 'clock reset');
    eq(fresh.isFallen, false, 'not fallen');
    eq(fresh.leanVelocity, 0, 'velocity reset');
    eq(fresh.inputDirection, 0, 'input reset');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${'='.repeat(60)}`);
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log('='.repeat(60));
console.log(`${results.filter((r) => r.passed).length}/${results.length} checks passed, ${assertions} assertions, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
