# Contract change: `render_movie_card` gains a cancel action

**Feature**: [047](../spec.md) · **Story**: US5 · **Satisfies**: FR-032, FR-033, FR-034, FR-035

**Additive only.** One optional prop is added to the existing `render_movie_card` contract
([specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md](../../012-multi-agent-mvp/contracts/generative-ui-and-actions.md),
extended by 013 US10 with `url` / `addable` / `addCollectionId` / `addCollectionName`). Every
existing emitter stays valid — a card without the new prop behaves exactly as it does today.

## Added prop

| Field | Type | Required | Notes |
|---|---|---|---|
| `cancelable` | boolean | no | Defaults `false`. When `true` the card renders a cancel action alongside "Add to collection". |

Emitted `true` only by the search node's terminal web-result card (`_web_card` in
[search.py](../../../agents/movie-assistant/src/nodes/search.py)) — the one place a member is left
with an add-or-nothing choice. Look-up-only preview cards and in-collection cards are unaffected.

## Client behaviour

- The cancel action sits beside the existing Add button, reachable on web and Android (FR-035).
- Tapping it posts the canonical exit value through the same send path the Add button uses. The
  search node already treats `exit` / `cancel` / `never mind` as a universal control
  ([search.py:460](../../../agents/movie-assistant/src/nodes/search.py#L460)), so no new agent-side
  parsing is introduced.
- After cancelling, the card no longer invites an add — both actions are disabled (FR-033).
- The card itself remains in the conversation as a record of what was shown; cancelling ends the
  workflow, it does not erase history (spec Assumptions).

## Agent-side note

`_web_card` **already** clears the search workflow state via `_SEARCH_RESET` before rendering. So
FR-034 ("the next message is a fresh request") holds today and the cancel path must not regress it.
Cancelling is an acknowledgement plus an affordance, not a state transition — which is why this
story is the smallest of the five.

A test must pin that a cancel produces an acknowledgement and **zero** write tool calls.

## Out of scope

- A cancel action on non-search cards.
- Removing or collapsing the card from the transcript.
