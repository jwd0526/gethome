# Trade War — Web POC

Proof of concept for the card minigame specified in `minigame-tradewar.md`.
Vanilla JS/HTML/CSS, no frameworks. Local pass-and-play on one device.

```
index.html             markup for all five screens
styles.css             readability styling + the card faces and backs
DESIGN.md              design decisions, reuse, and porting caveats
src/game.js            rules/state layer — pure, no DOM, JSON-serializable state
src/ui.js              rendering + input; never decides legality itself
build.js               inlines everything into one distributable HTML file
tests/logic-tests.js   state-level checks (node)
tests/browser-tests.js end-to-end checks driving real Chromium clicks
tests/dist-smoke.js    proves the built single file plays over file://
dist/trade-war.html    generated — the double-click build
screenshots/           captured from the running app
```

## Run

```bash
npm run serve                   # then open http://127.0.0.1:8137/index.html
npm test                        # rules-layer checks (node, no browser)
npm run ui                      # end-to-end checks (starts its own server + Chromium)
```

`npm run ui` needs `npx playwright install chromium` once. Set `TW_PORT` if 8137 is busy.

The copy in `minigame-demos/` at the repo root is refreshed from this build by
`node scripts/sync-demos.mjs` (`--check` reports staleness without writing).

## Distributing it

```bash
npm run build                   # -> dist/trade-war.html  (one file, ~49 KB)
npm run test:dist               # build, then play full 4p + 6p games over file://
```

`dist/trade-war.html` is the whole game in a single file: CSS and both modules inlined, no
external requests, no server, no install. Double-click it and it opens in the default
browser. Email it or drop it on a USB stick to hand out for playtesting.

The modules are concatenated rather than left as separate files because browsers refuse to
fetch module imports over `file://`. Edit `src/`, never `dist/` — the build regenerates it
and fails loudly if any external reference survives.

From Windows, the built file lives at:

```
\\wsl.localhost\Debian\home\jwd0526\dev\minigames\dist\trade-war.html
```

## Architecture

`src/game.js` is the portable half. It exports the contract from Section 9:

```js
applyAction(state, { playerId, actionType, payload }, now) // -> { success, newState, error? }
checkGameOver(state)                                        // -> bool
computeScores(state)                                        // -> { [playerId]: number }
```

State is plain JSON — no classes, no functions, no DOM handles — and the test suite
asserts it survives a `JSON.stringify`/`parse` round-trip mid-game and keeps playing.
Rejected actions return the *same* state object, so a failed call cannot half-mutate
anything. The timer is a `timerEndsAt` number in state, evaluated by `resolveTimeout`,
not by a UI component.

The UI never independently decides what is legal: buttons call `applyAction` and render
whatever comes back. Not rendering a Lock button on a locked card is convenience only —
the rules layer rejects the action too, and the browser tests bypass the UI to prove it.

### Round resolution

Each action resolves the moment it is submitted, so the acting player watches their own
card lock, flip or swap before the device is passed on. A result beat then holds the
screen — showing the changed card badged and spelled out in words — until they tap
*Done — pass the device*.

Section 4.3's required order (`FORCE_TRADE` before everyone else's action) is preserved by
**turn order** rather than by batching: pass-and-play submission order is the active
player first, then seating order, so the round's one possible Force Trade always lands
before any other player acts. `CHECK 3b` asserts that invariant every round of both
formats, and that the trade is the first resolved event of its round.

A player traded on mid-round sees a banner on their turn naming the slot that was taken
and the card left in its place, since the hand in front of them is no longer the one they
last saw.

## Decisions made beyond the spec

Summarised here; the full rationale, rejected alternatives and porting caveats are in
[DESIGN.md](DESIGN.md) and [../PORTING-TO-UNREAL.md](../PORTING-TO-UNREAL.md).

1. **Timer-expiry fallback** (the open question in Section 8) — implemented as the spec's
   assumed behaviour: auto-`LOCK` the lowest-value unlocked card, ties broken by lowest
   hand position so it is deterministic. Recorded on the action as
   `autoResolved: 'TIMEOUT'`. **Still worth confirming** — the alternatives (auto-`REPLACE`,
   or forfeit-with-no-action) are a one-line change in `resolveTimeout`.

2. **Swaps and replacements happen in place.** Section 5 says "remove … add", which would
   let hand positions shuffle. Position is the entire point of the blind pick and of the
   cross-round tracking/bluffing layer, so a replaced or traded card takes the exact index
   of the card it displaces. Hand length is always N.

3. **Actions resolve on submit rather than in an end-of-round batch** (see *Round
   resolution* above). Batching would mean a player never sees their own lock take effect,
   never sees the card they drew from a Replace, and never sees what a blind Force Trade
   actually won them — the feedback would all arrive a screen later, attributed to nobody.
   Resolving immediately is also what makes a chosen card impossible to yank out from under
   its owner between choosing and resolving, since the two are now the same instant.

4. **Between-round summary is redacted.** The round summary is on the shared screen, so it
   reports actions by *position* and never names a card. Section 7 keeps the traded card
   private to its new owner; the trader learns what they took by looking at their own hand.
   Full-detail text exists in `state.log` and is shown only on the end screen.

5. **The end-of-game force-lock sweep (Section 6.1) is a safety net that legal play never
   triggers.** Every action retires exactly one unlocked card per player per round — a
   Force Trade target loses the taken card but receives an unlocked one and then still acts
   — so unlocked count is always `N - roundsCompleted`, reaching 0 exactly at the end of
   round N. The sweep is implemented and tested anyway (`CHECK 7b` plants a straggler).

6. **Drunkenness** is entered on the setup screen, standing in for the value the parent game
   would supply. It is used only for the tiebreak. A drunkenness tie on top of a score tie
   is left to the parent game, per Section 6.4.

## Test hooks

`window.__tw` exposes `getState`, `getScreen`, `expireTimer` and `tryActions` (a read-only
probe of `applyAction` used to attack the rules layer from outside the UI). Test-only; it
has no role in gameplay.
