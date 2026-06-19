# Feature 018 — Per-User Agent Config — Session Handoff

**Date**: 2026-06-19 (Slice D Python+BFF landed) · **Branch**: `018-per-user-agent-config`

Read first (in order): [spec.md](spec.md) · [plan.md](plan.md) · [research.md](research.md) · [data-model.md](data-model.md) · [contracts/](contracts/) · [tasks.md](tasks.md). This file is the live state + how to resume.

## What's done & verified (committed)

Branch commits, newest last:
- `42c2e46` — analyze remediations (spec/tasks/contract).
- `d1f6d45` — **Phase 1+2 foundation (T001–T010)**: mongodb driver; env keys; `agent-config-crypto` (5 unit GREEN); logger redaction (6 unit GREEN); `mongo-client`; `agent-config-store` (3 integration GREEN); `agent-config-service` (non-secret view + `isRunnable` + stubs); `types/agent-config`.
- `18433af` — **US1 core (T011,T012,T015,T016,T017,T018)**: GET/DELETE `/bff-api/agent/config`; `resolveForRun` + `run+api` short-circuit (`assistant_not_configured`, HTTP 200); `use-assistant-config` hook + dock gate.
- `8e0298f` — **US2 probes + PUT validate-on-save (T019,T020,T025,T026)** — VERIFIED LIVE. Probes module (Ollama/Anthropic/TMDB, 5s AbortController, safe `{reason}`); `validateAndSave` + PUT handler (shape→400, missing-required-for-enable→400, probes→422 all-or-nothing, encrypt+upsert, FR-014 omitted-secret-kept). PUT added to `AGENT_ROUTES`; PUT IDOR case added to scoping test. `ProbeField` widened (provider/costLimitUsd).
- `883458a` — **US2 form + hook + profile wiring (T023,T027,T028)**. `MovieAssistantConfig` DS component (R1–R7 scan GREEN); hook gained `save`/`test`; mounted in `ProfileScreen` (ScrollView).
- `a3a8a7d` — **Slice D Python + BFF per-run injection (T021,T022,T029,T030,T031,T032)** — the MVP-blocking remainder of US2 that makes a configured run actually USE the user's creds at the model + TMDB layer. TDD throughout; pure `select_model_config`/`build_chat_model` signatures untouched (golden gate unaffected). Details:
  - **T029** `AgentConfigMiddleware` (pure ASGI, `x-agent-config` → `_agent_config` ContextVar) in `runtime_context.py` + registered in `gateway.build_app`; `agui_identity.inject_agent_config` bridges the ContextVar → `config["configurable"]["agent_config"]` in `prepare_stream`; `parse_agent_config` fail-safe; `agent_config_scope` node-scope contextmanager.
  - **T030** `models.runtime_env(agent_config, base)` overlays provider/ollamaBaseUrl/anthropicKey → MODEL_PROVIDER/OLLAMA_BASE_URL/ANTHROPIC_API_KEY; `models.escalation_or_base(env)` degrades escalation→base specialist with no Anthropic key (R10). The three model-build closures (`_default_extract`/`_default_plan`/`_default_query_extract`) source `_runtime_env()` (`get_agent_config()` overlaid on os.environ) and pass it to `build_chat_model`. **The threading solution = a node-task ContextVar bridge** (NOT changing `ExtractFn(messages)->dict`): the curator/organizer/query node wrappers `with agent_config_scope(_agent_config_of(config))` re-set the ContextVar from `config` in the node's own task, so the synchronous model build (same task) reads the per-run config. This keeps all one-arg `extract=lambda _m:` test stubs valid (zero churn to pure nodes + their tests).
  - **T031** per-run TMDB key: `mcp_tools._call_tmdb_key` ContextVar + `tmdb_key_scope(key)` cm + `DownscopedTokenAuth` now adds `X-TMDB-Key` when set (scoped to web-api-mcp calls ONLY — curator binds it for the whole node since curator only calls web; search binds it ONLY inside `web_search` so movie-mcp never sees the key). web-api-mcp `server.py`: `_request_tmdb_key` ContextVar + `TmdbKeyMiddleware` (wraps `mcp.streamable_http_app()` in `build_app`); `_tmdb_key()` prefers the per-request key, env/Vault is now only a fallback (FR-021).
  - **T032** BFF `agent-gateway-client.createMovieAssistantAgent` serializes `ResolvedRunConfig` → `X-Agent-Config` header; `run+api.ts` passes the already-resolved `runConfig`. Logger redaction already covers `agentConfig`/`anthropicKey`/`tmdbKey` (T009).
  - **T022** leak-scan + `state.forbid_token_fields` markers extended with `api_key`/`apikey`/`agent_config`; planted-leak unit asserts a logged `agent_config`/`*_api_key` is flagged.

**Verified GREEN this session (no live stack):** agent unit **827 passed/2 skip**; agent leak-scan 12/12 (full static scan over agent+MCP src clean with new markers); golden replay **39 passed** (`LLM_CASSETTE_MODE=replay`, deselected 63); agent ruff+mypy clean (43 files); web-api-mcp unit **13 passed** + lint clean (5 files); BFF `tsc --noEmit` clean; BFF `nx lint mcm-app` 0 errors (2 pre-existing `require()` warnings).

**Verified GREEN this session (live stack):**
- T013 route-auth integration (14/14) + T013a IDOR scoping (now GET/PUT/DELETE, 3 cases).
- Full agent-config integration set: **5 suites / 32 tests** (`--testPathPattern "agent-config|agent-route-auth"`) — crypto, store, probes-vs-real-Ollama+TMDB, save, scoping, route-auth.
- `tsc` clean; `nx lint mcm-app` green (only 2 pre-existing `require()` warnings); DS-compliance scan green; profile/assistant unit (5) green.

## Stack state (left running)

Up & healthy: `mcm-keycloak-service-1`, `mcm-mcm-redis-1`, `mc-db`, `mcm-keycloak-db-1`, `mcm-keycloak-mailpit-1`, **plus** `agent-gateway` (:8123 via gw-proxy), `movie-mcp`, `web-api-mcp`, `spreadsheet-mcp`, `mc-service`. Ollama on host (:11434, `qwen2.5:32b`).

**BFF (Metro :8081)** was started this session via `cd frontend/mcm-app && pnpm start` (bg). It loaded the 018 env keys.

**Env added to `frontend/mcm-app/.env.local` (gitignored, NOT committed):**
- `AGENT_CONFIG_ENC_KEY` (32-byte base64, generated this session)
- `MONGO_URL=mongodb://localhost:27017`
- `TMDB_API_KEY` (copied from `mcp-servers/web-api-mcp/.env.local`) — needed by the probe/save integration tests.

If you restart the BFF, these must be present in its env. The integration harness loads them from `.env.local`.

## Remaining work

### US2 — Slice D is CODE-COMPLETE (T021,T022,T029–T032 done + unit/lint/golden GREEN). Left: live E2E verification.

The per-run injection chain (X-Agent-Config → middleware → configurable → node-task ContextVar → model build; X-TMDB-Key → web-api-mcp) is implemented and unit/golden-verified. **NOT yet run against the live stack.** Next steps for Slice D:
1. **Rebuild the agent-gateway + web-api-mcp images** (stale image = old code — [[project-mcm-containerized-agent-stack]]): they now read `X-Agent-Config`/`X-TMDB-Key`. `pnpm nx docker-build` the changed agent images (or `agent-stack.mjs`).
2. **T024a** (`tests/integration/agent-config-run-revoked.integration.test.ts`) — revoked-credential-at-run-time fails user-safe, no leak. Needs the run path.
3. **T024/T014** web E2E (below) — needs the dev-container + **T050 seeding**.
4. **T051 (SC-002)** — run the stack with NO shared model/TMDB env: configured user works, unconfigured short-circuits.

The historical Slice-D TDD plan (now executed) is retained below for reference / re-derivation:

1. **T029 — `inject_agent_config` + `AgentConfigMiddleware` + ContextVar** (low risk; mirror the subject-token bridge exactly):
   - `runtime_context.py`: add `_agent_config: ContextVar`, `get_agent_config()`, `parse_agent_config(header)` (fail-safe JSON→dict like `parse_ui_snapshot`), and `AgentConfigMiddleware` reading header `x-agent-config` (pure ASGI — NOT BaseHTTPMiddleware).
   - `gateway.py` `build_app`: `app.add_middleware(AgentConfigMiddleware)` alongside the others.
   - `agui_identity.py`: add `inject_agent_config(config, cfg)` → `config["configurable"]["agent_config"] = cfg`; call it in `IdentityAwareAGUIAgent.prepare_stream` (it runs in the request task, where the ContextVar IS visible — same reason subject_token is bridged here). No-op when absent (SC-005).
   - Unit-test (T021 part 1, pytest, no stack): `inject_agent_config` places provider/keys under `configurable`; middleware parse fail-safe.

2. **T030 — model build from per-run config** (the hard part — design decision below):
   - The three model-build call sites are closures in [runtime_nodes.py](../../agents/movie-assistant/src/runtime_nodes.py): `_default_extract` (curator), `_default_plan` (organizer), `_default_query_extract` (query) — each does `build_chat_model(select_model_config(node, os.environ))`.
   - **The threading problem**: `curator` node is `async def curator(state)` — it does NOT receive `config`, so `config["configurable"]["agent_config"]` is not directly reachable inside the closure. (organizer/approval_gate DO get config — they read `configurable.subject_token`.)
   - **Decide between**: (a) thread `config` into the `ExtractFn`/`PlanFn`/`QueryExtractFn` signatures and into the node fns (invasive: changes `nodes/curator.py`, `nodes/organizer.py`, `nodes/query.py` signatures + `runtime_nodes` wiring + their unit tests — and `curator.py` must NOT use `from __future__ import annotations` or LangGraph won't inject `config`, see memory [[project-langgraph-config-injection-future-annotations]]); OR (b) a small `runtime_env(configurable) -> Mapping[str,str]` helper that overlays `agent_config` onto `os.environ` (MODEL_PROVIDER / OLLAMA_BASE_URL / ANTHROPIC_API_KEY), fed from the node's `config`. Either way the **pure** `select_model_config(node, env)` / `build_chat_model(spec, env)` signatures stay UNCHANGED (research R8) so the golden harness is unaffected — only the *mapping source* swaps from `os.environ` to the per-run env.
   - Escalation degrades to base when no `anthropic_api_key` in the per-run config (R10) — handle at the escalation select/build site.
   - After the prompt/seam change, **re-record affected golden cassettes** only if a prompt changed (it shouldn't here — this is plumbing, not prompt).

3. **T031 — `web-api-mcp` per-run TMDB key**: `server.py` reads `X-TMDB-Key` per request into a ContextVar; `_tmdb_key()` returns it; remove env/Vault TMDB from the user-facing runtime (FR-021). Gateway attaches `X-TMDB-Key` on the MCP streamable-HTTP calls for that run. Keep `enable_dns_rebinding_protection=False` (012).

4. **T032 — BFF `X-Agent-Config` wiring**: `agent-gateway-client.ts` serializes the resolved config to the `X-Agent-Config` header; `run+api.ts` calls `resolveForRun(userId)` and passes it. Extend the BFF logger redaction to never log this header (FR-024 — confirm `agentConfig`/`X-Agent-Config` already in `SENSITIVE_KEYS` from T009). Map provider/TMDB run-time failures to a user-safe message (revoked-credential path → T024a).

5. **T022 — leak-scan extension**: extend `eval/token_leak_scan.py` + `state.forbid_token_fields` markers to cover `anthropic_api_key`/`tmdb_api_key`/`agent_config`; planted-leak unit asserts detection.

6. **Verify**: agent pytest unit + leak scan; rebuild the gateway image (stale image = old code — memory [[project-mcm-containerized-agent-stack]]); `LLM_CASSETTE_MODE=replay` golden gate still green; then T024/T024a/T014 web E2E (below).

### Web E2E (T014, T024) + globalSetup seeding (T050) — needs dev-container

🚨 **The dock is now gated on a runnable config (T018).** The existing 012/014 assistant web E2E specs (assistant*.spec.ts, agent*.spec.ts) assume the dock renders → they will FAIL for the test user until **T050** seeds a `user_agent_config` row (provider=ollama + TMDB key) for the E2E test user in Playwright `globalSetup`. **Do T050 before/with the first dev-container web E2E run**, else the whole assistant suite is red. T014 itself (the OFF/new-user case) does NOT need seeding — but the rest of the suite does.

- **T014** — `tests/e2e/web/assistant-config.spec.ts` (new): fresh/unconfigured user → no dock + `POST /run` → `assistant_not_configured`. (May need a dedicated unconfigured user, or clear config in `afterEach`.)
- **T024/T024a** — enable+configure+save → dock → interaction succeeds on per-user creds; bad key → per-field 422; revoked credential → user-safe failure, no leak.
- Run via `E2E_BFF_TARGET=dev-container` after `pnpm nx docker-build mcm-app` (rebuild image after any src change). See [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md).

### Then: US3 (T033–T036), US4 (T037–T040), US5 (T041–T044), Mobile (T045–T048), Polish (T049–T053)

Note: the **`POST /config/test` endpoint (T035, US3)** is already referenced by the form's Test button + the hook's `test()` — it returns 404 until T035 lands. Add it to `AGENT_ROUTES` then.

## Load-bearing notes

- `--profile` goes BEFORE `up`/`down` (compose v2). Nx `up-keycloak`/`up-app` are broken for this — use `docker compose --profile <p> up -d`.
- Decrypted secrets are per-run, in-memory only (SC-004). BFF logger already redacts 018 fields (T009).
- New BFF routes MUST join `AGENT_ROUTES` (compensating control).
- `.env.local` is gitignored (`*.env.*`); committed env reference goes in `docs/runbooks/local-dev.md` (T052).
- Form non-secret fields hydrate via React render-phase state-adjustment keyed on `updatedAt` (NOT a setState-in-effect — that lint rule is enforced); secret inputs are write-only and never hydrated.
- DS-compliance scan: fontSize must be on the MD3 scale (13 is OFF — use 12/14/16/18…).
