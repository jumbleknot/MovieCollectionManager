---
type: Reference
title: OpenWiki quickstart — MovieCollectionManager
description: The root entry point for this repository's OpenWiki bundle — what it is, how it is organized, how to query it by type or tag, and links to every concept area.
resource: openwiki/INSTRUCTIONS.md
tags: [openwiki, navigation, quickstart]
timestamp: 2026-07-28T02:22:54.286Z
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
[Spec-driven development](/openwiki/process/spec-driven-development.md)).

## How to query this bundle

Every page carries OKF front matter (`type`, `title`, `description`, `tags`, `resource`, `timestamp`).
Use these fields rather than guessing filenames:

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
  [system overview](/openwiki/architecture/system-overview.md), the
  [AI Agents layer architecture](/openwiki/architecture/agent-layer.md) (call chain and token
  custody), and the [mc-service domain data model](/openwiki/architecture/data-model.md).
- **[projects/](projects/)** — one page per deployable unit: the
  [Expo/React Native universal app](/openwiki/projects/expo-app.md) and its
  [design system](/openwiki/projects/design-system.md), the
  [BFF](/openwiki/projects/bff.md), the
  [mc-service (Rust/Axum)](/openwiki/projects/mc-service.md), the
  [Agent Gateway (LangGraph)](/openwiki/projects/agent-gateway.md) and its
  [three scoped MCP servers](/openwiki/projects/mcp-servers.md), the
  [infrastructure-as-code stacks](/openwiki/projects/infrastructure-stacks.md), and the
  [CI/CD pipeline](/openwiki/projects/ci-cd-pipeline.md).
- **[invariants/](invariants/)** — cross-cutting rules that span projects and are easy to violate: the
  [authentication and authorization chain](/openwiki/invariants/auth-chain.md), the
  [secrets-management posture](/openwiki/invariants/secrets-management.md),
  [model-provider environment scoping](/openwiki/invariants/model-provider-scoping.md), the
  [published-port reservation convention](/openwiki/invariants/published-port-reservation.md),
  [logging and audit conventions](/openwiki/invariants/logging-and-audit.md),
  [testing tiers and what gates a merge](/openwiki/invariants/testing-tiers.md), and
  [Nx as the universal task runner](/openwiki/invariants/nx-task-runner.md).
- **[decisions/](decisions/)** — ratified architecture decision records, starting with
  [ADR-0001: Production secrets-management standard](/openwiki/decisions/adr-0001-prod-secrets-management.md).
- **[gotchas/](gotchas/)** — standalone, non-obvious traps not scoped to a single invariant or project,
  covering pagination, SSRF guarding, cascade deletes, index uniqueness, telemetry leaks, build
  quirks, and the Expo/agent-transport edge cases.
- **[runbooks/](runbooks/)** — one concept per live operator document under `docs/runbooks/`: local
  dev, the devcontainer, CI diagnostics, security scanning (SAST/DAST/infra-image), E2E and mobile
  testing, and the production bring-up/reboot/data-tier runbooks.
- **[process/](process/)** — how this repository itself is governed and how work moves through it: the
  [governing constitution](/openwiki/process/constitution.md), the
  [proposal → spec → plan → tasks → implementation lifecycle](/openwiki/process/spec-driven-development.md),
  and [how this wiki bundle itself is generated and maintained](/openwiki/process/wiki-maintenance.md).

## Backlog

None currently tracked — every priority area named in `openwiki/INSTRUCTIONS.md` §4 has at least one
concept page. If a new canonical document lands under `docs/runbooks/`, `docs/decisions/`, or the
architecture docs without a citing concept, treat that as a gap to close on the next update rather than
a silent omission.
