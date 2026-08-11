# Trade War — Design Decisions

Companion to `minigame-tradewar.md` (the spec) and `README.md` (how to run it). This
document records **what was decided, why, what was rejected, and what it costs** — the
things that are invisible in the code and expensive to re-derive during the Unreal port.

Cross-cutting engine material lives in [`../PORTING-TO-UNREAL.md`](../PORTING-TO-UNREAL.md);
this file covers only what is specific to Trade War.

---

## 1. Shape of the solution

Two layers with a hard wall between them:

```
src/game.js   rules + state. No DOM. Plain JSON data. Deterministic given a seed.
src/ui.js     rendering, input, screen routing. Owns nothing authoritative.
```

The wall is the point. `game.js` is what survives the port to C++; `ui.js` is disposable
and will be replaced by UMG/Blueprint. Every decision below either defends that wall or
records a rule the spec left open.

The contract, unchanged from Section 9 of the spec:

```js
applyAction(state, { playerId, actionType, payload }, now) // -> { success, newState, error? }
checkGameOver(state)                                        // -> bool
computeScores(state)                                        // -> { [playerId]: number }
```

---

## 2. Decisions

### D1 — Actions resolve on submission, not in an end-of-round batch

**Decision.** `applyAction` validates *and resolves* the action immediately, then advances
the submission queue. The round "resolves" only in the bookkeeping sense: when the last
player has submitted, `finishRound` seals the summary.

**Why.** The first implementation batched: every player submitted against a frozen
round-start state, and the whole round resolved at once in the spec's Section 4.3 order
(`FORCE_TRADE` → `REPLACE` → `LOCK`). That is a faithful reading, and it is a bad game.
You clicked Lock and the card did not lock. You clicked Replace and never saw the card you
drew. You made a blind Force Trade and never learned what you won — all of it arrived a
screen later, attributed to nobody. In a pass-and-play game the device leaves your hands
between the action and its consequence, so the feedback lands in front of the *wrong
person*.

**What preserves the spec's ordering.** Section 4.3 exists to disambiguate a Force Trade
touching another player's hand mid-round. That guarantee now comes from **turn order**
instead of batching: `beginRound` builds `submissionOrder` as *active player first, then
seating order*, so the round's one possible Force Trade always resolves before any other
player acts. The ordering requirement is met by construction rather than by sorting.

**Rejected alternative.** Keep batching and show a "pending" badge on the chosen card.
Rejected because pending states can *lie* — under batching, a card you marked for Lock
could be traded away before your Lock resolved, so the badge would have promised something
the engine then refused. The honest version of that UI is exactly the one that removes the
need for it.

**Consequences.**
- The "chosen card was traded away" edge case is now unreachable: validation and resolution
  are the same instant. `fallbackLock` survives as a defensive guard, documented as such.
- The trade *target* sees their hand already changed when their turn arrives, so
  `renderTurn` shows a banner naming the slot taken and the card left behind. Without it,
  the hand in front of them silently differs from the one they last saw.
- The invariant is load-bearing and therefore tested directly, not assumed —
  `CHECK 3b` asserts the active player is `submissionOrder[0]` in every round of both
  formats, and that the trade is the first resolved event of its round.

**Code.** `commitSubmission`, `resolveRecord`, `finishRound`, `beginRound` in `src/game.js`.

---

### D2 — Replacements and trades swap **in place**

**Decision.** A replaced or traded card takes the exact hand index of the card it displaces.
Hand length is always N.

**Why.** Spec Section 5 says "remove … add", which permits positions to shuffle. But
Section 7 makes blind-by-position the *entire psychological mechanic*: "returning players
can track/bluff based on position over multiple rounds." If a Replace reorders a hand, the
position everyone has been tracking silently points somewhere else, and the mechanic
quietly stops working — with no error and no visible symptom.

**Consequences.** Position is stable and meaningful across rounds. `CHECK 3` asserts the
receiver's slot 3 holds the given card after the swap, and that a later blind read of
position 3 sees the new physical occupant. This is the single most important invariant in
the game and the easiest to break during a port.

---

### D3 — The blind pick travels as a **position**, resolved to a card id at the boundary

**Decision.** The UI sends `takeIndex` (0-based slot). `validateForceTrade` resolves it
against the target's hand *at validation time* and stores both `takeCardId` and `takeIndex`
in the action record.

**Why.** "Position 3" must mean "whatever physically occupies slot 3 right now." Resolving
in the rules layer makes that a single, testable line rather than an assumption spread
across UI code. Storing both means the event log can say "took their position 3" (safe to
show everyone) while the engine acts on an unambiguous card identity.

**Port note.** This is also the security-correct shape: a client that could name a *card id*
to take would be naming a card it should not be able to see. See caveat C3 below.

---

### D4 — Hidden information is redacted at the **data** layer, not with CSS

**Decision.** `viewFor(state, viewerId)` returns a per-viewer projection in which opponents'
cards carry only `{ position, locked }` — no id, no rank, no value. The UI can only render
what it is given.

**Why.** A first pass hid opponents' cards by rendering them as face-down slots, which was
correct, but the *outgoing* player's hand stayed in the DOM behind `display: none` during
the pass-the-device interstitial. That is not privacy; it is a view-source away from being
the whole game. Found by `CHECK 10`, which asserts no card id of any player appears
anywhere in `document.documentElement.innerHTML` at any handoff.

**Consequences.**
- `show()` tears down the turn screen markup whenever it is not the active screen.
- The between-round summary uses `redactEvent` (positions only, never faces); the
  full-detail `describeEvent` text goes to `state.log`, shown only on the end screen.
- Two functions for the same events looks redundant until you remember the summary is on a
  shared screen and the log is not.

**This is the decision that ports worst.** In a networked build, redaction *must* move to
the replication boundary — see C3.

---

### D5 — Timer state lives in `GameState`, not in a UI component

**Decision.** `state.timerEndsAt` is a timestamp; `resolveTimeout(state, now)` is a pure
function that applies the expiry rule. The UI's `setInterval` only *observes*.

**Why.** Spec Section 9 asks for exactly this, and it is what makes the 15s rule testable
without a browser (`CHECK 5`, logic) and enforceable by a server later. A timer implemented
as UI state is a timer the server cannot enforce.

**Expiry rule.** Auto-`LOCK` the lowest-value unlocked card, ties broken by lowest hand
position so it is deterministic. This is the spec's own assumption (Section 8, Q1) and
**remains the one open question worth confirming** — the alternatives (auto-`REPLACE`, or
forfeit with no action) are a one-line change in `resolveTimeout`.

**Consequence.** The timer restarts at each decision point including each Force Trade step,
per Section 7, via `startTurnTimer` called from the UI on reveal and on each trade step.

---

### D6 — Rejected actions return the **same state object**

**Decision.** `reject()` returns `{ success: false, newState: state }` — the identical
reference, never a copy, never a partial mutation.

**Why.** It makes "a failed action changed nothing" checkable by identity rather than by
deep comparison, and it removes a whole class of half-applied-mutation bugs. `CHECK 6`
asserts reference equality after four different illegal actions.

**Port note.** This idiom does not survive contact with C++ — see C4.

---

### D7 — Seeded, injectable randomness

**Decision.** `createGame` takes `seed`, and optionally `names`, `drunkenness` and
`roundOrder`. A mulberry32 stream drives the shuffle.

**Why.** Reproducible games make bugs reproducible and let tests pin scenarios instead of
retrying until they get lucky. It is also how `CHECK 9` produces a *genuine* tied game
(seed 1 deals two hands totalling 25 each) rather than hand-constructing a fake end state.

---

### D8 — The end-of-game force-lock sweep is a safety net that never fires

**Finding, not a decision.** Section 6.1 says to force-lock stragglers after round N. In
legal play there are never any: every action retires exactly one unlocked card per player
per round — a Force Trade target loses the taken card but receives an unlocked one and then
still takes their own action — so unlocked count is always `N − roundsCompleted`, hitting
zero exactly at the end of round N.

**Why it is documented rather than deleted.** It is cheap insurance against a future rule
that breaks the invariant. `CHECK 7` asserts natural play leaves nothing for the sweep;
`CHECK 7b` plants a straggler so the sweep is exercised for real. Both matter: the first
documents the invariant, the second proves the fallback works if the invariant ever dies.

---

### D9 — The table is a layout, not a second source of truth

**Decision.** The turn screen is a felt with seats around it, piles in the middle, and the
viewer at the bottom. Three things it deliberately does *not* do:

- **Opponent slots stay in position order, even once some are locked.** Locked slots are
  greyed and dropped a few pixels in place rather than grouped into a separate bank. Force
  Trade is a blind pick *by position*; reordering an opponent's cards would scramble the
  only handle the trader has on them.
- **Your own locked cards stay inside `#own-hand`, in a second zone.** A locked card is
  still yours, still on the table and still scored — only its reach has changed, which is
  what the split says. Hiding it would be lying about the game state.
- **The discard is a count, not a list.** Faces are never public (D4), so the pile is drawn
  face-down like every other card nobody owns. `viewFor` exposes `discardCount` and
  `deckCount`; it does not expose what is in either.

**Flight animations are decorative and non-blocking.** The action resolves first and the
real cards are in their final places before anything moves; a ghost card is then tweened
over the table from the pre-action geometry to the post-action geometry. Nothing waits on
it, clicking straight through is always safe, and `prefers-reduced-motion` skips it
entirely. The ghosts live in `#fly-layer`, which `show()` tears down with the rest of the
turn screen — a card in flight must not survive into the handoff (D4).

**Port note.** The seat ring, the zone split and the tweens are all view concerns computed
from `viewFor`. None of them needs state the rules layer does not already publish.

---

## 3. Invariants the tests exist to protect

These are the things a port must not break. Each maps to a check that fails loudly.

| Invariant | Check |
|---|---|
| Active player is always the round's first submitter | `CHECK 3b` |
| A Force Trade is the first resolved event of its round | `CHECK 3b` |
| Blind position resolves to the physical occupant of that slot | `CHECK 3` |
| Swaps are in place; hand length and positions stay stable | `CHECK 3` |
| Given card unlocks for receiver; taken card locks for trader | `CHECK 3`, UI `CHECK 3` |
| Locked cards cannot be locked, replaced, given or taken | `CHECK 6` |
| Rejected actions mutate nothing | `CHECK 6` |
| Every player is active exactly once across N rounds | `CHECK 1a/1b` |
| Non-active players cannot Force Trade | `CHECK 1a/1b` + UI |
| Unlocked count is always `N − roundsCompleted` | `CHECK 7` |
| No opponent card data reaches the DOM | UI `CHECK 10` |
| State survives a JSON round-trip and keeps playing | `EXTRA` |

---

## 4. Reuse — what generalizes to other games

Trade War is the reference implementation of the **turn-based, discrete-action** family.
Everything in `game.js` except the specific action verbs is reusable for any minigame where
players submit choices in turn and a referee validates them.

The reusable skeleton:

```
createGame(opts)              seed + config in, initial state out
applyAction(state, action)    validate -> resolve -> advance queue -> maybe end round
checkGameOver(state)          terminal predicate
computeScores(state)          state -> per-player number
viewFor(state, viewerId)      per-viewer redaction
```

**Directly reusable as-is:**
- The **submission queue** (`submissionOrder` / `submissionIndex` / `awaitingPlayerId`) —
  any pass-and-play or turn-based game needs exactly this, and it is where the ordering
  guarantees live.
- The **action envelope** `{ playerId, actionType, payload }` → `{ success, newState, error }`.
  Designed to cross a network boundary; see `../PORTING-TO-UNREAL.md`.
- The **timer** (`timerEndsAt` + `resolveTimeout` + a per-game expiry rule).
- The **redaction projection** (`viewFor`) — any hidden-information game needs one.
- **Seeded setup** and the reject-returns-same-state discipline.

**Swap per game:** the action verbs, their validators, their resolvers, the scoring
function, and the tiebreak.

**Good fits for this skeleton:** liar's dice, blackjack-style push-your-luck, voting or
accusation games, drafting, any "everyone picks simultaneously then reveal" round structure.

**Bad fit:** anything with a continuous per-frame simulation. That is the other family — see
[`../minigame-balance/DESIGN.md`](../minigame-balance/DESIGN.md), which is the reference
implementation for it. The two share the outer contract but nothing internal.

---

## 5. Unreal port — Trade War specifics

General mechanics (module layout, RPCs, testing, tick) are in
[`../PORTING-TO-UNREAL.md`](../PORTING-TO-UNREAL.md). What follows is game-specific.

### Types

```cpp
UENUM(BlueprintType)
enum class ETradeWarActionType : uint8 { Lock, Replace, ForceTrade };

USTRUCT(BlueprintType)
struct FTradeWarCard
{
    GENERATED_BODY()
    UPROPERTY(BlueprintReadOnly) FName    Id;       // "7C" — never the display glyph
    UPROPERTY(BlueprintReadOnly) uint8    Rank = 0;
    UPROPERTY(BlueprintReadOnly) uint8    Suit = 0;
    UPROPERTY(BlueprintReadOnly) int32    Value = 0;
    UPROPERTY(BlueprintReadOnly) bool     bLocked = false;
    UPROPERTY(BlueprintReadOnly) FName    OwnerId;
};

// The JS payload is a discriminated union. C++ replication has no such thing, so flatten
// it and let validation reject fields that do not belong to the chosen ActionType.
USTRUCT()
struct FTradeWarAction
{
    GENERATED_BODY()
    UPROPERTY() FName                 PlayerId;
    UPROPERTY() ETradeWarActionType   ActionType = ETradeWarActionType::Lock;
    UPROPERTY() FName                 CardId;          // Lock / Replace
    UPROPERTY() FName                 GiveCardId;      // ForceTrade
    UPROPERTY() FName                 TargetPlayerId;  // ForceTrade
    UPROPERTY() int32                 TakeIndex = INDEX_NONE; // ForceTrade, blind slot
};
```

### `actionsThisRound` cannot be a `TMap`

UE4 does not replicate `TMap` or `TSet`. Store it as `TArray<FTradeWarAction>` and look up
by `PlayerId`; at 4–6 entries a linear scan is free. If it ever needs to be efficient or
delta-replicated, use `FFastArraySerializer`.

### Hand replication is the whole security model

Hands must **not** live in a replicated `GameState` that every client receives. The pattern:

- Each player's hand lives on their `APlayerState`, replicated with
  `DOREPLIFETIME_CONDITION(ATradeWarPlayerState, Hand, COND_OwnerOnly)`.
- A **public projection** — per-slot `{ Position, bLocked }` only, exactly what `viewFor`
  produces for non-viewers — replicates to everyone.
- The server holds the authoritative full state and never sends card faces to a client that
  should not see them.

Getting this wrong reproduces the bug `CHECK 10` caught, except unfixable from the client
side and invisible in play.

### Force Trade RPC

```cpp
UFUNCTION(Server, Reliable, WithValidation)
void ServerSubmitAction(const FTradeWarAction& Action);
```

`_Validate` should do the cheap structural checks (is this player the current submitter, is
`TakeIndex` in range). `_Implementation` calls the rules layer, which does the real
validation. **Never** trust a client-supplied `TakeCardId` — accept only `TakeIndex` and
resolve it server-side, or a client can name a card it was never shown.

### Turn timer

Replicate `TimerEndsAt` as server world time and compute the countdown client-side:

```cpp
const float Remaining = State.TimerEndsAt - GetWorld()->GetGameState()->GetServerWorldTimeSeconds();
```

The **server** runs the expiry, not the client's countdown widget. The client timer is
decoration; a client that never fires its timer must not stall the round.

---

## 6. Caveats

**C1 — Pass-and-play privacy has no network analogue.** Every "hand it to the next player"
interstitial disappears in a real multiplayer build, and with it the entire trust model.
The redaction in `viewFor` is currently enforced by *rendering from a projection*; over a
network it must be enforced by *not sending the data*. Treat `viewFor` as the specification
of what each client is allowed to receive, not as a UI helper.

**C2 — Simultaneity is faked by turn order.** Design intent is that a round is simultaneous.
This build makes it sequential and relies on `submissionOrder[0] == activePlayerId` to
preserve the one ordering rule that matters. If a networked version lets players submit
genuinely concurrently, D1 must be revisited: either re-introduce batching (and lose the
per-player feedback) or add an explicit resolve phase. The invariant test `CHECK 3b` is the
thing that will tell you the port broke it.

**C3 — Blind-by-position is only blind if the server keeps it that way.** The mechanic
depends on the client being unable to see which card sits in a slot. Any convenience change
that ships full hands to all clients — a spectator view, a replay, a debug overlay —
silently destroys the game's central bluffing layer while every test still passes.

**C4 — The pure-functional style does not port literally.** `applyAction` deep-clones state
via `JSON.parse(JSON.stringify(...))` on every call. That is fine for a 4–6 player hand and
proves serializability, but a C++ transliteration that copies a `FTradeWarState` per action
is wasteful. Port it as **mutate-in-place on the server, with the copy taken only when you
need a rollback point**. The *contract* (validate fully before mutating anything) is what
must survive, not the copying.

**C5 — Deck exhaustion is reachable at 6 players. The spec is wrong about this.**

Section 5 states that "deck exhaustion is a non-issue at 4–6 players / 4–6 rounds against a
52-card deck — no reshuffle logic needed." That holds at 4 players and fails at 6:

| Players | Dealt | Left in deck | Max possible `REPLACE` actions | Safe? |
|---|---|---|---|---|
| 4 | 16 | 36 | 16 | yes, comfortably |
| 6 | **36** | **16** | **36** | **no — short by 20** |

At 6 players the deal consumes 36 of 52 cards, leaving 16, but the game affords
6 players × 6 rounds = 36 actions, every one of which could be a Replace. Verified by
simulation: a 6-player game where everyone always replaces gets **16 replaces through and
20 rejected** for an empty deck. This is not a corner case — a table replacing roughly half
the time lands right on the boundary.

The implementation degrades safely: `validateReplace` rejects with "Deck is empty," the UI
shows the error, and the player can Lock instead. But **the design has no rule here**, and
"you may not Replace any more" arriving mid-game with no explanation is a bad experience.

Options, none of which should be chosen without a design call:
1. **Reshuffle the discard pile into the deck when it empties.** `state.discard` is already
   maintained for exactly this; it is a few lines in `validateReplace`/`resolveReplace`. Note
   it makes replaced cards reappear, which is a real rules change.
2. **Deal from a two-deck shoe at 6 players.** Removes the problem, introduces duplicate card
   ids — the id scheme (`"7♣"`) assumes uniqueness, so this needs C7 fixed first.
3. **Accept it and surface it honestly** — show the remaining deck count in the UI so players
   can see it coming, and keep the rejection.

**C6 — Drunkenness is an input this game does not own.** It is entered on the setup screen
purely so the tiebreak can be exercised. In the real game it arrives from the parent title,
and a drunkenness tie on top of a score tie defers to the parent's global rule (Section 6.4)
— `determineWinner` currently just keeps the earlier player in that case, which is a
placeholder, not a rule.

**C7 — Card ids use suit glyphs (`"7♣"`).** Convenient in JS, a poor choice for `FName` and
for any wire format. Port to a numeric rank/suit pair with display handled at the render
layer; the ids are already treated as opaque everywhere in the logic, so this is a
mechanical change.
