# Implementation Plan: Cancelling a movie search actually exits it

**Branch**: `050-fix-search-cancel-exit` | **Date**: 2026-08-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/050-fix-search-cancel-exit/spec.md` (backlog item #149)

## Summary

The cancel action on a web-search movie card posts the canonical control value `exit search`, but
the agent's search node honours that control **only while a search stage is live** — and the card
is the terminal step of a search, rendered *after* the workflow state has already been cleared. The
control therefore falls through to the fresh-search branch and is treated as a movie title, so the
member who asked to leave is answered with `I couldn't find "exit search" in your "Wish List"
collection. Want to look elsewhere?`.

A measured reproduction against the real node (research R1) shows the defect is worse than the
report: the cancel also issues a real collection read, emits a `render_selection` call that
re-offers the search controls, and leaves `search_stage` at `awaiting_pick` — so it does not merely
fail, it puts the member **back inside** the workflow they were trying to leave, capturing their
next message too. The item is filed p2 on the strength of the wrong message alone; the actual
behaviour is a trap rather than a dead end.

The fix is agent-side and small: honour the canonical exit control regardless of stage, and route
it to the search node deterministically — before the intent classifier runs — so an escape hatch
never depends on a model call or a healthy provider. No client change is needed, which is also what
gives web/mobile parity (FR-008) by construction rather than by a second implementation.

The larger part of the work is **test integrity**. All three tests 047 shipped for this behaviour
are green on the broken code: the unit test calls the exit function directly (testing the
destination, never the route), and the web E2E asserts only client-local state that changes
regardless of what the assistant replies. Those are corrected here, because a regression test that
cannot fail on the reported bug does not protect the fix (spec FR-011 / SC-006).

See [research.md](./research.md) for the root-cause evidence, the rejected alternatives, and the
blast-radius analysis.

## Technical Context

**Language/Version**: Python 3.12 (agent); TypeScript/React Native (client, tests only)

**Primary Dependencies**: LangGraph (supervisor graph), `langchain_core` messages, AG-UI; Playwright (web E2E), Maestro (mobile flows)

**Storage**: None. A cancel is a read-nothing, write-nothing turn — no MCP tool call, no mc-service call, no collection access.

**Testing**: `pytest` via Nx (`movie-assistant:test`); Vitest for the client component test; Playwright for web E2E; Maestro for the mobile flow

**Target Platform**: Agent Gateway container (Linux); Expo universal client (web + Android)

**Project Type**: Bug fix within the existing AI Agents layer + its client-side and E2E test surface

**Performance Goals**: Non-goal in the ordinary sense; the change *removes* one LLM classification call from the cancel path, so a cancel becomes strictly faster and cheaper than it is today.

**Constraints**: The cancel path must not depend on a model provider being reachable (FR-010). The exact-match rule must not capture real movie titles, and must not steal the bare-`cancel` reply from the import/organize workflows (research R4).

**Scale/Scope**: Two source files in the agent (~20 lines net), plus five test files. No new dependencies, no schema change, no API change, no client behaviour change.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Result: **PASS**, no violations, Complexity Tracking table omitted.*

| Principle | Assessment |
|---|---|
| **Test-Driven Development (NON-NEGOTIABLE)** | PASS — every implementation task is paired with a test task carrying a Verify RED command whose expected output is a real failure. The RED here is unusually strong: one new row in the existing transition table fails on `main` today with the exact reported message. |
| **Test Type Integrity (NON-NEGOTIABLE)** | PASS — the unit tests exercise pure functions with injected stub closures (the node's documented seam), which is a legitimate unit test, not a disguised integration test. The E2E mocks nothing. No test moves tier. |
| **Agent golden tier** | N/A, deliberately — the fix *removes* the classifier from this path. There is no new model decision to record, and a golden pair asserting a classification here would contradict FR-010. |
| **No Domain Logic in Agents** | PASS — a cancel performs no domain operation at all; it emits a message and clears agent-local state. |
| **Agents Never Call Backend Services Directly** | PASS — the change strictly *reduces* tool calls: the current broken path issues a `list_movies` read that the fixed path does not. |
| **AG-UI-Native Interaction** | PASS — no change to events, tools, or the card's props. The client keeps posting the same canonical value through the same send path. |
| **Identity Propagation** | Unaffected — no tool call is made on this path, so no token is exchanged. |
| **HITL Approval Gates** | Unaffected — a cancel writes nothing and so never reaches a gate. FR-005 is pinned by an explicit zero-write assertion. |
| **Universal Generative UI** | PASS — the fix is in the shared agent; both surfaces get it from one change (FR-008). |
| **Agent Separation of Concerns** | PASS — the change stays in the Orchestration layer (supervisor router) and a node's pure dispatcher. No IO added to either. |
| **Logging & Monitoring** | Note, not a violation: routing before the classifier means `record_turn(intent)` is not called for a cancel turn, so cancels stop appearing in the intent counter. That is the correct trade (the metric records *classified* intents, and a cancel is no longer classified), but it must be a conscious choice — recorded in T007 so the observability change is deliberate rather than incidental. |
| **AI Agent Quality Standards** — ruff, mypy/pyright, ≥70% coverage on new code | PASS — enforced by the existing `movie-assistant` lint/typecheck targets; the changed lines are directly covered by the new tests. |
| **Constitution § AI Assistant Constraints — SDD gate** | PASS — this spec/plan/tasks set exists before any implementation code is written under `agents/`. |

## Project Structure

### Documentation (this feature)

```text
specs/050-fix-search-cancel-exit/
├── spec.md                    # What must be true for the member
├── plan.md                    # This file
├── research.md                # Phase 0: root cause, rejected alternatives, blast radius
├── quickstart.md              # Phase 1: how to reproduce RED and verify GREEN
├── contracts/
│   └── search-cancel-control.md   # The client↔agent canonical control contract
├── checklists/
│   └── requirements.md        # Spec quality checklist (from /speckit-specify)
└── tasks.md                   # Phase 2 output (/speckit-tasks — not created here)
```

**No `data-model.md`.** This feature introduces, changes and persists no entity. The spec's "Key
Entities" are conversational concepts, not stored data, and the one genuine interface — the
canonical cancel value shared by client and agent — is captured in `contracts/` where it can
actually be pinned by a test.

### Source Code (repository root)

```text
agents/movie-assistant/
├── src/
│   ├── graph.py                     # CHANGED: deterministic pre-classifier route for the cancel control
│   └── nodes/
│       └── search.py                # CHANGED: `is_search_cancel` helper + stage-free exit; corrected comments
└── tests/
    └── unit/
        ├── test_state_machine_transitions.py   # CHANGED: new stage-free cancel row (primary RED)
        ├── test_graph.py                       # CHANGED: routing is deterministic + classifier-free
        └── test_search.py                      # CHANGED: assert the ROUTE, not just `_exit()`

frontend/mcm-app/
├── src/components/agent/
│   └── render-movie-card.tsx        # UNCHANGED (behaviour); comment corrected — it states the false premise that caused the bug
└── tests/e2e/
    ├── web/agent-search.spec.ts     # CHANGED: assert the assistant's actual reply, not client-local state
    └── mobile/agent-search.yaml     # CHANGED: same assertion for FR-008 parity
```

**Structure Decision**: The change lives entirely in the AI Agents layer plus the test surface that
failed to catch it. `render-movie-card.tsx` keeps its behaviour — it was already correct — but its
comment asserting *"the search node already treats it as a universal control"* is the exact false
premise that produced the bug and is corrected so the next reader does not inherit it.

## Design

### D1 — `is_search_cancel` (new, `src/nodes/search.py`)

A pure predicate mirroring the existing `is_cancel_import` precedent:

- exact match on the trimmed, case-folded canonical value `CTRL_EXIT` (`"exit search"`);
- **not** a substring test, so a movie whose title contains the words is unaffected (spec edge case);
- **not** extended to the bare synonyms `exit` / `cancel` / `never mind`, which stay scoped to a
  live search stage where they cannot collide with the import and organize workflows' own cancels.

Rationale in [research.md § R4](./research.md).

### D2 — Stage-free exit in the search dispatcher (`src/nodes/search.py`)

The guard at the top of `search()` becomes: honour the canonical control **whatever the stage**,
and keep the loose synonyms gated on a live stage. This alone makes the reported flow correct when
the turn reaches the node.

The stale comments in `_web_card_props` and `test_search.py` — which argue the control is already
universal — are corrected in the same change.

### D3 — Deterministic route in the supervisor (`src/graph.py`)

A check placed **immediately after the human-turn guard and before `classifier(messages)`**, so the
cancel is routed without a model call:

- satisfies FR-010 — routing cannot be classified away, and cannot be defeated by a provider
  outage (a classifier exception currently short-circuits to `degraded` *before* any routing runs);
- guarded on **no in-progress add** (`add_stage`), because `_exit()` clears the add lifecycle and
  must not silently discard a member's half-finished add — see [research.md § R5](./research.md);
- needs no guard for the import / organize / navigate workflows, which neither reset dict touches.
  A test pins this rather than assuming it.

### D4 — Test corrections

Per [research.md § R2 and § R6](./research.md), three existing tests are strengthened because each
is currently green on the broken code:

- `test_search.py` — assert cancelling **through the dispatcher** exits, instead of calling `_exit()`
  directly; add that the reply names no collection and offers no further search (FR-003, FR-007).
- `agent-search.spec.ts` — assert the assistant's actual reply after the click. The existing
  assertions (Add disabled, no approval request, card still visible) all pass on the bug.
- `agent-search.yaml` — the same reply assertion on mobile (FR-008 / US3).

## Discovered during implementation

**FR-012 — two more layers answer before routing.** FR-010 was written against the intent
classifier. Implementing it showed the classifier is only the first of three things that reply on
the model's behalf *before* any routing runs:

1. the classifier's own **exception handler**, which returns `degraded`;
2. the **error-rate circuit breaker**, which returns `degraded` when it has tripped.

Both answer a cancel with "Sorry — I couldn't complete that just now", which is neither an
acknowledgement nor an exit. The breaker case is the sharper one: it opens after repeated failures,
which is precisely when a member is most likely to be stuck and wanting out — and a routed cancel
makes no provider call at all, so letting it past costs the cooldown nothing.

The route therefore sits above all three, and below the administrative kill switch, where a
disabled assistant is required to do nothing. Recorded as FR-012 in the spec rather than smuggled
in as an unlisted behaviour change.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| The global route steals a genuine request containing "exit search" | Very low | Exact match on the whole trimmed message, never a substring (D1). Pinned by a test using a title that contains the phrase. |
| A stage-free exit discards a member's in-progress add | Low | Explicit `add_stage` guard (D3), with a test asserting a pending add survives. |
| A stage-free exit disturbs a pending import/organize/navigate | Low | Neither reset dict touches those keys; asserted by test rather than assumed (research R5). |
| Cancels disappear from the intent metric | Certain, and intended | Called out in the Constitution Check and recorded as a deliberate observability change in tasks (T007), not left as a silent side effect. |
| The E2E reply assertion is brittle against copy changes | Medium | Assert on the *absence* of the failure signature (no "couldn't find", no collection name, no re-offer) plus the presence of an acknowledgement — properties the spec fixes, rather than an exact string it deliberately leaves open. |

## Out of scope

- Replacing the text-message control with a structured client→agent signal. A genuine improvement,
  but it changes the contract, the transcript shape, and both surfaces for a p2 bug fix — see
  [research.md § R3](./research.md). If wanted, it belongs in its own backlog item.
- Any change to the add flow, collection data, permissions, or the card's rendering.
- Auditing every other control value for the same stage-gating flaw. The cancel control is what
  #149 reports; a broader sweep is worth filing separately rather than widening this branch.

## Traceability

| Spec requirement | Design | Verified by |
|---|---|---|
| FR-001 exit whatever the stage | D2 | Stage-free row in `_SEARCH_TRANSITIONS` |
| FR-002 acknowledgement | existing `_exit()`, reached via D2 | `test_search.py` dispatcher-level assertion |
| FR-003 no search performed | D2 | Stub read closures asserted uncalled |
| FR-004 never treated as a title | D1 + D2 | Reply asserted not to quote the phrase |
| FR-005 no writes | existing `_exit()` | Zero-write assertion (retained from 047) |
| FR-006 no leftover context | existing `_SEARCH_RESET` | State assertions + E2E next-message step |
| FR-007 no re-offer | D2 | Reply asserted to carry no selection options |
| FR-008 web/mobile parity | agent-side fix (D2/D3) | Mobile flow assertion |
| FR-009 repeat/stale use is inert | D3 `add_stage` guard + client `actioned` state | Import-pending test + existing client test |
| FR-010 routing independent of the classifier | D3 | `test_graph.py` — classifier recorded as never called |
| FR-011 test at the level of the defect | D4 | The RED runs against the dispatcher and the router, not `_exit()` |
| FR-012 honoured while degraded *(added in implementation)* | D3, raised above the breaker | `test_graph.py` — classifier-raises and breaker-open cases |
