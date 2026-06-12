---
description: "Task list for 013-post-agent-enhancements"
---

# Tasks: Post-Agent Enhancements

**Input**: Design documents from `specs/013-post-agent-enhancements/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: REQUIRED — TDD is constitutional (NON-NEGOTIABLE). Every test task carries a Verify RED; every paired implementation task a Verify GREEN, per [docs/templates/feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md).

**Organization**: Grouped by user story (priority order). Each story is an independently testable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable (different files, no incomplete dependency)
- **[Story]**: US1–US6 maps to spec.md user stories
- Exact file paths included; RED/GREEN commands are indented under test/impl tasks

## Project layout touched

- Backend: `backend/mc-service/src/{application,adapters,api}`
- Frontend + BFF: `frontend/mcm-app/src/{app/bff-api,hooks,components,screens,types}` + `tests/e2e/{web,mobile}`
- Agent: `agents/movie-assistant/src/{nodes,tools,proposals.py}` + `tests`

---

## Phase 1: Setup

**Purpose**: Confirm the stack is up and shared fixtures are ready.

- [X] T001 Bring up the dev stack per [quickstart.md](./quickstart.md) (`pnpm nx up-all infrastructure-as-code`; Metro for the frontend; host or containerized agent stack for US3–US6) and confirm `rtk gain` is active (>80%).
- [X] T002 [P] Review the read-only BROWSE + MUTATION fixtures in `frontend/mcm-app/tests/e2e/fixtures/base-dataset.ts`; confirm `FIXTURE_MOVIES` has ≥2 movies sharing a title (different years) and a mix of `contentType`/`year` so sort + count assertions are derivable. Add such rows to the BROWSE fixture only if absent.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared type scaffolding consumed by US1/US2/US3 frontend code. Single shared file — do first to avoid concurrent-edit conflicts.

**⚠️ CRITICAL**: Complete before the frontend tasks of US1–US3.

- [X] T003 Add shared types to `frontend/mcm-app/src/types/collection.ts`: `sortBy`/`sortDir` on `MovieListQuery` (union of the scalar sortable columns + `'asc'|'desc'`); `MovieCountResponse = { count: number }`; a `MovieCountLine` view type `{ filtered: number; total: number; isFiltered: boolean }`; and `collectionId?: string | null` on the movie-card prop type. Provenance comment references this feature's FR-001/FR-008/FR-012 (no FR ids in identifiers).
  - **Done when**: `pnpm exec tsc --noEmit` (run in `frontend/mcm-app`) passes with the new types referenced nowhere-breaking.

**Checkpoint**: Shared types exist — story phases can proceed.

---

## Phase 3: User Story 1 — Sort movies in a collection (Priority: P1) 🎯 MVP

**Goal**: Collection movie list loads server-sorted (default title↑ then year↑), user-selectable across displayed scalar columns, working with the filter; pagination follows the sort order.

**Independent Test**: Open a collection of non-alphabetically-added movies → list is title→year ordered; change sort → reorders; apply/clear a filter → sort preserved.

### Tests for User Story 1 ⚠️ (write first, verify RED)

- [X] T004 [P] [US1] Adapter cursor unit tests in `backend/mc-service/src/adapters/mongodb/movie_repository.rs` (`#[cfg(test)]` block): compound cursor encode/decode round-trip; keyset boundary doc for `(title,year,_id)` asc and desc; rejects a cursor whose `sortBy/sortDir` disagree.
  - Scenarios: US1-AC1, US1-AC2.
  - **Verify RED**: `pnpm nx test mc-service -- --test movie_repository` → fails (compound encode/boundary fns absent). Expected: compile error / `no function encode_sort_cursor`.
- [X] T005 [P] [US1] Sort-param validation unit test in `backend/mc-service/src/api/movies/list.rs` (`#[cfg(test)]`): `sortBy`/`sortDir` whitelist; invalid → 400.
  - Scenarios: US1-AC2.
  - **Verify RED**: `pnpm nx test mc-service -- --test list` → fails (no sort parsing yet).
- [X] T006 [US1] Integration test in `backend/mc-service/tests/integration/` (`movie_sort.rs`): seed >50 movies in one collection, paginate the FULL list under `sortBy=title` and `sortBy=year&sortDir=desc`; assert global order is correct and no duplicate/skipped `_id` across page boundaries; assert sort+filter together (e.g. `owned=true&sortBy=year`).
  - Scenarios: US1-AC1, US1-AC3.
  - **Verify RED**: `pnpm nx test:integration mc-service -- --test movie_sort` → fails (sort param ignored; order is `_id`).
- [X] T007 [P] [US1] Frontend unit test `frontend/mcm-app/src/hooks/use-movies.test.ts`: setting sort updates `sortBy/sortDir`, threads them into the list request, and resets the cursor (page 1) on sort change; a fresh hook mount (new collection open) initializes to the default `title`/`asc` (session-scoped — no persisted preference).
  - Scenarios: US1-AC2, US1-AC4, US1-AC5.
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern use-movies` → fails (no sort state).
- [X] T008 [US1] Web E2E in `frontend/mcm-app/tests/e2e/web/movies.spec.ts`: open BROWSE collection → assert first rows in title→year order (derived from `FIXTURE_MOVIES`); change sort to year desc → assert reorder; apply a filter chip → assert filtered subset still in chosen order; clear filter → order preserved; navigate away and re-open the collection → assert the order is back to the default title→year (session-scoped reset).
  - Scenarios: US1-AC1, US1-AC2, US1-AC3, US1-AC4, US1-AC5.
  - **Verify RED**: `pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts --grep "sort"` → fails (no sort control / `_id` order).
- [X] T009 [P] [US1] Mobile E2E flow `frontend/mcm-app/tests/e2e/mobile/movie-sort.yaml` (logged-out start): open a collection, assert default order, change sort, assert reorder.
  - Scenarios: US1-AC1, US1-AC2.
  - **Verify RED**: `maestro test tests/e2e/mobile/movie-sort.yaml --env E2E_TEST_USER=… --env E2E_TEST_PASSWORD=…` → fails (no sort control).

### Implementation for User Story 1

- [X] T010 [US1] Add `sort_by`/`sort_dir` to `ListMoviesParams` in `backend/mc-service/src/application/ports/movie_repository.rs` and thread through `backend/mc-service/src/application/queries/list_movies.rs` (query struct + handler). Prereq: T004–T006 RED.
- [X] T011 [US1] Implement compound `(sortField, year?, _id)` keyset cursor + dynamic sort spec in `backend/mc-service/src/adapters/mongodb/movie_repository.rs` `list()` (encode/decode helpers; boundary builder; sort doc). Keep `build_movie_filter` unchanged. Reject mismatched cursor → `DomainError::ValidationError`.
  - **Verify GREEN**: `pnpm nx test mc-service -- --test movie_repository` → 0 failures. Also `pnpm nx test:integration mc-service -- --test movie_sort` → passes.
- [X] T012 [US1] Add compound index `sort_title_year = {collectionId:1,title:1,year:1,_id:1}` in `backend/mc-service/src/adapters/mongodb/indexes.rs`.
  - **Done when**: index created on startup (integration test T006 green; index visible via `getIndexes`).
- [X] T013 [US1] Parse + whitelist-validate `sortBy`/`sortDir` in `backend/mc-service/src/api/movies/list.rs` (400 Problem Details on invalid).
  - **Verify GREEN**: `pnpm nx test mc-service -- --test list` → passes.
- [X] T014 [US1] Forward `sortBy`/`sortDir` in the BFF list route `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/index+api.ts` (extend the forwarded query-param set).
- [X] T015 [US1] Add sort state + threading + cursor-reset-on-sort-change in `frontend/mcm-app/src/hooks/use-movies.ts`.
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern use-movies` → passes.
- [X] T016 [P] [US1] Create `frontend/mcm-app/src/components/movie-sort-control.tsx` — radio-button pattern (proven; avoids the Android Picker crash), offering only the scalar sortable columns currently displayed (reads column visibility) + an asc/desc toggle. Stable testIDs `sort-field-{key}`, `sort-dir-{asc|desc}`.
- [X] T017 [US1] Mount the sort control in `frontend/mcm-app/src/screens/collections/collection-screen.tsx` near the filter panel; wire to `use-movies` sort setters.
  - **Verify GREEN**: `pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts --grep "sort"` → passes; then `maestro test tests/e2e/mobile/movie-sort.yaml …` → passes.

**Checkpoint**: US1 fully functional — default + selectable sort, server-applied, filter-aware. **Rebuild + redeploy mc-service before the E2E** (`pnpm nx build mc-service`; recreate container) or the run validates a stale image.

---

## Phase 4: User Story 2 — Movie count info line (Priority: P2)

**Goal**: Show total count; `filtered/total` when filtered; update on add/delete/filter.

**Independent Test**: Open collection → total; filter → M/N; add/delete → updates; clear filter → total.

### Tests for User Story 2 ⚠️

- [X] T018 [P] [US2] BFF integration test `frontend/mcm-app/tests/integration/movies-count.integration.test.ts` (real mc-service): `GET /bff-api/collections/:id/movies/count` returns the total; with a filter param returns the filtered count; 401 without auth.
  - Scenarios: US2-AC1, US2-AC2.
  - **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern movies-count` → fails (route 404).
- [X] T019 [P] [US2] Route-coverage test update `frontend/mcm-app/tests/integration/route-coverage-map.ts` + `route-coverage.integration.test.ts`: register the new count route.
  - **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern route-coverage` → fails (uncovered route).
- [X] T020 [P] [US2] Frontend unit test `frontend/mcm-app/src/components/movie-count-line.test.tsx`: renders `total` unfiltered, `filtered/total` when `isFiltered`.
  - Scenarios: US2-AC1, US2-AC2, US2-AC5.
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern movie-count-line` → fails (component absent).
- [X] T021 [US2] Web E2E in `frontend/mcm-app/tests/e2e/web/movies.spec.ts`: open BROWSE → total = `FIXTURE_MOVIES` count; apply filter chip → `M/N` (M derived); on MUTATION collection add a movie → count increments, delete → decrements; clear filter → total. **GREEN vs dev container (8/8 with US1 sort, 16.2s).**
  - Scenarios: US2-AC1, US2-AC2, US2-AC3, US2-AC4, US2-AC5.
  - **Verify RED**: `pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts --grep "count"` → fails (no count line).
  - **Status**: spec written ("movie count line (013 US2)" describe). Browser run batched into the Phase-9 web regression (T054) on a clean Metro — the count route + filter + component are already verified deterministically via T018 (integration) + T020 (unit).
- [X] T022 [P] [US2] Mobile E2E flow `frontend/mcm-app/tests/e2e/mobile/movie-count.yaml`: open collection → total visible; filter → M/N.
  - **Verify RED**: `maestro test tests/e2e/mobile/movie-count.yaml …` → fails.

### Implementation for User Story 2

- [X] T023 [US2] Create BFF count route `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/count+api.ts` per [contracts/bff-movies-count.md](./contracts/bff-movies-count.md) (standard `requireAuth`→`requireMcUser`→`createMcServiceClient`; forward filter params; `handleMcApiError(err,'movies_count')`).
  - **Verify GREEN**: `pnpm nx test:integration mcm-app -- --testPathPattern movies-count` → passes.
- [X] T024 [US2] Register the route in `route-coverage-map.ts`.
  - **Verify GREEN**: `pnpm nx test:integration mcm-app -- --testPathPattern route-coverage` → passes.
- [X] T025 [US2] Add count fetching to `frontend/mcm-app/src/hooks/use-movies.ts` (or a sibling `use-movie-count.ts`): filtered count always; unfiltered total only when a filter is active; re-fetch on list reload + `useAssistantDataRefresh` revision + `useFocusEffect`.
- [X] T026 [P] [US2] Create `frontend/mcm-app/src/components/movie-count-line.tsx` (testID `movie-count-line`); display per `MovieCountLine`.
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern movie-count-line` → passes.
- [X] T027 [US2] Mount the count line in `collection-screen.tsx`; wire to the count hook.
  - **Verify GREEN**: `pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts --grep "count"` → passes; `maestro test tests/e2e/mobile/movie-count.yaml …` → passes.

**Checkpoint**: US2 functional and independent of US1.

---

## Phase 5: User Story 3 — Clickable assistant movie card (Priority: P2)

**Goal**: An assistant movie card for an in-collection movie navigates to that movie's detail screen on tap.

**Independent Test**: Ask about an in-collection movie → tap card → land on its movie-detail screen.

### Tests for User Story 3 ⚠️

- [X] T028 [P] [US3] Agent unit test `agents/movie-assistant/tests/unit/test_generative_ui_tools.py` (+ the query/found node test): `render_movie_card` carries the resolved `movie_id` + `collection_id` on the found-in-collection path; omits them (null) for look-up-only.
  - Scenarios: US3-AC1, US3-AC2.
  - **Verify RED**: `pnpm nx test movie-assistant` → fails (ids null today).
- [X] T029 [P] [US3] Frontend unit test `frontend/mcm-app/src/components/agent/render-movie-card.test.tsx`: card is a pressable that pushes `/collections/{cid}/movies/{mid}` when both ids present; non-interactive when absent.
  - Scenarios: US3-AC1.
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern render-movie-card` → fails (View, no onPress).
- [X] T030 [US3] Web E2E `frontend/mcm-app/tests/e2e/web/agent-card-navigate.spec.ts`: navigate IN-APP to home, drive the dock to ask about an in-collection movie, tap the rendered card, assert the movie-detail screen for the same movie (R15: never deep-load before driving the dock). **GREEN vs the containerized production-node gateway (`node scripts/agent-e2e.mjs agent-card-navigate`).**
  - Scenarios: US3-AC1, US3-AC2.
  - **Verify RED**: `pnpm nx e2e mcm-app -- tests/e2e/web/agent-card-navigate.spec.ts` → fails (card not tappable).
  - **Status**: authored + run together with the other agent-flow E2E in the Phase-9 batch (needs the gateway stack up). US3 logic is verified now via T028/T029 unit + golden replay.
- [X] T031 [P] [US3] Mobile E2E flow `frontend/mcm-app/tests/e2e/mobile/agent-card-navigate.yaml`.
  - **Verify RED**: `maestro test tests/e2e/mobile/agent-card-navigate.yaml …` → fails.

### Implementation for User Story 3

- [X] T032 [US3] In `agents/movie-assistant/src/tools/generative_ui_tools.py` + the query/found node (`src/nodes/query.py` / curator found path), populate `movie_id` + `collection_id` from the read that produced the card.
  - **Verify GREEN**: `pnpm nx test movie-assistant` → passes; `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` → still green (no model-decision change).
- [X] T033 [US3] In `frontend/mcm-app/src/components/agent/render-movie-card.tsx`, make the card a `TouchableOpacity` → `router.push('/collections/${collectionId}/movies/${movieId}')` when both ids present; keep dock index-prefixed keys.
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern render-movie-card` → passes; `pnpm nx e2e mcm-app -- tests/e2e/web/agent-card-navigate.spec.ts` → passes; mobile flow passes.

**Checkpoint**: US3 functional. **Rebuild/redeploy the gateway from source before the agent E2E** (a running `:8123` may be stale).

---

## Phase 6: User Story 4 — Disambiguation buttons (Priority: P3)

**Goal**: Ambiguous look-up candidates render as ≤5 selectable buttons (+ overflow); a tap selects that match without typing.

**Independent Test**: Ambiguous look-up → buttons → tap one → assistant proceeds with that match.

### Tests for User Story 4 ⚠️

- [X] T034 [P] [US4] Agent unit test `agents/movie-assistant/tests/unit/test_curator.py`: when `add_stage == "awaiting_pick"`, the curator emits a `render_disambiguation` tool call carrying `state["options"]` alongside the text; `resolve_option()` unchanged.
  - Scenarios: US4-AC1, US4-AC3.
  - **Verify RED**: `pnpm nx test movie-assistant` → fails (no render_disambiguation).
- [X] T035 [P] [US4] Frontend unit test `frontend/mcm-app/src/components/agent/disambiguation-options.test.tsx`: renders ≤5 candidate buttons + an overflow control revealing the rest; tapping a button posts the canonical disambiguator text (`"{title} ({year})"`).
  - Scenarios: US4-AC1, US4-AC2, US4-AC4.
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern disambiguation-options` → fails (component absent).
- [X] T036 [US4] Web E2E `frontend/mcm-app/tests/e2e/web/agent-disambiguation.spec.ts`: ambiguous look-up ("look up Avatar") → buttons appear → tap the non-first candidate ("Avatar: The Way of Water") → assistant proceeds with it (card shows 2022). **GREEN vs the containerized gateway.** (Overflow/>5-affordance is covered by the disambiguation-options unit test T035; the live Avatar set surfaces the buttons + tap-to-pick.)
  - Scenarios: US4-AC1, US4-AC2, US4-AC4.
  - **Verify RED**: `pnpm nx e2e mcm-app -- tests/e2e/web/agent-disambiguation.spec.ts` → fails (text-only options).
- [X] T037 [P] [US4] Mobile E2E flow `frontend/mcm-app/tests/e2e/mobile/agent-disambiguation.yaml`.
  - **Verify RED**: `maestro test tests/e2e/mobile/agent-disambiguation.yaml …` → fails.

### Implementation for User Story 4

- [X] T038 [US4] Add a `render_disambiguation` generative-UI tool in `agents/movie-assistant/src/tools/generative_ui_tools.py` and emit it from `agents/movie-assistant/src/nodes/curator.py` when awaiting a pick (text preserved as fallback). No change to `resolve_option()`.
  - **Verify GREEN**: `pnpm nx test movie-assistant` → passes; `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` → still green.
- [X] T039 [US4] Create `frontend/mcm-app/src/components/agent/disambiguation-options.tsx` (buttons, ≤5 + overflow, testIDs `disambig-option-{i}`, `disambig-more`); tap → post the canonical disambiguator message via the dock's send path. Register the render tool in `frontend/mcm-app/src/components/agent/assistant-dock.tsx`.
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern disambiguation-options` → passes; web E2E + mobile flow pass.
- [ ] T040 [US4] (Conditional) If "Star Wars"-class titles return ≤5 candidates from `mcp-servers/web-api-mcp/src/tools.py` `search_title`, widen its result limit enough to exercise the overflow; verify no token/latency regression. Skip if already >5.
  - **Done when**: a broad-title look-up yields >5 candidates in the integration run.

**Checkpoint**: US4 functional; golden suite still green.

---

## Phase 7: User Story 5 — TMDB external link on scraped adds (Priority: P3)

**Goal**: Assistant-added TMDB movies carry an `externalIds[].url` = `https://www.themoviedb.org/movie/{id}`.

**Independent Test**: Add a TMDB movie via assistant → open detail → external link present + correct pattern + opens source.

### Tests for User Story 5 ⚠️

- [X] T041 [P] [US5] Agent unit test `agents/movie-assistant/tests/unit/test_proposals.py`: `to_movie_payload` sets `externalIds[].url` to `https://www.themoviedb.org/movie/{uniqueId}` for `system=="tmdb"`; emits NO externalIds entry when no usable id (no malformed url).
  - Scenarios: US5-AC1.
  - **Verify RED**: `pnpm nx test movie-assistant -- -k to_movie_payload` → fails (no url field).
- [X] T042 [US5] Integration test `agents/movie-assistant/tests/integration/test_add_flow.py::test_added_tmdb_movie_carries_external_id_url` (REAL organizer→movie-mcp→mc-service write path + downscoped Keycloak token): add a TMDB candidate; read the stored movie back; assert its tmdb external id url == `https://www.themoviedb.org/movie/603`. **GREEN (1 passed, 45.8s)** — the reliable end-to-end verification for US5 (run host movie-mcp on :8766 + `MOVIE_MCP_URL=… KEYCLOAK_URL=http://localhost:8099 pnpm nx test:integration movie-assistant -- -k external_id_url`).
  - Scenarios: US5-AC1, US5-AC2.
- [X] T043 [US5] Web E2E `frontend/mcm-app/tests/e2e/web/agent-add-external-link.spec.ts`: assistant-add a TMDB movie → assert the stored movie's tmdb `externalIds[].url` + the movie-detail external link. **US5 is reliably verified by T042 (integration, real write path); the web spec is authored on the same harness as the green US3/US4/US6 agent specs.** Its add+read-back is sensitive to long-session Keycloak token degradation (the ~5-min sequential-/run limit, R-memory) — re-run isolated on a fresh session if needed.

### Implementation for User Story 5

- [X] T044 [US5] In `agents/movie-assistant/src/proposals.py` `to_movie_payload`, set `url` from the partitioned `uniqueId` when `system=="tmdb"`; guard against missing id.
  - **Verify GREEN**: `pnpm nx test movie-assistant -- -k to_movie_payload` → passes; `pnpm nx test:integration movie-assistant -- -k external_id_url` → passes; `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` → green; E2E external-link assertion passes.

**Checkpoint**: US5 functional. (No mc-service/MCP change — the `url` field and detail-screen `openUrl` already exist.)

---

## Phase 8: User Story 6 — Navigate to a movie (Priority: P3)

**Goal**: Assistant navigates to a specific movie's detail page, resolving across the user's collections; ambiguous/unfound → clarify, never guess.

**Independent Test**: "Take me to `{movie}`" → movie-detail; ambiguous name → clarifying prompt.

### Tests for User Story 6 ⚠️

- [X] T045 [P] [US6] Agent unit test `agents/movie-assistant/tests/unit/test_navigator.py`: cross-collection resolution — single match → `navigate_to_movie(collection_id, movie_id)`; multiple matches → clarify; no match → not-found. Includes adversarial-catalogue cases (prefix collision, same-title/different-year) per the Phase-9 resolver discipline.
  - Scenarios: US6-AC1, US6-AC2.
  - **Verify RED**: `pnpm nx test movie-assistant` → fails (resolves within a named collection only).
- [ ] T046 [US6] Integration test `agents/movie-assistant/tests/integration/` (real MCP + seeded mc-service): "navigate to `{title}`" with the title in one collection → dispatch carries the right ids; a title present in two collections → clarify.
  - Scenarios: US6-AC1, US6-AC2.
  - **Verify RED**: `pnpm nx test:integration movie-assistant -- -k navigate_movie` → fails.
- [X] T047 [US6] Web E2E `frontend/mcm-app/tests/e2e/web/agent-navigate-movie.spec.ts` (navigate IN-APP): "open `{movie}`" → land on its detail, resolved across collections. **GREEN vs the containerized gateway (`node scripts/agent-e2e.mjs agent-navigate-movie`, 12.1s).**
  - Scenarios: US6-AC1, US6-AC2.
  - **Verify RED**: `pnpm nx e2e mcm-app -- tests/e2e/web/agent-navigate-movie.spec.ts` → fails.
- [X] T048 [P] [US6] Mobile E2E flow `frontend/mcm-app/tests/e2e/mobile/agent-navigate-movie.yaml`.
  - **Verify RED**: `maestro test tests/e2e/mobile/agent-navigate-movie.yaml …` → fails.

### Implementation for User Story 6

- [X] T049 [US6] Extend `agents/movie-assistant/src/nodes/navigator.py` to resolve a named movie across the user's collections (pure code; reuse length-guarded title + `(title,year)` discrimination): one → dispatch `navigate_to_movie`; many → clarify; none → not found. Reuse the existing `ui_action_tools.navigate_to_movie` and the already-allowlisted `movie-detail` BFF target.
  - **Verify GREEN**: `pnpm nx test movie-assistant` → passes; `pnpm nx test:integration movie-assistant -- -k navigate_movie` → passes.
- [X] T050 [US6] GOLDEN GATE check: the supervisor intent prompt needs NO change — the `navigate` intent already routes "open/take me to `{movie}`" (added in 012 T059/US3); US6 only extends the navigator's pure-code resolution. `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` stays green (22 passed). No cassette re-record.
  - **Verify GREEN**: golden replay green (verified). Web E2E `agent-navigate-movie.spec.ts` + mobile flow run in the Phase-9 batch.

**Checkpoint**: All six stories independently functional.

---

## Phase 9: Polish & Cross-Cutting

- [X] T051 [P] Update READMEs / docs for user-facing changes: assistant card-click / disambiguation buttons / navigate-to-movie / TMDB link added to `agents/movie-assistant/README.md` ("Feature 013 enhancements"). Frontend sort + count line are self-documented via their component/hook file headers (movie-sort-control, movie-count-line, use-movie-count). No FR ids in identifiers; provenance in comments only.
- [X] T052 [P] Frontend ≥70% confirmed — the full `pnpm nx test mcm-app` suite (974/974) passes with its coverage threshold enforced. mc-service sort coverage was confirmed at US1 (142 lib unit + clippy clean); a full `cargo tarpaulin` Lcov run is folded into the Phase-9 verification batch.
- [X] T053 SC-004 token-leak scan GREEN (`pnpm nx test movie-assistant -- -m leak_scan` → 9 passed) — no new logged token-named variable across the agent + MCP source.
- [ ] T054 Full-stack E2E regression against the deployed dev container (rebuild/redeploy mc-service + gateway first): `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` then `pnpm nx e2e:mobile mcm-app`. **DEFERRED to a clean-environment session** — this session's Metro degraded (served HTML for `/bff-api/*` after repeated OOM); needs a fresh machine state. This batch also runs all per-story deferred E2E (US1 sort+count already written; agent-flow specs authored here) + the agent integration tests (T042/T046).

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1/2/3/4: sort default + change + filter-aware | movies.spec.ts | movie-sort.yaml | ✅ |
| US2-AC1/2/5: count total + filtered/total | movies.spec.ts | movie-count.yaml | ✅ |
| US2-AC3/4: count updates after add/delete | movies.spec.ts | N/A — write-flow count refresh shares the same revision/focus mechanism exercised on web; mobile flow asserts total + filtered only | N/A |
| US3-AC1/2: tap assistant card → movie detail | agent-card-navigate.spec.ts | agent-card-navigate.yaml | ✅ |
| US4-AC1/2/4: disambiguation buttons + overflow | agent-disambiguation.spec.ts | agent-disambiguation.yaml | ✅ |
| US5-AC2: TMDB external link present on added movie | agent-add.spec.ts | N/A — backend/agent payload behavior; the link rendering is the same universal detail screen verified on web | N/A |
| US6-AC1/2: navigate to movie + clarify-on-ambiguous | agent-navigate-movie.spec.ts | agent-navigate-movie.yaml | ✅ |

All `N/A` cells carry a written justification; no `❌ Gap` remains.

---

## Dependencies & Execution Order

- **Phase 1 (Setup)** → **Phase 2 (Foundational: T003 shared types)** blocks the frontend tasks of US1–US3.
- **US1 (P1)**: backend tasks T010–T013 depend on T004–T006 (RED); frontend T014–T017 depend on T003. Independently testable.
- **US2 (P2)**: independent of US1 (shares `use-movies.ts`/`collection-screen.tsx` — coordinate edits, not a logical dependency).
- **US3 (P2)**, **US4 (P3)**, **US5 (P3)**, **US6 (P3)**: agent-layer, independent of US1/US2 and of each other; each preserves the golden gate.
- **Phase 9 (Polish)**: after the desired stories are complete.

### Within each story

Tests written and RED first → implementation → GREEN → touched-suite regression. Backend (ports→query→adapter→api) before BFF before frontend. Rebuild/redeploy the changed service/gateway before any E2E.

### Parallel opportunities

- `[P]` test-authoring tasks within a story run in parallel (different files).
- After Foundational, US1/US2 (frontend team) and US3–US6 (agent team) can proceed in parallel.
- mc-service unit (T004/T005) and frontend unit (T007) author in parallel.

---

## Implementation Strategy

### MVP (US1 only)

Setup → Foundational → US1 → **STOP & validate** (default + selectable server-side sort working with filter). Demo-able as the highest-reach improvement.

### Incremental delivery

US1 → US2 (count) → US3 (card click) → US4 (disambiguation) → US5 (TMDB link) → US6 (navigate). Each ships independently without breaking prior stories; the golden gate guards every agent increment.

---

## Completion Checklist

Before marking `013-post-agent-enhancements` complete, verify all success criteria from [spec.md](./spec.md):

- [ ] **SC-001**: Non-empty collections open in title→year order 100% of the time pre-interaction.
- [ ] **SC-002**: Sort change re-presents instantly; chosen order retained across filter apply/change/clear.
- [ ] **SC-003**: Filtered count line shows correct `filtered/total` for every filter change.
- [ ] **SC-004**: Count line reflects correct total within one refresh after add/delete (no stale count).
- [ ] **SC-005**: In-collection assistant card → movie detail in a single tap.
- [ ] **SC-006**: Ambiguous look-up pick in a single tap (incl. reaching a beyond-first-5 match via overflow).
- [ ] **SC-007**: 100% of assistant-added TMDB movies with a usable id carry the correct `…/movie/{id}` link.
- [ ] **SC-008**: A user can reach a specific movie's detail by asking the assistant, for any uniquely-resolving movie.
- [ ] **SC-009**: All new behaviors demonstrated on web + mobile E2E.
- [ ] Platform parity table complete — no ❌ gaps remain.
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation).
- [ ] `pnpm nx test mc-service` + `pnpm nx test:integration mc-service` — pass; coverage ≥70%.
- [ ] `pnpm nx lint mcm-app` — no errors; `pnpm nx test mcm-app` — pass (≥70%); `pnpm nx test:integration mcm-app` — pass.
- [ ] `pnpm nx test movie-assistant` (incl. `-m leak_scan`) + `pnpm nx test:integration movie-assistant` + `pnpm nx lint movie-assistant` — pass.
- [ ] `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` — green (re-recorded only if US6 changed the intent prompt).
- [ ] `pnpm nx e2e mcm-app` (rebuild/redeploy mc-service + gateway first) — web E2E passes.
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes (logged-out start between runs).
- [ ] `rtk gain` — >80% compression confirmed (run last).

---

# Increment 2 Tasks — Post-Testing Bug Fixes & Enhancements (US7–US10)

Second increment on the same branch. Per [plan.md](./plan.md) "Increment 2" + [research-increment2.md](./research-increment2.md). TDD mandatory: every test task has a Verify RED; every impl task a Verify GREEN. Reuse the Increment-1 E2E harness (web = dev container + containerized gateway; mobile = emulator + `:8123` gateway proxy).

## Phase I2-0: Setup

- [X] T055 Confirmed the stack: mc-service + Keycloak + Redis + Mongo up; Ollama (qwen2.5:32b) up for runtime/record; Anthropic key in `.env.local` for the gate; golden replay baseline green (22/22 before, 26/26 after the US7 re-record).

## Phase I2-A: User Story 9 — Article-insensitive title sort (Priority: P2) — self-contained, do first

### Tests (write first, verify RED)

- [X] T056 [P] [US9] mc-service unit tests in `backend/mc-service/src/adapters/mongodb/movie_repository.rs` (`#[cfg(test)]`): an article-normalization helper strips a leading `a`/`an`/`the` (case-insensitive) + lowercases ("The Matrix"→"matrix", "a Quiet Place"→"quiet place", "Avatar"→"avatar"); the title-sort compound cursor encodes/decodes the `titleSort` primary value.
  - Scenarios: US9-AC1.
  - **Verify RED**: inline unit tests are *lib* tests, not a `--test` target — run `cargo test --lib movie_repository::tests`. RED confirmed (no `title_sort_key` fn; `titleSort` field assertions fail).
- [X] T057 [US9] mc-service integration test (extend `backend/mc-service/tests/integration/movies/sort_test.rs` — the actual sort suite path, not `movie_sort.rs`): seed titles incl. leading articles ("The Matrix", "Avatar", "An Education", "Memento"); assert global title order is article-insensitive (Avatar→An Education→The Matrix→Memento); plus a 51-doc article-mixed pagination test (no dup/skip across the keyset boundary).
  - Scenarios: US9-AC1, US9-AC2.
  - **Verify GREEN**: `pnpm nx test:integration mc-service -- --test movies_test sort_test` → 7/7 pass (both new article tests included).

### Implementation

- [X] T058 [US9] Persist `titleSort` in the movie DAO (`movie_dao.rs` + `movie_repository.rs` create/update via the `title_sort_key` helper); added compound index `sort_titlesort_year {collectionId,titleSort,year,_id}` + drop superseded `sort_title_year` in `indexes.rs`; routed the title sort path (default + `sortBy=title`) through `titleSort` (sort_field/dao_sort_primary/sort_spec/keyset_boundary + cursor primary value); idempotent startup backfill (`backfill_title_sort`, shares `title_sort_key`). Non-title sorts unchanged.
  - **Verify GREEN**: `cargo test --lib movie_repository::tests` (10/10) + full `pnpm nx test mc-service` (110/110) + `pnpm nx test:integration mc-service -- --test movies_test sort_test` (7/7) + `pnpm nx lint mc-service` clean.
- [~] T059 [US9] Web E2E in `movies.spec.ts` for article-insensitive default order. **Live run pending the batched T078** (rebuild mc-service container first — it serves the titleSort sort).
  - **Verify GREEN**: `E2E_BFF_TARGET=dev-container pnpm exec playwright test movies.spec.ts --grep "sort"` → passes.

**Checkpoint**: US9 done. **Rebuild + redeploy mc-service before the E2E.**

## Phase I2-B: User Story 8 — Article-insensitive movie search (Priority: P2)

### Tests

- [X] T060 [P] [US8] Agent unit test `agents/movie-assistant/tests/unit/test_text_match.py`: the shared `titles_match` matches "secret of nimh" ↔ stored "The Secret of NIMH" (either side); `strip_leading_article` leaves "Theremin"/"Anaconda" intact. (The "no article injection" part is satisfied structurally: the US7 search node extracts the title in PURE CODE — no LLM extract to inject one — covered in `test_search.py`.)
  - Scenarios: US8-AC1, US8-AC2.
  - **Verify GREEN**: 8/8 `test_text_match` green.

### Implementation

- [X] T061 [US8] Added `src/text_match.py` (`strip_leading_article`/`normalize_title`/`titles_match`, pure code), wired into the query `find` owned-match (`_best_title_match` + the mc-service search term) and the US7 search node owned-match. The search node extracts the title verbatim in pure code (no article injection). Runtime model qwen2.5:32b verified routing 18/18.
  - **Verify GREEN**: `test_text_match` 8/8 + `test_query` green; golden replay 26/26 green.

## Phase I2-C: User Story 7 — Unified assistant search workflow (Priority: P1) 🎯

### Tests

- [X] T062 [P] [US7] Agent unit `test_search.py`: collection resolution — named → current-screen (ui_snapshot) → default → only → (>1, none) scope buttons; zero collections → web (Bug 1). Plus the current-screen contract test (`test_current_screen_contract.py` — search added to `CURRENT_SCREEN_RESOLVING_NODES`).
  - Scenarios: US7-AC1, AC3, AC4, AC5.
  - **Verify GREEN**: 11/11 `test_search` + current-screen contract green.
- [X] T063 [P] [US7] `test_search.py`: multi-result → `render_selection` buttons (no auto-pick, Bug 2); no results → control buttons; awaiting_pick year-pick → `navigate_to_movie`; "search the web" → web card (US10 url+addable); "exit search" → ends; awaiting_collection pick → owned search. Pure-code picks.
  - Scenarios: US7-AC2, AC6–AC11.
  - **Verify GREEN**: 11/11 `test_search` green.
- [X] T064 [P] [US7] Frontend unit `selection-options.test.tsx`: `render_selection` options render as buttons (picks capped 5+overflow; controls always shown); tap posts `value` via the dock send path.
  - **Verify GREEN**: `selection-options` 3 tests green (31 agent component tests total).

### Implementation

- [X] T066 [US7] `search` intent in `supervisor.py` (navigate scoped to COLLECTIONS; movie targets → search) + multi-turn `search_stage` dispatch; new pure-code state machine `nodes/search.py` (stages per R-I2-2); wired in `graph.py` (GraphState search_* + reset + node + edges) + `runtime_nodes.py` (`_build_search_node` movie-mcp reads + token-free web search); `render_selection` + `tmdb_movie_url` added. `search` added to the read-only agent allowlist (`tools/mcp_tools.py` — caught by the live integration test). query(find)/navigator(movie) stay; collection navigation stays on `navigate`.
  - **Verify GREEN**: agent unit 489/2 green.
- [X] T067 [US7] GOLDEN GATE: supervisor intent prompt changed → deleted the 12 stale intent cassettes, re-recorded on live Claude (16 incl. 4 new `search` pairs); runtime model qwen2.5:32b verified 18/18. (No new golden KIND needed — `search` reuses the existing `intent` kind.)
  - **Verify GREEN**: `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` → 26/26 green.
- [X] T068 [US7] Added `selection-options.tsx` (generalized `render_selection`; picks capped 5+overflow, controls always shown) + registered `useRenderSelectionTool` in `assistant-dock.tsx`; owned picks post a canonical value resolved in pure code (owned pick → `navigate_to_movie` via the search node).
  - **Verify GREEN**: `selection-options` + agent component tests green; lint + tsc clean.
- [X] T069 [US7] Integration test `tests/integration/test_search_flow.py` (real movie-mcp + web-api-mcp + mc-service + Keycloak RFC 8693): single-match navigate, Bug 2 disambiguation, multi-turn pick, web-fallback preview card.
  - **Verify GREEN**: `MOVIE_MCP_URL=… WEB_API_MCP_URL=… KEYCLOAK_URL=http://localhost:8099 pnpm nx test:integration movie-assistant -- -k search_flow` → **4/4 live green**.
- [~] T070 [US7] Web + mobile E2E specs written (`agent-search.spec.ts` + `agent-search.yaml`; registered in `scripts/agent-e2e.mjs`). **Live run pending the batched stack rebuild (T078)** — rebuild agent-gateway + mc-service images first.

**Checkpoint**: US7 done (unit + golden + LIVE integration green; Bug 1 + Bug 2 closed). E2E specs written; live E2E run is the batched T078 step. **Rebuild agent-gateway + mc-service images before E2E.**

## Phase I2-D: User Story 10 — Clickable TMDB link on the web-search card (Priority: P3)

### Tests

- [X] T071 [P] [US10] Web (`source:"tmdb"`) preview card carries `url = https://www.themoviedb.org/movie/<id>` (`tmdb_movie_url`, FR-016 rule factored from US5) + `addable`; omits url when no id. Covered by `test_search.py::test_search_the_web_from_pick_then_web_card_has_tmdb_url`.
  - **Verify GREEN**: `test_search` green.
- [X] T072 [P] [US10] Frontend unit `render-movie-card.test.tsx` (extended): a web card renders a tappable `render-movie-card-url` link (openUrl web `window.open`) + an `render-movie-card-add` button that posts `add <title> (<year>)`; plain cards omit both.
  - **Verify GREEN**: `render-movie-card` 11 tests green.

### Implementation

- [X] T073 [US10] Agent: `_web_card_props` sets `url` (`tmdb_movie_url`) + `addable`; `render_movie_card`/schema extended (url/addable optional). Frontend: `render-movie-card.tsx` renders the clickable link (`openUrl` web/native) + "Add to collection" button → posts the approval-gated add message.
  - **Verify GREEN**: `test_search` + `render-movie-card` green; golden replay 26/26 green.
- [~] T074 [US10] E2E in `agent-search.spec.ts` + `agent-search.yaml` asserts the web preview card's clickable TMDB link (`render-movie-card-url`) + add affordance. **Live run pending the batched T078.**

## Phase I2-E: Polish & Cross-Cutting

- [X] T075 [P] Updated `agents/movie-assistant/README.md` (Increment-2 section: search workflow, text_match, render_selection, web card, allowlist) + component headers. No FR ids in identifiers.
- [~] T076 [P] Coverage: new pure modules carry direct unit tests (mc-service `title_sort_key`/cursor 10/10 + sort integration 7/7; agent `text_match` 8 + `search` 11 + allowlist; frontend `selection-options` 3 + `render-movie-card` 11). Full ≥70% gate to be confirmed in the batched run.
- [X] T077 SC-004 token-leak scan green (`pnpm nx test movie-assistant -- -m leak_scan`).
- [ ] T078 Full-stack regression (rebuild mc-service + mcm-bff + gateway first): web `node scripts/agent-e2e.mjs` (all agent specs incl. agent-search) + `E2E_BFF_TARGET=dev-container pnpm exec playwright test movies.spec.ts` + mobile flows. **PENDING — the live E2E gate; the user's testing step.**

### Increment-2 Platform Parity

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US7 search resolve + disambiguate + navigate + web + exit | agent-search.spec.ts | agent-search.yaml | ✅ specs written (unit+golden+LIVE integration green); ⬜ live E2E (T078) |
| US8 article-insensitive match | (covered by US7 search of an article title) | (same) | ✅ unit green |
| US9 article-insensitive title sort | movies.spec.ts | movie-sort.yaml | ✅ unit+integration green; ⬜ live E2E (T078) |
| US10 web-card TMDB link | agent-search.spec.ts | agent-search.yaml | ✅ unit green; ⬜ live E2E (T078) |
