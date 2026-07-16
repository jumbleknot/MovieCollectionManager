---
description: "Task list for feature 040 — admin registration control + agent add/import/navigate reliability"
---

# Tasks: Admin Registration Control + Agent Add/Import/Navigate Reliability

**Input**: Design documents from `specs/040-admin-registration-agent-fixes/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: INCLUDED — TDD is mandatory (constitution §Test-Driven Development). Every behavior change is preceded by a failing test. Test tasks follow [docs/templates/feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md) (Scenarios → Verify RED → Verify GREEN) and honor Test Type Integrity (unit may mock externals; integration hits real Mongo/Keycloak/mc-service/MCP; E2E drives the real stack).

**Organization**: Grouped by user story (priority order US1 → US2 → US3 → US4). Each story is an independently testable, independently shippable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 / US4
- Every task names exact file path(s)

## Story ↔ Item ↔ Priority map

| Story | Item | Priority | Area |
|---|---|---|---|
| US1 | Item 4 — navigate-to-collection routing | P1 🎯 MVP | Python agent layer |
| US2 | Item 3 — spreadsheet-import reliability | P2 | Python agent layer |
| US3 | Item 1 — admin disables self-registration | P2 | Frontend + BFF |
| US4 | Item 2 — TMDB add ownership + navigate | P3 | Python agent layer |

---

## Phase 1: Setup (Shared)

**Purpose**: Clean baselines before any edit.

- [ ] T001 Bring up local stacks per [quickstart.md](./quickstart.md) (auth → mcm app profile → agent gateway + MCP servers; replica-set Mongo) and rebuild the agent gateway + MCP images to a clean baseline (stale image = old code).
- [ ] T002 [P] Capture a green baseline of the suites this feature will touch: `pnpm nx test movie-assistant` (test_navigator, test_routing, test_search, test_organizer, test_import_*, test_approval*), `pnpm nx test mcm-app`, `pnpm nx test mc-service` — record current pass state before changes.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Confirm the one whole-feature scope assumption. The four stories are otherwise independent (no shared blocking code) — see Dependencies for shared-file serialization.

- [ ] T003 Confirm mc-service already honors `owned` with no backend change needed: run `pnpm nx test mc-service` covering movie-create with `owned=true` and `owned=false` (domain/movie.rs, application/dtos/movie_dto.rs, application/commands/create_movie.rs). If green, mc-service is out of scope for edits (only the agent passes the boolean). If a gap surfaces, STOP and revise the plan.

**Checkpoint**: Baselines captured, backend scope confirmed — user-story work can begin.

---

## Phase 3: User Story 1 — Navigate to a collection reliably (Priority: P1) 🎯 MVP

**Goal**: "navigate to &lt;collection&gt;" opens that collection; disambiguation taps navigate (never mis-search); the assistant never stays anchored to a previously-viewed collection.

**Independent Test**: Drive the exact repro (ask → disambiguate → tap "Test Import" → Test Import opens; "navigate to X collection" opens X), passing without US2/US3/US4.

### Tests for User Story 1 (write first — Verify RED) ⚠️

- [X] T004 [P] [US1] Extend `agents/movie-assistant/tests/unit/test_navigator.py`: disambiguation buttons carry a **bare stage-anchored** `value` (not `"open <name>"`); resolving a tap yields a `navigate_to_collection` for the chosen collection. Verify RED.
- [X] T005 [P] [US1] Extend `agents/movie-assistant/tests/unit/test_routing.py`: a pending `navigate_stage` keeps the follow-up tap in the navigator (continuation guard); `"navigate to <collection> collection"` classifies as `navigate`, while `"navigate to <movie title>"` stays `search`. Also add a **no-match** case: a navigate request naming no owned collection yields a navigation-context response (offer/list), NOT a movie-search failure inside the current collection (FR-021). Verify RED.
- [X] T006 [P] [US1] Add the golden expectation for `tests/golden/cassettes/us7-intent-search-navigate.json` covering `"navigate to <collection> collection" → navigate` (test asserts intent; cassette re-recorded in T011). Verify RED.
- [ ] T007 [US1] Add web E2E `frontend/mcm-app/tests/e2e/web/agent-navigate-collection.spec.ts` reproducing the reported flow (navigate → disambiguate → tap → correct collection opens; no in-collection movie-search misfire). Verify RED.
- [ ] T008 [US1] Add mobile flow `frontend/mcm-app/tests/e2e/mobile/agent-navigate-collection.yaml` (logged-out start; same journey; agent flow runs in CI). Verify RED.

### Implementation for User Story 1

- [X] T009 [US1] Add `navigate_stage` + `navigate_options` to `GraphState` in `agents/movie-assistant/src/graph.py` and clear them on resolution (add a navigate reset alongside the existing `_*_STATE_RESET` handling). *(shared file — see Dependencies)*
- [X] T010 [US1] In `agents/movie-assistant/src/nodes/navigator.py` `_clarify`: post buttons with a bare stage-anchored `value` (drop the `"open "` verb); resolve the resumed token to the chosen collection and emit `navigate_to_collection`.
- [X] T011 [US1] In `agents/movie-assistant/src/graph.py`, add the `navigate_stage` continuation guard (mirror the `search_stage`/`import_stage` guards ~209–263) so a disambiguation tap stays in the navigator. *(shared file — see Dependencies)*
- [X] T012 [US1] In `agents/movie-assistant/src/nodes/supervisor.py`, update the intent-classifier prompt so `"navigate to <collection> collection"` naming an owned collection → `navigate` (not `search`); keep movie-title → `search`. *(GOLDEN surface — see T013)* *(shared file — see Dependencies)*
- [X] T013 [US1] Re-record `agents/movie-assistant/tests/golden/cassettes/us7-intent-search-navigate.json` for the new classification and **obtain explicit human approval before merge (FR-023)**. *(Done 2026-07-16: re-recorded all 29 intent cassettes + new `us040-intent-navigate-collection-qualified` positive pair; 41/41 pass record+replay; counter-example stays `search`. Commit `8fb473e`.)*
- [ ] T014 [US1] Rebuild the agent gateway + MCP images (agent-source changed) before containerized E2E.

### Verify GREEN (US1)

- [ ] T015 [US1] Run `pnpm nx test movie-assistant` (T004–T006 green), then `pnpm nx e2e mcm-app -- tests/e2e/web/agent-navigate-collection.spec.ts` and `scripts/maestro-run.sh tests/e2e/mobile/agent-navigate-collection.yaml` — all GREEN. (SC-009, SC-010)

**Checkpoint**: US1 fully functional and independently testable — MVP shippable.

---

## Phase 4: User Story 2 — Finish a large spreadsheet import (Priority: P2)

**Goal**: The import never stops silently — an answered clarification always advances it, errors always surface, dedup reads aren't throttled, and large files stay responsive.

**Independent Test**: Import 200+ rows with ≥10 comma titles; every answer advances; a forced error surfaces a message; passes without US1/US3/US4.

### Tests for User Story 2 (write first — Verify RED) ⚠️

- [X] T016 [P] [US2] Extend `agents/movie-assistant/tests/unit/test_import_disambiguation_runtime.py` + `test_import_transitions.py`: an answer that does not `resolve_option` **re-asks** the pending comma question and preserves import state (no `_IMPORT_STATE_RESET`, no re-classification). Verify RED.
- [X] T017 [P] [US2] Extend `agents/movie-assistant/tests/unit/test_import_runtime.py`: an exception in the import node yields a user-facing `"import failed: …"` message (graceful degradation), never a blank reply. Verify RED.
- [X] T018 [P] [US2] Add a unit test asserting the `_finalize` existing-movie reads pass `skip_rate_limit=True` (a large multi-collection dedup is not throttled into a partial list). File: `agents/movie-assistant/tests/unit/test_import_apply.py` (or test_import_runtime.py). Verify RED.
- [ ] T019 [P] [US2] Add a unit test asserting the parsed spreadsheet is carried across clarification turns via a **transient handle**, not the full `import_context` dataset (checkpointed state bounded), **AND that the handle stays valid across multiple clarification turns of one import session** (a multi-turn import resolves the handle on the last turn, not just the first — FR-016). File: `agents/movie-assistant/tests/unit/test_import_runtime.py`. Verify RED.
- [ ] T020 [US2] Extend integration `agents/movie-assistant/tests/integration/test_import_flow.py`: a 200+ row sheet with comma titles completes to approval/apply against real MCP + mc-service; duplicates reported as skipped; remainder created. **Assert the existing per-row skip/complete behavior (FR-017) is preserved through the T022/T024 changes** (no impl task — this is a preservation check). Verify RED.

### Implementation for User Story 2

- [X] T021 [US2] In `agents/movie-assistant/src/graph.py` import-continuation gate (~259–263): when the answer does not `resolve_option`, re-ask the pending question (retain `import_stage`/`import_prompt`) instead of `_IMPORT_STATE_RESET` → new intent. *(shared file — see Dependencies)*
- [X] T022 [US2] In `agents/movie-assistant/src/runtime_nodes.py` `_build_import_node`: wrap the node body in a graceful-degradation handler (like `_degrade_node`) so any exception returns a user-facing `"import failed: <reason>"` (non-secret) message.
- [X] T023 [US2] In `agents/movie-assistant/src/runtime_nodes.py` `_finalize`: pass `skip_rate_limit=True` on the `list_movies` existing-movie reads.
- [ ] T024 [US2] Replace the full-dataset `import_context` checkpointing with a transient handle to the parsed spreadsheet across clarification turns — edit `agents/movie-assistant/src/runtime_nodes.py` (and `graph.py` state field / `nodes/import_collection.py` / `nodes/import_disambiguation.py` as needed). **The handle's backing store MUST keep the parsed data valid for the whole import session (all its clarification turns); if the spreadsheet-mcp transient store's TTL/lifecycle cannot guarantee that, either extend/refresh it per turn or checkpoint a minimal re-parse key instead — do not adopt a handle that can expire mid-session (FR-016).** *(graph.py shared — see Dependencies)* *(2026-07-16 finding — see research D3.4: the upload store is SINGLE-USE (`read_upload` deletes the key on first read), so the "re-parse key" alternative is DEAD. Correct path: add a NEW `import:parsed:<handle>` store + `stash_parsed`/`fetch_parsed` spreadsheet-mcp tools with a session-long TTL refreshed per read; checkpoint only `import_handle`. Cross-service change — NOT started.)*
- [ ] T025 [US2] Rebuild the agent gateway + spreadsheet-mcp images.

### Verify GREEN (US2)

- [ ] T026 [US2] Run `pnpm nx test movie-assistant` (T016–T019 green) and `pnpm nx test:integration movie-assistant` (T020 green) — all GREEN. (FR-013…FR-017, SC-007, SC-008)

**Checkpoint**: US1 + US2 both independently functional.

---

## Phase 5: User Story 3 — Admin disables self-registration (Priority: P2)

**Goal**: An mc-admin can toggle self-registration off/on; disabling hides the entry point and refuses registration server-side; non-admins are blocked; default is allowed.

**Independent Test**: As mc-admin toggle off → link gone + direct register 403 (no user created) → re-enable works; mc-user blocked. Passes without US1/US2/US4.

### Tests for User Story 3 (write first — Verify RED) ⚠️

- [X] T027 [P] [US3] Unit tests for the app-settings store in `frontend/mcm-app/src/bff-server/__tests__/app-settings-store.test.ts`: absent doc ⇒ `allowSelfRegistration:true`; `setAllowSelfRegistration(false, adminUuid)` upserts + stamps `updatedBy`/`updatedAt`. Verify RED.
- [X] T028 [P] [US3] **Unit** tests (mock Mongo store + Keycloak/`requireMcAdmin`) for `bff-api/admin/settings` per [contracts/bff-admin-settings.md](./contracts/bff-admin-settings.md): 401 unauth, 403 non-admin (GET+PATCH), 200 GET default, 200 PATCH persists + audit, 400 invalid body, **and assert a `logger.audit` access-denied/auth-failure event on the 401 and 403 paths (FR-007)**. File: `frontend/mcm-app/src/app/bff-api/admin/__tests__/settings.test.ts`. (Real-dependency coverage is delegated to T031.) Verify RED.
- [X] T029 [P] [US3] **Unit** tests (mock Mongo store) for `bff-api/auth/registration-status` per [contracts/bff-registration-status.md](./contracts/bff-registration-status.md): public GET returns only `{ allowed }`; reflects toggle; callable with no session. File: `frontend/mcm-app/src/app/bff-api/auth/__tests__/registration-status.test.ts`. Verify RED.
- [X] T030 [P] [US3] **Unit** test (mock Mongo store + Keycloak Admin API) for `register+api.ts` enforcement: 403 + `logger.audit('registration_refused_disabled')` + no `createUser` when disabled; existing 201 path when enabled; fail-closed on store error. File: `frontend/mcm-app/src/app/bff-api/auth/__tests__/register.test.ts` (extend). Verify RED.
- [X] T031 [US3] Integration tests (**real Mongo + real Keycloak**, no mocking the dependency under integration — constitution Test Type Integrity) in `frontend/mcm-app/tests/integration/admin-registration.integration.test.ts`: admin PATCH persists (assert against the real Mongo doc directly); non-admin 403; register refused when disabled (assert Keycloak user **absent** via the real Admin API); `afterAll` cleanup; isolated namespace. Verify RED. *(Done 2026-07-16: 3/3 GREEN against real BFF+Keycloak+Mongo. Added `findUsersByUsername` helper. Run in-network via a sidecar container joined to backend+mcm-bff networks — see session notes; host→127.0.0.1 published ports are unreliable in this dind env due to multi-homed docker-proxy return-path asymmetry.)*
- [ ] T032 [US3] Web E2E `frontend/mcm-app/tests/e2e/web/admin-registration.spec.ts`: admin disables → "Create Account" hidden for signed-out visitor → direct register blocked → re-enable restores. Verify RED.
- [ ] T033 [US3] Mobile flow `frontend/mcm-app/tests/e2e/mobile/admin-registration-disable.yaml` (logged-out start; admin toggles; register entry hidden). Verify RED.

### Implementation for User Story 3

- [X] T034 [P] [US3] Create `frontend/mcm-app/src/bff-server/app-settings-store.ts` (`getAppSettings` default-true; `setAllowSelfRegistration` upsert) and add `getAppSettingsCollection()` to `frontend/mcm-app/src/bff-server/mongo-client.ts`. Annotate the stable external names (`app_settings`, `allowSelfRegistration`) per constitution.
- [X] T035 [P] [US3] Create `frontend/mcm-app/src/app/bff-api/admin/settings+api.ts` (GET + PATCH; `requireAuth` → `requireMcAdmin`; boolean validation; `logger.audit('admin_setting_changed', …)` on change; **and `logger.audit` on the 401/403 refusal paths** — unless `requireAuth`/`requireMcAdmin` already audit access-denied centrally, in which case confirm and note it (FR-007)).
- [X] T036 [P] [US3] Create `frontend/mcm-app/src/app/bff-api/auth/registration-status+api.ts` (public GET → `{ allowed }`, single boolean only).
- [X] T037 [US3] Edit `frontend/mcm-app/src/app/bff-api/auth/register+api.ts`: enforce the toggle at the top of `_post()` (403 typed error + `logger.audit('registration_refused_disabled', …)`, fail-closed) before `createUser`.
- [X] T038 [P] [US3] Create hooks `frontend/mcm-app/src/hooks/use-app-settings.ts` (admin read/write) and `frontend/mcm-app/src/hooks/use-registration-status.ts` (public status).
- [X] T039 [US3] Create the mc-admin-only screen `frontend/mcm-app/src/app/(app)/admin/settings.tsx` (design-system toggle; no ad-hoc styles) and wire the admin-role guard via the existing `components/auth-guard.tsx` / `components/protected-route.tsx` admin-role param.
- [X] T040 [US3] Edit `frontend/mcm-app/src/screens/auth/login-screen.tsx` to hide the "Create Account" `Link` when `use-registration-status` reports disabled; guard/redirect the register route (`app/(auth)/register.tsx`) when disabled.

### Verify GREEN (US3)

- [ ] T041 [US3] Run `pnpm nx lint mcm-app`, `pnpm nx test mcm-app` (T027–T030 green), `pnpm nx test:integration mcm-app` (T031 green), then `pnpm nx e2e mcm-app -- tests/e2e/web/admin-registration.spec.ts` + `scripts/maestro-run.sh tests/e2e/mobile/admin-registration-disable.yaml` — all GREEN. (SC-001…SC-004)

**Checkpoint**: US1 + US2 + US3 independently functional.

---

## Phase 6: User Story 4 — Ownership prompt + detail navigation on TMDB add (Priority: P3)

**Goal**: The assistant asks "Do you own this movie?" before creating a TMDB-sourced movie, stores the answer, and opens the movie's detail page after adding.

**Independent Test**: Add from TMDB → ownership Yes/No asked before add → "No" stores owned=false → lands on movie detail. Passes without US1/US2/US3.

### Tests for User Story 4 (write first — Verify RED) ⚠️

- [X] T042 [P] [US4] Extend `agents/movie-assistant/tests/unit/test_organizer.py`: the add flow enters `awaiting_ownership` and emits a Yes/No `render_selection` **before** any write; the resumed tap sets `owned` (Yes→true, No→false) and proceeds to the proposal. Verify RED.
- [X] T043 [P] [US4] Add a unit test for `agents/movie-assistant/src/proposals.py` `to_movie_payload`: `owned` comes from the argument (no hardcoded `True`); default false. **Assert a "No" answer produces a payload that still targets the chosen `collectionId` with `owned=false` (FR-010) — collection membership independent of ownership.** File: `agents/movie-assistant/tests/unit/test_proposals.py`. Verify RED.
- [X] T044 [P] [US4] Extend the approval-gate unit tests (`agents/movie-assistant/tests/unit/test_approval*.py`): after a successful add, exactly one `navigate_to_movie(collectionId, movieId)` tool call is emitted with the created ids; decline/cancel ⇒ no `add_movie` call. Verify RED.
- [ ] T045 [US4] Add web E2E `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts`: add from TMDB → ownership Yes/No → "No" → approve → lands on the movie detail page (movie not owned). Verify RED.
- [ ] T046 [US4] Add mobile flow `frontend/mcm-app/tests/e2e/mobile/agent-add-ownership.yaml` (in-app navigation to the assistant, add, ownership, detail). Verify RED.

### Implementation for User Story 4

- [X] T047 [US4] Edit `agents/movie-assistant/src/proposals.py` `to_movie_payload` to accept and set `owned` (remove the hardcoded `"owned": True`).
- [X] T048 [US4] Edit `agents/movie-assistant/src/nodes/organizer.py` `_add`: add the `awaiting_ownership` stage (emit Yes/No `render_selection`, stash candidate+target, resolve on next turn) between enrich and `build_add_proposal`; add the add-stage/ownership field to `GraphState` in `graph.py` and to `_ADD_STATE_RESET` in `graph.py` **and** `approval_gate.py`. *(graph.py/approval_gate.py shared — see Dependencies)*
- [X] T049 [US4] Edit `agents/movie-assistant/src/nodes/approval_gate.py` `apply_proposal`: capture the created `movieId` from the add `ExecOutcome.data` and emit a `navigate_to_movie(collectionId, movieId)` tool call after a successful add. *(shared file — see Dependencies)*
- [ ] T050 [US4] Rebuild the agent gateway + movie-mcp images.

### Verify GREEN (US4)

- [ ] T051 [US4] Run `pnpm nx test movie-assistant` (T042–T044 green), then `pnpm nx e2e mcm-app -- tests/e2e/web/agent-add-ownership.spec.ts` + `scripts/maestro-run.sh tests/e2e/mobile/agent-add-ownership.yaml` — all GREEN. (SC-005, SC-006)

**Checkpoint**: All four stories independently functional.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T052 [P] Update the Platform Parity Table for feature 040 (per [docs/templates/feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md)) in the spec/feature docs.
- [ ] T053 [P] Update [docs/agent-layer.md](../../docs/agent-layer.md) for the new ownership stage, navigate_stage, and import-reliability behavior (if it documents these surfaces).
- [X] T054 Confirm human approval for the US1 golden re-record (T013) is recorded before merge (FR-023). *(Approval recorded per session handoff; captured in commit `8fb473e`.)*
- [ ] T055 Full regression (Final Validation Checklist): `pnpm nx test mc-service && pnpm nx test:integration mc-service`, `pnpm nx lint mcm-app && pnpm nx test mcm-app && pnpm nx test:integration mcm-app`, `pnpm nx e2e mcm-app` (**required for every feature**) `&& pnpm nx e2e:mobile mcm-app`.
- [ ] T056 Rebuild + redeploy any changed BFF/agent/MCP container, then run the final containerized web E2E (`E2E_BFF_TARGET=dev-container`) so it validates fresh images; reset to Metro-only after.
- [ ] T057 [P] `rtk gain` — confirm >80% token compression (run last).
- [ ] T058 Walk [quickstart.md](./quickstart.md) end-to-end for all four stories.

---

## Dependencies & Execution Order

### Phase order
- **Setup (P1)** → **Foundational (P2)** → **US1 (P3)** → **US2 (P4)** → **US3 (P5)** → **US4 (P6)** → **Polish (P7)**.
- Stories are independent and MAY be reordered/parallelized by a team; the numbering follows priority (US1 is the MVP).

### Story independence
- **US3 (BFF/frontend)** shares no files with the agent stories — fully parallelizable against US1/US2/US4.
- **US1, US2, US4 (agent layer)** are behavior-independent but **share files** — serialize edits to avoid conflicts:
  - `agents/movie-assistant/src/graph.py` — US1 (T009, T011), US2 (T021, T024), US4 (T048).
  - `agents/movie-assistant/src/nodes/supervisor.py` — US1 (T012); check US4 add-stage routing.
  - `agents/movie-assistant/src/nodes/approval_gate.py` — US2 (T022 degrade), US4 (T048 reset, T049 navigate emit).
  - `agents/movie-assistant/src/runtime_nodes.py` — US2 (T022–T024).
  - Do these edits in one story at a time; rebuild images per story before that story's E2E.

### Within each story
- Tests (RED) before implementation; implementation before Verify GREEN.
- Agent-source change → **rebuild images** before containerized E2E.
- US1 golden re-record (T013) requires human approval (FR-023) before merge.

### Parallel opportunities
- **US3 implementation** T034/T035/T036/T038 are `[P]` (different new files); T037/T039/T040 edit existing files (serialize per file).
- **US3 tests** T027–T030 are `[P]`.
- **US1 tests** T004–T006 are `[P]`; **US2 tests** T016–T019 are `[P]`; **US4 tests** T042–T044 are `[P]`.
- Whole-story parallelism: US3 (frontend+BFF) can run alongside any single agent story.

---

## Implementation Strategy

### MVP first
1. Phase 1 Setup → Phase 2 Foundational.
2. Phase 3 **US1 (navigate fix)** — the P1 MVP; STOP and validate independently (the reported bug is fixed end-to-end).
3. Ship/demo.

### Incremental delivery
US1 → US2 → US3 → US4, each tested and shippable on its own. US3 can be developed in parallel with the agent stories (disjoint files).

### Notes
- `[P]` = different files, no incomplete dependency.
- Commit after each task or logical group; keep the golden re-record (T013) as its own reviewable commit.
- Never let a test pass by patching the app inside the test (constitution/Testing Requirements); a broken feature must fail its test.
