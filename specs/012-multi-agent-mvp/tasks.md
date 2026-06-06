# Tasks: Multi-Agent Conversational Assistant (Phase 1 MVP)

**Input**: Design documents from `specs/012-multi-agent-mvp/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: REQUIRED — TDD is non-negotiable (constitution). Every test task carries a **Verify RED**; its paired implementation task carries a **Verify GREEN**. Integration tests run against **real** MCP servers + real `mc-service` (no mocking the dependency under integration). LLM nondeterminism in CI is removed via the cassette/replay harness (T032), not by mocking the agent logic.

**Organization**: by user story (US1 P1 → US2 P2 → US3 P3). Each story is an independently testable increment.

**Stack** (from plan.md): Python 3.13 + `uv` (LangGraph orchestration `agents/movie-assistant/`, MCP servers `mcp-servers/movie-mcp` + `web-api-mcp`), TypeScript (Expo SDK 56 BFF routes + CopilotKit client in `frontend/mcm-app/`), Rust `mc-service` **unchanged**. Default model provider **Ollama** (`qwen2.5`/`qwen2.5:32b`), Claude fallback. All test/lint/build via **Nx** (`@nxlv/python` for Python).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete-task dependency)
- **[Story]**: US1/US2/US3 (user-story phases only)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffolding for the additive agent layer. No existing project is modified except additive deps/dirs.

- [ ] T001 Create `agents/movie-assistant/` Nx Python project (`@nxlv/python`) with `pyproject.toml` + committed `uv` lockfile and the directory tree from plan.md (`src/{graph,state,models}.py`, `src/nodes/`, `src/tools/`, `src/guardrails/`, `tests/{unit,integration}/`)
- [ ] T002 [P] Create `mcp-servers/movie-mcp/` Nx Python project (`pyproject.toml`, `src/{server,tools}.py`, `tests/{unit,integration}/`, `Dockerfile`)
- [ ] T003 [P] Create `mcp-servers/web-api-mcp/` Nx Python project (`pyproject.toml`, `src/{server,tools}.py`, `tests/{unit,integration}/`, `Dockerfile`)
- [ ] T004 [P] Add `movie-assistant` deps + pin lockfile: `langgraph`, the `langgraph-api`/AG-UI integration, `langchain-core`, `langchain-ollama`, `langchain-anthropic`, `mcp`, `nemoguardrails`, `guardrails-ai`, `pydantic`, `langfuse`, `opentelemetry-*`, `psycopg`
- [ ] T005 [P] Add `movie-mcp` + `web-api-mcp` deps (`mcp`, `httpx`) and pin lockfiles
- [ ] T006 [P] Configure `ruff` + `mypy`/`pyright` (no warnings/errors) for all three Python projects
- [ ] T007 [P] Add CopilotKit deps to `frontend/mcm-app` via pnpm: `@copilotkit/react-native` (verify RN 0.85 / React 19.2 / react-native-web compat — see research R6). **Determine whether the package adds native code (prebuild/autolinking); if yes, an Android APK rebuild (T033a) is required before any mobile E2E, per the CLAUDE.md native-module rule.**
- [ ] T008 Create Dockerfiles: `agents/movie-assistant/Dockerfile` (langgraph-api Agent Gateway), `mcp-servers/movie-mcp/Dockerfile`, `mcp-servers/web-api-mcp/Dockerfile`
- [ ] T009 Create per-service compose files `infrastructure-as-code/docker/{agent-db,agent-gateway,movie-mcp,web-api-mcp,ollama}/compose.yaml` and `include:` them in root `compose.yaml`; add the `agents` profile (per quickstart.md). **Profile-gate the gateway's loopback host port (`127.0.0.1:8123`) to Metro-dev only** (a dedicated profile or override file) so it is NEVER published in container/prod compose — preserving "gateway never reachable from clients/public network" (constitution §Agent Architecture Boundaries)
- [ ] T010 [P] Create external volumes `agent-db-data` + `ollama-models`; add both to the documented first-time `docker volume create` list
- [ ] T011 [P] Create `.env.local` templates: `agents/movie-assistant/.env.local` (`MODEL_PROVIDER=ollama` default, `OLLAMA_BASE_URL`, model IDs, `AGENT_DB_URL`, `KEYCLOAK_*`, gateway client id/secret, `LANGFUSE_*`, `UNLEASH_*`, `OPA_URL`, `OPENSEARCH_URL`), `mcp-servers/web-api-mcp/.env.local` (`TMDB_API_KEY`), `frontend/mcm-app/.env.local` agent additions (`AGENT_GATEWAY_URL`, rate/cost thresholds, subject-token client id/secret)
- [ ] T012 Configure Keycloak `jumbleknot` realm: enable standard token exchange, register the Agent Gateway as a **confidential** requester client, add an `mc-service`-audience client (exchanged-token TTL ≤60 s); script under `infrastructure-as-code/docker/keycloak/scripts/` (per research R3). Keep the `KC_HOSTNAME=localhost:8099` + `BACKCHANNEL_DYNAMIC` issuer pin (quickstart "Token exchange across serving modes")
- [ ] T013 [P] Bring up Ollama and pull `qwen2.5` + `qwen2.5:32b` (host or `ollama` compose service per quickstart); verify `ollama run qwen2.5 "reply OK"`
- [ ] T014 [P] Create `api-specs/agent-bff-api.yaml` (OpenAPI for the new BFF agent routes — spec-first, per constitution Specification-First)
- [ ] T014a Spike: validate `langgraph-api` **native AG-UI emission** + CopilotKit consumption end-to-end through the BFF proxy on **web (react-native-web) and Android** (SSE/WebSocket) with a trivial echo graph, before building T020/T028/T029 on it. De-risks research R6 (the architecture's NON-NEGOTIABLE AG-UI-native assumption).
  - **Done when**: a streamed AG-UI text event from a stub gateway renders in the CopilotKit dock on both web and Android via the BFF proxy.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user-story work begins until this phase completes. This builds the gateway runtime, the secure BFF proxy + identity propagation, the shared MCP client, the read tools every story needs, the client overlay, and observability/governance.

- [ ] T015 Implement `GraphState` typed state + checkpoint contract in `agents/movie-assistant/src/state.py` — enforce the **no-raw-token invariant** (subject/exchanged tokens never in checkpointed fields); carry only non-sensitive `userId`/`threadId`
- [ ] T016 [P] Implement `agents/movie-assistant/src/models.py` provider switch: `MODEL_PROVIDER=ollama` default (`ChatOllama`, per-node tiers `qwen2.5`/`qwen2.5:32b`) with `langchain-anthropic` Claude fallback; low temperature + schema-validated tool/structured output (research R1, FR-018 circuit-breaker hook)
- [ ] T017 Implement `supervisor` node (intent routing ONLY, calls no domain tools) in `src/nodes/supervisor.py`
- [ ] T018 Implement the shared in-process MCP client + **per-agent allowlists** in `src/tools/mcp_tools.py` (curator → read-only; organizer → read + write; supervisor → none — enforced by config, not convention)
- [ ] T019 [P] Implement guardrails: NeMo `src/guardrails/rails.co` (movie-domain topic confinement — FR-005) + `src/guardrails/output_validators.py` (Guardrails AI/Pydantic structural + PII checks on all user input and tool/MCP output)
- [ ] T020 Compile the LangGraph supervisor graph with **native AG-UI emission** + Postgres checkpointer in `src/graph.py` + `langgraph.json`; initialize the `agent-db` checkpointer schema on gateway startup
- [ ] T021 [P] Implement `movie-mcp` READ tools (`get_collection`, `list_movies`, `list_collections`) wrapping `mc-service` REST, forwarding the downscoped JWT, in `mcp-servers/movie-mcp/src/tools.py`
  - **Verify RED**: `pnpm nx test:integration movie-mcp -- -k read_tools` → fails (tools not implemented)
  - **Verify GREEN** (after impl): same command → passes against real `mc-service`
- [ ] T022 [P] Implement `web-api-mcp` tools (`search_title`, `get_movie_details`) → TMDB via `httpx`, Vault-injected key, outbound-only (no `backend-network`), typed `matchConfidence`, in `mcp-servers/web-api-mcp/src/tools.py`
  - **Verify RED**: `pnpm nx test:integration web-api-mcp -- -k tmdb` → fails
  - **Verify GREEN**: same command → passes against **real TMDB** (cassette only for the LLM dimension elsewhere, never for TMDB itself — constitution §Test Type Integrity)
- [ ] T023 Implement `frontend/mcm-app/src/bff-server/agent-subject-token.ts` — RFC 8693 run-scoped, audience-narrowed delegation token (agent-origin marker, short TTL), minted per invocation/resume; never logged/checkpointed (research R3)
- [ ] T024 Implement gateway-side token re-exchange at tool-call time (downscoped `aud=mc-service`, ≤60 s) + OPA authorization of the exchange, inside the shared MCP client path
- [ ] T024a Implement write-tool resilience in `agents/movie-assistant/src/tools/mcp_tools.py`: retry-with-backoff on transient failures + a **dead-letter handler** surfacing exhausted-retry failure to the user as a "couldn't complete" AG-UI message + audit entry (constitution §Agent Security "Idempotency for Writes"; FR-018). Idempotency keys (T041/T043) keep retries safe.
  - **Verify RED**: `pnpm nx test:integration movie-assistant -- -k write_resilience` → fails
  - **Verify GREEN**: same → passes (simulated transient error retries, then dead-letters to a user-facing failure)
- [ ] T025 Implement `frontend/mcm-app/src/bff-server/agent-gateway-client.ts` — server-side client to `langgraph-api` over the private network; mode-aware `AGENT_GATEWAY_URL` (internal DNS for container-BFF, loopback `127.0.0.1:8123` for Metro — quickstart)
- [ ] T026 [P] Implement `src/bff-server/ui-state-sanitizer.ts` (structural-field allowlist — sole sanitization point) + `src/bff-server/ui-action-authorizer.ts` (navigate target ↔ JWT-role check)
- [ ] T027 [P] Implement `src/bff-server/agent-rate-limiter.ts` — per-user request limit + per-user/session cost ceiling (Redis), friendly "try again later", no action on breach (FR-020a)
- [ ] T027a Enforce a **per-agent** rate limit at the gateway (in addition to T027's per-user limits) — constitution §Agent Security requires limits "per authenticated user AND per agent". Cap each specialist's tool-call/token rate; breach degrades gracefully (FR-018).
- [ ] T028 Implement BFF `src/app/bff-api/agent/run+api.ts` — AG-UI stream **passthrough proxy** (no event-shape translation); `requireAuth` → `requireMcUser`; sanitize UI state; mint subject token; rate/cost guard
  - **Verify RED**: `pnpm nx test:integration mcm-app -- agent-run` → fails (route absent)
  - **Verify GREEN** (after impl): same → passes against real gateway + Keycloak + Redis; asserts 401/403 parity and no token in logs
- [ ] T028a Auth-guard regression test asserting EVERY `bff-api/agent/*` route (`run`, `resume`, `ui-state`) returns 401 unauthenticated and 403 for a non-`mc-user`, in `frontend/mcm-app/tests/integration/agent-route-auth.integration.test.ts` — **compensating control for the documented Centralized Access Control deviation** (per-handler auth due to the `@expo/server` middleware gap). Any agent route added later MUST be added to this test.
  - **Verify RED**: `pnpm nx test:integration mcm-app -- agent-route-auth` → fails (routes/guards absent)
  - **Verify GREEN** (after T028/T044/T057): same → passes
- [ ] T029 Implement CopilotKit `src/components/agent/assistant-dock.tsx` (app-wide overlay reachable from any screen) + `src/hooks/use-assistant.tsx` (AG-UI client wiring + readable-UI-state provider); mount in `app/_layout.tsx` without altering existing routes
- [ ] T030 [P] Wire Control Tower: LangFuse traces/cost/latency, OpenSearch append-only audit (write-only service account), Unleash kill-switch + error-rate circuit breakers, in the gateway runtime
- [ ] T030a Wire HashiCorp **Vault** runtime injection of LLM/MCP credentials (Anthropic key when on the Claude fallback, TMDB key, gateway client secret) for the gateway + MCP server containers in deployed environments (constitution §Agent Security "Secrets"); local dev uses `.env.local`. Secrets MUST NOT appear in agent context, prompts, logs, or source.
- [ ] T031 [P] Implement the **token-leak scan** (CI/eval) asserting no subject/exchanged token in `agent-db`, traces, or logs (SC-004) in `agents/movie-assistant/tests/`
- [ ] T032 [P] Implement the **golden-pair regression harness** (LangFuse dataset; runs against the configured provider) + a **CI cassette/replay** mode that records/replays **only the LLM provider** for determinism (research R1). Integration tests MUST keep the dependency-under-integration **real** (MCP servers, `mc-service`, TMDB) — never cassette those; the live-model path is covered by the golden-pair gate (T063).
- [ ] T033 Register Nx targets for `movie-assistant`/`movie-mcp`/`web-api-mcp` (`test`, `test:integration`, `lint`, `build`, `deploy`) via `@nxlv/python`; verify the `agents` compose profile boots the full stack
- [ ] T033a (conditional on T007) If `@copilotkit/react-native` adds native code, rebuild + install the Android APK via the CI `android-apk` workflow (`gh workflow run android-apk.yml`; then `adb install -r app-debug.apk`) — ordered **before** the mobile E2E tasks T038/T049/T056 (Maestro runs the installed APK and crashes on a stale binary). If CopilotKit is pure-JS, mark **N/A** with that justification.

**Checkpoint**: Gateway runs, BFF proxies AG-UI with identity propagation, read tools + overlay work, observability live — user stories can begin.

---

## Phase 3: User Story 1 — Enrich and add a movie by conversation (Priority: P1) 🎯 MVP

**Goal**: A signed-in user asks the assistant to add a named film to a collection; it enriches metadata, shows a preview, gates the write behind explicit approval, and (on approval) adds it once — including creating the target collection if it doesn't exist.

**Independent Test**: From a logged-in session, ask to add a named movie to a collection; verify preview + approval prompt, nothing persisted pre-approval, exactly one movie added post-approval (enriched), and create-if-missing surfaces both writes in one preview.

### Tests for User Story 1 (write FIRST, confirm RED)

- [ ] T034 [P] [US1] pytest unit for `curator` enrich+propose (mocked tools) in `agents/movie-assistant/tests/unit/test_curator.py`
  - **Verify RED**: `pnpm nx test movie-assistant -- -k curator` → fails (node absent)
- [ ] T035 [P] [US1] pytest integration: `curator` → real `web-api-mcp`/TMDB search+details in `agents/movie-assistant/tests/integration/test_curator_enrich.py`
  - **Verify RED**: `pnpm nx test:integration movie-assistant -- -k enrich` → fails
- [ ] T036 [US1] pytest integration: organizer add path + `approval_gate` interrupt/resume + idempotency + create-if-missing, real `movie-mcp` + real `mc-service`, in `agents/movie-assistant/tests/integration/test_add_flow.py`
  - **Verify RED**: `pnpm nx test:integration movie-assistant -- -k add_flow` → fails
- [ ] T037 [P] [US1] Web E2E in `frontend/mcm-app/tests/e2e/web/assistant-add.spec.ts` — add named movie → preview+approval; reject leaves unchanged; approve adds once; retry adds once (idempotency); add-to-nonexistent shows create+add in one preview
  - **Verify RED**: `pnpm nx e2e mcm-app -- tests/e2e/web/assistant-add.spec.ts` → fails (no dock/flow)
- [ ] T038 [P] [US1] Mobile E2E `frontend/mcm-app/tests/e2e/mobile/assistant-add.yaml` (Maestro) — same journey on Android, logged-out start
  - **Verify RED**: `maestro test tests/e2e/mobile/assistant-add.yaml --env …` → fails

### Implementation for User Story 1

- [ ] T039 [US1] Implement `curator` node (web-api-mcp read-only allowlist; enrich; build `EnrichedMovieCandidate`; emit `render_movie_card`) in `src/nodes/curator.py`
  - **Verify GREEN**: T034 + T035 commands → pass
- [ ] T040 [US1] Implement `render_movie_card` generative-UI tool in `src/tools/generative_ui_tools.py` + client adapter `src/components/agent/render-movie-card.tsx` (maps props to existing movie-card component)
- [ ] T041 [US1] Implement organizer add path + `src/proposals.py` (`Proposal`/`ProposalItem`, deterministic idempotency key = hash(threadId,proposalId,itemId), create-if-missing surfaced in same proposal) in `src/nodes/organizer.py`
- [ ] T042 [US1] Implement `approval_gate` node — LangGraph `interrupt()` + AG-UI `approval-request`; checkpoint to `agent-db`; **no token held while paused** — in `src/nodes/approval_gate.py`
- [ ] T043 [US1] Implement `movie-mcp` write tools `add_movie` + `create_collection` (carry `idempotencyKey`; executed only on approved-resume) in `mcp-servers/movie-mcp/src/tools.py`
  - **Verify RED→GREEN**: `pnpm nx test:integration movie-mcp -- -k writes` (RED before, GREEN after)
- [ ] T044 [US1] Implement BFF `src/app/bff-api/agent/resume+api.ts` — HITL approve/reject; mint fresh subject token; trigger approval-time re-validation; record `ApprovalDecision` to OpenSearch audit (in-session auth, no step-up — FR-006a)
- [ ] T045 [US1] RBAC/DAC denial parity **and cross-user/admin guard**: unauthorized add denied identically (404); additionally assert an agent run cannot target another user's resources or perform admin operations (FR-011, FR-012, SC-003) — integration test in `tests/integration/test_authz_parity.py`
- [ ] T046 [US1] Wire `supervisor` routing for add/enrich intents → curator → organizer → approval_gate
  - **Verify GREEN (story)**: T036, T037, T038 commands → pass

**Checkpoint**: US1 fully functional and independently testable — the MVP.

---

## Phase 4: User Story 2 — Organize a collection by conversation (Priority: P2)

**Goal**: A signed-in user asks for a multi-item reorganization; the assistant plans a batch, shows the full batch for one review (per-item visible), and on approval applies the still-valid items — chunking oversized requests and skipping drifted items.

**Independent Test**: With a populated collection, request a multi-item reorg; verify the batch preview, collection unchanged until approval, and post-approval state matches the plan; oversized request chunks into sequential approvals; drifted items skipped+reported.

### Tests for User Story 2 (RED first)

- [ ] T047 [P] [US2] pytest integration: organizer batch plan + chunking >50 + per-item approval-time re-validation (skip drifted, apply valid, don't abort batch) real deps, in `agents/movie-assistant/tests/integration/test_organize_batch.py`
  - **Verify RED**: `pnpm nx test:integration movie-assistant -- -k organize_batch` → fails
- [ ] T048 [P] [US2] Web E2E `frontend/mcm-app/tests/e2e/web/assistant-organize.spec.ts` — multi-item reorg batch preview → approve applies all; partial-permission items reported; oversized chunks; drift skipped
  - **Verify RED**: `pnpm nx e2e mcm-app -- tests/e2e/web/assistant-organize.spec.ts` → fails
- [ ] T049 [P] [US2] Mobile E2E `frontend/mcm-app/tests/e2e/mobile/assistant-organize.yaml`
  - **Verify RED**: `maestro test tests/e2e/mobile/assistant-organize.yaml --env …` → fails

### Implementation for User Story 2

- [ ] T050 [US2] Implement organizer batch/update/remove + chunking (≤50, sequential batches — FR-009b) + approval-time re-validation skipping now-duplicate/now-missing (FR-009a, SC-010) in `src/nodes/organizer.py` + `src/proposals.py`
- [ ] T051 [US2] Implement `movie-mcp` write tools `update_movie` + `delete_movie` (idempotency) in `mcp-servers/movie-mcp/src/tools.py`
  - **Verify RED→GREEN**: `pnpm nx test:integration movie-mcp -- -k update_delete`
- [ ] T052 [US2] Implement `render_collection_summary` + `render_wishlist` generative-UI tools + adapters `render-collection-summary.tsx` (wishlist reuses the collection component — clarify round 3)
- [ ] T053 [US2] Wire `supervisor` routing for organize intents
  - **Verify GREEN (story)**: T047, T048, T049 → pass

**Checkpoint**: US1 + US2 both independently functional.

---

## Phase 5: User Story 3 — Context-aware reference to the current screen (Priority: P3)

**Goal**: While viewing a collection/movie, the user says "add this …" and the assistant resolves the target from the current screen; ambiguous references prompt for clarification.

**Independent Test**: On a specific collection screen, issue a "this" instruction; verify the on-screen collection is resolved as target and the normal approval flow applies; an unresolvable reference asks the user to clarify.

### Tests for User Story 3 (RED first)

- [ ] T054 [P] [US3] pytest unit: "this"/current-target resolution from `ui_snapshot`; ambiguity → clarify, in `agents/movie-assistant/tests/unit/test_context_resolution.py`
  - **Verify RED**: `pnpm nx test movie-assistant -- -k context` → fails
- [ ] T055 [P] [US3] Web E2E `frontend/mcm-app/tests/e2e/web/assistant-context.spec.ts` — on a collection screen "add \<movie\> to this" resolves target; ambiguous reference asks to clarify
  - **Verify RED**: `pnpm nx e2e mcm-app -- tests/e2e/web/assistant-context.spec.ts` → fails
- [ ] T056 [P] [US3] Mobile E2E `frontend/mcm-app/tests/e2e/mobile/assistant-context.yaml`
  - **Verify RED**: `maestro test tests/e2e/mobile/assistant-context.yaml --env …` → fails

### Implementation for User Story 3

- [ ] T057 [US3] Implement client readable-UI-state snapshot provider (current screen, collection/movie id, structural filter keys) in `use-assistant.tsx` + BFF `src/app/bff-api/agent/ui-state+api.ts` intake (sanitized via the allowlist; no PII/values)
- [ ] T058 [US3] Implement "this"/current-target resolution using `ui_snapshot`; unresolvable → clarify prompt (FR-013/FR-014) in supervisor/specialist
  - **Verify GREEN**: T054 → passes
- [ ] T059 [US3] Implement `navigate_*` / `prefill_*` UI-action tools in `src/tools/ui_action_tools.py` + client dispatch (allowlisted; `prefill_add_movie` HITL-surfaced for unsaved state) + enforce `ui-action-authorizer`
  - **Verify GREEN (story)**: T055, T056 → pass

**Checkpoint**: All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T060 [P] Verify out-of-domain decline (FR-005) — guardrail topic rails reject non-movie-domain requests; test in `tests/integration/test_out_of_domain.py`
- [ ] T061 [P] Graceful degradation: model/provider/tool failure → "couldn't complete" AG-UI message, never silent/unauthorized action (FR-018); Unleash kill-switch disables the assistant with no impact on existing app (SC-009) — tests
- [ ] T062 [P] Proposal expiry at session end (FR-008/SC-007) — session-end sweep marks pending threads expired with zero writes; test
- [ ] T063 [P] Add golden-pair exemplars per story; wire the deployment gate to **block on regression** (runs against the provider the target deploy uses — research R1)
- [ ] T064 Token-leak scan green in the CI gate (SC-004)
- [ ] T065 [P] Docs: `agents/movie-assistant/README.md`, `mcp-servers/*/README.md`, tool-schema + allowlist docs; finalize `api-specs/agent-bff-api.yaml`; **update root `CLAUDE.md`** with the agent-layer dev loop (the `agents` compose profile, Ollama setup, `pnpm nx … movie-assistant` targets)
- [ ] T066 **Existing web E2E regression** (additive-only proof, SC-005) — rebuild + redeploy the gateway/BFF images first, then `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` stays green
- [ ] T067 Verify per-turn cost + p95 latency within configured budgets in LangFuse (SC-008)
- [ ] T068 Complete the Platform Parity Table (below) and the Completion Checklist; confirm all test tasks used Verify RED before implementation

---

## Platform Parity Table

New assistant E2E flows must exist for **both** web (Playwright) and mobile (Maestro) — SC-001 parity. Mobile flows are new (`[create: …]`).

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1/2/3: add named movie → preview+approval → approve/reject | `assistant-add.spec.ts` | `[create: assistant-add.yaml]` | ❌ Gap → T037/T038 |
| US1-AC4: duplicate-submission retry adds once | `assistant-add.spec.ts` | `[create: assistant-add.yaml]` | ❌ Gap → T037/T038 |
| US1-AC5: unauthorized add denied identically (404) | `assistant-add.spec.ts` | N/A — authz parity proven at the API/integration layer (T045); not a distinct mobile UI flow | N/A |
| US1-AC6: create-collection-if-missing in one preview | `assistant-add.spec.ts` | `[create: assistant-add.yaml]` | ❌ Gap → T037/T038 |
| US2-AC1/2: multi-item organize batch preview → approve applies all | `assistant-organize.spec.ts` | `[create: assistant-organize.yaml]` | ❌ Gap → T048/T049 |
| US2-AC3: partial-permission items reported, gate not skipped | `assistant-organize.spec.ts` | N/A — authz parity proven at integration layer (T047); reported inline | N/A |
| US3-AC1: "add this" resolves on-screen collection | `assistant-context.spec.ts` | `[create: assistant-context.yaml]` | ❌ Gap → T055/T056 |
| US3-AC2: ambiguous reference → clarify | `assistant-context.spec.ts` | `[create: assistant-context.yaml]` | ❌ Gap → T055/T056 |

All `❌ Gap` rows are resolved by their listed tasks; `N/A` rows are justified (authz/parity verified deterministically at the integration layer, not as a separate mobile UI flow).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)**: no dependencies.
- **Foundational (P2)**: depends on Setup; **blocks all user stories**.
- **User Stories (P3–P5)**: all depend on Foundational. US1 is the MVP; US2/US3 build on the shared HITL/proxy path but are independently testable.
- **Polish (P6)**: depends on the targeted stories being complete.

### User-story dependencies

- **US1 (P1)**: after Foundational. Establishes the write+HITL path (approval_gate, organizer add, write tools, resume route) — no dependency on US2/US3.
- **US2 (P2)**: after Foundational. Reuses US1's approval_gate/resume but adds batch/chunk/re-validate + update/delete tools; independently testable. (If built after US1, reuse `proposals.py`; if built in parallel, both extend it — coordinate on that one file.)
- **US3 (P3)**: after Foundational. Adds UI-state snapshot + resolution + UI-action tools; independent of US1/US2 write behavior.

### Within each story

- Tests written and **RED-verified before** implementation.
- Python: state/models → nodes → tools; MCP tool contract tests before tool impl.
- BFF: route integration test (RED) → route impl (GREEN).
- E2E (web + mobile) RED at story start, GREEN after the story's impl tasks.

### Parallel opportunities

- Setup: T002–T007, T010–T011, T013–T014 are `[P]`.
- Foundational: T016, T019, T021, T022, T026, T027, T030, T031, T032 are `[P]` (distinct files/services).
- Within a story, the `[P]` test tasks (unit + web E2E + mobile E2E) can be authored in parallel.
- With staff, US1/US2/US3 can proceed in parallel after Foundational (coordinate on `proposals.py` and `organizer.py` if US1+US2 overlap).

---

## Parallel Example: User Story 1

```bash
# Author US1 tests together (all RED first):
Task: "pytest unit curator in tests/unit/test_curator.py"            # T034
Task: "Web E2E add flow in tests/e2e/web/assistant-add.spec.ts"      # T037
Task: "Mobile E2E add flow in tests/e2e/mobile/assistant-add.yaml"   # T038
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (blocks everything) → 3. Phase 3 US1 → **STOP & validate US1 independently** → demo. This is a usable assistant: enrich, preview, approve, write once, create-if-missing — all HITL-gated and scoped to the user.

### Incremental delivery

Foundational → US1 (MVP) → US2 (organize/batch) → US3 (context-aware). Each adds value without breaking prior stories; run the existing E2E regression (T066) after each to prove additivity (SC-005).

---

## Completion Checklist

Before marking `012-multi-agent-mvp` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: add/enrich/organize entirely by conversation on **both** web and mobile, identical behavior
- [ ] **SC-002**: 100% of agent writes/deletes pass explicit approval; 0 unapproved writes (audit confirms)
- [ ] **SC-003**: assistant never exceeds the user's own permissions — unauthorized attempt denied identically to direct API (T045)
- [ ] **SC-004**: no user token in `agent-db`, memory, traces, or logs — automated scan green (T031/T064)
- [ ] **SC-005**: zero changes to existing screens/login/domain logic — existing web E2E regression green (T066)
- [ ] **SC-006**: duplicate-submission retry → exactly one persisted change
- [ ] **SC-007**: abandoned proposal → zero changes, expired by session end (T062)
- [ ] **SC-008**: per-turn cost + p95 latency within budget, visible in observability (T067)
- [ ] **SC-009**: kill switch disables the assistant with no impact on existing app (T061)
- [ ] **SC-010**: drifted-batch approval applies only valid items, reports drift, zero conflicting/duplicate writes
- [ ] **SC-011**: rate/cost limit stops the user with a friendly message, zero action, existing app unaffected
- [ ] Platform Parity Table complete — no `❌ Gap` remains
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx test movie-assistant` / `movie-mcp` / `web-api-mcp` — Python unit tests pass (≥70% coverage)
- [ ] `pnpm nx test:integration movie-assistant` / `movie-mcp` / `web-api-mcp` — against real MCP + real `mc-service`, pass
- [ ] `pnpm nx test mcm-app` + `pnpm nx test:integration mcm-app` — BFF unit + integration pass
- [ ] `pnpm nx lint movie-assistant` / `movie-mcp` / `web-api-mcp` / `mcm-app` — no errors
- [ ] `pnpm nx e2e mcm-app` — web E2E (assistant flows + existing regression) pass
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E pass (logged-out start between runs)
- [ ] Golden-pair regression suite green and gating deployment (T063)
- [ ] `rtk gain` — >80% token compression confirmed (run last)

---

## Notes

- `[P]` = different files, no incomplete-task dependency. `[Story]` maps to spec.md user stories.
- Integration tests MUST hit real MCP servers + real `mc-service` (no mocking the dependency under integration); LLM determinism in CI comes from the cassette/replay harness (T032), never from mocking agent logic.
- Behavior-Descriptive Identifiers: no `FR-`/`SC-`/`US#` in code identifiers — put the requirement ID in a provenance comment only.
- `mc-service` is **not modified** — all domain writes go through `movie-mcp` → existing `mc-service` endpoints.
- Default provider is Ollama; if the golden-pair gate fails or p95 regresses on the prod Ollama model, switch that node/provider to Claude (research R1) — not a code change, an env switch.
