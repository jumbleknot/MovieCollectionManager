# Implementation Plan: Re-plan wiki concepts that fell behind the maintenance marker

**Branch**: `082-wiki-drift-replanning` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/082-wiki-drift-replanning/spec.md`

**Gate before implementation:** the operator ratifies the proposed decision in spec FR-001 and FR-004
(bounded drift slices, plus the report). Until then this plan is a proposal, and no task below starts.

## Summary

The planner learns a second source of work beside "documentation changed since the marker": concepts
that V12 flags as stale. It plans at most `DRIFT_PAGES_PER_RUN` (2) of them per run, oldest first, and
only within the page budget left over. Parking becomes a recorded field that drift and change-driven
planning both respect. `--plan` reports drift as planned, deferred, parked and unplannable. V12 stays
warn-only, and the budget is unchanged.

## Technical Context

- **Language/Version**: Node.js ESM scripts, as `scripts/wiki-maintain.mjs`. No new dependency.
- **Primary Dependencies**: git (commit dates), the existing OKF gate and stamp helpers.
- **Storage**: `openwiki/.maintenance-state.json`, which gains a `parked` field.
- **Testing**: `node --test scripts/__tests__/*.test.mjs` (node flags BEFORE paths), with fixture git
  repositories as in `wiki-maintain.test.mjs`. Offline and free.
- **Target Platform**: the Forgejo `wiki-maintain` job, and local `--plan`.
- **Constraints**: `PAGE_BUDGET` = 8, a 4-minute start deadline, and V12 never failing a build.
- **Scale/Scope**: about 70 concepts. A drift scan is one `git log -1` per cited file, cached.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after design. No violations.*

| Principle | Assessment |
|---|---|
| **TDD (NON-NEGOTIABLE)** | PASS. Every behaviour (drift selection, the bound, parking, the report, migration) gets a fixture test verified RED first. `tasks.md` carries the Verify RED / Verify GREEN commands. |
| **Test Type Integrity** | PASS. Pure fixture repositories, with no generator and no network. SC-001's "re-planned eventually" is demonstrated by driving successive plans and executions with a stub generator. |
| **Nx as universal task runner** | PASS. `wiki-plan` and `wiki-maintain` remain the entry points. No new target. |
| **Cost control** | PASS. Drift only spends budget that is left over (FR-001, FR-008), and parking stops known-failing pages being paid for (FR-005). |
| **Docs as canonical home** | PASS. The runbook is rewritten in place (FR-010). The brief gains the file-`resource` rule (FR-009). |

## Design

### D1. One drift comparison: `scripts/openwiki-drift.mjs` (new, pure plus git)

`sourceCommitAfterStamp({ root, fields, resource, fallbackToMtime })` → `{ stale, sourceDate, stamp } | null`
(null: cannot judge). It is extracted from V12 (`check-openwiki-okf.mjs`) and from `sourceNewerThanStamp`
(`wiki-maintain.mjs`), which make the same comparison today. Both callers import it, so the three uses
cannot drift apart (FR-002). The difference between them stays explicit as a parameter: V12 falls back to
mtime for an untracked file, while the planner and `verifySlice` treat untracked as "cannot judge".

### D2. Drift selection in `computePlan`

After `planSlices` (change-driven work plus the backlog), `selectDrift({ root, bundleDir, planned, backlog,
parked, budgetLeft, limit })`:
1. scans the concepts, keeping those whose `resource` is a tracked **file** and that D1 says are stale;
2. drops pages already planned or in the backlog, and parked pages;
3. puts directory resources in `unplannable`;
4. sorts by stamp ascending, then path;
5. takes `min(limit, budgetLeft)` pages;
6. groups them per area as `{ kind: 'drift', area, pages, reason: 'drift: <source> changed after stamp' }`.

The rest go in `driftDeferred`, which is reported and **never written to the backlog** (FR-003). A drift
slice that fails is carried in the backlog like any other slice, so it is not selected twice (scenario 4).

### D3. Parking: `parked` in the run record

`{ "<area>/<page>": { item: <number>, since: <ISO date>, reason: <string> } }`. `planSlices` filters parked
pages out of change-driven slices. `selectDrift` excludes them. `--plan` lists them, along with orphaned entries
whose page is gone. Migration (FR-006): `runbooks/devcontainer-sandbox.md` (PR #718) and `runbooks/renovate.md`
(PR #710), both item #719.

### D4. Reporting

`reportPlan` prints the four groups. `--plan --json` adds `drift: { planned, deferred, parked, unplannable }`,
and `proposalBody` adds one line per drift slice. No CI gate reads these.

### D5. Directory `resource`

The brief gains: "`resource` names one canonical file". `process/spec-driven-development.md` keeps its
`specs/` resource until a maintenance run regenerates it under the new rule. Until then it is reported as
unplannable, which is truthful.

## Project Structure

```text
scripts/
├── openwiki-drift.mjs                 # D1 (new)
├── check-openwiki-okf.mjs             # V12 imports D1
├── wiki-maintain.mjs                  # D2–D4; sourceNewerThanStamp imports D1
└── __tests__/
    ├── openwiki-drift.test.mjs        # D1 (new)
    └── wiki-maintain.test.mjs         # D2–D4, SC-001…SC-003, SC-005
openwiki/
├── .maintenance-state.json            # `parked` (D3 migration)
└── INSTRUCTIONS.md                    # D5 rule
docs/runbooks/wiki-maintenance.md      # FR-010
```

## Complexity Tracking

None.
