# Feature Specification: Docker Resource Naming Convention & Rename

**Feature Branch**: `019-resource-naming`

**Created**: 2026-06-20

**Status**: Draft

**Input**: User description: "Standardize all Docker volume, network, and container/service names to a consistent, collision-safe scheme with an `mcm-` product prefix; remove the unused containerized Ollama service; preserve data during the rename."

## User Scenarios & Testing *(mandatory)*

The "users" here are the **developers and operators** who provision, run, and debug the local/CI/prod stacks.

### User Story 1 - Consistent, collision-safe volume & network names (Priority: P1)

A developer reading `docker volume ls` / `docker network ls` can tell, from each name alone, which component owns it, what role it plays, and what engine backs it — and the names cannot collide with a future sibling product on the same Docker host. The three data-bearing volumes (Keycloak realm/users, mc-service movies/collections, BFF agent-configs) survive the rename with **zero data loss**.

**Why this priority**: This is the core value and the only part carrying data-loss risk. It is a viable MVP on its own — the stack is fully consistent for storage/networking even if nothing else ships.

**Independent Test**: Run the rename on a populated stack, bring it back up, and confirm (a) every external volume/network matches the convention, (b) Keycloak realm + Mongo document counts + BFF configs are unchanged, (c) the full test suite (unit/integration/E2E) is green.

**Acceptance Scenarios**:

1. **Given** a running stack with data, **When** the rename migration is performed, **Then** every external volume is named `mcm-<context>-<role>-<engine>-data` and every network `mcm-<scope>-network`, and no bare/un-prefixed external object remains.
2. **Given** the three stateful volumes, **When** the migration completes, **Then** the Keycloak `grumpyrobot` realm resolves, mc-service movie/collection counts match pre-migration, and BFF agent-config documents are intact.
3. **Given** an edited compose file referencing a renamed `external` volume that was not pre-created, **When** `docker compose up` runs, **Then** it fails loudly (missing external volume) rather than silently starting with empty data.

---

### User Story 2 - Remove the unused containerized Ollama service (Priority: P2)

A developer provisioning the agent stack is not asked to create an `ollama-models` volume or pull a ~19 GB model into a container that the committed workflow never uses; the only supported path is host Ollama.

**Why this priority**: Removes dead scaffolding and a documented foot-gun (the missing-volume error on `--profile agents up`). Independent of the rename.

**Independent Test**: After removal, `docker compose config` parses, the agent stack comes up via `scripts/agent-stack.mjs` (host Ollama), agent E2E passes, and no reference to the `ollama` service / `ollama-models` volume remains in compose, scripts, CI, or current docs.

**Acceptance Scenarios**:

1. **Given** the agent stack, **When** it is brought up, **Then** it uses host Ollama (`host.docker.internal:11434`) and no containerized `ollama` service is defined or required.
2. **Given** the repo, **When** searched, **Then** the `ollama` compose service, its `--profile` entry, and the `ollama-models` volume are gone from all live config/docs (historical specs excepted).

---

### User Story 3 - Observability & mailpit volumes follow the convention (Priority: P3)

The same naming rules apply to the observability and mailpit volumes, so the whole repo is uniform.

**Why this priority**: Consistency completeness. Low risk (these volumes hold only disposable dev data) but lower value than the data-bearing stores.

**Independent Test**: Bring up `--profile observability` and `--profile keycloak`; confirm the LangFuse/OTel/Unleash/Mailpit volumes carry explicit `mcm-observability-…` / `mcm-keycloak-mailpit-…` names.

**Acceptance Scenarios**:

1. **Given** the observability/audit/keycloak profiles, **When** they start, **Then** their volumes use explicit convention-conformant names (uniform `mcm-` hyphen prefix), not the auto `mcm_…` underscore prefix.

---

### User Story 4 - Service/container DNS rename with coordinated env cutover (Priority: P3)

Service and container names follow `mcm-<context>-<role>`, and the inter-service DNS names they expose are updated everywhere they are referenced — including a documented step for the **gitignored** `.env` files that each environment must apply.

**Why this priority**: Highest blast radius (runtime DNS, gitignored env, healthchecks, scripts) and must not silently break inter-service auth, so it ships last as a coordinated cutover after US1–US3 are stable.

**Independent Test**: After the service rename, every environment that updated its `.env` boots a green stack; login, movie CRUD, and an agent run all succeed end-to-end.

**Acceptance Scenarios**:

1. **Given** the service rename, **When** an environment updates its local `.env` per the documented mapping, **Then** the stack boots, inter-service calls resolve, and auth + agent flows pass.
2. **Given** an environment that did NOT update its `.env`, **When** the stack starts, **Then** the failure is a clear connection/DNS error pointing at the renamed host (not a silent partial outage).

### Edge Cases

- A renamed `external` volume not pre-created → compose errors on the missing volume (must not start empty). *(Covered by US1 AC3.)*
- Partial migration (copy half-done) → the old volumes remain untouched until explicit decommission, so the stack can always be rolled back.
- **Prod/Komodo and other environments** are out of repo reach — the PR cannot update their live `.env` or pre-create their volumes; the cutover requires a per-environment runbook step.
- CI provisions volumes/networks via create-loops in `android-e2e.yml`; these must be updated in lockstep or CI fails to find the renamed objects.
- Disposable volumes (cache/checkpoints/audit) are recreated empty — sessions log out and checkpoints reset on cutover (acceptable, must be documented).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every externally-named Docker volume MUST follow `<context>-<role>-<engine>-data`; every network `<scope>-network`; every service/container `<context>` optionally suffixed `-<role>` (a bare context like `keycloak`/`mc-service` is conformant) — where `<context>` is the owning component (`keycloak`, `mc-service`, `mcm-bff`, `movie-assistant` for resources of this specific assistant, `agent` for platform-level resources shared by any future agent such as the audit sink, `observability`).
- **FR-002**: Resources MUST be namespaced by their owning component (the component name is the namespace). A global product prefix MUST NOT be used; the `mcm-` qualifier is applied **only to the BFF** (`mcm-bff-*`), because the BFF is the sole frontend-specific component and "bff" is a role a future sibling frontend would repeat.
- **FR-003**: The rename MUST preserve all data in the three stateful volumes (Keycloak realm/users/secrets, mc-service movies/collections, BFF agent-configs) via a copy-then-cutover migration — never an in-place `name:` change that orphans data.
- **FR-004**: The migration MUST be reversible until an explicit decommission step (old volumes retained; a host-side backup taken first).
- **FR-005**: The containerized `ollama` service and its `ollama-models` volume MUST be removed from all live configuration, scripts, CI, and current documentation; host Ollama remains the supported path.
- **FR-006**: All reference sites MUST be updated in lockstep: the 11 service compose files (incl. `movie-mcp` and `spreadsheet-mcp`; `ollama` is deleted, not edited), the root `compose.yaml` (`include:`, profile table, first-time create block), `scripts/agent-stack.mjs`, `scripts/agent-gateway-local.ps1`, the CI volume/network create-loops, and the operational docs (`local-dev.md`, `MCM-Architecture.md`, `agent-layer.md`, `agents/movie-assistant/README.md`).
- **FR-007**: Observability and mailpit volumes MUST be brought into the convention with explicit names (uniform `mcm-` prefix), with relaxed `mcm-observability-<service>-<engine>-data` naming permitted for multi-volume vendor stacks.
- **FR-008**: Service/container DNS renames (Stage B) MUST include a documented per-environment step to update the gitignored `.env` files, and every `.env*.example` in the repo MUST be updated.
- **FR-009**: Historical spec artifacts (`specs/004`, `012`, `018`, …) MUST be left unchanged as point-in-time records; only live/operational references are updated.
- **FR-010**: After each phase, the project's standard verification gates (unit, integration, web E2E) MUST pass against the renamed resources.

### Key Entities *(include if feature involves data)*

- **Resource name**: a structured identifier — `context` (keycloak | mc-service | mcm-bff | movie-assistant | agent | observability; only the BFF carries the `mcm-` frontend qualifier; `movie-assistant` = this specific assistant, `agent` = shared platform resources) · `role` (store | cache | audit | …) · `engine` (postgres | mongo | redis | opensearch | clickhouse | minio | mailpit) · constant suffix (`-data` for volumes, `-network` for networks).
- **Stateful volume**: a volume whose data is a system of record and must be copied during migration (the 3 stores).
- **Disposable volume**: cache/checkpoint/audit data that may be recreated empty.
- **Reference site**: any file that names a resource (compose, scripts, CI, docs, `.env*.example`) and must change in lockstep.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of external Docker volumes and networks match the convention; zero bare or compose-project-prefixed external names remain (verifiable by `docker volume ls`/`network ls` + a grep gate over compose files).
- **SC-002**: Zero data loss — post-migration Keycloak realm resolves and Mongo document counts (movies, collections, BFF configs) exactly equal pre-migration counts.
- **SC-003**: The full stack boots clean and the standard verification gates pass (unit, integration, web E2E) after each phase, matching the pre-rename baselines.
- **SC-004**: Zero references to the removed `ollama` containerized service / `ollama-models` volume remain in live config, scripts, CI, or current docs.
- **SC-005**: A developer can provision a fresh host from the updated first-time-setup block alone and reach a green stack (no stale volume/network names).
- **SC-006**: The migration is demonstrably reversible — rolling back the compose edits and bringing the stack up restores the pre-rename state with no data change.

## Assumptions

- Target is the single-host local/CI Docker environment; **prod/Komodo cutover is operator-driven** via the runbook (the repo cannot touch live `.env` or pre-create remote volumes).
- The committed model-serving path is **host Ollama**; the containerized `ollama` service is genuinely unused and safe to delete.
- Disposable volumes (cache/checkpoints/audit) may be recreated empty; losing dev sessions/checkpoints on cutover is acceptable.
- Multi-volume vendor stacks (LangFuse) use the relaxed `mcm-observability-<service>-<engine>-data` form where strict `<role>` tagging is awkward.
- The full design (exact current→proposed mapping) and the step-by-step migration runbook already exist at [docs/proposals/resource-naming-convention.md](../../docs/proposals/resource-naming-convention.md) and [docs/proposals/volume-network-rename-migration.md](../../docs/proposals/volume-network-rename-migration.md) and are the authoritative reference for planning.
- Open Phase-2 detail (use explicit `container_name:` vs compose-generated `mcm-<service>-1`) is a planning/clarify decision, not a scope blocker.
