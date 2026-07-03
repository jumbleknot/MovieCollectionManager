# Contract: Stack Health + Audit Posture

## A. Healthcheck contracts (what "healthy" means to Komodo)

| Service | Health probe | Healthy criterion |
|---|---|---|
| `langfuse-postgres` / `unleash-postgres` | `pg_isready -U <u> -d <db>` | accepting connections |
| `langfuse-clickhouse` | `wget --spider http://localhost:8123/ping` | 200 (start_period ≥30s) |
| `langfuse-redis` | `redis-cli -a $PW ping` | PONG |
| `langfuse-minio` | `mc ready local` | ready |
| `langfuse-web` | reachable on `:3000` (deps healthy) | HTTP up |
| `unleash-service` | `wget --spider http://localhost:4242/health` | 200 |
| `otel-lgtm` | **ADD** a probe (e.g. `wget --spider http://localhost:3000` Grafana, or OTLP port open) | up |
| `opa-service` | **ADD** a probe (e.g. `wget --spider http://localhost:8181/health`) | 200 |
| `agent-audit-opensearch` | `curl -sk -u admin:$PW https://localhost:9200/_cluster/health` | non-error (start_period ~40s) |
| `agent-audit-init` | one-shot | `service_completed_successfully` (the write=201 / search=403 self-verify passes) |
| `vault-service` (dormant) | `curl .../v1/sys/health?uninitcode=200&sealedcode=200&standbycode=200` → 200 | **healthy while uninitialized+sealed** |

**Dormant-Vault rule (critical)**: without the `uninitcode`/`sealedcode` overrides the default health endpoint returns 501 (uninit) / 503 (sealed) → Komodo marks the stack unhealthy and may loop-redeploy (same trap as mc-service self-init Mongo). The overrides make dormant a healthy state; they lose effect (revert to real semantics) once the operator runs `vault operator init` + unseal at adoption.

## B. Audit posture contract (write-only sink)

The `agent-audit` role/user (created by `agent-audit-init`, logic from `opensearch/init-audit-user.sh`):

- **Index patterns**: `mcm-agent-audit-*`, `mcm-agent-audit`.
- **Allowed actions ONLY**: `create_index`, `indices:data/write/index`, `indices:data/write/bulk`, `indices:data/write/bulk*` + cluster `cluster_composite_ops`.
- **Denied** (must fail): read/search, update, delete.
- **Self-verification** (the init service asserts, or fails): a write returns **201**; a `_search` returns **403**. These two probes ARE the acceptance oracle for SC-006.

Audit document (written at runtime by the app `audit_sink`): a redacted structured JSON doc (`action`, `user_id` [Keycloak UUID], decision/`allowed`, `timestamp`, …) — never a raw token, email, or username (constitution logging rule). Index-time only; the sink never reads back.

## C. Acceptance-oracle mapping (spec SC → verification)

| SC | Oracle |
|---|---|
| SC-001 | Komodo shows all three stacks healthy (incl. dormant Vault via override). |
| SC-002 | One prod assistant turn → ≥1 LangFuse trace visible (or `test_observability_sc008.py` against prod LangFuse). |
| SC-003 | ≥1 OTLP span/metric from the gateway in otel-lgtm/Grafana. |
| SC-004 | An OPA policy deny blocks a real token-exchange/action (`test_opa_authz.py`). |
| SC-005 | Flip an Unleash flag (e.g. kill-switch) → app behavior changes, no redeploy (`test_unleash_flags.py`). |
| SC-006 | `agent-audit-init` write=201/search=403 + a real action lands a doc (`test_audit_opensearch.py`). |
| SC-007 | Restart `vault-service` → data persists, still uninit+sealed; no secret in committed files. |
| SC-008 | With consumer vars unset, app behavior unchanged (baseline vs wired). |
| SC-009 | `secret-scan` + `check-no-inline-secrets` + topology-scrub + `check-resource-naming` all green. |
| SC-010 | Bring up/tear down each stack independently; app + other stacks unaffected. |
