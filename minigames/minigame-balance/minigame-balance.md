# Balance Game — Minigame Build Spec

**Status:** Web POC (proof of concept) — simple UI, functional only.
**Future target:** Unreal Engine port. Core logic engine-agnostic (see Section 8), same approach as Trade War.
**Template:** Exception — continuous-input balance/survival, doesn't fit Templates A-D cleanly (same reasoning as the earlier "Stacked Stool" discussion: this needs a persistent per-frame physics loop, not a single-shot timing check).
**Scene:** The Stage
**Players (actual game):** All players run an independent, simultaneous instance — no interaction between players. Highest survival time wins. Last one standing (i.e., everyone else has fallen) also implicitly wins if that happens first.
**Players (this POC):** 1 — single-player only, no opponent/comparison logic needed for the demo.

---

## 1. Overview

Player balances a "lean" value at center. An invisible force constantly pulls the lean away from center, growing stronger the longer you survive and the further off-center you already are. Player holds Left/A or Right/→ to counteract it. Overcorrecting past center is possible and dangerous — the same force that was pulling you one way now pulls you the other. Falling (`|lean| ≥ 1`) ends the round. Score = survival time.

---

## 2. Data Model

```
BalanceGameState {
  lean: number              // -1.0 to 1.0, 0 = centered
  leanVelocity: number       // current rate of change of lean
  gravityCoefficient: number  // current strength of the away-from-center pull, grows over time
  elapsedTime: number         // seconds survived this run
  inputDirection: -1 | 0 | 1  // current held input: -1 = left/A, +1 = right/→, 0 = neither/both cancel
  isFallen: boolean
  isDrunk: boolean            // externally supplied, sets starting gravityCoefficient
}

BalanceConfig {
  fallThreshold: number         // default 1.0 — |lean| at or beyond this = fall
  correctionStrength: number    // acceleration applied while a direction is held — TUNABLE, see Section 6
  damping: number                // velocity damping factor per second, prevents runaway oscillation — TUNABLE
  baseGravityStart: number       // sober starting gravityCoefficient, default 1.05
  drunkGravityStart: number      // drunk starting gravityCoefficient, default 1.07
  gravityRampRate: number        // per-second growth multiplier applied to gravityCoefficient — TUNABLE, identical for sober and drunk
}
```

---

## 3. Physics Update (runs every tick, `dt` = delta time in seconds)

```
function tick(state, config, dt):
  // 1. Difficulty ramp — same growth rate regardless of drunk state
  state.gravityCoefficient *= (config.gravityRampRate ** dt)

  // 2. Forces
  gravityForce = state.gravityCoefficient * state.lean       // pulls AWAY from center, scales with how far off you already are
  inputForce = config.correctionStrength * state.inputDirection

  netAcceleration = gravityForce + inputForce

  // 3. Integrate velocity with damping (prevents chaotic oscillation, keeps it feeling like a wobble not a glitch)
  state.leanVelocity += netAcceleration * dt
  state.leanVelocity *= (1 - config.damping * dt)

  // 4. Integrate position
  state.lean += state.leanVelocity * dt

  // 5. Fall check
  if abs(state.lean) >= config.fallThreshold:
    state.isFallen = true
    return { finalScore: state.elapsedTime }

  state.elapsedTime += dt
  return state
```

Note the fall-direction logic needs no special case: since `gravityForce` always shares `lean`'s sign, holding a correction too long naturally drives you past center and gravity flips against you from the opposite side — overcompensation is an emergent property of the formula, not a separate rule.

---

## 4. Input Handling

- **Left / A** → `inputDirection = -1` while held
- **Right / → (Right Arrow)** → `inputDirection = +1` while held
- Both held simultaneously, or neither held → `inputDirection = 0`
- No cooldown, no debounce — this is a continuous hold-based control, sampled every tick

---

## 5. Difficulty Ramp & Drunkenness

- `gravityCoefficient` starts at `baseGravityStart` (sober, default **1.05**) or `drunkGravityStart` (drunk, default **1.07**)
- From that starting point, it grows every tick at the **same rate** (`gravityRampRate`) regardless of drunk state — drunk players start harder, not steeper
- This means: at any given elapsed time `t`, `gravityCoefficient(t) = startValue × (gravityRampRate ^ t)` — drunk players are always facing a proportionally-scaled-up version of what sober players face at the same timestamp, never a different curve shape

---

## 6. Tuning Targets & Starting Defaults

**Target:** a skilled player should survive roughly **30-45 seconds**.

These starting values are a reasonable first pass, **not derived numbers** — this game's feel can only be tuned by actually playing it, same as any balance/physics game:

| Parameter | Suggested starting value | Notes |
|---|---|---|
| `fallThreshold` | 1.0 | Confirmed |
| `correctionStrength` | 2.5 | Player's push should feel noticeably stronger than gravity at low `gravityCoefficient`, or the game is unwinnable from second one |
| `damping` | 1.5 | Prevents oscillation from spiraling into an unrecoverable death-wobble too early; lower = twitchier/harder, higher = floatier/easier |
| `baseGravityStart` (sober) | 1.05 | Given |
| `drunkGravityStart` (drunk) | 1.07 | Given |
| `gravityRampRate` | 1.02 (2% growth per second, compounding) | This is the one most likely to need retuning to hit the 30-45s target — if playtests fall short of 30s, lower this; if runs drag past 45s, raise it |

**Recommended build step:** implement with these defaults, then run several playtest passes and adjust `gravityRampRate` and `correctionStrength` first — those two have the biggest effect on time-to-fail.

---

## 7. Web POC — Simple UI Spec

- **Visual indicator:** a horizontal or vertical bar with a marker showing current `lean` position between the -1 and +1 fall boundaries (a simple divot/line at each extreme is enough — no need for character art or animation).
- **Direction cue:** the indicator itself communicates which way to correct (marker position relative to center) — no separate arrow/text needed, but a color shift (e.g., marker turns red as it nears the fall threshold) is a cheap, useful addition if easy to add.
- **Timer:** plain text, running seconds survived (`"12.4s"`).
- **Fall / end state:** simple text — `"You fell! Survived: 12.4s"` with a restart button.
- **Drunk toggle (for testing):** a simple checkbox or button to start a run as "drunk" vs. "sober," since there's no actual drunkenness system in this POC to feed it — this lets you test both starting curves without wiring up the full game's drunkenness stat.
- No art, no animation beyond the marker moving smoothly with `lean` each frame.

---

## 8. Engine-Agnostic Logic Design (for future Unreal port)

Same approach as Trade War:

- The `tick()` function in Section 3 should be a **pure function**: `(state, config, dt) → newState`, no DOM/rendering calls inside it. This is what makes it a near-direct port to Unreal's `Tick()` function later — the formula doesn't change, only the language it's written in.
- `BalanceGameState` and `BalanceConfig` are both plain, serializable data (numbers and booleans only) — no class instances or closures stored inside them.
- Input should be reduced to the single `inputDirection: -1 | 0 | 1` value **before** it reaches the logic layer — key-reading (`KeyDown`, `KeyUp` events in the web POC; `Enhanced Input` bindings in Unreal later) is rendering/platform-layer code and should never leak into `tick()`.
- Because this is single-player and has no cross-player interaction (unlike Trade War), there's no replication/authority concern to design around yet — if the real game later needs to show all players' bars simultaneously (for spectator tension, since "last one standing" implies watching others), that's a **read-only broadcast** of each player's `elapsedTime`/`isFallen` status to the room, not a shared-state or trust concern like Trade War's hidden hands.

---

## 9. Open Questions / Assumptions Made

1. **Damping value (1.5)** and **ramp rate (1.02)** are unverified starting guesses — flagged in Section 6, expect to retune after first playtest.
2. **Drunk toggle in the POC** is a manual testing convenience (Section 7) since there's no real drunkenness input source yet — confirm this is fine for POC purposes, or if you want it hooked to something else even at this stage.
3. **Multiplayer spectator view** (watching other players' bars in the real game) is mentioned in Section 8 as a future consideration but is **out of scope for this single-player POC** — confirming that's the intended scope before I assume it stays that way.