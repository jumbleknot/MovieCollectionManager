---

description: "Task list for 059 — assistant add fidelity"
---

# Tasks: Assistant add fidelity — the real rating, and the children's question

**Input**: Design documents from `/specs/059-assistant-add-fidelity/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: REQUIRED. This repository's test-authoring convention applies in full — every test task
carries a **Verify RED**, every implementation task a **Verify GREEN**. The one exception is marked
explicitly: T005 is a *characterization guard* that must pass before and after.

> **A Verify RED showing 0 failures is a failed task, not a passed one.** Check the *collected*
> count as well as the failure count — a `-k` selector that matches nothing also reports no
> failures, and this repository has been bitten by exactly that.

> **A skip is not a pass.** The web-api-mcp integration suite skips clean when `TMDB_API_KEY` is
> absent. Check the skip count is 0 before believing any green from it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 (item #163, rating) or US2 (item #162, children's question)

## Already done (during planning — do not redo)

These landed in `517f8a2` because the alternative was a hand-run verification, which the spec now
forbids (FR-020a). Listed so no one repeats them:

- `.devcontainer/init-firewall.sh` — `api.themoviedb.org` allowlisted for the dev-container shell
- `.devcontainer/verify/verify-firewall-allowlist.sh` — asserts TMDB reachable, default-deny intact
- `docs/runbooks/devcontainer.md` — records why the old "do NOT allowlist TMDB" is superseded

---

## Phase 1: Setup (baseline)

**Purpose**: know the starting state, so a later red is attributable to this feature.

- [ ] T001 Record the pre-change baseline in this file: run `pnpm nx run web-api-mcp:test`, `pnpm nx run web-api-mcp:test:integration`, `pnpm nx run movie-assistant:test`, `pnpm nx run movie-assistant:test:integration` and note passed/failed/skipped counts for each
  - **Expected**: all green; web-api-mcp integration = 5 passed, **0 skipped** (a skip means `TMDB_API_KEY` is missing — fix that before starting, per [quickstart.md](./quickstart.md) §2)
  - The movie-assistant integration baseline matters for T024: four of its tests assert the add chain's first stage and will legitimately go red during US2.
  - **Measured**: _(fill in)_

- [ ] T002 [P] Confirm TMDB egress and default-deny in the current container: `bash .devcontainer/verify/verify-firewall-allowlist.sh`
  - **Expected**: PASS, including `reachable: TMDB (api.themoviedb.org)` and `arbitrary host refused`
  - If TMDB is unreachable, the ipset is stale — re-run `sudo env FORGE_REGISTRY_HOST="$FORGE_REGISTRY_HOST" /bin/bash .devcontainer/init-firewall.sh`. Do **not** widen the allowlist further.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: make the live check gate a merge in CI rather than only locally (FR-020a), and pin
today's behaviour of the callers this feature must not disturb.

- [ ] T003 Add skip-escalation to `mcp-servers/web-api-mcp/tests/integration/conftest.py` so a missing `TMDB_API_KEY` FAILS when `MCM_REQUIRE_LIVE_STACK=1`, mirroring `mcp-servers/movie-mcp/tests/integration/conftest.py:67-98`
  - **This comes before enrollment, not after.** Enrolling a suite that still skips clean on an absent key is precisely the window in which CI reports green for a suite that ran nothing.
  - **Verify RED**: `cd mcp-servers/web-api-mcp && MCM_REQUIRE_LIVE_STACK=1 TMDB_API_KEY= uv run pytest tests/integration -q`
  - **Expected RED**: `skipped`, exit 0 — the failure mode this task removes
  - **Measured RED**: _(fill in)_
  - **Verify GREEN**: same command → non-zero exit with the escalation message; and with the key present → 5 passed, 0 skipped

- [ ] T004 Enroll `web-api-mcp` in the CI integration step in `.forgejo/workflows/app-ci.yml`, alongside movie-mcp and spreadsheet-mcp, passing `TMDB_API_KEY` from the existing job-level env (line ~332) and setting `MCM_REQUIRE_LIVE_STACK: '1'`
  - Replace the "web-api-mcp is deliberately NOT enrolled (048 FR-013)" comment block (lines ~572-578) with the current position: egress from the shell is now allowlisted in the dev container and the credential question is answered by the existing CI secret. Do not delete the comment — 048's reasoning must remain readable next to its reversal.
  - Depends on T003: the `MCM_REQUIRE_LIVE_STACK` flag does nothing until the escalation exists.
  - **Verify**: `pnpm nx run web-api-mcp:test:integration` locally; CI is verified by T027, not by this edit.

- [ ] T005 [P] Characterization guard for the callers that must not change, in `agents/movie-assistant/tests/unit/test_import_transform.py` and `agents/movie-assistant/tests/unit/test_proposals.py`: the spreadsheet-import payload still carries `childrens: false` and its rating still comes from the spreadsheet column; `compose_movie_payload` (the organize/update path) still injects neither field (FR-007, FR-015, SC-007)
  - **This is a guard, not a RED/GREEN pair.** It must pass **before** implementation and still pass after. If it fails before, the premise of FR-007 is wrong and the plan needs revisiting — that is the finding, not a task failure.
  - **Verify**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_transform.py tests/unit/test_proposals.py -q` → 0 failures now, and again after T012 and T021

---

## Phase 3: User Story 1 — the rating on an added movie is the film's real rating (P1, item #163)

**Goal**: every assistant-mediated add records the film's actual US certification, or nothing at all.

**Independent test**: add a certified film and an uncertified film through the assistant; the first
carries its real rating, the second carries none and still succeeds. Needs nothing from US2.

### Tests for US1 (write first — these MUST fail before T011)

- [ ] T006 [P] [US1] Unit tests for certification extraction in `mcp-servers/web-api-mcp/tests/unit/test_certification.py` — one case per row of [contracts/web-api-mcp-get-movie-details.md](./contracts/web-api-mcp-get-movie-details.md), built from the measured shapes: `PG,PG` → `PG`; `R,R,""` → `R`; `NR,NR` → `NR`; `"",PG-13,PG-13` → `PG-13`; seven `""` then `NR` → `NR`; `""` only → `None`; no US block → `None`; `TV-14` → `None`; non-US blocks only → `None`
  - **Verify RED**: `pnpm nx run web-api-mcp:test -- tests/unit/test_certification.py -q`
  - **Expected RED**: collection error — the extractor does not exist yet
  - **Measured RED**: _(fill in)_

- [ ] T007 [US1] Unit test in `mcp-servers/web-api-mcp/tests/unit/test_certification.py` that `get_movie_details` requests `append_to_response=release_dates` and makes exactly **one** HTTP call, using an httpx `MockTransport` that records requests (FR-002a)
  - Same file as T006 — sequence, do not parallelize.
  - **Verify RED**: same command, `-k append_to_response`
  - **Expected RED**: 1 failed — the request carries no such parameter
  - **Measured RED**: _(fill in)_

- [ ] T008 [P] [US1] Extend `mcp-servers/web-api-mcp/tests/integration/test_tmdb.py` with real-TMDB assertions on the stable films only: 412117 → `PG` (SC-001), 603 → `R`, 396535 → `NR`, 152747 → `PG-13` (the leading-empty case)
  - Do **not** pin the low-traffic `None` films here — their TMDB records are publicly editable and would drift; those cases live in T006.
  - **Verify RED**: `pnpm nx run web-api-mcp:test:integration -- -k certification -q`
  - **Expected RED**: 4 failed — `KeyError`/`None`, the candidate has no `rated` field
  - **Measured RED**: _(fill in)_

- [ ] T009 [P] [US1] Unit tests in `agents/movie-assistant/tests/unit/test_proposals.py` that `to_movie_payload` emits the candidate's rating, and `"rated": None` — **key present** — when the candidate has none (FR-004, research R5)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k rated -q`
  - **Expected RED**: ≥2 failed — the payload contains the literal `"NR"`
  - **Measured RED**: _(fill in)_

### Implementation for US1

- [ ] T010 [US1] Add `rated: str | None = None` to `EnrichedMovieCandidate` in `agents/movie-assistant/src/proposals.py`
  - Defaulted, so the disambiguation path that builds candidates from search results is unaffected.

- [ ] T011 [US1] Implement the certification extraction in `mcp-servers/web-api-mcp/src/tools.py`: add `append_to_response=release_dates` to the existing `/movie/{id}` request, and a pure helper that walks `release_dates.results` → the US block → the **first non-empty** certification, validated against `{G, PG, PG-13, R, NC-17, NR, Unrated}`, else `None`. Return it as `rated` on the candidate.
  - Keep the helper pure and separately importable — it is what T006 tests.
  - **No renaming.** TMDB publishes `PG-13`/`NC-17` and the product stores `PG-13`/`NC-17` (research R1). Item #163's AC3 asks for `PG13`/`NC17`; implementing that literally sends a value mc-service rejects.
  - **Verify GREEN**: `pnpm nx run web-api-mcp:test -- tests/unit/test_certification.py -q` → 0 failures, ≥10 passed
  - **Also run**: `pnpm nx run web-api-mcp:test -q` → previously passing tests still pass

- [ ] T012 [US1] Wire the rating through `to_movie_payload` in `agents/movie-assistant/src/proposals.py` — replace the literal `"rated": "NR"` with the candidate's value, defaulting to `None`
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -q` → 0 failures
  - **Also run**: T005's guard, plus `pnpm nx run movie-assistant:test -q` → no regression in `test_approval_gate.py` / `test_import_apply.py`

- [ ] T013 [US1] Verify the live tier: `pnpm nx run web-api-mcp:test:integration -q`
  - **Expected GREEN**: 9 passed, **0 skipped**
  - **Measured GREEN**: _(fill in)_
  - If the shape differs from [contracts/web-api-mcp-get-movie-details.md](./contracts/web-api-mcp-get-movie-details.md), fix the contract **and** the T006 fixtures — never just the failing assertion.

- [ ] T014 [P] [US1] Add two assertions to `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts` (`@model-decision`): "The Secret Life of Pets 2" (2019) added through the assistant has `rated` = `PG` (SC-001), and a film with no US certification is added successfully with a blank rating (US1-AC4, SC-003) — proving mc-service accepts `"rated": null` on the real write path, not just in the payload
  - **Verify**: `node scripts/agent-e2e.mjs agent-add-ownership`

**Checkpoint**: US1 is independently shippable here — merge-blocking unit + live coverage, and the
reported defect is fixed end to end.

---

## Phase 4: User Story 2 — every add records whether it is a children's movie (P2, item #162)

**Goal**: the member is asked, once, before the ownership question, and their answer is what gets
written.

**Independent test**: add a movie answering the new question both ways, and with both ownership
answers; the created movie carries exactly what was chosen. Needs nothing from US1.

### Tests for US2 (write first — these MUST fail before T020)

- [ ] T015 [P] [US2] Unit tests for the stage machine in `agents/movie-assistant/tests/unit/test_organizer_add_chain.py`: the chain's first question is `awaiting_childrens`; `yes`/`no` advances to `awaiting_ownership` retaining the answer; an unparseable reply re-asks without advancing; abandonment adds nothing; a not-owned add still carries the answer (US2-AC5)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -q`
  - **Expected RED**: ≥5 failed — the chain enters `awaiting_ownership` directly
  - **Measured RED**: _(fill in)_

- [ ] T016 [US2] Unit test in `agents/movie-assistant/tests/unit/test_organizer_add_chain.py` that `awaiting_childrens` is registered in **both** `graph._OWNERSHIP_STAGES` and `curator._OWNERSHIP_STAGES`, and **not** in `_MULTI_SELECT_STAGES` (research R6)
  - This is a guard, not a tautology: each omission fails differently at runtime and none of them fails loudly. Same file as T015 — sequence.
  - **Verify RED**: same command, `-k stages`
  - **Expected RED**: 2 failed — the stage is absent from both sets
  - **Measured RED**: _(fill in)_

- [ ] T017 [P] [US2] Unit tests in `agents/movie-assistant/tests/unit/test_proposals.py` that `to_movie_payload(..., childrens=True)` emits `"childrens": true`, that it defaults to `False`, and that `build_add_proposal` carries the answer onto the `ProposalItem` (FR-010, FR-015)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k childrens -q`
  - **Expected RED**: ≥3 failed — the parameter does not exist
  - **Measured RED**: _(fill in)_

- [ ] T018 [P] [US2] Unit test in `agents/movie-assistant/tests/unit/test_approval_gate.py` that an approval arriving on a later turn applies the checkpointed children's answer (research R9)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_approval_gate.py -k childrens -q`
  - **Expected RED**: 1 failed
  - **Measured RED**: _(fill in)_

- [ ] T019 [P] [US2] Parity test in `agents/movie-assistant/tests/unit/test_proposals.py` that the add-time answer and the conversational update path set the **same field**: `to_movie_payload(..., childrens=True)` and `compose_movie_payload` with a `childrens` change both produce a payload whose `childrens` is `true` (FR-016)
  - FR-016 exists to stop two paths drifting; without this test nothing notices when they do. `compose_movie_payload` already accepts the flag (`proposals.py:255`) — this asserts the add path joins it rather than inventing a second vocabulary.
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k parity -q`
  - **Expected RED**: 1 failed — the add path has no `childrens` parameter yet
  - **Measured RED**: _(fill in)_

### Implementation for US2

- [ ] T020 [US2] Add `childrens: bool | None = None` to `ProposalItem` and thread it through `_item` and `build_add_proposal` in `agents/movie-assistant/src/proposals.py`; add a `childrens: bool = False` keyword to `to_movie_payload` replacing the hardcoded `"childrens": False`
  - Leave `diff` untouched — FR-018a keeps the approval text unchanged.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -q` → 0 failures

- [ ] T021 [US2] Register `awaiting_childrens` in `agents/movie-assistant/src/graph.py` (`_OWNERSHIP_STAGES`, line ~166) and in the local mirror in `agents/movie-assistant/src/nodes/curator.py` (line ~122). Do **not** add it to `_MULTI_SELECT_STAGES`.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -k stages -q` → 0 failures

- [ ] T022 [US2] Add `_ask_childrens` to `agents/movie-assistant/src/nodes/organizer.py` mirroring `_ask_ownership` (Yes/No via `render_selection`, tool id `add-childrens`), make it the stage the chain enters instead of `awaiting_ownership` (line ~280), and add the `awaiting_childrens` branch to the transition block (line ~482) which stores the answer and calls `_ask_ownership`. Reuse `_parse_ownership`; re-ask on `None`.
  - The collection question keeps its position ahead of this one (FR-008a) — the entry point that changes is the one reached *after* `add_target` is resolved.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -q` → 0 failures, ≥7 passed

- [ ] T023 [US2] Thread the answer through the proposal build (`_build_ownership_proposal`, `organizer.py:~390`) and the apply path (`approval_gate.py:~212`) so it reaches `to_movie_payload`
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -q` → 0 failures across the whole unit suite; T005's guard still green

- [ ] T024 [US2] Update the movie-assistant **integration** tests that assert the chain's first pause — `tests/integration/test_add_flow.py:143` and `:352`, `tests/integration/test_gateway_add_e2e.py:202`, `tests/integration/test_metadata_unavailable_live.py:108` — all four assert `add_stage == "awaiting_ownership"` immediately after the add turn, which is now `awaiting_childrens`
  - This tier is not optional and not covered by the Playwright work in T025: it is the tier that proves the chain across a real graph run. FR-021's rule ("coverage that walks a fixed sequence must be updated") applies here first.
  - Add one turn to each affected flow rather than weakening the assertion — a test relaxed to "some stage" stops proving the ordering the story is about.
  - **Verify RED**: `pnpm nx run movie-assistant:test:integration -q` (before the update, after T022)
  - **Expected RED**: 4 failed — `assert 'awaiting_childrens' == 'awaiting_ownership'`
  - **Measured RED**: _(fill in)_
  - **Verify GREEN**: same command → back to the T001 baseline counts

- [ ] T025 [US2] Update the E2E specs that walk the old turn sequence — 5 tests in `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts` (lines ~70, 155, 215, 261, 303) and 1 in `frontend/mcm-app/tests/e2e/web/agent-add-external-link.spec.ts` (line ~78) — to answer the children's question first, and add new coverage: the question appears before ownership from both a card add and a typed add; abandoning at it adds nothing; and it is answerable **by tapping only and by typing only**, both producing the same movie (FR-012, SC-005)
  - The tap/type assertion belongs on the new question specifically — the existing "typed answers reach the same result as tapping" test (line ~261) covers the 047 questions, and updating it to pass is not the same as asserting the new one.
  - **If these pass unmodified, the question is not being asked** — that is a failure, not a convenience.
  - **Verify**: `node scripts/agent-e2e.mjs agent-add-ownership` and `node scripts/agent-e2e.mjs agent-add-external-link`

**Checkpoint**: both stories complete and independently verifiable.

---

## Phase 5: Polish & cross-cutting

- [ ] T026 [P] Run both linters — `pnpm nx run web-api-mcp:lint` and `pnpm nx run movie-assistant:lint` (ruff + mypy)
  - Derive checks from the diff, not from memory: a Python change means `lint` as well as `test`.

- [ ] T027 Verify in CI that the enrolled integration step actually ran web-api-mcp — read the run log via `node scripts/ci-status.mjs`, confirm a non-zero collected count for `tests/integration` and a skip count of 0
  - A workflow edit is not evidence that a step ran. If egress from the runner turns out to be blocked, this is where it surfaces — fix the runner path or revert T004 and record why, but do not silence it.

- [ ] T028 [P] Manual confirmation per [quickstart.md](./quickstart.md) §4 — add "The Secret Life of Pets 2" through the assistant on the local stack, answer the children's question, and read the detail screen: Rated `PG`, and the children's flag as answered

- [ ] T029 [P] Comment on backlog items #163 and #162 recording what their acceptance criteria got wrong — the `PG-13` → `PG13` rename that exists at no boundary (item #163 AC3, research R1) and `build_add_movie_payload`, which is `to_movie_payload` (both items, research R2)
  - `node scripts/backlog.mjs comment 163 --body-file …` / `… 162 …`. Correct the criteria before closing, not after.

- [ ] T030 Close items #163 and #162 only once their criteria are met and verified — `node scripts/backlog.mjs update 163 --state closed`
  - Not when the PR merges. Verify first, then close.

- [ ] T031 [P] Record the reusable learning in the knowledge base: the dev-container firewall now separates the FORWARD chain (runtime, never needed TMDB) from the OUTPUT chain (test runners, do), and web-api-mcp's integration tier is enrolled in CI — update `openwiki/invariants/testing-tiers.md` and/or `openwiki/runbooks/*` per [openwiki/INSTRUCTIONS.md](../../openwiki/INSTRUCTIONS.md) (write into the cited source, never into CLAUDE.md)

---

## Dependencies

```text
Phase 1 (T001-T002)  →  everything
Phase 2 (T003→T004)  →  T013, T027      (US1's live gate; nothing in US2)
Phase 2 (T005)       →  re-run after T012 and T023
US1 (T006-T014)      ──┐
US2 (T015-T025)      ──┴→  Phase 5
```

- **T003 before T004.** The escalation must exist before the suite is enrolled: `MCM_REQUIRE_LIVE_STACK` does nothing without it, so enrolling first opens a window where a missing key skips clean and CI reports green for a suite that ran nothing.
- **US1 and US2 are independent.** They touch the same function (`to_movie_payload`) on different
  lines and the same E2E file in different tests — sequence them to avoid a conflict, but either can
  ship without the other.
- Within US1: T006/T008/T009 in parallel (T007 follows T006, same file) → T010 → T011 → T012 → T013 → T014.
- Within US2: T015/T017/T018/T019 in parallel (T016 follows T015, same file) → T020 → T021 → T022 → T023 → T024 → T025.
- T024 must follow T022: the integration tests cannot go red for the right reason until the chain actually changes.

## Parallel execution examples

```bash
# US1 test authoring — three files, no shared state
T006 mcp-servers/web-api-mcp/tests/unit/test_certification.py     # T007 follows, same file
T008 mcp-servers/web-api-mcp/tests/integration/test_tmdb.py
T009 agents/movie-assistant/tests/unit/test_proposals.py

# US2 test authoring
T015 agents/movie-assistant/tests/unit/test_organizer_add_chain.py  # T016 follows, same file
T017 + T019 agents/movie-assistant/tests/unit/test_proposals.py     # same file: sequence
T018 agents/movie-assistant/tests/unit/test_approval_gate.py
```

## Implementation strategy

**MVP = User Story 1.** It is the `priority/p2` bug, it puts false data in members' libraries on
every add, and it is fully proven by merge-blocking tiers. Shipping it alone is a coherent release.

**Then User Story 2**, which is additive and carries no data-correctness urgency.

**Do not defer Phase 2.** T003/T004 are what make the live check a gate rather than a habit — the
spec requires it (FR-020a). T005 is cheap and pays for itself the moment someone edits
`to_movie_payload` without noticing that three other callers share it.
