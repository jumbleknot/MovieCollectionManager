# Contract: the search-cancel control

**Feature**: `050-fix-search-cancel-exit` | **Spec**: [../spec.md](../spec.md)

This is the only interface this feature touches. It is not an HTTP API — it is the agreement
between the universal client and the agent about how the member's "leave this search" choice is
expressed. It is written down here because it is currently held together by a pair of comments in
two languages, and those comments were wrong in a way that shipped a bug.

## The value

| Side | Symbol | Value |
|---|---|---|
| Client | `SEARCH_CANCEL_TEXT` — `frontend/mcm-app/src/components/agent/render-movie-card.tsx` | `exit search` |
| Agent | `CTRL_EXIT` — `agents/movie-assistant/src/nodes/search.py` | `exit search` |

The two MUST be identical. They live in different languages with no shared source, so the agreement
is held by an assertion in each side's test suite (the agent side already has one:
`test_search.py` asserts `CTRL_EXIT == "exit search"`).

## Producers

1. The **cancel action on a movie card** — the terminal step of a web search. This is the case
   backlog item #149 reports. At this point **no search stage is live**: the card is rendered only
   after the search workflow has been cleared.
2. The **"Exit search" control button** offered alongside search results and on a no-results reply.
   Here a search stage *is* live.
3. The member **typing the phrase**, with or without a search in progress.

All three mean the same thing and MUST produce the same outcome. Before this feature only (2)
worked; (1) and (3) were treated as a movie title.

## Transport

The value is sent as an ordinary user message on the existing AG-UI run path — the same send path
as the card's "Add to collection" action. No new event type, tool, or transport is introduced.

## Required handling

| Rule | Requirement |
|---|---|
| Matching | **Exact**, on the whole message, trimmed and case-folded. Never a substring test — a movie title containing the words must remain searchable. |
| Stage independence | Honoured whatever the search stage, **including no stage at all**. This is the corrected rule; the previous "universal control" claim held only across live stages. |
| Routing | Resolved **before** intent classification, so it cannot be classified away and cannot be defeated by a model-provider failure. Mirrors the ratified cancel-import control (047 FR-009/FR-010). |
| Effect | Acknowledge; clear the search workflow; perform no read, no write, and no tool call; offer no continuation. |
| Blast radius | Clears search state and the add lifecycle only. An in-progress add is protected by an explicit guard on the route; import, organize and navigate state is untouched. |

## Deliberately NOT part of this contract

- **The bare synonyms** `exit`, `cancel`, `never mind`, `nevermind`. These remain accepted **only
  while a search stage is live**. Promoting them to a stage-free route would steal the cancel reply
  from the import and organize workflows, which have their own cancel handling.
- **The acknowledgement wording.** Fixed only by its properties (names no collection, offers no
  further search), so copy can change without breaking the contract.

## Stability

Changing the value requires changing both sides in the same commit. Either side alone silently
reverts the member-visible behaviour to the #149 bug — the client's cancel becomes a movie title
again — with no compile-time or runtime error to announce it. The paired test assertions are what
make that failure loud.
