# Handoff — Feature 012 Multi-Agent MVP (implementation in progress)

**Branch**: `012-multi-agent-mvp` | **Updated**: 2026-06-07 | **Tree**: clean, all work committed.
(Latest: T027/T027a rate+cost limits + T019 guardrails + T033 Nx targets — see Foundational DONE.)

Read this first, then `tasks.md` (checkboxes current) + `plan.md`/`research.md`. Implementation
handoff for a fresh session: current state, exact commands, durable findings, next picks.

## Where we are

Phase 1 (Setup) is done. **Most of Foundational (Phase 2) is done** — the gateway, the secure
BFF↔gateway transport, the CopilotKit overlay, the read tools, and the **entire identity-propagation
chain** are built, TDD'd, and committed. **SC-005/T066 GREEN**: `E2E_BFF_TARGET=dev-container pnpm nx
e2e mcm-app` → **95/95 (~60 s)**, deterministic, Metro-free (re-verified this session after the
`run+api.ts` change + the production login-client audience mapper).

### Foundational DONE (`[X]` in tasks.md)
- **T015–T018, T020** — state/no-token invariant, model provider switch, supervisor node, per-agent
  MCP allowlists, compiled LangGraph graph + AG-UI gateway.
- **T021** movie-mcp READ tools (GREEN vs real mc-service) · **T022** web-api-mcp TMDB tools (GREEN vs
  real TMDB; key in gitignored `mcp-servers/web-api-mcp/.env.local`).
- **T026** BFF ui-state sanitizer + ui-action authorizer (12/12) · **T028/T028a** BFF agent route +
  auth-guard regression · **T029** CopilotKit dock + live web E2E (`assistant.spec.ts` 2/2).
- **T023** `bff-server/agent-subject-token.ts` — RFC 8693 subject-token mint (9 unit + real-Keycloak
  integration GREEN) · **T025** `bff-server/agent-gateway-client.ts` — mode-aware gateway URL + AG-UI
  `HttpAgent` factory (6 unit). Wired into `run+api.ts` (per-request runtime, best-effort subject-token
  attach; config-gated so unchanged when unconfigured).
- **T024** gateway re-exchange + OPA + per-request capture + acquire seam — **pieces 1–4, 24 tests
  (23 unit + 1 real-Keycloak integration) GREEN**. See "T024" below. **MCP transport split to US1.**
- **T066** existing web E2E regression GREEN (additivity proof). **T033** partial (gateway
  containerized on `backend-network`; Nx Python targets + full `--profile agents` boot still pending).
- **T027** BFF per-user rate + cost limits — `bff-server/agent-rate-limiter.ts` (7 unit + 4 real-Redis
  integration GREEN). `checkAgentRequestRateLimit` (20/60 s), `enforceAgentCostCeiling` pre-flight
  (throws before any work → "no action"), `recordAgentCost` (micro-USD accrual; T030 supplies the
  LangFuse per-turn cost). Cost primitives `addAgentCostMicros`/`getAgentCostMicros` in `cache-service`.
  **Wired into `run+api.ts` POST only** (the `/info` GET is a handshake). Env: `AGENT_RATE_LIMIT_REQUESTS`/
  `_WINDOW_MS`/`AGENT_SESSION_COST_CEILING_USD`. **Re-verified live:** bff image rebuilt + recreated,
  auth-guard 2/2 vs container, SC-005 dev-container E2E **95/95 (~1.0 min)**.
- **T027a** gateway per-agent tool-call limiter — `agents/.../src/tools/agent_rate_limit.py`
  `AgentToolRateLimiter` (sliding window per `(agent, scope)`, per-agent overrides, injectable clock) +
  `build_default_limiter(env)` (`AGENT_TOOL_CALL_LIMIT`/`_WINDOW_SECONDS`, defaults 30/60 s); breach →
  typed `AgentRateLimitExceeded` (FR-018 graceful degradation). 7 unit GREEN; ruff + mypy clean.
  **The `limiter.check(agent, scope)` call site lands with the US1 MCP tool transport** (same split as T024).
- **T019** guardrails — `src/guardrails/output_validators.py` (pure): `scan_for_pii`/`redact_pii`
  (email/phone/Luhn card), `detect_prompt_injection` (instruction-override heuristics on untrusted
  tool/MCP output), `validate_structure` (Pydantic → typed `StructuralValidationError`/`GuardrailError`),
  `guard_user_input`/`guard_tool_output` → `GuardResult{text,pii,injection}`. `src/guardrails/rails.co`
  = real NeMo Colang movie-domain rails (in/out-of-domain intents + decline flow); `test_rails_config.py`
  asserts it parses (no LLM). **15 unit GREEN; ruff + mypy clean.** Call sites (`guard_tool_output` at the
  MCP boundary + NeMo rails on the model) wire with the US1 transport; **live decline = T060**.

### Foundational REMAINING
- ~~**T019** guardrails~~ **DONE this session** — see below.
- **T024a** write-tool resilience (retry/backoff + dead-letter → user-facing failure) — lands WITH the
  US1 MCP transport (needs a real write tool to exercise).
- ~~**T027 / T027a** rate/cost limits~~ **DONE this session** — see below.
- **T030 / T030a / T030b** observability/Vault/OTel (LangFuse, OpenSearch audit, Unleash kill-switch;
  Vault secret injection; Tempo/Prometheus/Loki) — several may be documented-deferral for the MVP.
- **T031 / T032** token-leak scan (SC-004) + golden-pair regression harness + CI cassette/replay.
- ~~**T033** finish~~ **DONE this session** (targets + wiring) — `deploy` added to all three `project.json`
  (Nx infers `dependsOn: build`), via root `compose --profile agents`; validated by `nx deploy web-api-mcp`
  end-to-end. Full `--profile agents` boot (19 GB model pull + external volumes) remains a documented
  one-time provisioning deferral (local loop uses `scripts/agent-gateway-local.ps1`).

Then **US1 (T034–T046)**: curator/organizer/approval_gate/write tools/resume route — this is where the
**T024 MCP transport** lands (wires `movie-mcp/server.py` + the in-process MCP client onto the seam).

### T024 — what was built (the identity chain)
The gateway-side downscoping is complete and real-Keycloak-verified:
- `src/tools/token_exchange.py` `reexchange_for_mc_service` — RFC 8693 via `agent-gateway`; NO `audience`
  param (the client's mappers stamp `aud=[movie-collection-manager, mc-service]`); TTL capped ≤60 s.
- `src/tools/opa.py` `authorize_exchange` — config-gated (skip+allow when `OPA_URL` unset; OPA is NOT
  deployed — env placeholder only), FAILS CLOSED when configured-but-erroring; sends only
  user_id/audience/agent_origin (no token).
- `src/runtime_context.py` `SubjectTokenMiddleware` + `get_subject_token()` — **pure ASGI** middleware
  (NOT Starlette `BaseHTTPMiddleware`, whose separate task breaks ContextVar propagation) captures the
  BFF `Authorization: Bearer` subject token per request; never checkpointed.
- `src/tools/identity.py` `acquire_downscoped_token` — **the seam US1 plugs into**: OPA-authorize →
  re-exchange → `(user,audience)` cache bounded by ≤60 s TTL. `authorize`/`exchange`/`cache` injected.
- Integration `tests/integration/test_token_reexchange.py` asserts `aud=[movie-collection-manager,
  mc-service]` + `agent_origin=true` + TTL ≤60 s vs live Keycloak (self-sufficient conftest fetches the
  agent-gateway secret via the BFF service account; skips without the live stack/T012).

### Keycloak token-exchange (v2) — TWO preconditions (durable; recurred in T024, will recur again)
Keycloak 26.x **standard token exchange** (`standard.token.exchange.enabled=true`) is filter-/
mapper-based, not free downscoping:
1. **Requester must be within the subject token's `aud`** — else `access_denied: "Client is not within
   the token audience"`. So the user's `movie-collection-manager` login token carries `agent-subject-token`
   in `aud` (audience mapper on the login client, applied by the T012 script).
2. **The downscope target must be an "available" audience on the requester** — else `invalid_request:
   "Requested audience not available"`. Satisfied by an `oidc-audience-mapper` for the target ON the
   requester client. We avoid the `audience` param entirely and let the mappers stamp the aud (also
   sidesteps precondition 2). Debug exchange failures by reading Keycloak's `error_description` directly —
   the BFF/agent modules redact the body (SC-004); use a throwaway probe.

### `aud=[movie-collection-manager, mc-service]` decision (user-approved 2026-06-07)
R3 wants `aud=mc-service` but **mc-service is unchanged in 012** and validates `aud⊇movie-collection-manager`
(`axum-keycloak-auth 0.8.3` → `jsonwebtoken set_audience`, non-empty-intersection). So the gateway-exchanged
token carries BOTH: `movie-collection-manager` (accepted by unchanged mc-service) + `mc-service` (R3 binding
signal). Provably additive — both the BFF (`aud.includes||azp`) and mc-service ignore extra audiences.

### Local env state (LEFT UP — ready to re-run)
- Containers UP: `agent-gateway`, `mcm-bff-dev`, `mc-service`, `keycloak-service`, `mcm-redis`, `mc-db`,
  keycloak-db, mailpit (`docker ps`). The BFF image was rebuilt this session with the `run+api.ts` change.
- **Keycloak T012 FULLY applied** (user re-ran the script this session): `agent-subject-token` +
  `agent-gateway` clients with all audience mappers + `agent_origin` claim + TTLs; login-client audience
  mapper present. OPA is NOT deployed (gated off).
- Creds: `frontend/mcm-app/.env.local` has `AGENT_SUBJECT_TOKEN_*`; `.env.docker` has `AGENT_GATEWAY_URL`.
  The agent re-exchange integration fetches the `agent-gateway` secret at runtime via the service account
  (no agent `.env.local` cred needed).

### Verify commands (all currently GREEN)

```bash
pnpm nx test movie-assistant                    # 86 unit (incl. T024 23 + T027a 7 + T019 15 guardrails)
pnpm nx test:integration movie-assistant -- -k reexchange   # T024 re-exchange vs real Keycloak (1)
pnpm nx lint movie-assistant                    # ruff + mypy clean
pnpm nx test mcm-app                            # 871 BFF unit (incl. T027 agent-rate-limiter 7)
pnpm nx test:integration mcm-app -- --testPathPattern=agent-rate-limiter   # T027 rate+cost vs real Redis (4)
pnpm nx test:integration mcm-app -- --testPathPattern=agent-subject-token   # T023 vs real Keycloak (2)
pnpm nx test:integration mcm-app -- agent-route-auth        # T028a auth guard (2)
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app            # SC-005 regression (95/95) — needs gateway+bff-dev up
```

See the kickoff at the bottom for next picks.

### T029 fixes (this session) — two real wiring bugs + one infra gotcha
1. **AG-UI `HttpAgent`, not `LangGraphHttpAgent`.** `run+api.ts` bound the runtime with
   `@copilotkit/runtime`'s `LangGraphHttpAgent` (LangGraph-**Platform** REST protocol → `/threads`,
   `/runs`) which **404s** against our gateway (a native **AG-UI** endpoint via `ag_ui_langgraph`).
   Fixed: `new HttpAgent({url})` from **`@ag-ui/client`** (added as a direct dep, pinned `0.0.53`
   to match what CopilotKit already resolves). Verified the gateway returns 200 + a clean complete
   AG-UI stream via a direct Node `HttpAgent.runAgent()` repro.
2. **`useSingleEndpoint` on `CopilotKitProvider`.** The client otherwise GETs runtime sub-paths
   (`${runtimeUrl}/info`, `/agents`); Expo Router is an **exact-path** file router (`run+api.ts` =
   one path) so those **404**. Single-endpoint sends everything to the one `run` POST.
3. **Metro OOMs on long sessions / the full 95-test suite.** Repeated `exit 134` = V8
   `Reached heap limit`, NOT a code bug (the dock E2E passes clean on a fresh Metro). Start Metro
   **fresh** for E2E; `NODE_OPTIONS=--max-old-space-size=8192` + `COPILOTKIT_TELEMETRY_DISABLED=true`
   help but the **full ×5-worker suite still exhausts heap mid-run** (~52/95 then the server dies).

### Findings A & B — BOTH ROOT-CAUSED AND FIXED (this session). Full dev-container regression now GREEN.

**RESULT: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` → 95/95 passed (~1.0 min), deterministic,
Metro-free.** This is SC-005/T066 green (includes `assistant.spec` 2/2 in-container AND the previously
failing `movies.spec`). The earlier diagnoses in the prior handoff were both WRONG — corrected below.

**Finding A — root cause was NOT network/`host.docker.internal`. It was a prod-bundle `import.meta` crash.**
The exported `@expo/server` runtime leaves `globalThis.__ExpoImportMetaRegistry` undefined. Metro rewrites
`import.meta.url` in bundled deps → `globalThis.__ExpoImportMetaRegistry.url`; the Metro **dev** server
populates that registry but the **prod export does not**. So when CopilotKit's runtime lazily `require`s its
adapter at request time, that module's top-level `createRequire(import.meta.url)` threw
`TypeError: Cannot read properties of undefined (reading 'url')` — **asynchronously inside the streaming
`respond` pipeline**, so the route's try/catch never caught it and the client just hung 90 s. The gateway
logged zero POSTs because the BFF crashed before forwarding. Works on Metro (dev bundle), hung in-container
(prod bundle) — exactly the observed split. **Fix (two parts):**
1. **Containerize the gateway on `backend-network`** + set `AGENT_GATEWAY_URL=http://agent-gateway:8000`
   in `frontend/mcm-app/.env.docker` (it was unset → defaulted to the container's OWN `localhost:8123`
   loopback). The BFF now reaches the gateway by service DNS; verified bff-dev→gateway `/health` 200.
2. **Polyfill `globalThis.__ExpoImportMetaRegistry` in `frontend/mcm-app/server.js`** (a flat
   `{ url: pathToFileURL(__filename).href }`, set before `createRequestHandler` loads the bundle — faithful
   to Metro's single shared registry; lets `createRequire` resolve the deployed `node_modules`).
   Verified: gateway logged `POST /agent/movie-assistant 200 OK`, zero `url` TypeErrors.
- Also fixed the **gateway Dockerfile**: added `build-essential` to the build stage (`nemoguardrails → annoy`
  has no cp313 wheel → compiles from source → needs `g++`).

**Finding B — root cause was NOT "session invalid / login screen". It was the dock overlapping the FAB.**
Reproduced cleanly: the page snapshot showed a fully **authenticated** screen (movie list + "Add movie"
FAB + "Assistant" toggle, NO login screen). The real failure: `page.click('collection-screen-add-movie')`
→ `<div data-testid="assistant-dock"> subtree intercepts pointer events` → retried 170× → 90 s timeout.
The dock toggle was `position:absolute, right:16, bottom:16` — directly on top of the bottom-right add-movie
FAB — so every `movies.spec` test failed in `beforeEach → clickAddMovie`. This is a **real T029
additive-only regression (SC-005)**, exactly the snag the prior handoff *warned* about ("dock overlay is
bottom-right absolute — watch for overlapping existing tap targets"). It is NOT a Keycloak/session/Redis
issue (KC_HOSTNAME pin verified intact; global-setup login + seeding succeeded every run).
**Fix:** moved the dock to **bottom-left** (`assistant-dock.tsx` styles only — every existing primary action
in this app is a bottom-right FAB; bottom-left is unoccupied app-wide; container already `pointerEvents="box-none"`).
Do NOT chase the "delete `.auth/user.json`" red herring — global-setup overwrites it with a fresh login every run.

### SC-005/T066 — CLOSED (dev-container). Notes for next time
- The **dev-container path is the deterministic regression** (95/95 ~1 min, 5 workers across files, no Metro
  JIT/OOM). Use it, not Metro, for the additivity gate. The Metro full-suite OOM (handoff T029 #3) is a
  Metro-only memory issue and is now moot for the gate.
- To reproduce: bring up the gateway (`pwsh scripts/agent-gateway-local.ps1 -Build`), rebuild+recreate the
  BFF container (`pnpm nx docker-build mcm-app` → `docker compose --profile bff-dev up -d mcm-bff-dev`),
  then `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`.

### Local env left by this session (LEFT UP — ready to re-run)
- **`agent-gateway` container UP** on `backend-network` (host Ollama via `host.docker.internal`, no host
  port — constitution boundary preserved). `mcm-bff-dev` container UP (rebuilt with both fixes). Shared
  stack (Keycloak/Redis/Mongo/mc-service) UP.
- Re-run the deterministic regression any time: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`.
- New committed artifacts: `frontend/mcm-app/server.js` (registry polyfill), `agents/movie-assistant/Dockerfile`
  (`build-essential`), `frontend/mcm-app/.env.docker.example` + `.env.docker` (`AGENT_GATEWAY_URL`),
  `frontend/mcm-app/src/components/agent/assistant-dock.tsx` (bottom-left), `scripts/agent-gateway-local.ps1`.
- Teardown when done: `pwsh scripts/agent-gateway-local.ps1 -Down`; `docker rm -sf mcm-mcm-bff-dev-1`.
  (Metro is untouched — still the default dev inner loop.)

---

## (historical) THE original remaining piece — T029 final: live web E2E  ✅ DONE

### Commits (newest first)
- `chore(012)` commit pnpm-lock
- `f9a493c` BFF agent route → CopilotKit runtime endpoint (T029 server side)
- `08f739c` T029 CopilotKit overlay (client) + corrected BFF-runtime finding
- `16b3dd9` T029 spike (gateway emits AG-UI natively)
- `0f004ec` BFF agent AG-UI route + auth-guard (T028/T028a)
- `7504d81` Foundational agent core + AG-UI gateway (TDD)
- (earlier) Phase-1 scaffold + deferred setup (committed by the user)

### tasks.md done (`[X]`): T001–T014, T015, T016, T017, T018, T020, T028, T028a
### Verified green
- `pnpm nx test movie-assistant` → 41 unit · `pnpm nx test:integration movie-assistant` → 5 (gateway boot + real-graph + build_chat_model vs Ollama)
- `pnpm nx test mcm-app` → **837 unit** · `pnpm nx test:integration mcm-app -- --testPathPattern=agent-route-auth` → T028a 2/2 (real BFF + Keycloak) · route-coverage 5/5
- `pnpm exec tsc --noEmit` (mcm-app) → clean
- End-to-end smoke: real Ollama (`qwen2.5`) routes "organize"→organizer, out-of-domain→decline through the live gateway emitting native AG-UI.

## (historical — ✅ DONE) THE remaining piece — T029 final: live web E2E

Goal: open the dock on web, send a message, assert the AG-UI response renders. This also
validates **CopilotKit rendering on real react-native-web DOM** (the unit render test used
react-test-renderer, NOT a browser — unproven) and the runtime `/info` + single-endpoint handshake.

### Bring up the stack (4 things)
```powershell
# 1. Ollama (installed; models pulled) — confirm running:
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" list   # expect qwen2.5 + qwen2.5:32b

# 2. Agent Gateway (FastAPI + ag_ui_langgraph, real graph):
cd agents/movie-assistant ; uv run uvicorn src.gateway:create_app --factory --host 127.0.0.1 --port 8123
#   verify: curl http://127.0.0.1:8123/health  → {"status":"ok"}

# 3. Keycloak/Redis/mc-service already run as containers (docker compose --profile app --profile keycloak up -d if not)

# 4. Metro/BFF: cd frontend/mcm-app ; pnpm exec expo start --port 8081
```

### Write + run the E2E
- New spec: `frontend/mcm-app/tests/e2e/web/assistant.spec.ts` — login via the existing Playwright global setup (storageState), open `testID=assistant-dock-toggle`, type into `assistant-dock-input`, tap `assistant-dock-send`, assert an `assistant-msg-assistant` row appears (text contains the stub "organizer:"/"curator:"/decline copy for now).
- Run: `pnpm nx e2e mcm-app -- tests/e2e/web/assistant.spec.ts`
- Then the **existing E2E regression** (SC-005, T066): `pnpm nx e2e mcm-app` must stay green — the auth-gated dock overlay must not disturb existing flows.

### Likely snags to expect (not yet resolved)
- **CopilotKit on react-native-web**: rendering + SSE transport in a real browser is unproven. May need RNW-specific shims or CopilotKit web config.
- **Runtime handshake**: the RN client GETs runtime `/info` then POSTs. The BFF route exports GET+POST (both auth-gated) delegating to `copilotRuntimeNextJSAppRouterEndpoint`. May need `useSingleEndpoint` on `CopilotKitProvider` (in `src/hooks/use-assistant.tsx`) — confirm against client behavior.
- The dock overlay is bottom-right absolute — watch for it overlapping existing E2E tap targets.

## Key architecture findings (don't re-derive)
- **Gateway = FastAPI + `ag_ui_langgraph.add_langgraph_fastapi_endpoint` + `copilotkit.LangGraphAGUIAgent`** wrapping the compiled graph; emits AG-UI natively. Entry: `agents/movie-assistant/src/gateway.py` `create_app()`. NOT a `langgraph-api` CLI.
- **BFF route = CopilotKit RUNTIME endpoint** (`bff-api/agent/run+api.ts`): `CopilotRuntime` + `ExperimentalEmptyAdapter` + **`HttpAgent` from `@ag-ui/client`** (`{url: <gateway>/agent/movie-assistant}`), behind requireAuth→requireMcUser. The RN client needs a runtime endpoint (`runtimeUrl`), NOT raw AG-UI (research R6); this is the framework's standard bridge, compliant (not bespoke translation). **NOTE (fixed in 313c5e8):** must be the AG-UI `HttpAgent`, NOT `LangGraphHttpAgent` (LangGraph-Platform protocol → 404 vs our AG-UI gateway). Client provider needs **`useSingleEndpoint`** (Expo Router exact-path vs CopilotKit `/info` sub-path).
- **`@copilotkit/runtime` eager-imports its OpenAI adapter** → `openai` + `@ai-sdk/openai` are installed as eager-import satisfiers (unused; we use the empty adapter + LangGraph). Other adapters lazy-load. Follow-up: drop these if a runtime version lazy-loads adapters.
- **PROD-BUNDLE `import.meta` GOTCHA (bit us as Finding A):** the exported `@expo/server` runtime does NOT populate `globalThis.__ExpoImportMetaRegistry`, but Metro rewrites bundled deps' `import.meta.url` → `globalThis.__ExpoImportMetaRegistry.url`. Any bundled dep doing `createRequire(import.meta.url)` (CopilotKit runtime's lazy adapter does) crashes ONLY in the container/prod export, NOT under Metro dev — and the throw is async inside the SSE `respond` pipeline so the route try/catch misses it and the client just hangs. Mitigated by a registry polyfill in `frontend/mcm-app/server.js`. **If you add other ESM-interop server deps and they hang/500 only in-container, suspect this first.** A future `@expo/server` may fix it natively (then the polyfill is a harmless no-op via the `if (!…)` guard).
- **jest transformIgnorePatterns** extended to transform `@copilotkit`/`@ag-ui`/`uuid` (ESM) — see `frontend/mcm-app/package.json`.
- **Default model provider = Ollama** (research R1): `supervisor`→qwen2.5, specialists→qwen2.5:32b; Claude fallback via `MODEL_PROVIDER=anthropic`; escalation always Opus. `src/models.py` `select_model_config` (pure) + `build_chat_model`.
- **Tooling gotcha**: running the same `pnpm exec jest <file>` repeatedly returns a CACHED (stale) result via the RTK wrapper. Use `pnpm nx test mcm-app --skip-nx-cache [-- --testPathPattern=…]` for fresh runs.

## Gated / deferred
- **OPA not deployed** — only `OPA_URL` env placeholder; no compose service/policy. `opa.authorize_exchange` is config-gated (skip+allow when unset). Stand up an OPA container + Rego policy before enforcement is meaningful (or keep gated for the MVP with a deferral note).
- **T033a** Android APK rebuild (CopilotKit → react-native-reanimated, native) — required before any **mobile** E2E; use the CI `android-apk` workflow (Windows CMAKE wall). T038/T049/T056 mobile flows gated on it.
- **Heavy guardrails** (`nemoguardrails`/`guardrails-ai`, T019) — install on py3.13 proven; not yet wired.
- **Full `--profile agents` boot** (T033) — needs `ollama-models` + `agent-db-data` external volumes + ~19 GB model pull; the local loop uses `scripts/agent-gateway-local.ps1` (host Ollama, MemorySaver) instead.

## Suggested kickoff for the fresh session
> "Continue feature 012. Read `specs/012-multi-agent-mvp/HANDOFF.md` (Where-we-are section), then `tasks.md`. Foundational is ~done incl. the full identity chain — T023 subject-token mint, T024 gateway re-exchange + OPA + per-request capture + `acquire_downscoped_token` seam, T025 agent-gateway-client — all real-Keycloak GREEN (24 T024 tests). T012 is applied; SC-005/T066 is 95/95. The T024 **MCP transport is split to US1**. Pick the next Foundational task — **T027/T027a** (per-user + per-agent rate/cost limits; Redis is up; mirror `bff-server/rate-limiter.ts`) is self-contained, or **T019** (guardrails), or **T033** (Nx Python targets). Then **US1 (T034–T046)** wires the MCP transport onto the `identity.acquire_downscoped_token` + `runtime_context.get_subject_token` seam. Use TDD (RED→GREEN, real deps for integration). Bring the gateway + bff-dev containers up (`scripts/agent-gateway-local.ps1`) before any dev-container E2E."
