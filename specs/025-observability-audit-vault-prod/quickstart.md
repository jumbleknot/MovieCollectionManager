# Quickstart: Deploy & Verify the Prod Observability / Audit / Vault Stacks

A validation runbook proving the feature end-to-end. Deploy is via Komodo ResourceSync (git push → webhook → reconcile); the steps below are what an operator does + how each Success Criterion is checked. Not implementation code — see `tasks.md` for the build steps.

## Prerequisites (one-time on the prod host)

```sh
# External volumes (data survives redeploys)
docker volume create observability-langfuse-postgres-data
docker volume create observability-langfuse-clickhouse-data
docker volume create observability-langfuse-clickhouse-logs
docker volume create observability-langfuse-minio-data
docker volume create observability-otel-lgtm-data
docker volume create observability-unleash-postgres-data
docker volume create agent-audit-opensearch-data
docker volume create vault-store-data

# Dedicated audit network (isolation — FR-001)
docker network create agent-audit-network
```

Seed the masked **Komodo Variables** (see `contracts/komodo-variables.md`) BEFORE the first sync that references them. The `prod-observability` UI binds reuse the existing `TS_ADMIN_IP` + `TAILNET_HOST` Variables (already seeded for prod-auth) — nothing new.

**Operator UI access (R10)**: only `langfuse-web` (`:3030`) and Grafana (`:3002`) are published, and only on the prod host's **tailnet admin IP** — reach them over the tailnet at `http://<TAILNET_HOST>:3030` (LangFuse) / `:3002` (Grafana). No public port; every other service is unpublished.

## Phase 1 — prod-audit (P1, simplest, highest value)

1. Land `opensearch/compose.prod.yaml` (+ `agent-audit-init`) and the `prod-audit` `stacks.toml` block; push to `main`.
2. Komodo ResourceSync reconciles → deploys `prod-audit`.
3. **Verify (SC-001, SC-006)**:
   - `agent-audit-opensearch` healthy; `agent-audit-init` exited `completed_successfully` with `write=201 / search=403` in its logs.
   - Manually confirm the write-only posture (from a host with network access):
     ```sh
     # write (expect 201), search (expect 403)
     curl -sk -u agent-audit:$PW -XPOST https://<host>/mcm-agent-audit/_doc -H 'Content-Type: application/json' -d '{"action":"qs-verify"}' -o /dev/null -w '%{http_code}\n'
     curl -sk -u agent-audit:$PW https://<host>/mcm-agent-audit/_search -o /dev/null -w '%{http_code}\n'
     ```
4. **Wire consumers** (Phase-2 of the coupling): add `OPENSEARCH_URL/USERNAME/PASSWORD` to `prod-mcm-bff` + `prod-movie-assistant` (both compose refs + `stacks.toml` env + the `agent-audit-network` join); re-sync.
5. **Verify wired**: drive one assistant action → an audit doc appears (`test_audit_opensearch.py` against prod, or check index count increments).

## Phase 2 — prod-observability (P2, after a capacity check)

1. **Capacity check**: confirm host headroom for LangFuse+ClickHouse+Unleash alongside audit + the app (set the ClickHouse/OpenSearch caps per research R5). Abort/opt-in fallback if short.
2. Land `observability/compose.prod.yaml` + the `prod-observability` block; push; sync.
3. **Verify (SC-001)**: every service healthy in Komodo (langfuse-web/worker, clickhouse, postgres×2, redis, minio, otel-lgtm, opa-service, unleash-service; minio-init/unleash-seed completed).
4. **Wire consumers**: add `LANGFUSE_*`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OPA_URL`, `UNLEASH_URL/API_TOKEN` to the two app stacks; re-sync.
5. **Verify wired**:
   - **SC-002**: one assistant turn → a LangFuse trace appears (LangFuse UI over the tailnet `http://<TAILNET_HOST>:3030`, project `movie-assistant`).
   - **SC-003**: gateway OTLP spans/metrics visible in Grafana (over the tailnet `http://<TAILNET_HOST>:3002`).
   - **SC-004**: a policy that denies an action → the action is blocked (`test_opa_authz.py`).
   - **SC-005**: flip `mcm.agent.kill-switch` in Unleash → assistant disabled without redeploy; flip back.

## Phase 3 — Vault (dormant)

1. Land `vault/compose.prod.yaml` + `config/vault.hcl` under `prod-auth`; push; sync.
2. **Verify (SC-001, SC-007)**:
   - `vault-service` reports **healthy** in Komodo while **uninitialized + sealed** (the `?uninitcode=200&sealedcode=200` health override).
   - `docker restart vault-service` → still uninit+sealed, `vault-store-data` persisted.
   - `git grep` the committed files → NO root token / secret (it is not `-dev`).
   - Do **NOT** run `vault operator init` (out of scope).

## Cross-cutting gates (every phase)

- **SC-008 (additive no-op)**: before wiring, capture app behavior; after deploying support stacks but before consumer env, behavior is unchanged.
- **SC-009 (zero committed secrets/topology)**: run locally before push —
  ```sh
  node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs
  node scripts/check-no-inline-secrets.mjs
  node scripts/check-resource-naming.mjs
  ```
  All must pass (they run in CI `guardrails.yml` too).
- **SC-010 (independence)**: each stack up/down without touching the others or the app.

## Rollback

Remove the consumer env vars (→ integrations no-op) and/or delete the support `[[stack]]` block (→ ResourceSync removes it). No app redeploy needed to disable a capability.
