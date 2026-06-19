# Feature 018 — Per-User Agent Config — Session Handoff

**Date**: 2026-06-19 · **Branch**: `018-per-user-agent-config` · **Last commit**: `18433af`

Read first (in order): [spec.md](spec.md) · [plan.md](plan.md) · [research.md](research.md) · [data-model.md](data-model.md) · [contracts/](contracts/) · [tasks.md](tasks.md). This file is the live state + how to resume.

## What's done & verified (committed)

3 commits on the branch:
- `42c2e46` — analyze remediations (spec/tasks/contract).
- `d1f6d45` — **Phase 1+2 foundation (T001–T010)**: mongodb driver; env keys (`AGENT_CONFIG_ENC_KEY`, `MONGO_*`); `agent-config-crypto` (AES-256-GCM, **5 unit tests GREEN**); logger redaction for 018 secrets (**6 unit GREEN**); `mongo-client`; `agent-config-store` (**3 integration GREEN, real Mongo**); `agent-config-service` (non-secret view + `isRunnable` + story stubs); `types/agent-config`.
- `18433af` — **US1 core (T011,T012,T015,T016,T017,T018) GREEN/tsc/lint-clean**: GET/DELETE `/bff-api/agent/config`; `resolveForRun` + `run+api` short-circuit (`assistant_not_configured`, HTTP 200, before any rate/cost/gateway); `use-assistant-config` hook + dock gate.

Touched-area unit run: **19 passed**. `tsc` clean. 0 new lint problems (2 pre-existing `require()` warnings elsewhere are not ours).

## What's written but NOT yet verified (needs the live BFF + Keycloak)

- **T013** — `AGENT_ROUTES` allowlist extended (GET/DELETE config) with a method-aware harness in `tests/integration/agent-route-auth.integration.test.ts`. Verify: `pnpm exec jest --config jest.integration.config.js --testPathPattern "agent-route-auth"`.
- **T013a** — caller-scoping (IDOR) test in `tests/integration/agent-config-scoping.integration.test.ts` (GET/DELETE now; PUT assertion lands with T026). Verify: `... --testPathPattern "agent-config-scoping"`.

## Not started

- **T014** — web E2E gating spec `tests/e2e/web/assistant-config.spec.ts` (author + verify via the dev-container path).
- **US2 (T019–T032, T024a)** — the big cross-stack piece: probes module, PUT validate-on-save, React config form, Python `inject_agent_config`/`AgentConfigMiddleware`/`models.py` refactor, `web-api-mcp` `X-TMDB-Key`, `X-Agent-Config` wiring, leak-scan extension, DS scan.
- **US3 (T033–T036), US4 (T037–T040), US5 (T041–T044), Mobile (T045–T048), Polish (T049–T053)**.

## Stack state (left running for you)

Already **up & healthy** (8 days): `mcm-keycloak-service-1`, `mcm-mcm-redis-1`, `mc-db`, `mcm-keycloak-db-1`, `mcm-keycloak-mailpit-1`. Keycloak realm `http://localhost:8099/realms/jumbleknot` → 200.

Started via: `docker compose --profile keycloak up -d` (NOT the Nx `up-keycloak` target — it emits `--profile` *after* `up`, which Docker Compose v2 rejects; flag must precede `up`).

**Still to start in your session:**
- **BFF on :8081** — the integration tests (T013/T013a, and all US2 live tests) hit `http://localhost:8081`. Start Metro: `cd frontend/mcm-app && pnpm start` (or the dev-container per [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md)). For US2 PUT/run the BFF process **must** have `AGENT_CONFIG_ENC_KEY` (32-byte base64, e.g. `openssl rand -base64 32`) and `MONGO_URL` set.
- **Agent gateway + MCP** — only needed for US2 end-to-end runs ([docs/agent-layer.md](../../docs/agent-layer.md)); not for T013/T013a/T014 gating.

## Resume checklist (next session)

1. Set `AGENT_CONFIG_ENC_KEY` + `MONGO_URL` in `frontend/mcm-app/.env.local` (and `tests/integration/setup/env.ts` for the integration harness — US2 PUT/run paths decrypt).
2. Start the BFF (:8081). Run T013/T013a integration tests → mark `[X]` in [tasks.md](tasks.md) when GREEN.
3. Author + verify **T014** (dev-container web E2E).
4. Proceed into **US2** in TDD order (probes → PUT → form → Python injection → wiring), per [tasks.md](tasks.md). The pure `select_model_config(node, env)` / `build_chat_model(spec, env)` signatures stay unchanged — per-run injection only swaps the call-site mapping (configurable vs `os.environ`), keeping the golden cassette gate intact (research R8).

## Load-bearing notes

- `--profile` goes BEFORE `up`/`down` (compose v2). Nx `up-keycloak`/`up-app` targets are broken for this — use `docker compose --profile <p> up -d` directly.
- Decrypted secrets are **per-run, in-memory only** — never persist/log/trace (SC-004); the BFF logger already redacts the 018 fields (T009).
- New BFF routes MUST join `AGENT_ROUTES` (T013) — the compensating control for the per-handler-auth gap.
- `.env.example` is gitignored in this repo (`*.env.*`); the committed env reference goes in `docs/runbooks/local-dev.md` (T052).
