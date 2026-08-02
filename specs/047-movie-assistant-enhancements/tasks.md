---
description: "Task list for 047 — Movie Assistant Enhancements & Fixes"
---

# Tasks: Movie Assistant Enhancements & Fixes

**Input**: Design documents from `/specs/047-movie-assistant-enhancements/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **REQUIRED, not optional.** TDD is NON-NEGOTIABLE in the constitution, and
[test-authoring-conventions](../../openwiki/process/test-authoring-conventions.md) requires every
feature test task to use the Verify RED → Verify GREEN checkpoint pair.

**Organization**: Phases follow spec priority order (US1…US5). Delivery is by **PR group**, which
cuts across priority — see [Dependencies & Execution Order](#dependencies--execution-order).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: `[US1]`…`[US5]`; Setup/Foundational/Polish tasks carry no story label
- Every task line carries an exact file path

Each test task carries an indented **RED:** line and each implementation task an indented
**GREEN:** line — the checkpoint pair required by
[feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md), reconciled
with the single-line checklist format. *A passing test that was never RED is not a TDD test.*

## Path conventions

| Project | Root | Unit tests | Integration tests |
|---|---|---|---|
| agent | `agents/movie-assistant/src/` | `agents/movie-assistant/tests/unit/` | `agents/movie-assistant/tests/integration/` |
| movie-mcp | `mcp-servers/movie-mcp/src/` | `mcp-servers/movie-mcp/tests/unit/` | `mcp-servers/movie-mcp/tests/integration/` |
| mc-service | `backend/mc-service/src/` | inline `#[cfg(test)]` at file bottom | `backend/mc-service/tests/integration/` |
| app | `frontend/mcm-app/src/` | co-located `*.test.tsx` | `frontend/mcm-app/tests/e2e/` |

---

## Phase 1: Setup & Research Gates

**Purpose**: Answer the two gating research questions and build the fixtures the defects need. Three
of these defects only reproduce at scale, so a small fixture would let every test pass while the bug
is still live.

- [ ] T001 Resolve [RQ-1](./research.md#rq-1) — reproduce `navigate to <collection>` against the large-library fixture, capture the gateway log, and record which hypothesis fired (classified intent from `record_turn`, `record_turn_failure`, breaker state) in `specs/047-movie-assistant-enhancements/research.md`
  - **Done when**: RQ-1's Status line reads RESOLVED and names the confirmed cause. **Gates all of Phase 3.**
- [ ] T002 Resolve [RQ-2](./research.md#rq-2) — verify whether `@copilotkit/react-native`'s `useAgent` exposes agent state and re-renders on AG-UI `STATE_DELTA`; record the answer in `specs/047-movie-assistant-enhancements/research.md`
  - **Done when**: RQ-2 names the chosen transport. If the state channel is unavailable, **stop and raise FR-014a with the product owner** — do not silently redefine "updates in place" as an appending line. **Gates T049–T052.**
- [ ] T003 [P] Seed a large-library fixture — one collection of 2,500+ movies — in `frontend/mcm-app/tests/e2e/web/setup/` and document the seeding command in `specs/047-movie-assistant-enhancements/quickstart.md`
  - **Done when**: the fixture seeds reproducibly and `list_movies` needs >30 keyset pages to walk it.
- [ ] T004 [P] Add trailing-whitespace and multi-word-comma title rows (`"Three Billboards Outside Ebbing, Missouri "`, `"Crouching Tiger, Hidden Dragon"`) to the import fixtures in `agents/movie-assistant/tests/fixtures/adversarial.py`
  - **Done when**: both shapes are importable fixtures and the trailing space survives fixture round-trip (a formatter must not eat it).
- [ ] T005 [P] Create a 5,001-row oversize spreadsheet fixture generator in `agents/movie-assistant/tests/fixtures/adversarial.py`
  - **Done when**: the generator produces a workbook whose eligible row count exceeds the ceiling by exactly one.
- [ ] T006 [P] Confirm [RQ-5](./research.md#rq-5) — measure the audit sink under a 2,000-event burst and record the result in `specs/047-movie-assistant-enhancements/research.md`
  - **Done when**: RQ-5 records measured throughput and confirms per-write audit events are retained.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The option-matching normalisation shared by US2 and US4. Both stories fail the same
way — an answer that differs only by surrounding whitespace or case matches nothing — so the fix is
made once, in the shared resolver, and registered with the adversarial harness.

**⚠️ CRITICAL**: US2 and US4 cannot begin until T008 is GREEN.

- [ ] T007 Register whitespace/case option shapes in the shared adversarial catalogue at `agents/movie-assistant/tests/fixtures/adversarial.py` — trailing-space option label vs trimmed reply, leading space, mixed case, and the label-longer-than-reply case that causes the substring test to fail
  - **Done when**: the catalogue exposes the new shapes to `test_resolvers_adversarial.py` and `test_resolvers_properties.py`.
- [ ] T008 [P] Write failing normalisation tests for `resolve_option` in `agents/movie-assistant/tests/unit/test_resolvers_adversarial.py` and a Hypothesis invariant in `agents/movie-assistant/tests/unit/test_resolvers_properties.py` ("an option that equals the reply after trim+casefold always resolves")
  - **RED**: `pnpm nx run movie-assistant:test -- -k "normalise or normalize" -q` → expected ≥2 failing, `assert None is not None` on the trailing-space option
- [ ] T009 Add a normalised-equality check to `resolve_option` **before** the substring step in `agents/movie-assistant/src/nodes/supervisor.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- -k "normalise or normalize" -q` → 0 failures
  - **Also run the touched suite**: `pnpm nx run movie-assistant:test -- tests/unit/test_resolvers_adversarial.py tests/unit/test_resolvers_properties.py tests/unit/test_search.py tests/unit/test_navigator.py tests/unit/test_organize_flow.py`
- [ ] T010 Re-run the recorded-output → resolver bridge in `agents/movie-assistant/tests/unit/test_recorded_phrasing_resolves.py` to prove the shared change did not alter resolution of real recorded model output
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_recorded_phrasing_resolves.py` → 0 failures

**Checkpoint**: Option matching is whitespace- and case-insensitive across search, organize,
navigate and import. US2 and US4 unblocked.

---

## Phase 3: User Story 1 — Open a collection by name (Priority: P1) — PR B

**Goal**: `navigate to <collection name>` opens that collection regardless of library size, and an
unresolvable target explains itself instead of returning the generic reply.

**Independent Test**: Against the T003 large-library fixture, ask the assistant to navigate to a
collection by name and confirm it opens — and that the turn issues **no** `list_movies` pagination.

**⚠️ Blocked by T001.** The pagination work below is correct regardless, but the error-message tasks
(T019–T020) depend on knowing which path actually emits the generic reply.

- [ ] T011 [P] [US1] Write a failing test asserting a name-only navigation issues zero `list_movies` calls, in `agents/movie-assistant/tests/unit/test_navigator.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_navigator.py -k "no_movie_reads" -q` → 1 failing, `assert 50 == 0` (full pagination)
- [ ] T012 [US1] Skip the movie read entirely when a collection resolves and the text carries no movie reference, in `agents/movie-assistant/src/nodes/navigator.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_navigator.py -k "no_movie_reads" -q` → 0 failures
  - **Also run the touched suite**: `pnpm nx run movie-assistant:test -- tests/unit/test_navigator.py`
- [ ] T013 [P] [US1] Write a failing test asserting movie resolution uses a bounded `search_title` call per collection rather than keyset pagination, in `agents/movie-assistant/tests/unit/test_navigator.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_navigator.py -k "bounded_movie_lookup" -q` → 1 failing, `list_movies` called instead of `search_title`
- [ ] T014 [US1] Replace whole-collection pagination with a `search_title` lookup in `agents/movie-assistant/src/nodes/navigator.py`, following the `_owned_matches` pattern in `agents/movie-assistant/src/nodes/search.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_navigator.py -k "bounded_movie_lookup" -q` → 0 failures
- [ ] T015 [US1] Wire the navigator's `search_title` read in `agents/movie-assistant/src/runtime_nodes.py` (`_build_navigator_node`), removing the 200-page loop
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_runtime_nodes.py`
- [ ] T016 [P] [US1] Register the navigator's movie-resolution function in the adversarial catalogue at `agents/movie-assistant/tests/fixtures/adversarial.py` — bare-prefix collisions, same-title/different-year, case and punctuation
  - **Done when**: the new resolver appears in the catalogue. *A resolver not registered with the harness is not covered by it (013 Inc5 lesson).*
- [ ] T017 [P] [US1] Add a Hypothesis invariant for the navigator resolver ("a non-None result is always one of the inputs; an ambiguous input never silently resolves") in `agents/movie-assistant/tests/unit/test_resolvers_properties.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_resolvers_properties.py -k navigator -q` → ≥1 failing
- [ ] T018 [US1] Make the navigator resolver satisfy the invariants in `agents/movie-assistant/src/nodes/navigator.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_resolvers_properties.py -k navigator -q` → 0 failures
- [ ] T019 [P] [US1] Write a failing test asserting an unresolvable navigation target returns a reason plus collection choices — never the generic degrade text — in `agents/movie-assistant/tests/unit/test_graceful_degradation.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_graceful_degradation.py -k navigate_unresolvable -q` → 1 failing
- [ ] T020 [US1] Apply the RQ-1 fix and the specific not-found reply across `agents/movie-assistant/src/nodes/navigator.py` and whichever module T001 identified
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_graceful_degradation.py -k navigate_unresolvable -q` → 0 failures
- [ ] T021 [US1] Add spec-derived navigate transition rows to `agents/movie-assistant/tests/unit/test_state_machine_transitions.py` for US1-AC1…AC5, written from spec.md not from the code
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_state_machine_transitions.py -k navigate`
- [ ] T022 [US1] Add a large-library navigation integration test against real movie-mcp + mc-service in `agents/movie-assistant/tests/integration/test_resolution_realistic.py`
  - **GREEN**: `pnpm nx run movie-assistant:test:integration -- -k navigate_large_library` → 0 failures, turn completes under 5 s

**Checkpoint**: US1 independently functional — verify against the T003 fixture before moving on.

---

## Phase 4: User Story 2 — Answer an import sorting question once (Priority: P2) — PR A

**Goal**: An import question is answered once, recorded, and never re-asked; whitespace never blocks
a match; the member can always get out.

**Independent Test**: Import the T004 fixture, answer the sorting question by tapping and (in a
second run) by typing, and confirm the import proceeds and never re-asks.

- [ ] T023 [P] [US2] Write a failing test asserting the article prompt's `key` and option `title`s are trimmed, in `agents/movie-assistant/tests/unit/test_import_disambiguation.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_disambiguation.py -k trimmed_key -q` → 1 failing, key retains the trailing space
- [ ] T024 [US2] Trim the prompt key and option labels in `_article_prompt` and compare trimmed titles in `collect_import_disambiguations`, in `agents/movie-assistant/src/nodes/import_disambiguation.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_disambiguation.py -k trimmed_key -q` → 0 failures
  - **Also run the touched suite**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_disambiguation.py`
- [ ] T025 [P] [US2] Write the regression test for the reported loop — the trailing-whitespace title, answered by tap and by typing, resolves and is recorded — in `agents/movie-assistant/tests/unit/test_import_disambiguation_runtime.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_disambiguation_runtime.py -k three_billboards -q` → 2 failing, prompt re-issued instead of resolved
- [ ] T026 [US2] Key `resolutions["article"]` by trimmed title in `apply_import_pick`, in `agents/movie-assistant/src/nodes/import_disambiguation.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_disambiguation_runtime.py -k three_billboards -q` → 0 failures
- [ ] T027 [P] [US2] Write a failing test asserting an answered title is never re-asked across ten distinct ambiguous titles (SC-004), in `agents/movie-assistant/tests/unit/test_import_preview_resolutions.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_preview_resolutions.py -k never_reasked -q` → 1 failing
- [ ] T028 [US2] Ensure a recorded decision suppresses its prompt for the rest of the import, in `agents/movie-assistant/src/nodes/import_disambiguation.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_preview_resolutions.py -k never_reasked -q` → 0 failures
- [ ] T029 [P] [US2] Write failing tests for imported-value trimming — stored titles carry no surrounding whitespace, **and** a whitespace-only cell is still treated as blank on update — in `agents/movie-assistant/tests/unit/test_import_transform.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_transform.py -k trim -q` → 2 failing
- [ ] T030 [US2] Trim every imported text value at row-transform time in `agents/movie-assistant/src/nodes/import_resolvers.py`, preserving `_is_blank`'s existing behaviour
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_transform.py -k trim -q` → 0 failures
  - **Also run the touched suite**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_transform.py tests/unit/test_import_dedup.py`
- [ ] T031 [P] [US2] Write a failing test asserting a multi-word comma suffix ("Crouching Tiger, Hidden Dragon") raises no sorting question (FR-012), in `agents/movie-assistant/tests/unit/test_title_articles.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_title_articles.py -k multi_word_suffix -q` → 1 failing
- [ ] T032 [US2] Confirm/repair the multi-word-suffix branch of `normalize_title_article` in `agents/movie-assistant/src/nodes/import_resolvers.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_title_articles.py -k multi_word_suffix -q` → 0 failures
- [ ] T033 [P] [US2] Write a failing test asserting the question text states how many decisions remain (FR-008), in `agents/movie-assistant/tests/unit/test_import_disambiguation.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_disambiguation.py -k decisions_remaining -q` → 1 failing
- [ ] T034 [US2] Add `import_decisions_remaining` to `GraphState` in `agents/movie-assistant/src/graph.py` and render it in the prompt text in `agents/movie-assistant/src/nodes/import_disambiguation.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_disambiguation.py -k decisions_remaining -q` → 0 failures
- [ ] T035 [P] [US2] Write a failing test asserting two consecutive non-resolving replies produce a re-ask that includes a cancel-import control (FR-009/FR-010), in `agents/movie-assistant/tests/unit/test_import_disambiguation_runtime.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_disambiguation_runtime.py -k escape_after_two -q` → 1 failing, identical prompt re-issued forever
- [ ] T036 [US2] Add `import_unresolved_replies` to `GraphState` in `agents/movie-assistant/src/graph.py`, increment/reset it in the import node in `agents/movie-assistant/src/runtime_nodes.py`, and append the cancel control in `agents/movie-assistant/src/nodes/import_disambiguation.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_disambiguation_runtime.py -k escape_after_two -q` → 0 failures
- [ ] T037 [US2] Add spec-derived import transition rows for US2-AC1…AC6 to `agents/movie-assistant/tests/unit/test_state_machine_transitions.py`, written from spec.md
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_state_machine_transitions.py -k import`
- [ ] T038 [US2] Extend the import integration flow with the trailing-whitespace fixture in `agents/movie-assistant/tests/integration/test_import_flow.py`
  - **GREEN**: `pnpm nx run movie-assistant:test:integration -- -k import_trailing_whitespace` → 0 failures

**Checkpoint**: US2 independently functional. **US3 depends on this** — a large import cannot be
validated while the loop is live.

---

## Phase 5: User Story 3 — Import a large spreadsheet to completion (Priority: P3) — PR B

**Goal**: A 2,000-row import previews, shows progress, completes in under 10 minutes, and reports —
and an interrupted one keeps what it applied.

**Independent Test**: Upload `docs/test-data/large-import-sample.xlsx` ("Movies"), approve, and
confirm every eligible row lands. **Check the applied count against the eligible row count** — a
partial import that reports success is exactly the failure this story removes.

**⚠️ T049–T052 blocked by T002.**

- [ ] T039 [P] [US3] Write an equivalence test proving an indexed matcher returns identical results to the current `match_existing_movie` across the adversarial catalogue, in `agents/movie-assistant/tests/unit/test_import_dedup.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_dedup.py -k indexed_equivalence -q` → 1 failing, indexed matcher absent
- [ ] T040 [US3] Build a `(normalised_title, year)` index once per tab and use it in `_plan_writes`, reusing the comparison key from `agents/movie-assistant/src/text_match.py`, in `agents/movie-assistant/src/nodes/import_collection.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_dedup.py -k indexed_equivalence -q` → 0 failures
  - **Also run the touched suite**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_dedup.py tests/unit/test_import_preview.py`
- [ ] T041 [P] [US3] Write a failing test asserting a 5,001-row file is refused before any preview or write, with the limit stated (FR-015), in `agents/movie-assistant/tests/unit/test_import_runtime.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_runtime.py -k oversize -q` → 1 failing, preview built anyway
- [ ] T042 [US3] Add a named `MAX_IMPORT_ROWS = 5000` constant and the up-front refusal in `agents/movie-assistant/src/nodes/import_collection.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_runtime.py -k oversize -q` → 0 failures
- [ ] T043 [P] [US3] Write a failing test asserting bounded-concurrency apply preserves per-item idempotency keys and still applies `create_collection` first with its id threaded in, in `agents/movie-assistant/tests/unit/test_approval_gate.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_approval_gate.py -k concurrent_apply -q` → 1 failing, writes still strictly sequential
- [ ] T044 [US3] Apply `add`/`update` items with bounded concurrency after any `create_collection`, in `apply_proposal` in `agents/movie-assistant/src/nodes/approval_gate.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_approval_gate.py -k concurrent_apply -q` → 0 failures
  - **Also run the touched suite**: `pnpm nx run movie-assistant:test -- tests/unit/test_approval_gate.py tests/unit/test_import_apply.py tests/unit/test_organize_flow.py`
- [ ] T045 [P] [US3] Write a failing test asserting a re-run of a partially applied import creates no duplicates (FR-018), in `agents/movie-assistant/tests/unit/test_import_apply.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_apply.py -k rerun_no_duplicates -q` → 1 failing
- [ ] T046 [US3] Confirm 409 → `skipped_duplicate` classification survives concurrent apply, in `agents/movie-assistant/src/nodes/approval_gate.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_apply.py -k rerun_no_duplicates -q` → 0 failures
- [ ] T047 [P] [US3] Write a regression test pinning the bulk rate-limit exemption (`skip_rate_limit=True` on import reads and approval-gate writes, FR-019a — already satisfied today) in `agents/movie-assistant/tests/unit/test_agent_rate_limit.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_agent_rate_limit.py -k bulk_exemption -q` → 1 failing (test absent, not behaviour absent)
- [ ] T048 [US3] Add the assertion that a 2,000-item apply issues 2,000 writes with zero limiter rejections, in `agents/movie-assistant/tests/unit/test_agent_rate_limit.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_agent_rate_limit.py -k bulk_exemption -q` → 0 failures
- [ ] T049 [P] [US3] Write failing progress tests — advances at least every 10 s, exactly one progress surface per run, replaced by the report at the end (FR-014a/b, SC-008) — in `agents/movie-assistant/tests/unit/test_import_apply.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_apply.py -k progress -q` → 3 failing
- [ ] T050 [US3] Add `import_total` / `import_applied` / `import_run_id` to `GraphState` in `agents/movie-assistant/src/graph.py` and advance them in the apply loop in `agents/movie-assistant/src/nodes/approval_gate.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_apply.py -k progress -q` → 0 failures
- [ ] T051 [US3] Emit progress over the transport RQ-2 selected, in `agents/movie-assistant/src/runtime_nodes.py`, per [contracts/import-progress.md](./contracts/import-progress.md)
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_runtime_nodes.py -k progress`
- [ ] T052 [P] [US3] Build the in-place progress surface at `frontend/mcm-app/src/components/agent/import-progress.tsx` with a co-located test at `frontend/mcm-app/src/components/agent/import-progress.test.tsx`, and register it in `frontend/mcm-app/src/components/agent/assistant-dock.tsx`
  - **RED then GREEN**: `pnpm nx run mcm-app:test -- import-progress`
- [ ] T053 [P] [US3] Write a failing test asserting a throttled bulk import waits and says so rather than showing a stalled number (FR-019b), in `agents/movie-assistant/tests/unit/test_import_apply.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_apply.py -k waiting_note -q` → 1 failing
- [ ] T054 [US3] Set `state: "waiting"` with a note when a write is throttled, in `agents/movie-assistant/src/nodes/approval_gate.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_apply.py -k waiting_note -q` → 0 failures
- [ ] T055 [P] [US3] Write failing tests asserting an interrupted run leaves applied rows in place and reports on the next turn (FR-016a/b), in `agents/movie-assistant/tests/unit/test_import_runtime.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_runtime.py -k interrupted -q` → 2 failing
- [ ] T056 [US3] Detect an unfinished checkpointed run, report it, and clear it, in `agents/movie-assistant/src/runtime_nodes.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_runtime.py -k interrupted -q` → 0 failures
- [ ] T057 [US3] Add spec-derived import-run transition rows for US3-AC1…AC6 to `agents/movie-assistant/tests/unit/test_state_machine_transitions.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_state_machine_transitions.py -k import_run`
- [ ] T058 [US3] Add 2,000-row and 5,000-row scale integration tests against real MCP servers and mc-service in `agents/movie-assistant/tests/integration/test_import_flow.py`, asserting **applied count == eligible row count**
  - **GREEN**: `pnpm nx run movie-assistant:test:integration -- -k import_scale` → 0 failures, 2,000 rows under 10 min

**Checkpoint**: US3 independently functional.

---

## Phase 6: User Story 4 — Record how I own a movie (Priority: P4) — PR A

**Goal**: Answering "yes" to ownership collects media formats, ripped, and rip qualities before the
add — on every assistant-mediated add, with the option values published by the domain.

**Independent Test**: Add a movie twice — once from a web search card, once from a typed
`add <title> to <collection>` — and confirm identical behaviour and that the created movie carries
exactly the chosen values.

### 6a — mc-service publishes the accepted values ([RQ-4](./research.md#rq-4))

- [ ] T059 [P] [US4] Write failing inline unit tests for `MediaFormat::all()` — returns every variant, and every returned string deserialises back into a `MediaFormat` — in the `#[cfg(test)]` module at the bottom of `backend/mc-service/src/domain/movie.rs`
  - **RED**: `pnpm nx test mc-service -- media_format_all` → 2 failing, `all()` not found
- [ ] T060 [US4] Implement `MediaFormat::all()` as an **exhaustive match** (not a hand-written array) in `backend/mc-service/src/domain/movie.rs`, so adding a variant fails to compile until it is published
  - **GREEN**: `pnpm nx test mc-service -- media_format_all` → 0 failures
- [ ] T061 [P] [US4] Add `MovieMetadataDto { media_formats: Vec<String> }` to `backend/mc-service/src/application/dtos/movie_dto.rs` with a serialisation unit test
  - **RED then GREEN**: `pnpm nx test mc-service -- movie_metadata_dto`
- [ ] T062 [P] [US4] Write a failing HTTP integration test for `GET /api/v1/movie-metadata` — 200 body shape, 401 without a token, 403 without the app role — in `backend/mc-service/tests/integration/movies/movie_metadata_test.rs`, reusing the authenticated harness from features 045/046 in `backend/mc-service/tests/integration/common/auth.rs`
  - **RED**: `pnpm nx test:integration mc-service -- --test movie_metadata_test` → 3 failing, route returns 404
- [ ] T063 [US4] Implement the handler in `backend/mc-service/src/api/movie_metadata.rs` and register the route inside the existing `protected` router in `backend/mc-service/src/api/router.rs` — **no per-handler role guard**; role enforcement stays a layer
  - **GREEN**: `pnpm nx test:integration mc-service -- --test movie_metadata_test` → 0 failures
  - **Also run the touched suite**: `pnpm nx test mc-service`

### 6b — movie-mcp exposes it as a tool

- [ ] T064 [P] [US4] Write a failing unit test asserting `get_movie_metadata` returns the endpoint body unchanged, in `mcp-servers/movie-mcp/tests/unit/test_read_tools.py`
  - **RED**: `pnpm nx run movie-mcp:test -- -k movie_metadata -q` → 1 failing, tool not registered
- [ ] T065 [US4] Add the `get_movie_metadata` read tool — thin wrapper, `tool_span`, propagated JWT, no transformation — in `mcp-servers/movie-mcp/src/server.py`
  - **GREEN**: `pnpm nx run movie-mcp:test -- -k movie_metadata -q` → 0 failures
- [ ] T066 [P] [US4] Add an integration test against a **real** mc-service (never a mock) in `mcp-servers/movie-mcp/tests/integration/test_tools_errors.py`
  - **GREEN**: `pnpm nx run movie-mcp:test:integration -- -k movie_metadata` → 0 failures

### 6c — Agent consumes it

- [ ] T067 [P] [US4] Write a failing allowlist test asserting `get_movie_metadata` is permitted for the organizer and **denied for every other agent**, in `agents/movie-assistant/tests/unit/test_allowlist.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_allowlist.py -k movie_metadata -q` → 1 failing
- [ ] T068 [US4] Add `get_movie_metadata` to `_READ_TOOLS` and to the organizer allowlist only, in `agents/movie-assistant/src/tools/mcp_tools.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_allowlist.py -k movie_metadata -q` → 0 failures
- [ ] T069 [P] [US4] Write a failing test for the `render_multi_select` props builder against [contracts/render-multi-select.md](./contracts/render-multi-select.md), in `agents/movie-assistant/tests/unit/test_generative_ui_tools.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_generative_ui_tools.py -k multi_select -q` → 1 failing
- [ ] T070 [US4] Add `RENDER_MULTI_SELECT` and `render_multi_select()` to `agents/movie-assistant/src/tools/generative_ui_tools.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_generative_ui_tools.py -k multi_select -q` → 0 failures
- [ ] T071 [P] [US4] Register the multi-select reply resolver (`"Selected: DVD, Blu-Ray"`, `"Selected: none"`, typed `"dvd, blu-ray"`, `"DVD and Blu-Ray"`) in the adversarial catalogue at `agents/movie-assistant/tests/fixtures/adversarial.py` and add a Hypothesis invariant in `agents/movie-assistant/tests/unit/test_resolvers_properties.py`
  - **RED**: `pnpm nx run movie-assistant:test -- -k multi_select_resolver -q` → ≥2 failing. *A new resolver joins the catalogue the moment it is written.*
- [ ] T072 [US4] Implement the multi-select reply resolver in pure code, reusing the Phase 2 normalisation, in `agents/movie-assistant/src/nodes/organizer.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- -k multi_select_resolver -q` → 0 failures
- [ ] T073 [P] [US4] Write the spec-derived transition table for the ownership chain (`awaiting_ownership` → `awaiting_media` → `awaiting_ripped` → `awaiting_rip_quality` → proposal, plus the no/abandon branches for US4-AC1…AC8) in `agents/movie-assistant/tests/unit/test_state_machine_transitions.py`, written from spec.md
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_state_machine_transitions.py -k ownership -q` → ≥6 failing
- [ ] T074 [US4] Add `add_owned_media` / `add_ripped` / `add_rip_quality` / `add_multi_pending` to `GraphState` and to `_ADD_STATE_RESET` in `agents/movie-assistant/src/graph.py`, and extend the supervisor's stage guards for the three new stages
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_state_machine_transitions.py -k ownership -q` → 0 failures
- [ ] T075 [US4] Implement the stage chain in `agents/movie-assistant/src/nodes/organizer.py`, fetching the option values via `get_movie_metadata` — never a literal list
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer.py tests/unit/test_add_flow_graph.py`
- [ ] T076 [P] [US4] Write failing tests asserting `to_movie_payload` carries the chosen values, and emits empty `ownedMedia` when not owned and empty `ripQuality` when not ripped, in `agents/movie-assistant/tests/unit/test_proposals.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k ownership_fields -q` → 4 failing
- [ ] T077 [US4] Add `owned_media` / `ripped` / `rip_quality` parameters to `to_movie_payload` in `agents/movie-assistant/src/proposals.py`, replacing the hardcoded empty lists. **Do not re-implement mc-service's cross-field rules** — it already enforces them
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k ownership_fields -q` → 0 failures
- [ ] T078 [P] [US4] Write a failing test asserting a metadata-fetch failure **skips** the format question and still completes the add with no formats — never a guessed list — in `agents/movie-assistant/tests/unit/test_graceful_degradation.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_graceful_degradation.py -k metadata_unavailable -q` → 1 failing
- [ ] T079 [US4] Implement the skip-on-failure path in `agents/movie-assistant/src/nodes/organizer.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_graceful_degradation.py -k metadata_unavailable -q` → 0 failures
- [ ] T080 [US4] Add a process-level TTL cache for the metadata read in `agents/movie-assistant/src/runtime_nodes.py`, with a comment recording why cross-user sharing is safe here (domain enum, no user data) and must not be copied to user-scoped reads
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_runtime_nodes.py -k metadata_cache`
- [ ] T081 [P] [US4] Build the multi-select component at `frontend/mcm-app/src/components/agent/multi-select-options.tsx` with tests at `frontend/mcm-app/src/components/agent/multi-select-options.test.tsx` — toggle on/off, selection visible before confirm, confirming zero selections posts `Selected: none`, disabled after confirm, accessibility state per toggle
  - **RED then GREEN**: `pnpm nx run mcm-app:test -- multi-select-options`
- [ ] T082 [US4] Register `useRenderMultiSelectTool()` in `frontend/mcm-app/src/components/agent/assistant-dock.tsx`
  - **GREEN**: `pnpm nx run mcm-app:test -- assistant-dock`
- [ ] T083 [US4] Extend the web E2E for both entry paths (search card and typed add), zero-format confirm, abandon, and typed-list equivalence in `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts`
  - **GREEN**: `pnpm nx e2e mcm-app -- tests/e2e/web/agent-add-ownership.spec.ts`
- [ ] T084 [US4] Extend the mobile flow in `frontend/mcm-app/tests/e2e/mobile/agent-add-ownership.yaml` to cover the toggle list and confirm
  - **GREEN**: `maestro test frontend/mcm-app/tests/e2e/mobile/agent-add-ownership.yaml`
- [ ] T085 [US4] Add an end-to-end ownership integration test against real MCP servers and mc-service in `agents/movie-assistant/tests/integration/test_add_flow.py`, asserting the persisted movie carries exactly the chosen values
  - **GREEN**: `pnpm nx run movie-assistant:test:integration -- -k ownership_details` → 0 failures

**Checkpoint**: US4 independently functional across all three layers.

---

## Phase 7: User Story 5 — Back out of a web search result (Priority: P5) — PR A

**Goal**: The web search card offers a cancel action that ends the search and writes nothing.

**Independent Test**: Search the web, pick a result, cancel, and confirm the search ends with an
acknowledgement and zero write tool calls.

- [ ] T086 [P] [US5] Write a failing test asserting `_web_card` emits `cancelable: true` and other card emitters do not, in `agents/movie-assistant/tests/unit/test_search.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_search.py -k cancelable -q` → 2 failing
- [ ] T087 [US5] Add the optional `cancelable` prop to `render_movie_card` in `agents/movie-assistant/src/tools/generative_ui_tools.py` and set it in `_web_card_props` in `agents/movie-assistant/src/nodes/search.py`
  - **GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_search.py -k cancelable -q` → 0 failures
- [ ] T088 [P] [US5] Write a failing test asserting cancelling produces an acknowledgement and **zero** write tool calls, in `agents/movie-assistant/tests/unit/test_search.py`
  - **RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_search.py -k cancel_no_writes -q` → 1 failing
- [ ] T089 [US5] Add the Cancel action to `frontend/mcm-app/src/components/agent/render-movie-card.tsx` — posts the canonical exit value through the same send path as Add, disables both actions after use — with tests in `frontend/mcm-app/src/components/agent/render-movie-card.test.tsx`
  - **GREEN**: `pnpm nx run mcm-app:test -- render-movie-card`
- [ ] T090 [P] [US5] Extend the web E2E in `frontend/mcm-app/tests/e2e/web/agent-search.spec.ts` — cancel ends the search, nothing is added, the next message is fresh
  - **GREEN**: `pnpm nx e2e mcm-app -- tests/e2e/web/agent-search.spec.ts`
- [ ] T091 [P] [US5] Extend the mobile flow in `frontend/mcm-app/tests/e2e/mobile/agent-search.yaml` to cover the cancel action
  - **GREEN**: `maestro test frontend/mcm-app/tests/e2e/mobile/agent-search.yaml`

**Checkpoint**: All five stories independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T092 Run the golden-pair regression suite and confirm it passes **without re-recording**: `LLM_CASSETTE_MODE=replay pnpm nx run movie-assistant:test:golden`
  - **Done when**: 0 failures with cassettes unchanged. *If a re-record is needed, something changed that this plan says should not have — investigate before re-recording.*
- [ ] T093 [P] Run the SC-004 token-leak scan: `pnpm nx run movie-assistant:test -- -m leak_scan`
  - **Done when**: no token appears in state, logs, or traces — including the new progress and ownership state fields.
- [ ] T094 [P] Lint all four touched projects — `pnpm nx run movie-assistant:lint`, `pnpm nx run movie-mcp:lint`, `pnpm nx lint mc-service`, `pnpm nx run mcm-app:lint`
  - **Done when**: ruff + mypy clean, clippy clean, ESLint clean.
- [ ] T095 [P] Confirm ≥70% line coverage on new code across `agents/movie-assistant/`, `backend/mc-service/`, and the new client components
- [ ] T096 [P] Record the durable learnings in `docs/runbooks/` — the navigator pagination-vs-rate-limit interaction, and the whitespace option-matching failure — then let OpenWiki regenerate; **do not hand-edit `openwiki/` pages**
  - **Done when**: `node scripts/check-openwiki-governance.mjs` passes.
- [ ] T097 Rebuild and redeploy the agent gateway, movie-mcp, and mc-service, then confirm the running containers carry the change before any E2E run
  - **Done when**: a probe against each container shows the new behaviour. *An E2E against a stale container validates old code (013 Inc5 lesson).*
- [ ] T098 Run the full web E2E regression: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`
- [ ] T099 Run the mobile E2E regression: `pnpm nx e2e:mobile mcm-app` (flows require a logged-out start between runs)
- [ ] T100 Walk [quickstart.md](./quickstart.md) end to end, including the RQ-4 drift check (add a `MediaFormat` variant locally and confirm the build fails until it is published)
- [ ] T101 Run `rtk gain` last and confirm >80% token compression

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1: navigate to a collection by name | `agent-navigate-collection.spec.ts` | `agent-navigate-collection.yaml` | ✅ |
| US1-AC3: navigate to a movie by name | `agent-navigate-movie.spec.ts` | `agent-navigate-movie.yaml` | ✅ |
| US2-AC1/AC2: answer a sorting question by tap and by typing | `agent-import-disambiguate.spec.ts` | N/A — spreadsheet upload is a web-first flow; `request_import_file` renders a file picker with no mobile counterpart | N/A |
| US3-AC2: large import progress and report | `agent-import.spec.ts` | N/A — same web-first upload constraint as US2 | N/A |
| US4-AC2/AC3: media-format toggle list and confirm | `agent-add-ownership.spec.ts` | `agent-add-ownership.yaml` | ✅ |
| US4-AC5: rip-quality toggle list | `agent-add-ownership.spec.ts` | `agent-add-ownership.yaml` | ✅ |
| US5-AC2: cancel from the web search card | `agent-search.spec.ts` | `agent-search.yaml` | ✅ |

No `❌ Gap` rows. The two `N/A` rows are justified by the upload affordance being web-first, which is
documented in `agents/movie-assistant/src/tools/generative_ui_tools.py`.

---

## Dependencies & Execution Order

### Delivery is by PR group, not by priority

| PR | Phases | Tasks |
|---|---|---|
| **A — ready now** | 1 (partial), 2, 4 (US2), 6 (US4), 7 (US5) | T003–T010, T023–T038, T059–T091 |
| **B — research-gated** | 1 (partial), 3 (US1), 5 (US3) | T001, T002, T011–T022, T039–T058 |

**PR A merges before PR B** — US3 cannot be validated until US2's loop fix has landed.

### Blocking edges

- **T001 → all of Phase 3.** Do not code US1's error-message tasks against a guessed root cause.
- **T002 → T049–T052.** If the state channel is unavailable, FR-014a goes back to the product owner.
- **T008/T009 (shared normalisation) → US2 and US4.** Both depend on it; it is fixed once.
- **T060 → T063 → T065 → T068 → T075.** The Story 4 layer chain: domain → endpoint → tool →
  allowlist → organizer. All in one PR, but strictly ordered within it.
- **T097 → T098/T099.** Redeploy before any E2E, or the run validates stale code.

### Within each story

Tests written and verified RED → implementation → GREEN → touched-suite regression.

### Parallel opportunities

- Phase 1: T003, T004, T005, T006 in parallel (T001 and T002 are independent spikes and can also run
  alongside).
- Phase 6: T059/T061 (mc-service) ∥ T064 (movie-mcp test scaffolding) ∥ T081 (client component) —
  three projects, no shared files. The chain only serialises at T063 → T065 → T068.
- Phase 7: T086 and T088 in parallel; T090 and T091 in parallel.
- Phase 8: T093, T094, T095, T096 in parallel.

---

## Parallel Example: Phase 6 (User Story 4)

```bash
# Three projects, disjoint files — start together:
Task: "T059 MediaFormat::all() unit tests in backend/mc-service/src/domain/movie.rs"
Task: "T064 get_movie_metadata unit test in mcp-servers/movie-mcp/tests/unit/test_read_tools.py"
Task: "T081 multi-select component in frontend/mcm-app/src/components/agent/multi-select-options.tsx"

# Then the layer chain serialises:
# T063 (endpoint) → T065 (tool) → T068 (allowlist) → T075 (organizer chain)
```

---

## Implementation Strategy

### First increment — PR A

The conventional MVP is User Story 1, but US1 is blocked on a diagnosis (T001). The first shippable
increment is therefore **PR A**: the import loop fix (US2), the ownership follow-ups (US4), and the
search cancel (US5).

1. Phase 1 fixtures (T003–T006)
2. Phase 2 shared normalisation (T007–T010)
3. Phase 4 (US2) → **stop and validate** — this alone makes spreadsheet import usable again
4. Phase 6 (US4) and Phase 7 (US5)
5. Phase 8 gates, then open PR A

### Second increment — PR B

1. T001 and T002 answered first — both are genuine spikes, not formalities
2. Phase 3 (US1), then Phase 5 (US3)
3. Phase 8 gates, then open PR B

### Notes

- `[P]` = different files, no dependencies on incomplete tasks
- Commit after each task or logical pair
- Run `pnpm nx preflight` before pushing either branch — it catches offline-knowable failures without
  spending a runner slot

---

## Completion Checklist

Before marking `047-movie-assistant-enhancements` complete, verify all success criteria from
[spec.md](./spec.md):

- [ ] **SC-001**: 100% of collection-name navigations open that collection, incl. 10,000-movie libraries
- [ ] **SC-002**: navigation answers in under 5 s at p95
- [ ] **SC-003**: the generic reply no longer appears for a resolvable navigation
- [ ] **SC-004**: zero repeat questions across ≥10 distinct ambiguous titles
- [ ] **SC-005**: the question phase completes in one exchange per distinct ambiguous title
- [ ] **SC-006**: a 2,000-row import completes in under 10 minutes with every eligible row applied
- [ ] **SC-007**: a 5,000-row import completes successfully
- [ ] **SC-008**: progress advances at least every 10 s, adding no more than one line to the conversation
- [ ] **SC-009**: every import ends with a report
- [ ] **SC-010**: ownership details recorded entirely in-conversation, halving the steps
- [ ] **SC-011**: 100% of movies created via the ownership flow carry exactly the chosen values
- [ ] **SC-012**: a web search can be abandoned from the card in one action, on web and mobile
- [ ] Platform parity table complete — no ❌ gaps remain
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx run movie-assistant:test` — unit tests pass (≥70% coverage), incl. the leak scan
- [ ] `pnpm nx run movie-assistant:test:integration` — integration passes against real MCP + mc-service
- [ ] `LLM_CASSETTE_MODE=replay pnpm nx run movie-assistant:test:golden` — passes **without re-record**
- [ ] `pnpm nx test mc-service` / `pnpm nx test:integration mc-service` — pass
- [ ] `pnpm nx run movie-mcp:test` / `:test:integration` — pass
- [ ] `pnpm nx run mcm-app:test` — component tests pass
- [ ] All four projects lint clean
- [ ] `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` — web E2E passes
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes
- [ ] PR head is a **real branch** (`git push origin HEAD:<branch>` then `POST …/pulls`) — never an AGit push
- [ ] `rtk gain` — >80% token compression confirmed (run last)
