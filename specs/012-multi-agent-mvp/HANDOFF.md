# Handoff — Feature 012 Multi-Agent MVP (implementation in progress)

**Branch**: `012-multi-agent-mvp` | **Updated**: 2026-06-06 | **Tree**: clean, all work committed.

Read this first, then `tasks.md` (checkboxes are current) + `plan.md`/`research.md`. This is an
implementation handoff for a fresh session — it captures state, exact commands, findings, and the
single remaining piece.

## Where we are

Phase 1 (Setup) + the unit-testable Foundational core + the AG-UI gateway + the BFF↔gateway
transport + the CopilotKit client overlay are built, tested, and committed. **T029 live web E2E
is GREEN** (`assistant.spec.ts`, 2/2) AND — new this session — **the full existing web E2E
regression is GREEN against the containerized BFF: `E2E_BFF_TARGET=dev-container pnpm nx e2e
mcm-app` → 95/95 (~1 min), deterministic, Metro-free.** That closes **SC-005/T066** and required
root-causing + fixing the two harness findings (A & B) below. The agent gateway is now
**containerized on `backend-network`** (T009 path proven end-to-end; the BFF reaches it in-container).

**Foundational progress (most recent session):** ✅ T021 (movie-mcp read tools, GREEN vs real
mc-service), ✅ T022 (web-api-mcp TMDB tools, GREEN vs real TMDB — key in gitignored
`mcp-servers/web-api-mcp/.env.local`), ✅ T026 (BFF ui-state sanitizer + ui-action authorizer,
12/12). All TDD RED→GREEN, lint + tsc clean, committed.

**Foundational progress (this session):** ✅ **T025** (`bff-server/agent-gateway-client.ts` —
mode-aware gateway URL + AG-UI `HttpAgent` factory, 6/6 unit) and ✅ **T023**
(`bff-server/agent-subject-token.ts` — RFC 8693 run-scoped subject-token mint, 9/9 unit). TDD
RED→GREEN; tsc + eslint clean; 274/274 bff-server unit regression green. **Wired into
`run+api.ts`**: it now resolves the gateway URL via T025 (replacing the inline `localhost:8123`
HttpAgent) and builds the runtime per-request so the T023 subject token attaches. The mint is
**config-gated** (`AGENT_SUBJECT_TOKEN_CLIENT_ID/_SECRET/_AUDIENCE`) and **best-effort/non-fatal**
for the current tool-free graph — so behavior is unchanged when unconfigured (current env), keeping
SC-005 intact. **NOTE for next session:** the dev-container E2E regression should be re-run
after a `pnpm nx docker-build mcm-app` + recreate, since `run+api.ts` changed — but only matters
once tools flow (US1); the auth-guard 401/403 (T028a) is unaffected (it throws before the changed
path).

**T023 is now REAL-KEYCLOAK GREEN** (`agent-subject-token.integration.test.ts`, 2/2). T012 was
applied by the user (admin creds in their shell) and the script was **extended** to register the
dedicated `agent-subject-token` confidential client (agent-origin claim + `agent-gateway` audience
mapper). **Two Keycloak 26.x standard-token-exchange (v2) preconditions were discovered via
systematic debugging — they WILL recur in T024:**
1. **Requester must be within the subject token's `aud`** — else `access_denied: "Client is not
   within the token audience"`. The user's `movie-collection-manager` token therefore must carry
   `agent-subject-token` in `aud` (production: an audience mapper on the login client — DEFERRED in
   the T012 script as an SC-005 sign-off item; test: `ensureRopcAudienceFor` on `mcm-bff-test`).
2. **The downscope target must be an "available" audience on the requester** — `audience=agent-gateway`
   is rejected `invalid_request: "Requested audience not available"` UNLESS the requester client has
   an `oidc-audience-mapper` for it. Fixed by adding that mapper to `agent-subject-token` in the T012
   script (test ensures it via `ensureClientAudienceMapper`). The no-audience exchange already
   produced `agent_origin=true` + 180 s TTL; the audience param only narrows.

This means T024 (gateway re-exchange → `aud=mc-service`) will need `mc-service` as an available
audience on the `agent-gateway` client too — add the analogous audience mapper there. **Confirmed
empirically (read-only):** `agent-gateway` currently has ZERO protocol mappers, so T024 must add
`aud-mc-service` to it (precondition 2 for the gateway hop).

**SC-005 re-verified GREEN (this session):** the T012 production audience mapper
(`movie-collection-manager` → `aud=agent-subject-token`) was applied AND the `run+api.ts` change
was rebuilt into the BFF image, then `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` → **95/95
(60.0s)**. So the additive login-client audience + the per-request runtime/subject-token wiring do
not disturb any existing flow. The audience mapper is provably safe (BFF `token-service` uses
`aud.includes||azp`; mc-service `axum-keycloak-auth 0.8.3` → `jsonwebtoken set_audience` uses
non-empty-intersection — both ignore the extra audience).

See the kickoff at the bottom for the REMAINING Foundational list.

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

## THE remaining piece — T029 final: live web E2E

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

## Gated / deferred (not blockers for the E2E)
- **T012 apply** (Keycloak token-exchange): script ready at `infrastructure-as-code/docker/keycloak/scripts/configure-token-exchange.mjs`; needs KC admin creds (not in repo) to run. Audience must reconcile with mc-service in T023.
- **T023** RFC 8693 subject-token mint in the BFF route (TODO in `run+api.ts`) — only needed once tools call mc-service (US1); current graph is tool-free.
- **T033a** Android APK rebuild (CopilotKit pulls react-native-reanimated, native) — required before any **mobile** E2E; use the CI `android-apk` workflow (Windows CMAKE wall).
- **Heavy guardrails** (`nemoguardrails`/`guardrails-ai`, T019) — proven to install on py3.13; not yet wired.

## Suggested kickoff for the fresh session
> "Continue feature 012. Read specs/012-multi-agent-mvp/HANDOFF.md. Findings A & B are FIXED and **SC-005/T066 is green** (dev-container 95/95) — the gateway is containerized and the harness is sound. **Foundational done: T015–T018, T020, T021 (movie-mcp read tools, GREEN vs real mc-service), T022 (web-api-mcp TMDB tools, GREEN vs real TMDB — key in gitignored `mcp-servers/web-api-mcp/.env.local`), T026 (ui-state sanitizer + action authorizer, 12/12).** **DONE this session:** T023 (subject-token mint) + T025 (agent-gateway-client) — 15/15 unit + T023 real-Keycloak integration GREEN; wired into `run+api.ts`. **T024 (gateway re-exchange + OPA + per-request capture + acquire seam)** — pieces 1-4, 23 unit + 1 real-Keycloak integration GREEN (`test_token_reexchange.py`: `aud=[movie-collection-manager, mc-service]` + `agent_origin=true` + TTL ≤60 s). T024 **MCP transport (movie-mcp `server.py` + in-process client + out-of-band token injection into `make_mc_client`) is SPLIT to US1** (user-approved) where it's end-to-end testable. The seam US1 plugs into: `src/tools/identity.acquire_downscoped_token` (OPA-authorize → re-exchange → `(user,aud)` TTL cache) + `src/runtime_context.get_subject_token()` (the captured BFF subject token). The T012 script now fully configures the chain (re-run it after pulling — it added the agent-gateway mappers). Foundational REMAINING: T019 (guardrails), T024a (write resilience — retry/dead-letter, lands with the MCP transport in US1), T027/T027a (rate/cost limits, Redis is up), T030/T030a/T030b (observability/Vault/OTel), T031/T032 (token-leak scan + golden-pair harness), T033 (Nx Python targets + full `--profile agents` boot — needs ollama-models volume + 19 GB pull). Then US1: T034–T046 (curator/organizer/approval_gate/write tools/resume route) — wires the MCP transport onto the T024 seam. Mobile (T033a Android APK + T038/T049/T056) gated on the CI `android-apk` workflow."
