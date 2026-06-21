# Implementation Plan: Docker Compose Stack & Container Naming Cleanup

**Branch**: `020-docker-stack-naming` | **Date**: 2026-06-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/020-docker-stack-naming/spec.md`

## Summary

Unify each Docker service's `container_name` and compose **service key** to one role-descriptive identifier (`<component>[-<role>-<technology>]`), and split the single `mcm` Compose project into four independently operable named stacks — `auth`, `mcm`, `audit`, `observability` — via thin `include:`-only aggregator files. Because renaming a service key changes its in-network DNS hostname, the work begins with a repo-wide (and dev-machine env-file) discovery sweep, then updates every reference in lockstep. Vault moves from observability into auth (profile-gated: optional dev / required prod). Networks and volumes (owned by feature 019) are untouched. Validation is the existing naming gate (updated to the new convention) plus the web E2E regression against `mcm-bff-service-nonsecure`, which proves no inter-service DNS reference was missed.

## Technical Context

**Language/Version**: N/A — declarative infra config (Docker Compose v2 `compose.yaml`, YAML); supporting scripts in Node ESM (`.mjs`) and PowerShell; no application source language changes.

**Primary Dependencies**: Docker Compose v2 (profiles, `include:`, `extends:`, named projects via top-level `name:`); Nx (`@nxlv/python`/`@monodon/rust` targets unaffected; `infrastructure-as-code` project targets remapped); the naming gate (`scripts/check-resource-naming.mjs`, uses the `yaml` root dep).

**Storage**: N/A (no schema/data changes). Existing external volumes keep their feature-019 names verbatim.

**Testing**: `node scripts/check-resource-naming.mjs` (naming gate, runs in CI via `.github/workflows/naming-gate.yml`); `pnpm nx e2e mcm-app` dev-container path (`E2E_BFF_TARGET=dev-container` against `mcm-bff-service-nonsecure`); manual per-stack bring-up/teardown validation.

**Target Platform**: Local developer machine (Windows/PowerShell primary, Bash available) + GitHub Actions CI (Linux).

**Project Type**: Infrastructure / configuration refactor across an existing polyglot monorepo (no new project, no app behavior change).

**Performance Goals**: No runtime perf target. Constraint: web E2E regression stays at its known-green baseline (~54s/93 tests dev-container) with no increase attributable to connectivity retries.

**Constraints**: Zero change to network/volume names (FR-013); zero application behavior change beyond hostname/connection strings; the old service-key names MUST NOT be re-added as aliases (so a missed reference fails loudly rather than silently resolving); ports/cookie postures/TLS edge functionally unchanged.

**Scale/Scope**: 31 container definitions across 11 per-service compose files → 4 stack-aggregator files; ~24 of 31 services renamed (container and/or key); reference sweep spans compose, Caddyfile, env files (incl. gitignored), app config defaults, scripts, CI, Nx targets, runbooks/docs, CLAUDE.md, and the auto-memory (60+ candidate files identified in the spike).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

This feature touches infrastructure configuration only; most constitution principles (Security, Clean Architecture, TDD app-layers, Frontend layers) do not apply. Relevant gates:

| Principle | Status | Notes |
|---|---|---|
| **Docker-Native Operations** — compose files provided for local multi-service dev | ✅ PASS | Reorganizes existing compose files into clearer named stacks; all services keep healthchecks; no service loses its compose definition. |
| **Secrets Management** (Vault) | ✅ PASS | Vault relocates to the `auth` stack; remains profile-gated (optional dev / required prod). No secrets added to source; no behavior change to secret injection beyond its `VAULT_ADDR` hostname. |
| **Configuration in environment** | ✅ PASS | All renamed hostnames remain env-driven (connection URLs in `.env*`), not hard-coded in app logic. |
| **Directory & File Naming** (kebab-case for non-Rust) | ✅ PASS | New aggregator files and all identifiers are kebab-case. |
| **Behavior-Descriptive Identifiers** | ✅ PASS | New names describe role (`*-store-mongo`, `*-cache-redis`, `*-tls-proxy`); no spec-ID in identifiers. The naming gate enforces the convention. |
| **Test-Driven Development** | ⚠️ ADAPTED | No app code under test; this is config. The "test-first" analogue is: (1) update the naming gate to assert the new convention (RED: fails on the current tree), then (2) perform renames (GREEN: gate passes), and (3) the web E2E regression is the integration proof that DNS still resolves. Documented in Complexity Tracking. |
| **Bounded-Context Isolation for Agent State** | ✅ PASS | The agent checkpointer Postgres is only renamed (`agent-db`→`movie-assistant-store-postgres`); it stays a dedicated store on the private network — isolation unchanged. |
| **Independent Deployment / Decoupling** | ✅ PASS | Four independent stacks improve decoupling; the one dropped cross-project `depends_on` is a deliberate, documented trade (manual ordering). |

No unjustified violations. The TDD adaptation is recorded below.

## Project Structure

### Documentation (this feature)

```text
specs/020-docker-stack-naming/
├── plan.md              # This file
├── research.md          # Phase 0 output — resolved design decisions + the discovery-sweep method
├── data-model.md        # Phase 1 output — the rename mapping + reference-category taxonomy
├── quickstart.md        # Phase 1 output — per-stack bring-up + E2E validation guide
├── contracts/
│   └── naming-convention.md   # Phase 1 output — the container/service-key convention the gate enforces
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
infrastructure-as-code/
├── docker/
│   ├── stacks/                       # NEW — thin named-project aggregators (include: only)
│   │   ├── auth.compose.yaml         #   name: auth        → keycloak/* + vault (profile-gated)
│   │   ├── mcm.compose.yaml          #   name: mcm         → mc-service/* + bff/* + agent-*/* + mcp/*
│   │   ├── audit.compose.yaml        #   name: audit       → opensearch
│   │   └── observability.compose.yaml#   name: observability → langfuse/* + otel + opa + unleash
│   ├── keycloak/compose.yaml         # renamed container+key: keycloak→keycloak-service, keycloak-db→keycloak-store-postgres
│   ├── mc-service/compose.yaml       # mc-db→mc-service-store-mongo, rs-init→mc-service-store-mongo-rs-init (+ rs member host)
│   ├── bff/compose.yaml              # mcm-bff→*-service-secure, mcm-bff-dev→*-service-nonsecure, caddy→mcm-bff-tls-proxy, mcm-redis→*-cache-redis, mcm-bff-db→*-store-mongo
│   ├── bff/compose.agent-e2e.yaml    # override key mcm-bff-dev→mcm-bff-service-nonsecure
│   ├── bff/Caddyfile                 # reverse_proxy upstream mcm-bff→mcm-bff-service-secure
│   ├── agent-gateway/compose.yaml    # keys agent-gateway→movie-assistant-gateway, agent-gateway-metro→movie-assistant-gateway-metro (+ extends:)
│   ├── agent-db/compose.yaml         # agent-db→movie-assistant-store-postgres
│   ├── movie-mcp/compose.yaml        # movie-mcp→movie-assistant-mcp-movie
│   ├── spreadsheet-mcp/compose.yaml  # spreadsheet-mcp→movie-assistant-mcp-spreadsheet
│   ├── web-api-mcp/compose.yaml      # web-api-mcp→movie-assistant-mcp-webapi
│   ├── observability/compose.yaml    # vault REMOVED (→auth); opa→opa-service, unleash→unleash-service
│   └── opensearch/compose.yaml       # opensearch→agent-audit-opensearch
├── project.json                      # Nx targets remapped: up-auth/up-mcm/up-audit/up-observability/up-all
compose.yaml                          # RETIRED single-project root aggregator (removed or reduced to a pointer)
scripts/
├── check-resource-naming.mjs         # gate extended: assert container_name == service key == convention
├── agent-stack.mjs                   # target the `mcm` project / new compose paths
└── agent-e2e.mjs                     # target the `mcm` project / new compose paths
.github/workflows/                    # naming-gate.yml + android-e2e.yml: new stack/compose invocations
frontend/mcm-app/                     # env examples + src/config/env.ts + integration env + mobile flows: renamed hostnames
docs/ + CLAUDE.md + memory/           # runbooks, architecture, CLAUDE.md, auto-memory: new stack model + names
```

**Structure Decision**: Keep the existing modular per-service compose files (minimal churn, each service self-contained) and add a `stacks/` directory of four thin `include:`-only aggregator files, each with its own top-level `name:` so `docker compose -p`/`ps`/`down` operate per stack. Retire the single root `compose.yaml` aggregation. This matches the spec's FR-005/FR-006 and the user's resolved decision #2.

## Complexity Tracking

| Decision | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Rename **service keys** (not just `container_name`) | User wants full consistency: one identifier shown in `docker ps` AND used as the in-network DNS name. | Container-name-only is lower-risk but leaves the service key (the actual DNS alias) divergent — the inconsistency the feature exists to remove. |
| Four separate Compose projects (drop cross-project `depends_on`) | Independent per-stack lifecycle; `down` one stack without tearing down the others (today `--profile X down` kills the whole `mcm` project). | Single project with profiles is simpler but cannot give per-stack lifecycle isolation; the one lost health-gate (`mc-service`→`keycloak-service`) is already covered by documented manual ordering. |
| TDD-as-gate adaptation (no app code) | Config refactor has no unit-testable function; the naming gate (RED→GREEN) + web E2E (integration proof) are the verifiable analogue. | A literal unit test would test nothing real; the gate + E2E are the meaningful, runnable checks. |
