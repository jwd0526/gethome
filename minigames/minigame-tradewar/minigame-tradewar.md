# Trade War — Minigame Build Spec

**Status:** Web POC (proof of concept) — simple UI, functional only. Not the final art/engine target.
**Future target:** Unreal Engine port. Core game logic should be engine-agnostic so this POC's rules layer can be reused, not rewritten, when porting.
**Template:** D (Card/Choice)
**Scene:** Card Table
**Players:** 4 or 6 (fixed party-size formats; N = player count = cards dealt = number of rounds)

---

## 1. Overview

Each player is dealt N cards (N = number of players). Over N rounds, players take turns being the "active" player, during which every player performs exactly one action on their hand: **Lock**, **Replace**, or (active player only) **Force Trade**. At the end of N rounds, all cards are final. Highest sum of card values wins; ties broken by drunkenness stat.

---

## 2. Data Model

```
Player {
  id: string
  hand: Card[4]          // length == N, fixed at deal
  drunkenness: number     // externally supplied, used only for tiebreak
  isActiveThisRound: bool
}

Card {
  id: string
  rank: string            // "A","2"..."10","J","Q","K"
  value: number            // A=1, 2-10=face, J=11, Q=12, K=13
  locked: bool
  ownerId: string
}

GameState {
  players: Player[]
  deck: Card[]             // standard 52-card deck, no jokers, shuffled at start
  currentRound: number      // 1-indexed, up to N
  activePlayerId: string    // rotates each round
  roundOrder: string[]      // predetermined sequence of activePlayerId per round,
                             // each player appears exactly once
  phase: "AWAITING_ACTIONS" | "ROUND_RESOLVING" | "GAME_OVER"
  actionsThisRound: Map<playerId, ActionRecord>
}

ActionRecord {
  playerId: string
  actionType: "LOCK" | "REPLACE" | "FORCE_TRADE"
  // payload varies by actionType, see Section 4
}
```

---

## 3. Setup

1. Determine N = number of players (4 or 6).
2. Shuffle standard 52-card deck (no jokers).
3. Deal N cards face-up (visible to owner only) to each player. All dealt cards start **unlocked**.
4. Generate `roundOrder`: a random permutation of all player IDs, length N. `roundOrder[i]` is the active player for round `i+1`. Each player appears exactly once across all rounds.
5. Set `currentRound = 1`, `activePlayerId = roundOrder[0]`, `phase = AWAITING_ACTIONS`.

---

## 4. Round Flow

Each round proceeds as follows:

1. **Round start:** Set `activePlayerId` from `roundOrder[currentRound - 1]`.
2. **Action collection:** Every player (including the active player) submits exactly one action:
   - `LOCK` — no payload beyond the card being locked.
   - `REPLACE` — no additional payload; system draws from deck.
   - `FORCE_TRADE` — **only legal if `playerId == activePlayerId`.** Payload: `{ giveCardId, targetPlayerId, takeCardId }`.
3. **Resolution order:** Process actions in this fixed order to avoid ambiguity when a Force Trade touches another player's hand mid-round:
   1. Resolve `FORCE_TRADE` first (only one can occur per round, since only the active player may submit it).
   2. Resolve all `REPLACE` actions.
   3. Resolve all `LOCK` actions.
   - Rationale: Force Trade changes hand contents before other players lock/replace, matching "each player still gets to play their turn" from design intent — the trade target's turn is not skipped or overridden, only one card is swapped before their own action resolves.
4. **End of round:** increment `currentRound`. If `currentRound > N`, proceed to Section 6 (End Game). Otherwise return to step 1.

---

## 5. Actions — Detailed Rules

### LOCK
- **Eligibility:** Any player, any round.
- **Validation:** Target card must belong to the acting player and be `locked == false`.
- **Effect:** `card.locked = true`. No other state change.

### REPLACE
- **Eligibility:** Any player, any round.
- **Validation:** Target card must belong to the acting player and be `locked == false`. (Deck exhaustion is a non-issue at 4–6 players / 4–6 rounds against a 52-card deck — no reshuffle logic needed.)
- **Effect:**
  1. Remove the chosen unlocked card from the player's hand (discard it — does not return to deck).
  2. Draw the top card from the deck.
  3. New card is added to hand with `locked = true` immediately (per spec: replaced cards auto-lock).

### FORCE_TRADE
- **Eligibility:** Only the round's `activePlayerId`. One Force Trade action max per round (since only one player is active).
- **Validation:**
  - `giveCardId` must belong to the active player and be `locked == false`.
  - `targetPlayerId` must not equal the active player's own ID.
  - `takeCardId` must belong to `targetPlayerId` and be `locked == false`.
  - Trade is only legal between two unlocked cards — a locked card can never be given or taken.
- **Effect:**
  1. Remove `giveCardId` from active player's hand; add it to `targetPlayerId`'s hand with `locked = false` (it does **not** lock for the receiver).
  2. Remove `takeCardId` from `targetPlayerId`'s hand; add it to active player's hand with `locked = true` immediately.
- **Note:** The target player still submits their own separate action (Lock/Replace) this same round — Force Trade does not consume or replace their turn.

---

## 6. End Game

1. After round N resolves, force-lock any remaining unlocked cards for all players (no further actions possible).
2. Compute `score[player] = sum(card.value for card in player.hand)`.
3. Determine winner: `max(score)`.
4. **Tiebreak:** If two or more players share the max score, the player among them with the highest `drunkenness` value wins. (If drunkenness is also tied, defer to whatever global tiebreak rule the parent game uses — not defined at the minigame level.)

---

## 7. UI/UX Requirements

- **Hand display:** Each player sees only their own hand in full detail (rank + value). Other players' hands show card **backs only**, except for cards explicitly revealed via Force Trade (the card given away becomes visible to its new owner; it does not need to be revealed to the rest of the lobby).
- **Locked indicator:** Locked cards need a clear visual state (e.g., dimmed glow, lock icon overlay) distinct from unlocked cards.
- **Active player indicator:** UI must clearly show whose round it is (turn banner, avatar highlight), since only that player sees the Force Trade option.
- **Force Trade flow (active player only):**
  1. Select own card to give (must be unlocked).
  2. Select target player.
  3. Select which of the target's unlocked cards to take — shown as **face-down slots by position only**, not values. The pick is blind, but corresponds to the card's real position in the target's hand (not randomized server-side), so returning players can track/bluff based on position over multiple rounds — this is the intended psychological layer.
- **End-of-game reveal:** All hands flip face-up simultaneously; show computed sums side-by-side with the winner highlighted.
- **Action timer:** Every individual action submission — every player, every round, including each step of a Force Trade — has a **15-second timer**. The timer resets/restarts fresh at each new decision point (i.e., a player gets a full 15s window each time it's their turn to submit an action, not one 15s budget for the whole round). If a player doesn't act in time, auto-resolve to `LOCK` on their lowest-value unlocked card (fallback rule — flagged as an assumption, not explicitly specified, confirm before build). Timer UI should be visible to all players (spectator tension), even though only the active player sees Force Trade controls.

---

## 8. Open Questions / Assumptions Made

All prior open questions have been resolved (trades are unlocked-only, blind-by-position, 4/6 players makes deck exhaustion moot). One assumption remains, not explicitly specified:

1. **Timer-expiry fallback behavior:** Spec assumes auto-`LOCK` on the lowest-value unlocked card if a player fails to act within 15s. Confirm this is the desired fallback (alternatives: auto-`REPLACE`, or the player simply forfeits the round with no action taken and their hand stays as-is).

---

## 9. Engine-Agnostic Logic Design (for future Unreal port)

Goal: the POC is a web app, but the **rules/state logic** should be written so it can be ported to Unreal later without a rewrite — only the rendering layer changes. Practically, that means:

- **Keep game logic pure and stateless-in/stateless-out.** The core should be a single `GameState` object (matches Section 2's data model exactly) plus a set of functions: `applyAction(state, action) → newState`, `checkGameOver(state) → bool`, `computeScores(state) → scores`. No DOM references, no React state hooks, no UI framework calls inside this layer — it should run identically in Node, a browser console, or (conceptually) C++ later.
- **State must be plain, serializable data** (JSON-shaped: strings, numbers, arrays, plain objects) — no functions or class instances stored inside `GameState` itself. This is what makes the eventual C++ struct port a near 1:1 translation instead of a redesign.
- **All validation from Section 5 lives in the logic layer, not the UI.** Buttons should simply attempt an action and get an accept/reject result back — the UI never independently decides what's legal.
- **Action interface is the contract that survives the port.** `{ playerId, actionType, payload }` in and `{ success, newState, error? }` out — this exact shape becomes the Unreal `ServerSubmitAction` RPC payload later. Design it now, in JS, as if it already needs to cross a network boundary, even though the POC may just call it as a local function.
- **Timer logic is also engine-agnostic:** a plain countdown value in `GameState` (`timerEndsAt: timestamp`) checked by the logic layer, not something baked into a UI component's internal state.

This means: when you get to Unreal, `UTradeWarGame` becomes a re-implementation of the same `applyAction`/`GameState`/validation rules in C++ — the design decisions in Sections 4–6 don't need to be rethought, only re-typed into a different language.

---

## 10. Web POC — Simple UI Spec

Bare-functional, no art pass. Goal is to validate the logic loop is fun/correct, not to look good.

- **Layout:** single page, one row per player (or just the local/active player's view if simulating one seat at a time for testing). No animations required.
- **Card display:** plain text is enough — `"7♣"` / `"K♠"` — colored text or a simple border for suit if you want, no card art needed.
- **Own hand:** shown as text + a **Lock** button and **Replace** button under each unlocked card. Locked cards just show as greyed-out/disabled with a "LOCKED" label.
- **Other players' hands:** shown as numbered face-down slots (`[1] [2] [3] [4]`, no values) — enough to support Force Trade's blind-by-position selection.
- **Force Trade (active player only):** a simple 3-step form/flow — dropdown or click to pick your own unlocked card → dropdown to pick target player → click one of their numbered slots. A plain "Confirm Trade" button.
- **Timer:** plain text countdown (`"14s"`), no need for a radial/animated bar in the POC.
- **Round/turn indicator:** plain text — `"Round 2 of 4 — Active Player: Jackson"`.
- **End screen:** simple table — player name, final hand (revealed), sum, winner marked with plain text ("WINNER") rather than any special styling.

No styling requirements beyond basic readability — this is purely to playtest the rules from Sections 4–6, not a UI prototype.