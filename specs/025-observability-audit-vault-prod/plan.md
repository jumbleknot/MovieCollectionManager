# Implementation Plan: Production Observability, Audit & Vault Stacks

**Branch**: `025-observability-audit-vault-prod` | **Date**: 2026-07-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/025-observability-audit-vault-prod/spec.md`

## Summary

Promote the Control Tower capabilities (LLM observability, infra telemetry, policy, feature flags, append-only audit) and a dormant production-grade Vault to production as **three new Komodo ResourceSync stacks** — `prod-observability`, `prod-audit`, and a Vault addition to `prod-auth` — then switch the running `prod-mcm-bff` and `prod-movie-assistant` stacks to consume them via env vars only. Every service uses an **upstream pinned image** (no CI build/scan/digest), so the stacks deploy purely from committed `compose.prod.yaml` + Komodo Variables, exactly like the live `prod-auth` (Keycloak) stack. The application-side integrations already exist and are env-gated; enabling them in production is configuration, not code. The work is **compose authoring + `stacks.toml` blocks + Komodo Variable seeding + a guardrails-allowlist entry** — no application code changes.

## Technical Context

**Language/Version**: N/A (infrastructure-as-code). Docker Compose v2 spec YAML; HCL for the Vault config file.

**Primary Dependencies**: Upstream pinned images only — `langfuse/langfuse:3` + `langfuse/langfuse-worker:3`, `postgres:16-alpine`, `clickhouse/clickhouse-server:24.3`, `redis:7-alpine`, `minio/minio` + `minio/mc`, `grafana/otel-lgtm`, `openpolicyagent/opa`, `unleashorg/unleash-server`, `opensearchproject/opensearch:2`, `hashicorp/vault:1.18`, `curlimages/curl` (seed). Orchestration: Komodo ResourceSync (config-as-code from `infrastructure-as-code/komodo/stacks.toml`).

**Storage**: External named Docker volumes, pre-created on the prod host: LangFuse postgres/clickhouse(+logs)/minio, otel-lgtm, unleash-postgres, `agent-audit-opensearch-data`, `vault-store-data` (Vault raft).

**Testing**: No new automated test suites (upstream images). Verification is operational per `quickstart.md` + the existing env-gated integration tests (`agents/movie-assistant/tests/integration/test_{observability_sc008,audit_opensearch,unleash_flags,opa_authz}.py`) which are the acceptance oracles, run against the deployed stacks. Guardrails CI gates (`secret-scan`, `check-no-inline-secrets`, `check-resource-naming`, topology-scrub) must stay green on the committed files.

**Target Platform**: Single prod host ("Local" Komodo server, Beelink 64 GB), Linux/Docker. Internal-only networking; no published ports.

**Project Type**: Infrastructure / deployment feature (additive prod stacks). No app source structure change.

**Performance Goals**: N/A for latency. The binding constraint is **memory footprint** — explicit heap/analytics caps so the heavy stack coexists with the running app (OpenSearch `-Xms1g -Xmx1g`; ClickHouse capped; per §Constraints).

**Constraints**:
- Zero committed secrets/topology — every secret is `${VAR:?}` fail-fast; real values are Komodo Variables (`[[NAME]]`) written into gitignored `.env.prod`. No `.env.deploy` (upstream images, no digests).
- Internal-only networking, **no published ports** — with ONE carve-out: `langfuse-web` + `otel-lgtm` (Grafana) bind to the tailnet admin IP (`${TS_ADMIN_IP}`) so an operator can view traces/spans (SC-002/003), mirroring the Keycloak admin-console pattern. No public ports anywhere.
- Always-on with memory caps (clarified); opt-in only as a capacity fallback.
- Policy engine fails-closed when enabled-but-unreachable (already true in `src/tools/opa.py`).
- Vault deployed dormant: uninitialized + sealed, health endpoint overridden so Komodo reads healthy; not `-dev`.
- No application code changes; no CI pipeline changes.

**Scale/Scope**: 3 new/updated stacks; ~13 new services total; ~13 new Komodo Variables; 2 app-stack `environment` blocks extended; 1 guardrails allowlist entry.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Gate (constitution) | Assessment |
|---|---|
| **Security — Secrets Management (NON-NEGOTIABLE)** | PASS by design. No clear-text secret in git: all secrets are `${VAR:?set in .env.prod}`; real values via Komodo Variables. No `${VAR:-literal}` defaults. Enforced by `secret-scan` + `check-no-inline-secrets` gates over the committed compose/TOML. |
| **Security — topology scrub** | PASS. No host/domain/IP literals; internal DNS is container-name only (`langfuse-web`, `otel-lgtm`, `opa-service`, `unleash-service`, `agent-audit-opensearch`, `vault-service`). Topology-scrub gate scans the new files. |
| **Security — Centralized/Default-deny Access Control (NON-NEGOTIABLE)** | PASS. Policy engine (OPA) fails-closed when enabled-but-unreachable (existing code). Audit user is write-only (no read/modify/delete). Vault ships sealed. |
| **Additive / no-op contract (SC-005 lineage)** | PASS. Consumer integrations are env-gated; unset ⇒ silent no-op ⇒ prod behavior unchanged. Deploying a support stack does not by itself change app behavior (phased wiring). |
| **Resource Naming (feature 019/020)** | PASS with one required edit: identifiers already allowlisted (`observability-*` volumes, `agent-audit`/`opa`/`unleash`/`vault` container names). A new dedicated `agent-audit-network` must be added to `APPROVED_NETWORKS` in `scripts/check-resource-naming.mjs`. |
| **Spec-Driven Development** | PASS. This plan derives from spec.md + clarifications; artifacts kept in sync. |
| **Test-Driven Development (NON-NEGOTIABLE)** | N/A-with-note. No new app code ⇒ no new unit/integration code to TDD. The existing env-gated integration tests are the acceptance oracles and are run against the deployed stacks (quickstart.md); no code is "fixed inside a test." |
| **Observability (structured logging)** | PASS/advanced — this feature *adds* the production observability substrate; json-file logging (10m×N) on every new service per the established pattern. |

**Result: PASS.** One tracked, benign deviation: a guardrails allowlist entry for `agent-audit-network` (a naming-gate data change, not a principle violation) — recorded in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/025-observability-audit-vault-prod/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (networks, dormant-Vault, provisioning, caps)
├── data-model.md        # Phase 1 — stacks/services/volumes/networks/variables inventory
├── quickstart.md        # Phase 1 — deploy + verify runbook (acceptance oracles)
├── contracts/           # Phase 1 — consumer-env, Komodo variables, audit-doc & health contracts
│   ├── consumer-env-contract.md
│   ├── komodo-variables.md
│   └── stack-health-and-audit-contracts.md
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
infrastructure-as-code/
├── docker/
│   ├── opensearch/
│   │   ├── compose.yaml            # (existing dev, --profile audit)
│   │   ├── compose.prod.yaml       # NEW — prod-audit: single-node OpenSearch + one-shot init service
│   │   └── init-audit-user.sh      # (existing; reused by the prod one-shot init service)
│   ├── observability/
│   │   ├── compose.yaml            # (existing dev, --profile observability)
│   │   └── compose.prod.yaml       # NEW — prod-observability: langfuse* + otel-lgtm + opa + unleash*
│   ├── vault/
│   │   ├── compose.yaml            # (existing dev, -dev mode)
│   │   ├── compose.prod.yaml       # NEW — prod dormant Vault (raft, sealed) — run under prod-auth
│   │   └── config/vault.hcl        # NEW — prod Vault HCL (listener/storage/api_addr/cluster_addr)
│   ├── bff/compose.prod.yaml       # EDIT — add consumer env refs (${OPENSEARCH_*}, ${LANGFUSE_*}, ${OTEL_*}, ${OPA_URL}, ${UNLEASH_*}) + join agent-audit-network
│   └── agents/compose.prod.yaml    # EDIT — same consumer env refs on the gateway + join agent-audit-network
├── komodo/
│   └── stacks.toml                 # EDIT — add prod-observability + prod-audit blocks; extend prod-auth (Vault run_dir/file), prod-mcm-bff, prod-movie-assistant environment
└── opa/policies/                   # (existing; mounted read-only by prod opa-service from the ResourceSync checkout)

scripts/
└── check-resource-naming.mjs       # EDIT — add 'agent-audit-network' to APPROVED_NETWORKS
```

**Structure Decision**: Mirror the established prod convention proven by the four live stacks. Each new stack is a `compose.prod.yaml` next to its dev `compose.yaml`, referenced by a `stacks.toml` block (`deploy=true`, `after=[…]`, `env_file_path=".env.prod"`, no `additional_env_files`/`.env.deploy` since there are no digests). Vault is deployed as its **own `prod-vault` stack** (`run_directory=infrastructure-as-code/docker/vault`, `after=["prod-auth"]`) — it stays in the auth tier logically (ordered after `prod-auth`, on `backend-network`) but is a standalone block because Komodo `file_paths` are `run_directory`-relative and the Vault compose lives under `docker/vault/`, not the keycloak run-directory. (Merging it into the `prod-auth` block's `file_paths` was the initial idea but is mechanically awkward for that reason.)

**Operator access to the two admin UIs (LangFuse web, Grafana)**: SC-002/SC-003 require an operator to *view* traces/spans, but the support services are otherwise internal-only. Resolution: publish **only** `langfuse-web` and `otel-lgtm` (Grafana) on the prod host's **tailnet admin IP** — the same pattern the live `prod-auth` uses for the Keycloak admin console (`KC_ADMIN_BIND_IP=[[TS_ADMIN_IP]]`, `:8099`). Bind `${TS_ADMIN_IP}:3030:3000` (LangFuse) and `${TS_ADMIN_IP}:3002:3000` (Grafana); no public port, IP sourced from the existing `TS_ADMIN_IP` Komodo Variable (no committed literal). Every other observability/audit/vault service stays fully unpublished.

## Complexity Tracking

| Deviation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New `agent-audit-network` added to the naming-gate allowlist | FR-001 requires the audit store be reachable by **only** the gateway + BFF; the shared `backend-network` exposes it to keycloak/mc-service too. A dedicated network is the isolation boundary. | Reusing `backend-network` (as dev does) is simpler but violates FR-001's isolation requirement; credential-only isolation (write-only user) is defense-in-depth, not a substitute for network scoping of a security sink. |
| Vault deployed as a standalone `prod-vault` stack (`after=["prod-auth"]`) | Komodo `file_paths` are `run_directory`-relative and the Vault compose lives under `docker/vault/`, so it cannot be merged into the `prod-auth` block's `file_paths`; a dedicated block is the mechanically correct way to keep it in the auth tier. | Merging into `prod-auth` `file_paths` (the initial idea) fails because the file is outside the keycloak run-directory. The standalone block stays logically co-located via `after` + `backend-network`. |
| Two admin UIs (`langfuse-web`, Grafana) publish on the tailnet admin IP | SC-002/SC-003 require operator viewability; fully-internal services can't be viewed. Binding to `${TS_ADMIN_IP}` (Keycloak-admin precedent) exposes them over the tailnet only. | A public port violates the internal-only posture; leaving them unpublished makes SC-002/SC-003 unverifiable without an ad-hoc tunnel each time. IP comes from an existing Komodo Variable (no literal). |
