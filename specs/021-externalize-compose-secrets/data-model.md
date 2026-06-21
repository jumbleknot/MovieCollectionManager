# Phase 1 Data Model: Credential-Variable Registry

The "data" for this feature is the canonical set of credential variables — their names, generation kind, the exact occurrences that must reference each one, and which stack `.env` owns them. This registry is the single source of truth the compose edits, the `*.env.example` templates, the generator, and the gate allowlist all derive from.

## Entities

### Credential variable
- **name** — canonical `UPPER_SNAKE_CASE` env var, referenced as `${name:?…}`.
- **kind** — generation rule (see research R4 table): `b62-32` | `b62-48` | `hex-64` | `complex-16` | `unleash-admin` | `unleash-client` | `fixed`.
- **stack** — which `<stack>.env` owns it: `auth` | `mcm` | `audit` | `observability`.
- **occurrences** — every file + location (`environment` / `command` / `healthcheck` / `entrypoint` / URL) that must reference it.
- **shared** — true if referenced by more than one service/location (still one variable).

### Placeholder template (`<stack>.env.example`, committed)
One line per variable: `NAME=<generate:KIND>` for randomized, `NAME=<fixed value>` for deterministic fixtures. The generator's contract: every `<generate:…>` becomes a real value; every fixed value is copied verbatim.

### Local value file (`<stack>.env`, gitignored)
The generator's output — same keys, real values. Never committed.

## Registry

### Stack: `auth` → `auth.env`
| Variable | Kind | Occurrences |
|----------|------|-------------|
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | `complex-16` | `keycloak/compose.yaml` → keycloak-service `environment` (replaces `change_me`). Not URL-embedded. |
| `VAULT_DEV_ROOT_TOKEN_ID` | `b62-48` | `vault/compose.yaml` → vault-service `environment` (replaces `mcm-dev-root-token`). |

> Out of scope (already externalized): `keycloak-store-postgres` password (`POSTGRES_PASSWORD_FILE` → `secrets/keycloak_db_password.txt`); keycloak-service DB password via `.env.local`.

### Stack: `mcm` → `mcm.env`
| Variable | Kind | Occurrences |
|----------|------|-------------|
| `AGENT_DB_PASSWORD` | `b62-32` | **shared**: `agent-db/compose.yaml` → `POSTGRES_PASSWORD`; `agent-gateway/compose.yaml` → `AGENT_DB_URL` (`postgresql://agent:${AGENT_DB_PASSWORD}@movie-assistant-store-postgres:5432/agent_db`). URL-embedded → URL-safe kind. |

> Out of scope (already externalized): `AGENT_GATEWAY_CLIENT_SECRET` (`${…:-}`, injected at deploy); BFF `.env.docker`; mc-service `.env.local`.

### Stack: `audit` → `audit.env`
| Variable | Kind | Occurrences |
|----------|------|-------------|
| `OPENSEARCH_INITIAL_ADMIN_PASSWORD` | `complex-16` | **shared**: `opensearch/compose.yaml` → `environment` + `healthcheck` (`curl -sk -u admin:${OPENSEARCH_INITIAL_ADMIN_PASSWORD} …`). Also sanitize the header-comment literals (R6). Not URL-embedded (used in a `-u user:pass` curl arg → keep free of shell-special chars; `complex-16` charset excludes shell-breaking chars). |

> Note: the runtime-provisioned `agent-audit` writer account is not a compose env var; only its documentation comment is sanitized.

### Stack: `observability` → `observability.env`
| Variable | Kind | Occurrences |
|----------|------|-------------|
| `LANGFUSE_PG_PASSWORD` | `b62-32` | **shared**: langfuse-postgres `POSTGRES_PASSWORD`; langfuse-web/worker `DATABASE_URL`. URL-embedded. |
| `LANGFUSE_CLICKHOUSE_PASSWORD` | `b62-32` | **shared**: langfuse-clickhouse `CLICKHOUSE_PASSWORD`; langfuse-web/worker `CLICKHOUSE_PASSWORD` (+ `CLICKHOUSE_MIGRATION_URL`/`CLICKHOUSE_URL` carry user only, no pw). |
| `LANGFUSE_REDIS_PASSWORD` | `b62-32` | **shared ×3**: langfuse-redis `command` (`--requirepass`); langfuse-redis `healthcheck` (`redis-cli -a`); langfuse-web/worker `REDIS_AUTH`. |
| `LANGFUSE_MINIO_ROOT_PASSWORD` | `b62-32` | **shared ×4**: langfuse-minio `MINIO_ROOT_PASSWORD`; langfuse-minio-init `entrypoint` (`mc alias set … minio <pw>`); langfuse-web/worker `LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY` + `LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY`. (The S3 *ACCESS_KEY_ID* + `MINIO_ROOT_USER` = `minio` is a non-secret identifier — left inline / allowlisted.) |
| `LANGFUSE_SALT` | `b62-48` | langfuse-web/worker `SALT`. |
| `LANGFUSE_ENCRYPTION_KEY` | `hex-64` | langfuse-web/worker `ENCRYPTION_KEY` (must be 32-byte hex). |
| `LANGFUSE_NEXTAUTH_SECRET` | `b62-48` | langfuse-web `NEXTAUTH_SECRET`. |
| `LANGFUSE_INIT_USER_PASSWORD` | `b62-48` | langfuse-web `LANGFUSE_INIT_USER_PASSWORD` (the LangFuse UI dev login; dev reads it from `.env`). |
| `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` | `fixed` = `pk-lf-mcm-dev-0000000000000000` | langfuse-web `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`. Deterministic fixture — gateway + SC-008 verify test must match. |
| `LANGFUSE_INIT_PROJECT_SECRET_KEY` | `fixed` = `sk-lf-mcm-dev-0000000000000000` | langfuse-web `LANGFUSE_INIT_PROJECT_SECRET_KEY`. Deterministic fixture. |
| `UNLEASH_PG_PASSWORD` | `b62-32` | **shared**: unleash-postgres `POSTGRES_PASSWORD`; unleash-service `DATABASE_URL`. URL-embedded. |
| `UNLEASH_ADMIN_TOKEN` | `unleash-admin` | **shared**: unleash-service `INIT_ADMIN_API_TOKENS`; unleash-seed `entrypoint` Authorization header. Full structured value `*:*.<random>`. |
| `UNLEASH_CLIENT_TOKEN` | `unleash-client` | unleash-service `INIT_CLIENT_API_TOKENS`. Value `default:development.<random>`. |

## Non-secret values left inline (gate allowlist)

These contain a secret-shaped substring or sit near secrets but are not credentials — explicitly allowlisted in the gate (mirrors `check-resource-naming.mjs`'s `NAME_ALLOWLIST`):
- `POSTGRES_USER`, `CLICKHOUSE_USER`, `MINIO_ROOT_USER`, the `…_S3_…_ACCESS_KEY_ID` (= `minio`), `REDIS_HOST`, DB/host/port fragments of URLs.
- `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `LANGFUSE_INIT_PROJECT_SECRET_KEY` (deterministic fixtures — present in the committed `.env.example` by design; allowlisted so the gate does not flag the fixture value, while still requiring the compose file to reference them via `${…}`).

## Counts (for SC-001 / tasks derivation)

- Randomized secret variables: **13** (`KC_BOOTSTRAP_ADMIN_PASSWORD`, `VAULT_DEV_ROOT_TOKEN_ID`, `AGENT_DB_PASSWORD`, `OPENSEARCH_INITIAL_ADMIN_PASSWORD`, `LANGFUSE_PG_PASSWORD`, `LANGFUSE_CLICKHOUSE_PASSWORD`, `LANGFUSE_REDIS_PASSWORD`, `LANGFUSE_MINIO_ROOT_PASSWORD`, `LANGFUSE_SALT`, `LANGFUSE_ENCRYPTION_KEY`, `LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_INIT_USER_PASSWORD`, `UNLEASH_PG_PASSWORD`) + the 2 structured unleash tokens = **15 randomized**.
- Deterministic fixtures: **2** (`LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`).
- Total canonical variables: **17**, across **6** edited component compose files and **~25** literal occurrences (several variables shared across multiple locations).
