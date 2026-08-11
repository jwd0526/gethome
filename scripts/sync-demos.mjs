#!/usr/bin/env node
// Refresh minigame-demos/ from the source of truth: each minigame's src/.
//
// The files in minigame-demos/ are single-file builds meant to be handed to someone and
// double-clicked. They are copies, so they go stale silently the moment a game changes —
// this script rebuilds each minigame and copies its dist output over.
//
// Run:
//   node scripts/sync-demos.mjs            build and copy
//   node scripts/sync-demos.mjs --check    report staleness, change nothing (exit 1 if stale)
//
// Discovery is by convention: any minigames/<name>/ with a build.js is a minigame, and
// whatever HTML its build writes into dist/ is its demo. Adding a third game needs no
// edit here.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAMES_DIR = path.join(ROOT, 'minigames');
const DEMOS_DIR = path.join(ROOT, 'minigame-demos');

const checkOnly = process.argv.includes('--check');

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function findGames() {
  if (!isDir(GAMES_DIR)) die(`no minigames directory at ${GAMES_DIR}`);
  const games = readdirSync(GAMES_DIR)
    .filter((name) => isFile(path.join(GAMES_DIR, name, 'build.js')))
    .sort();
  if (games.length === 0) die(`no minigames with a build.js under ${GAMES_DIR}`);
  return games;
}

function build(game) {
  const cwd = path.join(GAMES_DIR, game);
  try {
    execFileSync(process.execPath, ['build.js'], { cwd, stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    // A build that fails leaves the previous dist/ in place; copying it would ship a
    // stale demo under the banner of a fresh sync. Stop instead.
    die(`${game}: build.js failed\n${(err.stderr || err.stdout || err.message).trim()}`);
  }
}

/** Every HTML file the build wrote into dist/. Normally exactly one. */
function builtFiles(game) {
  const dist = path.join(GAMES_DIR, game, 'dist');
  const files = isDir(dist) ? readdirSync(dist).filter((f) => f.endsWith('.html')) : [];
  if (files.length === 0) die(`${game}: build.js produced no HTML in dist/`);
  return files.map((f) => path.join(dist, f));
}

const same = (a, b) =>
  isFile(a) && isFile(b) && readFileSync(a).equals(readFileSync(b));

function die(message) {
  console.error(`sync-demos: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

const stale = [];
const copied = [];

if (!checkOnly) mkdirSync(DEMOS_DIR, { recursive: true });

for (const game of findGames()) {
  build(game);
  for (const src of builtFiles(game)) {
    const dest = path.join(DEMOS_DIR, path.basename(src));
    const upToDate = same(src, dest);
    if (upToDate) {
      console.log(`  ok    ${path.relative(ROOT, dest)}`);
      continue;
    }
    stale.push(path.relative(ROOT, dest));
    if (checkOnly) {
      console.log(`  STALE ${path.relative(ROOT, dest)}`);
      continue;
    }
    copyFileSync(src, dest);
    copied.push(path.relative(ROOT, dest));
    const kb = (statSync(dest).size / 1024).toFixed(1);
    console.log(`  wrote ${path.relative(ROOT, dest)} (${kb} KB)`);
  }
}

if (checkOnly) {
  if (stale.length) {
    console.error(
      `\n${stale.length} demo(s) out of date. Run: node scripts/sync-demos.mjs`
    );
    process.exit(1);
  }
  console.log('\nAll demos match their current build.');
} else {
  console.log(
    copied.length
      ? `\nUpdated ${copied.length} demo file(s) in minigame-demos/.`
      : '\nAll demos were already up to date.'
  );
}
