# Balance — Web POC

Single-player balance/survival minigame from `minigame-balance.md`.
Vanilla JS/HTML/CSS, no frameworks, no build step needed to run.

```
index.html             playfield (figure + bar), tuning form, run log
styles.css             readability styling + the balancing figure
DESIGN.md              design decisions, reuse, and porting caveats
src/balance.js         physics layer — pure, no DOM, JSON-serializable state
src/ui.js              render loop, keyboard, tuning form
build.js               inlines everything into one distributable HTML file
tests/logic-tests.js   physics checks (node)
tests/browser-tests.js end-to-end checks driving real Chromium input
dist/balance.html      generated — the double-click build
```

## Run

```bash
npm run serve       # http://127.0.0.1:8140/index.html
npm test            # physics checks
npm run ui          # end-to-end checks (starts its own server + Chromium)
npm run build       # -> dist/balance.html, one self-contained file
```

Set `BAL_PORT` if 8140 is taken. `npm run ui` needs `npx playwright install chromium` once.

The copy in `minigame-demos/` at the repo root is refreshed from this build by
`node scripts/sync-demos.mjs` (`--check` reports staleness without writing).

## Playing

Hold <kbd>←</kbd>/<kbd>A</kbd> or <kbd>→</kbd>/<kbd>D</kbd> to correct; both or neither
cancels to zero. <kbd>Space</kbd> starts a run. There are also hold-able on-screen buttons
for mouse/touch.

## Tuning

Every parameter is live-editable in the page — slider and number field, mirrored — and
applies on the next run. The **run log** records the settings each result came from, so a
tuning session leaves a readable trail instead of a pile of remembered numbers.

Five presets are provided as starting points, spread across the ramp rate rather than
derived from anything:

| Preset | gravityRampRate | correctionStrength | damping |
|---|---|---|---|
| Spec defaults | 1.02 | 2.5 | 1.5 |
| Gentle | 1.06 | 2.5 | 1.5 |
| Moderate | 1.12 | 2.5 | 1.5 |
| Steep | 1.22 | 2.5 | 1.3 |
| Brutal | 1.35 | 2.8 | 1.1 |

`gravityRampRate` compounds per second, so it is by far the biggest lever on run length —
at 1.02 the pull takes ~35s to merely double, at 1.35 about 2.3s. That is the first dial
to move if runs feel too long or too short. The live HUD shows the current gravity
coefficient, lean, velocity and input so you can see what the numbers are doing.

## Decisions made beyond the spec

Summarised here; the full rationale, rejected alternatives and porting caveats are in
[DESIGN.md](DESIGN.md) and [../PORTING-TO-UNREAL.md](../PORTING-TO-UNREAL.md).

1. **`initialLeanMagnitude` (default 0.02) is an addition, and a necessary one.**
   `gravityForce = gravityCoefficient × lean`, which is exactly zero at `lean = 0`. A run
   starting perfectly centred with zero velocity therefore has no force acting on it and
   would stand still forever — there is no game. Every run needs an opening nudge off dead
   centre; the sign is random. It is exposed as a tunable like everything else, and a
   physics test pins the behaviour at 0 so the reason stays documented in the suite.

2. **Fixed timestep (1/120 s) with an accumulator**, rather than feeding raw frame deltas
   into `tick()`. Euler integration is frame-rate sensitive, so variable steps would make
   the game measurably different on a 60 Hz and a 144 Hz display and make tuning results
   non-comparable. Frame time is capped at 0.25s so a backgrounded tab cannot spiral.

3. **`tick()` returns a full state rather than `{ finalScore }` on the falling tick.**
   The spec's pseudocode returns a different shape on fall; keeping one shape keeps the
   state serializable and the caller simple. `isFallen` and `finalScore` are fields, and
   the spec's ordering is preserved exactly — the fall check runs *before* `elapsedTime`
   accumulates, so the tick you fall on is not credited to your score.

4. **Drunk vs sober is a 1.9% difference** (1.07 vs 1.05) and, per Section 5, both ramp at
   the same rate — so the two curves stay a constant multiple apart for the whole run.
   Whether that is a big enough gap to be felt is a playtest question; both starting values
   are editable in the UI.

Section 9's open questions 2 and 3 are implemented as the spec assumed: the drunk toggle is
a manual testing checkbox, and multiplayer/spectator is out of scope for this POC.

## Portability

`src/balance.js` has no DOM references. State and config are plain numbers and booleans,
verified to survive a JSON round-trip and keep simulating identically. Key handling is
reduced to a single `-1 | 0 | 1` by `reduceInput(leftHeld, rightHeld)` *before* it reaches
the physics, so nothing platform-shaped leaks into `tick()` — which is what makes it a
near-direct transliteration into Unreal's `Tick()`.
