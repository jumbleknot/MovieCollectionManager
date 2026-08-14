# Contract — the add question chain gains a first question

**Component**: `movie-assistant` organizer/curator/graph · **Requirements**: FR-008 … FR-019
**Extends**: feature 047 US4 (FR-020 … FR-031a)

## The chain

```text
before   [which collection?] → owned? → [yes] formats → ripped? → [yes] qualities → proposal → approve
after    [which collection?] → children's? → owned? → [yes] formats → ripped? → [yes] qualities → proposal → approve
```

The collection question, when it is asked at all, still comes first (FR-008a). Everything from
`owned?` onward is 047's behaviour unchanged (FR-017).

## The question

| Property | Value |
|---|---|
| Prompt | `Is "<title>" a children's movie?` |
| Control | the existing `render_selection` Yes/No buttons — **not** the toggle-list-plus-confirm used for the multi-valued questions (FR-011) |
| Options | `[{label: "Yes", value: "yes", kind: …}, {label: "No", value: "no", kind: …}]` |
| Tool call id | `add-childrens` (mirrors `add-ownership`) |
| Answering | tap or type, identically — a tap posts the option's `value` through the normal send path (FR-012) |
| Unparseable reply | re-ask the same question; never guess, never fall through (research R8) |

`kind` is coerced to `"control"` for any value outside `{movie, collection, scope, control}` before
it reaches the client, so no frontend registration or schema change is needed (research R7).

## State

New stage `awaiting_childrens`, which must be registered in **three** places or the flow breaks in
three different ways (research R6):

| Registration | Consequence of omission |
|---|---|
| `organizer` transitions | the answer is never consumed; the flow stalls |
| `graph._OWNERSHIP_STAGES` | a bare "yes" is routed as a brand-new request |
| `curator._OWNERSHIP_STAGES` (local mirror) | extraction runs on "yes", finds no film, clears the candidate, and resets the member mid-flow |

`_MULTI_SELECT_STAGES` is **not** extended — the question is single-valued.

The answer is held in `add_childrens` while the chain runs, then carried on `ProposalItem.childrens`
so it survives a HITL pause of any length (research R9).

## Behaviour table

| Member does | Result |
|---|---|
| Answers **yes**, then **yes** to owning it, completes the chain | movie created with `childrens: true` and the 047 answers |
| Answers **no**, then **no** to owning it | movie created immediately with `childrens: false`, `owned: false`, nothing else recorded (FR-009) |
| Answers **yes**, then **no** to owning it | movie created immediately with `childrens: true`, `owned: false` — a not-owned children's movie (US2-AC5) |
| Types "kids movie" rather than tapping | same result as tapping Yes, if it parses as an affirmative; otherwise re-asked (FR-012, research R8) |
| Says something unparseable | question re-asked; no state advances |
| Abandons at this question | pending add discarded, nothing added (FR-013) |
| Adds via spreadsheet import or an organize/update path | never sees the question; `childrens: false` as today (FR-015) |
| Later says "mark X as a kids movie" | unchanged path, same flag (FR-016) |

## What does not change

- The approval message text and the proposal's visible `diff` (FR-018a).
- The post-add navigation to the movie detail screen (FR-019).
- The explicit-approval requirement and the ownership rules mc-service enforces (FR-018, FR-017).
- Any frontend file (research R7).

## Verification

- **Merge-blocking**: `nx test movie-assistant` — the stage transitions including the new entry
  stage, the re-ask, abandonment, the payload values for each combination in the table, and the
  answer surviving apply through `approval_gate`.
- **Non-blocking**: `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts` (`@model-decision`)
  — the question appearing first from a search card and from a typed add, and the created movie
  carrying the answer. Five existing tests in that file, plus one in
  `agent-add-external-link.spec.ts`, walk the old turn sequence and must be updated (FR-021).
