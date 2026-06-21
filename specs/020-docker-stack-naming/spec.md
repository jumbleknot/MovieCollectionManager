# Feature Specification: Docker Compose Stack & Container Naming Cleanup

**Feature Branch**: `020-docker-stack-naming`

**Created**: 2026-06-20

**Status**: Draft

**Input**: User description: "Reorganize all local-dev Docker infrastructure into four named compose stacks and rename every container_name AND service key to a consistent, role-descriptive convention — a follow-up to feature 019, which renamed only networks and volumes."

## Overview

Feature 019 standardized Docker **network** and **volume** names but deliberately left **container names**, **compose service keys**, and the **compose project/stack layout** untouched. The result is an inconsistent surface: some containers carry historical names that no longer describe their role (`mc-service-db`, `mcm-bff-cache`, `movie-assistant-db`, `keycloak`), the service keys that act as in-network DNS aliases diverge from the container names (`mc-db` vs container `mc-service-db`; `caddy` vs container `mcm-bff-proxy`), and every service is merged into a single Compose project (`mcm`) gated only by profiles.

This feature unifies each service's **container name and service key to one role-descriptive identifier**, and splits the single project into **four independently operable compose stacks**: `auth`, `mcm`, `audit`, and `observability`. It is an infrastructure/configuration change only — no application behavior changes beyond updating the hostname/connection strings that reference renamed service keys.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Unified, role-descriptive identifiers with no connectivity breakage (Priority: P1)

A developer runs `docker ps` and sees every container named by a consistent `<component>[-<role>-<technology>]` convention that tells them what each one is (e.g. `mc-service-store-mongo`, `mcm-bff-cache-redis`, `movie-assistant-store-postgres`). Because the in-network service key is renamed to the **same** identifier, every service-to-service connection (BFF→Redis/Mongo, mc-service→Keycloak/Mongo, gateway→MCP servers, audit/observability sinks) continues to resolve and the application works end to end.

**Why this priority**: This is the core value — a self-describing, consistent naming surface — and it is the riskiest part, because renaming a service key changes its DNS hostname and every config reference must move in lockstep or inter-service calls break. Delivered alone it is already a complete, valuable improvement.

**Independent Test**: Bring up the full stack after the renames and run the web E2E regression via the dev-container path (against `mcm-bff-service-nonsecure`). All inter-service connectivity (login, collections, movies, agent flows) works, proving no DNS reference was missed.

**Acceptance Scenarios**:

1. **Given** the renamed compose files, **When** an operator lists running containers, **Then** every container's name matches the target convention and no legacy name (`mc-service-db`, `keycloak`, `mcm-bff-cache`, `movie-assistant-db`, `opensearch`, `opa`, `unleash`, etc.) appears.
2. **Given** a renamed service key (e.g. `mc-db` → `mc-service-store-mongo`), **When** the dependent service starts, **Then** it resolves the new hostname and connects successfully (no "No such host" / connection-refused errors).
3. **Given** the full stack is up, **When** the web E2E regression runs against the dev-container BFF, **Then** it passes at the known-green baseline.
4. **Given** the mongo replica set, **When** integration tests run, **Then** the replica-set member host and the documented `rs.reconfig` recovery command reference the renamed container and still succeed.

---

### User Story 2 - Four independently operable compose stacks (Priority: P2)

An operator brings up only the slice of infrastructure they need: `auth` (Keycloak + optional Vault), `mcm` (the application + its stores + agents), `audit` (OpenSearch sink), or `observability` (LangFuse + OTel + OPA + Unleash). Each stack is its own named Compose project with its own lifecycle, so `docker ps` / `docker compose down` operate on one stack without tearing down the others.

**Why this priority**: Operational clarity and isolation — today a `--profile X down` tears down the whole `mcm` project. Valuable, but depends on the rename (US1) landing first and is lower-risk than the DNS changes.

**Independent Test**: Run `up-auth` and confirm only the auth stack's containers start under the `auth` project; run `up-mcm` and confirm the mcm stack starts and reaches the already-running auth stack over the shared external network; `down` one stack and confirm the others keep running.

**Acceptance Scenarios**:

1. **Given** the four stack-aggregator compose files, **When** an operator brings up one stack, **Then** only that stack's services start and they appear under that stack's project name.
2. **Given** the `auth` stack is running and the `mcm` stack is brought up with the `app` profile, **When** `mc-service` starts, **Then** it reaches `keycloak-service` over the shared external network (manual ordering, no cross-project `depends_on`).
3. **Given** one stack is brought down, **When** the operator inspects the others, **Then** they remain running (no whole-project teardown).
4. **Given** the `auth` stack, **When** brought up without the Vault profile, **Then** `vault-service` does not start; **When** brought up with it, **Then** it does.
5. **Given** the per-stack Nx targets (`up-auth`, `up-mcm`, `up-audit`, `up-observability`, `up-all`), **When** invoked, **Then** they bring up the corresponding stack(s), and the agent helper scripts target the `mcm` project.

---

### User Story 3 - Convention enforced and documented (Priority: P3)

A contributor adds a new container or renames one incorrectly and the naming gate fails in CI, pointing them at the convention. Documentation (CLAUDE.md, runbooks, architecture docs) and the auto-memory describe the new stacks, names, and the four-project bring-up model so the next session starts from accurate guidance.

**Why this priority**: Prevents regression and keeps the docs trustworthy, but the rename and split deliver value without it.

**Independent Test**: Run the naming gate against the renamed tree (passes) and against a deliberately mis-named service (fails with a clear message); confirm the docs/runbooks no longer reference legacy names or the single-project bring-up.

**Acceptance Scenarios**:

1. **Given** the updated naming gate, **When** it runs on the renamed tree, **Then** it passes; **When** a container/service violates the convention, **Then** it fails with a message identifying the offender and the expected name.
2. **Given** the docs and CLAUDE.md, **When** a developer follows them, **Then** every command and hostname reflects the new stacks and names (no legacy `docker exec mc-service-db ...`, no single-project `docker compose --profile` bring-up that no longer exists).
3. **Given** CI workflows and Nx targets, **When** they run, **Then** they reference the new stack/project names and pass.

---

### Edge Cases

- **Missed DNS reference in a gitignored env file**: live connection URLs live in `.env.docker` / `agents/*/.env.local` / `mcp-servers/*/.env.local`, which are not in version control. A missed reference surfaces only at runtime as a connection failure → the discovery sweep must cover the dev-machine env files, and US1's E2E acceptance is the catch-all.
- **Renamed service key still resolvable by an old name**: nothing should rely on the old key after the rename; the old name must NOT be re-added as an alias (that would mask missed references). Connectivity must work via the new name alone.
- **Both BFF postures up at once** (`bff-secure` + `bff-nonsecure`): they bind different host ports (8081/8443 vs 8082) so they do not physically collide, but profiles keep the intent separated.
- **Replica-set member host**: the mongo RS is initiated/reconfigured with a member host string; renaming the container must not silently break the host-side `rs.reconfig` recovery documented for integration tests.
- **Vault required in prod but absent in dev**: prod bring-up must include the Vault profile; dev omits it. Services that depend on Vault must degrade/no-op cleanly when it is absent (existing env-gated behavior).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every Docker service MUST set its `container_name` and its compose service key to the **same** target identifier, per the mapping in Key Entities below.
- **FR-002**: Target identifiers MUST follow the `<component>[-<role>-<technology>]` convention; third-party vendor bundles (`langfuse-*`, `otel-lgtm`) and a documented set of auxiliary/bundle-member services (`keycloak-mailpit`, `unleash-postgres`, `unleash-seed`) MAY keep upstream names via the gate's named allowlist (contract Rules 3 / 3b). First-class application stores (e.g. the Keycloak DB) are NOT exempt and MUST adopt the convention.
- **FR-003**: All in-network references to a renamed service key MUST be updated in lockstep so that inter-service DNS resolution continues to work — covering compose `depends_on`/`extends`, env-file connection URLs, app config defaults, the Caddyfile upstream, the mongo replica-set member host, scripts, CI workflows, and Nx targets.
- **FR-004**: Implementation MUST begin with a repo-wide discovery sweep enumerating every reference to every old container name and service key, **including the gitignored env files on the dev machine**, producing the authoritative change list before edits begin.
- **FR-005**: The infrastructure MUST be reorganized into four named Compose stacks — `auth`, `mcm`, `audit`, `observability` — each a separate Compose project defined by a thin stack-aggregator compose file that `include:`s only that stack's per-service files.
- **FR-006**: The single root `compose.yaml` aggregation MUST be retired; cross-project `depends_on` (the `mc-service` → `keycloak-service` health-gate) is intentionally dropped in favor of documented manual ordering (bring up `auth` before the `mcm` `app` profile).
- **FR-007**: The `mcm` stack MUST preserve the existing profile behavior with the agreed layout: default (no profile) = test infra (`mc-service-store-mongo`, `mc-service-store-mongo-rs-init`, `mcm-bff-cache-redis`, `mcm-bff-store-mongo`); `app` adds `mc-service`; `bff-nonsecure` = `mcm-bff-service-nonsecure`; `bff-secure` = `mcm-bff-service-secure` + `mcm-bff-tls-proxy` (paired); `agents` = gateway + three MCP servers + `movie-assistant-store-postgres`; `agents-metro` = `movie-assistant-gateway-metro`.
- **FR-008**: `vault-service` MUST move out of the observability compose file into the `auth` stack and be gated behind a `vault` profile so it is optional for dev and included for prod.
- **FR-009**: Per-stack Nx targets MUST be provided (`up-auth`, `up-mcm`, `up-audit`, `up-observability`, plus an `up-all` convenience) and the agent helper scripts (`agent-stack.mjs`, `agent-e2e.mjs`) MUST target the `mcm` project; legacy single-project targets that no longer apply MUST be updated or removed.
- **FR-010**: The naming gate (`scripts/check-resource-naming.mjs`) MUST be updated to assert the new container-name/service-key convention and fail on violations, and MUST run in CI.
- **FR-011**: The BFF image tag MUST remain `mcm-bff:latest` (both secure and nonsecure services build from it); the image MUST NOT be renamed and `nx docker-build` MUST be unchanged.
- **FR-012**: Documentation and durable guidance — CLAUDE.md, the local-dev / e2e / android runbooks, architecture docs, and the auto-memory — MUST be updated to the new stack/project model and names, with no remaining references to retired single-project bring-up or legacy container names.
- **FR-013**: Network and volume names, external network declarations, and volume `name:` values MUST remain unchanged (owned by feature 019); this feature MUST NOT rename them.
- **FR-014**: After the change, the web E2E regression MUST pass via the dev-container path against `mcm-bff-service-nonsecure`, proving inter-service connectivity survived the service-key renames.

### Key Entities

**Service rename mapping** (old container / old service key → new unified identifier), grouped by target stack:

- **auth stack**:
  - `keycloak` / `keycloak-service` → **keycloak-service**
  - `keycloak-db` / `keycloak-db` → **keycloak-store-postgres**
  - `keycloak-mailpit` / `keycloak-mailpit` → **keycloak-mailpit** (unchanged; allowlisted auxiliary, contract Rule 3b)
  - `vault` / `vault` → **vault-service** (moved from observability; profile-gated)
- **mcm stack**:
  - `mc-service` / `mc-service` → **mc-service** (unchanged)
  - `mc-service-db` / `mc-db` → **mc-service-store-mongo**
  - `mc-service-db-rs-init` / `rs-init` → **mc-service-store-mongo-rs-init**
  - `mcm-bff-dev` / `mcm-bff-dev` → **mcm-bff-service-nonsecure** (dev cookie posture, :8082)
  - `mcm-bff` / `mcm-bff` → **mcm-bff-service-secure** (prod cookie posture, :8081)
  - `mcm-bff-proxy` / `caddy` → **mcm-bff-tls-proxy** (TLS edge, :8443)
  - `mcm-bff-store` / `mcm-bff-db` → **mcm-bff-store-mongo**
  - `mcm-bff-cache` / `mcm-redis` → **mcm-bff-cache-redis**
  - `movie-assistant-gateway` / `agent-gateway` → **movie-assistant-gateway**
  - `movie-assistant-gateway-metro` / `agent-gateway-metro` → **movie-assistant-gateway-metro**
  - `movie-assistant-db` / `agent-db` → **movie-assistant-store-postgres**
  - `movie-assistant-mcp-movie` / `movie-mcp` → **movie-assistant-mcp-movie**
  - `movie-assistant-mcp-spreadsheet` / `spreadsheet-mcp` → **movie-assistant-mcp-spreadsheet**
  - `movie-assistant-mcp-webapi` / `web-api-mcp` → **movie-assistant-mcp-webapi**
- **audit stack**:
  - `opensearch` / `opensearch` → **agent-audit-opensearch**
- **observability stack**:
  - `langfuse-web|worker|postgres|clickhouse|redis|minio|minio-init`, `otel-lgtm` → unchanged (vendor bundle)
  - `opa` / `opa` → **opa-service**
  - `unleash` / `unleash` → **unleash-service**
  - `unleash-postgres`, `unleash-seed` → unchanged (allowlisted bundle members, contract Rule 3b)

**Compose stack (project)**: a named `include:`-only aggregator file (`auth`, `mcm`, `audit`, `observability`) that composes its member per-service files into one project lifecycle and shares external networks with the other stacks.

**DNS reference**: any string outside the service definition that names a service key as a hostname (env connection URLs, Caddyfile upstream, replica-set member host, app config defaults, scripts, CI, Nx targets) — each must be updated when its target key is renamed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of containers, after the change, carry the target name from the mapping — zero legacy container names appear in `docker ps` for any stack.
- **SC-002**: The full stack comes up per-profile across all four stacks with zero connection failures attributable to an unresolved/renamed hostname.
- **SC-003**: The web E2E regression passes at the known-green baseline via the dev-container path; total run time stays within a normal-variance margin (≤10%) of the pre-change baseline recorded in T002, so any connectivity-retry regression surfaces as a measurable slowdown rather than going unnoticed.
- **SC-004**: Each of the four stacks can be brought up and torn down independently; tearing down one leaves the others running.
- **SC-005**: The naming gate passes on the renamed tree and fails (with an actionable message) on a deliberately mis-named service.
- **SC-006**: Zero references to any old container name or service key remain anywhere in the repository (compose, scripts, CI, app config, docs, runbooks, memory) except where intentionally preserved as historical notes — verified by a final repo-wide search.
- **SC-007**: Network and volume names are byte-for-byte unchanged from before this feature (no accidental 019 regression).

## Assumptions

- **Both container name and service key are renamed** (not container-name-only); the user accepted the larger blast radius of changing in-network DNS hostnames in exchange for full consistency.
- **The four-project split drops the one cross-stack `depends_on`** (`mc-service` → `keycloak-service` health-gate); the user accepted relying on documented manual ordering instead.
- **Shared external networks already exist** (`backend-network`, `keycloak-network`, `movie-assistant-mcp-network`) from prior features and continue to carry cross-stack traffic; this feature does not recreate them.
- **Live connection URLs reside in gitignored env files** on the dev machine; the discovery sweep and edits must be performed there as well as in version-controlled files, and only the dev machine can validate them at runtime.
- **Vendor bundles keep upstream names** (`langfuse-*`, `otel-lgtm`), with the user reserving the right to tweak them later.
- **No application code or behavior changes** beyond hostname/connection-string updates; the BFF image, build process, ports, cookie postures, and TLS edge are functionally unchanged.
- **The mongo replica set remains a single-member set**; only the member host string (if it references a renamed container/service) and the documented recovery command are touched.
- **Mobile E2E remains a CI concern** (issue #16) and is not a local gate for this feature; mobile flow files that hardcode hostnames are updated as part of the reference sweep.
