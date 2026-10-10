---
description: "Tasks for 082: re-plan wiki concepts that fell behind the maintenance marker"
---

# Tasks: Re-plan wiki concepts that fell behind the maintenance marker

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md)

**Gate**: T000 must be done before any other task starts.

**Test command**: `node --test --test-name-pattern="<pattern>" scripts/__tests__/<file>.test.mjs`. Node flags go
**before** the path; after it they are passed to the script and filter nothing (CLAUDE.md).

## Format: `[ID] [P?] [Story] Description`

## Phase 0: Decision

- [x] T000 (ratified 2026-10-10, option 1 bounded plus option 4) The operator ratifies spec FR-001 and FR-004 (bounded drift plus the report), or picks another option.
      Record the decision and its date in spec.md's Status line, and revise the spec first if it differs.
      **Done when** spec.md's Status line names the decision.

## Phase 1: Foundational (blocks every story)

- [x] T001 [P] Test D1 in `scripts/__tests__/openwiki-drift.test.mjs`:
  - a source committed after the stamp is stale;
  - the stamp is the newest of `generated.at`, `verified.at` and `timestamp`;
  - an untracked source → null with `fallbackToMtime: false`, a judgement with `true`;
  - an external or directory resource → null, or `directory: true`.

  **Verify RED**: `node --test scripts/__tests__/openwiki-drift.test.mjs` fails (module missing).
- [x] T002 Implement `scripts/openwiki-drift.mjs` (plan D1). **Verify GREEN**: T001 passes.
- [x] T003 Make V12 (`check-openwiki-okf.mjs`) and `sourceNewerThanStamp` (`wiki-maintain.mjs`) import D1. Neither
      may keep its own copy of the comparison.
      **Verify GREEN**: `node --test scripts/__tests__/*.test.mjs` is all green with 0 skipped, and
      `node scripts/check-openwiki-okf.mjs` reports the same V12 list as before on `main`. Diff the two outputs.

## Phase 2: User Story 2, parking is a recorded state (P1; before US1, which would otherwise un-park)

- [x] T010 [US2] Tests in `wiki-maintain.test.mjs`:
  - a page in `parked` is excluded from change-driven slices even after a new commit to its source;
  - `--plan` lists it with its item;
  - an orphaned entry is reported, not fatal.

  **Verify RED**: `node --test --test-name-pattern="082 US2" scripts/__tests__/wiki-drift-plan.test.mjs` fails.
- [x] T011 [US2] Implement `parked` reading in `computePlan` and `planSlices`, and its reporting (plan D3).
      **Verify GREEN**: T010 passes, then rerun the whole suite.
- [x] T012 [US2] Migrate `runbooks/devcontainer-sandbox.md` and `runbooks/renovate.md` into `parked` (item #719)
      in `openwiki/.maintenance-state.json`.
      **Done when** `node scripts/wiki-maintain.mjs --plan --json` on the branch matches `main`'s in `slices` and
      `deferred`, and lists both pages as parked (FR-006, SC-005).

## Phase 3: User Story 1, bounded drift slices (P1, MVP)

- [x] T020 [US1] Tests:
  - scenarios 1 to 5 of US1;
  - SC-002: no plan exceeds `PAGE_BUDGET`, with or without drift;
  - SC-003: no parked page is ever planned.

  **Verify RED**: `node --test --test-name-pattern="082 US1" scripts/__tests__/wiki-drift-plan.test.mjs` fails.
- [x] T021 [US1] Implement `selectDrift` and `DRIFT_PAGES_PER_RUN` in `wiki-maintain.mjs` (plan D2).
      **Verify GREEN**: T020 passes, then rerun the whole suite.
- [x] T022 [US1] SC-001 demonstration test: a fixture with 5 drifted pages, where `executeSlices` is driven with a
      stub generator that lands every page. Assert that every page is planned within ⌈5/2⌉ = 3 runs, and that
      the backlog never holds a page twice.
      **Verify RED** (before T021): it fails. **Verify GREEN**: it passes.

## Phase 4: User Story 3, report (P2)

- [x] T030 [US3] Tests: `--plan` text and `--plan --json` carry the four groups, a directory `resource` is
      unplannable, and the proposal body lists drift slices.
      **Verify RED**: `node --test --test-name-pattern="082 US3" scripts/__tests__/wiki-drift-plan.test.mjs` fails.
- [x] T031 [US3] Implement plan D4. **Verify GREEN**: T030 passes, then rerun the whole suite.

## Phase 5: Guards and documentation

- [x] T040 Guard SC-004: a fixture whose only findings are V12 makes `check-openwiki-okf` exit 0. Already proven by
      `check-openwiki-okf.test.mjs` "V12 a stale concept emits a drift warning but still exits 0" and by the gate's
      own `--selftest` scenario "V12 — drift warns without escalating". Both still pass after T003 moved the
      comparison into `openwiki-drift.mjs`. No new test.
- [x] T041 [P] Add the "`resource` names one canonical file" rule to `openwiki/INSTRUCTIONS.md` (FR-009, plan D5).
      **Done when** `node scripts/check-openwiki-governance.mjs` exits 0.
- [x] T042 [P] Rewrite `docs/runbooks/wiki-maintenance.md` in place: drift selection, the bound, parking (replacing
      the "advance `coveredCommit` past the page's source change" recipe) and the report (FR-010).
      **Done when** the runbook's parking recipe edits `parked` and nothing else.
- [x] T043 (2026-10-10: 1612 pass, 0 fail, 0 skipped; all six exit 0) Final gates: `node --test scripts/__tests__/*.test.mjs` (0 failed, 0 skipped), plus
      `check-openwiki-okf`, `check-openwiki-governance`, `secret-scan`, `check-topology-scrub`,
      `wiki-maintain --selftest` and `--plan`, all exit 0.
- [ ] T044 After the first merged run, check item #526's criteria against the run record and the plan, then close #526.
