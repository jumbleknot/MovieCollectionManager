# Phase 1 Data Model: Docker Compose Stack & Container Naming Cleanup

This feature has no runtime data schema. The "data model" here is the **rename mapping** (the authoritative source of truth for every edit) plus the **reference-category taxonomy** that the discovery sweep must cover.

## Entity: Compose Stack (named project)

| Stack | `name:` | Member per-service compose files | Purpose |
|---|---|---|---|
| auth | `auth` | keycloak/compose.yaml (+ vault, moved in) | IAM + secrets |
| mcm | `mcm` | mc-service, bff, agent-gateway, agent-db, movie-mcp, spreadsheet-mcp, web-api-mcp | The application + its stores + the agent layer |
| audit | `audit` | opensearch/compose.yaml | Append-only audit sink |
| observability | `observability` | observability/compose.yaml (vault removed) | LangFuse + OTel + OPA + Unleash |

**Relationships**: stacks share the pre-existing external networks (`backend-network`, `keycloak-network`, `movie-assistant-mcp-network`) for cross-stack traffic; no cross-stack `depends_on` (Decision 3).

## Entity: Service rename (the mapping)

Each row: old `container_name` / old service key → **new unified identifier** (both). "—" = unchanged.

### auth stack

| Old container | Old key | New (container == key) |
|---|---|---|
| keycloak | keycloak-service | **keycloak-service** |
| keycloak-db | keycloak-db | **keycloak-store-postgres** |
| keycloak-mailpit | keycloak-mailpit | keycloak-mailpit (— · allowlisted, contract Rule 3b) |
| vault | vault | **vault-service** (moved from observability; profile-gated) |

### mcm stack

| Old container | Old key | New (container == key) |
|---|---|---|
| mc-service | mc-service | mc-service (—) |
| mc-service-db | mc-db | **mc-service-store-mongo** |
| mc-service-db-rs-init | rs-init | **mc-service-store-mongo-rs-init** |
| mcm-bff-dev | mcm-bff-dev | **mcm-bff-service-nonsecure** |
| mcm-bff | mcm-bff | **mcm-bff-service-secure** |
| mcm-bff-proxy | caddy | **mcm-bff-tls-proxy** |
| mcm-bff-store | mcm-bff-db | **mcm-bff-store-mongo** |
| mcm-bff-cache | mcm-redis | **mcm-bff-cache-redis** |
| movie-assistant-gateway | agent-gateway | **movie-assistant-gateway** (key change only) |
| movie-assistant-gateway-metro | agent-gateway-metro | **movie-assistant-gateway-metro** (key change only) |
| movie-assistant-db | agent-db | **movie-assistant-store-postgres** |
| movie-assistant-mcp-movie | movie-mcp | **movie-assistant-mcp-movie** (key change only) |
| movie-assistant-mcp-spreadsheet | spreadsheet-mcp | **movie-assistant-mcp-spreadsheet** (key change only) |
| movie-assistant-mcp-webapi | web-api-mcp | **movie-assistant-mcp-webapi** (key change only) |

### audit stack

| Old container | Old key | New (container == key) |
|---|---|---|
| opensearch | opensearch | **agent-audit-opensearch** |

### observability stack

| Old container | Old key | New (container == key) |
|---|---|---|
| langfuse-web/worker/postgres/clickhouse/redis/minio/minio-init | (same) | unchanged (vendor bundle) |
| otel-lgtm | otel-lgtm | unchanged |
| opa | opa | **opa-service** |
| unleash | unleash | **unleash-service** |
| unleash-postgres | unleash-postgres | unchanged (allowlisted, contract Rule 3b) |
| unleash-seed | unleash-seed | unchanged (allowlisted, contract Rule 3b) |

**Validation rules**:
- For every service: `container_name` MUST equal the service key MUST equal the convention `<component>[-<role>-<technology>]` (vendor bundles per contract Rule 3 and the auxiliary/bundle-member services per contract Rule 3b — `keycloak-mailpit`, `unleash-postgres`, `unleash-seed` — exempt).
- Old names MUST NOT survive anywhere (SC-006) and MUST NOT be re-added as aliases (Decision 1).
- Network/volume names MUST NOT change (SC-007).

## Entity: DNS reference (what the sweep must update per renamed key)

| Category | Where | Examples (old key → new key) |
|---|---|---|
| Compose `depends_on` | each per-service compose | `mc-db`, `mcm-redis`, `mcm-bff-db`, `unleash`, `langfuse-*`, `mcm-bff`, `rs-init` |
| Compose `extends:` | agent-gateway/compose.yaml | `service: agent-gateway` → `movie-assistant-gateway` |
| Compose override key | bff/compose.agent-e2e.yaml | `mcm-bff-dev` → `mcm-bff-service-nonsecure` |
| Reverse-proxy upstream | bff/Caddyfile | `reverse_proxy mcm-bff:3000` → `mcm-bff-service-secure:3000` |
| Replica-set member host | mc-service rs-init script + CLAUDE.md `rs.reconfig` | host string referencing `mc-service-db` |
| Env connection URLs (gitignored + `.example`) | `.env.docker`, agents/`.env.local`, mcp/`.env.local`, `.env.example` | `MC_DB_URL`, `REDIS_URL`, `AGENT_GATEWAY_URL`, MCP URLs, `OPA_URL`, `UNLEASH_*`, `OPENSEARCH_URL`, `VAULT_ADDR`, `KC_DB_URL` |
| App config defaults | frontend/mcm-app/src/config/env.ts, integration test env | default upstream hostnames |
| Scripts | scripts/agent-stack.mjs, agent-e2e.mjs, check-resource-naming.mjs | compose paths, project name `mcm`, container/key assertions |
| CI workflows | .github/workflows/naming-gate.yml, android-e2e.yml | stack/compose invocations, container names |
| Nx targets | infrastructure-as-code/project.json | up-* targets → per-stack |
| Docs / memory | docs/runbooks/*, docs/MCM-Architecture.md, docs/agent-layer.md, CLAUDE.md, memory/* | container names, bring-up commands, stack model |
| Mobile E2E flows | frontend/mcm-app/tests/e2e/mobile/*.yaml | any hardcoded hostnames |

## State transitions

Not applicable — a one-shot configuration rename. The only ordering constraint is the discovery sweep (and the naming-gate RED) **before** edits, and the E2E validation **after**.
