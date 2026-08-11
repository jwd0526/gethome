# Beer Pong — Web POC

Proof of concept for the minigame specified in `minigame-beerpong.md`.
Vanilla JS/HTML/CSS, no frameworks, no build step needed to run.

```
index.html             setup, the table, and the end screen
styles.css             readability styling + the 2D table and meters
DESIGN.md              design decisions, reuse, and porting caveats
src/meter.js           Template A timing meter — pure, game-agnostic
src/beerpong.js        rules layer — pure, no DOM, JSON-serializable state
src/ui.js              meters, throw animation, screens; decides no rules
build.js               inlines everything into one distributable HTML file
tests/logic-tests.js   rules + meter checks (node, no browser)
tests/browser-tests.js end-to-end checks driving real Chromium input
tests/dist-smoke.js    proves the built single file plays over file://
tests/capture-screenshots.js  regenerates screenshots/
dist/beer-pong.html    generated — the double-click build
screenshots/           captured from the running app (npm run shots)
```

## Run

```bash
npm run serve       # http://127.0.0.1:8142/index.html
npm test            # rules + meter checks
npm run ui          # end-to-end checks (starts its own server + Chromium)
npm run build       # -> dist/beer-pong.html, one self-contained file
npm run test:dist   # build, then prove the single file plays over file://
npm run shots       # recapture screenshots/ from the running app
```

`npm run ui` needs `npx playwright install chromium` once. Set `BP_PORT` if 8142 is busy.

The copy in `minigame-demos/` at the repo root is refreshed from this build by
`node scripts/sync-demos.mjs` (`--check` reports staleness without writing).

## Playing

Each throw is two chained meters. Press **Throw** (or <kbd>Space</kbd>) to start the aim
meter sweeping, <kbd>Space</kbd> again to lock it, and a third time to lock power. Aim is
where the ball goes left-to-right; power is how far it carries. Both have to land within
the tolerance radius of a cup for it to sink.

Two throws to a turn. Sink both and you get the balls back and throw again; miss either
and possession passes. Clearing the opposing rack does **not** win — it starts sudden
death, where both sides shoot at one respawning cup and the match is decided on streaks.

## Setup and standings

Sides are seeded from session standings (spec Section 3):

| Players | Format | Seeding |
|---|---|---|
| 2 | 1v1 | the two players |
| 3 | 1v2 | 1st plays solo against 2nd + 3rd |
| 4 | 2v2 | 1st + 4th against 2nd + 3rd |

Ties on standing points break on drunkenness — the drunker player ranks higher, the same
tiebreak used elsewhere in the game. Leave every standing at 0 and the draw is random,
which is the first-game-of-a-session case.

## Tuning

`toleranceRadius` and `maxAimOffset` are the two dials Section 6 calls out, and both are
live on the match screen — edits apply to the very next throw. The meter speeds are there
too, since sweep speed is the real difficulty control.

Cups sit **1.0 apart** in rack units, so a tolerance of 0.5 means "anywhere in the cup's
own footprint" and anything above that starts overlapping neighbours (the nearer cup wins).
The dashed ring drawn where each ball lands *is* the tolerance radius — it is there to make
tuning legible rather than guesswork.

## Drunkenness

Per spec, drunkenness perturbs **aim only**, never power:

```
adjustedAim = lockedAim + random(-1, 1) × maxAimOffset × drunkenness
```

At 0 it is exactly a no-op, so a sober player's lock is used verbatim. Values are per
player and set on the setup screen (0–1).
