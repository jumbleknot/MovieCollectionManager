# PRD — Production Observability, Audit & Vault Stacks

**Status:** Proposed (candidate feature **024-observability-audit-vault-prod**)
**Created:** 2026-07-03
**Depends on:** 023 (Forgejo CI/CD + Komodo ResourceSync — LIVE), 012 (Control Tower services — built, env-gated)
**Related:** `docs/proposals/prod-hardening/PRD-Data-Auth-and-Vault.md` (Vault-as-secrets-backbone decision)

---

## 1. Goal & context

The four application prod stacks (`prod-auth`, `prod-mc-service`, `prod-mcm-bff`, `prod-movie-assistant`) are live, deployed as **config-as-code via Komodo ResourceSync** from `infrastructure-as-code/komodo/stacks.toml`. This PRD promotes the **Control Tower** services — built in feature 012 as env-gated, no-op-by-default integrations — to production as new ResourceSync stacks so prod gains:

- **LLM observability** — LangFuse v3 (per-turn cost/latency traces)
- **Infra telemetry** — otel-lgtm (OTLP → Tempo/Prometheus/Loki/Grafana)
- **Policy** — OPA (`opa-service`, token-exchange + UI-action authz)
- **Feature flags** — Unleash (`unleash-service`, agent kill-switch / escalation / degrade)
- **Append-only audit** — OpenSearch (`agent-audit-opensearch`, write-only agent-audit sink)
- **(Decision-gated) secrets** — Vault (`vault-service`)

Target stacks (per the user's framing):

| New/updated stack | Services |
|---|---|
| **prod-observability** (new) | langfuse-{web,worker,postgres,clickhouse,redis,minio,minio-init} + otel-lgtm + opa-service + unleash-{service,postgres,seed} |
| **prod-audit** (new) | agent-audit-opensearch |
| **prod-auth** (update) + Vault | add `vault-service` — **DECIDED v1: prod-grade, deployed dormant (§4c)** |

## 2. Why this is materially easier now (the hypothesis — confirmed)

Three things already in place make this mostly *assembly*, not net-new engineering:

1. **All services already exist as dev compose** — `infrastructure-as-code/docker/{observability,opensearch,vault}/compose.yaml` (feature 012 Phase 8 / feature 020 stack split). Promotion = author a `compose.prod.yaml` mirroring the established prod conventions.
2. **Every image is UPSTREAM** (`langfuse/langfuse:3`, `grafana/otel-lgtm`, `openpolicyagent/opa`, `unleashorg/unleash-server`, `opensearchproject/opensearch:2`, `hashicorp/vault`, clickhouse/minio/postgres/redis). So these stacks **skip the entire CI pipeline** — no `nx build`, no Trivy, no digest-by-git promote, **no `.env.deploy`**. They deploy purely from committed compose + Komodo Variables, exactly like `prod-auth`/Keycloak.
3. **The agent/BFF integration is already built and env-gated** (`agents/movie-assistant/src/{observability,flags,kill_switch,audit_sink}.py`, `src/tools/opa.py`; BFF `audit-sink.ts`). Enabling in prod = **set env vars**; **zero application code changes**. Unset → graceful no-op (SC-005 additive contract).

**Net work** = author 2 new `compose.prod.yaml` + `stacks.toml` blocks + seed Komodo Variables + add the consuming env vars to the app stacks. No new workflows, no code.

## 3. The established pattern to mirror (from the 4 live stacks)

- **Images:** upstream pinned versions (no `${…_DIGEST}` substitution — that's CI-built-only).
- **Secrets:** fail-fast `${VAR:?set in .env.prod}`; real values are **Komodo Variables** interpolated as `[[NAME]]` in `stacks.toml`, written by Komodo into the gitignored `.env.prod`. **No inline literals, no `.env.deploy`** for upstream stacks.
- **Networks/volumes:** external, pre-created on the prod host (`docker network create` / `docker volume create`); no published ports (internal-only; network scoping is the boundary).
- **Healthchecks + `depends_on: condition: service_healthy`**, `restart: unless-stopped`, `container_name: <role>`, json-file logging (10m×10).
- **`stacks.toml` block:** `name`, `deploy=true`, `after=[…]`, `[stack.config]` with `server="Local"`, `linked_repo="mcm-repo"`, `branch="main"`, `run_directory`, `file_paths=["compose.prod.yaml"]`, `env_file_path=".env.prod"`, `environment` (Komodo `[[VAR]]` tokens only).
- **Deploy:** ResourceSync reconciles + redeploys in `after` order; guardrails topology-scrub + secret-scan gate the committed compose/TOML.

## 4. Per-stack plan

### 4a. prod-audit (recommend FIRST — simplest, high value)
- **`infrastructure-as-code/docker/opensearch/compose.prod.yaml`**: single-node `agent-audit-opensearch`, external volume `agent-audit-opensearch-data`, **heap cap `-Xms1g -Xmx1g`** (the dev box already OOMs at the 4 GB default — capacity-critical), `bootstrap.memory_lock=true` + `memlock` ulimit, TLS as in dev (self-signed, `-k` in healthcheck), no published port.
- **Secrets → Komodo Variables:** `OPENSEARCH_INITIAL_ADMIN_PASSWORD`.
- **Runtime provisioning:** the write-only `agent-audit` user (index/bulk only, no read/search/delete) is created at runtime (`opensearch/init-audit-user.sh` — already reads its password from env, skips cleanly if unset). Decide: run as a one-shot init service or an operator step.
- **Network:** dedicated `agent-audit-network` (only the gateway + BFF reach it) — matches the mc-service/BFF isolation pattern.
- **Consumers get:** `OPENSEARCH_URL=https://agent-audit-opensearch:9200`, `OPENSEARCH_USERNAME=agent-audit`, `OPENSEARCH_PASSWORD` on prod-mcm-bff + prod-movie-assistant.

### 4b. prod-observability (biggest — capacity check REQUIRED first)
- **`infrastructure-as-code/docker/observability/compose.prod.yaml`**: promote the ~11 dev services. Persistent external volumes for langfuse-postgres/clickhouse/minio, unleash-postgres, otel-lgtm; `${VAR:?}` for every secret; keep the deterministic LangFuse bootstrap (`LANGFUSE_INIT_*`) so the gateway's pinned public/secret keys stay valid; OPA policies mounted from the **cloned repo** path (`infrastructure-as-code/opa/policies`) resolved under the ResourceSync checkout.
- **⚠️ Resource footprint is the gating risk:** LangFuse (web+worker+**ClickHouse**+postgres+redis+minio) + otel-lgtm + Unleash(+pg) is heavy. Combined with prod-audit's OpenSearch, this is several GB of JVM/analytics RAM on the Beelink (64 GB, but already running auth+app+agents). **Capacity-plan before enabling** (set ClickHouse/heap caps; consider deploying observability opt-in / on a schedule).
- **Secrets → Komodo Variables (~10 new):** `LANGFUSE_SALT`, `LANGFUSE_ENCRYPTION_KEY`, `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`, `LANGFUSE_INIT_USER_PASSWORD`, `LANGFUSE_PG_PASSWORD`, `CLICKHOUSE_PASSWORD`, `LANGFUSE_REDIS_AUTH`, `LANGFUSE_MINIO_ROOT_PASSWORD`, `UNLEASH_ADMIN_TOKEN`, `UNLEASH_CLIENT_TOKEN`, `UNLEASH_PG_PASSWORD`.
- **Consumers get:** `LANGFUSE_HOST=http://langfuse-web:3000` + `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318`, `OPA_URL=http://opa-service:8181`, `UNLEASH_URL=http://unleash-service:4242/api` + `UNLEASH_API_TOKEN` on prod-mcm-bff + prod-movie-assistant.
- **Network:** the gateway/BFF must reach these — put the stack on `backend-network` (shared) or a dedicated `observability-network` that the app stacks also join.

### 4c. prod-auth + Vault (DECIDED v1 — deploy prod-grade, dormant-until-needed)

**Decision (user, 2026-07-03):** ship Vault in v1 — put it in the environment now so it's present and
ready the day it's adopted, even though nothing consumes it yet. **Not dev-mode** (`server -dev` is
in-memory + a fixed root token + no TLS — it loses all data on every restart, so it is useless "when
needed"). Instead a production-shaped Vault that sits **dormant** until first use:

- **`infrastructure-as-code/docker/vault/compose.prod.yaml`**: `hashicorp/vault:<pin>`, a real config
  file (HCL: `listener "tcp"`, `storage "raft"`, `api_addr`, `cluster_addr`) instead of `-dev`,
  **persistent integrated `raft` storage** → external volume `vault-store-data`, `cap_add: IPC_LOCK`,
  no published port (internal-only on the auth network).
- **Dormant-until-init lifecycle:** deploy it **uninitialized + sealed**; do NOT run `vault operator
  init` until adoption. Nothing reads from it, so there is no unseal-on-restart tax yet — it just idles.
- **Healthcheck must tolerate uninit/sealed** or Komodo flags the stack unhealthy (same trap as the
  mc-service self-init Mongo). Use Vault's health endpoint with override codes —
  `/v1/sys/health?uninitcode=200&sealedcode=200&standbycode=200` — so the container reports healthy
  while dormant; the default codes apply once you init + unseal.
- **Placement:** co-located in **prod-auth** (per the ask + the dev layout — feature 020 relocated
  Vault from observability into the auth/identity stack). Splittable into a standalone `prod-vault`
  stack later if its lifecycle diverges (adoption, auto-unseal).
- **Komodo Variables:** none while dormant (no root token in env — this is real Vault, not `-dev`).
  Adoption later adds only what the unseal/injection model needs.

**Deploying the stack ≠ adopting Vault as the secrets backbone.** Migrating Komodo Variables → Vault,
auto-unseal, and deploy-time secret injection remain the separate `PRD-Data-Auth-and-Vault.md`
Workstream B (B-opt-2) decision. This step just puts a real, persistent Vault in prod — healthy and
ready to `vault operator init` the day it's wanted.

## 5. Wiring the app stacks (the one coupling)

To *use* the new services, `prod-mcm-bff` and `prod-movie-assistant` `stacks.toml` `environment` blocks (and their `compose.prod.yaml` `${VAR}` refs) gain the consumer env vars above, sourced from new Komodo Variables. Because the integration is env-gated no-op, this is cleanly **phased**:

1. Deploy the new stacks (unused — nothing points at them yet).
2. Add the Komodo Variables + the consumer env to the app stacks; re-sync → the gateway/BFF start emitting to LangFuse/OTel, calling OPA, reading Unleash, writing audit.

Internal DNS is container-name based (`langfuse-web`, `otel-lgtm`, `opa-service`, `unleash-service`, `agent-audit-opensearch`) over the shared network — no host/domain literals.

## 6. Open decisions (resolve before implementation)

1. **🔑 Vault prod model — RESOLVED (user, 2026-07-03): Vault is IN v1, deployed dormant.** Ship a
   prod-grade Vault (persistent `raft` storage, uninitialized/sealed, health-endpoint override so it's
   green in Komodo) into prod now, ready to `vault operator init` when adopted — **not** the dev-mode
   `-dev` server (ephemeral/insecure = useless later). See §4c. This does **not** commit to the
   secrets-backbone migration (Komodo Variables → Vault, auto-unseal, deploy-time injection) — that
   stays the separate `PRD-Data-Auth-and-Vault.md` Workstream B (B-opt-2) decision. Deploying the stack
   ≠ adopting the backbone.
2. **Capacity.** Does the prod host have headroom for LangFuse+ClickHouse+OpenSearch alongside the running app? Set explicit memory caps; decide always-on vs opt-in.
3. **Audit-user provisioning** — one-shot init service (Komodo-managed) vs operator step.
4. **OPA policy delivery** — mounted from the repo checkout vs baked; confirm the path resolves under Komodo's ResourceSync clone.
5. **Networks** — one shared `observability`/`audit` network vs reuse `backend-network`.

## 7. Non-goals / what we're NOT doing

- No CI pipeline changes (upstream images — no build/scan/digest).
- No gateway/BFF code changes (integration exists, env-gated).
- No Mongo SCRAM auth (that's `PRD-Data-Auth-and-Vault.md` Workstream A).
- No prod Vault-as-secrets-backbone **adoption** — v1 deploys the *dormant* Vault stack (§4c) but does
  NOT `vault operator init` it, migrate Komodo Variables → Vault, or wire auto-unseal/injection
  (deferred; `PRD-Data-Auth-and-Vault.md` B-opt-2).

## 8. Proposed phased rollout

- **Phase 1 — prod-audit** (OpenSearch): simplest, immediate value (tamper-evident agent audit trail). One stack, one secret, one consumer wiring.
- **Phase 2 — prod-observability** (LangFuse + otel-lgtm + OPA + Unleash): after a capacity check; the largest stack.
- **Phase 3 — Vault**: deploy the **dormant** prod-grade Vault (persistent `raft`, uninitialized/sealed,
  health-override) into prod-auth so it's present and ready. `vault operator init` + secrets-backbone
  adoption is a later, separate effort (`PRD-Data-Auth-and-Vault.md` B-opt-2).

## 9. SDD framing

Land as feature **`024-observability-audit-vault-prod`**. This PRD → `/speckit-specify` → `spec.md` / `plan.md` / `tasks.md`. Success criteria candidates: each stack green in Komodo; gateway emits ≥1 LangFuse trace + ≥1 OTel span in prod; an OPA deny is enforced; a flipped Unleash flag takes effect; an audit event lands in OpenSearch; all with **zero committed secrets/topology** (guardrails green).
