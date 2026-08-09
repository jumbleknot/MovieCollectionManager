---
description: "Task list for 050 — cancelling a movie search actually exits it"
---

# Tasks: Cancelling a movie search actually exits it

**Input**: Design documents in `specs/050-fix-search-cancel-exit/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [contracts/search-cancel-control.md](./contracts/search-cancel-control.md), [quickstart.md](./quickstart.md)

**Backlog**: item #149 (`type/bug`, `priority/p2`)

**Tests**: MANDATORY. The constitution's TDD principle is non-negotiable, and spec FR-011 / SC-006
require a test that fails on the reported bug. This feature exists partly *because* the tests
047 shipped for this behaviour cannot fail on it — see [research.md § R2](./research.md).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different file, no dependency on an incomplete task
- **[Story]**: `[US1]`…`[US3]`; Setup / Foundational / Polish tasks carry no story label
- Every test task carries a **Verify RED**; every implementation task a **Verify GREEN**

> **A Verify RED showing 0 failures is a failed task, not a passed one.** Check the collected
> count as well as the failure count — a `-k` selector that matches nothing also reports no
> failures, and this repository has been bitten by exactly that.

---

## Phase 1: Setup — establish the baseline

**Purpose**: Prove the defect exists in this working copy before changing anything, so every later
GREEN is measured against a real RED rather than an assumed one.

- [X] T001 Run the reproduction in [quickstart.md § 1](./quickstart.md) from `agents/movie-assistant` and confirm the four measured lines
  - **Type**: Verification | **Risk**: None
  - **Expected**: reply `I couldn't find "exit search" in your "Wish List" collection. Want to look elsewhere?`; tool calls `['render_selection']`; reads `[('wish', 'exit search')]`; `search_stage` `'awaiting_pick'`
  - **Done when**: all four match. If any differs, STOP — the root cause in [research.md § R1](./research.md) no longer holds and the plan needs revisiting before code is written.

---

## Phase 2: Foundational — the canonical-value predicate

**Purpose**: Both the node fix (US1) and the router fix (US1/US2) call one predicate. It lands
first so neither is blocked, and so its matching rules are pinned before anything depends on them.

**⚠️ BLOCKS**: every user story below.

- [X] T002 [P] Write a failing test for `is_search_cancel` exact-match semantics in `agents/movie-assistant/tests/unit/test_search.py`
  - **Type**: Test | **Risk**: Low | **Covers**: FR-004, spec edge case "cancel wording inside a genuine request", [contract § Required handling](./contracts/search-cancel-control.md)
  - Assert TRUE for `exit search`, `  Exit Search  `, `EXIT SEARCH` (trimmed, case-folded). Assert FALSE for the bare synonyms `exit` / `cancel` / `never mind` (they stay stage-scoped — see [research.md § R4](./research.md)), and FALSE for a message that merely *contains* the phrase, e.g. `find How to Exit Search a Building`.
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_search.py -k is_search_cancel -q`
  - **Expected RED**: collection error / import failure — `cannot import name 'is_search_cancel' from 'src.nodes.search'`
  - **Measured RED**: 14 failed, 1101 deselected — `ImportError`. **GREEN**: 14 passed.

- [X] T003 Add `is_search_cancel(text: str) -> bool` to `agents/movie-assistant/src/nodes/search.py`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T002 verified RED
  - Exact match on the trimmed, case-folded message against `CTRL_EXIT` only. Mirror the existing precedent `is_cancel_import` (`src/nodes/import_disambiguation.py:210`) in both shape and docstring style. **Not** a substring test.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_search.py -k is_search_cancel -q`
  - **Expected GREEN**: 0 failures, ≥5 passed
  - **Also run**: `pnpm nx run movie-assistant:test -- tests/unit/test_search.py -q` → previously passing tests still pass

---

## Phase 3: User Story 1 — cancelling from a movie card leaves the search (P1) 🎯 MVP

**Goal**: Pressing cancel on the terminal movie card ends the search with an acknowledgement — no
read, no tool call, no collection named, no continuation offered.

**Independent Test**: [quickstart.md § 1](./quickstart.md) prints the post-fix output, and
[quickstart.md § 7](./quickstart.md) passes manually.

### Tests first — all four verified RED before any Phase 3 implementation

- [X] T004 [P] [US1] Add a stage-free cancel row to `_SEARCH_TRANSITIONS` in `agents/movie-assistant/tests/unit/test_state_machine_transitions.py`
  - **Type**: Test | **Risk**: Low | **Covers**: US1-AC1, FR-001
  - One table entry: empty state (no `search_stage`), text `CTRL_EXIT`, expect `"exit"`, spec note *"the terminal card has already cleared the stage — cancel must still exit"*. This is the primary RED and states the whole bug in one row.
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_state_machine_transitions.py -k cancel -q`
  - **Expected RED**: 1 failing — the node re-offers a search where `exit` was expected
  - **Measured RED**: 2 failed (one row per case) — `assert 'control_buttons' == 'exit'`. The predicted classification was `result_buttons`; with no owned match the node returns `control_buttons`. Same defect, more precise label.

- [X] T005 [P] [US1] Replace the `_exit()`-direct assertions in `agents/movie-assistant/tests/unit/test_search.py` with dispatcher-level ones
  - **Type**: Test refactor | **Risk**: Medium | **Covers**: US1-AC2, US1-AC3, US1-AC4, FR-002, FR-003, FR-004, FR-007
  - `test_cancel_no_writes_produces_an_acknowledgement_and_zero_write_calls` currently calls `_exit()` directly — it tests the destination and never the route, which is why the bug shipped ([research.md § R2](./research.md)). Drive `build_search_node(...)` instead, with stub reads and **no** search stage, and assert: the reply is non-empty; the stub `list_movies` and `web_search` were **never called**; **zero** tool calls of any kind (not merely zero *write* calls — a `render_selection` is what re-offers the search); the reply text contains neither the collection name nor the phrase `exit search`.
  - Keep the existing zero-write and `CTRL_EXIT == "exit search"` assertions — they are still the contract.
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_search.py -k cancel -q`
  - **Expected RED**: ≥1 failing — stub `list_movies` called with `('wish', 'exit search')`, and a `render_selection` tool call present
  - **Measured RED**: 1 failed — `cancelling performed a search: [('wish', 'exit search')]`. A companion guard test (`test_cancel_still_exits_mid_search`) was added and passes, so widening the guard cannot narrow the in-stage behaviour.

- [X] T006 [P] [US1] Write a failing test asserting the cancel route never consults the classifier, in `agents/movie-assistant/tests/unit/test_graph.py`
  - **Type**: Test | **Risk**: Medium | **Covers**: FR-010
  - Follow the existing pattern at `test_graph.py:47` (`test_non_user_turn_ends_without_declining`), which records classifier calls and asserts `calls == []`. Two cases: (a) a recording classifier — assert it was never called and the search node was reached; (b) a classifier that **raises** — assert the cancel still exits rather than degrading. Case (b) is the one that matters: `_classify` returns `degraded` on a classifier exception *before* any routing runs, so today a provider outage answers a cancel with "I couldn't complete that".
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_graph.py -k cancel -q`
  - **Expected RED**: 2 failing — the classifier is recorded as called; the raising case returns intent `degraded`
  - **Measured RED**: 2 failed, exactly as predicted, including `assert 'degraded' != 'degraded'` for the provider-down case. A third test (a title *containing* the phrase must still be classified normally) passes already and stands as a guard.

- [ ] T007 [P] [US1] Strengthen the web E2E cancel assertion in `frontend/mcm-app/tests/e2e/web/agent-search.spec.ts`
  - **Type**: Test refactor | **Risk**: Medium | **Covers**: US1-AC2, US1-AC4, FR-002, FR-003, FR-007
  - The existing test at line 133 passes on the broken code: the disabled Add button is client-local state set before the agent replies, and a *failed search* also produces no approval request. Add assertions on the assistant's actual reply after the click — no `couldn't find`, no occurrence of the on-screen collection name, and no new `selection-options` block — plus a positive acknowledgement. Assert on those **properties** rather than an exact string; the spec deliberately leaves the wording open.
  - **Verify RED**: `pnpm nx run mcm-app:e2e -- --grep "cancel from the web card"`
  - **Expected RED**: 1 failing — the assistant reply contains `couldn't find` and the collection name
  - **Note**: ~35 min. Run this RED **before** T008/T009 land, or it can never be seen to fail.

### Implementation — after all four REDs are confirmed

- [ ] T008 [US1] Honour the canonical cancel control regardless of search stage, in `agents/movie-assistant/src/nodes/search.py`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T004, T005 verified RED
  - Change the guard at the top of `search()` so `is_search_cancel(text)` exits whatever the stage, while the loose synonyms (`exit`, `cancel`, `never mind`, `nevermind`) stay gated on a live stage.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_state_machine_transitions.py -k cancel -q && pnpm nx run movie-assistant:test -- tests/unit/test_search.py -k cancel -q`
  - **Expected GREEN**: 0 failures in both, with non-zero collected counts
  - **Also run**: `pnpm nx run movie-assistant:test -- tests/unit/test_state_machine_transitions.py -q` → the existing `pick-exit→exit` row and all other transitions still pass

- [ ] T009 [US1] Route the cancel control deterministically, before intent classification, in `agents/movie-assistant/src/graph.py`
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T006 verified RED
  - Place the check immediately after the human-turn guard and **before** `classifier(messages)`, returning the `search` intent. Guard it on there being no in-progress add (`add_stage`) — `_exit()` clears the add lifecycle and must not silently discard a half-finished add ([research.md § R5](./research.md)). Comment it with the reason, as `is_cancel_import` is at `graph.py:387`.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_graph.py -k cancel -q`
  - **Expected GREEN**: 0 failures, 2 passed
  - **Also run**: `pnpm nx run movie-assistant:test -- tests/unit/test_graph.py tests/unit/test_routing.py -q` → all existing routing guards still pass

- [ ] T010 [US1] Record the observability consequence of routing before the classifier
  - **Type**: Documentation | **Risk**: None | **Covers**: plan.md Constitution Check (Logging & Monitoring)
  - `record_turn(intent)` runs after classification, so cancels no longer appear in the intent counter. That is the correct trade — a cancel is no longer a classified turn — but it must be deliberate. Note it in the `graph.py` comment beside the new route, and confirm no dashboard or alert keys on a `search` intent volume that would now shift.
  - **Done when**: the comment states it, and a grep of `infrastructure-as-code/` for an alert on classified-intent volume comes back empty (or the finding is filed as a backlog item).

- [ ] T011 [US1] Re-run T007's web E2E to GREEN
  - **Type**: Verification | **Risk**: Low | **Prerequisite**: T008, T009 complete
  - **Verify GREEN**: `pnpm nx run mcm-app:e2e -- --grep "cancel from the web card"`
  - **Expected GREEN**: 1 passed

**Checkpoint**: US1 is independently shippable here. [quickstart.md § 1](./quickstart.md) prints
empty reads, empty tool calls and a cleared stage; the reported path passes manually.

---

## Phase 4: User Story 2 — the next message after cancelling is a fresh request (P1)

**Goal**: A cancel leaves no residue — no search context, and nothing else the member was doing is
destroyed either.

**Independent Test**: Cancel from a card, send an unrelated request, and confirm it is handled on
its own terms.

- [X] T012 [P] [US2] Write failing tests for cancel residue and blast radius in `agents/movie-assistant/tests/unit/test_graph.py`
  - **Type**: Test | **Risk**: Medium | **Covers**: US2-AC1, US2-AC2, FR-006, FR-009, spec edge case "stale card"
  - Three assertions, each stating a claim [research.md § R5](./research.md) makes and must not merely assume: (a) after a cancel, `search_stage` / `search_query` / `search_results` are all cleared; (b) a cancel taken while an **import** is pending does not clear `import_stage` — the import still resumes on the next reply; (c) a cancel taken while an **add** is pending is NOT taken as a stage-free route, so the pending add survives.
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_graph.py -k residue -q`
  - **Expected RED**: 3 failing
  - **Measured RED**: **1 failing, not 3.** The import-survives and add-survives cases pass already — today's cancel does nothing, so those states survive by accident rather than by design. They are therefore *guard* tests protecting the fix, not REDs, and are recorded as such rather than counted as a demonstrated failure.
  - **Correction made while writing this**: the first draft of the clears-everything case asserted through `build_graph`'s DEFAULT search node, which is a fixed-text responder that never touches state — it proved nothing. It now injects the real `build_search_node`, making it the closest unit-level analogue of the member's report: message → real router → real node. It fails on `the cancel searched a collection: [('c1', 'exit search')]`.

- [ ] T013 [US2] Confirm the `add_stage` guard and reset scope satisfy T012 in `agents/movie-assistant/src/graph.py`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T012 verified RED
  - Cases (a) and (b) should already pass from T009 plus the existing `_SEARCH_RESET` / `_LIFECYCLE_RESET` scope; case (c) is the `add_stage` guard. If any of the three still fails, the reset scope is not what the research claims — fix the code, and correct [research.md § R5](./research.md) rather than weakening the test.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_graph.py -k residue -q`
  - **Expected GREEN**: 0 failures, 3 passed

- [ ] T014 [US2] Extend the web E2E's post-cancel step in `frontend/mcm-app/tests/e2e/web/agent-search.spec.ts`
  - **Type**: Test | **Risk**: Low | **Covers**: US2-AC1, US2-AC2 | **Prerequisite**: T007 (same file — not parallel with it)
  - The existing test already sends a follow-up message; assert its answer does not reference the cancelled search's title or scope, and that starting a *new* search re-asks for scope rather than reusing the cancelled search's collection.
  - **Verify GREEN**: `pnpm nx run mcm-app:e2e -- --grep "cancel from the web card"` → 1 passed

**Checkpoint**: US1 + US2 together are the whole of backlog item #149's acceptance criterion.

---

## Phase 5: User Story 3 — web and mobile behave identically (P2)

**Goal**: Verify parity. The fix is agent-side, so parity is expected by construction — this phase
proves it rather than building it.

**Independent Test**: The Story 1 flow on mobile yields the same acknowledgement.

- [X] T015 [P] [US3] Extend the mobile flow in `frontend/mcm-app/tests/e2e/mobile/agent-search.yaml` to assert the cancel reply
  - **Type**: Test | **Risk**: Low | **Covers**: US3-AC1, FR-008
  - The flow already covers the cancel action (047 T091); add the same reply assertions as T007 — no `couldn't find`, no collection name, no new selection block.
  - **Verify GREEN**: `pnpm nx run mcm-app:e2e-mobile -- --flow tests/e2e/mobile/agent-search.yaml`
  - **Expected GREEN**: flow passes. See [openwiki/runbooks/android-emulator.md](../../openwiki/runbooks/android-emulator.md) for bringing the emulator up.

---

## Phase 6: Polish & cross-cutting

- [ ] T016 [P] Correct the three comments that assert the false premise behind this bug
  - **Type**: Documentation | **Risk**: None
  - `agents/movie-assistant/src/nodes/search.py` `_web_card_props` (lines ~310–313), the header block in `agents/movie-assistant/tests/unit/test_search.py` (~lines 580–588), and `frontend/mcm-app/src/components/agent/render-movie-card.tsx` (~lines 68–75, 132–134). All three state that the search node "already treats it as a universal control, so no new agent-side parsing is introduced". That was true across live *stages* and false at the terminal card, which has none — and it is the reasoning that shipped the defect.
  - **Done when**: no comment in either language still claims the control is universal without saying it is universal *including with no stage*, and each points at the deterministic route.

- [ ] T017 Record the learning in the knowledge bundle per [openwiki/INSTRUCTIONS.md](../../openwiki/INSTRUCTIONS.md)
  - **Type**: Documentation | **Risk**: None
  - Two learnings, both general beyond this bug: (1) a control gated on a workflow stage is not universal, and the *terminal* step of a workflow is exactly where the stage is already gone; (2) an E2E that asserts only client-local state (a button disabling itself) cannot fail on a wrong agent reply — assert what the assistant said. Apply the routing rule in `INSTRUCTIONS.md`: a concept citing a `resource` is a derived summary, so write into the cited source; if no concept covers the subject, add one. Candidate home: a new gotcha alongside `openwiki/gotchas/`, cross-linked from `openwiki/architecture/agent-layer.md`.
  - **Done when**: `node scripts/check-openwiki-governance.mjs` passes and the learning is findable from the CLAUDE.md index.

- [ ] T018 Full quality gate
  - **Type**: Verification | **Risk**: Low
  - `pnpm nx run movie-assistant:test` → 0 failures; `pnpm nx run movie-assistant:lint` → ruff and mypy both clean; `pnpm nx run mcm-app:test -- render-movie-card` → 0 failures.
  - **Done when**: all three green, and the **skip count** in the pytest run is checked, not just the failure count — a skip reads as a pass.

- [ ] T019 Final validation against [openwiki/invariants/feature-validation-checklist.md](../../openwiki/invariants/feature-validation-checklist.md)
  - **Type**: Verification | **Risk**: Low
  - Walk the whole "What done means" list in [quickstart.md](./quickstart.md), including the manual reported path (§ 7).

- [ ] T020 Close backlog item #149 — **only after T019 passes**
  - **Type**: Chore | **Risk**: None
  - Apply the labels the body already declares but the item lacks (`type/bug`, `priority/p2`) and the `050-fix-search-cancel-exit` milestone; comment with the verification evidence; then `node scripts/backlog.mjs update 149 --state closed`.
  - **Done when**: the item is closed with its acceptance criterion demonstrably met — closure is an explicit act after verification, never "the PR merged".

---

## Dependencies

```text
T001 (baseline)
  └─> T002 ─> T003            Foundational: is_search_cancel  ⚠️ BLOCKS ALL STORIES
        ├─> [US1] T004, T005, T006, T007  (all RED, parallel)
        │       └─> T008 ─> T009 ─> T010
        │                     └─> T011 (E2E GREEN)
        ├─> [US2] T012 ─> T013 ─> T014      (T014 needs T007: same file)
        └─> [US3] T015                       (needs T008+T009 landed)
                    └─> T016, T017 [P] ─> T018 ─> T019 ─> T020
```

**Story independence**: US1 is shippable alone and is the MVP. US2 hardens it and is where the
blast-radius claims get proved. US3 is verification only. US2 and US3 both require US1's
implementation (T008/T009) but not each other.

## Parallel opportunities

- **Phase 3 REDs**: T004, T005, T006, T007 touch four different files — write and verify all four
  RED together. Start T007 (E2E, ~35 min) **first**; it is the long pole and the one that cannot
  be seen RED once the fix lands.
- **Phase 6**: T016 and T017 are independent documentation tasks.
- Everything else is sequential — the two implementation tasks (T008, T009) are the funnel that
  turns every RED green, and the verification chain after them is inherently ordered.

## Implementation strategy

**MVP = Phase 1 → Phase 2 → Phase 3.** That is backlog item #149's acceptance criterion in full and
is independently shippable. Phases 4–6 complete the spec (residue, parity, and the knowledge the
next reader needs) and should ship in the same pull request: per
[openwiki/process/pull-request-batching.md](../../openwiki/process/pull-request-batching.md), split
only when a red run would be ambiguous, and here every phase touches the same two source files and
the same test surface — a failure could not be misattributed.

**Task count**: 20 — 3 setup/foundational, 8 for US1, 3 for US2, 1 for US3, 5 polish/verification.
