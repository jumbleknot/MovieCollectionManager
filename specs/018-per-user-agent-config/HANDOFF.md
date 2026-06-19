# Feature 018 — Per-User Agent Config — Session Handoff

**Date**: 2026-06-19 (full web E2E regression GREEN — ready for PR) · **Branch**: `018-per-user-agent-config`

## ▶ RESUME HERE (latest session, HEAD `6e86a94`)

**Full web E2E regression is GREEN.** Feature 018 is functionally complete, web-verified end-to-end, and ready to PR to `main` — gated only on the mobile CI leg (issue #16).

- **Standard non-agent web suite** (dev-container): **130 passed / 30 skipped**.
- **Agent web suite** (`node scripts/agent-e2e.mjs`): **18/18 specs green**. (The "suite" is sequential isolated `nx e2e` per spec, so isolated runs == in-suite.)

This session's commits (newest last):
- `59efc22` — **fixed the assistant-query blocker** (the original ask): scoped `assistant-query.spec.ts` (012) + `.yaml` to count/list; "do I have X" find behavior is owned by the 013 search node (→ `render_selection`, not `render_movie_card`) and covered by `agent-search`. The "runtime-model divergence" diagnosis was WRONG — it's deterministic search-node output.
- `6e86a94` — **fixed two PRE-EXISTING 013 specs** the full regression surfaced (unrelated to 018; rarely run so unnoticed):
  - `agent-add-external-link`: `findAddedMovie` read GET `/bff-api/collections` as `.items` but that endpoint returns a **BARE ARRAY** → `[]` → movie never found (agent flow works fine). Fixed to `(body.items ?? body)`. Also `DONE_TIMEOUT` 90s→180s (approval resume re-runs the graph via a fresh `/run`).
  - `agent-card-navigate`: same root cause as assistant-query (expected a card for "do I have X"; now a search selection button). Repointed to tap the result button → navigate, kept its precise exact-deep-link assertions.

**NEXT STEPS for the fresh session:**
1. **Open the PR to `main`** (user paused on this — confirm with them first). All web gates green; constitution/SDD artifacts (spec/plan/tasks) are aligned and all T001–T053 checked.
2. **Mobile CI (issue #16)** — the four 018 Maestro flows (`assistant-config-*.yaml`) are authored + registered in `android-e2e.yml`; their green run is gated on mobile-CI provisioning (per-user config seeded for the mobile user + a provider reachable from the emulator + TMDB key). Same dependency the existing `agent-*` mobile flows share. SC-007 mobile leg + the platform-parity table close when this runs.
3. Optionally run the remaining Final-Validation-Checklist items in `tasks.md` (Rust unit/integration if any mc-service touch — there was none this feature; `rtk gain`).

**Stack left running & healthy:** agent-gateway (:8123 via gw-proxy), movie-mcp, web-api-mcp, spreadsheet-mcp, mc-service, mcm-bff-dev (recreated with the agent-e2e limit override), redis, keycloak×3, mc-db. Ollama on host (:11434, qwen2.5:32b). `.env.local` / `.env.docker` carry the 018 env (see Load-bearing notes — `MONGO_URL` container value needs `?directConnection=true`).

---

## ✅ Current state: ALL user stories + polish done (web-verified)

Every task T001–T053 is checked in [tasks.md](tasks.md). This session added US3 (re-test), US4 (disable), US5 (cost cap), the four mobile flows, the secret-scan guard, docs, and quickstart validation — all on top of the already-complete MVP (US1+US2). Commits this session, newest last: `3a19bb1` (US3/US4/US5 backend+tests), `519014d` (form right-align fix + web E2E 6/6), `abc0e39` (mobile flows + CI), `9e6a5e5` (secret-scan T049), `37563e7` (docs T052 + quickstart T053).

**Verified GREEN this session:** mcm-app full unit **1086 passed** + lint 0 errors + tsc clean; agent-config integration (test 3/3, store 3/3, route-auth 18/18, rate-limiter override 4/4); **assistant-config web E2E 6/6** (containerized stack — T014/T024/T024b/T034/T038/T042); secret-scan selftest+real-tree GREEN; SC-006 runtime grep → 0 TMDB-key hits in BFF/gateway/MCP logs + Mongo (ciphertext only) + Redis.

**Two durable findings this session:**
- **The assistant-config form's action row MUST be right-aligned** (`justifyContent:'flex-end'`). A configured user (dock present, bottom-LEFT) had the floating dock toggle intercept the left-aligned Save → the disable web E2E timed out. This is the same 015 DS convention (action buttons bottom-right, dock bottom-left). The configure/bad-key tests didn't catch it because they start from a *cleared* config (no dock).
- **`assistant-query.spec.ts` (a 012 spec) FIXED** — was NOT a model divergence (that earlier diagnosis was wrong). The "find hit/miss" cases tested **pre-013 behavior**: "do I have X" now routes to the **search** node (supervisor few-shot `do I have Coherence … => search`), which deterministically renders a SELECTION ("Open it, or search elsewhere?" — `search.py:397`, the 013 "New Scope 1") for a single owned match — never a `render_movie_card`, never auto-nav. "Open it, or search elsewhere?" is pure-code output, not model variance. That find path is already covered by `agent-search.spec.ts`/`.yaml` (013). Fix: removed the two stale find tests from `assistant-query.spec.ts` + the find-miss step from `assistant-query.yaml`, scoping the query spec to count/list (the query node's actual job). tsc + eslint green.

**Remaining before merge:** the broader Final Validation Checklist (full web E2E regression across the 012/014 assistant suite, mobile CI run). Mobile flows are authored + registered but their green run is gated on mobile-CI provisioning (**issue #16**). Then PR to `main`.

---

## (historical) Slice D handoff below

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

### US2 — Slice D is LIVE-VERIFIED ✅ (commit `321d858`, 2026-06-19). MVP per-run injection proven end-to-end.

The per-run injection chain (X-Agent-Config → middleware → configurable → node-task ContextVar → model build; X-TMDB-Key → web-api-mcp) is now **GREEN against the live dev-container + containerized gateway**: `node scripts/agent-e2e.mjs assistant-config` → **3/3 passed (15.7s)** — T014 gating (no dock + short-circuit), T024a configure→dock→real Ollama interaction on the user's OWN creds, T024b bad-key per-field 422. T050 seeding works (globalSetup seeds via the real PUT path). Done this slice:
- Rebuilt all 4 agent images via `agent-stack.mjs --build` (Slice D code now live — verified `AgentConfigMiddleware`/`inject_agent_config` + web-api-mcp `TmdbKeyMiddleware` present in the running containers).
- Wired `.env.docker` with the 018 env (see Load-bearing notes — **`MONGO_URL` MUST carry `?directConnection=true`** or the dev container's mongo driver dials localhost via rs topology discovery → ECONNREFUSED).
- `agent-config-seed.ts` helper + globalSetup hook + `agent-e2e.mjs` TMDB_API_KEY forwarding + `assistant-config` registered in the agent-spec list.

**Left for full MVP completion:**
1. ✅ **T024a DONE** (`tests/integration/agent-config-run-revoked.integration.test.ts`, **1 passed ~0.8s** vs live gateway). Plants a post-save-revoked config (provider=anthropic + invalid `sk-ant-…` marker key + a TMDB marker, written straight via `store.upsert` — validate-on-save would reject it) and drives a real run through the BFF's OWN `createMovieAssistantAgent` (the `@ag-ui/client` `HttpAgent` handles the AG-UI protocol + SSE — no hand-rolled GraphQL/body needed; reuses `mintSubjectToken` + the kc-test helpers). **Finding: the gateway degrades a revoked-credential model error into a GRACEFUL user-safe assistant decline** ("Sorry — I couldn't complete that just now. Please try again.") via a normal `RUN_FINISHED` — NOT a loud `RUN_ERROR`/throw. So the assertion is: no secret marker anywhere in the surface (events+messages+error) AND the assistant message carries no internal detail (no `anthropic`/`api_key`/`401`/`sk-ant`/URL/traceback) AND the user still gets a bounded message. Do NOT assert an error-shaped outcome.
2. **T051 (SC-002)** — discriminating proof that per-run injection is the SOLE cred path. ⚠️ Current caveat: the T024a-green run configured the user with `ollamaBaseUrl=http://host.docker.internal:11434`, which is ALSO the gateway's `OLLAMA_BASE_URL` env — so green does not yet distinguish per-run config from the shared env fallback. To prove SC-002: redeploy the gateway WITHOUT `OLLAMA_BASE_URL`/`MODEL_PROVIDER`/`SUPERVISOR_MODEL`/`SPECIALIST_MODEL` and recreate `web-api-mcp` WITHOUT its TMDB env, then confirm a configured user still works (model + a TMDB-touching add) and an unconfigured user short-circuits. (agent-stack.mjs always sets the model env for ollama — needs a sans-env variant or a manual gateway `docker run`.)

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

- **Dev-container BFF needs the 018 env in `.env.docker`** (NOT just `.env.local`, which is Metro-only): `AGENT_CONFIG_ENC_KEY` (copy the SAME value so encrypt/decrypt is consistent) + `MONGO_URL`. Both BFF containers (`mcm-bff`, `mcm-bff-dev`) read `frontend/mcm-app/.env.docker` via `env_file`. Without these the dev-container web E2E 500s on every config op. **Do NOT add a shared `TMDB_API_KEY` to `.env.docker`** (FR-021/SC-002 — no shared key); the E2E seed value comes from the Playwright harness env (`agent-e2e.mjs` auto-loads `TMDB_API_KEY` from `.env.local`).
- **🚨 Container `MONGO_URL` MUST be `mongodb://mc-db:27017/?directConnection=true`** (Metro/`.env.local` keeps bare `mongodb://localhost:27017`). `mc-db`'s `rs0` replica set is configured with member host `localhost:27017` (deliberately, so HOST integration tests reach it — see root `CLAUDE.md`). Without `directConnection=true` the Node driver connects to `mc-db`, does replica-set **topology discovery**, learns the member is "localhost", then dials `localhost:27017` INSIDE the container → `ECONNREFUSED ::1:27017, 127.0.0.1:27017` (looks like the env wasn't read, but the URL parsed fine — it's topology discovery). `directConnection=true` skips discovery; the BFF store only does single-doc upserts so no transaction/RS is needed there. Verified: `docker exec mcm-mcm-bff-dev-1 node -e "...directConnection=true...ping"` → ok=1.
- `--profile` goes BEFORE `up`/`down` (compose v2). Nx `up-keycloak`/`up-app` are broken for this — use `docker compose --profile <p> up -d`.
- Decrypted secrets are per-run, in-memory only (SC-004). BFF logger already redacts 018 fields (T009).
- New BFF routes MUST join `AGENT_ROUTES` (compensating control).
- `.env.local` is gitignored (`*.env.*`); committed env reference goes in `docs/runbooks/local-dev.md` (T052).
- Form non-secret fields hydrate via React render-phase state-adjustment keyed on `updatedAt` (NOT a setState-in-effect — that lint rule is enforced); secret inputs are write-only and never hydrated.
- DS-compliance scan: fontSize must be on the MD3 scale (13 is OFF — use 12/14/16/18…).

## Post-Implementation Review Remediation (2026-06-19)

A high-effort local review found 10 issues; all fixed TDD-first. Gates: `movie-assistant` 848 + `web-api-mcp` 15 Python unit, `mcm-app` 1103 BFF unit — all green; `tsc`, `ruff`, `secret-scan --selftest` clean. Details + per-task tests in tasks.md **Phase 11**; new requirements FR-026…FR-030 and SC-009…SC-011 in spec.md.

Showstoppers fixed: Anthropic-provider users got the Ollama model id (404) and the supervisor/intent classifier ignored the per-user config entirely — both now route through `runtime_env` + `agent_config_scope`. Security: SSRF guard on the Ollama URL (`agent-config-ssrf.ts`, blocks metadata/link-local, opt-in `AGENT_OLLAMA_ALLOWED_HOSTS`, `redirect:'manual'`); AES-GCM AAD binds each blob to `${userId}:${field}`; per-user Anthropic key now beats Vault; web-api-mcp `_tmdb_key()` fails closed. Mobile `android-e2e.yml` reordered so the config is enabled before the dock-driving agent flows. Cleanups: one shared runnability predicate + default view, `store.upsert` → `findOneAndUpdate`, probe-by-effective-provider, one ASGI middleware factory.

Still pending (unchanged by this pass): live BFF+gateway integration/E2E runs and the mobile-CI provisioning (issue #16).
