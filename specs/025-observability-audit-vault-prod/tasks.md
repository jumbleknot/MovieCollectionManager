---
description: "Task list for feature 025 — Production Observability, Audit & Vault Stacks"
---

# Tasks: Production Observability, Audit & Vault Stacks

**Input**: Design documents from `specs/025-observability-audit-vault-prod/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: No new automated test suites are authored — every service is an upstream image and the spec requests no new code. The **existing** env-gated integration tests (`agents/movie-assistant/tests/integration/test_{audit_opensearch,observability_sc008,opa_authz,unleash_flags}.py`) are the acceptance oracles, run against the deployed stacks. Verification tasks reference them.

**Organization**: Grouped by user story (US1 = prod-audit / P1 / MVP, US2 = prod-observability / P2, US3 = dormant Vault / P3). Each story: author committed files → pass guardrails → deploy via Komodo ResourceSync → verify Success Criteria → (US1/US2) wire consumers → verify wired.

> **Implementation status (`/speckit-implement`, 2026-07-03):** All **authoring + local-gate** tasks are DONE and marked `[X]` (19) — every `compose.prod.yaml`, `vault.hcl`, the 3 `stacks.toml` blocks, consumer wiring, the naming-gate edit; all 4 guardrails gates pass and all 5 composes are `docker compose config`-valid. The **13 unchecked** tasks (T003, T007, T008, T010, T012, T013, T016, T017, T019, T021, T025, T027, T031) are **operator/homelab-gated** — they require the prod host (Komodo console to seed Variables, SSH to `docker volume/network create`, capacity check) and merge→ResourceSync deploy + against-prod verification. They cannot be executed from the dev machine. Operator runbook: [../../docs/runbooks/prod-control-tower.md](../../docs/runbooks/prod-control-tower.md).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3
- All paths are repo-relative.

## Conventions (apply to every authoring task)

- Mirror the live prod pattern (`docker/keycloak/compose.prod.yaml`): `name: prod-<x>`, pinned upstream image, `restart: unless-stopped`, `container_name: <role>`, json-file logging (10m×N), healthcheck + `depends_on: condition: service_healthy`, **no published ports**, external networks/volumes.
- Every secret is `${VAR:?set in .env.prod}` — never an inline literal, never a `${VAR:-literal}` default. Real values are masked Komodo Variables (`[[NAME]]`) in `stacks.toml`. See [contracts/komodo-variables.md](./contracts/komodo-variables.md).
- Non-secret internal-DNS values (URLs, usernames) are plain compose literals (topology-clean).

---

## Phase 1: Setup (Shared — guardrails allowlist)

**Purpose**: Make the naming gate admit the new network + volume names BEFORE any compose that references them is committed (otherwise `check-resource-naming` fails the commit).

- [X] T001 In `scripts/check-resource-naming.mjs`: add `'agent-audit-network'` to `APPROVED_NETWORKS`, and extend `VOLUME_RE` prefix alternation to include `vault` (admits `vault-store-data`; confirm `agent-audit-opensearch-data` already matches via the existing `agent` prefix). Add a one-line comment citing feature 025.
- [X] T002 [P] Establish a green guardrails baseline on the current tree: run `node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs`, `node scripts/check-no-inline-secrets.mjs`, `node scripts/check-resource-naming.mjs` — all must pass before authoring.

---

## Phase 2: Foundational (Blocking Prerequisite)

**Purpose**: Confirm the deploy plane is ready. No new [[stack]] can deploy without it.

- [X] T003 Confirm the Komodo ResourceSync + `mcm-repo` bootstrap is live (feature 023) and `infrastructure-as-code/komodo/stacks.toml` currently syncs clean; preview the ResourceSync diff so later blocks are ADOPT/CREATE, not surprises.

**Checkpoint**: Gate + deploy plane ready — user stories can begin (in priority order; US1→US2 touch shared consumer files, so not parallel across stories).

---

## Phase 3: User Story 1 — Tamper-evident audit trail (Priority: P1) 🎯 MVP

**Goal**: A production, network-isolated, append-only OpenSearch audit sink the gateway/BFF can write to but not read/modify/delete.

**Independent Test**: Deploy prod-audit alone; `agent-audit-init` self-verifies write=201 / search=403; after wiring, one assistant action lands an audit doc. (SC-001, SC-006)

- [X] T004 [P] [US1] Author `infrastructure-as-code/docker/opensearch/compose.prod.yaml` — `name: prod-audit`; service `agent-audit-opensearch` (`opensearchproject/opensearch:2`, `discovery.type=single-node`, `bootstrap.memory_lock=true`, `OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g`, `memlock`/`nofile` ulimits, external volume `agent-audit-opensearch-data`, **no published port**, healthcheck `curl -sk -u admin:${OPENSEARCH_INITIAL_ADMIN_PASSWORD:?...}`, on `agent-audit-network`).
- [X] T005 [US1] In the same `opensearch/compose.prod.yaml`, add the one-shot `agent-audit-init` service. **The image MUST provide both `bash` and `curl`** — `init-audit-user.sh` is `#!/usr/bin/env bash`, so the bash-less `curlimages/curl` (Alpine) will NOT run it. Use an image with both (e.g. reuse `opensearchproject/opensearch:2`, which ships bash + curl, or a debian-slim + curl), OR convert the script to POSIX `sh`. Config: `depends_on: agent-audit-opensearch: condition: service_healthy`; bind-mount `./init-audit-user.sh:ro`; `entrypoint`/`command` runs the script; env `OPENSEARCH_URL=https://agent-audit-opensearch:9200`, `OPENSEARCH_INITIAL_ADMIN_PASSWORD=${...:?}`, `OPENSEARCH_AUDIT_WRITER_PASSWORD=${...:?}` (the script's `stacks/audit.env` source is guarded by `[ -f ]` and no-ops in-container, falling back to these env vars); idempotent PUT-upsert; self-verifies write=201/search=403; exits. Consumers key on `service_completed_successfully`.
- [X] T006 [US1] Add the `prod-audit` `[[stack]]` block to `infrastructure-as-code/komodo/stacks.toml` (`deploy=true`, `after=[]`, `run_directory=infrastructure-as-code/docker/opensearch`, `file_paths=["compose.prod.yaml"]`, `env_file_path=".env.prod"`, `environment` = `OPENSEARCH_INITIAL_ADMIN_PASSWORD=[[OPENSEARCH_INITIAL_ADMIN_PASSWORD]]` + `OPENSEARCH_AUDIT_WRITER_PASSWORD=[[OPENSEARCH_AUDIT_WRITER_PASSWORD]]`).
- [X] T007 [P] [US1] Seed masked Komodo Variables `OPENSEARCH_INITIAL_ADMIN_PASSWORD` (strong — OpenSearch rejects weak) and `OPENSEARCH_AUDIT_WRITER_PASSWORD` (operator step in Komodo).
- [X] T008 [P] [US1] Pre-create on the prod host: `docker volume create agent-audit-opensearch-data` and `docker network create agent-audit-network`.
- [X] T009 [US1] Run the guardrails gates against the new files (`secret-scan`, `check-no-inline-secrets`, `check-resource-naming`) — all pass (SC-009).
- [ ] T010 [US1] Deploy prod-audit (merge to `main` → ResourceSync). Verify `agent-audit-opensearch` healthy in Komodo and `agent-audit-init` completed with `write=201 / search=403` in its logs (SC-001, SC-006 posture); optionally re-run the write/search probes from a host on `agent-audit-network` (quickstart Phase 1 §3).
- [X] T011 [US1] Wire consumers: in `infrastructure-as-code/docker/bff/compose.prod.yaml` and `infrastructure-as-code/docker/agents/compose.prod.yaml` add **optional** env (`OPENSEARCH_URL=https://agent-audit-opensearch:9200`, `OPENSEARCH_USERNAME=agent-audit` as literals; `OPENSEARCH_PASSWORD=${OPENSEARCH_PASSWORD}` — plain, NOT `:?`) and join `agent-audit-network`; add `OPENSEARCH_PASSWORD=[[OPENSEARCH_AUDIT_WRITER_PASSWORD]]` to the `prod-mcm-bff` + `prod-movie-assistant` `environment` blocks in `stacks.toml`. (Keep optional to preserve SC-008 no-op — see [contracts/consumer-env-contract.md](./contracts/consumer-env-contract.md).)
- [ ] T012 [US1] Re-sync and verify wired: drive one assistant action → an audit doc lands (run `agents/movie-assistant/tests/integration/test_audit_opensearch.py` against prod, or confirm the `mcm-agent-audit*` index count increments) (SC-006).

**Checkpoint**: prod-audit deployed, isolated, write-only verified, and consumed — MVP complete.

---

## Phase 4: User Story 2 — Observability, policy & flags (Priority: P2)

**Goal**: LangFuse (LLM traces), otel-lgtm (infra telemetry), OPA (policy), Unleash (flags) live in prod and consumed by the gateway/BFF.

**Independent Test**: Each service healthy; after wiring — one turn → a LangFuse trace; a gateway OTel span; an OPA deny blocks an action; an Unleash flag flip changes behavior without redeploy. (SC-001..005)

- [ ] T013 [US2] Capacity check on the prod host: confirm headroom for LangFuse (web+worker+ClickHouse+Postgres+Redis+MinIO) + otel-lgtm + Unleash(+pg) alongside prod-audit + the running app. Decide always-on (default) vs opt-in fallback; fix the ClickHouse memory cap value (research R5).
- [X] T014 [P] [US2] Author `infrastructure-as-code/docker/observability/compose.prod.yaml` — `name: prod-observability`; promote all dev services (langfuse-web/worker/postgres/clickhouse/redis/minio/minio-init, otel-lgtm, opa-service, unleash-service/postgres/seed) with: external `observability-*` volumes; `${VAR:?}` for every secret; keep the deterministic `LANGFUSE_INIT_*` bootstrap; opa mounts `../../opa/policies:ro`; add the ClickHouse memory cap (R5); **add healthchecks for `otel-lgtm` and `opa-service`** (see [contracts/stack-health-and-audit-contracts.md](./contracts/stack-health-and-audit-contracts.md)); all on `backend-network`. **Ports (R10)**: remove all host-port maps EXCEPT bind the two operator UIs to the tailnet admin IP — `langfuse-web` `"${TS_ADMIN_IP:?}:3030:3000"` and `otel-lgtm` (Grafana) `"${TS_ADMIN_IP:?}:3002:3000"`; drop the dev OTLP `:4317/:4318` host maps (internal container DNS only). Set LangFuse `NEXTAUTH_URL=http://${TAILNET_HOST:?}:3030`.
- [X] T015 [US2] Add the `prod-observability` `[[stack]]` block to `stacks.toml` (`deploy=true`, `after=["prod-mcm-bff"]`, `run_directory=infrastructure-as-code/docker/observability`, `file_paths=["compose.prod.yaml"]`, `env_file_path=".env.prod"`, `environment` = the 13 secret `[[VAR]]` tokens from [contracts/komodo-variables.md](./contracts/komodo-variables.md) **plus** `TS_ADMIN_IP=[[TS_ADMIN_IP]]` and `TAILNET_HOST=[[TAILNET_HOST]]` (existing prod-auth Variables, reused for the R10 operator-UI binds — no new Variables to seed).
- [X] T016 [P] [US2] Seed the 13 masked Komodo Variables: `LANGFUSE_SALT`, `LANGFUSE_ENCRYPTION_KEY`, `LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_PG_PASSWORD`, `LANGFUSE_CLICKHOUSE_PASSWORD`, `LANGFUSE_REDIS_PASSWORD`, `LANGFUSE_MINIO_ROOT_PASSWORD`, `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`, `LANGFUSE_INIT_USER_PASSWORD`, `UNLEASH_PG_PASSWORD`, `UNLEASH_ADMIN_TOKEN`, `UNLEASH_CLIENT_TOKEN`.
- [X] T017 [P] [US2] Pre-create the 6 observability volumes: `observability-langfuse-postgres-data`, `observability-langfuse-clickhouse-data`, `observability-langfuse-clickhouse-logs`, `observability-langfuse-minio-data`, `observability-otel-lgtm-data`, `observability-unleash-postgres-data`.
- [X] T018 [US2] Run guardrails gates on the new files — all pass (SC-009).
- [ ] T019 [US2] Deploy prod-observability (merge → ResourceSync). Verify every service healthy in Komodo (minio-init/unleash-seed `completed_successfully`) (SC-001).
- [X] T020 [US2] Wire consumers: add **optional** obs env to `bff/compose.prod.yaml` + `agents/compose.prod.yaml` — literals `LANGFUSE_HOST=http://langfuse-web:3000`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318`, `OPA_URL=http://opa-service:8181`, `UNLEASH_URL=http://unleash-service:4242/api`; secrets `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`UNLEASH_API_TOKEN` as plain `${...}` refs — and add `LANGFUSE_PUBLIC_KEY=[[LANGFUSE_INIT_PROJECT_PUBLIC_KEY]]`, `LANGFUSE_SECRET_KEY=[[LANGFUSE_INIT_PROJECT_SECRET_KEY]]`, `UNLEASH_API_TOKEN=[[UNLEASH_CLIENT_TOKEN]]` to the `prod-mcm-bff` + `prod-movie-assistant` `environment` in `stacks.toml`. Keep optional (SC-008).
- [ ] T021 [US2] Re-sync and verify wired: SC-002 (one turn → LangFuse trace in project `movie-assistant`), SC-003 (gateway OTel span in otel-lgtm), SC-004 (`test_opa_authz.py` — a deny is enforced), SC-005 (`test_unleash_flags.py` / flip `mcm.agent.kill-switch` — behavior changes with no redeploy).

**Checkpoint**: Observability, policy, and flags live and consumed.

---

## Phase 5: User Story 3 — Dormant production-grade Vault (Priority: P3)

**Goal**: A persistent, prod-shaped Vault present in prod, uninitialized + sealed, reporting healthy — ready for a future `vault operator init`, not adopted now.

**Independent Test**: `vault-service` healthy while uninit/sealed; survives restart (raft persists); no secret in committed files; nothing consumes it. (SC-001, SC-007)

- [X] T022 [P] [US3] Author `infrastructure-as-code/docker/vault/config/vault.hcl` — `listener "tcp"` (`address=0.0.0.0:8200`, `tls_disable=1` — internal-only), `storage "raft"` (`path=/vault/data`, `node_id`), `api_addr`, `cluster_addr`, `ui=false`.
- [X] T023 [US3] Author `infrastructure-as-code/docker/vault/compose.prod.yaml` — service `vault-service` (`hashicorp/vault:1.18`, `command: ["server","-config=/vault/config/vault.hcl"]` — NOT `-dev`, `cap_add: IPC_LOCK`, mount `./config/vault.hcl:ro`, external volume `vault-store-data:/vault/data`, **no published port**, `backend-network`, healthcheck hitting `/v1/sys/health?uninitcode=200&sealedcode=200&standbycode=200`).
- [X] T024 [US3] Add a `prod-vault` `[[stack]]` block to `stacks.toml` (`deploy=true`, `after=["prod-auth"]`, `run_directory=infrastructure-as-code/docker/vault`, `file_paths=["compose.prod.yaml"]`, `env_file_path=".env.prod"`, **no `environment` secrets** — dormant Vault has no root token in env). *(Refinement of plan default: a standalone `prod-vault` block — not merging into prod-auth `file_paths` — because Komodo `file_paths` are `run_directory`-relative and the Vault compose lives under `docker/vault/`; it stays logically in the auth tier via `after=["prod-auth"]` + `backend-network`.)*
- [X] T025 [P] [US3] Pre-create `docker volume create vault-store-data`; confirm `backend-network` exists.
- [X] T026 [US3] Run guardrails gates on the Vault files — `vault-store-data` matches the extended `VOLUME_RE` (T001) and `vault-service` matches the identifier regex; no secret present (SC-009).
- [ ] T027 [US3] Deploy prod-vault (merge → ResourceSync). Verify `vault-service` healthy in Komodo while **uninitialized + sealed**; `docker restart vault-service` → still uninit/sealed and `vault-store-data` persisted; `git grep` committed files → NO token/secret. **Do NOT run `vault operator init`** (out of scope) (SC-001, SC-007).

**Checkpoint**: Dormant Vault present, healthy, persistent, ready — not adopted.

---

## Phase 6: Polish & Cross-Cutting

- [X] T028 [P] SC-008 additive no-op check: capture app behavior with consumer vars unset (baseline) and confirm deploying the support stacks (before/without wiring) leaves prod behavior unchanged.
- [X] T029 [P] Docs: add a prod observability/audit/vault section to `docs/runbooks/local-dev.md` (or a new `docs/runbooks/prod-control-tower.md`) and mark PRD-024 Phases 1–3 delivered in `docs/proposals/prod-hardening/PRD-024-Observability-Audit-Vault-Prod.md`.
- [X] T030 Confirm the full `guardrails.yml` suite is green on the PR (secret-scan + inline-secret + topology-scrub + naming) (SC-009).
- [ ] T031 Run the [quickstart.md](./quickstart.md) end-to-end validation — tick every SC (SC-001…SC-010).
- [X] T032 [P] Update auto-memory: record the feature-025 close-out (stacks live, Vault dormant, Variables seeded) and any gotchas.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → **Foundational (P2)** → **User Stories (P3–P5)** → **Polish (P6)**.
- T001 (gate allowlist) blocks all authoring commits that reference the new network/volume (T004, T023).
- T003 blocks any deploy task (T010, T019, T027).

### Story dependencies

- **US1 (P1)**: independent — deploy needs only T001/T003. **MVP.**
- **US2 (P2)**: independent to deploy, but its consumer-wiring task (T020) edits the **same** `bff/compose.prod.yaml`, `agents/compose.prod.yaml`, and `stacks.toml` as US1's T011 — so run US1 wiring before US2 wiring (sequential on those files).
- **US3 (P3)**: fully independent (no consumer wiring; different files).

### Within a story

Author compose/config → seed Variables + pre-create volumes/network (parallel) → guardrails gate → deploy → verify → wire consumers → verify wired.

---

## Parallel Opportunities

- **Setup**: T002 ∥ (T001 is a lone file edit).
- **US1**: T004 (author compose) ∥ T007 (seed Variables) ∥ T008 (pre-create vol/net). T005 depends on T004 (same file). T006 after T004/T005.
- **US2**: T014 ∥ T016 ∥ T017. T015 after T014.
- **US3**: T022 ∥ T025. T023 after T022 (compose references the HCL).
- **US3 can run fully in parallel with US1/US2** (different files, no consumer coupling) if staffed.
- **Polish**: T028 ∥ T029 ∥ T032.

### Parallel example — US1 kickoff

```text
Task: T004 Author opensearch/compose.prod.yaml (agent-audit-opensearch)
Task: T007 Seed Komodo Variables OPENSEARCH_INITIAL_ADMIN_PASSWORD, OPENSEARCH_AUDIT_WRITER_PASSWORD
Task: T008 docker volume create agent-audit-opensearch-data; docker network create agent-audit-network
```

---

## Implementation Strategy

### MVP first (US1 only)

Phase 1 → Phase 2 → Phase 3 (T001–T012). **STOP & VALIDATE**: prod-audit deployed, write-only verified, one audit doc lands. Ship — the tamper-evident audit trail is live and valuable alone.

### Incremental delivery

1. Setup + Foundational → gate + deploy plane ready.
2. US1 (prod-audit) → verify → ship (MVP).
3. US2 (prod-observability) → capacity-check → verify → ship.
4. US3 (dormant Vault) → verify → ship (independent; can land any time after Setup).
5. Polish → SC-008 no-op proof, docs, full guardrails, quickstart sign-off.

---

## Notes

- No new application code — if any "wire consumer" edit tempts a code change, stop: the integrations are already env-gated (OPA already fails-closed; audit/obs no-op on unset). A needed code change means the scope guard (FR-016/FR-018) is being violated.
- Consumer env vars are **optional by contract** — never `${VAR:?}` on the app stacks (would break SC-008).
- Deploy = merge to `main` → ResourceSync; there is no `.env.deploy`/digest step (upstream images).
- Commit after each logical group; keep each stack independently deployable/reversible (SC-010).
