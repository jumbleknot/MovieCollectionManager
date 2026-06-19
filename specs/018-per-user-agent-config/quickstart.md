# Quickstart & Validation: Per-User Movie Assistant Configuration

A run/validation guide proving the feature works end-to-end. Implementation detail lives in `tasks.md`; data shapes in [data-model.md](data-model.md); API in [contracts/](contracts/).

## Prerequisites

- Local stack up: Keycloak + Redis + MongoDB (`mc_db` replica set) per [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md). MongoDB **must** be a replica set (existing requirement).
- Agent stack reachable (gateway + `web-api-mcp` + `movie-mcp`) per [docs/agent-layer.md](../../docs/agent-layer.md).
- Env (gitignored / Vault in prod — **never commit**):
  - `AGENT_CONFIG_ENC_KEY` — 32-byte AES-256 key (e.g., `openssl rand -base64 32`).
  - `MONGO_*` — BFF→Mongo connection (scoped credentials for `user_agent_config`).
  - For tests: `E2E_OLLAMA_BASE_URL`, `E2E_TMDB_KEY`, and (golden gate) `ANTHROPIC_API_KEY` — all from env/CI secrets.
- RTK active (`rtk gain` > 80%).

## Scenario 1 — New user is off by default (US1 / SC-001)

1. Sign in as a freshly created user with no saved config.
2. **Expect**: no assistant dock on any `(app)` screen.
3. Force a run request for that user (e.g., direct `POST /bff-api/agent/run`).
4. **Expect**: typed `assistant_not_configured` response, **no** gateway call, **no** cost accrual (`agent-cost:{userId}` unchanged in Redis). Verify by asserting the Redis cost key is absent/zero.

## Scenario 2 — Enable + configure + save (US2 / SC-002/003)

1. Profile → **Movie Assistant** section → enable, pick **Ollama**, enter base URL, enter a valid **TMDB key**, Save.
2. **Expect**: live probes pass (≤5s); `200` non-secret view; secrets stored encrypted; dock now appears.
3. Drive the dock through one assistant interaction.
4. **Expect**: the run uses the per-run config (Ollama + the user's TMDB key); succeeds.
5. **Round-trip check** (integration): read the Mongo doc directly — `*Enc` fields are non-plaintext; decrypt yields the original key.

## Scenario 3 — Save with a bad credential (US2 / SC-004)

1. In the form, enter a deliberately invalid Anthropic key (provider=anthropic) + valid TMDB key, Save.
2. **Expect**: `422` with `errors:[{field:"anthropicKey",reason:…}]`; per-field message in the UI; **nothing persisted** (GET still shows prior/empty state).

## Scenario 4 — Test connection on a saved key (US3 / SC-004)

1. With a saved, valid config, press **Test connection** (no secret re-entry).
2. **Expect**: per-credential status (`ollama|anthropic|tmdb: "ok"`). No secret returned to the client (inspect the response — only statuses).
3. Revoke/spoil one stored credential server-side, press **Test connection** again.
4. **Expect**: that credential reports `{reason:…}`; others remain `"ok"`.

## Scenario 5 — Disable (US4)

1. Toggle the assistant off, Save.
2. **Expect**: dock disappears; a subsequent run short-circuits with no external call. Re-enabling restores provider selection and non-secret settings (secrets retained on a disable; wiped only on clear/DELETE).

## Scenario 6 — Personal cost ceiling (US5 / SC-005)

1. Leave `costLimitUsd` empty → confirm the global default ceiling governs (existing behavior).
2. Set a low `costLimitUsd` → drive interactions until accrued cost exceeds it.
3. **Expect**: runs short-circuit with the existing cost-ceiling response, scoped to this user.

## Scenario 7 — Security assertions (SC-006)

- `GET /config` never returns any secret value (only `has*` flags).
- Grep logs / OTel spans / LangFuse traces / LangGraph checkpoints for the test key values → **zero** hits (FR-022).
- CI secret-scan guard passes (no key-shaped literal committed); golden cassettes contain no `authorization`/`x-api-key`/key values (NFR-Sec-4).

## Test commands (TDD: RED → GREEN)

```bash
# BFF unit + integration (real Mongo round-trip, live probes)
pnpm nx test mcm-app -- --testPathPattern "agent-config"
pnpm nx test:integration mcm-app -- --testPathPattern "agent-config"

# Route auth coverage (new routes must be in AGENT_ROUTES)
pnpm nx test:integration mcm-app -- --testPathPattern "agent-route-auth"

# Design-system scan (new Profile UI must pass R1–R7)
pnpm nx test mcm-app -- --testPathPattern "design-system-compliance"

# Python agent layer (per-run injection + leak scan) + golden gate
# (run via the agent project's Nx/uv targets — see docs/agent-layer.md)

# Web E2E (dev-container path — rebuild image after src changes)
pnpm nx docker-build mcm-app
docker compose --profile bff-dev up -d
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/assistant-config.spec.ts

# Mobile E2E (CI for agent flows)
maestro test frontend/mcm-app/tests/e2e/mobile/assistant-config-enable.yaml --env ...
```

## Definition of validated

All seven scenarios pass on web; the agent-driven scenarios (2, 5) pass on mobile (CI); security assertions (Scenario 7) green; `rtk gain` > 80% on the test runs.
