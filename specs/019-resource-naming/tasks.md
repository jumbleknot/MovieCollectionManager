# Tasks: Docker Resource Naming Convention & Rename

**Feature**: `019-resource-naming` | **Plan**: [plan.md](plan.md) | **Mapping**: [data-model.md](data-model.md) | **Runbook**: [../../docs/proposals/volume-network-rename-migration.md](../../docs/proposals/volume-network-rename-migration.md)

This is an infrastructure migration: tasks are config/script/doc edits plus live data-preserving migration and verification — no application source changes. The authoritative current→target mapping is [data-model.md](data-model.md); do not retype names from memory.

---

## Phase 1: Setup

- [ ] T001 Record the pre-migration baseline and save it to `specs/019-resource-naming/baseline.txt`: Keycloak `grumpyrobot` issuer (`curl http://localhost:8099/realms/grumpyrobot/.well-known/openid-configuration`), and Mongo counts (`docker exec mc-db mongosh --quiet --eval "const d=db.getSiblingDB('mc_db'); print('coll='+d.movie_collections.countDocuments({})+' mov='+d.movies.countDocuments({})')"`) plus BFF `bff_db` collection names. Used by T0XX zero-data-loss checks.
- [ ] T002 Back up the three stateful volumes to host tarballs per runbook Phase 0 (`E:/tmp/volbackup/{keycloak-db,mc-db,bff-db}.tgz`) and confirm the existing `E:/tmp/jumbleknot-realm-backup.json` realm export is present.

---

## Phase 2: Foundational (blocking prerequisite — the enforcement gate)

**Purpose**: an executable naming gate that is RED until the renames land, then guards against regression. Implements [contracts/naming-convention.md](contracts/naming-convention.md).

- [ ] T003 Create the static naming gate `scripts/check-resource-naming.mjs`: parse root `compose.yaml` + `infrastructure-as-code/docker/**/compose*.yaml` and, scoped per a `--section=volumes|networks|containers|ollama|all` flag (default `all`), assert every volume `name:` (inspected **only** inside `volumes:` blocks — never the top-level compose project `name:`), external network key, and `container_name:` matches the convention grammar in [data-model.md](data-model.md); fail on any legacy/project-prefixed (`localdev-auth_`, `mc-service_`, `mcm_`) or bare engine-only name, on any non-`mcm-bff` name carrying `mcm-`, and on any surviving `ollama`/`ollama-models` reference. Exit non-zero with the offending file + token. Sections per [contracts/naming-convention.md](contracts/naming-convention.md#phased-enforcement).
- [ ] T004 Add an Nx target / npm script `check:naming` that runs `node scripts/check-resource-naming.mjs`, and document it in [data-model.md](data-model.md) validation section. (Each `--section` is RED until its phase lands: `volumes`/`networks` after Phase 3, `ollama` after Phase 4, `containers` after Phase 6; `--section=all` GREEN only at Phase 7.)

---

## Phase 3: User Story 1 — Volume & network rename with zero data loss (Priority: P1) 🎯 MVP

**Goal**: every external volume/network follows the convention; the three stateful stores keep their data.

**Independent test**: run the migration on populated data; gate passes, issuer resolves, Mongo counts equal T001 baseline, full regression green.

### Repo edits (parallel — distinct files)

- [ ] T005 [P] [US1] In `infrastructure-as-code/docker/keycloak/compose.yaml` set the keycloak DB volume `name:` → `keycloak-store-postgres-data`.
- [ ] T006 [P] [US1] In `infrastructure-as-code/docker/mc-service/compose.yaml` set the mc-db volume `name:` → `mc-service-store-mongo-data`.
- [ ] T007 [P] [US1] In `infrastructure-as-code/docker/bff/compose.yaml` set the redis volume `name:` → `mcm-bff-cache-redis-data`, the bff-db volume `name:` → `mcm-bff-store-mongo-data`, and rename the `bff-network` key → `mcm-bff-network` updating every service reference (`mcm-bff`, `mcm-bff-dev`, `caddy`, `mcm-redis`, `mcm-bff-db`) and its mount aliases.
- [ ] T008 [P] [US1] In `infrastructure-as-code/docker/agent-db/compose.yaml` set the volume `name:` → `movie-assistant-store-postgres-data`.
- [ ] T009 [P] [US1] In `infrastructure-as-code/docker/opensearch/compose.yaml` set the volume `name:` → `agent-audit-opensearch-data`.
- [ ] T010 [P] [US1] In `infrastructure-as-code/docker/agent-gateway/compose.yaml` rename network `agent-mcp` → `movie-assistant-mcp-network` (declaration + service ref).
- [ ] T011 [P] [US1] In `infrastructure-as-code/docker/web-api-mcp/compose.yaml` rename network `agent-mcp` → `movie-assistant-mcp-network` (declaration + service ref).
- [ ] T012 [US1] In root `compose.yaml` update the first-time `docker volume create` / `docker network create` block and the profile/volume comments to the target names (drop `agent-mcp`, add `movie-assistant-mcp-network`; rename all volumes per [data-model.md](data-model.md)). *(Same file as T024 — sequence them.)*
- [ ] T013 [P] [US1] In `scripts/agent-stack.mjs` replace `ensureNetwork('agent-mcp')` and all 4 `docker run --network agent-mcp` occurrences with `movie-assistant-mcp-network`.
- [ ] T014 [P] [US1] In `.github/workflows/android-e2e.yml` update the volume-create loop (L98) and network-create loop (L97) to the target names.
- [ ] T015 [P] [US1] Update operational docs to the target names: `docs/runbooks/local-dev.md` (create commands + volume-source table), `docs/MCM-Architecture.md` (create block), `docs/agent-layer.md`, `agents/movie-assistant/README.md`.

### Live migration (sequential — runbook Phases 1–6)

- [ ] T016 [US1] Stop the full stack: `node scripts/agent-stack.mjs --down` then `docker compose --profile app --profile keycloak --profile bff-dev --profile audit down`.
- [ ] T017 [US1] Create the new volumes and `docker run … cp -a` copy the three stateful volumes (keycloak, mc-db, bff-db) per runbook Phase 2; create empty `mcm-bff-cache-redis-data`, `movie-assistant-store-postgres-data`, and (if used) `agent-audit-opensearch-data`.
- [ ] T018 [US1] `docker network create movie-assistant-mcp-network`.
- [ ] T019 [US1] Bring the stack up against the renamed volumes (`docker compose --profile keycloak --profile app --profile bff-dev up -d`; `node scripts/agent-stack.mjs`).

### Verify

- [ ] T020 [US1] Verify zero data loss + convention compliance: issuer resolves; Mongo counts equal `specs/019-resource-naming/baseline.txt`; `docker volume ls`/`network ls` show only target names; `node scripts/check-resource-naming.mjs --section=volumes` and `--section=networks` pass (those sections now GREEN; `containers`/`ollama` remain RED until Phases 6/4).
- [ ] T021 [US1] Regression: `pnpm nx run-many --target=test`; `pnpm nx test:integration mc-service`; `BFF_BASE_URL=http://localhost:8082 pnpm nx test:integration mcm-app`; `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- auth.spec.ts collections.spec.ts movies.spec.ts` — all green.
- [ ] T021a [US1] Reversibility demonstration (SC-006): with the old volumes still retained, revert the compose `name:` edits, `docker compose … up -d`, and confirm the pre-rename stack boots against the original volumes with issuer + Mongo counts unchanged; then re-apply the rename before proceeding.
- [ ] T022 [US1] Decommission old volumes + `agent-mcp` network (runbook Phase 6) only after T020–T021a pass.

**Checkpoint**: MVP complete — stack is fully convention-compliant for storage/networking with data intact.

---

## Phase 4: User Story 2 — Remove the containerized Ollama service (Priority: P2)

**Goal**: only host Ollama remains; no dead containerized-Ollama scaffolding.

**Independent test**: `docker compose config` parses; agent stack up via `scripts/agent-stack.mjs`; agent E2E green; zero `ollama`/`ollama-models` references in live config/scripts/CI/docs.

- [ ] T023 [US2] Delete `infrastructure-as-code/docker/ollama/compose.yaml`.
- [ ] T024 [US2] In root `compose.yaml` remove the `ollama/compose.yaml` `include:` entry, the `ollama` service profile assignment, and its line in the first-time-create comments.
- [ ] T025 [P] [US2] In `infrastructure-as-code/docker/agent-gateway/compose.yaml` remove the `depends_on: ollama` (and any `OLLAMA_BASE_URL=http://ollama:11434` pointing at the container; keep the host-Ollama default).
- [ ] T026 [P] [US2] Remove `ollama-models` / `ollama` service references from `docs/agent-layer.md`, `specs/012-multi-agent-mvp` is historical (leave), and any current quickstart/runbook live docs.
- [ ] T027 [US2] Verify: `docker compose config` exit 0; `node scripts/agent-stack.mjs` brings the stack up on host Ollama; `node scripts/agent-e2e.mjs assistant-add` green; `node scripts/check-resource-naming.mjs --section=ollama` passes (no `ollama` remnants).

---

## Phase 5: User Story 3 — Observability & mailpit volume naming (Priority: P3)

**Goal**: the managed observability/mailpit volumes follow the convention (uniform explicit names).

**Independent test**: bring up `--profile observability` + `--profile keycloak`; volumes carry the `observability-*` / `keycloak-mailpit-data` names.

- [ ] T028 [P] [US3] In `infrastructure-as-code/docker/observability/compose.yaml` set explicit `name:` on each managed volume per [data-model.md](data-model.md) (`observability-langfuse-postgres-data`, `-langfuse-clickhouse-data`, `-langfuse-clickhouse-logs`, `-langfuse-minio-data`, `observability-otel-lgtm-data`, `observability-unleash-postgres-data`).
- [ ] T029 [P] [US3] In `infrastructure-as-code/docker/keycloak/compose.yaml` set the mailpit volume `name:` → `keycloak-mailpit-data` (explicit, already conformant).
- [ ] T030 [US3] Verify: `docker compose --profile observability config` parses; `node scripts/check-resource-naming.mjs --section=volumes` passes (now incl. the observability/mailpit volumes).

---

## Phase 6: User Story 4 — Service/container DNS rename, coordinated cutover (Priority: P3)

**Goal**: services/containers follow `<context>-<role>` via explicit `container_name:`; all DNS references updated.

**Independent test**: an environment that updated its `.env` boots green; login + movie CRUD + an agent run all pass; a non-updated `.env` fails with a clear DNS error.

- [ ] T031 [US4] Add `container_name:` to every service across the 10 surviving compose files (incl. `movie-mcp`→`movie-assistant-mcp-movie` and `spreadsheet-mcp`→`movie-assistant-mcp-spreadsheet`) per the [data-model.md](data-model.md) service table (e.g. `mcm-redis`→`mcm-bff-cache`, `mcm-bff-db`→`mcm-bff-store`, `keycloak-service`→`keycloak`, `mc-db`→`mc-service-db`, `agent-gateway`→`movie-assistant-gateway`, `caddy`→`mcm-bff-proxy`).
- [ ] T032 [P] [US4] Update inter-service DNS references in `scripts/agent-stack.mjs` (`--name` flags + MCP URLs + `gw-proxy`) and `scripts/agent-gateway-local.ps1` to the renamed container names.
- [ ] T033 [P] [US4] Update every `**/.env*.example` in the repo (`frontend/mcm-app/.env*.example`, `backend/mc-service/.env*`, `agents/movie-assistant/.env.local.example`, `mcp-servers/**/.env.local.example`) — `KEYCLOAK_URL`, `MC_SERVICE_URL`, `REDIS_URL`, `MONGO_URL`, `AGENT_GATEWAY_URL` hostnames → renamed services.
- [ ] T034 [P] [US4] Update healthcheck hostnames and any compose `depends_on`/service refs affected by the renames across the 8 compose files.
- [ ] T035 [US4] Add a "Service rename — update your local `.env`" cutover section to `docs/runbooks/local-dev.md` mapping old→new DNS names (the gitignored `.env` step each environment must apply).
- [ ] T036 [US4] Local cutover: update this machine's gitignored `.env` files; `docker compose … up -d` + `node scripts/agent-stack.mjs`; verify full stack DNS resolves, login + movie CRUD + `node scripts/agent-e2e.mjs assistant-add` green.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T037 Wire `node scripts/check-resource-naming.mjs --section=all` into CI (a lint job or the existing workflow) so any naming drift fails the build. This is the first point all sections are expected GREEN.
- [ ] T038 Full regression after all phases: `pnpm nx run-many --target=test,lint`; `pnpm nx test:integration mc-service`; `BFF_BASE_URL=http://localhost:8082 pnpm nx test:integration mcm-app`; `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` (core specs) — all green.
- [ ] T038a Fresh-host provisioning check (SC-005): on a Docker host with the target volumes/networks absent (or a throwaway context), run the updated first-time `docker volume create`/`network create` block from root `compose.yaml` alone, bring the stack up, and confirm a green boot — no stale/legacy volume or network names required.
- [ ] T039 [P] Finalize docs: fold the proposal docs' final mapping into `docs/runbooks/local-dev.md` (or keep as reference), confirm no live doc still names a removed/renamed object, and update `docs/MCM-Architecture.md` if it diagrams volumes/networks.
- [ ] T040 Update the feature memory + CLAUDE.md local-dev section if any first-time-setup command changed.
- [ ] T040a Constitution check: confirm no mechanical sync is required — `.specify/memory/constitution.md` references none of the renamed Docker resources (verified, zero matches). Decide whether the resource-naming convention should be codified as a principle; if yes, that is a SEPARATE `/speckit-constitution` amendment (out of scope here). Record the decision in the feature notes either way.

---

## Dependencies & Execution Order

- **Setup (P1–2)** → **Foundational (T003–T004)** → **US1 (P1)** → US2 / US3 (independent of each other; both after US1 to avoid editing the same compose files concurrently) → **US4 (P3, last — depends on US1 networks being final)** → **Polish**.
- T012 and T024 both edit root `compose.yaml` → sequential.
- T010/T025 both edit `agent-gateway/compose.yaml` → US1 before US2.
- Live-migration tasks T016→T017→T018→T019→T020→T021→T021a→T022 are strictly sequential.

## Parallel Opportunities

- **US1 repo edits**: T005, T006, T008, T009, T010, T011, T013, T014, T015 run in parallel (distinct files); T007 and T012 are the serialization points.
- **US3**: T028, T029 in parallel.
- **US4**: T032, T033, T034 in parallel after T031.

## Implementation Strategy

- **MVP = US1 (Phase 3)** — convention-compliant, data-preserving volume/network rename. Ship + verify before anything else.
- **Increment 2 = US2 + US3** — low-risk cleanup (Ollama removal, observability naming).
- **Increment 3 = US4** — the higher-risk service DNS cutover, gated on US1 being stable and a coordinated `.env` update.
- Every increment ends green on the naming gate + the standard regression suites.

**Format validation**: all tasks use `- [ ] T### [P?] [US#?] description + file path`; setup/foundational/polish carry no story label; US phases are labeled.
