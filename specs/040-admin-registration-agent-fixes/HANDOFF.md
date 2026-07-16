# Feature 040 — Session Handoff

**Branch**: `040-admin-registration-agent-fixes` (8 commits ahead of `main`, tree clean at handoff)
**Status**: all four user stories **implemented + unit-verified**; the remaining work is **infra/credential-gated** (golden re-record, E2E, integration).

---

## Session 2 update (2026-07-16) — read this first

**Done + committed this session:**
- **T013 / T054 — golden re-record** ✅ (`8fb473e`). Re-recorded all 29 intent cassettes + new `us040-intent-navigate-collection-qualified`; **41/41 pass record AND replay**; counter-example `us7-intent-search-navigate` stays `search`. Human approval recorded (FR-023).
- **BFF image rebuilt + container recreated** ✅. The running `mcm-bff:latest` was **stale** (US3 `/bff-api/auth/registration-status` returned the SPA shell). Rebuilt via `docker build -t mcm-bff:latest` + `docker compose -p mcm -f mcm.compose.yaml --env-file mcm.env --profile bff-nonsecure up -d --force-recreate --no-deps mcm-bff-service-nonsecure`. Now serves `{"allowed":true}`.
- **T031 — US3 integration** ✅ (`68c2f05`). `tests/integration/admin-registration.integration.test.ts`, **3/3 green** vs real BFF+Keycloak+Mongo. Added `findUsersByUsername` Admin-API helper. Restores the shared `app_settings` global doc in `afterAll`.
- **T024 design correction** (`research.md` D3.4 + `tasks.md` T024): the spreadsheet-mcp upload store is **SINGLE-USE** (`read_upload` deletes the key on first read), so the "re-parse key" alternative is **dead**. Correct path = a new `import:parsed:<handle>` store + `stash_parsed`/`fetch_parsed` tools with a session-long TTL refreshed per read; checkpoint only `import_handle`. **Cross-service — NOT started.**

**Environment facts learned (this devcontainer):**
- **This shell is the dind host**; app containers run on user-defined networks. **Host→`127.0.0.1:<published-port>` is UNRELIABLE for multi-homed services** (BFF, Keycloak sit on two nets → userland docker-proxy return-path asymmetry → curl connects then hangs). Single-homed `0.0.0.0` ports (mongo:27017) work over 127.0.0.1. Do **NOT** `sysctl route_localnet` or edit the firewall (037 isolation is deliberate; safety layer blocks it).
- **Reliable path = address services by compose service-name from a sidecar container joined to the app networks.** BFF integration proven this way (see `scratchpad/run-integration.sh` pattern; recorded in agent memory `mcm-devcontainer-integration-runner`). A glibc `node:24-slim` with the repo bind-mounted + `--network backend-network --network mcm-bff-network` + service-name env runs `jest` green.
- **Agent tier — model tier is host-Ollama (feature 019); NO Ollama here** → the **gateway + agent E2E cannot run locally**. But **agent INTEGRATION (movie-mcp path) IS feasible**: `test_add_flow`/`test_authz_parity` stub the classifier (`classifier=lambda _m: "add"`) and curator, so **no model is needed** — they exercise organizer→movie-mcp→mc-service with real Keycloak token-exchange. The realm already has `agent-gateway` + `mcm-bff-test` clients + T012 applied. To run: build+run `movie-mcp` on `backend-network` (MC_SERVICE_URL=http://mc-service:3001), update the tests for the **ownership turn** (insert a "yes" turn — US4 fallout item #7), then run `.venv` python in a sidecar (mount repo + `/home/coder/.local/share/uv` so `.venv/bin/python` resolves).
- **Agent venv**: the container rebuild wiped the uv-managed interpreter — `uv sync --python 3.13` in `agents/movie-assistant` rebuilds it (finished first try this session).

**Web E2E feasibility**: needs Metro-BFF or the browser to reach multi-homed **Keycloak** over the unreliable loopback path → **not runnable in this agent shell**; author + commit for CI. Mobile agent E2E is CI-only by design.

**Remaining (unchanged scope, refined):** T024 (cross-service, path above) · US4/US2 agent integration (feasible via sidecar; needs test updates + movie-mcp) · web+mobile E2E (author for CI) · polish (parity table T052, docs T053, full regression T055-T058).

---

Read first: [spec.md](./spec.md) · [plan.md](./plan.md) · [tasks.md](./tasks.md) · [research.md](./research.md). Repo rules: root [CLAUDE.md](../../CLAUDE.md), [docs/agent-layer.md](../../docs/agent-layer.md), [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md), [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md).

## What the last session did (verify before trusting)

Commits (newest first): `1e6396d` US4 · `8986998` US3 · `acb6639` US2 · `e3cb4a9` US1 · plus the 4 SDD-doc commits. **30 / 58 tasks** checked off in tasks.md (all the code + here-runnable tests).

| Story | Item | What shipped | Verified |
|---|---|---|---|
| **US1** | 4 | Navigate-to-collection: `navigate_stage`/`navigate_options` in GraphState + supervisor guard; navigator `_clarify` posts **bare** collection-name buttons + resume path; classifier prompt distinguishes "navigate to X collection"→navigate; golden dataset pair added | agent unit suite green (bug-a fully; **bug-b needs golden re-record — see T013**) |
| **US2** | 3 | Import reliability: supervisor no longer abandons on unparsed comma answer (re-asks); import node graceful-degradation wrapper (always a message); `skip_rate_limit=True` on `_finalize` dedup reads | unit green (**T024 checkpoint-bloat deferred**) |
| **US3** | 1 | `app_settings` single-doc store + `getAppSettingsCollection`; `bff-api/admin/settings` GET/PATCH (requireMcAdmin, 401/403 audited); public `bff-api/auth/registration-status`; `register+api` enforcement (403+audit, fail-closed); hooks + mc-admin admin screen + login-screen hide | **16 BFF unit tests + tsc + eslint clean** |
| **US4** | 2 | `to_movie_payload(owned=False default)`; `ProposalItem.owned` threaded via `build_add_proposal`→`apply_proposal`; new `awaiting_ownership` organizer stage (persists `add_target`); supervisor route + curator passthrough; `approval_gate` captures created movieId + emits `navigate_to_movie` | **agent unit suite 850 passed** (~30 existing add-flow tests updated to drive the ownership turn) |

**Sanity commands** (should already pass):
```bash
cd agents/movie-assistant && .venv/bin/python -m pytest tests/unit/ -q          # 850 passed, 2 skipped
cd /workspaces/mcm && pnpm nx test mcm-app -- --testPathPattern "app-settings-store|admin-settings-api|registration-status-api|register-enforcement"  # 16 passed
```

## Environment note (why the last session was constrained)

- **Agent Python venv**: `uv sync` in `agents/movie-assistant` kept timing out on pypi CDN downloads but **caches each attempt** — a retry loop finishes it. If `.venv/bin/pytest` is missing:
  ```bash
  cd agents/movie-assistant
  for i in $(seq 1 15); do uv sync --python 3.13; [ -x .venv/bin/pytest ] && break; done
  ```
- At handoff only the **data tier** ran as containers (BFF-nonsecure, Keycloak, Postgres, Redis, Mongo×2, mc-service). The **agent gateway + 3 MCP servers were NOT running**, and there was **no `ANTHROPIC_API_KEY`** in env — the two reasons E2E and T013 were deferred. The user is fixing the key via `.devcontainer/devcontainer.json` `containerEnv` + a rebuild.

## Remaining work — pick up here

### 1. T013 — golden re-record (US1 bug-b) — NOW UNBLOCKED once the key is set
The US1 classifier prompt change (`supervisor.py`, "navigate to X collection"→navigate) **re-keys ~29 intent golden cassettes** (they're hashed on the full prompt), so `LLM_CASSETTE_MODE=replay` currently FAILS for every intent pair. Re-record them (user has approved — FR-023):
```bash
cd agents/movie-assistant
test -n "$ANTHROPIC_API_KEY" || echo "STILL MISSING — cannot record"
LLM_CASSETTE_MODE=record .venv/bin/python -m pytest tests/integration/test_golden_pairs.py -m golden -q
# then confirm the gate is green in replay mode:
LLM_CASSETTE_MODE=replay .venv/bin/python -m pytest tests/integration/test_golden_pairs.py -m golden -q
git add tests/golden/cassettes && git commit -m "test(040): re-record intent golden cassettes for the navigate-to-collection classifier (US1 bug-b, FR-023)"
```
The new positive pair is `us040-intent-navigate-collection-qualified` ("navigate to Test Import collection" ⇒ navigate); the counter-example `us7-intent-search-navigate` ("navigate to Coherence" ⇒ search) must stay `search`.

### 2. Stand up the agent stack + rebuild images (needed for all E2E)
Agent source changed (US1/US2/US4) → **rebuild the gateway + MCP images** (stale image = old code) and bring the stack up per [docs/agent-layer.md](../../docs/agent-layer.md) + [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md). Dev/test models are **Ollama** (not Claude), so the classifier change runs at runtime without the golden cassettes.

### 3. Web E2E (T007/T032/T045) — the three user-facing stories
Author + run these specs, then the full regression:
- `tests/e2e/web/agent-navigate-collection.spec.ts` (US1): navigate → disambiguation buttons → tap "Test Import" → the **Test Import** collection opens (NOT a movie search); "navigate to X collection" opens X.
- `tests/e2e/web/admin-registration.spec.ts` (US3): mc-admin toggles registration OFF → signed-out visitor has **no "Create Account"** (`link-create-account` absent) → direct `POST /bff-api/auth/register` is 403 → toggle ON restores. Non-admin blocked from the admin screen.
- `tests/e2e/web/agent-add-ownership.spec.ts` (US4): add from TMDB → **"Do you own this movie?" Yes/No** appears before the add → answer No → movie stored `owned=false`, still added → lands on the **movie detail** screen.
```bash
pnpm nx e2e mcm-app -- tests/e2e/web/agent-navigate-collection.spec.ts   # etc.
pnpm nx e2e mcm-app   # full web regression (REQUIRED for every feature)
```
Agent-flow E2E gotcha (CLAUDE.md): **navigate in-app, never deep-load before driving the dock**; locally Metro OOM-crashes after ~1-2 agent `/run` calls (agent mobile flows run in CI).

### 4. Mobile E2E (T008/T033/T046) — parity flows
`agent-navigate-collection.yaml`, `admin-registration-disable.yaml`, `agent-add-ownership.yaml` (logged-out start). Mobile agent flows run in **CI** (homelab `app-ci` `app-e2e`), not locally. `scripts/maestro-run.sh <flow>`.

### 5. US3 integration (T031) — real Mongo + Keycloak (stack is up)
`tests/integration/admin-registration.integration.test.ts`: admin PATCH persists (assert the real Mongo doc); non-admin 403; register refused when disabled (assert the Keycloak user is **absent** via Admin API); `afterAll` cleanup; isolated namespace. `pnpm nx test:integration mcm-app`.

### 6. US2 integration (T020) + T024 (deferred design)
- `tests/integration/test_import_flow.py`: extend for a 200+ row sheet with ≥10 comma titles completing to apply; per-row skip on dup (FR-017 preservation).
- **T024** (checkpoint-bloat → store-backed handle): NOT started. Needs a spreadsheet-mcp transient store keyed handle with a **session-long lifetime guarantee** (see research D3.4 + the U1 note) — do not adopt a handle that can expire mid-session. Verify with a multi-turn import (T019).

### 7. Add-flow INTEGRATION tests need the ownership turn (US4 fallout)
The last session updated all **unit** add tests to drive the new Yes/No turn. The **integration** ones still assume a direct proposal:
- `tests/integration/test_add_flow.py` and `tests/integration/test_authz_parity.py` (calls `to_movie_payload(candidate)` — now defaults `owned=false`, and the graph add now has an extra ownership turn). Update them the same way (insert a "yes" turn before the approval interrupt) when running integration.

## Final validation (before marking the feature done)
Per CLAUDE.md Final Validation Checklist — **web E2E is required for EVERY feature**:
```bash
pnpm nx test mc-service && pnpm nx test:integration mc-service   # confirm owned passthrough (no backend change expected)
pnpm nx lint mcm-app && pnpm nx test mcm-app && pnpm nx test:integration mcm-app
pnpm nx e2e mcm-app && pnpm nx e2e:mobile mcm-app
cd agents/movie-assistant && .venv/bin/python -m pytest tests/ -q   # unit + integration + golden
rtk gain   # >80% compression
```
Rebuild + redeploy any changed BFF/agent/MCP container before the final containerized E2E, or it validates a stale image.

## Watch-outs
- **No secrets in git** — never commit the API key, forge host literal, etc.
- US1 bug-b is the only golden-surface change; US2/US3/US4 stay off the golden gate.
- After ANY `agents/**` or `mcp-servers/**` change, rebuild the affected image before E2E.
- The supervisor `awaiting_ownership` guard escapes on a clear new command (enrich/organize/navigate/import/export/query/search) so the ownership question isn't a trap; a bare yes/no stays in the add.
