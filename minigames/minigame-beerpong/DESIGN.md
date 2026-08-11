# Beer Pong POC — design notes

What the code decided that the spec left open, and what a port must not break.
Section references are to `minigame-beerpong.md`.

## 1. Shape

```
src/meter.js     Template A timing meter. Pure, and knows nothing about beer pong.
src/beerpong.js  rules/state. Pure: no DOM, no timers, no rendering.
src/ui.js        meters, throw animation, screens. Owns nothing authoritative.
```

The split is the same one Trade War and Balance use, for the same reason: the rules layer
is the thing that ports, and it ports cleanly only if nothing in it can reach the DOM.

---

## 2. Decisions

### D1 — The meter is its own module, not part of the game

**Decision.** `meter.js` has no beer-pong types in it. It sweeps a marker between 0 and 1,
you lock it, you get a number.

**Why.** Section 10 asks whether the four Template A games share one meter rather than
reimplementing it each time. They should, and this is that module — but there is no shared
package in this repo yet and inventing one for a single consumer is speculative. It is
written so that extracting it is a file move: no imports, no game vocabulary, no config
beyond speed and starting edge.

**Consequence.** When Bottle Flip, Axe Throwing or Last Round Pour lands, move this file up
rather than copying it. If a second copy ever appears, they will drift.

### D2 — The sweep reflects instead of clamping

**Decision.** `tickMeter` folds an overshoot back into range by reflection, however far past
an end it went, and flips direction accordingly.

**Why.** The obvious implementation clamps to 0 or 1 and flips. That is correct for small
steps and wrong for large ones: a backgrounded tab hands you a 3-second frame, and the
marker parks on an end instead of landing where it would have. Reflection makes one coarse
step land where many fine ones would, which the tests assert directly.

### D3 — Aim and power map onto a **fixed** lane, not the current rack

**Decision.** `aimToX` and `powerToY` map the 0..1 meter readings onto the *full* rack's
extent plus a margin, and that mapping never changes as cups are sunk or the rack is
re-formed.

**Why.** Mapping onto the live rack's width was the tempting reading of Section 6 ("across
the opposing rack's current width"), and it inverts what a re-rack is. If the lane narrows
as the rack narrows, each meter unit covers less table and a 3-cup rack becomes *easier* to
hit per unit of timing precision. In reality the cups get closer together and the table
does not move. Fixed lane, moving cups.

**Consequence.** A re-rack genuinely rewards the shooter — the survivors bunch toward the
centre of a lane that stayed the same size.

### D4 — Re-rack is `remaining <= threshold`, checked only at `startTurn`

**Decision.** `checkRerack` fires when the count is at *or below* a threshold that has not
already been applied, and the only caller is `startTurn`.

**Why.** Two throws can take a rack from 7 to 5 and never be equal to 6, and Section 4's own
example expects exactly that case to re-rack. `===` would silently skip it. Putting the only
call in `startTurn` is what makes Section 4's deferral rule fall out for free rather than
being enforced by a flag: a rack that crossed a threshold mid-turn is re-formed when the
next turn opens, and because a bonus repeat turn goes through `startTurn` too, it re-triggers
the check exactly as the spec says it must.

**Consequence.** `appliedThresholds` lives on the team, so each step fires once per match
even though the condition stays true forever after.

### D5 — A re-rack drops sunk cups; before one, they persist

**Decision.** `applyThrow` marks a cup `isSunk` and leaves it in `cupRack`. `repack` builds
the new rack from survivors only, so sunk cups disappear from the array at that point.

**Why.** Keeping sunk cups is what lets the renderer draw the ghost rings that make the
rack's original shape readable. Once the rack is physically re-formed, those positions mean
nothing — the cups are off the table and the survivors are in a new triangle.

**Consequence.** The rendering differs either side of a re-rack (ghosts, then none). That is
the honest depiction: it matches what is actually on the table.

### D6 — Survivors fill the new layout front to back

**Decision.** `repack` drops survivors into the new triangle's slots in order, front row
first, left to right, and a layout with more slots than cups simply leaves the tail unused.

**Why.** The thresholds do not line up with the counts — 5 cups can owe the 6-slot 1-2-3
layout, and 2 can owe the 3-slot 1-2. Something has to decide which slots go empty, the
spec does not say, and front-filling is both how a rack is re-formed in practice and
deterministic enough to test.

### D7 — Clearing the rack does not win; only sudden death ends the match

**Decision.** `applyThrow` flips `suddenDeathActive` when the last cup goes, and `phase`
only ever reaches `GAME_OVER` out of `resolveSuddenDeathTurn`.

**Why.** Section 1 says the side whose rack is cleared "loses" and Section 7 says clearing
"does not end the game" — Section 7 is the specific rule and wins. The consequence is worth
stating plainly because it is counterintuitive: **the side that got cleared can win.** Their
rack being empty has no further effect; both sides shoot at the same respawning cup from
there, and the match is decided on streaks alone.

**Consequence.** `winnerTeamId` is never set by a rack going empty. `CHECK 9` asserts the
match is still live at that moment.

### D8 — Matching the target does not win, it raises the bar

**Decision.** On a turn ending in sudden death: no target yet → set it; streak ≥ target →
set the new target and pass; streak < target → the target holder wins, immediately.

**Why.** This is the part of Section 7 the spec itself flagged as a best-effort synthesis,
so it is worth being explicit about what was built. A match can ping-pong indefinitely with
each side matching the other; nobody wins by *reaching* a number, only by the other side
*failing* to. There are no ties by construction — a match ends only on a failure, and a
failure names a winner.

**Consequence.** `suddenDeathTargetTeamId` has to be tracked separately from `activeTeamId`,
because the winner is the side that set the standing target, not the side that just threw.

### D9 — The streak counts hits, and survives bonus turns

**Decision.** `suddenDeathCurrentStreak` increments per hit on the sudden-death cup, is
never reset at a turn boundary, and is only zeroed when possession changes.

**Why.** Section 7 counts a streak "while a team's turn keeps continuing (via repeated
sink-both bonus turns)". A bonus turn is a new turn, so resetting per turn would cap every
streak at 2. The clearing shot itself is excluded because it was a throw at a rack, not at
the sudden-death cup.

### D10 — The throw animation is required, and reads from the result

**Decision.** `applyThrow` returns a `throwResult` carrying the computed `(x, y)`; the UI
arcs a ball to it over ~0.7s and only then advances the turn.

**Why.** Section 6 makes this part of the spec rather than a nicety: the whole point of two
meters is that the player can see where their timing sent the ball, and a text verdict does
not tell them whether they were wide or short. The dashed landing ring is the tolerance
radius, so a near miss visibly *is* a near miss.

**Port note.** The logic never knows the animation exists. `throwResult` is the entire
contract, and a renderer that ignores it still plays a correct game.

---

## 3. Invariants the tests exist to protect

| Invariant | Check |
|---|---|
| 1st plays solo at 3; 1st + 4th pair at 4; ties break on drunkenness | `CHECK 1` |
| The rack is a centred 1-2-3-4 triangle | `CHECK 2` |
| Re-rack fires at or below 6 and 3, once each | `CHECK 3` |
| A mid-turn crossing defers to the next turn start, bonus turns included | `CHECK 4` |
| Two throws a turn; sink both keeps the balls | `CHECK 5` |
| Solo sides throw both balls; pairs alternate and swap lead-off | `CHECK 6` |
| Every cup is reachable; tolerance decides; nearest cup wins | `CHECK 7` |
| Drunkenness moves aim, never power, and is a no-op at 0 | `CHECK 8` |
| Clearing a rack starts sudden death and does not end the match | `CHECK 9` |
| The sudden-death cup respawns; streaks survive bonus turns | `CHECK 10` |
| Matching raises the bar; falling short loses | `CHECK 11`, `CHECK 12` |
| The meter stays in range and is step-size independent | `CHECK 13` |
| GameState survives a JSON round trip and plays on | `EXTRA` |
| The ball lands where aim and power said | UI: "the ball lands where…" |
| The built single file plays over `file://` | `tests/dist-smoke.js` |

---

## 4. Porting caveats

**C1 — The lane mapping is a rendering-adjacent constant.** `aimToX`/`powerToY` bake in the
full rack extent plus margins. In Unreal these become world-space positions on a real
table; keep the *fixed lane* property (D3) when remapping, or the difficulty curve inverts.

**C2 — Cup coordinates are already the port's data shape.** `CupSlot` carries plain numeric
`{x, y}` in rack units. Section 10 asks for exactly this so the port remaps a coordinate
space rather than redesigning a structure. Nothing else in the state should grow a
non-serializable field.

**C3 — The RNG stream is part of the state.** `rngCursor` advances once per throw and seeds
a fresh generator, so a match replays exactly from `{seed, rngCursor}`. A port that reaches
for a global RNG loses replay, and with it the ability to reproduce a reported bug.

**C4 — Two throws can end a match mid-turn.** `advanceAfterThrow` may return a `GAME_OVER`
state on the first ball of a turn. A renderer that assumes it always gets a second throw
will animate into a finished match.

**C5 — A perfect shooter never gives up the balls.** Sink-both repeats the turn with no cap,
so a side that never misses holds possession forever. That is the spec working as written
and it is fine for humans, but any AI opponent needs a miss rate or the match will not
terminate. The logic tests hit this immediately and drive with realistic miss rates because
of it.
