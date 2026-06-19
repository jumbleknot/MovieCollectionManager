---
description: "Task list for Per-User Movie Assistant Configuration (018)"
---

# Tasks: Per-User Movie Assistant Configuration

**Input**: Design documents from `/specs/018-per-user-agent-config/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/)

**Tests**: REQUIRED — TDD is constitution-mandatory. Every test task carries a **Verify RED**; every paired implementation task carries a **Verify GREEN** (per `docs/templates/feature-test-tasks-template.md`).

**Organization**: Grouped by user story (priority order). MVP = Phase 1 + 2 + US1 + US2 (P1 stories).

**Conventions**: `pnpm nx` invocation only. Web E2E runs via the **dev-container** path (rebuild image after any `src` change). Mobile agent flows run in **CI**. Decrypted secrets are per-run/in-memory only (SC-004). New BFF routes MUST be added to the `AGENT_ROUTES` allowlist.

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Add `mongodb` Node driver to `frontend/mcm-app/package.json` via `pnpm add mongodb` (BFF→Mongo dependency, plan §Primary Dependencies); confirm `pnpm install` passes the pnpm-only guard.
- [X] T002 [P] Add env keys to `frontend/mcm-app/src/config/env.ts`: `AGENT_CONFIG_ENC_KEY` (required, 32-byte base64) and `MONGO_*` (BFF→Mongo connection); read via the existing `optionalEnv`/required-env helpers. Throw at startup if `AGENT_CONFIG_ENC_KEY` is missing in production.
- [X] T003 [P] Add `.env.example` entries + a gitignored local-dev value note for `AGENT_CONFIG_ENC_KEY` and `MONGO_*` in `frontend/mcm-app/.env.example` (no real key text — NFR-Sec-1).

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Blocks all user stories. The credential store, encryption, and config plumbing everything else builds on.

- [X] T004 [P] Write encryption round-trip unit test in `frontend/mcm-app/src/bff-server/agent-config-crypto.test.ts`: `encrypt(plaintext)` → blob ≠ plaintext; `decrypt(encrypt(x)) === x`; tampered blob (flip a ciphertext byte) → throws (GCM auth fail). **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern "agent-config-crypto"` → fails (module absent).
- [X] T005 Implement AES-256-GCM module in `frontend/mcm-app/src/bff-server/agent-config-crypto.ts` (Node `crypto`, random 12B IV, store `iv||tag||ciphertext` base64; key from `env.agentConfigEncKey`). **Verify GREEN**: same command → passing. (Prereq: T004 RED.)
- [X] T006 Implement BFF Mongo connection singleton in `frontend/mcm-app/src/bff-server/mongo-client.ts` (lazy connect, scoped `MONGO_*` creds, returns `mc_db` handle); no secret in logs.
- [X] T007 [P] Write `user_agent_config` store integration test in `frontend/mcm-app/tests/integration/agent-config-store.integration.test.ts` (REAL Mongo): upsert→read returns saved non-secret fields; `*Enc` round-trips; omitted-secret PUT leaves stored secret intact (FR-014); `afterAll` deletes the test userId doc. **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-store"` → fails (store absent).
- [X] T008 Implement store CRUD in `frontend/mcm-app/src/bff-server/agent-config-store.ts` (`getByUserId`, `upsert`, `clear` per data-model state transitions; `_id=userId`). **Verify GREEN**: same command → passing. (Prereq: T007 RED.)
- [X] T009 [P] Extend logger redaction in `frontend/mcm-app/src/bff-server/logger.ts` `SENSITIVE_KEYS`: add `anthropicKey`, `tmdbKey`, `anthropicKeyEnc`, `tmdbKeyEnc`, `agentConfig`, `AGENT_CONFIG_ENC_KEY` (FR-024, NFR-Sec-3). Add a unit assertion in `logger.test.ts` that these keys redact.
- [X] T010 Implement config service shell in `frontend/mcm-app/src/bff-server/agent-config-service.ts`: `getNonSecretView(userId)` (data-model non-secret projection + derived `escalationAvailable`/`has*`) and stubs for `validateAndSave` / `testStored` / `resolveForRun` / `clear` (filled per story). No secret returned by `getNonSecretView`.

**Checkpoint**: Encryption, durable store, and the non-secret view exist and are tested against real Mongo.

---

## Phase 3: User Story 1 — Assistant is off until I opt in (Priority: P1) 🎯 MVP

**Goal**: New/disabled/under-configured users get no dock and zero external calls; a run request short-circuits with `assistant_not_configured` before any gateway call or cost.

**Independent Test**: Sign in as a fresh user → no dock; force `POST /bff-api/agent/run` → typed `assistant_not_configured`, Redis `agent-cost:{userId}` unchanged, no gateway call.

### Tests for User Story 1

- [X] T011 [P] [US1] Write GET-config route unit test in `frontend/mcm-app/tests/app/bff-api/agent/config/index.test.ts`: unauth→401; non-mc-user→403; new user→`{enabled:false, hasTmdbKey:false, …, updatedAt:null}`; never returns a secret. **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern "agent/config/index"` → fails (route absent).
- [X] T012 [P] [US1] Write run short-circuit unit test in `frontend/mcm-app/tests/app/bff-api/agent/run.test.ts` (extend): not-runnable config → `assistant_not_configured`, asserts the gateway client + `recordEstimatedTurnCost` are NOT called. **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern "agent/run"` → fails (no short-circuit).
- [X] T013 [P] [US1] Add new routes to `AGENT_ROUTES` in `frontend/mcm-app/tests/integration/agent-route-auth.integration.test.ts`: `GET /bff-api/agent/config`, `PUT /bff-api/agent/config`, `DELETE /bff-api/agent/config`, `POST /bff-api/agent/config/test`. **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern "agent-route-auth"` → fails (routes unprotected/absent).
- [X] T013a [P] [US1] Write caller-scoping (IDOR) test in `frontend/mcm-app/tests/integration/agent-config-scoping.integration.test.ts` (FR-017, Deny-by-Default/Least-Privilege): authenticated as user A, send GET/PUT/DELETE with a **spoofed body `userId`/`_id` = user B** → all operations act ONLY on A's document (B's doc untouched, A reads/writes A's row); the owning identity is taken from the validated session, never the body. `afterAll` deletes both test docs. **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-scoping"` → fails (handlers/store not yet enforcing session-derived userId). **Verify GREEN**: same command passes once T015 (GET/DELETE) lands; the PUT and test-route assertions go green as T026 (US2) and T035 (US3) land — re-run after each. All handlers MUST derive `userId` from `requireAuth` and ignore any body-supplied id.
- [X] T014 [US1] Write web E2E gating spec in `frontend/mcm-app/tests/e2e/web/assistant-config.spec.ts` (new-user case): logged-in fresh user (no config) → `[data-testid="assistant-dock"]` absent; direct `page.request.post('/bff-api/agent/run', …)` → `assistant_not_configured` body. Seed nothing; `afterEach` clears any config via `DELETE /bff-api/agent/config`. **Verify RED**: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/assistant-config.spec.ts --grep "off by default"` → fails (dock shows / no short-circuit).

### Implementation for User Story 1

- [X] T015 [US1] Implement `GET` + `DELETE` handlers in `frontend/mcm-app/src/app/bff-api/agent/config/index+api.ts` (auth→`requireMcUser`→service; `withRequestContext`, `securityHeaders`, `handleMcApiError`; GET=non-secret view, DELETE=clear semantics R9). DELETE MUST emit `logger.audit('assistant_config_cleared', { userId })` (FR-019; userId only, no secret). **Verify GREEN**: T011 command → passing. (Prereq: T011 RED.)
- [X] T016 [US1] Implement `resolveForRun(userId)` runnability + short-circuit in `agent-config-service.ts` and wire into `frontend/mcm-app/src/app/bff-api/agent/run+api.ts` (after `requireMcUser`, before rate/cost/gateway): not-runnable → typed `assistant_not_configured`, return early. **Verify GREEN**: T012 command → passing. (Prereq: T012 RED.)
- [X] T017 [P] [US1] Implement `use-assistant-config` hook in `frontend/mcm-app/src/hooks/use-assistant-config.tsx` (GET on mount; exposes `enabled`, `hasAnthropicKey`, `hasTmdbKey`, `escalationAvailable`, refresh).
- [X] T018 [US1] Gate the dock in `frontend/mcm-app/src/app/(app)/_layout.tsx` `AuthedAssistant`: mount `AssistantProvider`/`AssistantDock` only when `enabled && requiredProviderCred && hasTmdbKey` (per hook). **Verify GREEN**: T013 + T014 commands → passing. (Prereq: T013, T014 RED.)

**Checkpoint**: US1 independently testable — fresh user has no dock and cannot incur cost.

---

## Phase 4: User Story 2 — Enable and configure my own assistant (Priority: P1) 🎯 MVP

**Goal**: From Profile, enable + pick provider + supply credentials + TMDB key; validate-on-save (≤5s probes, per-field 422); encrypt + persist; dock appears; a real run uses the per-user credentials.

**Independent Test**: Configure (Ollama + TMDB) → save succeeds → dock appears → an assistant interaction succeeds using those creds. Separately, save with a bad key → per-field 422, nothing persisted.

### Tests for User Story 2

- [X] T019 [P] [US2] Write live-probe integration test in `frontend/mcm-app/tests/integration/agent-config-probes.integration.test.ts` (REAL Ollama + REAL TMDB from CI secrets): valid creds→`ok`; deliberately-bad key→`{reason}`; each probe respects a 5s timeout. **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-probes"` → fails (probes absent).
- [X] T020 [P] [US2] Write PUT validate-on-save integration test in `frontend/mcm-app/tests/integration/agent-config-save.integration.test.ts` (REAL Mongo + probes): valid PUT→200 + encrypted persist; bad-key PUT→422 per-field + nothing persisted (assert doc unchanged); omitted secret keeps stored value (FR-014). **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-save"` → fails.
- [X] T021 [P] [US2] Write Python per-run injection unit test in `agents/movie-assistant/tests/unit/test_agent_config_injection.py`: `inject_agent_config` places provider/keys under `configurable`; node model build sources from `configurable` not `os.environ`; missing anthropic key → escalation degrades to base (R10). **Verify RED**: agent unit target (see docs/agent-layer.md) → fails (injection absent).
- [X] T022 [P] [US2] Extend the SC-004 token-leak scan markers in `agents/movie-assistant/src/eval/token_leak_scan.py` + `state.py` to cover `anthropic_api_key`/`tmdb_api_key`/`agent_config`; add a unit asserting a planted `logger.info(agent_config)` is flagged. **Verify RED**: `leak_scan`-marked test → fails (markers not yet covering new fields) OR planted-leak not detected.
- [X] T023 [P] [US2] Write design-system compliance assertion run for the new UI: ensure `frontend/mcm-app/src/components/agent/movie-assistant-config.tsx` passes R1–R7. **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern "design-system-compliance"` → fails once the new file exists with any raw color/font/button (drives DS-correct authoring).
- [X] T024 [US2] Write web E2E configure+save+bad-key cases in `frontend/mcm-app/tests/e2e/web/assistant-config.spec.ts`: (a) enable+Ollama+TMDB+save → dock appears → drive one interaction succeeds; (b) bad Anthropic key → per-field 422 surfaced, GET still unconfigured. `afterEach` DELETE teardown. **Verify RED**: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/assistant-config.spec.ts --grep "configure|bad key"` → fails.

- [X] T024a [P] [US2] Write revoked-credential-at-interaction-time integration test in `frontend/mcm-app/tests/integration/agent-config-run-revoked.integration.test.ts` (spec Edge Cases; REAL Mongo + run path): seed a runnable config whose stored provider/TMDB credential is invalid (revoked after save), drive a run → the run fails with a **user-safe** message (no raw provider body, no key, no internal detail), and the failure carries no secret in the response/logs (assert redaction). `afterAll` clears the test doc. **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-run-revoked"` → fails (no safe-failure path / leaks raw error).

### Implementation for User Story 2

- [X] T025 [US2] Implement live probes in `frontend/mcm-app/src/bff-server/agent-config-probes.ts` (Ollama `/api/tags`, Anthropic `/v1/models`, TMDB `/authentication`; 5s `AbortController`; normalize to safe `{field,reason}` — never forward raw provider bodies). **Verify GREEN**: T019 → passing. (Prereq: T019 RED.)
- [X] T026 [US2] Implement `validateAndSave` in `agent-config-service.ts` + the `PUT` handler in `frontend/mcm-app/src/app/bff-api/agent/config/index+api.ts` (shape/enum/type checks→400; probes→422 all-or-nothing; encrypt+upsert; audit). **Verify GREEN**: T020 → passing. (Prereq: T020 RED.)
- [X] T027 [P] [US2] Implement the config form component `frontend/mcm-app/src/components/agent/movie-assistant-config.tsx` from `@mcm/design-system` (toggle, provider picker, provider field(s), TMDB field, optional cost-limit field, Save, Test buttons; `NoAutoFillInput` for all fields; write-only secret fields with "configured" indicator; escalation note per R10; stable `testID`s). **Verify GREEN**: T023 → passing. (Prereq: T023 RED.)
- [X] T028 [US2] Wire the form into `frontend/mcm-app/src/components/profile-display.tsx` as a "Movie Assistant" section; save via `use-assistant-config` hook (PUT) and refresh flags. (depends on T017, T027)
- [X] T029 [P] [US2] Implement Python `inject_agent_config` in `agents/movie-assistant/src/agui_identity.py` + `AgentConfigMiddleware` in `gateway.py` + ContextVar in `runtime_context.py` (`X-Agent-Config` header → configurable; pure-ASGI, no-op when absent). **Verify GREEN**: T021 (injection portion) → passing. (Prereq: T021 RED.)
- [X] T030 [US2] Switch model build to per-run config in `agents/movie-assistant/src/models.py` call sites + `runtime_nodes.py` (assemble env-mapping from `configurable`; keep pure `select_model_config(node, env)`/`build_chat_model(spec, env)` signatures so the golden harness is unaffected). **Verify GREEN**: T021 → passing. (Prereq: T029.)
- [X] T031 [US2] Inject per-run TMDB key into `mcp-servers/web-api-mcp/src/server.py` (`X-TMDB-Key` request header → ContextVar; `_tmdb_key()` reads ContextVar; remove env/Vault TMDB path from user-facing runtime — FR-021) and have the gateway attach `X-TMDB-Key` on MCP calls. **Verify GREEN**: T022 leak scan + the integration run still green; per-run TMDB used.
- [X] T032 [US2] Serialize resolved config to `X-Agent-Config` in `frontend/mcm-app/src/bff-server/agent-gateway-client.ts` and decrypt+pass via `resolveForRun` in `run+api.ts`. Ensure provider/TMDB failures surfaced during a run map through `handleMcApiError`/node error surfacing to a user-safe message with no raw provider body or secret (revoked-credential path). **Verify GREEN**: T024 → passing (run succeeds with per-user creds); **T024a → passing** (revoked credential fails safely, no leak). (Prereq: T016, T026, T029–T031.)

**Checkpoint**: US1 + US2 = MVP. A user goes off→configured→working assistant on their own credentials; bad keys rejected per-field.

---

## Phase 5: User Story 3 — Re-test a saved credential without re-entering it (Priority: P2)

**Goal**: "Test connection" re-probes stored, server-decrypted credentials; per-credential status; no re-entry, no secret to client.

**Independent Test**: With saved valid creds, press Test connection → all `ok`; spoil one stored cred → that one reports `{reason}`, others `ok`.

### Tests for User Story 3

- [X] T033 [P] [US3] Write `POST /config/test` integration test in `frontend/mcm-app/tests/integration/agent-config-test.integration.test.ts` (REAL Mongo + probes): stored valid→`{tmdb:"ok",…}`; spoiled stored key→`{anthropic:{reason}}`; response carries NO secret value; nothing-to-test→409. **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-test"` → fails (route absent).
- [X] T034 [US3] Add Test-connection web E2E case to `frontend/mcm-app/tests/e2e/web/assistant-config.spec.ts`: saved config → click `[data-testid="assistant-test-connection"]` → status row shows per-credential `ok` without re-entry. **Verify RED**: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/assistant-config.spec.ts --grep "test connection"` → fails.

### Implementation for User Story 3

- [X] T035 [US3] Implement `testStored(userId)` in `agent-config-service.ts` + `POST` handler in `frontend/mcm-app/src/app/bff-api/agent/config/test+api.ts` (decrypt in-memory→probes→per-credential status; audit; never returns secret). **Verify GREEN**: T033 → passing. (Prereq: T033 RED.)
- [X] T036 [US3] Wire the Test-connection control in `movie-assistant-config.tsx` to the hook's test call and render the per-credential status. **Verify GREEN**: T034 → passing. (Prereq: T034 RED.)

**Checkpoint**: US3 independently testable on top of US2.

---

## Phase 6: User Story 4 — Disable the assistant (Priority: P2)

**Goal**: Disabling hides the dock and short-circuits runs; provider/non-secret settings retained on disable; clear (DELETE) wipes secrets but keeps non-secret settings.

**Independent Test**: Enabled user disables → dock gone, run short-circuits; re-enable shows prior provider selection; DELETE clears secrets but keeps provider.

### Tests for User Story 4

- [X] T037 [P] [US4] Write clear-semantics integration test in `frontend/mcm-app/tests/integration/agent-config-store.integration.test.ts` (extend): `DELETE`→`enabled=false`, `*Enc` removed, `provider`/`ollamaBaseUrl`/`costLimitUsd` retained (R9). **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-store"` → fails (clear keeps secrets / wrong shape).
- [X] T038 [US4] Add disable web E2E case to `frontend/mcm-app/tests/e2e/web/assistant-config.spec.ts`: enabled→toggle off→save→dock disappears→`POST /run` short-circuits; re-enable shows retained provider. **Verify RED**: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/assistant-config.spec.ts --grep "disable"` → fails.

### Implementation for User Story 4

- [X] T039 [US4] Implement `clear(userId)` in `agent-config-service.ts`/`agent-config-store.ts` per R9 (disable + wipe secrets, keep non-secret). **Verify GREEN**: T037 → passing. (Prereq: T037 RED.) Note: disable-via-PUT path reuses T026; dock/run gating reuses T016/T018.
- [X] T040 [US4] Ensure `movie-assistant-config.tsx` disable toggle persists via PUT and the dock gate (T018) reacts to the refreshed flag. **Verify GREEN**: T038 → passing. (Prereq: T038 RED.)

**Checkpoint**: US4 independently testable; opt-in is fully reversible.

---

## Phase 7: User Story 5 — Cap my own spend (Priority: P3)

**Goal**: Optional per-user spend ceiling overrides the global default; unset = unchanged behavior.

**Independent Test**: Unset → global default governs; set low → runs short-circuit at the user's ceiling.

### Tests for User Story 5

- [X] T041 [P] [US5] Write per-user ceiling unit test in `frontend/mcm-app/src/bff-server/agent-rate-limiter.test.ts` (extend): `enforceAgentCostCeiling(userId, override)` uses `override` when provided, else `env.agentSessionCostCeilingUsd`; accrual key `agent-cost:{userId}` unchanged. **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern "agent-rate-limiter"` → fails (no override param).
- [X] T042 [US5] Write web E2E cost-limit case in `frontend/mcm-app/tests/e2e/web/assistant-config.spec.ts`: set a tiny `costLimitUsd`, drive interactions until accrued cost exceeds it → cost-ceiling response. **Verify RED**: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/assistant-config.spec.ts --grep "cost limit"` → fails.

### Implementation for User Story 5

- [X] T043 [US5] Add optional `ceilingOverrideUsd` param to `enforceAgentCostCeiling` in `frontend/mcm-app/src/bff-server/agent-rate-limiter.ts`; pass `config.costLimitUsd ?? undefined` from `run+api.ts`. **Verify GREEN**: T041 → passing. (Prereq: T041 RED.)
- [X] T044 [US5] Persist + display `costLimitUsd` in the PUT path (T026 already accepts it) and the form's cost-limit field. **Verify GREEN**: T042 → passing. (Prereq: T042 RED.)

**Checkpoint**: All user stories independently functional.

---

## Phase 8: Mobile Parity (Maestro — CI)

- [X] T045 [P] [US1] Create `frontend/mcm-app/tests/e2e/mobile/assistant-config-gating.yaml`: fresh user → no dock (logged-out start; in-app navigate, never deep-load before the dock).
- [X] T046 [P] [US2] Create `frontend/mcm-app/tests/e2e/mobile/assistant-config-enable.yaml`: enable+Ollama+TMDB+save → dock appears → one interaction succeeds.
- [X] T047 [P] [US3] Create `frontend/mcm-app/tests/e2e/mobile/assistant-config-test-connection.yaml`: saved config → Test connection → status shown.
- [X] T048 [P] [US4] Create `frontend/mcm-app/tests/e2e/mobile/assistant-config-disable.yaml`: disable → dock disappears.

> Mobile agent flows run in CI (`android-e2e.yml`) — locally Metro OOMs after ~1–2 agent `/run` calls. See [docs/runbooks/android-emulator.md](../../docs/runbooks/android-emulator.md). The four flows above are authored + registered in the `android-e2e.yml` flow loop; their green run is gated on the mobile-CI provisioning (per-user config seeded for the mobile user + a provider reachable from the emulator + TMDB key) tracked as **issue #16** — the same dependency the existing `agent-*` mobile flows share.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T049 [P] Implement the CI secret-scan guard (grep key-shaped `sk-ant-…` + TMDB v3 token patterns across committed files; fail on hit) and a cassette assertion that recorded cassettes carry no `authorization`/`x-api-key`/key values (FR-025, NFR-Sec-4). **Done when**: the guard fails on a planted key and passes on the clean tree.
- [X] T050 Rework the test/golden harness to seed a `user_agent_config` row from env/CI secrets instead of relying on shared env (spec §8, R8): E2E `globalSetup` seeds the test user (`provider=ollama` + TMDB key); confirm the golden cassette gate still replays keyless (`LLM_CASSETTE_MODE=replay`) with no structural change. **Done when**: golden replay green + E2E setup seeds config.
- [X] T051 [P] SC-002 verification task: run the stack with **no** shared model/TMDB env credentials set; confirm a configured user still works and an unconfigured user short-circuits (proves no shared-credential path remains). **Done when**: both observed. **DONE (model path, discriminating proof, 2026-06-19)**: redeployed the gateway with `OLLAMA_BASE_URL=http://127.0.0.1:1` (a DEAD endpoint) — `agent-config.spec.ts` still 3/3 green, i.e. the configured user's live interaction succeeded only because the per-run `X-Agent-Config` overrode the dead env (had the shared env been the source, the run would have failed); the unconfigured user short-circuits at the BFF (never reaches the gateway). The TMDB path uses the identical per-run mechanism (`X-TMDB-Key`, `_tmdb_key()` prefers per-request over env — T031 unit-verified 13/13), so a configured user never relies on the shared TMDB env; an optional further-hardening discriminating E2E (dead web-api-mcp TMDB env + an add-flow interaction) is noted in HANDOFF.
- [X] T052 [P] Docs: add the new env vars (`AGENT_CONFIG_ENC_KEY`, `MONGO_*`, removed `MODEL_PROVIDER`/`OLLAMA_BASE_URL`/`ANTHROPIC_API_KEY`/`TMDB_API_KEY` from user-facing runtime) to [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md) env table and the per-user-config flow to [docs/agent-layer.md](../../docs/agent-layer.md). Update repo-root `CLAUDE.md` if a new always-true rule emerges.
- [X] T053 Run [quickstart.md](quickstart.md) scenarios 1–7 end-to-end (web) + security assertions (Scenario 7: grep logs/spans/traces/checkpoints for test key values → zero hits). **Done when**: all scenarios pass + zero secret hits. **DONE (web, 2026-06-19)**: scenarios 1–6 are the `assistant-config.spec.ts` web E2E (6/6 GREEN via the containerized stack); Scenario 7 verified — the seeded TMDB key plaintext has **0 hits** across the BFF/gateway/web-api-mcp/movie-mcp container logs, the Mongo `user_agent_config` store (only `*Enc` ciphertext), and Redis; GET returns only `has*` flags; the secret-scan guard + clean cassettes pass (T049). Mobile scenarios 2/5 are CI-gated (issue #16).

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1/2: new user → no dock + run short-circuits | assistant-config.spec.ts | assistant-config-gating.yaml | ✅ |
| US2-AC1: enable+configure+save → dock + run succeeds | assistant-config.spec.ts | assistant-config-enable.yaml | ✅ |
| US2-AC2: bad key → per-field 422, nothing persisted | assistant-config.spec.ts | N/A — error-path validation asserted on web + integration; mobile flow covers the happy enable path only (parity for the run outcome, not every 422 field message) | N/A |
| US3-AC1: test connection on saved key (no re-entry) | assistant-config.spec.ts | assistant-config-test-connection.yaml | ✅ |
| US4-AC1: disable → dock disappears, run short-circuits | assistant-config.spec.ts | assistant-config-disable.yaml | ✅ |
| US5-AC2: personal cost ceiling short-circuits | assistant-config.spec.ts | N/A — cost-ceiling accrual is BFF/runtime behavior with no mobile-specific UI surface beyond the shared cost-limit field; asserted on web + unit | N/A |

---

## Dependencies & Execution Order

- **Setup (P1)** → **Foundational (P2)** block everything. Within P2: T004→T005, T007→T008; T006/T009/T010 [P].
- **US1 (P3 phase)** depends only on Foundational. **US2** depends on Foundational; its run-success (T032) depends on US1's run wiring (T016) + the Python injection chain (T029–T031). **US3/US4/US5** depend on Foundational + US2's PUT/store.
- Within a story: tests RED before implementation; store/crypto before service; service before routes; routes before UI wiring; Python injection before `run+api` `X-Agent-Config` pass.
- **Polish (P9)** after all desired stories.

### Parallel Opportunities

- Setup: T002, T003 [P].
- Foundational: T004, T007, T009 [P] (different files); then their impls.
- US2: T019, T020, T021, T022, T023 [P] (distinct test files/areas); T027 (UI) ∥ T029 (Python) once contracts fixed.
- Mobile flows T045–T048 all [P].
- Polish T049, T051, T052 [P].

---

## Implementation Strategy

**MVP** = Phase 1 + 2 + US1 + US2 (both P1). Stop and validate: a user can opt in, bring their own credentials, and run the assistant; an un-opted user costs nothing. Then layer US3 (re-test), US4 (disable), US5 (cost cap) incrementally, each independently testable.

---

## Completion Checklist

Before marking `018-per-user-agent-config` complete, verify all success criteria from [spec.md](spec.md):

- [X] **SC-001**: New user triggers zero model/TMDB calls until opt-in. *(T014 web E2E: no dock + `POST /run` → `assistant_not_configured` before any gateway call/cost.)*
- [X] **SC-002**: No shared-credential path remains (run with no env creds: configured user works, unconfigured short-circuits). *Model path discriminatingly proven (T051): dead gateway OLLAMA env → configured run still green ⇒ per-run injection is the sole source.*
- [X] **SC-003**: Config + secrets persist across sessions/restarts; encrypt→read round-trip green. *(agent-config-store integration: `*Enc` round-trips; FR-014 omitted-secret kept.)*
- [X] **SC-004**: Bad credential rejected per-field; Test connection validates a saved key with no re-entry. *(T024b 422 per-field web E2E + T033 testStored integration + T034 test-connection E2E.)*
- [X] **SC-005**: Unset cost limit = global default unchanged; set limit short-circuits at the user's ceiling. *(T041 unit override + T042 cost-limit web E2E.)*
- [X] **SC-006**: No secret in any committed file/log/span/trace/checkpoint (secret-scan + assertions green). *(T049 guard + T053 runtime grep: 0 hits in logs/Mongo/Redis; cassettes clean.)*
- [~] **SC-007**: Enable/configure/save/test/disable green on web + mobile. *(Web: GREEN — assistant-config.spec.ts 6/6. Mobile: flows authored + registered in android-e2e.yml; green run gated on mobile-CI provisioning — issue #16.)*
- [X] **SC-008**: Live checks return within 5s or actionable failure (no indefinite hang). *(probes use a 5s AbortController → safe `{reason}` on timeout; verified by the probe integration tests + T034.)*
- [ ] Platform parity table complete — no ❌ gaps remain.
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation).
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage).
- [ ] `pnpm nx test:integration mcm-app` — integration tests pass (real Mongo + real Ollama/TMDB probes).
- [ ] `pnpm nx test movie-assistant` — Python unit + SC-004 token-leak scan pass.
- [ ] `pnpm nx test:integration movie-assistant` — agent integration vs real MCP/TMDB pass.
- [ ] `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` — golden gate green (keyless replay).
- [ ] `pnpm nx lint mcm-app` + agent lint — no lint errors; design-system R1–R7 scan passes.
- [ ] `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` — web E2E passes (rebuild dev-container image first).
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes (CI; logged-out start between runs).
- [ ] `rtk gain` — >80% token compression confirmed (run last).

---

## Phase 11 — Post-Implementation Review Remediation (2026-06-19)

High-effort local code review of the feature branch surfaced 10 findings (4 showstoppers, 4 security/correctness, 2 cleanup). Each was fixed TDD-first (failing test → fix → green). All Python unit (`movie-assistant` 848 + `web-api-mcp` 15) and BFF unit (`mcm-app` 1103) suites green; `tsc`, `ruff`, and `secret-scan --selftest` clean.

- [X] **T101 (#1, FR-028) — provider-switch model id**: `models.runtime_env` now drops the shared `SUPERVISOR_MODEL`/`SPECIALIST_MODEL`/`ESCALATION_MODEL` pins when a per-user provider differs from the base, so an Anthropic user no longer inherits the gateway's Ollama model id (which 404'd every Claude call). *Tests: `test_runtime_env_drops_provider_specific_model_pins_on_provider_switch`, `…_keeps_model_pins_when_provider_unchanged`.*
- [X] **T102 (#2, FR-028) — supervisor per-run config**: `graph._default_classifier` now builds from `runtime_env(get_agent_config(), os.environ)` and the supervisor node binds `agent_config_scope` from `config["configurable"]`, so intent classification uses the user's own provider/key (was hard-wired to `os.environ`). *Test: `test_supervisor_binds_per_run_agent_config_for_the_classifier`.*
- [X] **T103 (#4, FR-029) — per-user Anthropic key precedence**: new `models.resolve_anthropic_key` prefers the per-run env-injected key over the shared Vault key (mirroring the per-request TMDB override). *Test: `test_resolve_anthropic_key_prefers_the_per_run_user_key_over_vault`.*
- [X] **T104 (#7, FR-028) — Ollama-only shared-key leak**: `runtime_env` drops `ANTHROPIC_API_KEY` from the overlay for any run that carries no per-user Anthropic key, so an Ollama-only user can never reach the escalation tier on the org's shared key. *Test: `test_runtime_env_drops_shared_anthropic_key_for_an_ollama_only_user`.*
- [X] **T105 (#6, FR-030) — TMDB fail-closed**: web-api-mcp `_tmdb_key()` raises a clear config error when no per-request key is present (was an unauthenticated TMDB call surfaced as "couldn't find it"). *Superseded by T112 below — the static env/Vault fallback was then removed entirely (per-request `X-TMDB-Key` is now the sole source).* *Test: `test_tmdb_key_raises_when_no_per_request_key`.*
- [X] **T106 (#9) — middleware unify**: the four near-identical gateway ASGI middlewares collapse into one `make_header_context_middleware` factory (the SC-004 set/reset discipline now lives in one place). *Test: `test_header_context_factory_sets_and_resets_the_contextvar`.*
- [X] **T107 (#3, FR-026) — SSRF guard**: new `agent-config-ssrf.validateOllamaUrl` blocks link-local/cloud-metadata always, supports the optional `AGENT_OLLAMA_ALLOWED_HOSTS` allow-list, and probes now use `redirect:'manual'`; enforced at save (`validateAndSave`) and probe time (`probeOllama`). *Tests: `agent-config-ssrf.test.ts` (7), `agent-config-probes.test.ts` SSRF short-circuit.*
- [X] **T108 (#10, FR-027) — AES-GCM AAD**: `encryptSecret`/`decryptSecret` take an AAD; `secretAad(userId, field)` binds every blob to its owner+field (cross-user/cross-field decrypt fails). Threaded through service + integration seeds. *Tests: `agent-config-crypto.test.ts` AAD context-binding (4).*
- [X] **T109 (#8, FR-022) — TMDB key never logged**: probe `timedFetch` documented to never surface the raw URL/error; test asserts the returned reason never contains the key. *Tests: `agent-config-probes.test.ts` no-leak (3).*
- [X] **T110 (#5) — mobile E2E order**: `android-e2e.yml` now runs `assistant-config-gating` → `assistant-config-enable` BEFORE the four dock-driving agent flows, with `assistant-config-disable` last, so the (now config-gated) dock is present when those flows run.
- [X] **T111 (cleanups)**: single shared runnability predicate (`isRunnableFrom`/`isViewRunnable`) + shared `DISABLED_AGENT_CONFIG_VIEW` (server + client); `store.upsert` → atomic `findOneAndUpdate`; `validateAndSave` probes only the effective provider's credential (no spurious 422 on a provider switch).
- [X] **T112 (FR-021, no-fallbacks) — remove shared TMDB/model fallbacks + re-scope Vault**: the static env/Vault fallback for the TMDB key and the Vault fallback for the Anthropic model key were **removed entirely** (per-user credentials are the sole source; a missing one fails closed). `web-api-mcp/src/secrets.py` + `test_secrets.py` + the `hvac` dep deleted (TMDB was its only consumer); `models.resolve_anthropic_key` no longer calls `resolve_secret`. Vault now stores **operator secrets only** (gateway OAuth client secret; recommended: BFF master encryption key) — see [docs/PRD-Vault.md](../../docs/PRD-Vault.md). Architecture doc + diagram re-labelled accordingly. *Tests updated: web-api-mcp `test_tmdb_key.py` (per-request sole source + raises), `test_server.py` integration (sets the per-request ContextVar, not env); agent `test_resolve_anthropic_key_uses_only_the_per_run_key_no_fallback`. Gates: web-api-mcp unit 7, agent unit 833, ruff clean.*

> Deferred: the deep escalation-tier wiring of `escalation_or_base` stays a latent guard — the substantive leak (#7) is closed structurally in `runtime_env`, so the helper is retained (not deleted) for when a runtime node routes to escalation. web-api-mcp's single `TmdbKeyMiddleware` is left as-is (its package has only one such middleware — no cross-package shared lib to unify into).
