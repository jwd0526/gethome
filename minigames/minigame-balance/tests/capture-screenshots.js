// Recapture screenshots/ from the running app.
// Run: node tests/capture-screenshots.js  (starts its own static server)
//
// A run's starting lean sign is random, so these are not byte-identical between runs the
// way the trade-war set is. The config is pinned and the poses are driven through the
// test hook, so the framing and the state each shot is in are the same every time.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const PORT = Number(process.env.BAL_PORT ?? 8141);
const URL = `http://127.0.0.1:${PORT}/index.html`;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
for (let i = 0; ; i++) {
  try { if ((await fetch(URL)).ok) break; } catch { /* not up yet */ }
  if (i > 40) { server.kill(); throw new Error(`server never came up on ${PORT} (set BAL_PORT)`); }
  await new Promise((r) => setTimeout(r, 250));
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1150 } });

async function shot(name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${path.relative(ROOT, file)}`);
}

console.log('capturing balance screenshots:');
try {
  // 1 — idle: figure upright, nothing running
  await page.goto(URL);
  await shot('1-idle');

  // 2 — mid-run, leaning, with a correction held so the arms are swung.
  // Set through the form rather than the test hook, so the parameters visible in the shot
  // are the ones the run is actually using.
  for (const [param, value] of [['initialLeanMagnitude', '0.3'], ['damping', '0.4']]) {
    await page.fill(`#num-${param}`, value);
    await page.dispatchEvent(`#num-${param}`, 'input');
  }
  await page.click('#start');
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__bal.setHeld(true, false));
  await page.waitForTimeout(250);
  await shot('2-running');
  await page.evaluate(() => window.__bal.setHeld(false, false));

  // 3 — fallen: the topple, red, with the run logged
  await page.waitForFunction(() => window.__bal.getState().isFallen, null, { timeout: 30000 });
  await page.waitForTimeout(500); // let the topple animation land
  await shot('3-fallen');

  // 4 — the run log after a few runs, which is what the tuning loop is for
  for (let i = 0; i < 2; i++) {
    await page.click('#start');
    await page.waitForFunction(() => window.__bal.getState().isFallen, null, { timeout: 30000 });
  }
  await page.waitForTimeout(400);
  await shot('4-run-log');
} finally {
  await browser.close();
  server.kill();
}
console.log('done.');
