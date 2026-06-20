# Phase 1 Data Model — Naming Taxonomy & Authoritative Mapping

## Naming grammar

```
volume   := <context> "-" <role> "-" <engine> "-data"
network  := <scope> "-network"
service  := <context> "-" <role>          # container_name set explicitly (research D3)

context  := "keycloak" | "mc-service" | "mcm-bff" | "movie-assistant" | "agent" | "observability"
role     := "store" | "cache" | "audit" | <vendor-component>     # e.g. langfuse, otel, unleash, mailpit
engine   := "postgres" | "mongo" | "redis" | "opensearch" | "clickhouse" | "minio" | "mailpit"
scope    := "backend" | "keycloak" | "mcm-bff" | "movie-assistant" | ...
```

**Qualifier rule**: only the `mcm-bff` context carries the `mcm-` frontend qualifier. `movie-assistant` = resources of *this specific* assistant; `agent` = *platform-level* resources shared by any future agent.

## Authoritative mapping (final)

### Networks

| Current | Final | Kind |
|---|---|---|
| `backend-network` | `backend-network` | external (keep) |
| `keycloak-network` | `keycloak-network` | external (keep) |
| `bff-network` | `mcm-bff-network` | managed → set explicit name |
| `agent-mcp` | `movie-assistant-mcp-network` | external |

### Volumes — stateful (copy data)

| Current | Final | Engine | Data |
|---|---|---|---|
| `localdev-auth_keycloak-db-data` | `keycloak-store-postgres-data` | postgres | realm/users/secrets |
| `mc-service_mc-db-data` | `mc-service-store-mongo-data` | mongo | movies/collections |
| `mcm-bff-db-data` | `mcm-bff-store-mongo-data` | mongo | encrypted agent-configs |

### Volumes — disposable (recreate empty)

| Current | Final | Engine | Data |
|---|---|---|---|
| `mcm-redis-data` | `mcm-bff-cache-redis-data` | redis | sessions/cache |
| `agent-db-data` | `movie-assistant-store-postgres-data` | postgres | LangGraph checkpoints |
| `opensearch-data` | `agent-audit-opensearch-data` | opensearch | audit (profile-gated) |

### Volumes — compose-managed (set explicit name)

| Current | Final |
|---|---|
| `keycloak-mailpit-data` | `keycloak-mailpit-data` *(already conformant)* |
| `langfuse-pg-data` | `observability-langfuse-postgres-data` |
| `langfuse-clickhouse-data` | `observability-langfuse-clickhouse-data` |
| `langfuse-clickhouse-logs` | `observability-langfuse-clickhouse-logs` |
| `langfuse-minio-data` | `observability-langfuse-minio-data` |
| `otel-lgtm-data` | `observability-otel-lgtm-data` |
| `unleash-pg-data` | `observability-unleash-postgres-data` |

### Removed

| Removed | Reason |
|---|---|
| `ollama-models` volume + `ollama` service | containerized Ollama deleted (research D5) |

### Services / containers — Stage B (`container_name:` set)

| Current | Final |
|---|---|
| `keycloak-service` | `keycloak` |
| `keycloak-db` | `keycloak-db` |
| `keycloak-mailpit` | `keycloak-mailpit` |
| `mc-service` | `mc-service` |
| `mc-db` | `mc-service-db` |
| `mcm-bff` / `mcm-bff-dev` | `mcm-bff` / `mcm-bff-dev` |
| `mcm-redis` | `mcm-bff-cache` |
| `mcm-bff-db` | `mcm-bff-store` |
| `caddy` | `mcm-bff-proxy` |
| `agent-gateway` | `movie-assistant-gateway` |
| `movie-mcp` / `web-api-mcp` / `spreadsheet-mcp` | `movie-assistant-mcp-movie` / `-webapi` / `-spreadsheet` |
| `agent-db` | `movie-assistant-db` |
| `gw-proxy` | `movie-assistant-gw-proxy` |

## Validation rules

- Every external volume/network and every `container_name:` MUST match the grammar above (enforced by the static gate, contracts/naming-convention.md).
- No `name:` may retain a compose-project prefix (`localdev-auth_`, `mc-service_`) or a bare engine-only form.
- Only the `mcm-bff` context may carry `mcm-`.
- Stateful-volume document/realm counts post-migration MUST equal pre-migration (zero data loss).
