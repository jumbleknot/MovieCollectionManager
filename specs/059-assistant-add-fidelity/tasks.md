---

description: "Task list for 059 — assistant add fidelity"
---

# Tasks: Assistant add fidelity — the real rating, and the children's question

**Input**: Design documents from `/specs/059-assistant-add-fidelity/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: REQUIRED. This repository's test-authoring convention applies in full — every test task
carries a **Verify RED**, every implementation task a **Verify GREEN**.

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

- [ ] T001 Record the pre-change baseline in this file: run `pnpm nx run web-api-mcp:test`, `pnpm nx run web-api-mcp:test:integration`, `pnpm nx run movie-assistant:test` and note passed/failed/skipped counts for each
  - **Expected**: all green; web-api-mcp integration = 5 passed, **0 skipped** (a skip means `TMDB_API_KEY` is missing — fix that before starting, per [quickstart.md](./quickstart.md) §2)
  - **Measured**: _(fill in)_

- [ ] T002 [P] Confirm TMDB egress and default-deny in the current container: `bash .devcontainer/verify/verify-firewall-allowlist.sh`
  - **Expected**: PASS, including `reachable: TMDB (api.themoviedb.org)` and `arbitrary host refused`
  - If TMDB is unreachable, the ipset is stale — re-run `sudo env FORGE_REGISTRY_HOST="$FORGE_REGISTRY_HOST" /bin/bash .devcontainer/init-firewall.sh`. Do **not** widen the allowlist further.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: make the live check gate a merge in CI, not only locally (FR-020a). Blocks nothing in
US2, but US1's live proof is not complete without it.

- [ ] T003 Enroll `web-api-mcp` in the CI integration step in `.forgejo/workflows/app-ci.yml`, alongside movie-mcp and spreadsheet-mcp, passing `TMDB_API_KEY` from the existing job-level env (line ~332)
  - Replace the "web-api-mcp is deliberately NOT enrolled (048 FR-013)" comment block (lines ~572-578) with the current position: egress from the shell is now allowlisted in the dev container and the credential question is answered by the existing CI secret. Do not delete the comment — 048's reasoning must remain readable next to its reversal.
  - **Verify**: `pnpm nx run web-api-mcp:test:integration` locally first; CI is verified by T024, not by this edit.

- [ ] T004 Add skip-escalation to `mcp-servers/web-api-mcp/tests/integration/conftest.py` so a missing `TMDB_API_KEY` FAILS when `MCM_REQUIRE_LIVE_STACK=1`, mirroring `mcp-servers/movie-mcp/tests/integration/conftest.py:67-98`
  - **Verify RED**: `cd mcp-servers/web-api-mcp && MCM_REQUIRE_LIVE_STACK=1 TMDB_API_KEY= uv run pytest tests/integration -q`
  - **Expected RED**: currently `skipped`, exit 0 — the very failure mode this task removes
  - **Measured RED**: _(fill in)_
  - **Verify GREEN**: same command → non-zero exit with the escalation message; and with the key present → 5 passed, 0 skipped

---

## Phase 3: User Story 1 — the rating on an added movie is the film's real rating (P1, item #163)

**Goal**: every assistant-mediated add records the film's actual US certification, or nothing at all.

**Independent test**: add a certified film and an uncertified film through the assistant; the first
carries its real rating, the second carries none and still succeeds. Needs nothing from US2.

### Tests for US1 (write first — these MUST fail before T010)

- [ ] T005 [P] [US1] Unit tests for certification extraction in `mcp-servers/web-api-mcp/tests/unit/test_certification.py` — one case per row of [contracts/web-api-mcp-get-movie-details.md](./contracts/web-api-mcp-get-movie-details.md), built from the measured shapes: `PG,PG` → `PG`; `R,R,""` → `R`; `NR,NR` → `NR`; `"",PG-13,PG-13` → `PG-13`; seven `""` then `NR` → `NR`; `""` only → `None`; no US block → `None`; `TV-14` → `None`; non-US blocks only → `None`
  - **Verify RED**: `pnpm nx run web-api-mcp:test -- tests/unit/test_certification.py -q`
  - **Expected RED**: collection error — the extractor does not exist yet
  - **Measured RED**: _(fill in)_

- [ ] T006 [P] [US1] Unit test in `mcp-servers/web-api-mcp/tests/unit/test_certification.py` that `get_movie_details` requests `append_to_response=release_dates` and makes exactly **one** HTTP call, using an httpx `MockTransport` that records requests (FR-002a)
  - **Verify RED**: same command, `-k append_to_response`
  - **Expected RED**: 1 failed — the request carries no such parameter
  - **Measured RED**: _(fill in)_

- [ ] T007 [P] [US1] Extend `mcp-servers/web-api-mcp/tests/integration/test_tmdb.py` with real-TMDB assertions on the stable films only: 412117 → `PG` (SC-001), 603 → `R`, 396535 → `NR`, 152747 → `PG-13` (the leading-empty case)
  - Do **not** pin the low-traffic `None` films here — their TMDB records are publicly editable and would drift; those cases live in T005.
  - **Verify RED**: `pnpm nx run web-api-mcp:test:integration -- -k certification -q`
  - **Expected RED**: 4 failed — `KeyError`/`None`, the candidate has no `rated` field
  - **Measured RED**: _(fill in)_

- [ ] T008 [P] [US1] Unit tests in `agents/movie-assistant/tests/unit/test_proposals.py` that `to_movie_payload` emits the candidate's rating, and `"rated": None` — **key present** — when the candidate has none (FR-004, research R5)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k rated -q`
  - **Expected RED**: ≥2 failed — the payload contains the literal `"NR"`
  - **Measured RED**: _(fill in)_

### Implementation for US1

- [ ] T009 [US1] Add `rated: str | None = None` to `EnrichedMovieCandidate` in `agents/movie-assistant/src/proposals.py`
  - Defaulted, so the disambiguation path that builds candidates from search results is unaffected.

- [ ] T010 [US1] Implement the certification extraction in `mcp-servers/web-api-mcp/src/tools.py`: add `append_to_response=release_dates` to the existing `/movie/{id}` request, and a pure helper that walks `release_dates.results` → the US block → the **first non-empty** certification, validated against `{G, PG, PG-13, R, NC-17, NR, Unrated}`, else `None`. Return it as `rated` on the candidate.
  - Keep the helper pure and separately importable — it is what T005 tests.
  - **No renaming.** TMDB publishes `PG-13`/`NC-17` and the product stores `PG-13`/`NC-17` (research R1). Item #163's AC3 asks for `PG13`/`NC17`; implementing that literally sends a value mc-service rejects.
  - **Verify GREEN**: `pnpm nx run web-api-mcp:test -- tests/unit/test_certification.py -q` → 0 failures, ≥9 passed
  - **Also run**: `pnpm nx run web-api-mcp:test -q` → previously passing tests still pass

- [ ] T011 [US1] Wire the rating through `to_movie_payload` in `agents/movie-assistant/src/proposals.py` — replace the literal `"rated": "NR"` with the candidate's value, defaulting to `None`
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -q` → 0 failures
  - **Also run**: `pnpm nx run movie-assistant:test -q` → no regression in `test_approval_gate.py` / `test_import_apply.py`

- [ ] T012 [US1] Verify the live tier: `pnpm nx run web-api-mcp:test:integration -q`
  - **Expected GREEN**: 9 passed, **0 skipped**
  - **Measured GREEN**: _(fill in)_
  - If the shape differs from [contracts/web-api-mcp-get-movie-details.md](./contracts/web-api-mcp-get-movie-details.md), fix the contract **and** the T005 fixtures — never just the failing assertion.

- [ ] T013 [P] [US1] Add the SC-001 assertion to `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts` (`@model-decision`): add "The Secret Life of Pets 2" (2019) through the assistant and assert the created movie's `rated` is `PG` via `/bff-api`
  - **Verify**: `node scripts/agent-e2e.mjs agent-add-ownership`

**Checkpoint**: US1 is independently shippable here — merge-blocking unit + live coverage, and the
reported defect is fixed end to end.

---

## Phase 4: User Story 2 — every add records whether it is a children's movie (P2, item #162)

**Goal**: the member is asked, once, before the ownership question, and their answer is what gets
written.

**Independent test**: add a movie answering the new question both ways, and with both ownership
answers; the created movie carries exactly what was chosen. Needs nothing from US1.

### Tests for US2 (write first — these MUST fail before T018)

- [ ] T014 [P] [US2] Unit tests for the stage machine in `agents/movie-assistant/tests/unit/test_organizer_add_chain.py`: the chain's first question is `awaiting_childrens`; `yes`/`no` advances to `awaiting_ownership` retaining the answer; an unparseable reply re-asks without advancing; abandonment adds nothing; a not-owned add still carries the answer (US2-AC5)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -q`
  - **Expected RED**: ≥5 failed — the chain enters `awaiting_ownership` directly
  - **Measured RED**: _(fill in)_

- [ ] T015 [P] [US2] Unit test in `agents/movie-assistant/tests/unit/test_organizer_add_chain.py` that `awaiting_childrens` is registered in **both** `graph._OWNERSHIP_STAGES` and `curator._OWNERSHIP_STAGES`, and **not** in `_MULTI_SELECT_STAGES` (research R6)
  - This is a guard, not a tautology: each omission fails differently at runtime and none of them fails loudly.
  - **Verify RED**: same command, `-k stages`
  - **Expected RED**: 2 failed — the stage is absent from both sets
  - **Measured RED**: _(fill in)_

- [ ] T016 [P] [US2] Unit tests in `agents/movie-assistant/tests/unit/test_proposals.py` that `to_movie_payload(..., childrens=True)` emits `"childrens": true`, that it defaults to `False`, and that `build_add_proposal` carries the answer onto the `ProposalItem` (FR-010, FR-015)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k childrens -q`
  - **Expected RED**: ≥3 failed — the parameter does not exist
  - **Measured RED**: _(fill in)_

- [ ] T017 [P] [US2] Unit test in `agents/movie-assistant/tests/unit/test_approval_gate.py` that an approval arriving on a later turn applies the checkpointed children's answer (research R9)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_approval_gate.py -k childrens -q`
  - **Expected RED**: 1 failed
  - **Measured RED**: _(fill in)_

### Implementation for US2

- [ ] T018 [US2] Add `childrens: bool | None = None` to `ProposalItem` and thread it through `_item` and `build_add_proposal` in `agents/movie-assistant/src/proposals.py`; add a `childrens: bool = False` keyword to `to_movie_payload` replacing the hardcoded `"childrens": False`
  - Leave `diff` untouched — FR-018a keeps the approval text unchanged.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -q` → 0 failures

- [ ] T019 [US2] Register `awaiting_childrens` in `agents/movie-assistant/src/graph.py` (`_OWNERSHIP_STAGES`, line ~166) and in the local mirror in `agents/movie-assistant/src/nodes/curator.py` (line ~122). Do **not** add it to `_MULTI_SELECT_STAGES`.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -k stages -q` → 0 failures

- [ ] T020 [US2] Add `_ask_childrens` to `agents/movie-assistant/src/nodes/organizer.py` mirroring `_ask_ownership` (Yes/No via `render_selection`, tool id `add-childrens`), make it the stage the chain enters instead of `awaiting_ownership` (line ~280), and add the `awaiting_childrens` branch to the transition block (line ~482) which stores the answer and calls `_ask_ownership`. Reuse `_parse_ownership`; re-ask on `None`.
  - The collection question keeps its position ahead of this one (FR-008a) — the entry point that changes is the one reached *after* `add_target` is resolved.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -q` → 0 failures, ≥7 passed

- [ ] T021 [US2] Thread the answer through the proposal build (`_build_ownership_proposal`, `organizer.py:~390`) and the apply path (`approval_gate.py:~212`) so it reaches `to_movie_payload`
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -q` → 0 failures across the whole unit suite

- [ ] T022 [US2] Update the E2E specs that walk the old turn sequence — 5 tests in `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts` (lines ~70, 155, 215, 261, 303) and 1 in `frontend/mcm-app/tests/e2e/web/agent-add-external-link.spec.ts` (line ~78) — to answer the children's question first, and add new coverage: the question appears before ownership from both a card add and a typed add, and abandoning at it adds nothing
  - **If these pass unmodified, the question is not being asked** — that is a failure, not a convenience.
  - **Verify**: `node scripts/agent-e2e.mjs agent-add-ownership` and `node scripts/agent-e2e.mjs agent-add-external-link`

**Checkpoint**: both stories complete and independently verifiable.

---

## Phase 5: Polish & cross-cutting

- [ ] T023 [P] Run both linters — `pnpm nx run web-api-mcp:lint` and `pnpm nx run movie-assistant:lint` (ruff + mypy)
  - Derive checks from the diff, not from memory: a Python change means `lint` as well as `test`.

- [ ] T024 Verify in CI that the enrolled integration step actually ran web-api-mcp — read the run log via `node scripts/ci-status.mjs`, confirm a non-zero collected count for `tests/integration` and a skip count of 0
  - A workflow edit is not evidence that a step ran. If egress from the runner turns out to be blocked, this is where it surfaces — fix the runner path or revert T003 and record why, but do not silence it.

- [ ] T025 [P] Manual confirmation per [quickstart.md](./quickstart.md) §4 — add "The Secret Life of Pets 2" through the assistant on the local stack, answer the children's question, and read the detail screen: Rated `PG`, and the children's flag as answered

- [ ] T026 [P] Comment on backlog items #163 and #162 recording what their acceptance criteria got wrong — the `PG-13` → `PG13` rename that exists at no boundary (item #163 AC3, research R1) and `build_add_movie_payload`, which is `to_movie_payload` (both items, research R2)
  - `node scripts/backlog.mjs comment 163 --body-file …` / `… 162 …`. Correct the criteria before closing, not after.

- [ ] T027 Close items #163 and #162 only once their criteria are met and verified — `node scripts/backlog.mjs update 163 --state closed`
  - Not when the PR merges. Verify first, then close.

- [ ] T028 [P] Record the reusable learning in the knowledge base: the dev-container firewall now separates the FORWARD chain (runtime, never needed TMDB) from the OUTPUT chain (test runners, do), and web-api-mcp's integration tier is enrolled in CI — update `openwiki/invariants/testing-tiers.md` and/or `openwiki/runbooks/*` per [openwiki/INSTRUCTIONS.md](../../openwiki/INSTRUCTIONS.md) (write into the cited source, never into CLAUDE.md)

---

## Dependencies

```text
Phase 1 (T001-T002)  →  everything
Phase 2 (T003-T004)  →  T012, T024        (US1's live gate; nothing in US2)
US1 (T005-T013)      ──┐
US2 (T014-T022)      ──┴→  Phase 5
```

- **US1 and US2 are independent.** They touch the same function (`to_movie_payload`) on different
  lines and the same E2E file in different tests — sequence them to avoid a conflict, but either can
  ship without the other.
- Within US1: T005/T006/T007/T008 in parallel → T009 → T010 → T011 → T012 → T013.
- Within US2: T014/T015/T016/T017 in parallel → T018 → T019 → T020 → T021 → T022.
- T003 and T004 are ordered: escalation before enrollment would make CI red on the first run for the
  right reason but the wrong task.

## Parallel execution examples

```bash
# US1 test authoring — four files, no shared state
T005 mcp-servers/web-api-mcp/tests/unit/test_certification.py
T006 mcp-servers/web-api-mcp/tests/unit/test_certification.py   # same file: sequence with T005
T007 mcp-servers/web-api-mcp/tests/integration/test_tmdb.py
T008 agents/movie-assistant/tests/unit/test_proposals.py

# US2 test authoring
T014 + T015 agents/movie-assistant/tests/unit/test_organizer_add_chain.py   # same file: sequence
T016 agents/movie-assistant/tests/unit/test_proposals.py
T017 agents/movie-assistant/tests/unit/test_approval_gate.py
```

## Implementation strategy

**MVP = User Story 1.** It is the `priority/p2` bug, it puts false data in members' libraries on
every add, and it is fully proven by merge-blocking tiers. Shipping it alone is a coherent release.

**Then User Story 2**, which is additive and carries no data-correctness urgency.

**Do not defer Phase 2.** T003/T004 are what make the live check a gate rather than a habit — the
spec requires it (FR-020a), and the whole reason the environment work in `517f8a2` happened is that
the alternative was a verification only a person could run.
