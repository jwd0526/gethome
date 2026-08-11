# Balance — Design Decisions

Companion to `minigame-balance.md` (the spec) and `README.md` (how to run and tune it).
This document records **what was decided, why, what was rejected, and what it costs**.

Cross-cutting engine material lives in [`../PORTING-TO-UNREAL.md`](../PORTING-TO-UNREAL.md);
this file covers only what is specific to Balance.

---

## 1. Shape of the solution

```
src/balance.js   physics + state. No DOM, no rAF, no key handling. Plain numbers.
src/ui.js        render loop, keyboard, tuning form, run log.
```

The contract, from Section 8 of the spec:

```js
tick(state, config, dt)          // -> newState   (pure)
reduceInput(leftHeld, rightHeld) // -> -1 | 0 | 1 (the platform boundary)
```

Balance is the reference implementation of the **continuous-simulation** family, as
Trade War is for turn-based games. The two share an outer philosophy — plain serializable
state, pure functions, config as data — and nothing internal.

---

## 2. Decisions

### D1 — `initialLeanMagnitude` exists because the spec's game cannot start

**Decision.** Every run begins at `lean = ±0.02` (random sign), exposed as a tunable.

**Why.** This is a genuine gap in the spec, not a preference. Section 3 defines

```
gravityForce = gravityCoefficient * lean
```

which is **exactly zero when `lean` is zero**. Section 2 describes `lean` as "0 = centered"
and gives no initial value. A run starting perfectly centred with zero velocity therefore
has no force acting on it, in either direction, forever. Not "hard to balance" — literally
motionless. There is no game.

The formula describes an inverted pendulum: centre is an *unstable equilibrium*, and
unstable equilibria still need a perturbation to leave. So each run gets an opening nudge,
and gravity's own positive feedback takes it from there.

**Rejected alternatives.**
- *Per-tick noise.* Would also work and would arguably feel more like a drunk wobble, but it
  changes the character of the physics — the spec's model is deterministic, and noise makes
  every run unreproducible and un-tunable. Rejected as a bigger change than the problem
  requires.
- *Initial velocity instead of initial lean.* Equivalent in effect, but harder to reason
  about and less visible in the HUD.

**Consequence.** A physics test (`a run starting exactly centred with no velocity never
moves`) pins the `lean = 0` behaviour deliberately, so the reason for this parameter stays
documented in the suite rather than only in prose. It is the first thing to check if
someone "cleans up" the initial lean during a port.

---

### D2 — Fixed timestep (1/120 s) with an accumulator

**Decision.** The UI accumulates real frame time and calls `tick` in fixed 1/120 s steps,
capping any single frame's catch-up at 0.25 s.

**Why.** The spec's `tick(state, config, dt)` invites feeding raw frame deltas straight in.
That makes semi-implicit Euler integration **frame-rate dependent**: the same player input
produces measurably different physics on a 60 Hz and a 144 Hz display. For a game whose
entire remaining work is tuning-by-feel, that is disqualifying — two playtesters on
different monitors would be tuning different games, and neither could compare results with
the other.

The exponential terms (`gravityRampRate ** dt`, and damping) are dt-correct; the integrator
is not. Fixing the step fixes the integrator.

**Consequences.**
- `advance(state, config, seconds)` exists so tests and any headless caller can move time
  forward in the same fixed steps the UI uses. A test asserts that advancing 3 s in one call
  and in three 1 s calls produce identical state.
- The 0.25 s cap prevents the spiral of death after a backgrounded tab: without it, a tab
  restored after a minute would try to simulate a minute of physics in one frame.
- This decision transfers directly and importantly to Unreal — see §5.

---

### D3 — `tick` returns a full state, not `{ finalScore }` on the falling tick

**Decision.** One return shape always. `isFallen` and `finalScore` are fields on the state.

**Why.** The spec's pseudocode returns a different shape on the falling tick. A function
with two return shapes forces every caller to type-check the result, and it breaks
serializability — the thing Section 8 explicitly asks for. Fields cost nothing.

**What was preserved exactly.** The spec's step *order*, including the subtle part: the fall
check runs **before** `elapsedTime` accumulates, so the tick on which you fall is not
credited to your score. A test asserts `finalScore` equals the previous tick's
`elapsedTime`.

That ordering detail also produced the only genuinely confusing test failure in the build:
a gravity-ramp assertion was off by exactly one tick of growth (`1.02^(1/120)` = 1.000165),
because gravity ramps at the *top* of a tick while `elapsedTime` is credited at the
*bottom* — so on the falling tick, gravity advances and time does not. The test was wrong;
the code matched the spec. The check now isolates the ramp on a run pinned at `lean = 0`,
which never falls.

---

### D4 — Ticking a fallen state is a no-op

**Decision.** `tick` returns its input unchanged when `state.isFallen`.

**Why.** The render loop, a paused tab, and a slow `endRun` can all deliver one more tick
after the fall. Making the terminal state absorbing means none of them can corrupt a
finished score. It also makes `advance` safe to call with any duration.

---

### D5 — Input is reduced to `-1 | 0 | 1` at the boundary, by a function that takes booleans

**Decision.** `reduceInput(leftHeld, rightHeld)` lives in the logic module but accepts
**booleans, never key events**. `ui.js` owns `keydown`/`keyup` and the held flags.

**Why.** Section 8 requires that key-reading never leak into `tick()`. Putting the reduction
in the logic layer makes the both-held-cancels rule testable without a browser; taking
booleans rather than events keeps it platform-free. The distinction matters: a function
named `reduceInput` that took a `KeyboardEvent` would have quietly welded the physics to the
web.

**Consequence.** `window.addEventListener('blur', ...)` clears both held flags. Without it,
alt-tabbing while holding a key leaves the input stuck down and the run dies to a phantom
hold — a bug the player would read as the physics cheating.

---

### D6 — Every parameter is editable at runtime, and results are logged with their settings

**Decision.** All seven config values get a slider *and* a mirrored number field, applied on
the next run. A run log records each result **alongside the parameters that produced it**.

**Why.** Section 6 is explicit that the feel "can only be tuned by actually playing it," and
that the suggested numbers are not derived. So the deliverable is not a tuned game — it is a
tuning instrument. The run log exists because a tuning session otherwise degenerates into
remembering which numbers produced which result.

**What was deliberately removed.** An earlier pass included a headless tuning harness that
drove `tick` with a modelled player (reaction latency, lead compensation) and swept
`gravityRampRate` to hit the 30–45 s target. It was deleted at the user's direction. The
reason it was a poor fit is worth recording: a simulated controller measures *its own*
control law, not human feel, and it converges on numbers that are precisely right for a
player who does not exist. Presets now span the range as **starting points to play**, not as
recommendations.

**Presets.** `spec` (1.02) · `gentle` (1.06) · `moderate` (1.12) · `steep` (1.22) ·
`brutal` (1.35). Spread across the ramp rate, not derived.

---

### D7 — Config is separate from state

**Decision.** `BalanceConfig` (tunables) and `BalanceGameState` (per-run) are separate plain
objects; `tick` takes both.

**Why.** The spec already models them separately, and it pays off twice: config becomes a
Data Asset in Unreal that designers edit without touching code (§5), and state stays small
enough to replicate or serialize per run.

---

## 3. Properties the tests protect

| Property | Why it matters |
|---|---|
| `tick` never mutates its input | The whole pure-function claim; the port depends on it |
| State survives JSON round-trip and resumes identically | Section 8's serializability requirement |
| Identical inputs produce identical output | Tuning results are only comparable if runs are reproducible |
| `lean = 0` with no velocity never moves | Documents *why* `initialLeanMagnitude` exists |
| Gravity follows `start × rate^t`, drunk/sober ratio constant | Section 5 — harder start, not steeper curve |
| Overcorrection is emergent, not special-cased | Section 3's explicit design note |
| Falling tick is not credited to the score | Subtle spec ordering, easy to lose in a port |
| Advancing in different-size chunks gives identical results | Frame-rate independence (D2) |

Two test failures during the build were **wrong assertions, not bugs**, and both were the
same mistake: measuring `|lean|` and treating a *successful* correction that carried the
marker through centre as a failure. Holding left from `+0.021` reached `−0.228` — the input
worked perfectly. Both checks now assert direction of travel. This is worth knowing because
anyone writing new tests against this physics will make the same mistake: **absolute lean is
not a measure of control**.

---

## 4. Reuse — what generalizes to other games

Balance is the skeleton for any **continuous-input survival or skill** minigame — the
category the spec itself flags as "Template Exception," and which the earlier "Stacked
Stool" discussion belongs to.

The reusable skeleton:

```
createConfig(overrides)         tunables as data, defaults in one place
createState(opts)               per-run state, seeded/injectable
tick(state, config, dt)         pure, fixed-step, terminal state absorbing
reduceInput(...)                platform input -> a small value type
advance(state, config, seconds) fixed-step driver for tests and headless use
dangerLevel / leanFraction      pure derived readouts for rendering
```

**Directly reusable as-is:**
- The **fixed-step accumulator loop** in `ui.js` — every realtime minigame needs it, and
  getting it wrong is invisible until two people compare tuning notes.
- The **config/state split** and the runtime tuning form, which is genuinely game-agnostic:
  it is generated from a `PARAMS` table of `{ key, label, min, max, step, note }`.
- The **run log** keyed by parameters.
- The **terminal-state-is-absorbing** discipline.
- `reduceInput`'s shape: platform input collapses to a value type *before* the sim sees it.

**Swap per game:** the state fields, the force model inside `tick`, the terminal predicate,
and the score.

**Good fits:** any single-axis "hold to counteract" game (tug of war, holding a note,
carrying a tray), timing-under-pressure games, and anything with a difficulty ramp against a
survival clock. A two-axis version is the same code with vectors.

**Bad fit:** anything turn-based or hidden-information — that is
[`../minigame-tradewar/DESIGN.md`](../minigame-tradewar/DESIGN.md).

**The strongest cross-game reuse here is the difficulty ramp itself**:
`coefficient *= rate^dt`, with a per-player starting offset that scales the whole curve
without changing its shape. That is a clean, reusable model for "gets harder over time, and
some players start harder" and it applies well beyond balance games.

---

## 5. Unreal port — Balance specifics

General mechanics are in [`../PORTING-TO-UNREAL.md`](../PORTING-TO-UNREAL.md).

### Types

```cpp
USTRUCT(BlueprintType)
struct FBalanceState
{
    GENERATED_BODY()
    UPROPERTY(BlueprintReadOnly) float Lean = 0.f;
    UPROPERTY(BlueprintReadOnly) float LeanVelocity = 0.f;
    UPROPERTY(BlueprintReadOnly) float GravityCoefficient = 1.05f;
    UPROPERTY(BlueprintReadOnly) float ElapsedTime = 0.f;
    UPROPERTY(BlueprintReadOnly) int32 InputDirection = 0;
    UPROPERTY(BlueprintReadOnly) bool  bFallen = false;
    UPROPERTY(BlueprintReadOnly) bool  bDrunk = false;
};
```

### Config becomes a Data Asset — this is the big win

The tuning form has a direct, better analogue in-editor:

```cpp
UCLASS(BlueprintType)
class UBalanceConfig : public UDataAsset
{
    GENERATED_BODY()
public:
    UPROPERTY(EditAnywhere, Category="Balance", meta=(ClampMin="0.1")) float FallThreshold = 1.f;
    UPROPERTY(EditAnywhere, Category="Balance") float CorrectionStrength = 2.5f;
    UPROPERTY(EditAnywhere, Category="Balance") float Damping = 1.5f;
    UPROPERTY(EditAnywhere, Category="Balance") float BaseGravityStart = 1.05f;
    UPROPERTY(EditAnywhere, Category="Balance") float DrunkGravityStart = 1.07f;
    UPROPERTY(EditAnywhere, Category="Balance", meta=(ClampMin="1.0")) float GravityRampRate = 1.02f;
    UPROPERTY(EditAnywhere, Category="Balance") float InitialLeanMagnitude = 0.02f;
};
```

Designers then tune in the editor with no code change and no rebuild — the same workflow the
HTML form provides, with better tooling. Ship several assets (`DA_Balance_Gentle`,
`DA_Balance_Brutal`) as the preset equivalent.

### Tick — do **not** pass `DeltaTime` straight to the step function

```cpp
void ABalanceActor::Tick(float DeltaTime)
{
    Super::Tick(DeltaTime);
    Accumulator += FMath::Min(DeltaTime, MaxFrameSeconds); // 0.25f
    while (Accumulator >= FixedStep && !State.bFallen)     // 1.f/120.f
    {
        FBalanceRules::Step(State, *Config, FixedStep);
        Accumulator -= FixedStep;
    }
}
```

UE4's physics substepping (Project Settings → Physics) applies to PhysX simulation, **not**
to gameplay `Tick`. There is no built-in fixed gameplay tick; you implement the accumulator
yourself. Remember `PrimaryActorTick.bCanEverTick = true;`.

### Input maps to an axis, and the both-held rule comes free

Add an axis mapping `Lean` with `A = -1.0`, `Left = -1.0`, `D = +1.0`, `Right = +1.0`.
UE4 **sums** the scales of all bound keys, so holding A and D together yields exactly `0` —
Section 4's cancellation rule with no code.

```cpp
PlayerInputComponent->BindAxis("Lean", this, &ABalancePawn::OnLean);

void ABalancePawn::OnLean(float Value)
{
    State.InputDirection = FMath::Clamp(FMath::RoundToInt(Value), -1, 1);
}
```

Caveat: a gamepad stick delivers fractional values, so rounding turns a light nudge into a
full-strength correction. Either keep the digital `-1|0|1` contract and add a deadzone, or
extend the model to accept analog input — the latter changes the game and should be a
deliberate design call, not a side effect of the port.

---

## 6. Caveats

**C1 — Floating-point results are not bitwise identical across platforms.** The JS build is
deterministic *on one machine*; `float` maths in C++ across compilers, architectures and
optimisation levels is not. Do not build anything that assumes two machines simulating the
same inputs reach the same state (lockstep, replay-by-input, client-side prediction with
server confirmation by comparison). For the real game's "everyone runs an independent
instance, highest time wins," this is fine — see C2.

**C2 — Scores must be server-authoritative even though the game is single-player.** Section
7 of the spec makes each player's run independent, with results compared across the room.
That means the *client* runs the sim and the *server* believes the result — which is a
cheating surface, not a physics problem. Options, in increasing order of cost: accept it for
a party game among friends; have the server run the same sim from replicated inputs and
sanity-check the reported time; or run the sim server-side entirely and replicate `Lean` for
rendering. Pick deliberately; the POC makes no choice because it has no network.

**C3 — Tuning numbers do not survive a change to the timestep or the integrator.** All feel
tuning is relative to semi-implicit Euler at 1/120 s. If the port switches to a different
step size or integration scheme, every tuned value is invalidated and the game must be
re-tuned from scratch. If you change one, change it *before* tuning, not after.

**C4 — `initialLeanMagnitude` is load-bearing and looks like debug scaffolding.** It will
read as a stray constant to anyone porting from the spec alone, since it appears nowhere in
`minigame-balance.md`. Setting it to zero produces a game that silently never starts, with
no error and a frozen marker. See D1; keep the test that pins it.

**C5 — The 30–45 s target is unverified.** Section 6's target has not been validated against
a real player, and the auto-tuning that would have estimated it was removed by design. The
presets are unvalidated starting points. `gravityRampRate` compounds per second and is by
far the dominant lever — at 1.02 the pull takes roughly 35 s merely to double; at 1.35, about
2.3 s. Tune that first.

**C6 — Drunk vs sober is a 1.9 % difference.** `1.07` vs `1.05`, ramping at the same rate, so
the two curves stay a constant multiple apart for the entire run. Whether that is
perceptible at all is an open playtest question; if it needs to *feel* different, the lever
is a bigger gap in the starting values, not a different ramp (Section 5 forbids a different
curve shape).

**C7 — The marker's on-screen position is not the same thing as `lean`.** Rendering insets
the marker by its own width so it stays fully inside the bar at `±1`. Any port that maps
lean to a screen or bone position needs the same treatment, and any test that checks
rendering must compare against the inset mapping, not against raw lean — a real bug caught
during the build, where the marker was clipped at the extremes.

**C8 — Nothing here is multiplayer yet.** Section 8 notes a spectator view would be a
read-only broadcast of `ElapsedTime`/`bFallen` per player, not shared state. That remains
out of scope and unimplemented; it is genuinely easy *because* no player affects another,
and that property should be protected — the moment one player's run can influence another's,
the trust model becomes Trade War's.
