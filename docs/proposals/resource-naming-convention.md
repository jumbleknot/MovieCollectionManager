# Docker Resource Naming Convention (proposal v3)

Status: **proposal** — formalized as SDD feature `019-resource-naming`. Pairs with [volume-network-rename-migration.md](volume-network-rename-migration.md).

## Why

Current names mix three incompatible conventions — compose-project-prefixed (`localdev-auth_keycloak-db-data`), product-prefixed (`mcm-redis-data`), and bare (`agent-db-data`, `opensearch-data`) — so a name tells you nothing reliable about owner, role, or engine.

## Core rule: name by component; qualify the BFF with the frontend app

Each resource is namespaced by the **component / bounded context that owns it** — the component name *is* the namespace:

- `keycloak-*`, `mc-service-*`, `movie-assistant-*`, `observability-*` — singular backend/infra services; their own name is the identifier. **No product prefix.**
- `mcm-bff-*` — the BFF is the one **frontend-specific** component. "BFF" is a role *every* frontend has, and a future sibling frontend (`xyz`) would ship its own BFF, so this one is qualified by the **frontend-app name `mcm`** → `mcm-bff`. Here `mcm` is the *frontend app qualifier*, **not** a global product prefix.

> Correction history: v1 dropped prefixes inconsistently; v2 wrongly blanket-prefixed *everything* with `mcm-`. v3 is the intended rule: the component name is the namespace, and `mcm-` appears **only on the BFF** (the sole frontend-bound component).
>
> Accepted trade-off: external volumes/networks live in a flat host-global namespace, so a bare `keycloak-store-postgres-data` *could* collide with another product on the same host. We accept this for the singular backend/infra services (they are conceptually "the" keycloak/mc-service/assistant of this stack); the collision risk that actually matters — a repeated, frontend-bound role — is handled by qualifying the BFF.

## Patterns

| Object | Pattern |
|---|---|
| Volume | `<context>-<role>-<engine>-data` |
| Network | `<scope>-network` |
| Service / container | `<context>-<role>` (see Phase 2) |

…where `<context>` ∈ { `keycloak`, `mc-service`, `mcm-bff`, `movie-assistant`, `agent`, `observability` }, `<role>` ∈ { `store`, `cache`, `audit`, … }, `<engine>` ∈ { `postgres`, `mongo`, `redis`, `opensearch`, `clickhouse`, `minio`, `mailpit` }. Only the `mcm-bff` context carries the `mcm-` qualifier.

**Platform vs. assistant contexts:** `movie-assistant-*` names resources owned by *this specific* assistant (its checkpointer store, its MCP network, its gateway). `agent-*` names *platform-level* resources shared by any future agent (the append-only audit sink). Keeping them distinct is intentional, not an inconsistency.

## Mapping

### Networks

| Current | Proposed |
|---|---|
| `backend-network` | keep |
| `keycloak-network` | keep |
| `bff-network` | `mcm-bff-network` |
| `agent-mcp` | `movie-assistant-mcp-network` |

### Volumes

| Current | Proposed | Persistent data? |
|---|---|---|
| `localdev-auth_keycloak-db-data` | `keycloak-store-postgres-data` | **YES — realm/users/secrets** |
| `mc-service_mc-db-data` | `mc-service-store-mongo-data` | **YES — movies/collections** |
| `mcm-bff-db-data` | `mcm-bff-store-mongo-data` | **YES — agent configs** |
| `mcm-redis-data` | `mcm-bff-cache-redis-data` | no (cache/sessions) |
| `agent-db-data` | `movie-assistant-store-postgres-data` | no (checkpoints) |
| `opensearch-data` | `agent-audit-opensearch-data` *(platform-level — `agent` context, shared by any future agent)* | only if `--profile audit` used |
| `ollama-models` | **REMOVED** — containerized `ollama` service deleted; host Ollama is the committed path | n/a |
| `keycloak-mailpit-data` *(managed)* | `keycloak-mailpit-data` *(already conformant)* | no (dev mail) |
| `langfuse-pg-data` *(managed)* | `observability-langfuse-postgres-data` | no |
| `langfuse-clickhouse-data` *(managed)* | `observability-langfuse-clickhouse-data` | no |
| `langfuse-clickhouse-logs` *(managed)* | `observability-langfuse-clickhouse-logs` | no |
| `langfuse-minio-data` *(managed)* | `observability-langfuse-minio-data` | no |
| `otel-lgtm-data` *(managed)* | `observability-otel-lgtm-data` | no |
| `unleash-pg-data` *(managed)* | `observability-unleash-postgres-data` | no |

### Services / containers — **Phase 2 (higher risk)**

Service names are **runtime DNS**, referenced from **gitignored `.env` files** (`KEYCLOAK_URL=http://keycloak-service:8080`, `MC_SERVICE_URL=http://mc-service:3001`, `REDIS_URL=redis://mcm-redis:6379`, `MONGO_URL=…mcm-bff-db:27017`, `AGENT_GATEWAY_URL`), healthchecks, `scripts/agent-stack.mjs` `--name`/URLs, and `gw-proxy`. Renaming a service forces **every environment to update its own `.env`** (not capturable in a PR) and can break inter-service auth. So this is a **separate, coordinated phase** after the volume/network rename lands. (Same `mcm-`-only-on-BFF rule.)

| Current service/container | Proposed |
|---|---|
| `keycloak-service` | `keycloak` |
| `keycloak-db` | `keycloak-db` |
| `keycloak-mailpit` | `keycloak-mailpit` |
| `mc-service` | `mc-service` (keep) |
| `mc-db` | `mc-service-db` |
| `mcm-bff` / `mcm-bff-dev` | keep (already conformant) |
| `mcm-redis` | `mcm-bff-cache` |
| `mcm-bff-db` | `mcm-bff-store` |
| `caddy` | `mcm-bff-proxy` |
| `agent-gateway` | `movie-assistant-gateway` |
| `movie-mcp` / `web-api-mcp` / `spreadsheet-mcp` | `movie-assistant-mcp-{movie,webapi,spreadsheet}` |
| `agent-db` | `movie-assistant-db` |
| `gw-proxy` | `movie-assistant-gw-proxy` |

Open Phase-2 decision: explicit `container_name:` (clean DNS, but disables `--scale`, needs global uniqueness) vs. compose-generated `mcm-<service>-N` (note: a `mcm-bff` service key in project `mcm` yields `mcm-mcm-bff-1` — a reason to set `container_name:` for the BFF). Resolve in `/speckit-plan`.

## Two open items to confirm

1. **Keycloak volume** — `keycloak-store-postgres-data` (aligned to `<role>-<engine>` like the others) or your literal `keycloak-db-data`?
2. **Agent network** — `agent-mcp-network` (your original) or `movie-assistant-mcp-network` (unify with the agent volume/service context)?

## Scope of edits (reference map, verified via `git grep`)

- **Compose `name:`** — 9 service compose files (+ delete `ollama/compose.yaml`).
- **Root [compose.yaml](../../compose.yaml)** — `include:` (drop ollama), profile table, first-time `docker volume/network create` block.
- **Scripts** — [scripts/agent-stack.mjs](../../scripts/agent-stack.mjs), [scripts/agent-gateway-local.ps1](../../scripts/agent-gateway-local.ps1).
- **CI** — [.github/workflows/android-e2e.yml](../../.github/workflows/android-e2e.yml) (volume + network create loops).
- **Docs** — [docs/runbooks/local-dev.md](../runbooks/local-dev.md), [docs/MCM-Architecture.md](../MCM-Architecture.md), [docs/agent-layer.md](../agent-layer.md), [agents/movie-assistant/README.md](../../agents/movie-assistant/README.md).
- **Phase 2 only** — every `.env*.example` + a documented "update your local `.env`" step (live `.env` files are gitignored).
- Historical `specs/004,012,018/**` left as point-in-time record.
