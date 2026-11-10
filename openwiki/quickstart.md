---
type: Reference
title: OpenWiki quickstart — MovieCollectionManager
description: The root entry point to this repository's OpenWiki bundle — what the bundle is and is not, how to query it by type, tag, resource or directory, a task-routing map to the major concept areas, and how the coverage rule and the derived-versus-authoritative split decide where a new learning belongs.
tags: [openwiki, navigation, quickstart]
resource: openwiki/INSTRUCTIONS.md
resource-sha256: 6a1747c54fd47713d072bce19306d5445957171fcf0a5d7662f17497465f09ab
generated: { by: "openwiki/0.7.1", at: "2026-11-06T07:34:17.095Z" }
timestamp: 2026-11-10T11:26:50.302Z
---

# OpenWiki quickstart — MovieCollectionManager

This bundle is a **navigation and gotcha layer** over documentation that already exists in this
repository — not a second copy of it. MovieCollectionManager already has an architecture overview,
operator runbooks, architecture decision records, a governing constitution, and per-project READMEs;
this wiki's job is to make that material *findable and safe to act on* without re-derailing you into
reading every source document from scratch.

Every concept page in this bundle follows the same shape: a short **distilled summary** of the
subject, its **load-bearing gotchas** (the non-obvious traps that cost a developer a session when
missed — the highest-value content on any page), and — when the page is a derived summary — a
`resource` link to the authoritative source for full detail. If you need the complete step-by-step
procedure, follow the `resource` link; the page itself will not replay it. See
[the generation brief](./INSTRUCTIONS.md) for the scope, the exclusions, and the rule for where a new
learning belongs.

## How to query this bundle

Every page carries OKF front matter (`type`, `title`, `description`, `tags`, and a `resource` when the
page is a derived summary). Use these fields rather than guessing filenames:

- **By `type`** — filter to a category: `Architecture` (system and pipeline maps), `Service`
  (per-deployable-unit overviews), `Convention` / `Decision` (cross-cutting rules and ratified
  decisions), `Gotcha` (traps), `Runbook` (operator procedures), `Process` (how work moves through the
  repository), or `Reference` (this page and the repository tour). A page's type does **not** follow
  from its directory: `projects/` mixes `Service`, `Architecture`, `Reference` and `Convention` pages,
  and `process/constitution.md` is typed `Decision`.
- **By `tags`** — cross-cutting themes such as `auth`, `secrets`, `mongodb`, `ci`, or `openwiki`
  span multiple pages regardless of directory; a tag search surfaces all of them together.
- **By `resource`** — every derived page cites its canonical source as a repository-relative path
  (verified to resolve by the conformance gate) or an external URL. A `resource` names **one canonical
  file, never a directory**, and records that file's fingerprint as `resource-sha256`: the required
  `okf` check (**V17**) fails a PR whose summary no longer matches its source, so the session that
  changes a source refreshes its summary in the same PR, and **G14** refuses a directory or a
  bot-rewritten file as a `resource`. A page with **no** `resource` is
  *authoritative* — canonical in its own right, and listed under `authoritative:` in
  [the protection manifest](./protected.yaml). That split is a ratified decision, not a convention:
  [ADR-0003](./decisions/adr-0003-claims-and-fingerprints.md) made Grounded Claims (on derived pages)
  and the `protected.yaml` fingerprints (on authoritative pages) complements, and
  [ADR-0004](./decisions/adr-0004-session-maintained-wiki.md) replaced its Claims half with the source
  fingerprint above. Governance rule **G11** rejects any concept that is both or neither (a dangling
  citation classifies as neither, not as derived). The
  four reserved bundle files (`index.md`, `INSTRUCTIONS.md`, `log.md` and this quickstart) are not
  concepts at all, so the governance gate's classification check skips them; that is why this page may
  carry a `resource` without appearing under `authoritative:`. The conformance gate draws the reserved
  line more narrowly — it exempts `index.md` from the required `type` and skips `INSTRUCTIONS.md`
  entirely — so this page is still validated as a concept and must carry a front matter block that
  parses, with a `type`. If a document under `docs/runbooks/`,
  `docs/decisions/`, or the architecture docs has no citing concept page, that is a real gap, not an
  oversight — the brief requires every such document to be reachable by a metadata query.
- **By directory** — each section below is one directory under `openwiki/`, with its own `index.md`
  listing every page and its description. The conformance gate fails a directory that has concepts but
  no index, and a page its own index does not list.

In-repo links in this bundle are written **relative to the file they appear in**; a site-root-absolute
link renders as a forge URL and 404s. That rule exists because 204 such links went unnoticed across the
bundle before anyone checked (item 491).

## Start here by task

| If you are… | Read |
| --- | --- |
| Setting up a dev machine or dev container | [host toolchain setup](./runbooks/dev-environment-setup.md), the [dev container on a Docker Sandbox microVM](./runbooks/devcontainer-sandbox.md) and its [lifecycle half](./runbooks/devcontainer-sandbox-lifecycle.md) (recreate-from-nothing, the resizable volumes, the disk and memory symptoms, the destructive verification harness and the `sbx` upgrade ritual), the [retained DinD path](./runbooks/devcontainer.md), [local dev infrastructure](./runbooks/local-dev.md), [dev-stack env files](./projects/stacks.md) |
| Finding your way around the repository | [the monorepo itself](./projects/repository.md) — layout, toolchain and lint conventions, the mandatory pre-work gates |
| Changing mc-service domain logic | [mc-service](./projects/mc-service.md), [the domain data model](./architecture/data-model.md), [testing tiers](./invariants/testing-tiers.md), [test authoring conventions](./process/test-authoring-conventions.md) |
| Changing the client or the BFF | [the Expo/React Native app](./projects/expo-app.md), [its design system](./projects/design-system.md), [the BFF](./projects/bff.md) |
| Touching auth, sessions or roles | [the auth chain](./invariants/auth-chain.md), [Keycloak](./projects/keycloak.md), [session lifecycle and eviction](./gotchas/session-lifecycle-and-eviction.md), [role enforcement as a layer](./gotchas/role-enforcement-is-a-layer.md) |
| Working on the AI agent layer | [the AI Agents layer architecture](./architecture/agent-layer.md), [the Agent Gateway](./projects/agent-gateway.md), [the three scoped MCP servers](./projects/mcp-servers.md), [model-provider environment scoping](./invariants/model-provider-scoping.md) |
| Deploying or operating production | [infrastructure stacks](./projects/infrastructure-stacks.md), [the CI/CD pipeline](./projects/ci-cd-pipeline.md), [server setup](./runbooks/server-setup.md), [control tower](./runbooks/prod-control-tower.md), [data-tier authentication](./runbooks/prod-data-tier-auth.md), [reboot resilience](./runbooks/prod-reboot-resilience.md), [port reservation](./invariants/published-port-reservation.md), [ADR-0001](./decisions/adr-0001-prod-secrets-management.md), [ADR-0002](./decisions/adr-0002-stateful-major-upgrades.md) |
| Diagnosing a red build or a flaky test | [CI self-serve diagnostics](./runbooks/ci-diagnostics.md), [the CI evidence pipeline](./runbooks/ci-evidence-pipeline.md), [E2E testing](./runbooks/e2e-testing.md), [testing tiers](./invariants/testing-tiers.md), [Renovate](./runbooks/renovate.md) |
| Running or triaging a security scan | [SAST & SCA project page](./projects/sast.md), [the SAST/SCA runbook](./runbooks/sast-scanning.md), [DAST](./runbooks/dast-scanning.md), [infra-image scanning](./runbooks/infra-image-scanning.md), [secrets-management posture](./invariants/secrets-management.md) |
| Touching backups or account deletion | [per-user collection backups](./runbooks/backups.md), [the prod host restic backup](./projects/backup.md), [the BFF](./projects/bff.md) |
| Picking up work | [the agent-driven backlog](./runbooks/backlog.md), [spec-driven development](./process/spec-driven-development.md), [PR batching](./process/pull-request-batching.md), [feature-branch test scope](./process/feature-test-scope.md) |
| Maintaining this wiki | [bundle maintenance](./runbooks/wiki-maintenance.md), [the process view of it](./process/wiki-maintenance.md), [ADR-0004: session-maintained summaries](./decisions/adr-0004-session-maintained-wiki.md), [ADR-0003: Claims and fingerprints](./decisions/adr-0003-claims-and-fingerprints.md), [the wiki-refresh skill](../.claude/skills/wiki-refresh/SKILL.md), [the regeneration policy](./policy.yaml), [the protection manifest](./protected.yaml) |

## Concept areas

- **[architecture/](./architecture/)** — the whole-system map: the
  [system overview](./architecture/system-overview.md), the
  [AI Agents layer architecture](./architecture/agent-layer.md) (call chain and token custody), and the
  [mc-service domain data model](./architecture/data-model.md).
- **[projects/](./projects/)** — one page per deployable unit or cross-cutting build concern: the
  [MCM monorepo itself](./projects/repository.md) (structure and working conventions), the
  [Expo/React Native universal app](./projects/expo-app.md) and its
  [design system](./projects/design-system.md), the [BFF](./projects/bff.md), the
  [mc-service (Rust/Axum)](./projects/mc-service.md), [Keycloak](./projects/keycloak.md), the
  [Agent Gateway (LangGraph)](./projects/agent-gateway.md) and its
  [three scoped MCP servers](./projects/mcp-servers.md), the
  [infrastructure-as-code stacks](./projects/infrastructure-stacks.md), the
  [dev-stack env-file contract](./projects/stacks.md), the
  [CI/CD pipeline](./projects/ci-cd-pipeline.md),
  [SAST & SCA static security scanning](./projects/sast.md), and the
  [prod host backup (restic)](./projects/backup.md) with its failure alerting.
- **[invariants/](./invariants/)** — cross-cutting rules that span projects and are easy to violate: the
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
- **[decisions/](./decisions/)** — ratified architecture decision records:
  [ADR-0001: Production secrets-management standard](./decisions/adr-0001-prod-secrets-management.md),
  [ADR-0002: Stateful major upgrades — OpenSearch 3 then Langfuse 4](./decisions/adr-0002-stateful-major-upgrades.md),
  and
  [ADR-0003: Grounded Claims and protected-passage fingerprints are complements](./decisions/adr-0003-claims-and-fingerprints.md),
  the governance decision that makes the derived-versus-authoritative split above enforceable, and
  [ADR-0004: wiki summaries are maintained by the coding session](./decisions/adr-0004-session-maintained-wiki.md),
  which supersedes its Claims half.
- **[gotchas/](./gotchas/)** — standalone, non-obvious traps not scoped to a single invariant or project,
  covering SSRF guarding, cascade deletes, Docker-internal DNS, `.env` inline comments, Expo Router
  server export and transport traps, collection routing, external-ID URL opening, Keycloak
  service-account tokens, keyset pagination, musl-conditional OpenSSL vendoring, MongoDB index
  uniqueness, OTel span exception leaks, Playwright `testID` mapping, RFC 9457 problem details,
  layered role enforcement, `cargo fmt` scope, and Redis session lifecycle/eviction.
- **[runbooks/](./runbooks/)** — one concept per live operator document under `docs/runbooks/`, 21 pages:
  [dev environment setup](./runbooks/dev-environment-setup.md) (host toolchain),
  [local dev infrastructure](./runbooks/local-dev.md),
  [the devcontainer (Docker Sandbox microVM, primary)](./runbooks/devcontainer-sandbox.md) and its
  [lifecycle half](./runbooks/devcontainer-sandbox-lifecycle.md) (recreate-from-nothing, the three
  creation-time-resizable volumes and the disk and memory symptoms a full or exhausted VM produces,
  the verification harness, and the ritual before upgrading the `sbx` binary),
  the [retained Docker Desktop / DinD path](./runbooks/devcontainer.md),
  [Android emulator & APK builds](./runbooks/android-emulator.md),
  [E2E testing](./runbooks/e2e-testing.md),
  [CI self-serve diagnostics](./runbooks/ci-diagnostics.md),
  [the CI evidence pipeline](./runbooks/ci-evidence-pipeline.md),
  [SAST & SCA scanning](./runbooks/sast-scanning.md),
  [DAST scanning (OWASP ZAP)](./runbooks/dast-scanning.md),
  [infra-image CVE scanning](./runbooks/infra-image-scanning.md),
  [the Renovate dependency bot](./runbooks/renovate.md),
  [the agent-driven backlog (Forgejo Issues)](./runbooks/backlog.md),
  [per-user collection backups (scheduled & on-demand)](./runbooks/backups.md),
  the production
  [homelab server setup](./runbooks/server-setup.md),
  [control tower (observability/audit/dormant Vault)](./runbooks/prod-control-tower.md),
  [data-tier authentication (MongoDB SCRAM)](./runbooks/prod-data-tier-auth.md) and
  [reboot resilience](./runbooks/prod-reboot-resilience.md) runbooks, plus the historical
  [Phase 15 operator checklist](./runbooks/phase-15-operator-checklist.md) and
  [OpenWiki bundle maintenance](./runbooks/wiki-maintenance.md) itself. The one operator document
  summarized elsewhere is `docs/runbooks/agent-layer.md`, whose concept is
  [the AI Agents layer architecture](./architecture/agent-layer.md).
- **[process/](./process/)** — how this repository itself is governed and how work moves through it: the
  [governing constitution](./process/constitution.md), the
  [proposal → spec → plan → tasks → implementation lifecycle](./process/spec-driven-development.md),
  [PR batching](./process/pull-request-batching.md),
  [feature-branch test scope](./process/feature-test-scope.md),
  [test authoring conventions](./process/test-authoring-conventions.md), and
  [how this wiki bundle itself is generated and maintained](./process/wiki-maintenance.md).

## Coverage, gaps, and where a new learning goes

The brief requires one concept page per canonical document under `docs/runbooks/`, `docs/decisions/`,
and the architecture documents, so the *absence* of a concept reliably means "no such document" rather
than "not covered yet". Two things deliberately have none: `docs/proposals/**` (pre-specification
ideation, superseded the moment a spec exists — see
[Spec-driven development](./process/spec-driven-development.md)) and `docs/test-data/**` (a binary
unit-test fixture, not documentation). Both are declared `excluded` — never analyzed, never written —
in [the regeneration policy](./policy.yaml), and the brief states them explicitly rather than leaving
them to be inferred from a general binary-asset rule.

That coverage guarantee is scoped to those three document families. `specs/**` is a fourth declared
state — *analyzable, not a coverage target* — so specs are read freely as context (a measured fact is
often recorded nowhere else) but there is deliberately no concept per feature, and `specs/*/HANDOFF.md`
is the named exception because those carry live measured knowledge rather than history. A spec is also
never the current state: when one disagrees with a runbook, a decision record or the code, the later
source wins.

The runbooks area covers every live operator document, including
[the CI evidence pipeline](./runbooks/ci-evidence-pipeline.md) and
[the dev-container sandbox lifecycle](./runbooks/devcontainer-sandbox-lifecycle.md). Adding a canonical
document therefore means adding a concept page **and** an entry in its directory's `index.md` in the
same change, or the conformance gate fails the build.

A durable learning goes to the **canonical home of its subject**, decided from the concept covering it:
into the cited source when the concept is a derived summary — refreshing the summary in the same PR —
into the concept itself when it is authoritative, and into a new concept when none covers the subject.
Never append the detail only to a derived page, and never to `CLAUDE.md`, which is an index into this
bundle.

Both gates that police the bundle run offline and keyless, so checking it never needs the paid
generator: `pnpm nx okf-lint infrastructure-as-code` for conformance (rules V1–V15 and V17) and
`pnpm nx okf-governance infrastructure-as-code` for the policy, protection and classification rules
(rules G0–G12 and G14). Both are fail-closed — an absent or partially-written bundle, or a missing
governance file, is a violation rather than a skip — and neither has a skip flag or an allowlist, so a
rejected page is fixed in the page (or in [the generation brief](./INSTRUCTIONS.md), for a rebuild)
rather than accepted. Refreshing a page is free too: `node scripts/wiki-refresh.mjs --stale`, then
`--diff` and `--record` per page, with no credential and no model call. The paid generator is only a
manual rebuild of named pages (`pnpm nx wiki-maintain infrastructure-as-code --args="--pages …"`).
