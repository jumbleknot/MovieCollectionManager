# Implementation Plan: Repo-scoped CI evidence-bundle package

**Branch**: `106-repo-scoped-ci-failures` | **Date**: 2026-11-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/106-repo-scoped-ci-failures/spec.md`

## Summary

The failure digest publishes evidence to the owner-level generic package `ci-failures`. BELAY, under
the same owner, now runs the same digest, so this repository moves to `<repo>-ci-failures`
(`mcm-ci-failures`), derived from the repository identity the scripts already resolve.

One exported function in `scripts/ci-failure-digest.mjs` names the package. A second names the list
readers use, `[repo-scoped, legacy]`. Every writer, reader and pruner goes through them:

- **Writer**: the digest uploads only to the repo-scoped name, and the bundle reference and link name
  it too.
- **Pruner**: the digest's age-based prune lists and deletes by exact name across both, each version
  deleted under the package it was listed from. This is what drains legacy.
- **Readers**: `ci-status` lists both packages, dedupes by version (repo-scoped wins), and orders by
  run id. Fetch tries repo-scoped, then legacy. Durations fetches each file from the version's own
  package.
- **Retention**: the committed YAML lists both names with the same window. The loader's short-window
  refusal applies to every evidence package (`ci-failures` or `*-ci-failures`), not the literal
  `ci-failures`.

Docs, the 042 bundle-layout contract and their wiki summaries move to the new name, and the runbook
records the legacy drop date (cutover + 30 days).

## Technical Context

**Language/Version**: Node.js ESM. CI runs Node 26.13.1, the pinned setup-node: guardrails since
#1096, app-ci already. Locally, any Node satisfying `engines.node >=22.13`.

**Primary Dependencies**: none new. `yaml` (already a root dependency) for the retention config.

**Storage**: Forgejo generic package registry (owner-level packages). No schema; versions are
`<runId>--<jobSlug>` holding `bundle.json.gz` and the durations file.

**Testing**: `node:test` unit tests in `scripts/__tests__` with injected fake forge transports (the
existing seams), plus the scripts' `--selftest` modes.

**Target Platform**: Forgejo Actions runners (`ubuntu-latest` container, `kvm` host) and developer
machines (ci-status).

**Project Type**: repository CI/ops tooling (scripts), not a product surface.

**Performance Goals**: listing two packages instead of one doubles a paginated listing that is
already ≤ 100 pages of 50. Bundle fetch adds at most one 404 round trip for a legacy-only run.

**Constraints**: never write to, or silently fall back to, the legacy name. Never list, fetch or
delete another repository's package (search is by substring, so filter by exact name). Legacy links
keep resolving until the versions expire.

**Scale/Scope**: 3 scripts, 1 config, 3 test files, 1 contract, ~5 runbooks/docs and their wiki
summaries.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies | Assessment |
|-----------|---------|------------|
| Spec-driven development | Yes | This spec → plan → tasks set exists before code. Required because `infrastructure-as-code/forgejo/registry-retention.yaml` changes. |
| Test-Driven Development | Yes | Every behaviour change gets a failing unit test first (RED/GREEN in tasks.md). Test cases are reviewed by the operator before implementation. |
| Test Type Integrity | Yes | Unit tests use the scripts' injected fake transports. That is a unit test of request construction and selection logic, labelled as such. Real-forge behaviour is verified by the quickstart's post-merge checks, not by a mocked "integration" test. |
| Monorepo Build Tool (Nx) | Partially | The scripts and their tests are invoked directly with `node`, the existing convention for every `scripts/` gate (specs/061 Complexity Tracking). Constitution v2.12.0 (PR #1097) sanctions it as an explicit exception. No Nx target is added. |
| Logging & audit / never-log | Yes | No new output carries a token. Existing redaction (`redactForPublication`) still wraps prune errors; package names and versions are not sensitive. |
| Secrets management | No change | Same `CI_DIGEST_TOKEN` / `MCM_FORGE_TOKEN` scopes; a new package name under the same owner needs no new grant (Assumption). |
| Documentation / doc-impact sweep (v2.10.0) | Yes | `ci-failures` and `BUNDLE_PACKAGE` are swept at task generation and close-out, recorded in tasks.md. |
| Security / Auth / API-First / Clean Architecture / Rust / Frontend / AI Agents | No | No service, request path, credential flow, user data or domain model changes. |
| Final validation checklist (web E2E regression) | No | The change touches no application code, image or deployed stack, so there is nothing for the web E2E suite to exercise. The CI run of this PR exercises the changed scripts. |

**Post-Phase-1 re-evaluation**: no violation. The design adds two exported naming functions and
changes the call sites that build package URLs. No new project, dependency, CI step or abstraction
layer.

## Project Structure

### Documentation (this feature)

```text
specs/106-repo-scoped-ci-failures/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── evidence-package.md   # naming + transition contract (supersedes 042 bundle-layout's "constant")
├── checklists/requirements.md
└── tasks.md                  # /speckit-tasks
```

### Source Code (repository root)

```text
scripts/
├── ci-failure-digest.mjs        # bundlePackageFor(), bundlePackagesFor(), LEGACY_BUNDLE_PACKAGE;
│                                #   upload/list/delete/bundleRef/bundleUrl use them
├── ci-status.mjs                # list both, dedupe, fetch new→legacy, durations per-version package
├── registry-retention.mjs       # short-window guard for every evidence package name
└── __tests__/
    ├── ci-failure-digest.test.mjs
    ├── ci-status.test.mjs
    └── registry-retention.test.mjs
infrastructure-as-code/forgejo/registry-retention.yaml   # both names, same window
specs/042-ci-self-serve-diagnostics/contracts/bundle-layout.md (+ digest-format.md example)
docs/runbooks/ci-diagnostics.md, ci-evidence-pipeline.md, wiki-maintenance.md, Server-Setup-Runbook.md
openwiki/** summaries whose resource is one of the above (wiki-refresh --stale)
```

**Structure Decision**: no new files outside the spec directory. Each change lands in the script
that already owns that concern.

## Complexity Tracking

No violations to justify.
