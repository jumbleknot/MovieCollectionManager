# Implementation Plan: OpenWiki Automated Maintenance and Content Relocation

**Branch**: `044-openwiki-automation-migration` | **Date**: 2026-07-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/044-openwiki-automation-migration/spec.md`

## Summary

Three deferred items from feature 043, delivered as **Node ESM scripts plus one Forgejo workflow** — no
application code changes in any of the four existing projects.

1. **Bounded-slice generation** — a deterministic offline planner turns "what needs updating" into
   ordered slices (≤8 pages, never mixing a new bundle area with an existing one), and a verifier judges
   each slice by pages actually written plus continued bundle conformance. Research finding **R2** makes
   this non-optional: the generator has no programmatic scoping surface, so the slice bound is advisory
   text in a run message and **verification is the only real enforcement**.
2. **Change-triggered maintenance** — a new workflow debounced on a ~15-minute quiet `main` (concurrency
   cancel-restart, with a git-derived maximum-deferral cap), bounded per run, proposing its result as a
   single always-current pull request that a human merges. Consumes existing secrets only.
3. **Content relocation** — `CLAUDE.md` reduced to an index, its content moved into authoritative bundle
   concepts, with a hand-authored **protection manifest** outside the generator's write scope so a later
   refresh cannot silently paraphrase a load-bearing gotcha. Run through the same slice machinery
   (FR-027aa), so the trim doubles as User Story 1's acceptance evidence.

**One Phase 0 finding forced a spec amendment, now resolved** — see [research.md](research.md) R1:
OpenWiki 0.2.3 exposes no token or cost accounting, so FR-011's original spend ceiling was unmeasurable.
It was amended to a **page budget plus a wall-clock budget**, the two quantities this repository can
actually observe, and the feature now asserts no monetary bound at all (FR-011d).

## Technical Context

**Language/Version**: Node.js 24 (ESM, `.mjs`) — matches the existing `scripts/check-*.mjs` gate family
and the `node-version: 24` pin in CI.

**Primary Dependencies**: `node:` built-ins plus `yaml` (already a root dependency, already installed by
the `okf` job). OpenWiki `0.2.3` is invoked as a subprocess through the existing Nx target, never
directly. **No new runtime dependency.**

**Storage**: Version-controlled files only — a committed JSON state file for the run record and backlog,
and two hand-authored YAML governance files at the bundle root. No database, no cache, no volume.

**Testing**: `node --test scripts/__tests__/*.test.mjs`, auto-discovered by the `naming` job's shell
glob — a new test file needs **no workflow edit**. Gates ship with `--selftest` proving the detector
before it scans.

**Target Platform**: Forgejo Actions self-hosted runner (`ubuntu-latest`, capacity-1) and the local dev
container. Identical code path for both (FR-020).

**Project Type**: Repository tooling and governance — scripts, CI workflow, documentation. Touches no
deployable project (`mcm-app`, `mc-service`, `movie-assistant`, the MCP servers) and adds no container.

**Performance Goals**: Planner completes offline in < 5 s with no model call (FR-003). Governance gate
completes in < 10 s, inside the `okf` job's existing 10-minute budget. A no-op maintenance run costs
nothing (FR-012).

**Constraints**: Always-on gates stay keyless, offline and fail-closed. No egress-allowlist widening;
telemetry stays disabled by configuration. Generation only ever through the Nx target (pinned model,
raised heap, telemetry opt-out). The maintenance run must never be a required merge context and must not
contend with the merge-gating pipeline on the single runner.

**Scale/Scope**: 45 existing concepts across 8 bundle directories; `CLAUDE.md` at 592 lines / ~70 KB
across 38 sections is the relocation source; 17 canonical documents already cited.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1.*

| Principle | Status | Evidence |
|---|---|---|
| **AI Assistant Constraints — Technology Agnosticism** | ✅ PASS | `spec.md` carries no tech choices; every mechanism decision lives here and in `research.md` |
| **AI Assistant Constraints — Behavior-Descriptive Identifiers** | ✅ PASS | Scripts and rules are named for behaviour (`check-openwiki-governance`, `wiki-maintain`). No `FR-###` in any identifier; requirement provenance goes in a header comment, the one sanctioned WHAT-comment exception |
| **AI Assistant Constraints — Documentation** | ✅ PASS | The feature *is* documentation governance; `docs/runbooks/` gains a maintenance runbook and `openwiki/INSTRUCTIONS.md` gains the new exclusions |
| **Security — Secrets Management** | ✅ PASS | No new stored credential (R9). Both credentials already exist and are consumed from the Actions store, never argv, never logged. `secret-scan.mjs` and `check-topology-scrub.mjs` already cover every tracked file including generated pages |
| **Security — Principle of Least Privilege** | ⚠️ NOTED | Reusing the existing write token means the run *can* push to protected `main` when it only needs to open a proposal. FR-023a permits a narrower substitute; recorded as a residual, not a violation |
| **TDD (NON-NEGOTIABLE)** | ✅ PASS | Every script ships with `--selftest` plus a `node --test` unit suite. RED→GREEN is drivable offline against fixtures, exactly as 043 drove its gate. `tasks.md` will use the mandated TDD checkpoint format |
| **Test Type Integrity** | ✅ PASS | All new tests are genuine unit tests over fixtures — no external dependency to mock, no test placed under an `integration/` path |
| **Logging & Monitoring** | ✅ PASS (scoped) | These are CI scripts, not production services, so the structured-logger requirement does not attach. Failure evidence follows the feature-042 digest pattern (FR-018) |
| **Common Technology Stack — Nx** | ✅ PASS | Invocation is through Nx targets (`wiki-maintain`, `okf-lint`, plus the new governance gate); the CI workflow calls Nx or the script directly per the existing gate precedent |
| **Common Technology Stack — pnpm** | ✅ PASS | No new package; `pnpm install --frozen-lockfile` unchanged |
| **Monorepo Directory Structure** | ✅ PASS | `openwiki/` keeps its approved-deviation role; `docs/` stays the human-readable tree. Relocating `agent-layer.md` **into** `docs/runbooks/` moves toward the mandated structure, not away |
| **Backend / Frontend / Agent principles** | ➖ N/A | No service, UI, or agent code is touched |

**Gate result: PASS.** One residual (least privilege on the write token) and one specification tension
(R1, tracked below). Neither is an unjustified violation.

**Assumption carried forward and flagged**: FR-026c reads *regenerate* as governing an agent working
under human review, not as widening the generator's write scope. Every design decision here depends on
it — most visibly, nothing in this plan gives the generator write access outside `openwiki/`.

## Project Structure

### Documentation (this feature)

```text
specs/044-openwiki-automation-migration/
├── plan.md              # This file
├── research.md          # Phase 0 — 10 findings, R1 contradicts the spec
├── data-model.md        # Phase 1 — entities, state, file schemas
├── quickstart.md        # Phase 1 — runnable validation scenarios
├── contracts/           # Phase 1 — CLI + governance-file contracts
├── checklists/
│   └── requirements.md  # Spec quality checklist, 16/16
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
scripts/
├── wiki-maintain.mjs                       # NEW — plan / execute / verify orchestrator (US1, US2, US4)
├── check-openwiki-governance.mjs           # NEW — policy + protection + index gate (US3), keyless
├── check-openwiki-okf.mjs                  # UNCHANGED — V1–V13 bundle conformance; V12 stays report-only
└── __tests__/
    ├── wiki-maintain.test.mjs              # NEW — planner/verifier units, auto-globbed
    ├── check-openwiki-governance.test.mjs  # NEW — gate units, auto-globbed
    └── relocated-docs-links.test.mjs       # EXTENDED — guards the agent-layer move

openwiki/
├── INSTRUCTIONS.md                         # EXTENDED — new exclusions + protection rules
├── policy.yaml                             # NEW — per-path regeneration policy (hand-authored)
├── protected.yaml                          # NEW — protection manifest (hand-authored)
├── .maintenance-state.json                 # NEW — run record + backlog (committed, [skip ci])
└── <8 concept directories>                 # EXTENDED — authoritative concepts from the trim

.forgejo/workflows/
├── wiki-maintain.yml                       # NEW — debounced merge trigger + manual dispatch
└── guardrails.yml                          # EXTENDED — governance gate steps in the existing `okf` job

infrastructure-as-code/project.json         # EXTENDED — wiki-maintain + okf-governance targets

docs/
├── runbooks/agent-layer.md                 # MOVED from docs/agent-layer.md, content unchanged
└── runbooks/wiki-maintenance.md            # NEW — operator runbook

CLAUDE.md                                   # REWRITTEN to an index; 3 managed regions untouched
AGENTS.md, opencode.json, .claude/          # RECONCILED — no surface points at moved content
```

**Structure Decision**: Everything lands in existing trees following existing idioms. `scripts/` +
`scripts/__tests__/` is the established home for repository gates (nine siblings, auto-globbed tests).
The governance gate is a **new script rather than an extension** of `check-openwiki-okf.mjs`, keeping
bundle conformance and governance separately testable (R5). The maintenance workflow is a **new workflow**
because it is the only non-keyless, non-merge-gating automation here; the governance gate instead becomes
**steps in the existing `okf` job**, which avoids a new CI failure-digest obligation (R5).

## Phase 1 Design Overview

Detail lives in [data-model.md](data-model.md) and [contracts/](contracts/); the shape is:

- **Planner** (offline, no model) reads the run record, the git range since it, the bundle state and the
  backlog → emits an ordered slice list, each naming one bundle area and ≤8 pages, never mixing a new
  area with an existing one. Output is inspectable before any spend (FR-004).
- **Executor** renders each slice into a run message (R2 — the only scoping surface), invokes the Nx
  target, then hands to the verifier.
- **Verifier** counts pages actually written and re-runs the conformance gate. Exit status is ignored by
  construction (FR-005); zero pages is a failure with the slice still outstanding (FR-006).
- **Budget guard** tracks pages written and elapsed time between slices, refusing to start one once either
  budget is reached and carrying it forward (FR-011). Pages are counted from the working tree, never from
  the generator's self-report — the same anti-false-green rule as the verifier.
- **Governance gate** validates `policy.yaml` covers every documentation path, that protected passages
  still match their fingerprints, that protection is only ever attached to authoritative concepts, and
  that `CLAUDE.md` holds nothing but its index and managed regions.

## Complexity Tracking

| Violation / Tension | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| ~~FR-011 spend ceiling on an estimate~~ **RESOLVED — spec amended to page + wall-clock budgets** | R1: OpenWiki 0.2.3 emits no token or cost data, and no interception point exists for a bundled CLI | A calibrated cost estimate was rejected by the maintainer: with no cost data in the repository to calibrate against, it would have read as a monetary guarantee while being a fabrication. The Anthropic usage API would need a new admin credential, breaking FR-023. No complexity remains — the amended budgets are simpler than what they replaced |
| **Two gate scripts instead of one** | Bundle conformance (V1–V13) and governance are independently testable concerns with different failure semantics | Extending the 424-line existing gate doubles the blast radius of any change to either, and would mix a report-only drift warning with fail-closed protection rules |
| **A committed state file** | Runners are ephemeral, and FR-012 requires the marker to advance on runs that create no proposal | Deriving state from git history cannot distinguish "covered, found nothing" from "never covered", which FR-017 requires reporting separately |
| **Reusing the broad write token** | FR-023 forbids adding a credential; the existing token is the only write-capable one | A narrower token is preferable on least-privilege grounds and FR-023a allows it, but minting one adds a store entry this feature promised not to add. Recorded as a residual for the operator to decide |
