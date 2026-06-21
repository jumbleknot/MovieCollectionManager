# Discovery Notes — Docker Stack & Container Naming Cleanup (T001 / T002)

Authoritative change list (FR-004) + pre-change baselines (SC-003/SC-007 reference).

## T002 Pre-change baselines (captured 2026-06-20)

**Running containers (old names — gate expected RED):**
`keycloak`, `keycloak-db`, `keycloak-mailpit`, `mc-service`, `mc-service-db`, `mcm-bff-cache`, `mcm-bff-dev`, `mcm-bff-store`, `movie-assistant-gateway`, `movie-assistant-gw-proxy`, `movie-assistant-mcp-movie`, `movie-assistant-mcp-spreadsheet`, `movie-assistant-mcp-webapi`

**Networks (MUST stay unchanged — SC-007):**
`backend-network`, `keycloak-network`, `mcm-bff-network`, `movie-assistant-mcp-network`

**Named volumes (MUST stay byte-for-byte — SC-007):**
`keycloak-mailpit-data`, `keycloak-store-postgres-data`, `mc-service-store-mongo-data`, `mcm-bff-cache-redis-data`, `mcm-bff-store-mongo-data`, `movie-assistant-store-postgres-data`, `agent-audit-opensearch-data`

> Web E2E dev-container baseline run time: full suite 217.9s (130 tests incl. perf/a11y); time dominated by the Slow-3G perf spec, not connectivity retries (the documented fast baseline is ~54s for the older 93-test subset). The 12-test filter subset reseed ran 23.2s; collections suite 19 tests 38.0s — all normal, no connectivity-retry slowdown (SC-003 met).

## Final validation results (T033 / T034)

- **SC-001** (zero legacy container names): `docker ps` after rename shows only new names; legacy-name grep → NONE. ✅
- **SC-002 / FR-014** (web E2E connectivity): full dev-container suite 126 passed (login + all CRUD + filters); the single failure was transient preserved-Mongo fixture contamination — 12/12 filter tests green on reseed; 19/19 collections green against the mcm-stack BFF. ✅
- **SC-003** (run time): no connectivity-retry slowdown (see baseline note above). ✅
- **SC-004** (independent stack lifecycle): brought up `auth`/`mcm`/`audit` as separate projects; `down-audit` left auth+mcm running. ✅
- **SC-005** (gate): RED on old tree (13 violations) → GREEN after rename; gate-fail test FAILed on a deliberate mismatch with an actionable message, PASS on revert. ✅
- **SC-006** (no residual old names): live-tree grep clean except the Docker secret `keycloak-db-passwd` (out of scope) and intentional `RETIRED_KEYS`/old-name-mapping references. Volume KEYS also unified to their external names. ✅
- **SC-007** (networks/volumes unchanged): 4 networks + 7 named volumes byte-for-byte identical to the T002 baseline. ✅
- **FR-008** (vault gating): `vault-service` absent without `--profile vault`, present with it (relocated to `auth` stack). ✅
- **FR-011** (BFF image): `pnpm nx docker-build mcm-app` succeeded, produced `mcm-bff:latest`, target unchanged. ✅

## Rename mapping (old container / old key → new unified id)

| File | Old container | Old key | New (container == key) |
|---|---|---|---|
| keycloak/compose.yaml | keycloak | keycloak-service | **keycloak-service** |
| keycloak/compose.yaml | keycloak-db | keycloak-db | **keycloak-store-postgres** |
| keycloak/compose.yaml | keycloak-mailpit | keycloak-mailpit | keycloak-mailpit (— allowlist Rule 3b) |
| mc-service/compose.yaml | mc-service-db | mc-db | **mc-service-store-mongo** |
| mc-service/compose.yaml | mc-service-db-rs-init | rs-init | **mc-service-store-mongo-rs-init** |
| mc-service/compose.yaml | mc-service | mc-service | mc-service (—) |
| bff/compose.yaml | mcm-bff | mcm-bff | **mcm-bff-service-secure** |
| bff/compose.yaml | mcm-bff-dev | mcm-bff-dev | **mcm-bff-service-nonsecure** |
| bff/compose.yaml | mcm-bff-proxy | caddy | **mcm-bff-tls-proxy** |
| bff/compose.yaml | mcm-bff-store | mcm-bff-db | **mcm-bff-store-mongo** |
| bff/compose.yaml | mcm-bff-cache | mcm-redis | **mcm-bff-cache-redis** |
| agent-gateway/compose.yaml | movie-assistant-gateway | agent-gateway | **movie-assistant-gateway** (key only) |
| agent-gateway/compose.yaml | movie-assistant-gateway-metro | agent-gateway-metro | **movie-assistant-gateway-metro** (key only) |
| agent-db/compose.yaml | movie-assistant-db | agent-db | **movie-assistant-store-postgres** |
| movie-mcp/compose.yaml | movie-assistant-mcp-movie | movie-mcp | **movie-assistant-mcp-movie** (key only) |
| spreadsheet-mcp/compose.yaml | movie-assistant-mcp-spreadsheet | spreadsheet-mcp | **movie-assistant-mcp-spreadsheet** (key only) |
| web-api-mcp/compose.yaml | movie-assistant-mcp-webapi | web-api-mcp | **movie-assistant-mcp-webapi** (key only) |
| opensearch/compose.yaml | opensearch | opensearch | **agent-audit-opensearch** |
| observability/compose.yaml | opa | opa | **opa-service** |
| observability/compose.yaml | unleash | unleash | **unleash-service** |
| observability/compose.yaml | vault | vault | **vault-service** (→ auth stack in US2; profile-gated) |
| observability/compose.yaml | langfuse-*, otel-lgtm | (same) | unchanged (vendor — Rule 3) |
| observability/compose.yaml | unleash-postgres, unleash-seed | (same) | unchanged (allowlist Rule 3b) |

## Hostname references in connection URLs that MUST move in lockstep

Only references to an OLD container/key that is changing need editing. MCP servers' container names are already the new ids, and the agent-gateway MCP URLs already point at those container names → **no change needed for MCP URLs**.

| Reference | File:line | Old → New |
|---|---|---|
| `KC_DB_URL` JDBC host | keycloak/compose.yaml:72 | `keycloak-db:5432` → `keycloak-store-postgres:5432` |
| `MC_DB_URL` host | mc-service/compose.yaml:73 | `mc-service-db:27017` → `mc-service-store-mongo:27017` |
| `KEYCLOAK_URL` | mc-service/compose.yaml:74 | `http://keycloak:8080` → `http://keycloak-service:8080` |
| rs-init `mongosh --host` | mc-service/compose.yaml:45 | `mc-service-db:27017` → `mc-service-store-mongo:27017` |
| Caddyfile upstream | bff/Caddyfile:33 | `reverse_proxy mcm-bff:3000` → `mcm-bff-service-secure:3000` |
| spreadsheet-mcp `REDIS_URL` | spreadsheet-mcp/compose.yaml:15 | `redis://mcm-bff-cache:6379` → `redis://mcm-bff-cache-redis:6379` |
| gateway `AGENT_DB_URL` | agent-gateway/compose.yaml:17 | `@movie-assistant-db:5432` → `@movie-assistant-store-postgres:5432` |
| gateway `KEYCLOAK_URL` | agent-gateway/compose.yaml:23 | `http://keycloak:8080` → `http://keycloak-service:8080` |
| unleash `unleash-seed` curl target | observability/compose.yaml:325 | `http://unleash:4242` → `http://unleash-service:4242` |
| depends_on edges (intra-file) | all compose | old key → new key |

## Reference categories beyond compose (per data-model taxonomy)

- **Scripts**: `scripts/agent-stack.mjs`, `scripts/agent-e2e.mjs`, `scripts/agent-gateway-local.ps1`, `scripts/check-resource-naming.mjs` (gate, T003).
- **App/test config**: `frontend/mcm-app/src/config/env.ts`, `frontend/mcm-app/tests/integration/setup/env.ts`, `frontend/mcm-app/tests/integration/helpers/keycloak-test-client.ts`, `infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs`, `.../configure-token-exchange.mjs`, `mcp-servers/movie-mcp/tests/integration/conftest.py`.
- **Env examples (VCS)**: `frontend/mcm-app/.env.example`, `.env.docker.example`, `agents/movie-assistant/.env.local.example`, `mcp-servers/*/.env.local.example`.
- **Gitignored live env (dev machine, T016)**: `frontend/mcm-app/.env.docker`, `agents/movie-assistant/.env.local`, `mcp-servers/*/.env.local`.
- **CI**: `.github/workflows/naming-gate.yml`, `.github/workflows/android-e2e.yml`.
- **Nx targets**: `infrastructure-as-code/project.json`.
- **Docs/memory**: `CLAUDE.md`, `docs/runbooks/{local-dev,e2e-testing,android-emulator}.md`, `docs/MCM-Architecture.md`, `docs/agent-layer.md`, `agents/movie-assistant/README.md`, `infrastructure-as-code/docker/keycloak/README.md`, `memory/`.
- **Mobile E2E flows**: `frontend/mcm-app/tests/e2e/mobile/*.yaml` (assistant/agent flows) — check for hardcoded hostnames.

## Notes / anomalies

- A container `movie-assistant-gw-proxy` is currently running but is NOT defined in any committed compose file — likely an artifact of `scripts/agent-stack.mjs` (the metro/host proxy). Verify during T026/T027; not part of the static rename mapping.
- Most of the ~200 grep hits for `movie-mcp`/`spreadsheet-mcp`/`web-api-mcp` are **package/directory/image names** (unchanged) — only the compose **service keys** change for these three; their container names + the gateway's MCP URLs already use the new ids.
