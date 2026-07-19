---
description: "Task list for Integration-Test CI Enforcement"
---

# Tasks: Integration-Test CI Enforcement

**Input**: Design documents from `/specs/041-integration-test-ci-enforcement/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: The integration tests being enforced **already exist**; this feature wires them into CI and remediates
the 8 quarantined agent tests. There is therefore no "write new failing test first" TDD phase. The TDD-equivalent
guarantee is the **broken-on-purpose** check per suite (a deliberate regression must turn the gate red) — modeled
as explicit tasks (T018/T021/T027) rather than a Verify-RED/GREEN pair, because the artifact under test is a *CI
gate*, not a new function. Where a task genuinely authors or modifies a test (T010 golden relocation, T013
add-persist fix), it carries the constitution's Verify-RED/GREEN checkpoint evidence.

**Organization**: Tasks grouped by the four user stories to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 / US4 (Setup, Foundational, Polish carry no story label)
- Every task names an exact file path or command target.

## Path Conventions

Monorepo (web app + Rust backend + Python agent layer). CI lives on the Forgejo forge at
`.forgejo/workflows/app-ci.yml` (NOT `.github/`). All test suites run via `pnpm nx test:integration <project>`.

---

## Phase 1: Setup (Shared Prerequisites)

**Purpose**: Confirm the `app-e2e` stack, host toolchain, ports, and credentials each suite needs — before wiring
(FR-008; PRD Risk "host-provisioning surprise").

- [X] T001 Enumerate + verify each suite's host prerequisites on the `kvm` runner (Rust stable toolchain for mc-service — install pattern already in the `mc-service-checks` job of `.forgejo/workflows/app-ci.yml`; Node 20 + pnpm for mcm-app; `uv`/Python for the agent suite). Record the confirmed prereqs in [research.md](./research.md) D4/D5 if anything differs.
- [X] T002 [P] Confirm the published ports + credentials each suite uses are live in `app-e2e`: Mongo `27017` (replica-set member `localhost:27017`), BFF Mongo `27018`, Redis `6379` (db 1), mc-service `3001`, dev BFF `8082`, Keycloak `8099`; ROPC + service-account secrets already in the job env / `$GITHUB_ENV`. Cross-check against [contracts/app-e2e-integration-steps.md](./contracts/app-e2e-integration-steps.md).
- [ ] T003 [P] Capture the current `app-e2e` wall-clock (a recent green run) as the baseline for the SC-006 bounded-increase comparison; note it in [quickstart.md](./quickstart.md) or the PR description.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The cross-language skip-escalation primitives that Workstreams B (US2) and C (US3) reuse so a
misconfigured run fails loudly (FR-006/FR-012; realizes US4's guarantee for the two new suites). The pytest hook
already exists (`agents/movie-assistant/tests/integration/conftest.py`) — no agent work here.

**⚠️ CRITICAL**: T004 blocks US3; T005 blocks US2. US1 does NOT depend on this phase (the agent enforcement already
exists) and may proceed in parallel.

- [X] T004 Add a jest dependency **preflight** in `frontend/mcm-app/tests/integration/setup/` (new module wired via `globalSetup` in `frontend/mcm-app/jest.integration.config.js`, or an early guard in `setup/env.ts`): when `MCM_REQUIRE_LIVE_STACK=1`, probe BFF `:8082`, Keycloak `:8099`, Redis db 1, BFF Mongo `27018` and **throw** if any is unreachable (no silent all-skip). Document the legitimate-skip allowlist in-code. Per [contracts/skip-escalation-convention.md](./contracts/skip-escalation-convention.md).
- [X] T005 [P] Add a cargo **executed-test-count guard** for `backend/mc-service/tests/integration/` so an all-`#[ignore]` / zero-executed run is treated as FAILURE, not green (e.g. assert the expected integration binaries ran); forbid `#[ignore]` on these tests. Confirm `common/mod.rs` still `.expect()`s the Mongo connection (hard-fail on absent DB). Per [contracts/skip-escalation-convention.md](./contracts/skip-escalation-convention.md).
- [X] T006 [P] Finalize the per-suite legitimate-skip allowlists to match the implemented primitives (agent `_LEGITIMATE_SKIPS` unchanged; mcm-app preflight list; mc-service = N/A) and reconcile [contracts/skip-escalation-convention.md](./contracts/skip-escalation-convention.md) with the code.

**Checkpoint**: Skip-escalation primitives exist for all three runners — US2 and US3 wiring can now be trusted.

---

## Phase 3: User Story 1 - Restore the muted agent integration signal (Priority: P1) 🎯 MVP

**Goal**: Fix and un-quarantine all 8 agent integration tests so the CI step reverts to `-m "not golden"` and any
break in those paths turns the build red.

**Independent Test**: `pnpm nx test:integration movie-assistant -- -m "not golden"` against the live stack passes
with zero quarantine exclusions; `grep -r ci_quarantine agents/movie-assistant/tests` returns nothing.

### Bucket A — TMDB / web-api-mcp (4 tests)

- [X] T007 [US1] Diagnose the live TMDB failure (research D1): `docker exec movie-assistant-mcp-webapi printenv TMDB_API_KEY` and reproduce a live `search_title` / `get_movie_details` in an `app-e2e` run or the dev container; classify as missing-key/egress vs rate-limit vs real bug.
- [X] T008 [US1] Fix per T007 diagnosis — provisioning (`scripts/gen-ci-env.mjs` → `mcp-servers/web-api-mcp/.env.local` from `secrets.TMDB_API_KEY`), resilience (retry/backoff or accept a rate-limited response) in `mcp-servers/web-api-mcp/`, or a real `web-api-mcp` bug. NO mocking (§Test Type Integrity).
- [X] T009 [P] [US1] Remove the `@pytest.mark.ci_quarantine` decorators + explanatory comments from the 4 TMDB tests: `agents/movie-assistant/tests/integration/test_curator_enrich.py` (×3) and `test_resolution_realistic.py` (×1). Verify each passes live.

### Bucket B — live-LLM tool-choice (3 tests)

- [X] T010 [US1] Resolve the 3 tool-choice assertions (research D2, prefer **relocation to golden**): move the exact-tool-choice assertion into `agents/movie-assistant/tests/golden/` (recorded against the runtime model) for `test_query_flow.py` (×2) and `test_search_flow.py` (×1); OR loosen the live assertion to the valid alternative; OR fix the supervisor/specialist prompt if the behavior is genuinely wrong. For each relocated assertion, record the golden pair's Verify-GREEN in keyless replay and note the live test's pre-change failure as the RED baseline (constitution TDD Checkpoint Format — tests are authored/modified here).
- [X] T011 [P] [US1] Remove the `@pytest.mark.ci_quarantine` decorators + comments from the 3 tool-choice tests in `agents/movie-assistant/tests/integration/test_query_flow.py` and `test_search_flow.py`; verify the live tests pass (behavior-level, no exact-tool assertion) and the golden pairs pass in replay.

### Bucket C — add-persist (1 test)

- [X] T012 [US1] Reproduce `test_gateway_add_e2e::test_gateway_add_gated_until_approval_then_persists` against the live stack; determine **real-bug vs model/timing** (research D3, potential-bug-first) by polling mc-service for the collection after an approved add.
- [X] T013 [US1] Fix per T012: if the approval-resume path drops the write, fix the product (gateway add-persist code — the already-RED test is the TDD driver); if timing, harden the test's wait/assert (bounded poll) in `agents/movie-assistant/tests/integration/test_gateway_add_e2e.py`. No assertion-loosening to mask a real drop. If the fix is a product change, attach Verify-RED (the failing `test_gateway_add_gated_until_approval_then_persists` before the fix) and Verify-GREEN (passing after) evidence in the PR, per the constitution TDD Checkpoint Format — the test is authored/modified here.
- [X] T014 [US1] Remove the `@pytest.mark.ci_quarantine` decorator + comment from the add-persist test.

### Finalize US1

- [X] T015 [US1] Delete the `ci_quarantine` marker registration from `agents/movie-assistant/pyproject.toml` (`[tool.pytest.ini_options] markers`).
- [X] T016 [US1] Revert the agent step filter in `.forgejo/workflows/app-ci.yml` (`app-e2e` job, "Agent integration tests" step) from `-m "not golden and not ci_quarantine"` to `-m "not golden"`.
- [X] T017 [US1] Verify AC1: `grep -r ci_quarantine agents/movie-assistant/tests` returns nothing and `grep -n ci_quarantine .forgejo/workflows/app-ci.yml` shows the step reads `-m "not golden"` only.
- [X] T018 [US1] Prove the restored agent signal bites (SC-003/FR-013): temporarily break one newly-un-quarantined path (e.g. flip an expected assertion in `test_gateway_add_e2e.py`, or regress the resolved code path a curator-enrich test covers), confirm the "Agent integration tests" step now FAILS in an `app-e2e` run, then revert. This is the agent suite's 1-of-3 broken-on-purpose proof.

**Checkpoint**: Agent suite fully enforced — MVP deliverable. Independently shippable.

---

## Phase 4: User Story 2 - Gate every backend-service change (Priority: P2)

**Goal**: `mc-service test:integration` runs in `app-e2e` against the real replica-set Mongo (+ Keycloak JWKS) and
gates every backend PR.

**Independent Test**: an `app-e2e` run executes the mc-service integration binaries against the real replica set
and passes; a deliberate repository regression fails the step.

**Depends on**: Foundational T005 (cargo executed-count guard).

- [X] T019 [US2] Add an "mc-service integration tests" step to the `app-e2e` job in `.forgejo/workflows/app-ci.yml`, placed **after** stack bring-up and **before** the Web E2E / APK / emulator steps (fast-fail). Ensure the Rust stable toolchain is installed on the host (reuse the `mc-service-checks` rustup + `build-essential pkg-config libssl-dev` pattern). Command: `pnpm nx test:integration mc-service`. Per [contracts/app-e2e-integration-steps.md](./contracts/app-e2e-integration-steps.md) Step B.
- [X] T020 [US2] Set the step env: `MC_DB_URL=mongodb://localhost:27017/mc_db?replicaSet=rs0&directConnection=true`, `KEYCLOAK_URL=http://localhost:8099`, `KEYCLOAK_REALM=grumpyrobot`, `KEYCLOAK_CLIENT_ID=movie-collection-manager`, `MCM_REQUIRE_LIVE_STACK=1`; confirm the T005 executed-count guard gates the step.
- [X] T021 [US2] Prove the gate bites (AC2/SC-003): temporarily break the cascade-delete transaction in `backend/mc-service/src/adapters/mongodb/collection_repository.rs`, confirm the step fails in an `app-e2e` run, then revert.
- [X] T022 [US2] Prove no-false-green (AC4/SC-004): with `mc-service-store-mongo` stopped, confirm the step FAILS (`.expect()` panic), not skips.
- [X] T023 [US2] Confirm the mc-service integration suite leaves no residual data and uses an isolated namespace (FR-009/SC-005): verify each test drops the collections/movies it creates in `mc_db` (or document reliance on the per-run `mc-service-store-mongo-data` volume wipe in `app-ci.yml`'s "Reset stateful CI data" step) and cannot collide with the agent suite's data on the same instance. Inspect `mc_db` after a run.

**Checkpoint**: Backend integration path gated in CI.

---

## Phase 5: User Story 3 - Gate every BFF change (Priority: P3)

**Goal**: `mcm-app test:integration` runs in `app-e2e` against real Keycloak + Redis + the dev BFF and gates every
BFF PR.

**Independent Test**: an `app-e2e` run executes the BFF integration suite against the real dependencies and passes;
a deliberate BFF regression fails the step; no residual test data remains.

**Depends on**: Foundational T004 (jest preflight).

- [X] T024 [US3] Ensure `frontend/mcm-app/tests/integration/setup/env.ts` resolves its creds on the host CI runner: either align the loaded filenames with what `scripts/gen-ci-env.mjs` writes, or export the needed vars (`E2E_ROPC_CLIENT_ID/SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `MONGO_URL`) into the step env. Keep Redis pinned to db 1.
- [X] T025 [US3] Add a "BFF integration tests" step to the `app-e2e` job in `.forgejo/workflows/app-ci.yml`, same fast-fail placement, with env `BFF_BASE_URL=http://localhost:8082`, Keycloak `:8099` + ROPC creds (from `$GITHUB_ENV`), `REDIS_URL=redis://localhost:6379/1`, BFF Mongo `27018`, `MCM_REQUIRE_LIVE_STACK=1`. Command: `pnpm nx test:integration mcm-app`. Per [contracts/app-e2e-integration-steps.md](./contracts/app-e2e-integration-steps.md) Step C.
- [X] T026 [US3] Confirm the T004 jest preflight gates this step (a required-dep-down throws before any test skips).
- [X] T027 [US3] Prove the gate bites (AC3/SC-003): temporarily break session eviction or the rate-limit counter in `frontend/mcm-app/src/bff-server/` (`session-manager.ts` / `rate-limiter.ts`), confirm the step fails, then revert.
- [X] T028 [US3] Prove no-false-green (AC4/SC-004): with `mcm-bff-cache-redis` stopped and `MCM_REQUIRE_LIVE_STACK=1`, confirm the preflight throws and the step FAILS (not skip-to-green).
- [X] T029 [US3] Confirm the suite's `afterAll` leaves no residual test data in the shared BFF Mongo / Redis db 1 (SC-005) — inspect after a run.

**Checkpoint**: BFF integration path gated in CI.

---

## Phase 6: User Story 4 - No misconfigured run reports green (Priority: P1)

**Goal**: The shared skip-escalation guarantee holds across all three suites, and legitimately-optional profiles
stay skipped (not failed). This story's *primitives* were built in Foundational (T004/T005) and the pytest hook
pre-exists; this phase is the **cross-suite acceptance** + the documented allowlist policy.

**Independent Test**: for each suite, a partial-down run fails (SC-004 matrix); an optional-profile-down run does
NOT fail the default gate.

**Depends on**: the enforcement present in US1 (agent), US2 (T022), US3 (T028).

- [X] T030 [US4] Confirm the agent suite's `conftest.py` escalation still holds after un-quarantine: a partial-down agent run (e.g. an MCP server down) escalates the SKIP to FAIL. No golden/optional-profile skip is escalated.
- [X] T031 [US4] Verify AC/scenario 2 (FR-007): with an opt-in profile intentionally NOT running (e.g. `--profile observability` down), the default gate's optional-profile-dependent tests remain **skipped**, not failed, in all three suites.
- [X] T032 [US4] Execute the cross-suite SC-004 matrix from [quickstart.md](./quickstart.md) Story 4 (agent / mc-service / mcm-app each fail on their own partial-down) and record the result in the PR description.

**Checkpoint**: No-false-green guarantee proven for every newly-wired suite.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T033 [P] Update `docs/runbooks/` (e.g. `e2e-testing.md`) and the CLAUDE.md Test Run Protocol to state the integration tier now runs in CI for all three projects and how to run each suite locally against the `app-e2e` stack (FR-014/SC-007).
- [X] T034 [P] Keep the Platform Parity Table (below) current per the constitution; confirm the mobile/web N/A justification still holds (these are backend/BFF/agent integration suites with no UI surface).
- [X] T035 Measure the `app-e2e` wall-clock delta vs the T003 baseline; confirm the increase is bounded + justified and the fast-fail ordering (cheap checks before the emulator legs) is preserved (SC-006); confirm the secret / naming / prod-CI-port-collision gates stay green.
- [X] T036 Run the full [quickstart.md](./quickstart.md) validation on an `app-e2e` run (all four stories green in one run).
- [X] T037 [P] Update private memory `project_mcm_agent_integration_ci` with the un-quarantine outcomes (per-bucket resolution) and mark the mc-service + mcm-app integration wiring done, so the CI-runbook's authoritative note stays current.

---

## Platform Parity Table

Per the constitution (Frontend App Quality Standards), every feature lists each scenario's web/mobile status. This
feature adds **no UI scenarios** — it enforces backend/BFF/agent *integration* suites in CI. All rows are N/A for
web (Playwright) and mobile (Maestro) with justification.

| Scenario | Web (Playwright) | Mobile (Maestro) | Justification |
|---|---|---|---|
| Agent suite fully enforced (US1) | N/A | N/A | Python integration suite (pytest), no UI surface; the web/mobile agent E2E flows are unchanged and already covered by `app-e2e`. |
| mc-service integration gated (US2) | N/A | N/A | Rust service-to-DB integration (`cargo test`), no client UI. |
| BFF integration gated (US3) | N/A | N/A | BFF-to-dependency integration (`jest`, HTTP + real Redis/Keycloak/Mongo), no client UI. |
| No-false-green guarantee (US4) | N/A | N/A | CI-gate discipline (env flag + runner guards), verified by partial-down CI runs, not a UI flow. |

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: after Setup. T004 blocks US3; T005 blocks US2. Does NOT block US1.
- **US1 (Phase 3)**: after Setup — independent of Foundational (agent enforcement pre-exists). 🎯 MVP.
- **US2 (Phase 4)**: after Foundational T005.
- **US3 (Phase 5)**: after Foundational T004.
- **US4 (Phase 6)**: after US1, US2 (T022), US3 (T028) — it is the cross-suite proof.
- **Polish (Phase 7)**: after all desired stories.

### User Story Dependencies

- **US1 (P1)**: independent — the highest-signal, standalone-shippable MVP.
- **US2 (P2)** and **US3 (P3)**: independent of each other; each depends only on its Foundational primitive. Can
  proceed in parallel with US1 and with each other.
- **US4 (P1)**: aggregates the per-suite no-false-green proofs; runs last.

### Parallel Opportunities

- Setup: T002, T003 in parallel.
- Foundational: T005, T006 in parallel (T004 is the sequential blocker for US3).
- **US1 runs in parallel with Foundational + US2 + US3** — different files (agent suite vs Rust/jest/CI-steps).
- Within US1: T009, T011 are `[P]` (marker removals in different files), each gated on its bucket's fix
  (T008→T009, T010→T011).
- US2 and US3 can be developed by different people simultaneously once Foundational is done.

---

## Parallel Example: after Foundational

```bash
# Three tracks in parallel (different files, no shared state):
Track A (US1): diagnose+fix+un-quarantine the 8 agent tests (agents/movie-assistant/**)
Track B (US2): wire mc-service integration step (.forgejo/workflows/app-ci.yml + backend/mc-service/**)
Track C (US3): wire mcm-app integration step (.forgejo/workflows/app-ci.yml + frontend/mcm-app/**)
# Note: B and C both edit app-ci.yml — coordinate the two step insertions to avoid a merge conflict.
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup.
2. Phase 3 US1 — fix + un-quarantine the 8 agent tests, revert the filter, prove the restored signal bites.
3. **STOP and VALIDATE**: `-m "not golden"` green in an `app-e2e` run; `grep` clean (AC1); the deliberate-regression
   proof (T018) turned the step red then reverted.
4. Ship — this is the debt PR #77 deferred and the most likely to reveal a real product bug (add-persist).

### Incremental Delivery

1. Setup + Foundational → skip-escalation primitives ready.
2. US1 → agent suite enforced (MVP).
3. US2 → mc-service integration gated (prove it bites; confirm cleanup).
4. US3 → mcm-app integration gated (prove it bites).
5. US4 → cross-suite no-false-green proven.
6. Polish → docs, wall-clock check, memory.

Each story adds enforced coverage without weakening the others; B and C reuse the shared convention rather than
reinventing it.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task.
- The two new suites are wired into the **existing** `app-e2e` stack — no separate integration stack (PRD Non-Goal).
- No mocking in any `tests/integration/` (§Test Type Integrity) — relocations go to the **golden** harness, never a mock.
- No new host ports, no new secrets — reuse the published ports + Forgejo Actions store + `gen-ci-env`/`gen-dev-secrets`.
- Both US2 (T019) and US3 (T025) edit `.forgejo/workflows/app-ci.yml`; sequence or coordinate the two step insertions.
- Commit after each logical group; treat the add-persist item (T012/T013) as potential-bug-first.
- Broken-on-purpose proofs (SC-003, 3-for-3): T018 (agent), T021 (mc-service), T027 (mcm-app).
