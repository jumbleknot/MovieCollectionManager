# Contract: Komodo Variables to seed (masked)

Real prod values live ONLY as **masked Komodo Variables**, interpolated `[[NAME]]` in `stacks.toml`; Komodo writes them into the gitignored per-stack `.env.prod`. Committed compose carries only `${VAR:?}`. Nothing here is committed to git.

## prod-observability

| Komodo Variable | Consumed by | Notes |
|---|---|---|
| `LANGFUSE_SALT` | langfuse-web/worker | random |
| `LANGFUSE_ENCRYPTION_KEY` | langfuse-web/worker | 64-hex (32 bytes) |
| `LANGFUSE_NEXTAUTH_SECRET` | langfuse-web | random |
| `LANGFUSE_PG_PASSWORD` | langfuse-web/worker/postgres | |
| `LANGFUSE_CLICKHOUSE_PASSWORD` | langfuse-web/worker/clickhouse | |
| `LANGFUSE_REDIS_PASSWORD` | langfuse-web/worker/redis | |
| `LANGFUSE_MINIO_ROOT_PASSWORD` | langfuse-web/worker/minio/minio-init | |
| `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` | langfuse-web bootstrap **and** the gateway consumer (`LANGFUSE_PUBLIC_KEY`) | **same value both places** — keeps the deterministic bootstrap key valid |
| `LANGFUSE_INIT_PROJECT_SECRET_KEY` | langfuse-web bootstrap **and** the gateway consumer (`LANGFUSE_SECRET_KEY`) | **same value both places** |
| `LANGFUSE_INIT_USER_PASSWORD` | langfuse-web bootstrap admin login | |
| `UNLEASH_PG_PASSWORD` | unleash-service/postgres | |
| `UNLEASH_ADMIN_TOKEN` | unleash-service (`INIT_ADMIN_API_TOKENS`) + unleash-seed | admin scope |
| `UNLEASH_CLIENT_TOKEN` | unleash-service (`INIT_CLIENT_API_TOKENS`) **and** the gateway consumer (`UNLEASH_API_TOKEN`) | **client** scope — the value the app uses |

## prod-audit

| Komodo Variable | Consumed by | Notes |
|---|---|---|
| `OPENSEARCH_INITIAL_ADMIN_PASSWORD` | agent-audit-opensearch + agent-audit-init (admin) | strong; OpenSearch rejects weak |
| `OPENSEARCH_AUDIT_WRITER_PASSWORD` | agent-audit-init (creates the user) **and** the gateway/BFF consumer (`OPENSEARCH_PASSWORD`) | **same value** — the write-only account password |

**Reused (NOT new) — operator-UI binds (R10)**: `prod-observability` also references `TS_ADMIN_IP` and `TAILNET_HOST` in its `environment` to bind the LangFuse + Grafana UIs to the tailnet admin IP. Both Variables **already exist** (seeded for `prod-auth`); nothing new to seed — just add them to the `prod-observability` `environment` block.

## prod-vault (dormant)

None while dormant — real Vault has no root token in env. (Adoption later adds only unseal/injection material.)

## Consumer app stacks (reuse of the above, added to `environment`)

| Stack | Vars added |
|---|---|
| `prod-mcm-bff` | `OPENSEARCH_AUDIT_WRITER_PASSWORD`, `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`, `UNLEASH_CLIENT_TOKEN` (mapped to the consumer env-var names in consumer-env-contract.md) |
| `prod-movie-assistant` | same set (gateway is the primary emitter) |

**Seeding order**: seed all Variables **before** the ResourceSync that first references them (a `[[VAR]]` with no backing Variable interpolates empty → `${VAR:?}` on the support stacks aborts the deploy, which is the intended fail-fast).
