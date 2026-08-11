# Beer Pong — Minigame Build Spec

**Status:** Web POC (proof of concept) — simple UI, functional only.
**Future target:** Unreal Engine port. Core logic engine-agnostic (see Section 10), same approach as Trade War / Balance Game.
**Template:** A, chained ×2 per throw (aim meter, then power meter)
**Scene:** Game Wall
**Players:** 2, 3, or 4 (see Section 3 for format by count)

---

## 1. Overview

Two sides throw at a 10-cup triangle rack. Each turn, the throwing side gets 2 ball throws (solo players throw both themselves; 2-player teams alternate). Each throw is resolved via a chained pair of Template A timing meters — an **aim meter** (horizontal targeting across the rack) followed by a **power meter** (depth/arc accuracy) — landing both within tolerance of a remaining cup sinks it. Sinking both throws in a turn returns the balls and repeats the turn for the same side. The rack auto re-racks into a tighter triangle at fixed cup-count thresholds, checked only at the start of a turn. First side to have their entire rack cleared loses.

---

## 2. Data Model

```
Player {
  id: string
  teamId: string
  drunkenness: number         // 0.0 - 1.0, externally supplied. Perturbs this player's AIM result only (see Section 6).
}

Team {
  id: string
  playerIds: string[]        // length 1 (solo) or 2 (paired)
  cupRack: CupSlot[]           // this team's own cups, being defended
}

CupSlot {
  id: string
  row: number                 // 0 = front tip, increasing toward back
  col: number                  // position within row, 0-indexed left to right
  x: number
  y: number                    // scene coordinates for aim/power targeting — derived from current rack layout
  isSunk: boolean
}

GameState {
  teams: Team[2]
  matchFormat: "1v1" | "1v2" | "2v2"
  activeTeamId: string
  currentThrowerId: string      // specific player on the active team throwing this ball
  throwsThisTurn: number         // 0, 1, or 2
  sinksThisTurn: number
  turnBonusPending: boolean       // true if both throws this turn sank, triggers a repeat turn, re-rack check runs again
  rerackThresholdsApplied: Set<number>  // per team: tracks which thresholds (6, 3) have already fired this game
  suddenDeathActive: boolean        // true once either rack has been fully cleared — target switches to the single sudden-death cup
  suddenDeathCurrentStreak: number    // consecutive makes by whichever team is currently shooting during sudden death
  suddenDeathTargetStreak: number | null  // the streak the CURRENT shooter must reach/beat, set by the previous shooter's result; null only before the first team's attempt has ever ended
  phase: "AIM" | "POWER" | "RESOLVE_THROW" | "RESOLVE_TURN" | "SUDDEN_DEATH" | "GAME_OVER"
}
```

---

## 3. Setup — Team Format by Player Count

- **2 players:** 1v1.
- **3 players:** 1v2. Matchup determined by current session standings — **1st place plays solo** against 2nd + 3rd combined. If this is the first game of the session (no standings yet), matchup is random.
- **4 players:** 2v2, paired by standings — **1st + 4th vs. 2nd + 3rd**. Random pairing if first game of the session.
- **Standings ties:** if two or more players are tied for a ranking position that affects matchup assignment, the drunker player is ranked higher (same tiebreak used elsewhere in the game).
- Each side starts with a full 10-cup rack: **4-3-2-1** (row 0 = front tip with 1 cup, row 3 = back row with 4 cups).

---

## 4. Cup Rack & Re-Rack Logic

**Initial layout (10 cups):** rows of 1-2-3-4 (front to back).

**Re-rack thresholds — checked only at the start of a turn, never mid-turn:**
- When a team's `cupRack` remaining count reaches **6**, re-rack into 1-2-3 (front to back).
- When a team's `cupRack` remaining count reaches **3**, re-rack into 1-2 (front to back).
- Below 3 cups, no further re-rack is needed — remaining cups (2 or 1) stay in place as-is.

**Timing rule (explicit, since this was called out as important):** if a team's cup count crosses a threshold *during* a turn (e.g., drops from 7 to 5 within one turn's two throws), the re-rack does **not** happen immediately — it's deferred until the **start of the next turn** in which that rack is being thrown at. **Confirmed:** this explicitly includes bonus repeat turns — when a team gets balls back after sinking both throws, that bonus turn's start re-triggers the re-rack check just like any other turn start.

---

## 5. Turn Flow

1. **Turn start:** identify `activeTeamId` and the opposing team's rack (the one being thrown at). Run the re-rack check (Section 4) against that rack before any throws happen this turn.
2. **Determine thrower order for this turn:**
   - Solo side (1v1, or the solo player in 1v2): same player throws both balls.
   - Paired side (2v2, or the 2-player side in 1v2): the two players alternate. **Confirmed:** who throws first alternates turn-to-turn, so both players get equal first-throw reps across a game.
3. **Throw 1:** run AIM meter (Template A, horizontal targeting) → lock → run POWER meter (Template A, depth/arc accuracy) → lock → resolve (Section 6).
4. **Throw 2:** repeat step 3 with the next thrower per the order determined in step 2.
5. **Turn resolution:**
   - If both throws sank a cup (`sinksThisTurn == 2`): balls return, `turnBonusPending = true`, same team throws again — return to step 1 (this counts as a new turn start for re-rack purposes, per Section 4).
   - Otherwise: turn passes to the other team — return to step 1 with `activeTeamId` swapped.

---

## 6. Throw Resolution — Aim/Power → Hit Determination

**Design decision (was an open assumption, now the working model — flag before build if this doesn't match intent):**

- The **aim meter** result maps to a horizontal (x) target position across the opposing rack's current width.
- The **power meter** result maps to a depth/arc (y) target position — how far the throw carries.
- **Drunkenness perturbation (applied to AIM only):** after the player locks in their aim meter value, apply a random offset before it's used: `adjustedAim = lockedAimValue + (random(-1, 1) × maxAimOffset × player.drunkenness)`. At `drunkenness = 0`, this is a no-op (fully sober = no adjustment). At `drunkenness = 1`, the full `maxAimOffset` range can apply. `maxAimOffset` is a tunable constant — start small enough that a skilled, sober player's precise aim still reliably lands, then tune. Power is **not** affected by drunkenness in this spec — only aim, per design.
- Combined `(adjustedAim, power)` target is compared against all currently un-sunk `CupSlot` positions on the defending rack. If the target falls within a tolerance radius of a cup's `(x, y)`, that cup is sunk (`isSunk = true`, removed from remaining count). Otherwise, miss.
- Tolerance radius is a tunable constant — smaller = harder, larger = more forgiving. Tune from playtesting.

**Required 2D visual representation:** this cannot resolve as a silent number comparison — the throw needs an actual on-screen animation so the outcome is legible to the player. Minimum viable version: a simple 2D top-down or side-view scene where a ball icon visibly travels from the thrower's position to the computed `(x, y)` target along a short arc (a basic quadratic curve is enough, no physics engine needed), over roughly 0.5–1 second. On arrival: if it's a hit, the corresponding cup visually disappears from the rack; if a miss, the ball simply lands/bounces off short of or past the rack. This applies to every throw in the POC, not just a text "SUNK/MISS" result — the aim and power meter results need to visibly cash out as where the ball actually goes.

---

## 7. Sudden Death (Post-Clear Overtime)

Triggered the moment a team's throw removes the **last** remaining cup on the opposing rack — this does **not** end the game immediately.

**How it works:**
- The target switches from "the opponent's rack" to a **single fixed cup**, placed centered and in the back position, on whichever side is currently being shot at. This cup instantly resets/respawns after every hit — it never depletes, it's purely a streak-tracking target now.
- **Normal turn structure continues exactly as in Section 5** — 2 throws per turn, sink-both still returns balls and continues the same team's turn, missing either throw ends the turn and passes possession to the other team. Nothing about turn mechanics changes; only the target does.
- **Streak tracking:** while a team's turn keeps continuing (via repeated sink-both bonus turns), `suddenDeathCurrentStreak` increments by 1 per successful hit on the sudden-death cup. The clearing shot itself does **not** count toward this streak — the streak starts fresh at 0 once sudden death begins, only counting hits on the new sudden-death cup.
- **When a team's turn ends** (a miss occurs, breaking the sink-both chain), their final `suddenDeathCurrentStreak` is compared against the current `suddenDeathTargetStreak`:
  - **First team ever to end a turn in sudden death:** there's no target yet — their streak simply becomes the target (`suddenDeathTargetStreak = theirStreak`), and turn passes to the other team as normal, whose job is now to match or beat it.
  - **Every team after that:** if their streak reaches or exceeds the standing target, they've matched it — **this does not win them the game.** Instead, their achieved streak becomes the new `suddenDeathTargetStreak`, and it flips back to the other team to try to match *that*. This can repeat indefinitely.
  - If their streak falls short of the standing target, they lose immediately — **the team who set that standing target wins.**
- **No ties, ever.** Only the player(s) on the winning team receive points from this minigame; the losing side receives none.
- Throw resolution during sudden death uses the exact same aim/power/drunkenness/tolerance logic as Section 6 — the only difference is there's just one candidate `CupSlot` (the fixed center-back position) instead of a full rack to check against.

**One clarifying note:** this section is my best-effort synthesis of a fairly complex verbal description — the core loop (normal turns, single respawning cup, streak-vs-target, no winning on a mere match, only on the *other* side's subsequent failure) should be right, but flag anything that doesn't match what you had in mind before this goes into build.

---

## 8. End Game & Scoring

- A team loses when the Sudden Death sequence (Section 7) resolves against them.
- **Out of scope for this spec:** how a Beer Pong win/loss converts into the macro game's overall point pool — that's the parent game loop's job. This minigame only needs to report the winning team ID (and, per Section 7, that only winning-side players receive points) back up the chain, consistent with the score-reporting contract described in Trade War's equivalent section.

---

## 9. Web POC — Simple UI Spec

- **Rack display:** simple circles/dots arranged in the current triangle layout for both sides — no cup art needed, just position + filled/empty state.
- **Aim meter:** a horizontal bar with a moving marker, click/key to lock — same pattern as other Template A games.
- **Power meter:** a vertical or separate horizontal bar, moving marker, click/key to lock, appears immediately after aim locks.
- **Turn indicator:** plain text — `"Team A's turn — Player 2 throwing (Ball 1 of 2)"`.
- **Throw animation (required, see Section 6):** a simple 2D ball icon arcing from thrower to landing target, cup disappearing on a hit — this is functional, not decorative, since it's how the player confirms aim/power actually mapped to the right place. Plain shapes are fine (circle for ball, circles for cups), no art pass needed.
- **Re-rack event:** plain text notice when it happens — `"Rack reset to 3-2-1"` — helps confirm the timing rule (Section 4) is working correctly during testing.
- **Sudden Death indicator:** once triggered, plain text showing the current shooter's live streak and, once a target exists, what they need to beat — e.g., `"SUDDEN DEATH — Team A streak: 2 (need 4 to beat Team B)"` or, before any target is set, `"SUDDEN DEATH — Team A streak: 2 (setting the target)"`.
- **End state:** plain text — `"Team B wins! Team A's streak of 3 fell short of Team B's 5."`

---

## 10. Engine-Agnostic Logic Design (for future Unreal port)

Same approach as Trade War and Balance Game:

- Throw resolution (Section 6), turn flow (Section 5), re-rack logic (Section 4), and Sudden Death (Section 7) should all live in a pure logic module: `applyThrow(state, aimResult, powerResult) → newState`, `checkRerack(team) → newRackLayout`, with no DOM/rendering calls inside — the 2D throw animation (Section 9) is a rendering-layer concern that reads the logic module's output, not something the logic itself needs to know about.
- `GameState`, `Team`, and `CupSlot` are all plain serializable data — this matters more here than in Trade War, since `CupSlot` positions will eventually need to match real 3D world-space coordinates in Unreal; keeping them as plain `{x, y}` now means the Unreal port only needs to remap coordinate space, not redesign the data shape.
- The aim/power meters themselves are two more instances of the same Template A logic already used in Bottle Flip / Axe Throwing / Last Round Pour — worth confirming this shares the exact same underlying "timing meter" module across all four A-template games rather than reimplementing meter logic per game.

---

## 11. Open Questions / Assumptions Made

None remaining — all prior items are resolved. This spec is build-ready.