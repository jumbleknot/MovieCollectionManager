---
type: Reference
title: OpenWiki quickstart — MovieCollectionManager
description: The root entry point for this repository's OpenWiki bundle — what it is, how it is organized, how to query it by type or tag, and links to every concept area.
resource: openwiki/INSTRUCTIONS.md
tags: [openwiki, navigation, quickstart]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-27T16:58:28.669Z
sources:
  - id: openwiki-source-95a7ed7500d24b0881fc3468
    resource: repo://docs/runbooks/backups.md
generated: { by: "openwiki/0.5.2", at: "2026-09-27T16:58:28.669Z" }
---

# OpenWiki quickstart — MovieCollectionManager

This bundle is a **navigation and gotcha layer** over documentation that already exists in this
repository — not a second copy of it. MovieCollectionManager already has an architecture overview,
operator runbooks, architecture decision records, a governing constitution, and per-project READMEs;
this wiki's job is to make that material *findable and safe to act on* without re-derailing you into
reading every source document from scratch.

Every concept page in this bundle follows the same shape: a short **distilled summary** of the
subject, its **load-bearing gotchas** (the non-obvious traps that cost a developer a session when
missed — the highest-value content on any page), and a `resource` link to the authoritative source for
full detail. If you need the complete step-by-step procedure, follow the `resource` link; the page
itself will not replay it. See `openwiki/INSTRUCTIONS.md` for the full generation brief and its
exclusions (notably `docs/proposals/**`, which is intentionally out of scope — see
[Spec-driven development](./process/spec-driven-development.md)).

## How to query this bundle

Every page carries OKF front matter (`type`, `title`, `description`, `tags`, `resource`). Use these
fields rather than guessing filenames:

- **By `type`** — filter to a category: `Service` (per-deployable-unit overviews), `Convention` /
  `Decision` (cross-cutting rules and ratified decisions), `Gotcha` (standalone traps not tied to one
  project), `Runbook` (operator procedures), `Process` (how work moves through the repository), or
  `Reference` (this page).
- **By `tags`** — cross-cutting themes such as `auth`, `secrets`, `mongodb`, `ci-gates`, or `openwiki`
  span multiple pages regardless of directory; a tag search surfaces all of them together.
- **By `resource`** — every page cites its canonical source as a repository-relative path (verified to
  resolve by the conformance gate) or an external URL. If a document under `docs/runbooks/`,
  `docs/decisions/`, or the architecture docs has no citing concept page, that is a real gap, not an
  oversight — the brief requires every such document to be reachable by a metadata query.
- **By directory** — each section below is one directory under `openwiki/`, with its own `index.md`
  listing every page and description in that section.

## Concept areas

- **[architecture/](architecture/)** — the whole-system map: the
  [system overview](./architecture/system-overview.md), the
  [AI Agents layer architecture](./architecture/agent-layer.md) (call chain and token
  custody), and the [mc-service domain data model](./architecture/data-model.md).
- **[projects/](projects/)** — one page per deployable unit or cross-cutting build concern: the
  [MCM monorepo itself](./projects/repository.md) (structure and working conventions), the
  [Expo/React Native universal app](./projects/expo-app.md) and its
  [design system](./projects/design-system.md), the
  [BFF](./projects/bff.md), the
  [mc-service (Rust/Axum)](./projects/mc-service.md), [Keycloak](./projects/keycloak.md), the
  [Agent Gateway (LangGraph)](./projects/agent-gateway.md) and its
  [three scoped MCP servers](./projects/mcp-servers.md), the
  [infrastructure-as-code stacks](./projects/infrastructure-stacks.md), the
  [CI/CD pipeline](./projects/ci-cd-pipeline.md), and
  [SAST & SCA static security scanning](./projects/sast.md).
- **[invariants/](invariants/)** — cross-cutting rules that span projects and are easy to violate: the
  [authentication and authorization chain](./invariants/auth-chain.md), the
  [final validation checklist](./invariants/feature-validation-checklist.md), the
  [secrets-management posture](./invariants/secrets-management.md),
  [model-provider environment scoping](./invariants/model-provider-scoping.md), the
  [published-port reservation convention](./invariants/published-port-reservation.md),
  [logging and audit conventions](./invariants/logging-and-audit.md),
  [testing tiers and what gates a merge](./invariants/testing-tiers.md),
  [Nx as the universal task runner](./invariants/nx-task-runner.md),
  [package-manager enforcement (pnpm only)](./invariants/package-manager-enforcement.md), and
  [RTK token compression](./invariants/rtk-token-compression.md).
- **[decisions/](decisions/)** — ratified architecture decision records:
  [ADR-0001: Production secrets-management standard](./decisions/adr-0001-prod-secrets-management.md)
  and
  [ADR-0002: Stateful major upgrades — OpenSearch 3 then Langfuse 4](./decisions/adr-0002-stateful-major-upgrades.md).
- **[gotchas/](gotchas/)** — standalone, non-obvious traps not scoped to a single invariant or project,
  covering SSRF guarding, cascade deletes, Docker-internal DNS, `.env` inline comments, Expo Router
  server export and transport traps, collection routing, external-ID URL opening, Keycloak
  service-account tokens, keyset pagination, musl-conditional OpenSSL vendoring, MongoDB index
  uniqueness, OTel span exception leaks, Playwright `testID` mapping, RFC 9457 problem details,
  layered role enforcement, `cargo fmt` scope, and Redis session lifecycle/eviction.
- **[runbooks/](runbooks/)** — one concept per live operator document under `docs/runbooks/`:
  [dev environment setup](./runbooks/dev-environment-setup.md) (host toolchain),
  [local dev infrastructure](./runbooks/local-dev.md),
  [the devcontainer (Docker Sandbox microVM, primary)](./runbooks/devcontainer-sandbox.md) and its
  [retained Docker Desktop / DinD path](./runbooks/devcontainer.md),
  [Android emulator & APK builds](./runbooks/android-emulator.md),
  [E2E testing](./runbooks/e2e-testing.md),
  [CI self-serve diagnostics](./runbooks/ci-diagnostics.md),
  [SAST & SCA scanning](./runbooks/sast-scanning.md),
  [DAST scanning (OWASP ZAP)](./runbooks/dast-scanning.md),
  [infra-image CVE scanning](./runbooks/infra-image-scanning.md),
  [the Renovate dependency bot](./runbooks/renovate.md),
  [the agent-driven backlog (Forgejo Issues)](./runbooks/backlog.md),
  [per-user collection backups (scheduled & on-demand)](./runbooks/backups.md),
  the production
  [homelab server setup](./runbooks/server-setup.md),
  [control tower (observability/audit/dormant Vault)](./runbooks/prod-control-tower.md),
  [data-tier authentication (MongoDB SCRAM)](./runbooks/prod-data-tier-auth.md), and
  [reboot resilience](./runbooks/prod-reboot-resilience.md) runbooks, plus the historical
  [Phase 15 operator checklist](./runbooks/phase-15-operator-checklist.md) and
  [OpenWiki bundle maintenance](./runbooks/wiki-maintenance.md) itself.
- **[process/](process/)** — how this repository itself is governed and how work moves through it: the
  [governing constitution](./process/constitution.md), the
  [proposal → spec → plan → tasks → implementation lifecycle](./process/spec-driven-development.md),
  [PR batching](./process/pull-request-batching.md),
  [feature-branch test scope](./process/feature-test-scope.md),
  [test authoring conventions](./process/test-authoring-conventions.md), and
  [how this wiki bundle itself is generated and maintained](./process/wiki-maintenance.md).

## Backlog

None currently tracked — every priority area named in `openwiki/INSTRUCTIONS.md` §4 has at least one
concept page, and the bundle has grown well beyond the original page set as new features (backups,
data-tier auth hardening, control-tower promotion, ADR-0002) landed. If a new canonical document lands
under `docs/runbooks/`, `docs/decisions/`, or the architecture docs without a citing concept, treat
that as a gap to close on the next update rather than a silent omission.
