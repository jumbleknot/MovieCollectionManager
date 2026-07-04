# Runbook — Prod Control Tower (observability / audit / dormant Vault)

Feature **025**. Promotes the env-gated Control-Tower services to production as **three Komodo
ResourceSync stacks** — `prod-audit` (P1/MVP), `prod-observability` (P2), `prod-vault` (P3, dormant) —
then wires `prod-mcm-bff` + `prod-movie-assistant` to consume them via **env only** (no app code change).
Upstream images ⇒ no CI build/scan/digest; deploy = merge to `main` → ResourceSync, exactly like `prod-auth`.

Full acceptance runbook + SC checks: [specs/025-observability-audit-vault-prod/quickstart.md](../../specs/025-observability-audit-vault-prod/quickstart.md).
Contracts (variables, consumer-env, health/audit): `specs/025-observability-audit-vault-prod/contracts/`.

## Files

| Stack | Compose | `stacks.toml` block |
|---|---|---|
| prod-audit | `infrastructure-as-code/docker/opensearch/compose.prod.yaml` (+ reused `init-audit-user.sh`) | `prod-audit` |
| prod-observability | `infrastructure-as-code/docker/observability/compose.prod.yaml` | `prod-observability` |
| prod-vault | `infrastructure-as-code/docker/vault/compose.prod.yaml` + `vault/config/vault.hcl` | `prod-vault` |
| consumers | `bff/compose.prod.yaml`, `agents/compose.prod.yaml` (env + `agent-audit-network`) | extended `prod-mcm-bff` / `prod-movie-assistant` `environment` |

## One-time host prerequisites (prod host)

```sh
# 8 external volumes (data survives redeploys)
docker volume create observability-langfuse-postgres-data
docker volume create observability-langfuse-clickhouse-data
docker volume create observability-langfuse-clickhouse-logs
docker volume create observability-langfuse-minio-data
docker volume create observability-otel-lgtm-data
docker volume create observability-unleash-postgres-data
docker volume create agent-audit-opensearch-data
docker volume create vault-store-data

# dedicated isolation network for the audit sink (FR-001) — only opensearch + gateway/BFF join it
docker network create agent-audit-network
```

## Seed Komodo Variables (masked) — BEFORE the first sync that references them

An unseeded `[[VAR]]` interpolates empty → the support compose's `${VAR:?}` aborts the deploy (intended
fail-fast). **15 new Variables** (13 observability + 2 audit); Vault dormant needs none.

- **audit (2):** `OPENSEARCH_INITIAL_ADMIN_PASSWORD` (strong — OpenSearch rejects weak), `OPENSEARCH_AUDIT_WRITER_PASSWORD`.
- **observability (13):** `LANGFUSE_SALT`, `LANGFUSE_ENCRYPTION_KEY` (64-hex), `LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_PG_PASSWORD`, `LANGFUSE_CLICKHOUSE_PASSWORD`, `LANGFUSE_REDIS_PASSWORD`, `LANGFUSE_MINIO_ROOT_PASSWORD`, `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`, `LANGFUSE_INIT_USER_PASSWORD`, `UNLEASH_PG_PASSWORD`, `UNLEASH_ADMIN_TOKEN`, `UNLEASH_CLIENT_TOKEN`.
- **reused (NOT new):** `TS_ADMIN_IP`, `TAILNET_HOST` (already seeded for prod-auth) — the R10 tailnet operator-UI binds.

The `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `_SECRET_KEY` are the **same** values the gateway consumes (the
deterministic bootstrap keeps its pinned keys valid). `UNLEASH_CLIENT_TOKEN` is the **client** token the app uses.

## Deploy order & verify (per phase)

1. **prod-audit (P1/MVP)** — merge → ResourceSync. Verify `agent-audit-opensearch` healthy and
   `agent-audit-init` completed with **write=201 / search=403** in its logs (SC-001, SC-006). Then wire
   consumers (already in the composes) and drive one assistant action → an `mcm-agent-audit*` doc lands.
2. **prod-observability (P2)** — capacity-check the host first, then merge → sync. Every service healthy
   (minio-init/unleash-seed `completed_successfully`). Wired checks: SC-002 (LangFuse trace), SC-003 (OTel
   span), SC-004 (`test_opa_authz.py` deny enforced), SC-005 (flip `mcm.agent.kill-switch`, no redeploy).
3. **prod-vault (P3)** — merge → sync. `vault-service` healthy while **uninitialized + sealed**;
   `docker restart vault-service` → still uninit/sealed, `vault-store-data` persisted; `git grep` → no token.
   **Do NOT run `vault operator init`** (out of scope).

Operator UIs (R10): only `langfuse-web` (`:3030`) + Grafana (`:3002`), bound to `${TS_ADMIN_IP}` — reach
them over the tailnet (`http://<TAILNET_HOST>:3030` / `:3002`). No public port anywhere.

## Capacity check (T013) — result (2026-07-03)

Prod host (`prod@homelab`, ~57 GiB usable): **48 GiB RAM available**, actual container RSS ~2.2 GiB (app
is featherweight; Keycloak ~746 MB is the heaviest), `/var/lib/docker` on `/` with **759 GB free**.
Observability (~6–7 GiB) + prod-audit OpenSearch (~1.5 GiB) ≈ ~8 GiB → still ~40 GiB free. **Decision:
always-on (default), no opt-in fallback; ClickHouse `mem_limit: 4g` retained** (ample headroom, no need to
lower). Re-run the check (`free -h` + `docker stats --no-stream`) before any future footprint increase.

## Load-bearing gotchas (do not "fix" away)

- **Audit-init image MUST ship bash + curl.** `init-audit-user.sh` is `#!/usr/bin/env bash`; the bash-less
  `curlimages/curl` (Alpine) can't run it → `agent-audit-init` reuses `opensearchproject/opensearch:2`.
- **`mkdir -p …/stacks` before running the init script.** The reused script self-locates `../stacks/audit.env`
  and `cd`s into it BEFORE the `[ -f ]` guard; under `set -euo pipefail` a missing dir aborts the whole
  script (verified). The init service pre-creates an empty sibling `stacks` dir so the cd succeeds, no
  `audit.env` is found (Komodo checkout has none), and it falls back to the env vars.
- **BFF audit needs `OPENSEARCH_INSECURE_TLS=true`.** OpenSearch serves a self-signed cert; the BFF sink
  (`audit-sink.ts`) POSTs over https via `node:https` with `rejectUnauthorized:false` **only** when this is
  truthy — else the POST fails cert validation and no audit doc lands from the BFF path (SC-006). The
  gateway sink (`audit_sink.py`) uses `httpx verify=False`, so it needs no flag.
- **OPA uses the `-debug` image variant.** Distroless `openpolicyagent/opa` has no shell; `-debug` adds
  busybox so the `/health` wget healthcheck (and Komodo status) works. Policies already `import rego.v1`
  (OPA 1.x compatible). OPA is **fail-closed** on the BFF + gateway when `OPA_URL` is set.
- **ClickHouse capped via `mem_limit: 4g`** (R5) — 24.3 is cgroup-aware, so the container limit bounds its
  internal `max_server_memory_usage`. OpenSearch pinned `-Xms1g -Xmx1g`.
- **Dormant Vault health override.** `?uninitcode=200&sealedcode=200&standbycode=200` makes uninitialized +
  sealed read as healthy; the codes resume real meaning once an operator inits + unseals (future).

## Additive no-op (SC-008) & rollback (SC-010)

Every consumer var is **optional** (`${VAR}` in compose, never `${VAR:?}`; the `stacks.toml` refs are the
only place they get values). Deploying a support stack does **not** by itself change app behavior — the app
turns a capability on only when its consumer env is present (source gates: `audit_sink`/`OPENSEARCH_URL`,
`observability`/`LANGFUSE_*`+`OTEL_*`, `opa`/`OPA_URL`, `flags`/`UNLEASH_URL`). Unset ⇒ silent no-op ⇒
prior behavior unchanged. **Rollback** = remove the consumer env (→ no-op) and/or delete the support
`[[stack]]` block (→ ResourceSync removes it). No app redeploy needed to disable a capability. Each stack
is independently up/down-able.

## Guardrails (SC-009 — run before every push)

```sh
node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs
node scripts/check-no-inline-secrets.mjs
node scripts/check-resource-naming.mjs
node scripts/check-topology-scrub.mjs
```

The only gate change this feature needs is `agent-audit-network` in `APPROVED_NETWORKS` + the `vault`
volume prefix in `VOLUME_RE` (`scripts/check-resource-naming.mjs`).
