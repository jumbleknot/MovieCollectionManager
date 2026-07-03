# Phase 0 Research: Production Observability, Audit & Vault Stacks

All spec-level unknowns were resolved during `/speckit-clarify` (fail-closed policy, always-on + caps, one-shot audit init) and by the 2026-07-03 Vault decision (IN v1, dormant, prod-grade). The remaining decisions below are implementation choices left open in PRD §6; each is settled here so Phase 1/2 has no open questions.

## R1 — Deploy model: upstream images, no CI pipeline

**Decision**: All new stacks deploy as `compose.prod.yaml` + `stacks.toml` block with `env_file_path=".env.prod"` and **no** `additional_env_files`/`.env.deploy`.
**Rationale**: Every image is upstream-pinned — there is no `nx build`, Trivy scan, or digest-by-git promote. This is exactly the `prod-auth`/Keycloak model (`quay.io/keycloak/keycloak:26.5.5`, `postgres`). The `.env.deploy` mechanism exists only to carry CI-built bare `*_DIGEST` values, which these stacks don't have.
**Alternatives considered**: Mirroring the app stacks' digest-promotion path — rejected: there is nothing to build or promote; it would add a meaningless CI coupling.

## R2 — Networking: dedicated `agent-audit-network`; observability on `backend-network`

**Decision**:
- **prod-audit** → a **dedicated external `agent-audit-network`**, joined only by `agent-audit-opensearch`, the one-shot init service, and (as consumers) `prod-mcm-bff`'s BFF + `prod-movie-assistant`'s gateway.
- **prod-observability** → the shared external **`backend-network`** (where the gateway/BFF already live), matching the dev compose.
**Rationale**: FR-001 requires the audit sink be reachable by **only** the gateway + BFF. `backend-network` is shared by keycloak + mc-service + bff + agents, so it cannot satisfy "only." A dedicated network is the isolation boundary (mirrors the prod `mc-service-network` DB-isolation precedent). Observability (OPA/Unleash/otel/LangFuse) has no equivalent "only two callers" requirement and its services are internal telemetry/policy the gateway+BFF already reach on `backend-network`; a second network adds cost without a security gain.
**Consequence**: `agent-audit-network` must be pre-created on the prod host (`docker network create agent-audit-network`) and added to `APPROVED_NETWORKS` in `scripts/check-resource-naming.mjs` (naming gate). The consumer app stacks add `agent-audit-network` to their `networks:` and join it.
**Alternatives considered**: (a) audit on `backend-network` like dev — rejected (violates FR-001). (b) a dedicated `observability-network` too — rejected (no isolation requirement; extra pre-create + allowlist churn).

## R3 — Audit-user provisioning: one-shot init service

**Decision**: Add an `agent-audit-init` one-shot service to `opensearch/compose.prod.yaml` — `image: curlimages/curl` (or a small shell image), `depends_on: agent-audit-opensearch: condition: service_healthy`, running the existing `init-audit-user.sh` logic against `https://agent-audit-opensearch:9200`, then exits. It reads `OPENSEARCH_INITIAL_ADMIN_PASSWORD` + `OPENSEARCH_AUDIT_WRITER_PASSWORD` from env and is idempotent (PUT upsert), skipping cleanly when unset.
**Rationale**: Clarified answer A — self-provisioning + reproducible on a fresh deploy, no manual operator step (SC-010: stack deployable independently). The script is already idempotent and env-sourced (no hardcoded secret), so promotion is packaging it as a container step.
**Detail**: The container mounts/inlines the script and points `OPENSEARCH_URL=https://agent-audit-opensearch:9200`; TLS is self-signed so `curl -sk`. The default `OPENSEARCH_ADMIN_USER=admin`. Passwords come from Komodo Variables.
**Alternatives considered**: Operator step (B) — rejected (not reproducible, human-in-the-loop). Baked custom image (C) — rejected (a build step for upstream-only stacks; defeats R1).

## R4 — OPA policy delivery: mounted read-only from the ResourceSync checkout

**Decision**: `prod opa-service` mounts `../../opa/policies:/policies:ro` (relative to the observability run-directory), same as dev, with `--watch`.
**Rationale**: Komodo clones the repo (`linked_repo="mcm-repo"`) and runs compose from `run_directory`; the `infrastructure-as-code/opa/policies` path resolves under that checkout. No baking, no image build (keeps R1). Policy edits ship via git → ResourceSync redeploy.
**Verification**: Confirm the relative `../../opa/policies` resolves from `run_directory=infrastructure-as-code/docker/observability` under Komodo's clone root (it does — same relative depth as dev).
**Alternatives considered**: Baking policies into a custom OPA image — rejected (build step; slower policy iteration).

## R5 — Always-on with explicit memory caps

**Decision**: Deploy observability + audit always-on. Set hard caps:
- OpenSearch: `OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g` (as dev), `bootstrap.memory_lock=true` + `memlock` ulimit.
- ClickHouse: cap via `MAX_SERVER_MEMORY_USAGE`/`--max_server_memory_usage` (or a `<max_server_memory_usage_to_ram_ratio>` setting) to bound the biggest RAM consumer.
- LangFuse web/worker + Postgres/Redis/MinIO + otel-lgtm + Unleash(+pg): rely on modest defaults; optionally add compose `mem_limit` guards.
**Rationale**: Clarified answer A — continuous capture is the value; caps keep the footprint bounded on the shared 64 GB host. A capacity check precedes enabling the heavy stack (edge case: capacity exhaustion); opt-in is the fallback only if the check fails.
**Alternatives considered**: Opt-in/scheduled observability — rejected as default (retro-investigation needs traces that were already being collected).

## R6 — Vault dormant prod shape

**Decision**: `vault/compose.prod.yaml` runs `hashicorp/vault:1.18` with `command: ["server", "-config=/vault/config/vault.hcl"]` (NOT `-dev`), `cap_add: IPC_LOCK`, external volume `vault-store-data` → integrated **raft** storage, no published port, on `backend-network` (auth stack). The HCL sets `listener "tcp"` (address `0.0.0.0:8200`, `tls_disable = 1` for now — internal-only, edge/mesh TLS is a later adoption concern), `storage "raft"` (`path=/vault/data`, `node_id`), `api_addr`, `cluster_addr`, `ui = false`. Deploy **uninitialized + sealed** — do NOT run `vault operator init`.
**Healthcheck**: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8200/v1/sys/health?uninitcode=200&sealedcode=200&standbycode=200` expecting 200 — so Komodo sees healthy while dormant. Default codes (501 uninit / 503 sealed) resume meaning once initialized+unsealed.
**Rationale**: The dormant Vault must persist (raft volume) and report healthy without being initialized (same "self-init tolerated" trap as mc-service Mongo). `-dev` is ephemeral + fixed root token + no TLS ⇒ useless "when needed" and a committed-secret risk.
**Komodo Variables**: none while dormant (no root token in env — this is real Vault). Adoption later adds only what unseal/injection needs.
**Alternatives considered**: dev-mode Vault in prod — rejected (insecure theater, data loss on restart). `raft` vs `file`/`consul` storage — raft chosen (integrated, no extra service, HA-ready).

## R7 — Consumer wiring is env-only, phased, no code change

**Decision**: The gateway/BFF integrations are already env-gated. Enable by adding to `prod-mcm-bff` + `prod-movie-assistant` `stacks.toml` `environment` (sourced from new Komodo Variables) and the matching `${VAR}` refs in their `compose.prod.yaml`:
- Audit: `OPENSEARCH_URL=https://agent-audit-opensearch:9200`, `OPENSEARCH_USERNAME=agent-audit`, `OPENSEARCH_PASSWORD`.
- LangFuse: `LANGFUSE_HOST=http://langfuse-web:3000`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`.
- OTel: `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318`.
- OPA: `OPA_URL=http://opa-service:8181`.
- Unleash: `UNLEASH_URL=http://unleash-service:4242/api`, `UNLEASH_API_TOKEN`.
**Rationale**: Confirmed against source — `observability.py` gates on `LANGFUSE_PUBLIC_KEY`+`LANGFUSE_SECRET_KEY` / `OTEL_EXPORTER_OTLP_ENDPOINT`; `tools/opa.py` on `OPA_URL` (fail-closed when set); `flags.py`/`kill_switch.py` on `UNLEASH_URL`; `audit_sink.py` on `OPENSEARCH_URL`. Unset ⇒ no-op (FR-009/SC-008). Phased: deploy support stacks first (unused), then add consumer env (behavior turns on).
**Note (LangFuse port)**: containers talk to `langfuse-web:3000` (internal), not the dev host mapping `:3030`.
**Note (Unleash client token)**: `UNLEASH_API_TOKEN` on the consumer must be the **client** token (`UNLEASH_CLIENT_TOKEN`), not the admin token.

## R8 — Secrets provisioning (dev unchanged; prod via Komodo)

**Decision**: Dev flow (`gen-dev-secrets.mjs` → `stacks/*.env`) is untouched. Prod real values are seeded as **masked Komodo Variables** and interpolated `[[NAME]]` in `stacks.toml`; Komodo writes them into the gitignored `.env.prod` per stack. Committed compose carries only `${VAR:?}`.
**New Komodo Variables** (see contracts/komodo-variables.md): the LangFuse set (`LANGFUSE_SALT`, `LANGFUSE_ENCRYPTION_KEY`, `LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`, `LANGFUSE_INIT_USER_PASSWORD`, `LANGFUSE_PG_PASSWORD`, `LANGFUSE_CLICKHOUSE_PASSWORD`, `LANGFUSE_REDIS_PASSWORD`, `LANGFUSE_MINIO_ROOT_PASSWORD`), Unleash (`UNLEASH_PG_PASSWORD`, `UNLEASH_ADMIN_TOKEN`, `UNLEASH_CLIENT_TOKEN`), audit (`OPENSEARCH_INITIAL_ADMIN_PASSWORD`, `OPENSEARCH_AUDIT_WRITER_PASSWORD`), and the consumer refs on the app stacks (`OPENSEARCH_AUDIT_WRITER_PASSWORD`, `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`/`_SECRET_KEY`, `UNLEASH_CLIENT_TOKEN`). The LangFuse init public/secret keys are the SAME values the gateway consumes (so the deterministic bootstrap keeps its pinned keys valid).
**Rationale**: Matches the 021/022 externalization model and the `prod-auth` precedent. Guardrails `secret-scan` + `check-no-inline-secrets` enforce it.

## R10 — Operator access to the LangFuse & Grafana UIs (tailnet-bound, not public)

**Decision**: Publish **only** `langfuse-web` (`${TS_ADMIN_IP}:3030:3000`) and `otel-lgtm`/Grafana (`${TS_ADMIN_IP}:3002:3000`) on the prod host's **tailnet admin IP**. Every other observability/audit/vault service stays fully unpublished. Set LangFuse `NEXTAUTH_URL=http://${TAILNET_HOST}:3030` so its web login works over the tailnet.
**Rationale**: SC-002 ("viewable by an operator") and SC-003 ("visible in the telemetry backend") require a human-reachable UI, but the support stacks are otherwise internal-only. The live `prod-auth` already solves this exact problem for the Keycloak admin console by binding it to the tailnet IP (`KC_ADMIN_BIND_IP=[[TS_ADMIN_IP]]`, `:8099`) — reuse that pattern. The tailnet is private (no public exposure), and both `TS_ADMIN_IP` and `TAILNET_HOST` already exist as Komodo Variables (from prod-auth), so no new secret/topology literal enters git.
**Consequence**: `prod-observability` `stacks.toml` `environment` gains `TS_ADMIN_IP=[[TS_ADMIN_IP]]` and `TAILNET_HOST=[[TAILNET_HOST]]`; the two port maps use `${TS_ADMIN_IP}`; `NEXTAUTH_URL` uses `${TAILNET_HOST}`. These are the only published ports in the whole feature.
**Alternatives considered**: (a) fully unpublished + ad-hoc SSH/`docker` port-forward per view — rejected (SC-002/003 become manual/unrepeatable). (b) public port behind the Cloudflare tunnel — rejected (unnecessary public exposure of an internal admin UI). (c) loopback-only like dev — rejected (operator connects over the tailnet, not from on-box).

## R9 — Guardrails impact

**Decision**: The only gate change is adding `'agent-audit-network'` to `APPROVED_NETWORKS` in `scripts/check-resource-naming.mjs`. All service/container/volume identifiers already match the allowlist regexes (`observability-*-data`, `observability-*-logs`, `agent-audit`, `opa`, `unleash`, `vault`). No pattern weakening. Committed compose + TOML must pass `secret-scan`, `check-no-inline-secrets`, topology-scrub.
**Rationale**: Verified against the current gate source. Adding one approved network name is a data change, not a pattern relaxation.
