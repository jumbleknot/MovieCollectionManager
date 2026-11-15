# Implementation Plan: Doc-Drift Prevention (doc-impact sweep + periodic drift audit)

**Branch**: `101-doc-drift-prevention` | **Date**: 2026-11-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/101-doc-drift-prevention/spec.md`

## Summary

Add a Spec Kit **project override** of the tasks template. It carries a required doc-impact sweep
task and a `forked-from` fingerprint header. A deterministic guard
(`scripts/check-speckit-overrides.mjs`, run in guardrails) fails when an upgrade changes the core
template, the override goes missing or loses the sweep, or override-first resolution breaks. Only
the guard's `--record` mode writes the fingerprint. The rule is made durable in the constitution
(v2.10.0) and the canonical validation checklist. One new runbook,
`docs/runbooks/doc-drift.md`, carries both the Spec Kit upgrade procedure and the quarterly
drift-audit procedure, with a derived wiki page. The next audit is filed as a dated backlog item.

## Technical Context

**Language/Version**: Node.js 26 (ESM `.mjs`, the repo's gate-script convention), no new dependencies.

**Primary Dependencies**: `node:crypto` (SHA-256), `node:child_process` (`git log`/`git show`/`git diff`
for the fork-base diff), `scripts/lib/argv-contract.mjs` (the shared rejecting argument parser).

**Storage**: Files only. The fork point lives in the override's first line.

**Testing**: `node --test scripts/__tests__/check-speckit-overrides.test.mjs`, which the guardrails
glob `scripts/__tests__/*.test.mjs` picks up automatically. The gate also has its own `--selftest`,
matching the sibling gates.

**Target Platform**: The dev container and the Forgejo guardrails runner (Linux). Spec Kit's
scripts are PowerShell (`init-options.json`: `"script": "ps"`). The guard reads them as text and
never executes them.

**Project Type**: Repository tooling and process docs. No deployable unit changes.

**Performance Goals**: The guard finishes in well under a second (it reads 3 files and makes at
most a few git calls, only on mismatch).

**Constraints**: No model call in CI (proposal non-goal). No edit to any Spec Kit-owned file
(`speckit.manifest.json`, `claude.manifest.json`). The fingerprint is never hand-typed (the V17
rule). An unknown argument is rejected, never defaulted (CLAUDE.md, the instrument gate).

**Scale/Scope**: 1 new template, 1 new gate script + test, 1 new runbook + 1 wiki page, 3 edited
governance docs, 1 workflow step, 1 backlog item.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status |
|---|---|
| AI Assistant Constraints: Documentation ("relevant documentation must be updated") | **Strengthened.** This feature turns that sentence into a searched, recorded obligation. |
| Behavior-Descriptive Identifiers | Pass. `check-speckit-overrides.mjs`, `checkSpeckitOverrides()`, `recordForkPoint()`. No FR IDs in names. |
| Technology Agnosticism in Specification | Pass. spec.md names the framework as the protected domain object only, and every mechanism is here. |
| Test-Driven Development (Verify RED → Verify GREEN) | Pass. Each guard condition gets a failing test first (tasks follow `docs/templates/feature-test-tasks-template.md`). |
| Secrets Management | N/A. No credentials. The backlog write uses the existing `MCM_FORGE_ISSUE_TOKEN`. |
| Nx as task runner | Note. The gate runs as `node scripts/…` like every sibling guardrail step, and no nx target is added (precedent: `check-toolchain-consistency.mjs`). |
| Governance: amendments need a version bump and history | Pass. v2.9.0 → **v2.10.0** (MINOR: a new obligation, no principle redefined). |

No violations, so Complexity Tracking stays empty. Post-design re-check: unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/101-doc-drift-prevention/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1: fork-point header, guard result
├── quickstart.md        # Phase 1: RED/GREEN demonstration + scratch /speckit-tasks run
├── contracts/
│   └── check-speckit-overrides.md   # CLI contract: modes, exit codes, messages
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
.specify/templates/overrides/
└── tasks-template.md                 # NEW: fork of core + sweep task + forked-from header
scripts/
├── check-speckit-overrides.mjs       # NEW: guard (scan / --record / --selftest / --help)
└── __tests__/
    └── check-speckit-overrides.test.mjs   # NEW
.forgejo/workflows/guardrails.yml     # +1 step: selftest + scan
.specify/memory/constitution.md       # Documentation bullet + v2.10.0 history
openwiki/invariants/feature-validation-checklist.md   # canonical: close-out re-search item
openwiki/process/constitution.md      # derived: refresh (V17)
docs/runbooks/doc-drift.md            # NEW: Spec Kit upgrade + drift audit procedures
openwiki/runbooks/doc-drift.md        # NEW derived page citing it
openwiki/runbooks/index.md, CLAUDE.md # index entries (governance G8–G10)
docs/proposals/PRD-DocDriftPrevention.md  # §7 answers (done in the spec commit)
```

**Structure Decision**: The guard follows the existing `scripts/check-*.mjs` gate pattern
(`--selftest` plus scan, a guardrails step through `ci-log-step.sh`). The procedures get a **new**
runbook rather than a section of `wiki-maintenance.md`. That runbook is about the wiki-from-docs
direction (V17), while this one is about docs-from-code. A concurrent session
(`docs/pnpm-after-corepack`) is also editing `wiki-maintenance.md`, so a separate file avoids a
conflict.

## Complexity Tracking

None.
