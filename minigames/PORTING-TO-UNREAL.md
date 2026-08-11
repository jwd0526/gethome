# Minigame Kernel — Reuse & Unreal Engine 4 Porting Guide

Shared reference for both POCs in this repo. Per-game decisions live in
[`minigame-tradewar/DESIGN.md`](minigame-tradewar/DESIGN.md) and
[`minigame-balance/DESIGN.md`](minigame-balance/DESIGN.md); this document covers the pattern
they have in common, how to reuse it for a third game, and what it actually takes to move
this code into a real UE4 project.

Written against **UE4** (4.26+). Version-sensitive items are flagged; where UE5 differs it
is called out.

---

## 1. The pattern both games follow

Each minigame is two layers with a hard wall between them:

| Layer | Trade War | Balance | Survives the port? |
|---|---|---|---|
| Rules / simulation | `src/game.js` | `src/balance.js` | **Yes** — this is the asset |
| Presentation | `src/ui.js` | `src/ui.js` | No — replaced by UMG/Blueprint |

Four properties define the wall. They are worth stating as rules, because each one is what
makes some later thing possible:

1. **State is plain, serializable data.** Numbers, booleans, strings, arrays, plain objects.
   No classes, closures, or handles. *Enables:* a near-1:1 `USTRUCT` translation, save/load,
   replication, and network transport.
2. **Rules functions are pure.** State in, new state out; no I/O, no clock reads, no
   randomness that isn't seeded. *Enables:* headless unit tests, deterministic replay, and
   running the same code on server and client.
3. **All validation lives in the rules layer.** The UI attempts an action and is told
   yes or no. It never independently decides what is legal. *Enables:* a server that can
   trust its own referee and distrust every client.
4. **Time and input are values, not ambient state.** `dt` and `now` are parameters;
   key events are reduced to a value type at the boundary. *Enables:* fixed timesteps,
   fast-forwarding, and server-authoritative timers.

If a change to the rules layer would break any of these four, it is a change to the
architecture, not a change to the game.

### The shared contract

The two games look different but expose the same outer shape. This is the interface a third
minigame should implement:

```
create(config, seed)          -> state          deterministic setup
advance(state, input, dt)     -> state          the only way state changes
isOver(state)                 -> bool           terminal predicate
scores(state)                 -> per-player     result extraction
viewFor(state, viewerId)      -> redacted state what one participant may see
```

The family split is *only* in what `advance` means:

- **Turn-based / discrete** (Trade War): `advance` is `applyAction(state, action)`. `dt` is
  irrelevant; the driver is a submission queue. Hidden information is the hard problem.
- **Realtime / continuous** (Balance): `advance` is `tick(state, config, dt)`. Input is
  ambient and sampled; there is no queue. The timestep is the hard problem.

A third game picks a family and reuses that family's skeleton. See each game's DESIGN.md
§4 for the specific list of directly-reusable pieces.

### What is reusable across *both* families

- **Config as data, separate from state.** Becomes a `UDataAsset` in UE4 and hands tuning to
  designers with no rebuild. This is the single highest-value habit in the repo.
- **Seeded, injectable randomness.** Reproducible sessions; tests that pin scenarios instead
  of retrying until lucky.
- **The redaction projection** (`viewFor`). Even a single-player game benefits: it documents
  precisely what a client is entitled to know, which is exactly the spec a replication
  condition needs.
- **Terminal state is absorbing.** Advancing a finished game returns it unchanged, so a
  stray tick or a late RPC cannot corrupt a final score.
- **Rejected input changes nothing.** No partial mutation, ever.
- **The test suites themselves.** The invariant tables in each DESIGN.md are the port's
  acceptance criteria — re-implement those checks in C++ and you have a real conformance
  suite rather than a hope.

---

## 2. Project layout in UE4

Put the rules layer in **its own module that does not depend on `Engine`**:

```
Source/
  MinigameRules/                 <- Core + CoreUObject only
    Public/
      TradeWarTypes.h            USTRUCTs
      TradeWarRules.h            static validate/resolve/score
      BalanceTypes.h
      BalanceRules.h
    MinigameRules.Build.cs
  MinigameGameplay/              <- Engine, actors, replication, UMG
    TradeWarGameMode.h/.cpp
    TradeWarPlayerState.h/.cpp
    BalancePawn.h/.cpp
```

```csharp
// MinigameRules.Build.cs
PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject" });
// deliberately NOT "Engine"
```

Why this matters more than it looks: a module that cannot see `Engine` **cannot** call
`GetWorld()`, spawn actors, read `GetTimeSeconds()`, or touch a `UWorld`. The compiler
enforces the wall that discipline currently maintains in JS. It also means the rules
compile into a dedicated server or a commandlet with no rendering, and unit tests run in
milliseconds without booting a map.

`USTRUCT`/`UPROPERTY` need `CoreUObject`; that is the only reflection dependency required.

---

## 3. Translating the types

**Plain data → `USTRUCT`.** Direct, mechanical:

```cpp
USTRUCT(BlueprintType)
struct FBalanceState
{
    GENERATED_BODY()
    UPROPERTY(BlueprintReadOnly) float Lean = 0.f;
    UPROPERTY(BlueprintReadOnly) bool  bFallen = false;
    // ...
};
```

Always give members in-class initialisers. A `USTRUCT` is zero-initialised in some paths and
not others; defaults in the JS `createState` must be restated here or you will get a state
that starts at `Lean = 0` and never moves (see Balance D1 — the failure is silent).

**Rules functions → statics on a struct or namespace.** They are pure; they do not need a
`UObject`:

```cpp
struct MINIGAMERULES_API FBalanceRules
{
    static void Step(FBalanceState& State, const FBalanceConfig& Config, float Dt);
};
```

Note the signature change: `FBalanceState&` in-place, not `state -> newState`. See §6/C1.

**Things that do not translate:**

| JS | UE4 | Do this instead |
|---|---|---|
| `Map<playerId, Record>` | `TMap` is **not replicated** in UE4 | `TArray<FRecord>`, look up by id; `FFastArraySerializer` if it must scale |
| Discriminated-union payload | No native equivalent that replicates | Flatten all fields into one struct; validation rejects fields not belonging to the chosen action type |
| `JSON.parse(JSON.stringify(x))` deep clone | Legal but wasteful | Copy the struct only when you need a rollback point |
| String card ids with suit glyphs (`"7♣"`) | Poor `FName`/wire choice | Numeric rank + suit; glyphs are a render concern |
| `Date.now()` | Wall clock, not net-aware | `AGameStateBase::GetServerWorldTimeSeconds()` |
| `Math.random()` | Non-deterministic, unseedable | `FRandomStream` (a `USTRUCT`, seedable and replicable) |

---

## 4. Wiring it into the engine

### Ticking a realtime game

```cpp
// Constructor
PrimaryActorTick.bCanEverTick = true;

void ABalanceActor::Tick(float DeltaTime)
{
    Super::Tick(DeltaTime);
    Accumulator += FMath::Min(DeltaTime, MaxFrameSeconds); // 0.25f guard
    while (Accumulator >= FixedStep && !State.bFallen)     // 1.f / 120.f
    {
        FBalanceRules::Step(State, *Config, FixedStep);
        Accumulator -= FixedStep;
    }
}
```

**UE4 has no built-in fixed gameplay tick.** The substepping option in Project Settings →
Physics governs PhysX simulation, not `AActor::Tick`. If you want frame-rate independent
gameplay you write the accumulator yourself. (`FApp::SetFixedDeltaTime` / `-UseFixedTimeStep`
exist but are for deterministic offline rendering and capture, not for shipping gameplay.)

### Submitting an action in a turn-based game

```cpp
UFUNCTION(Server, Reliable, WithValidation)
void ServerSubmitAction(const FTradeWarAction& Action);
```

`WithValidation` is **required** on Server RPCs in UE4 (it became optional in UE5). Split
the work honestly:

- `ServerSubmitAction_Validate` — cheap structural sanity (indices in range, ids non-empty).
  Returning `false` **disconnects the client**, so use it only for things a legitimate
  client can never send.
- `ServerSubmitAction_Implementation` — calls the rules layer, which does the real
  game-legality validation and returns an error the client can be told about politely.

That mapping is exactly the JS split between "malformed" and `{ success: false, error }`.

### Where state lives

| Data | UE4 home |
|---|---|
| Whole-match authoritative state | `AGameMode` (server-only, never replicated) |
| Public match info all clients need | `AGameState` |
| Per-player public info | `APlayerState` |
| Per-player **secret** info | `APlayerState` with `COND_OwnerOnly` |

```cpp
void ATradeWarPlayerState::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& Out) const
{
    Super::GetLifetimeReplicatedProps(Out);
    DOREPLIFETIME_CONDITION(ATradeWarPlayerState, Hand, COND_OwnerOnly);  // faces
    DOREPLIFETIME(ATradeWarPlayerState, PublicSlots);                     // {position, locked}
}
```

`PublicSlots` is literally what `viewFor` returns for a non-viewer. The JS projection is the
replication spec — implement it once, in one place.

### Timers

Replicate the deadline, not the countdown:

```cpp
// Server sets:
State.TimerEndsAt = GetWorld()->GetGameState()->GetServerWorldTimeSeconds() + 15.f;

// Client renders:
const float Remaining = FMath::Max(0.f,
    State.TimerEndsAt - GetWorld()->GetGameState()->GetServerWorldTimeSeconds());
```

The **server** enforces expiry via its own `FTimerHandle` or a tick check. A client widget
that never fires must not be able to stall the round. This is why the JS design put
`timerEndsAt` in state rather than in a `setInterval` closure.

### Exposing to Blueprint

`USTRUCT(BlueprintType)` + `UFUNCTION(BlueprintPure)` accessors let designers build the HUD
without C++. Keep mutation out of Blueprint entirely — expose reads and the single
"submit action" entry point, nothing else, or rule 3 of the wall erodes one convenience node
at a time.

---

## 5. Testing the ported logic

The rules module's `Engine`-free design pays off here. UE4's automation framework runs these
headlessly:

```cpp
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FBalanceCentredRunNeverMoves,
    "Minigames.Balance.CentredRunNeverMoves",
    EAutomationTestFlags::ApplicationContextMask | EAutomationTestFlags::EngineFilter)

bool FBalanceCentredRunNeverMoves::RunTest(const FString&)
{
    FBalanceConfig Config;                       // defaults
    FBalanceState  State;
    State.Lean = 0.f;                            // deliberately dead centre
    for (int32 i = 0; i < 7200; ++i) FBalanceRules::Step(State, Config, 1.f/120.f);
    TestEqual(TEXT("stays at zero"), State.Lean, 0.f);
    TestFalse(TEXT("never falls"), State.bFallen);
    return true;
}
```

Run from the editor's Session Frontend, or headless in CI:

```
UE4Editor-Cmd.exe <Project>.uproject -ExecCmds="Automation RunTests Minigames" -unattended -nopause -testexit="Automation Test Queue Empty"
```

**Port the invariant tables, not just the code.** Each DESIGN.md lists the invariants with
the check that guards them; those tables are the acceptance criteria for the port. A port
that compiles and plays but drops "the active player is always the round's first submitter"
has silently changed the game's rules.

---

## 6. Caveats

**C1 — The pure-functional style is a contract, not a copying strategy.** Both JS modules
return new state and deep-clone to do it. In C++, transliterating that literally copies a
struct per action or per tick. Port as **mutate in place, validate fully before mutating
anything**, taking a copy only where you genuinely need a rollback point. What must survive
is the guarantee (a rejected action changes nothing), not the mechanism.

**C2 — Float determinism does not survive crossing machines.** Neither POC needs lockstep,
and neither should be given it. Do not build replay-by-input, client prediction validated by
state comparison, or any cross-machine "simulate the same thing and compare" scheme. Use
server-authoritative state and replicate results. This bites Balance hardest (see its C1/C2).

**C3 — Hidden information must be enforced by replication, never by rendering.** The
`viewFor` projection is currently upheld by the UI rendering from it. Over a network, the
only thing that hides a card is *not sending it*. Any spectator view, replay system, or
debug overlay that ships full state to clients destroys Trade War's central mechanic while
every existing test still passes. Treat `viewFor` as a security boundary.

**C4 — Client-authoritative results are a trust decision, not an oversight.** Balance is
single-player per instance, so the natural port has clients reporting their own survival
times. For a party game among friends that may be fine — but it should be an explicit,
recorded choice, not something discovered later.

**C5 — Version sensitivity.** Written for UE4 4.26+. Known differences to watch:
`WithValidation` is required on Server RPCs in UE4 and optional in UE5; Enhanced Input is an
experimental plugin in 4.26+ and the default in UE5, whereas classic Axis/Action mappings
(which give the both-keys-cancel behaviour for free — see Balance §5) are standard in UE4;
`TMap` replication is unsupported in both.

**C6 — The engine-agnostic claim covers the rules, not the game.** Roughly the rules layer
ports; the UI does not, and neither does anything that made these POCs *playable* —
pass-and-play handoffs, the tuning form, the run log, screen routing. Budget the port as
"re-type the rules, rebuild the presentation," and do not let the small size of the rules
files set the expectation for the whole job.

**C7 — Specs have gaps that only implementation finds.** Both builds turned up something the
spec could not have told you: Trade War's batched resolution made the game unreadable to its
own players, and Balance's physics cannot start from its own stated initial condition.
Expect the same during the port, and expect the gaps to be found by playing, not by reading.
