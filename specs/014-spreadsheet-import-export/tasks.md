---
description: "Task list for Spreadsheet Import & Export (feature 014)"
---

# Tasks: Spreadsheet Import & Export (Movie Assistant)

**Input**: Design documents from `specs/014-spreadsheet-import-export/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: TDD is mandatory (constitution NON-NEGOTIABLE). Every test task carries a **Verify RED** sub-line; its paired implementation carries a **Verify GREEN**. Run isolated (single test/file), never the full suite, for RED/GREEN.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete-task dependency)
- **[Story]**: US1 (optional language) · US2 (import) · US3 (export) · US4 (guided clarification)
- Exact file paths included. Commands are Nx-first.

## Conventions

- Backend (Rust): `pnpm nx test mc-service` / `test:integration mc-service`. Unit tests inline `#[cfg(test)]`.
- Frontend (Expo): `pnpm nx test mcm-app` (unit), `pnpm nx e2e mcm-app` (Playwright web), `maestro test` (mobile).
- Agent/MCP (Python): `pnpm nx test|test:integration|lint <project>`; golden gate `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant`.
- Agent E2E: `node scripts/agent-e2e.mjs` against the containerized production-node gateway (rebuild `agent-gateway:latest`, `spreadsheet-mcp:latest`, and `mcm-bff:latest` first).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffold the new MCP server and wire it into the stack.

- [X] T001 [P] Scaffold `mcp-servers/spreadsheet-mcp/` (pyproject.toml, Dockerfile, `src/server.py` skeleton) via the `@nxlv/python` Nx generator, mirroring `mcp-servers/movie-mcp/` layout.
- [X] T002 [P] Add `openpyxl` to `mcp-servers/spreadsheet-mcp/pyproject.toml`; configure ruff + mypy targets; pin the lockfile.
- [X] T003 Add `spreadsheet-mcp` service to root `compose.yaml` (`--profile agents`) and `infrastructure-as-code/docker/`; set `enable_dns_rebinding_protection=False` in `src/server.py` transport security (012 DNS-rebinding gotcha); expose `SPREADSHEET_MCP_URL`.
- [X] T004 Register `spreadsheet-mcp` in the gateway's shared MCP client and add it to the per-node tool allowlist for `import_collection` + `export_collection` only (`agents/movie-assistant/src/tools/mcp_tools.py`); add to `production_nodes_enabled` URL set. DONE: allowlists in mcp_tools.py; `RuntimeNodeConfig.spreadsheet_mcp_url` from `SPREADSHEET_MCP_URL` (env); `SPREADSHEET_MCP_URL=http://spreadsheet-mcp:8000/mcp` in the gateway compose; spreadsheet-mcp compose has `REDIS_URL` + backend-network. (Decision: spreadsheet_mcp_url is OPTIONAL — it does NOT gate `production_nodes_enabled`, so a gateway without it keeps serving existing flows and the import node degrades gracefully.)

---

## Phase 2: Foundational (Blocking Prerequisites for US2/US3/US4)

**Purpose**: Shared file-transport plumbing the import/export stories need.

**⚠️ CRITICAL**: Blocks US2, US3, US4. **US1 does NOT depend on this phase** (it is a self-contained mc-service + frontend change) and may proceed immediately after Phase 1 is irrelevant to it.

- [X] T005 Implement the transient upload store utility in `frontend/mcm-app/src/bff-server/transient-file-store.ts` (short-TTL, opaque single-use handle, size guard; Redis-backed with an `import:file:` prefix per research R3). Unit test in `frontend/mcm-app/src/bff-server/unit-tests/transient-file-store.test.ts`.
  - Verify RED: `pnpm nx test mcm-app -- --testNamePattern "transient-file-store"` → fails (module absent).
  - Verify GREEN: same command → passes (put/get/expire/single-use).
- [X] T006 Add `spreadsheet_tools.py` MCP bindings (`parse_spreadsheet`, `build_workbook`) in `agents/movie-assistant/src/tools/spreadsheet_tools.py`, callable in pure code from nodes (handle arg, never an LLM-chosen arg).

**Checkpoint**: File transport ready — import/export nodes can be built.

---

## Phase 3: User Story 1 - Make movie language optional (Priority: P1) 🎯 MVP

**Goal**: A movie can be created/edited with no language, across mc-service and the frontend form/display; existing data unaffected.

**Independent Test**: Add a movie with a blank language → saved with no error → visible in its collection with a neutral placeholder; filter/sort handle it. (Backend + both clients; no agent involvement.)

### Backend (mc-service) — Clean Architecture

- [X] T007 [P] [US1] Unit test: `create_movie`/`update_movie` accept absent/empty `language` (no `ValidationError`); `title` still required. In `backend/mc-service/src/application/commands/create_movie.rs` + `update_movie.rs` `#[cfg(test)]`.
  - Verify RED: `pnpm nx test mc-service -- create_movie` → fails (still rejects empty language).
  - Covers: US1-AC1.
- [X] T008 [US1] Implement: `language: Option<String>` in `domain/movie.rs` (entity + constructor); drop `RequiredStringSpec` on `language` in both command handlers; `Option<String>` in `application/dtos/movie_dto.rs` (Create/Update/Response).
  - Verify GREEN: `pnpm nx test mc-service -- create_movie` → passes. Covers: US1-AC1.
- [X] T009 [P] [US1] Unit test: `movie_dao` deserializes a document with no `language` field (serde default). In `backend/mc-service/src/adapters/mongodb/daos/movie_dao.rs` `#[cfg(test)]`.
  - Verify RED: `pnpm nx test mc-service -- movie_dao` → fails (missing-field deser error).
- [X] T010 [US1] Implement: `language: Option<String>` + `#[serde(default)]` in `movie_dao.rs` mapping both directions.
  - Verify GREEN: `pnpm nx test mc-service -- movie_dao` → passes.
- [X] T011 [US1] Integration test (real Mongo): `POST …/movies` with no `language` → `201`; `GET` returns `language` null; `GET …/movies/filter-options` excludes a null/empty language facet. In `backend/mc-service/tests/integration/`.
  - Verify RED: `pnpm nx test:integration mc-service -- --test movie_language_optional` → fails.
  - Covers: US1-AC1, US1-AC3.
- [X] T012 [US1] Implement: ensure `get_filter_options` skips null/absent language in its distinct aggregation.
  - Verify GREEN: same command → passes.
- [X] T013 [P] [US1] Update `api-specs/mc-service-api.yaml` per [contracts/mc-service-language-delta.md](./contracts/mc-service-language-delta.md) (remove `language` from `required` on Create/Update/Movie schemas).
  - Done when: the spec validates and `language` is optional on all movie schemas.

### Frontend (mcm-app)

- [X] T014 [P] [US1] Unit test: `movie-form` submits with a blank language (no "Language is required" error; no `*`). In `frontend/mcm-app/src/components/unit-tests/movie-form.test.tsx`.
  - Verify RED: `pnpm nx test mcm-app -- --testNamePattern "movie-form.*language"` → fails (validation blocks).
  - Covers: US1-AC1.
- [X] T015 [US1] Implement: remove the required-language validation + `*` label in `frontend/mcm-app/src/components/movie-form.tsx`; `language?: string` in `frontend/mcm-app/src/types/collection.ts` (Movie, Create/Update requests).
  - Verify GREEN: same command → passes. Covers: US1-AC1.
- [X] T016 [P] [US1] Unit test: `movie-list-item` + `movie-detail` render a neutral placeholder when `language` is absent. In the respective `unit-tests/*.test.tsx`.
  - Verify RED: `pnpm nx test mcm-app -- --testNamePattern "language placeholder"` → fails.
  - Covers: US1-AC2, US1-AC3.
- [X] T017 [US1] Implement: placeholder rendering + null-safe sort/filter in `movie-list-item.tsx`, `movie-detail.tsx`, `movie-list.tsx`, `column-selector.tsx`, `movie-sort-control.tsx`.
  - Verify GREEN: same command → passes. Covers: US1-AC2, US1-AC3.
- [X] T018 [US1] Web E2E: add a movie with blank language → row appears; sort/filter by language groups it consistently. In `frontend/mcm-app/tests/e2e/web/movies.spec.ts` (writes → MUTATION fixture; `afterEach` BFF teardown).
  - Verify RED: `pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts --grep "without language"` → fails.
  - Verify GREEN: same → `1 passed`. Covers: US1-AC1, US1-AC4.
- [X] T018a [US1] Web E2E: edit a movie, clear its language, save → persists with no language. In `frontend/mcm-app/tests/e2e/web/movies.spec.ts` (writes → MUTATION fixture; `afterEach` BFF teardown).
  - Verify RED: `pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts --grep "clear language"` → fails.
  - Verify GREEN: same → `1 passed`. Covers: US1-AC2.
- [X] T019 [US1] Mobile Maestro: add a movie with no language. Extended `frontend/mcm-app/tests/e2e/mobile/movie-add.yaml` (the "014 US1: add a movie with NO language" block — fills title+year, leaves language blank, asserts the `movie-detail-language` "—" placeholder, teardown). **LIVE-GREEN on the emulator** (full flow incl. SSO login → navigate → add-with-language → add-without-language → "—" placeholder asserted → delete, all COMPLETED). **Required a FRESH emulator** (`-no-snapshot-load -gpu swiftshader_indirect`): a snapshot-loaded emulator's `adb reverse` listener flaps → device Chrome `ERR_CONNECTION_REFUSED` on Keycloak `localhost:8099`. Also had to temporarily relax `AGENT_RATE_LIMIT_REQUESTS` in `.env.local` (the CopilotKit dock's runtime-info poll 429'd → a LogBox overlay covered the form — the 013 pre-existing `runtime_info_fetch_failed`, not a US1 bug; reverted after).
  - Verify GREEN: `maestro test frontend/mcm-app/tests/e2e/mobile/movie-add.yaml --env …` → flow passes.

**Checkpoint**: US1 fully functional on backend + web + mobile, independently testable. **MVP deliverable.**

---

## Phase 4: User Story 2 - Import a spreadsheet into matching collections (Priority: P1)

**Goal**: Upload a CSV/`.xlsx`; the assistant parses eligible tabs, auto-matches exact-name tabs, maps high-confidence columns, normalizes articles, splits multi-values, dedups, previews, and on confirm creates/updates best-effort without blanking.

**Independent Test**: Import `docs/test-data/sample-movies.xlsx` after picking the target collection for the `Sample` tab → correct movies created with multi-values split + titles normalized; re-run is idempotent.

### spreadsheet-mcp

- [X] T020 [P] [US2] Unit test: `parse_spreadsheet` returns tabs with eligibility (data tab eligible; `Lists`/`Category`/`MediaType`/`YesNo` ineligible), columns+sampleValues, rows keyed by header. Fixture: `docs/test-data/sample-movies.xlsx`. In `mcp-servers/spreadsheet-mcp/tests/unit/test_parse.py`.
  - Verify RED: `pnpm nx test spreadsheet-mcp -- -k parse` → fails (tool absent).
  - Covers: US2-AC1.
- [X] T021 [US2] Implement `parse_spreadsheet` (openpyxl `read_only` for `.xlsx`, stdlib `csv` for CSV; reads bytes via the transient handle; rejects corrupt/empty/unsupported per FR-022).
  - Verify GREEN: `pnpm nx test spreadsheet-mcp -- -k parse` → passes. Covers: US2-AC1.
- [X] T022 [US2] Integration test: `parse_spreadsheet` against a real transient-store handle (no mocking the store). In `mcp-servers/spreadsheet-mcp/tests/integration/`.

### Agent: intent + resolvers (pure code) + node

- [X] T023 [P] [US2] Golden: add an `import`-intent classification case to the golden dataset (adversarial prompts incl. "load my movies from this file"). In `agents/movie-assistant/tests/golden/`.
  - Verify RED: `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant -- -k import_intent` → `CassetteMissError`.
- [X] T024 [US2] Implement: add `import` intent to `classify_intent` (label def + few-shot) in `agents/movie-assistant/src/nodes/supervisor.py`; **delete stale intent cassettes and re-record** on qwen2.5 (runtime) AND Claude (gate). Verified: replay gate 35/35 green; qwen2.5 routes import correctly, no `add` regression.
  - Verify GREEN: `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant -- -k import_intent` → passes.
- [X] T025 [P] [US2] Unit test (adversarial matrix + Hypothesis property): column-mapping resolver — alias table + value-shape heuristics → high/medium/low; `Pick`/`Top`/`Tagline` → low/ignore (no model field); a generic `Rating`/`Score` header → medium/ask; `Set→movieSet`, `Outline→outline`, `Plot→plot` are high (direct). Verify the alias table against `backend/mc-service/src/application/dtos/movie_dto.rs`. In `agents/movie-assistant/tests/unit/test_column_mapping.py`.
  - Verify RED: `pnpm nx test movie-assistant -- -k column_mapping` → fails.
  - Covers: US2-AC3, FR-011/012/013.
- [X] T026 [US2] Implement the pure-code column-mapping resolver in `agents/movie-assistant/src/nodes/import_collection.py` (or a helper module). Register every resolver in the shared adversarial catalogue.
  - Verify GREEN: `pnpm nx test movie-assistant -- -k column_mapping` → passes.
- [X] T027 [P] [US2] Unit test (adversarial): title-article normalizer — `"Matrix, The"→"The Matrix"`, `"…, A"`, `"…, An"`; `"Goodbye, Lenin!"` → `needsConfirm`. In `agents/movie-assistant/tests/unit/test_title_articles.py`.
  - Verify RED: `pnpm nx test movie-assistant -- -k title_articles` → fails.
  - Covers: US2-AC4, FR-014/015.
- [X] T028 [US2] Implement the article normalizer (English The/A/An only) + multi-value `|` splitter (FR-016) as pure code.
  - Verify GREEN: `pnpm nx test movie-assistant -- -k "title_articles or multi_value"` → passes. Covers: US2-AC4, US2-AC5.
- [X] T029 [P] [US2] Unit test: dedup + compose-then-replace payload — existing-title match within target collection updates only supplied attributes, never blanks (reuse 013 `compose_movie_payload`). In `agents/movie-assistant/tests/unit/test_import_dedup.py`.
  - Verify RED: `pnpm nx test movie-assistant -- -k import_dedup` → fails.
  - Covers: US2-AC6, US2-AC7, FR-017/018/019.
- [X] T030 [US2] Implement dedup (via `list_movies`) + compose-then-replace in `import_resolvers.py` (pure-code helper, composed by `import_collection.py`).
  - Verify GREEN: `pnpm nx test movie-assistant -- -k import_dedup` → passes. Covers: US2-AC6, US2-AC7.
- [X] T031 [P] [US2] Unit test: spec-derived transition table for the import stage machine (parse→resolve→preview→confirm→write), one row per `(stage, input-class)` traced to spec ACs. In `agents/movie-assistant/tests/unit/test_import_transitions.py`.
  - Verify RED: `pnpm nx test movie-assistant -- -k import_transitions` → fails.
- [X] T032 [US2] Implement the `import_collection` node orchestration (parse → eligible tabs → map → normalize → dedup → build `ImportPreview`). Pure preview builder + row transform/coercion (typed payloads, externalIds assembly, create-defaults) + tab→collection resolution + stage machine in `import_collection.py`; runtime wiring deferred to T034/runtime_nodes.
  - Verify GREEN: `pnpm nx test movie-assistant -- -k import_transitions` → passes. Covers: US2-AC1.
- [X] T033 [US2] Implement preview generative-UI + approval-gate (preview-then-confirm, FR-020) with whole-tab exclusion (FR-020a), reusing the 012/013 approval-gate + pending-batches self-loop. Reused: import builds Proposal batches routed through the SHARED approval_gate (graph: import_collection→route_after_organizer→approval_gate). Covers: US2-AC8, US2-AC10.
- [X] T033a [US2] Test: cancelling at the preview writes **nothing** — the collection is unchanged after cancel. Covered deterministically at the compiled-graph level (`tests/unit/test_import_runtime.py::test_reject_writes_nothing`); real-MCP version lands with T038's `test_import_flow.py`. Covers: SC-009, FR-020.
- [X] T034 [US2] Implement chunked best-effort writes via the shared approval gate executor: `add_movie`/`update_movie` in ≤BATCH_CAP batches with idempotency keys, continue-on-failure (409→skipped_duplicate, 404→skipped_missing), applied/skipped summary, pending_batches self-loop; writes go through the same approved-write→idle dock data-revision bump (FR-031, 013 T072). Runtime `_build_import_node` (parse→read→preview→proposals) + graph node/route wired; `SPREADSHEET_MCP_URL` optional on RuntimeNodeConfig (graceful degrade, not gating production_nodes_enabled). Covers: US2-AC9, FR-021/021a/021b/031.
  - Covers: US2-AC9, FR-021/021a/021b/031.

### BFF + frontend (web)

- [X] T035 [P] [US2] BFF integration test (real Redis store): `POST /bff-api/agent/import-upload` stashes a file, returns a handle, validates type/size, audit-logs without contents. In `frontend/mcm-app/tests/integration/`.
  - Verify RED: `pnpm nx test:integration mcm-app -- import-upload` → fails (route absent).
  - Covers: FR-006, FR-022.
- [X] T036 [US2] Implement `frontend/mcm-app/src/app/bff-api/agent/import-upload+api.ts` (multipart → transient store, requireAuth+requireMcUser, audit by filename/size only) + register in the agent auth-guard enumeration + `route-coverage-map`. Gateway file-handle bridge: `X-Import-File` header → `ImportFileMiddleware` → `inject_import_file` → `config.configurable.file_handle/filename`; run+api reads+clears the per-user reference (single-use) and passes it to `createMovieAssistantAgent`. tsc clean; Python bridge tests 25 + BFF unit 40 green.
- [X] T037 [US2] Implement `frontend/mcm-app/src/components/spreadsheet-import-dialog.tsx` (web file browse + preview surface) and `frontend/mcm-app/src/hooks/use-spreadsheet-import.ts` (upload → run → progress). useCallback-wrap dock handlers (react-compiler rule).

### Integration + E2E

- [X] T038 [US2] Integration test (real MCP + mc-service, real Keycloak): import a CSV → exact creates into the matched collection, multi-values split (Genres `Sci-Fi|Action`), trailing article normalized (`"Matrix, The"`→`The Matrix`); **re-run → idempotent**; reject writes nothing. In `agents/movie-assistant/tests/integration/test_import_flow.py`. **LIVE-GREEN 2/2.** Harness = local `movie-mcp` (8766) + `spreadsheet-mcp` (8767) → mc-service:3001 + Redis:6379 + Keycloak:8099 (the established pattern; the containerized MCP have no host ports). Added `redis` as a movie-assistant dev dep to seed the transient `import:file:` store as the BFF would.
  - Covers: US2-AC1/5/6/7, SC-002, SC-005, SC-009/FR-020.
- [X] T038a [P] [US2] Authz test: an import whose tab name matches another user's collection cannot write to it — the tab→collection match only considers the requester's OWN collections (FR-030). The node pauses on a disambiguation prompt, the other user's collection stays empty. Extended `test_authz_parity.py`. **LIVE-GREEN.**
  - Covers: FR-030.
- [X] T039 [P] [US2] Recorded-output → resolver bridge test: feed recorded golden outputs through the column-mapping + article resolvers and assert correct resolution. In `agents/movie-assistant/tests/unit/test_import_bridge.py`.
  - Verify RED/GREEN: `pnpm nx test movie-assistant -- -k import_bridge`.
- [X] T040 [US2] Web agent E2E: upload `sample-movies.xlsx`, pick the target collection, confirm the preview, assert the created movies — discriminating assertion against a FRESH gateway. In `scripts/agent-e2e.mjs` + `frontend/mcm-app/tests/e2e/web/`.
  - Verify GREEN: rebuild `agent-gateway`+`spreadsheet-mcp`+`mcm-bff`, then `node scripts/agent-e2e.mjs` (import flow) → green. **Run the FULL agent E2E after the supervisor-prompt change** (routing regressions don't surface in stubbed integration).

**Checkpoint**: US2 import works end-to-end on web for well-formed + exact-match data.

---

## Phase 5: User Story 3 - Export selected collections to a spreadsheet (Priority: P2)

**Goal**: Multi-select collections → one `.xlsx` with one tab per collection, one column per attribute, multi-values pipe-joined, downloadable.

**Independent Test**: Export two collections → single file, two correctly-named tabs, expected columns, `|`-joined multi-values; opens in Excel.

- [X] T041 [P] [US3] Unit test: `build_workbook` — one sheet per tab, header row, `|`-join multi-values, header-only sheet for an empty collection, sheet-name de-dup. In `mcp-servers/spreadsheet-mcp/tests/unit/test_build.py`.
  - Verify RED: `pnpm nx test spreadsheet-mcp -- -k build` → fails.
  - Covers: US3-AC2/3/4, FR-025/026/027.
- [X] T042 [US3] Implement `build_workbook` (openpyxl write; returns a download handle).
  - Verify GREEN: `pnpm nx test spreadsheet-mcp -- -k build` → passes.
- [X] T043 [P] [US3] Golden: add an `export`-intent case. Verify RED: `…test:golden … -k export_intent` → `CassetteMissError`.
- [X] T044 [US3] Implement the `export` intent in `supervisor.py`; delete stale cassettes + re-record on Claude (replay 38/38; qwen2.5 runtime check deferred to live-stack batch).
  - Verify GREEN: `…test:golden … -k export_intent` → passes. Covers: US3-AC1.
- [X] T045 [US3] Implement the `export_collection` node in `agents/movie-assistant/src/nodes/export_collection.py`: pure shapers (movie→row, build_export_tabs, select_export_collections) + `_build_export_node` runtime wiring (list_movies all pages → `build_workbook` → `download_export` UI-action) + graph node/route (read-only → END).
  - Covers: US3-AC1/2/3/4.
- [X] T046 [P] [US3] BFF integration test: `GET /bff-api/agent/export-download?handle=…` streams the `.xlsx` with `Content-Disposition`; handle is ownership-scoped + single-use; 404 on expired. In `frontend/mcm-app/tests/integration/`.
  - Verify RED: `pnpm nx test:integration mcm-app -- export-download` → fails.
  - Covers: US3-AC5, FR-028.
- [X] T047 [US3] Implement `frontend/mcm-app/src/app/bff-api/agent/export-download+api.ts` + `AGENT_ROUTES`/route-coverage-map; `spreadsheet-export-dialog.tsx` + `use-spreadsheet-export.ts`.
  - Verify GREEN: same command → passes.
- [X] T046a [P] [US3] Authz test: export selects only the requester's OWN collections — explicitly requesting another user's collection id yields no workbook (`select_export_collections` filters it out → no download handle). Extended `test_authz_parity.py`. **LIVE-GREEN.**
  - Covers: FR-030.
- [X] T048 [US3] Integration test (real): export a seeded collection → a valid `.xlsx` (PK magic), and a **round-trip** export→import preserves the multi-value sets (genres + tags, order-independent), no duplicates. In `agents/movie-assistant/tests/integration/test_export_flow.py`. **LIVE-GREEN.**
  - Covers: SC-004, SC-008.
- [X] T049 [US3] Web agent E2E: export selected collections, download, assert tabs/columns. In `scripts/agent-e2e.mjs`.

**Checkpoint**: US3 export works end-to-end on web; round-trips with US2 import.

---

## Phase 6: User Story 4 - Guided clarification when import is ambiguous (Priority: P3)

**Goal**: When the assistant can't confidently resolve a tab→collection, a column mapping, or a sorting article, it prompts via disambiguation buttons rather than guessing.

**Independent Test**: Import a file with an unmatched-name tab, an ambiguous column, and an uncertain trailing word → each prompts via buttons; choices applied correctly.

- [X] T050 [P] [US4] Unit test: tab→collection prompt fires for 0-match and >1-match tab names; buttons offered; pick resolved in pure code. In `agents/movie-assistant/tests/unit/test_import_disambiguation.py`.
  - Verify RED: `pnpm nx test movie-assistant -- -k import_disambiguation` → fails.
  - Covers: US4-AC1, FR-010.
- [X] T051 [US4] Implement collection-target disambiguation in `import_collection.py` (reuse the 013 button + pure-code resolution pattern).
  - Verify GREEN: same command → passes. Covers: US4-AC1, US4-AC4.
- [X] T052 [P] [US4] Unit test: medium-confidence column → confirm prompt (e.g. a generic `Rating`/`Score` header, ambiguous vs MPAA `rated`). Add to `test_import_disambiguation.py`.
  - Verify RED: `…-k import_disambiguation` (medium-column case) → fails.
  - Covers: US4-AC2, FR-012.
- [X] T053 [US4] Implement the medium-confidence column confirmation flow.
  - Verify GREEN: same → passes. Covers: US4-AC2.
- [X] T054 [P] [US4] Unit test: uncertain trailing word → article confirm prompt (`needsConfirm`).
  - Verify RED: `…-k import_disambiguation` (article case) → fails.
  - Covers: US4-AC3, FR-015.
- [X] T055 [US4] Implement the article-uncertainty confirmation flow.
  - Verify GREEN: same → passes. Covers: US4-AC3.
- [X] T056 [US4] Web agent E2E: ambiguous import (unmatched tab) resolved via buttons → pick → approve → creates in the chosen collection. In `frontend/mcm-app/tests/e2e/web/agent-import-disambiguate.spec.ts` (+ `scripts/agent-e2e.mjs`). LIVE-GREEN ×3. The earlier "deferred" diagnosis (import_stage not surviving / re-parsing the single-use handle) was WRONG — a full gateway+mc-service single-attempt trace showed the multi-turn continuation is sound and the handle is never re-parsed. The flake was the assertion racing the async write (the assistant summary streams before `add_movie` lands, so a single immediate GET + afterEach cleanup tore down first → the late write hit the just-deleted collection = a CORRECT 404, not an mc-service bug). Fix = poll for the imported movie to land before asserting/teardown; hardened the same anti-pattern in `agent-import.spec.ts` (T040). New deterministic compiled-graph regression: `agents/movie-assistant/tests/unit/test_import_disambiguation_runtime.py`. The column + article disambiguations remain unit/compiled-graph proven (`test_import_disambiguation*`).
  - Covers: US4-AC1/2/3, SC-007.

**Checkpoint**: Import handles messy real-world data via guided prompts.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T057 [P] Audit logging for import/export (who/what/counts; never file contents or tokens) in the new BFF routes + nodes, per Agent Security + Core Logging. BFF: `import-upload+api.ts` audits `agent_import_upload {userId, filename, sizeBytes}`; `export-download+api.ts` audits `agent_export_download {userId, filename, sizeBytes}` — no contents/tokens (SC-004). Gateway: `audit_sink.py` emits `agent_tool_call` per import/export tool (parse_spreadsheet/build_workbook/add_movie/…), verified live.
- [X] T058 Confirm the SC-004 token-leak scan still passes over the agent + new `spreadsheet-mcp` source: `pnpm nx test movie-assistant -- -m leak_scan`.
- [X] T059 [P] Update READMEs: `mcp-servers/spreadsheet-mcp/README.md` (already complete — tools + transient-store + no-JWT design), `agents/movie-assistant/README.md` (added a Feature 014 section + import/export nodes + `spreadsheet_tools` to the Layout table), and the repo CLAUDE.md AI-Agent-Layer import/export note (3rd MCP server + intents + the T056 poll-the-write E2E lesson).
- [X] T060 [P] `pnpm nx lint mc-service`, `pnpm nx lint mcm-app`, `pnpm nx lint movie-assistant`, `pnpm nx lint spreadsheet-mcp` — no warnings. All four green (2026-06-14).
- [X] T061 Run [quickstart.md](./quickstart.md) validation end-to-end (US1 → US2 → US3 → US4). Each user story is validated by its now-green automated coverage: US1 web (T018/T018a) + mobile (T019); US2 import agent-E2E (T040) + live integration (T038/T038a); US3 export agent-E2E (T049) + live round-trip integration (T048/T046a); US4 disambiguation agent-E2E (T056) + unit/compiled-graph.
- [X] T062 Full-stack E2E regression: **web `107/0`** (dev-container), **agent E2E** import/export/disambiguation green (T040/T049/T056 vs the rebuilt production-node gateway), **Python integration `7/7`** (real MCP+mc-service+Keycloak), **mobile US1 green** (T019 on the emulator). Changed services (mc-service/agent-gateway/spreadsheet-mcp/mcm-bff) were rebuilt before their E2E legs.

---

## Platform Parity Table

Import/export are **web-first** (documented scope decision — file browse/download is web-centric; mobile is a planned follow-on). Optional language (US1) is a form/display change covered on both clients.

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1: add movie with no language | movies.spec.ts | movie-add.yaml | ✅ |
| US1-AC2: clear language on edit | movies.spec.ts | movie-edit.yaml | ✅ |
| US1-AC4: existing language preserved | movies.spec.ts | movie-edit.yaml | ✅ |
| US2-AC1: import eligible tabs only | agent-e2e (import) | N/A — web-first; mobile import/export deferred (spec Assumptions) | N/A |
| US2-AC6/7: create/update without blanking | agent-e2e (import) | N/A — web-first | N/A |
| US3-AC2: one tab per collection | agent-e2e (export) | N/A — web-first | N/A |
| US4-AC1: tab→collection prompt | agent-e2e (ambiguous import) | N/A — web-first | N/A |

No `❌ Gap` rows (mobile import/export N/A is a justified, documented scope decision).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1: T001–T004)**: start immediately (needed by US2/US3/US4).
- **Foundational (P2: T005–T006)**: after Setup; **blocks US2/US3/US4**. **US1 (T007–T019) depends on neither** — it can start in parallel from day one.
- **US1 (P3)** and **US2 (P4)** are both P1; US1 is the smaller MVP. Import **depends on US1** for language-less rows: it MUST pass an absent language through unchanged and MUST NOT inject a default like `"English"` (unlike the TMDB-enrichment path in `proposals.py`). Sequence US1's mc-service change before US2's write path.
- **US3 (P5)** depends on Setup+Foundational; independent of US2 (round-trip test references US2 but US3 is separately testable).
- **US4 (P6)** extends US2's `import_collection` node — depends on US2.
- **Polish (P7)**: after the desired stories.

### Within each story

- Tests written and verified RED before implementation; models/resolvers before node orchestration; node before BFF/frontend wiring; integration/E2E last.
- Supervisor-prompt changes (T024, T044) force a golden re-record (delete stale first) and a FULL agent E2E.

### Parallel opportunities

- T001–T002 [P]; T007/T009/T014/T016 [P] within US1; resolver unit tests T025/T027/T029/T031 [P] within US2; T041/T043 [P] within US3; T050/T052/T054 [P] within US4.
- US1 can be developed entirely in parallel with the Setup/Foundational/US2 agent work (different projects, no shared files).

---

## Implementation Strategy

### MVP first (US1)

1. T001–T004 setup (can defer if only shipping US1) → T007–T019 → **STOP & VALIDATE**: language-optional on backend + web + mobile. Deployable MVP.

### Incremental delivery

1. US1 (optional language) → demo.
2. Setup + Foundational + US2 (import, well-formed data) → demo.
3. US3 (export) → demo + round-trip with US2.
4. US4 (guided clarification) → demo messy-data import.

---

## Completion Checklist

Before marking `014-spreadsheet-import-export` complete, verify all success criteria from [spec.md](./spec.md):

- [X] **SC-001**: add a movie with no language in one attempt, visible immediately. (US1 web T018 + mobile T019.)
- [X] **SC-002**: sample import → 100% of eligible valid rows created/updated into correct collections, zero wrongly-blanked attributes. (T038 + T040.)
- [X] **SC-003**: exact-match well-formed import completes with no clarification prompt. (T040 + T038 filename==collection.)
- [X] **SC-004**: export→re-import round-trip preserves multi-value sets (order-independent). (T048.)
- [X] **SC-005**: re-import of unchanged data → 0 creates, 0 unintended changes (idempotent). (T038 + T040.)
- [X] **SC-006**: 100% of import/export choices are buttons (no free-text required). (T056 render_selection disambiguation.)
- [X] **SC-007**: an ambiguous import resolves fully via buttons and completes. (T056 live-green.)
- [X] **SC-008**: export → single file, one correctly-named tab per collection, one column per attribute, opens in common software. (T048 valid `.xlsx` + T049.)
- [X] **SC-009**: no data written before preview confirmation (cancel at preview leaves collection unchanged). (T038 reject-writes-nothing + T056.)
- [X] Platform parity table complete — no ❌ gaps remain (mobile import/export = justified web-first N/A).
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation).
- [ ] `pnpm nx test mc-service` + `pnpm nx test:integration mc-service` — pass (≥70% coverage).
- [ ] `pnpm nx test mcm-app` + `pnpm nx test:integration mcm-app` — pass (≥70% coverage).
- [ ] `pnpm nx test movie-assistant` (incl. `-m leak_scan`) + `pnpm nx test spreadsheet-mcp` — pass.
- [ ] `pnpm nx test:integration movie-assistant` — pass vs real MCP + mc-service + Keycloak.
- [ ] `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` — golden gate green (intents re-recorded).
- [ ] `pnpm nx lint` across mc-service / mcm-app / movie-assistant / spreadsheet-mcp — no warnings.
- [ ] `pnpm nx e2e mcm-app` (web, incl. agent import/export flows vs a FRESHLY rebuilt gateway+BFF) — pass.
- [ ] `pnpm nx e2e:mobile mcm-app` — US1 mobile flow passes (logged-out start between runs).
- [ ] `rtk gain` — >80% token compression confirmed (run last).

---

## Notes

- `[P]` = different files, no incomplete-task dependency.
- The `import`/`export` intents are the ONLY golden surface; column-mapping, article normalization, dedup, and pick resolution are **pure code** (no golden re-record) — keep them in the adversarial catalogue + property tests (012 Phase 9 / 013 Inc5 discipline).
- Rebuild `agent-gateway:latest`, `spreadsheet-mcp:latest`, AND `mcm-bff:latest` before any agent E2E — the runner recreates containers but never rebuilds; a stale image silently runs old code.
- Mobile import/export is intentionally out of scope (web-first); revisit as a follow-on feature.
