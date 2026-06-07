# Handoff — Feature 012 Multi-Agent MVP (implementation in progress)

**Branch**: `012-multi-agent-mvp` | **Updated**: 2026-06-06 | **Tree**: clean, all work committed.

Read this first, then `tasks.md` (checkboxes are current) + `plan.md`/`research.md`. This is an
implementation handoff for a fresh session — it captures state, exact commands, findings, and the
single remaining piece.

## Where we are

Phase 1 (Setup) + the unit-testable Foundational core + the AG-UI gateway + the BFF↔gateway
transport + the CopilotKit client overlay are built, tested, and committed. **T029 live web E2E
is now GREEN** (`tests/e2e/web/assistant.spec.ts`, 2/2): dock open/close + send→AG-UI reply
renders on real react-native-web through BFF→gateway→Ollama. This completes the **web leg** of
T014a (Android leg still pending T033a).

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

### Two NEW findings from the container investigation (NOT T029 regressions — both pre-existing / separate)

**Finding A — the container→host-gateway agent path does NOT work under the app runtime.**
Tried to run the full suite against the **dev BFF container** (`E2E_BFF_TARGET=dev-container`) with the
host gateway rebound to `0.0.0.0:8123` and `AGENT_GATEWAY_URL=http://host.docker.internal:8123` in
`.env.docker`. `docker exec … wget host.docker.internal:8123/health` succeeded, **but during the real
run the gateway logged ZERO `POST /agent/movie-assistant`** — the containerized `@expo/server` BFF
runtime never reached the gateway (the assistant test just hung 90 s, no error). So the assistant works
through **Metro** (proven, 2/2, gateway-confirmed 200s) but **NOT yet through the containerized BFF**.
This is the handoff's long-standing "prod/dev-container agent path unproven" risk — needs its own task
(suspect: Node `fetch`/undici → `host.docker.internal` under the container, or SSE buffering in the
prod `@expo/server`). The clean fix is to **containerize the gateway** (T009 compose exists, T033
unverified) so the BFF reaches it over `backend-network` instead of the host loopback.

**Finding B — the full Playwright suite has a shared-session fragility against the container.**
The container full run failed `movies.spec` en masse with the **login screen** ("session invalid").
**Isolated `movies.spec` ALONE also fails from test 1** — so this reproduces with ZERO assistant code
and is NOT caused by T029. Falsified en route (with evidence): the logout test is **mocked**
(`page.route('**/bff-api/auth/logout', …)`, real Keycloak SSO logout never runs); not idle/absolute
timeout (30 min / 24 h); not `MAX_CONCURRENT_SESSIONS` eviction (movies-alone has no other logins).
Root cause still open — likely the shared `storageState`/`.auth/user.json` session isn't valid against
the `bff-dev` container in that state (stale cached cookie vs. container Redis). **Pre-existing E2E-harness
bug, separate from this feature.** Try deleting `.auth/user.json` to force a fresh global-setup login.

### Remaining before SC-005/T066 is closed
- **Existing E2E regression (SC-005, T066) is NOT yet cleanly green.** On Metro the full ×5-worker
  suite OOMs (~52/95); on the dev container it hits Finding B. Additivity is *very likely* intact (the
  dock is `isAuthenticated`-gated; existing specs never open it; ~52 existing tests passed before each
  failure mode), but a **clean full pass is still owed** — gated on Finding B (harness session) and,
  for `assistant.spec` in-container, Finding A (gateway reachability).
- **Recommended path:** containerize the gateway (T009/T033) → then both the assistant in-container AND
  a Metro-free deterministic full regression become possible. Until then, run the **existing** regression
  (exclude `assistant.spec`) on a **fresh** Metro to prove additivity, and keep `assistant.spec` as the
  isolated Metro-only proof it already is.

### Local env left by this session (all reverted/torn down)
- `bff-dev` container removed; host gateway stopped; `.env.docker` `AGENT_GATEWAY_URL` line reverted.
- Shared stack (Keycloak/Redis/Mongo/mc-service) left **up**. To re-run the assistant E2E next session:
  start the gateway (`cd agents/movie-assistant; uv run uvicorn src.gateway:create_app --factory --host
  127.0.0.1 --port 8123`) + a **fresh** Metro, then `pnpm nx e2e mcm-app -- tests/e2e/web/assistant.spec.ts`.

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
- **jest transformIgnorePatterns** extended to transform `@copilotkit`/`@ag-ui`/`uuid` (ESM) — see `frontend/mcm-app/package.json`.
- **Default model provider = Ollama** (research R1): `supervisor`→qwen2.5, specialists→qwen2.5:32b; Claude fallback via `MODEL_PROVIDER=anthropic`; escalation always Opus. `src/models.py` `select_model_config` (pure) + `build_chat_model`.
- **Tooling gotcha**: running the same `pnpm exec jest <file>` repeatedly returns a CACHED (stale) result via the RTK wrapper. Use `pnpm nx test mcm-app --skip-nx-cache [-- --testPathPattern=…]` for fresh runs.

## Gated / deferred (not blockers for the E2E)
- **T012 apply** (Keycloak token-exchange): script ready at `infrastructure-as-code/docker/keycloak/scripts/configure-token-exchange.mjs`; needs KC admin creds (not in repo) to run. Audience must reconcile with mc-service in T023.
- **T023** RFC 8693 subject-token mint in the BFF route (TODO in `run+api.ts`) — only needed once tools call mc-service (US1); current graph is tool-free.
- **T033a** Android APK rebuild (CopilotKit pulls react-native-reanimated, native) — required before any **mobile** E2E; use the CI `android-apk` workflow (Windows CMAKE wall).
- **Heavy guardrails** (`nemoguardrails`/`guardrails-ai`, T019) — proven to install on py3.13; not yet wired.

## Suggested kickoff for the fresh session
> "Continue feature 012. Read specs/012-multi-agent-mvp/HANDOFF.md (esp. Findings A & B). T029 is DONE+committed (313c5e8). Next priorities: (1) **containerize the agent gateway** (T009 compose + T033) so the BFF reaches it over backend-network — unblocks Finding A and a Metro-free deterministic regression; (2) root-cause **Finding B** (full-suite shared-session invalidation, reproduces with `movies.spec` alone vs the dev container — try deleting `.auth/user.json`); (3) then close **SC-005/T066** (existing regression green). After that, resume Foundational/US1 (T019, T021–T027, T030–T033)."
