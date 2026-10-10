# Feature Specification: Re-plan wiki concepts that fell behind the maintenance marker

**Feature Branch**: `082-wiki-drift-replanning`

**Created**: 2026-10-10

**Status**: Ratified 2026-10-10 by the operator: option 1 bounded plus option 4 (FR-001 to FR-004), as written.

**Input**: Backlog item #526: "Concepts that fall behind the run-record marker are never re-planned; drift
is a one-way ratchet". It also takes in that item's 2026-10-06 comment: a directory `resource` is
permanently stale.

## Measured Baseline *(evidence for every claim in this spec)*

Measured 2026-10-10 on `origin/main` (`0e5dcb8d`), offline. Details are in [research.md](research.md).

- **The ratchet is real, but today it is mostly deliberate.** V12 flags **7 of 70** concepts. **4** of them
  have a source that last changed **before** the marker (`coveredCommit` `631f47dc`):
  - 2 are in the backlog (`runbooks/ci-evidence-pipeline.md`, `runbooks/sast-scanning.md`), so they will
    be retried;
  - 2 are **parked** (`runbooks/devcontainer-sandbox.md`, `runbooks/renovate.md`, item #719): they were
    deliberately dropped from the backlog with the marker advanced past their source change, because
    every paid attempt failed.

  The other 3 are ahead of the marker and will be planned. One of them, `process/spec-driven-development.md`,
  cites the directory `specs/`, so it is re-flagged by **any** spec commit.
- **Parking is indistinguishable from the ratchet.** Parking *is* the ratchet, applied on purpose: it
  leaves no record that a page is parked, why, or under which item. A drift re-planner built without
  that distinction would silently **un-park** pages that are known to burn money on every attempt.
- **openwiki's Claims preflight already re-plans some drift, but not most of it.** Since 0.7.1, a
  Claims-covered page whose cited evidence moved is forced into every run (item #707). That covers
  **30 of 70** concepts (those in `.page-manifest.json`), and only when the moved file is
  among their citations. The other 40 have no such signal: for them V12 is the only one.
- **The item's budget premise is out of date.** It names "16 pages / 20 minutes". The budget is now
  `PAGE_BUDGET = 8` pages and a **4-minute start deadline** (`TIME_BUDGET_SECONDS`), enforced between
  invocations, with a job deadline that stops a running generator (#613). This spec uses the current values.

## User Scenarios & Testing *(mandatory)*

### User Story 1: A page that fell behind is planned again, a bounded amount per run (Priority: P1)

As the maintainer of the wiki, I want a concept whose cited source changed before the marker, and that is
neither queued nor parked, to be planned again eventually. Then drift cannot accumulate silently, and no run
spends more than its budget on it.

**Why this priority**: this is the item's gap. Everything else serves it.

**Independent Test**: a fixture repository with a concept whose `resource` was committed after the
concept's stamp and before `coveredCommit`, with an empty backlog. `--plan` includes it as a drift slice.

**Acceptance Scenarios**:

1. **Given** a V12-stale concept behind the marker, not in the backlog and not parked, **When** the planner
   runs, **Then** it plans the page as a `drift` slice, after every change-driven slice.
2. **Given** more drifted pages than `DRIFT_PAGES_PER_RUN`, **When** the planner runs, **Then** it plans
   at most that many, oldest stamp first. The rest are reported but **not** written to the backlog, so the
   backlog does not grow without bound.
3. **Given** change-driven slices that already fill `PAGE_BUDGET`, **When** the planner runs, **Then** it
   plans no drift slice. Drift only uses budget that is left over.
4. **Given** a drift slice that fails, **When** the run ends, **Then** the page is selected again on a later
   run by the same rule, and is not added to the backlog twice.
5. **Given** a page that is already in the backlog or already in this run's change-driven slices, **When**
   drift is computed, **Then** it is not planned a second time.

---

### User Story 2: Parking is a recorded state, and drift never un-parks a page (Priority: P1)

As the operator, I want a parked page to stay parked until I unpark it, and the record to say why it is
parked. Otherwise the drift re-planner pays again, on every run, for a page that cannot currently be
regenerated.

**Why this priority**: without it, US1 is a regression. It re-plans `devcontainer-sandbox` and
`renovate`, whose workers exit without submitting at any effort (#719).

**Independent Test**: a fixture with a drifted page listed under `parked`. `--plan` excludes it from every
slice and prints it under "parked".

**Acceptance Scenarios**:

1. **Given** a page in `parked` (with an item number and the date it was parked), **When** the planner
   runs, **Then** neither drift **nor** a new change to its source plans it, and `--plan` lists it as
   parked, with its item.
2. **Given** the two pages parked today, **When** this feature is migrated, **Then** both appear in `parked`
   with item #719, and `--plan` on `main` shows no change in what is planned.
3. **Given** a `parked` entry whose page no longer exists, **When** the planner runs, **Then** it reports
   the entry as orphaned. It does not fail.

---

### User Story 3: Drift is visible before any money is spent (Priority: P2)

As the maintainer, I want the offline plan to say how many pages are stale and why, split by what will
happen to them, so that "what is out of date?" has one free answer.

**Independent Test**: `--plan` (and `--plan --json`) on a fixture prints counts and pages under drift
planned, drift deferred, parked, and unplannable.

**Acceptance Scenarios**:

1. **Given** V12-stale pages in each category, **When** `--plan` runs, **Then** it prints each category
   with its pages, and the JSON carries the same.
2. **Given** a concept whose `resource` is a directory, **When** drift is computed, **Then** the page is
   reported as **unplannable**, not planned: regenerating it clears the flag only until the next commit
   under that directory.

### Edge Cases

- A concept with no stamp, an external or absent `resource`, or an untracked source: V12 cannot judge it,
  so it is not drift. This matches `sourceNewerThanStamp`'s "unknowable is not stale".
- A drifted page in an area that also has change-driven work this run: it joins that area's slice if the
  slice has room, otherwise it gets its own `drift` slice, within the same budget.
- A page whose generator keeps failing as drift: escalation (078 US6) and the failure counter apply as to
  any slice, and the remedy is parking (US2), now recorded.
- `--since <ref>` dispatches: drift is computed the same way, and a far-back `--since` is still the
  manual sweep.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** (**proposed decision: option 1, bounded**): the planner MUST add V12-drifted concepts, as
  defined by FR-002, as `drift` slices. They come after all change-driven and backlog slices, and only
  within the page budget left over.
- **FR-002**: a concept is *drifted* when the same comparison V12 makes (cited source's last commit date
  newer than the newest of `generated.at`, `verified.at` and `timestamp`) is true, **and** its `resource`
  is a tracked **file**, **and** it is neither in the backlog, nor in this run's change-driven slices,
  nor parked. The comparison MUST be imported from the code V12 uses, not restated.
- **FR-003**: at most `DRIFT_PAGES_PER_RUN` drift pages (default **2**) are planned per run, ordered by
  oldest stamp, then path. The remainder MUST be reported and MUST NOT be written to the backlog.
- **FR-004** (**proposed decision: option 4, alongside**): `--plan`, its JSON, and the proposal body MUST
  report drift in four groups: planned, deferred, parked, unplannable.
- **FR-005**: `.maintenance-state.json` MUST carry `parked: { "<area>/<page>": { item, since, reason } }`.
  The planner MUST exclude a parked page from drift and from change-driven slices, and MUST list it in
  `--plan`. Unparking is removing the entry in a reviewed PR.
- **FR-006**: the two pages parked today MUST be migrated into `parked` (item #719) in the same change,
  and `--plan` on `main` MUST show no other difference (US2 scenario 2).
- **FR-007**: V12 MUST remain warn-only. `check-openwiki-okf` MUST still exit 0 on a bundle whose only
  findings are V12. No documentation edit may block a merge on a paid regeneration (item #526's third
  criterion).
- **FR-008**: the budget invariants MUST be unchanged: `PAGE_BUDGET` (8) and the 4-minute start deadline
  enforced between invocations. Drift MUST NOT raise the number of pages a run attempts above what the
  budget allows.
- **FR-009**: a concept whose `resource` is a directory MUST be reported as unplannable (FR-004). The
  generation brief (`openwiki/INSTRUCTIONS.md`) MUST say that a concept's `resource` names a canonical
  **file**. `process/spec-driven-development.md` is re-pointed at a specific canonical document by
  regeneration, not by hand-editing.
- **FR-010**: `docs/runbooks/wiki-maintenance.md` MUST describe drift selection, the bound, parking and the
  report, rewritten in place (item #589's rule).

### Key Entities

- **Drift candidate**: a concept page, its cited file, its stamp, and the commit date that makes it stale.
- **Parked entry**: page key → `{ item, since, reason }`. A recorded decision, made in a PR.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: a test proves that a concept stale behind the marker is planned within ⌈n / `DRIFT_PAGES_PER_RUN`⌉
  runs when n such pages exist and every run lands. The proof is a demonstration, not an assertion (item
  #526, second criterion).
- **SC-002**: no plan built by the tests attempts more than `PAGE_BUDGET` pages, with or without drift.
- **SC-003**: no parked page appears in any planned slice in any test, including after a new change to its
  source.
- **SC-004**: `check-openwiki-okf` exits 0 on a fixture whose only findings are V12 warnings (unchanged
  behaviour, guarded).
- **SC-005**: on `main` after migration, `--plan` reports the 2 parked pages under parked, and the
  directory-`resource` page under unplannable.

## Rejected options *(item #526 asks for the reasons to be recorded)*

- **Option 2: a periodic sweep on a schedule.** Rejected. It is a second scheduling mechanism beside the
  merge trigger and its 15-minute debounce. Its cost lands in one lump, which a 60-minute merge-run window
  cannot absorb (#690: a push run gets about 45 minutes of generation). And `--since <far back>` re-plans
  every page whose source **changed** in the range, not every page that is **stale**, so it would pay for
  current pages. A manual far-back `--since` dispatch remains available for a deliberate sweep.
- **Option 3: escalate V12 to failing after N days.** Rejected. It puts a paid regeneration on the
  critical path of an unrelated merge, which is exactly what V12's warn-only rule exists to prevent. It
  would also fail every merge while a parked page stays parked. FR-007 makes keeping V12 warn-only a
  requirement.
- **Option 1 unbounded** (every drifted page becomes a candidate). Rejected. With n drifted pages, every run
  would fill its budget with them and starve change-driven work, which "moves the problem, not solves it"
  (item #526's fourth criterion). FR-003 bounds it.
- **Relying on openwiki's Claims preflight alone.** Not sufficient. It covers 30 of 70 concepts, only through
  their citations, and it cannot be bounded or excluded per page. It also forces parked pages, which #707
  deals with separately.

## Assumptions

- `DRIFT_PAGES_PER_RUN = 2` is a starting value. With 8 pages per run, it leaves 6 for change-driven work,
  and clears today's 2 unparked behind-the-marker pages in one run.
- The operator ratifies the proposed decision (FR-001, FR-004) before implementation. If another option is
  chosen, this spec is revised first.
- Item #513 (Grounded Claims) has been adopted as openwiki 0.7.1's Claims. Its preflight overlaps but does
  not replace this, per "Rejected options".
