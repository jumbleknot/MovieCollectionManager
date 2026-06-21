---

description: "Task list for Docker Compose stack & container naming cleanup"
---

# Tasks: Docker Compose Stack & Container Naming Cleanup

**Input**: Design documents from `specs/020-docker-stack-naming/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/naming-convention.md](./contracts/naming-convention.md), [quickstart.md](./quickstart.md)

**Tests**: This is an infrastructure/config refactor with no app code under test. The "test-first" analogue (per plan §Constitution Check) is the **naming gate** (`scripts/check-resource-naming.mjs`) driven RED→GREEN, plus the **web E2E regression** as the inter-service-connectivity integration proof. Both use the TDD checkpoint format (Verify RED / Verify GREEN).

**Organization**: Tasks are grouped by the three user stories from spec.md. US1 (renames) is the MVP; US2 (stack split) builds on it; US3 (enforce + document) hardens it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 (Setup, Foundational, Polish carry no story label)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the authoritative change list and the known-green baselines BEFORE any edit.

- [ ] T001 Perform the discovery sweep (FR-004) and write the authoritative change list to `specs/020-docker-stack-naming/discovery-notes.md`: for every old container name and service key in [data-model.md](./data-model.md), grep the repo (compose, `infrastructure-as-code/docker/bff/Caddyfile`, `scripts/`, `.github/workflows/`, `frontend/mcm-app/src/config/env.ts`, `frontend/mcm-app/tests/integration/setup/env.ts`, `mcp-servers/*/tests`, `docs/`, `CLAUDE.md`, `memory/`) AND grep the **gitignored dev-machine env files** (`frontend/mcm-app/.env.docker`, `agents/movie-assistant/.env.local`, `mcp-servers/*/.env.local`); record file + line + old→new for each hit.
- [ ] T002 Capture pre-change baselines for regression comparison in `specs/020-docker-stack-naming/discovery-notes.md`: current `docker ps --format '{{.Names}}'`, `docker network ls`, `docker volume ls` (SC-007 reference), and confirm the web E2E dev-container suite is green at HEAD before changes begin — **record its total run time** as the SC-003 baseline for the T018 ≤10% comparison.

**Checkpoint**: Every reference that must change is enumerated; baselines recorded.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Update the naming gate to the new convention. This establishes the RED checkpoint the whole feature converges on.

**⚠️ CRITICAL**: This is the verification anchor for US1's GREEN.

- [ ] T003 Update `scripts/check-resource-naming.mjs` to assert the [naming-convention contract](./contracts/naming-convention.md): for every per-service compose file, `container_name` MUST equal the service key MUST equal the `<component>[-<role>-<technology>]` convention; enforce the vendor allowlist (Rule 3: langfuse-*, otel-lgtm) AND the auxiliary/bundle-member allowlist (Rule 3b: `keycloak-mailpit`, `unleash-postgres`, `unleash-seed`), Rule 4 (no renamed service re-adds its old key as a network `alias`), and keep the existing feature-019 network/volume assertions unchanged.
  - **Verify RED**: `node scripts/check-resource-naming.mjs` → FAILS on the current tree, listing the unrenamed services (e.g. container `mc-service-db` ≠ key `mc-db`, `keycloak` not matching convention). A pass here means the new assertions are not wired — fix before proceeding.

**Checkpoint**: Gate is RED against the current names — ready for US1 to drive it GREEN.

---

## Phase 3: User Story 1 - Unified identifiers with no connectivity breakage (Priority: P1) 🎯 MVP

**Goal**: Rename every `container_name` and service key to its unified target (data-model.md mapping), updating every reference in lockstep, while the existing single-project bring-up keeps working.

**Independent Test**: Bring up the full stack (still via the existing root `compose.yaml` + profiles, now using the new names) and run the web E2E regression via the dev-container path against `mcm-bff-service-nonsecure` — all flows pass, proving no DNS reference was missed.

> **NOTE**: T012 and T016 edit shared/central files and are sequential; the per-service compose edits (T005–T011) are parallel (different files). Root `compose.yaml` is edited here transitionally and retired in US2.

### Per-service compose renames (parallel)

- [ ] T005 [P] [US1] In `infrastructure-as-code/docker/keycloak/compose.yaml`: rename container `keycloak`→`keycloak-service`; rename service+container `keycloak-db`→`keycloak-store-postgres`; update the `keycloak-service` `depends_on` and the `KC_DB_URL`/JDBC host to `keycloak-store-postgres` (leave the `external` volume `name:` unchanged).
- [ ] T006 [P] [US1] In `infrastructure-as-code/docker/mc-service/compose.yaml`: rename `mc-db`→`mc-service-store-mongo` and `rs-init`→`mc-service-store-mongo-rs-init` (container+key); update `mc-service` and rs-init `depends_on`, the rs-init `rs.initiate` member-host string, and any `MC_DB_URL` host in this file.
- [ ] T007 [P] [US1] In the BFF compose set: `infrastructure-as-code/docker/bff/compose.yaml` (rename `mcm-bff`→`mcm-bff-service-secure`, `mcm-bff-dev`→`mcm-bff-service-nonsecure`, `caddy`→`mcm-bff-tls-proxy`, `mcm-redis`→`mcm-bff-cache-redis`, `mcm-bff-db`→`mcm-bff-store-mongo`; update all `depends_on` + the in-file Redis/Mongo hosts), `infrastructure-as-code/docker/bff/compose.agent-e2e.yaml` (override key `mcm-bff-dev`→`mcm-bff-service-nonsecure`), and `infrastructure-as-code/docker/bff/Caddyfile` (`reverse_proxy mcm-bff:3000`→`mcm-bff-service-secure:3000`).
- [ ] T008 [P] [US1] In `infrastructure-as-code/docker/agent-gateway/compose.yaml` and `infrastructure-as-code/docker/agent-db/compose.yaml`: rename keys `agent-gateway`→`movie-assistant-gateway`, `agent-gateway-metro`→`movie-assistant-gateway-metro`, `agent-db`→`movie-assistant-store-postgres`; update the metro `extends: service:` target and the gateway `depends_on`/checkpointer-DB host.
- [ ] T009 [P] [US1] In `infrastructure-as-code/docker/movie-mcp/compose.yaml`, `.../spreadsheet-mcp/compose.yaml`, `.../web-api-mcp/compose.yaml`: rename service keys to `movie-assistant-mcp-movie` / `-spreadsheet` / `-webapi` (container names already match).
- [ ] T010 [P] [US1] In `infrastructure-as-code/docker/observability/compose.yaml`: rename `opa`→`opa-service`, `unleash`→`unleash-service`, and `vault`→`vault-service` **in place** (relocation to the auth stack is US2/T020); update `unleash-seed` `depends_on` and any in-file references (leave langfuse-*/otel-lgtm untouched).
- [ ] T011 [P] [US1] In `infrastructure-as-code/docker/opensearch/compose.yaml`: rename `opensearch`→`agent-audit-opensearch` (container+key).

### Cross-cutting reference updates

- [ ] T012 [US1] In the root `infrastructure-as-code`-aggregating `compose.yaml`: update every key in the `services:` override block and all `depends_on`/`profiles` references to the new names (transitional — keeps single-project bring-up working for the US1 test; retired in US2/T024).
- [ ] T013 [P] [US1] In `scripts/agent-stack.mjs` and `scripts/agent-e2e.mjs`: update all container-name/service-key hostnames and any `docker exec`/`ps`/compose references to the new names.
- [ ] T014 [P] [US1] Update app/test config hostnames per the discovery list: `frontend/mcm-app/src/config/env.ts` defaults, `frontend/mcm-app/tests/integration/setup/env.ts`, `frontend/mcm-app/tests/integration/helpers/keycloak-test-client.ts`, `infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs`, `.../configure-token-exchange.mjs`, and `mcp-servers/movie-mcp/tests/integration/conftest.py`.
- [ ] T015 [P] [US1] Update the version-controlled env examples: `frontend/mcm-app/.env.example`, `frontend/mcm-app/.env.docker.example`, `agents/movie-assistant/.env.local.example`, `mcp-servers/*/.env.local.example` — change every old service-key hostname (`MC_DB_URL`, `REDIS_URL`, `AGENT_GATEWAY_URL`, MCP URLs, `OPA_URL`, `UNLEASH_*`, `OPENSEARCH_URL`, `VAULT_ADDR`, `KC_DB_URL`) to the new names.
- [ ] T016 [US1] Update the **gitignored dev-machine env files** from the discovery list: `frontend/mcm-app/.env.docker`, `agents/movie-assistant/.env.local`, `mcp-servers/*/.env.local` — apply the same hostname changes as T015 to the live files (these cannot be seen in VCS and are only validated at runtime).
- [ ] T017 [P] [US1] Update any hardcoded hostnames in `frontend/mcm-app/tests/e2e/mobile/*.yaml` (agent/assistant flows) to the new service names.

### US1 verification

- [ ] T018 [US1] **Verify GREEN** (US1 checkpoint): run `node scripts/check-resource-naming.mjs` → PASSES; bring up the full stack via the existing profiles and confirm `docker ps --format '{{.Names}}'` shows every target name and zero legacy names (SC-001); build + run the web E2E dev-container path (`pnpm nx docker-build mcm-app`, bring up `mcm-bff-service-nonsecure`, `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`) → green at baseline (SC-002/SC-003/FR-014). **FR-011 check**: confirm `pnpm nx docker-build mcm-app` still produces the `mcm-bff:latest` image tag (unchanged) and the `nx docker-build` target definition was not modified. **SC-003 run-time check**: compare the E2E suite total run time against the T002 baseline — within ≤10% (a larger slowdown signals connectivity-retry regressions). Any connection failure = a missed reference from T013–T016 → fix and re-run.

**Checkpoint**: All renames done, every reference updated, gate GREEN, E2E green. MVP complete and independently shippable.

---

## Phase 4: User Story 2 - Four independently operable compose stacks (Priority: P2)

**Goal**: Split the single project into four named Compose projects (`auth`, `mcm`, `audit`, `observability`), move Vault into `auth` (profile-gated), retire the root aggregator, and remap Nx targets.

**Independent Test**: `up-auth` then `up-mcm` start under separate projects; tearing one stack down leaves the others running; Vault is absent without its profile and present with it.

- [ ] T019 [P] [US2] Create `infrastructure-as-code/docker/stacks/auth.compose.yaml` with top-level `name: auth` and `include:` of `keycloak/compose.yaml` (and the relocated vault — see T020); declare the shared external networks.
- [ ] T020 [US2] Move the `vault-service` definition out of `infrastructure-as-code/docker/observability/compose.yaml` into the `auth` stack (its own per-service file `infrastructure-as-code/docker/vault/compose.yaml` included by the auth aggregator), gated behind a `vault` profile (absent for dev, included for prod); remove it from observability (FR-008).
- [ ] T021 [P] [US2] Create `infrastructure-as-code/docker/stacks/mcm.compose.yaml` (`name: mcm`) including mc-service, bff, agent-gateway, agent-db, movie-mcp, spreadsheet-mcp, web-api-mcp; apply the profile layout from plan/FR-007: default=test infra; `app`=mc-service; `bff-nonsecure`=`mcm-bff-service-nonsecure`; `bff-secure`=`mcm-bff-service-secure`+`mcm-bff-tls-proxy`; `agents`=gateway+3 MCP+`movie-assistant-store-postgres`; `agents-metro`=`movie-assistant-gateway-metro`.
- [ ] T022 [P] [US2] Create `infrastructure-as-code/docker/stacks/audit.compose.yaml` (`name: audit`) including `opensearch/compose.yaml`.
- [ ] T023 [P] [US2] Create `infrastructure-as-code/docker/stacks/observability.compose.yaml` (`name: observability`) including `observability/compose.yaml` (now vault-free).
- [ ] T024 [US2] Retire the root `compose.yaml` single-project aggregation (remove the `include:` + `services:` override block; replace with a short pointer/README to the per-stack aggregators, or delete) — dropping the cross-project `mc-service`→`keycloak-service` `depends_on` (FR-006, accepted trade).
- [ ] T025 [US2] Remap the Nx targets in `infrastructure-as-code/project.json`: replace the single-project `up-*`/`down*` targets with `up-auth`, `up-mcm`, `up-audit`, `up-observability`, an `up-all` convenience, and matching `down-*`, each invoking `docker compose -p <stack> -f infrastructure-as-code/docker/stacks/<stack>.compose.yaml ...` with appropriate profiles.
- [ ] T026 [US2] Update `scripts/agent-stack.mjs` and `scripts/agent-e2e.mjs` to target the `mcm` project and the new `stacks/mcm.compose.yaml` (+ the bff `compose.agent-e2e.yaml` override path) instead of the retired root compose.
- [ ] T027 [US2] **Verify**: bring up each stack independently (`up-auth`, `up-mcm`, `up-audit`, `up-observability`); confirm each runs under its own project name; tear down one stack and confirm the others survive (SC-004); confirm `vault-service` absent without the profile and present with it (FR-008); re-run the web E2E dev-container path via the `mcm` stack `bff-nonsecure` profile → green.

**Checkpoint**: Four independent stacks; lifecycle isolation proven; Vault relocated and gated. US1 + US2 both functional.

---

## Phase 5: User Story 3 - Convention enforced and documented (Priority: P3)

**Goal**: Lock the convention in CI and bring all documentation/memory in line with the new stacks and names.

**Independent Test**: The gate fails on a deliberately mis-named service; the docs/runbooks contain no legacy names or retired single-project commands.

- [ ] T028 [P] [US3] Confirm the naming gate runs in CI: verify `.github/workflows/naming-gate.yml` invokes the updated `scripts/check-resource-naming.mjs` (with the `yaml` root dep resolvable under frozen install) and update `.github/workflows/android-e2e.yml` for any renamed container/stack/compose references.
- [ ] T029 [P] [US3] Update `CLAUDE.md`: container names, the four-stack model + profile table, the per-stack bring-up commands (replace the retired single-project `docker compose --profile` quick-reference), the `rs.reconfig` recovery snippet (`mc-service-store-mongo`), and the Docker-internal-DNS notes.
- [ ] T030 [P] [US3] Update the runbooks and architecture docs: `docs/runbooks/local-dev.md` (profile table, stack bring-up, first-time-setup), `docs/runbooks/e2e-testing.md`, `docs/runbooks/android-emulator.md`, `docs/MCM-Architecture.md`, `docs/agent-layer.md`, `agents/movie-assistant/README.md`, and `infrastructure-as-code/docker/keycloak/README.md` — replace all legacy container names and single-project bring-up.
- [ ] T031 [P] [US3] Update the auto-memory at `C:/Users/Steve/.claude/projects/e--Programming-VSCode-MovieCollectionManager/memory/`: add a `project_mcm_020_docker_stack_naming.md` topic file (stacks, mapping, the four-project bring-up model, the no-legacy-alias rule) and a one-line `MEMORY.md` pointer; cross-link `[[project-mcm-019-resource-naming]]`.
- [ ] T032 [US3] **Verify**: temporarily mis-name one service's `container_name` (≠ its key) and confirm `node scripts/check-resource-naming.mjs` FAILS with an actionable message, then revert (SC-005); grep docs/runbooks/CLAUDE.md for legacy names → zero hits.

**Checkpoint**: Convention enforced in CI; docs and memory accurate.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final whole-feature validation.

- [ ] T033 Run the full [quickstart.md](./quickstart.md) validation end-to-end (§1 gate GREEN, §2 names, §3 independent teardown, §4 vault gating, §5 integration tests, §6 web E2E, §8 networks/volumes unchanged).
- [ ] T034 Final repo-wide residual search for any old container name / service key (SC-006) and confirm `docker network ls` / `docker volume ls` are byte-for-byte unchanged vs the T002 baseline (SC-007); record results in `discovery-notes.md`.

---

## Platform Parity Table

This feature adds no new user-facing test scenarios; it reuses the existing regression suites as connectivity proofs. No new per-scenario web/mobile parity is introduced.

| Scenario | Web (Playwright) | Mobile (Maestro) | Justification |
|---|---|---|---|
| Inter-service connectivity after rename (US1) | Reused: dev-container web E2E regression (T018/T027) | N/A | The web E2E dev-container path is the project's standard connectivity gate; it exercises BFF→service→DB end-to-end. Mobile E2E is a CI-only concern (issue #16) and adds no connectivity coverage the web path lacks. |
| Naming-gate enforcement (US3) | N/A (CI script gate) | N/A | Enforced by `check-resource-naming.mjs` in CI, not a UI flow. |
| Mobile flow hostnames (US1) | N/A | Updated: `tests/e2e/mobile/*.yaml` hostnames (T017) | Mobile flows are edited for renamed hostnames but not run as a local gate (issue #16). |

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately. T001 (discovery) blocks all edit tasks; T002 records baselines.
- **Foundational (Phase 2)**: depends on Setup. T003 establishes the RED gate.
- **US1 (Phase 3)**: depends on Foundational. The MVP — drives the gate GREEN.
- **US2 (Phase 4)**: depends on US1 (renames must be complete before splitting into stacks). 
- **US3 (Phase 5)**: depends on US1 (names final) and US2 (stack model final) for accurate docs; T028 gate-in-CI depends on T003.
- **Polish (Phase 6)**: depends on US1+US2+US3.

### Within US1

- T005–T011 (per-service compose files) are parallel — different files.
- T012 (root compose override) is sequential — central file referencing all new keys.
- T013–T015, T017 are parallel — different files.
- T016 (live env files) is sequential/manual on the dev machine.
- T018 (Verify GREEN) is last — depends on T005–T017.

### Parallel Opportunities

- T005, T006, T007, T008, T009, T010, T011 together (different compose files).
- T013, T014, T015, T017 together (different reference files).
- US2: T019, T021, T022, T023 together (different aggregator files); T020/T024/T025/T026 sequential (shared/dependent files).
- US3: T028, T029, T030, T031 together (different docs/files).

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 (discovery + baselines) → Phase 2 (gate RED) → Phase 3 (renames + references) → T018 GREEN.
2. **STOP and VALIDATE**: gate GREEN + web E2E green against the renamed single-project stack. This is a complete, shippable improvement on its own.

### Incremental Delivery

1. US1 → consistent names, everything still works (MVP).
2. US2 → four independent stacks + Vault relocation.
3. US3 → CI enforcement + docs/memory.
4. Polish → full quickstart + residual sweep.

---

## Notes

- The old service-key names must NOT be re-added as network aliases (contract Rule 4) — a missed reference must fail loudly at T018/T027, not silently resolve.
- Networks and volumes are owned by feature 019 and must remain unchanged (SC-007); the gate keeps the 019 assertions intact.
- Use PowerShell on this machine; `MSYS_NO_PATHCONV` issues with pnpm were noted in 019 — prefer PowerShell for `pnpm nx` invocations.
- Commit after each phase (or logical group) per the SDD git hooks.
- Task IDs are intentionally non-contiguous: **T004 is unused** (the sequence jumps T003 → T005). This is deliberate, not a missing task.
