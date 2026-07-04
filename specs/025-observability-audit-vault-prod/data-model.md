# Phase 1 Data Model: Production Observability, Audit & Vault Stacks

This feature has no application data model. The "entities" are deployment artifacts: stacks, services, volumes, networks, Komodo Variables, and the one runtime document shape (the audit record). This inventory is the source of truth for the Phase-2 task list.

## Entity 1 — Stack (Komodo ResourceSync `[[stack]]`)

| Field | prod-observability | prod-audit | prod-auth (Vault addition) |
|---|---|---|---|
| `name` | `prod-observability` | `prod-audit` | `prod-auth` (existing) |
| `deploy` | `true` | `true` | `true` (existing) |
| `after` | `["prod-mcm-bff"]` (consumers up first is not required to deploy the support stack, but ordering after the app keeps a clean graph; may be `[]`) | `[]` (independent; simplest, highest value) | `[]` (root) |
| `run_directory` | `infrastructure-as-code/docker/observability` | `infrastructure-as-code/docker/opensearch` | `infrastructure-as-code/docker/keycloak` (+ Vault file, see note) |
| `file_paths` | `["compose.prod.yaml"]` | `["compose.prod.yaml"]` | `["compose.prod.yaml"]` (+ Vault — see note) |
| `env_file_path` | `.env.prod` | `.env.prod` | `.env.prod` (existing) |
| `additional_env_files` | — (no digests) | — | — |
| `environment` (`[[VAR]]`) | LangFuse + Unleash secrets | `OPENSEARCH_INITIAL_ADMIN_PASSWORD`, `OPENSEARCH_AUDIT_WRITER_PASSWORD` | (unchanged; Vault dormant needs no vars) |

**Vault note**: Vault co-locates in `prod-auth`. Two shapes are acceptable; pick in tasks:
(a) add `vault/compose.prod.yaml` as a second entry in the prod-auth `file_paths` (multi-file compose merge, shared run-directory root), or
(b) a standalone `prod-vault` `[[stack]]` with `run_directory=infrastructure-as-code/docker/vault`. Plan default: (a) to match "co-located in prod-auth"; keep (b) as the split-later option.

## Entity 2 — Services (new containers)

### prod-observability (`compose.prod.yaml`, on `backend-network`)
| Service / container | Image (pinned) | Persistent volume | Health | Notes |
|---|---|---|---|---|
| `langfuse-web` | `langfuse/langfuse:3` | — | via deps | internal `:3000`; **UI published on `${TS_ADMIN_IP}:3030` only** (R10 tailnet bind); `NEXTAUTH_URL=http://${TAILNET_HOST}:3030` |
| `langfuse-worker` | `langfuse/langfuse-worker:3` | — | — | waits on minio-init |
| `langfuse-postgres` | `postgres:16-alpine` | `observability-langfuse-postgres-data` | `pg_isready` | |
| `langfuse-clickhouse` | `clickhouse/clickhouse-server:24.3` | `observability-langfuse-clickhouse-data` + `-logs` | `/ping` | **mem cap** (R5) |
| `langfuse-redis` | `redis:7-alpine` | — | `redis-cli ping` | `--requirepass` |
| `langfuse-minio` | `minio/minio` | `observability-langfuse-minio-data` | `mc ready` | |
| `langfuse-minio-init` | `minio/mc` | — | one-shot | creates `langfuse` bucket |
| `otel-lgtm` | `grafana/otel-lgtm` | `observability-otel-lgtm-data` | (add one) | internal OTLP `:4318`/`:4317`; **Grafana UI published on `${TS_ADMIN_IP}:3002` only** (R10); OTLP ports unpublished |
| `opa-service` | `openpolicyagent/opa` | — (mounts `../../opa/policies:ro`) | (add one) | `run --server --addr=0.0.0.0:8181 --watch /policies` |
| `unleash-service` | `unleashorg/unleash-server` | — | `/health` | internal `:4242` |
| `unleash-postgres` | `postgres:16-alpine` | `observability-unleash-postgres-data` | `pg_isready` | |
| `unleash-seed` | `curlimages/curl` | — | one-shot | seeds 3 flags default-off |

### prod-audit (`compose.prod.yaml`, on `agent-audit-network`)
| Service / container | Image (pinned) | Persistent volume | Health | Notes |
|---|---|---|---|---|
| `agent-audit-opensearch` | `opensearchproject/opensearch:2` | `agent-audit-opensearch-data` (external) | `_cluster/health` `curl -sk` | `-Xms1g -Xmx1g`, `memory_lock`, no host port |
| `agent-audit-init` | `curlimages/curl` (or shell) | — | one-shot (`service_completed_successfully`) | runs init-audit-user.sh logic; idempotent; skips if pw unset |

### prod-auth Vault addition (`vault/compose.prod.yaml`, on `backend-network`)
| Service / container | Image (pinned) | Persistent volume | Health | Notes |
|---|---|---|---|---|
| `vault-service` | `hashicorp/vault:1.18` | `vault-store-data` (external, raft) | `/v1/sys/health?uninitcode=200&sealedcode=200&standbycode=200` | `server -config`, `IPC_LOCK`, sealed/uninit, no host port |

## Entity 3 — Volumes (external, pre-create on prod host)

`observability-langfuse-postgres-data`, `observability-langfuse-clickhouse-data`, `observability-langfuse-clickhouse-logs`, `observability-langfuse-minio-data`, `observability-otel-lgtm-data`, `observability-unleash-postgres-data`, `agent-audit-opensearch-data`, `vault-store-data`.

**Naming**: all match the gate regex (`observability-…-data|-logs`, `agent-audit-opensearch-data`, `vault-store-data` → matches `vault-...-data`? verify: identifier regex covers container names; volume regex requires a known prefix — `vault-store-data` must match `^(…|vault?)…`; the volume regex prefix set is `keycloak|mc-service|mcm-bff|movie-assistant|agent|observability` → **`vault-store-data` and `agent-audit-opensearch-data` need a volume-regex allowlist check**). **Task**: confirm/extend `VOLUME_RE` in `check-resource-naming.mjs` to admit `vault-` and `agent-audit-` volume prefixes (or name them `agent-...`/reuse an approved prefix). Flag resolved in tasks.

## Entity 4 — Networks (external, pre-create on prod host)

| Network | Members | Status |
|---|---|---|
| `backend-network` | existing + langfuse/otel/opa/unleash + vault-service | exists (allowlisted) |
| `agent-audit-network` | `agent-audit-opensearch`, `agent-audit-init`, (consumers) BFF + gateway | **NEW** — pre-create + add to `APPROVED_NETWORKS` |

## Entity 5 — Komodo Variables (masked, seeded once)

Full list + which stack consumes each → [contracts/komodo-variables.md](./contracts/komodo-variables.md). Categories: LangFuse (10), Unleash (3), audit (2), plus reuse of a subset on the two consumer app stacks.

## Entity 6 — Consumer env contract (app stacks)

The env vars added to `prod-mcm-bff` + `prod-movie-assistant` that flip each integration from no-op to active → [contracts/consumer-env-contract.md](./contracts/consumer-env-contract.md). Governing invariant: **every one of these is optional**; unset ⇒ no-op ⇒ unchanged behavior (SC-008).

## Entity 7 — Audit document (runtime)

Written by the gateway/BFF `audit_sink` to index pattern `mcm-agent-audit-*` (or `mcm-agent-audit`). Redacted structured document (action, user_id, decision/allowed, timestamp, …). The `agent-audit` credential may `create_index`/`write`/`bulk` only — no `read`/`search`/`delete` (enforced by the role in init-audit-user.sh). Shape/permission contract → [contracts/stack-health-and-audit-contracts.md](./contracts/stack-health-and-audit-contracts.md).

## Lifecycle / state (Vault)

`deployed (uninitialized, sealed)` → [FUTURE, out of scope] `vault operator init` → `initialized, sealed` → `vault operator unseal` → `unsealed, active`. This feature stops at the first state; the healthcheck override makes that state report healthy.
