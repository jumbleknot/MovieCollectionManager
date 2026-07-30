# Tasks: OpenWiki Automated Maintenance and Content Relocation

**Input**: Design documents from `specs/044-openwiki-automation-migration/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/cli-contracts.md](contracts/cli-contracts.md), [quickstart.md](quickstart.md)

**Tests**: REQUIRED, not optional. The constitution makes TDD non-negotiable and mandates the checkpoint
format in `docs/templates/feature-test-tasks-template.md` — every test task carries its scenarios and a
**Verify RED**; every paired implementation task carries a **Verify GREEN**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different file, no dependency on incomplete work
- **[Story]**: US1–US4 for story phases; Setup/Foundational/Polish carry no story label

## Path Conventions

Repository tooling feature — no application project is touched. Scripts live in `scripts/`, their unit
tests in `scripts/__tests__/` (auto-globbed by the `naming` job — **no workflow edit needed for a new test
file**), governance artifacts at the bundle root, workflows in `.forgejo/workflows/`.

> **Two facts from Phase 0 that shape almost every task below.**
> **R2** — the generator has no programmatic scoping surface; a slice is free text in a run message, so
> the page cap is advisory and *verification is the only enforcement that exists*.
> **R1** — the generator reports no token or cost data, which is why FR-011 is a page/time budget and why
> pages must be counted from the working tree, never from the tool's own account.

---

## Phase 1: Setup

**Purpose**: Fixture scaffolding for the offline, keyless tests every later phase drives RED→GREEN.

- [ ] T001 [P] Create planner/verifier fixture tree in `scripts/__tests__/fixtures/wiki-maintain/` with: a conformant mini-bundle, a partially-written bundle, and a bundle with one new and one existing area
  - **Type**: New file · **Risk**: None
  - **Done when**: fixtures load offline with no network and no `ANTHROPIC_API_KEY`

- [ ] T002 [P] Create governance fixture tree in `scripts/__tests__/fixtures/openwiki-governance/` with: valid `policy.yaml`/`protected.yaml`, an unclassified path, a reworded protected passage, a deleted protected passage, a protected passage on a `resource`-bearing concept, a concept that is neither derived nor authoritative, and a `CLAUDE.md` carrying stray prose
  - **Type**: New file · **Risk**: None
  - **Done when**: each fixture isolates exactly one G-rule violation

- [ ] T003 Record the pre-trim baseline in `specs/044-openwiki-automation-migration/EVIDENCE.md`: `CLAUDE.md` line count, byte size, section count, and the bundle's concept count
  - **Type**: Documentation · **Spec reference**: FR-034, SC-009 · **Risk**: None
  - **Done when**: the before-measurement is committed *before* any relocation task runs — it cannot be reconstructed afterwards

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The policy registry, the routing rule, and the run-record module. Every user story reads at
least one.

⚠️ **No user story may start until this phase completes.**

- [ ] T004 Author `openwiki/policy.yaml` declaring the per-path regeneration policy exactly as specified
  - **Type**: Config · **Spec reference**: FR-026a, FR-026b, FR-026d · **Risk**: Low
  - Encode all ten assignments from the spec's grid, each with `glob`, `policy`, `actor`, `rationale`; `events` on every `event-driven` entry; `exceptions: ["specs/*/HANDOFF.md"]` on the `specs/**` entry
  - **Done when**: every documentation path in the tree matches an entry, and no entry outside `openwiki/` carries `actor: generator`

- [ ] T005 [P] Extend `openwiki/INSTRUCTIONS.md` with the new exclusions and the protection rule
  - **Type**: Documentation · **Spec reference**: FR-026g, FR-029b · **Risk**: Low
  - Add `docs/test-data/**` as a *declared* exclusion (today it is excluded only by accident of the binary-asset rule); state `specs/**` is analyzable but not a coverage target, `HANDOFF.md` excepted; state that `policy.yaml` and `protected.yaml` are never rewritten
  - **Done when**: a reader can derive the bundle's scope without inferring it from a general rule

- [ ] T006 [P] Document the canonical-home routing rule in `openwiki/INSTRUCTIONS.md`
  - **Type**: Documentation · **Spec reference**: FR-037, FR-037a, FR-037b, FR-037c, FR-038, FR-042 · **Risk**: Low
  - State the rule and how to apply it mechanically: a concept citing a `resource` is a **derived summary**, so a learning about it goes to that source — an operational learning belongs in the runbook, not in the page summarizing it. A concept with no `resource` is **authoritative**, so the learning goes into the concept. Record the rejected alternative (write to the instruction file and let a run relocate it later) and why: it needs an automated run to rewrite instruction-file content, the generator scope expansion FR-026c excludes, and it reinstates the grow-then-trim cycle
  - **Done when**: an assistant can determine the destination for any subject without consulting `spec.md`

- [ ] T007 Write the run-record module test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Type**: Test · **Spec reference**: [spec.md](spec.md) US2; FR-012, FR-017 · **Risk**: Low
  - **Scenarios covered**: US2-AC2 (marker advances on nothing-to-do); three distinct outcomes
  - Assert: read/write round-trips `openwiki/.maintenance-state.json`; `lastOutcome` is one of `nothing-to-do`/`completed`/`failed`; a malformed file is a hard error, never a silent default; the module never reads or writes `openwiki/.last-update.json` (tool-owned — see [data-model.md](data-model.md) E3)
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs`
  - **Expected RED**: 4+ failing — `Cannot find module '../wiki-maintain.mjs'`

- [ ] T008 Implement the run-record module in `scripts/wiki-maintain.mjs`
  - **Type**: Implementation · **Prerequisite**: T007 verified RED
  - Per [data-model.md](data-model.md) E3: `coveredCommit`, `coveredAt`, `lastOutcome`, `backlog`, `proposal`, `lastRunBudget`
  - **Verify GREEN**: `node --test scripts/__tests__/wiki-maintain.test.mjs` → 0 failures

---

## Phase 3: User Story 1 — A run never claims success without producing verified work (P1) 🎯 MVP

**Goal**: Decompose into bounded slices, then judge each by what landed — never by the generator's exit
status.

**Independent test**: Request an update needing substantial new content; confirm decomposition happens
before generation, and that a sabotaged slice producing nothing is reported as a failure.

### Planner

- [ ] T009 [US1] Write the slice-bounding test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: US1-AC1 (bounded slices, no mixed areas); FR-002
  - Assert: no slice exceeds **8 pages**; no slice both extends an existing area and creates a new one; `areaExists` is derived from the tree, never supplied by the caller
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "slice"`
  - **Expected RED**: 3 failing — `planSlices is not a function`
  - > The mixed-area case is the invariant that matters: of 043's eight runs, the *only* one that produced zero pages was the only one shaped that way.

- [ ] T010 [US1] Implement the planner in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T009 verified RED · **Spec reference**: FR-001, FR-010
  - Reads the run record, the git range since `coveredCommit`, `openwiki/policy.yaml` (to drop `excluded` and non-coverage paths), and the backlog → ordered slices. The change set derives from what changed **since the last recorded run**, never from per-concept staleness markers
  - **Verify GREEN**: same command → 0 failures

- [ ] T011 [P] [US1] Write the offline-planning test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: US1-AC5; FR-003, FR-004
  - Assert: `--plan` completes with no `ANTHROPIC_API_KEY` in the environment and makes no network call; output is inspectable JSON
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "offline"`
  - **Expected RED**: 2 failing — plan path attempts a model invocation

- [ ] T012 [US1] Implement `--plan` and `--json` per [contracts](contracts/cli-contracts.md) C1 in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T011 verified RED
  - **Verify GREEN**: same command → 0 failures

- [ ] T013 [P] [US1] Write the run-message rendering test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: US1-AC1; FR-001, FR-002
  - Assert: the rendered message names **every** page in the slice and **no others**; it names exactly one bundle area; a slice of 8 pages produces 8 named pages; the message is deterministic for a given slice (same input → byte-identical output, so a re-plan cannot silently change scope)
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "run-message"`
  - **Expected RED**: 4 failing — `renderRunMessage is not a function`
  - > Per research R2 this string is the **only** scoping surface the generator exposes. An untested renderer is an untested scope boundary.

- [ ] T014 [US1] Implement run-message rendering in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T013 verified RED · **Spec reference**: FR-001; research R2
  - Render each slice into an explicit page-list instruction (`openwiki code --update "<message>"`; there is no `--pages` flag)
  - **Verify GREEN**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "run-message"` → 0 failures
  - **Also run**: `node scripts/wiki-maintain.mjs --dry-run` → prints the exact message per slice, invoking nothing

### Verifier — the load-bearing part

- [ ] T015 [US1] Write the zero-page detection test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: US1-AC2; FR-005, FR-006, SC-003
  - Assert with a **stub generator that exits 0 having written nothing**: run reports failure, slice returns to the backlog, marker does not advance
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "zero-page"`
  - **Expected RED**: 3 failing — `verifySlice is not a function`
  - > A green result here means the detector is broken. This is the exact false-green 043 measured: 12 minutes of paid work, one `index.md`, exit 0.

- [ ] T016 [US1] Write the conformance-regression test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: US1-AC3; FR-005
  - Assert: a slice writing pages that break bundle conformance is reported as failed and surfaces the violation
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "conformance"`
  - **Expected RED**: 2 failing

- [ ] T017 [US1] Implement the verifier in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T015 and T016 verified RED
  - Count pages from the **working tree**; re-run `check-openwiki-okf.mjs`; **never** consult the generator's exit status
  - **Verify GREEN**: `node --test scripts/__tests__/wiki-maintain.test.mjs` → 0 failures

- [ ] T018 [US1] Write the policy-write enforcement test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: FR-026c, FR-026e; SC-015
  - Assert with a stub generator that writes outside its permitted scope: the run **fails**, names the offending path, and the slice returns to the backlog. Cover a write to `docs/runbooks/`, to a `never-written` path (`INSTRUCTIONS.md`, `policy.yaml`, `protected.yaml`), and to an `excluded` path
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "policy-write"`
  - **Expected RED**: 4 failing
  - > This is the runtime half of FR-026c. The gate checks the policy file *declares* `actor: generator` only inside `openwiki/`; nothing until now checked that a run **obeyed** it.

- [ ] T019 [US1] Implement the policy-write guard in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T018 verified RED · **Spec reference**: FR-026e
  - After each slice, collect written paths from the working tree and evaluate them against `openwiki/policy.yaml`; any path the generator may not write fails the slice
  - **Verify GREEN**: same command → 0 failures

### Budget guard

- [ ] T020 [US1] Write the budget-guard test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: FR-011, FR-011a, FR-011b; SC-006, SC-006a
  - Assert: a slice is not started once **16 pages** or **20 minutes** is reached; the remainder lands in `deferred`; **exit 3**, distinct from failure; page counts derive from files on disk, and a stub generator over-reporting its output does not move the counter
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "budget"`
  - **Expected RED**: 4 failing
  - > The over-report case is not hypothetical: per R2 nothing constrains the generator to its page list.

- [ ] T021 [US1] Implement the budget guard in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T020 verified RED · **Spec reference**: FR-011, FR-011a, FR-011b, FR-011c, FR-011d
  - Both budgets configurable. Declare the effective ceiling (≤24 pages / ~37 min) in the module header comment, and record there that the wall-clock budget bounds runner occupancy (FR-011c) and that **neither budget is a monetary bound** (FR-011d)
  - **Verify GREEN**: same command → 0 failures

### Resume and CLI surface

- [ ] T022 [US1] Write the resume test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: US1-AC4; FR-007, SC-002
  - Assert: re-invocation after interruption skips completed slices and attempts only outstanding ones
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "resume"`
  - **Expected RED**: 2 failing

- [ ] T023 [US1] Implement `--execute`, backlog persistence, and exit codes 0/1/2/3 per C1 in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T022 verified RED
  - **Verify GREEN**: `node --test scripts/__tests__/wiki-maintain.test.mjs` → 0 failures

- [ ] T024 [US1] Implement `--selftest` in `scripts/wiki-maintain.mjs`
  - **Type**: Implementation · **Spec reference**: FR-008
  - Exercises planner and verifier against T001's fixtures, including the sabotaged zero-page generator. Offline, keyless
  - **Verify GREEN**: `node scripts/wiki-maintain.mjs --selftest` → exit 0

- [ ] T025 [US1] Add the `wiki-plan` and `wiki-maintain` Nx targets to `infrastructure-as-code/project.json`
  - **Type**: Config · **Spec reference**: FR-021; contracts C5 · **Risk**: Low
  - Each carries a `metadata.description` stating why the target must be used rather than a bare call — matching the existing `wiki-update` and `okf-lint` entries, whose descriptions are load-bearing
  - **Done when**: `pnpm nx wiki-plan infrastructure-as-code` succeeds with no credential present

**Checkpoint**: US1 is independently deliverable. It makes the existing manual loop honest even if nothing else ships.

---

## Phase 4: User Story 2 — The bundle stays current without a human remembering (P1)

**Goal**: Merge-triggered maintenance proposing one always-current pull request, never auto-merged.

**Independent test**: Land a documentation-affecting change; confirm a proposal appears for review. Run
against an unchanged tree; confirm it is free and proposes nothing.

- [ ] T026 [US2] Write the marker-advance test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: US2-AC2; FR-012, SC-004
  - Assert: a run finding nothing to document **advances** `coveredCommit` and records `nothing-to-do`; two consecutive such runs both take the free path
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "marker"`
  - **Expected RED**: 2 failing
  - > This is the specific defect 043 measured: the tool's own marker advances only when wiki content changed, so a correct "nothing to document" run paid full price again next time.

- [ ] T027 [US2] Implement marker advance and outcome classification in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T026 verified RED · **Spec reference**: FR-012, FR-017
  - A credential, capacity, or generator failure must **never** classify as `nothing-to-do`
  - **Verify GREEN**: same command → 0 failures

- [ ] T028 [P] [US2] Write the proposal-lifecycle test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: US2-AC7; FR-016, FR-016a, FR-016b; SC-005b, SC-005c
  - Assert against a stubbed forge client: at most one open proposal; a second run rebases and appends rather than opening another; **a human commit on the branch survives the update**; a closed-unmerged proposal returns its work to the backlog and rolls the marker back
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "proposal"`
  - **Expected RED**: 5 failing

- [ ] T029 [US2] Implement the proposal client in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T028 verified RED · **Spec reference**: FR-013, FR-016; SC-005, SC-005a; contracts C4; research R8
  - Forgejo API `POST /api/v1/repos/{owner}/{repo}/pulls`; rebase-and-append, never a wholesale force-replace; **never auto-merge** — a human reviews every wiki diff
  - **Verify GREEN**: same command → 0 failures

- [ ] T030 [P] [US2] Write the missing-event-document test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: FR-026f, SC-019
  - Assert: when the change range adds a `## Clarifications` entry to a `specs/*/spec.md` **or** a Complexity Tracking row to a `specs/*/plan.md` — the two places this repository records decisions — and `docs/decisions/` was not touched, the run **reports** a candidate missing decision record. Assert it is reported, never silent; assert it does **not** block the run
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "missing-event"`
  - **Expected RED**: 3 failing

- [ ] T031 [US2] Implement missing-event-document detection in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T030 verified RED · **Spec reference**: FR-026f
  - Report in the plan output and the proposal body. An `event-driven` path is **not** satisfied by being left alone — the missing record is the finding
  - **Verify GREEN**: same command → 0 failures

- [ ] T032 [P] [US2] Write the workflow-shape guard test in `scripts/__tests__/wiki-maintain.guard.test.mjs`
  - **Scenarios covered**: US2-AC6; FR-009, FR-009a, FR-009b, FR-009c, FR-019, FR-023; SC-008a, SC-008b
  - Parse `.forgejo/workflows/wiki-maintain.yml` and assert: `concurrency` with `cancel-in-progress: true`; a `workflow_dispatch` trigger; a maximum-deferral step; a self-trigger guard for bundle-only and `[skip ci]` commits; secrets limited to the two **existing** names; a failure-digest step; `timeout-minutes: 45`
  - Additionally unit-test the deferral decision function directly: given an oldest-uncovered-commit age below the threshold it defers, at or above it runs immediately. Git-derived, so it is testable offline without exercising CI
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.guard.test.mjs`
  - **Expected RED**: 9 failing — workflow file absent
  - > Follows the `agent-stack.guard.test.mjs` / `zap-scan.guard.test.mjs` precedent: assert the workflow's shape statically rather than by running CI.

- [ ] T033 [US2] Create `.forgejo/workflows/wiki-maintain.yml`
  - **Prerequisite**: T032 verified RED · **Spec reference**: contracts C4
  - Debounce = `concurrency` + `cancel-in-progress` + an initial wait, so a new push cancels the waiter and restarts it (research R3). Maximum deferral computed from the **age of the oldest uncovered commit** — git-derived, so it survives cancellation. Consumes `ANTHROPIC_API_KEY` and the existing write token; adds no store entry
  - **Verify GREEN**: `node --test scripts/__tests__/wiki-maintain.guard.test.mjs` → 0 failures

- [ ] T034 [US2] Wire the feature-042 failure digest into `.forgejo/workflows/wiki-maintain.yml`
  - **Type**: Config · **Spec reference**: FR-018, SC-007
  - **Verify GREEN**: `node scripts/check-ci-digest-coverage.mjs` → exit 0
  - > A new job without a digest fails this gate — it is not optional.

- [ ] T035 [US2] Confirm `.forgejo/workflows/wiki-maintain.yml` is **not** added to branch protection required contexts
  - **Type**: Config verification · **Spec reference**: FR-019, SC-008 · **Risk**: Medium
  - **Done when**: `node scripts/ci-status.mjs status --branch main` shows the required-context set unchanged. A paid, occasionally-slow job must never gate an unrelated merge

**Checkpoint**: US2 delivers freshness. US1 + US2 together are a complete, useful feature without the trim.

---

## Phase 5: User Story 4 — Local run and resume (P2)

**Goal**: The identical path locally. **Raised from P3 because US3's trim runs through it (FR-027aa) —
this phase must land before Phase 6.**

**Independent test**: Run maintenance locally against known outstanding work; confirm the plan is shown
before generation, execution can be limited, and re-running resumes.

- [ ] T036 [P] [US4] Write the local-parity test in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Scenarios covered**: US4-AC1, US4-AC3; FR-020, FR-021
  - Assert: the executor invokes `pnpm nx wiki-update infrastructure-as-code` and **never** a bare `openwiki` call; `--max-slices` bounds the run; `--since` overrides the marker
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs --test-name-pattern "local"`
  - **Expected RED**: 3 failing
  - > A bare CLI call skips the telemetry opt-out and the raised heap, and OOMs.

- [ ] T037 [US4] Implement `--since`, `--max-slices`, and `--dry-run` in `scripts/wiki-maintain.mjs`
  - **Prerequisite**: T036 verified RED
  - **Verify GREEN**: same command → 0 failures

- [ ] T038 [P] [US4] Write the operator runbook `docs/runbooks/wiki-maintenance.md`
  - **Type**: Documentation · **Spec reference**: FR-020, FR-037 · **Risk**: None
  - Cover: plan-before-you-pay, the budgets and what exit 3 means, resuming, reading a failure digest, the canonical-home routing rule for recording learnings, and the remediation rule (fix `INSTRUCTIONS.md` and re-run — **never** allowlist rejected content)
  - **Done when**: an operator can run and diagnose a maintenance run without reading the scripts

---

## Phase 6: User Story 3 — The instruction file becomes a thin index (P2)

**Goal**: Relocate `CLAUDE.md` into the bundle behind a mechanical guard against silent paraphrase.

⚠️ **Order within this phase is load-bearing**: the governance gate must exist and be green *before* the
trim runs, or the trim lands unprotected.

**Independent test**: Measure before/after; confirm every relocated passage is present verbatim, links
resolve, and previously answerable questions remain answerable.

### Document relocation (independent, do first)

- [ ] T039 [P] [US3] Extend `scripts/__tests__/relocated-docs-links.test.mjs` for the agent-layer move
  - **Scenarios covered**: FR-030a
  - Assert: no tracked file references `docs/agent-layer.md`; the two bundle concepts citing it (`projects/agent-gateway.md`, `architecture/agent-layer.md`) resolve to the new path
  - **Verify RED**: `node --test scripts/__tests__/relocated-docs-links.test.mjs`
  - **Expected RED**: 2 failing — old path still referenced

- [ ] T040 [US3] Move `docs/agent-layer.md` → `docs/runbooks/agent-layer.md` and update every inbound reference in lockstep
  - **Prerequisite**: T039 verified RED · **Spec reference**: FR-030a
  - **No content change.** Update `CLAUDE.md:93`, specs 018/019/020/040/043, and both concepts' `resource` fields — the OKF gate **fails** on an unresolvable repo-relative `resource`, so the concepts must move in the same change
  - **Verify GREEN**: `node --test scripts/__tests__/relocated-docs-links.test.mjs` → 0 failures
  - **Also run**: `pnpm nx okf-lint infrastructure-as-code` → exit 0

### Governance gate

- [ ] T041 [P] [US3] Write policy-validation tests (G1–G4) in `scripts/__tests__/check-openwiki-governance.test.mjs`
  - **Scenarios covered**: FR-026a, FR-026b, FR-026c, FR-026d; SC-015
  - Assert: an unclassified documentation path fails (G1); an invalid `policy` value fails (G2); **`actor: generator` outside `openwiki/` fails (G3)** — the mechanical expression of FR-026c; `event-driven` without `events` fails (G4)
  - **Verify RED**: `node --test scripts/__tests__/check-openwiki-governance.test.mjs`
  - **Expected RED**: 4 failing — script absent

- [ ] T042 [P] [US3] Write protection tests (G5–G7) in `scripts/__tests__/check-openwiki-governance.test.mjs`
  - **Scenarios covered**: FR-029, FR-029c, FR-029d, FR-041a; SC-012, SC-018, SC-018a, SC-018b, SC-018c
  - Assert: a reworded protected passage fails (G5); a **deleted** one fails as a removal rather than passing for lack of text to compare (G6); a protected passage on a `resource`-bearing concept fails (G7); correcting a passage **and** its fingerprint in the same change **passes** — the escape hatch, without which the gate is a trap people work around
  - **Verify RED**: same command · **Expected RED**: 4 failing

- [ ] T043 [P] [US3] Write index tests (G8–G10) in `scripts/__tests__/check-openwiki-governance.test.mjs`
  - **Scenarios covered**: FR-031, FR-033, FR-039, FR-040; SC-011, SC-016, SC-017
  - Assert: prose in `CLAUDE.md` beyond the index and the three managed regions fails (G8); an index entry pointing at a non-existent concept fails (G9); an assistant surface referencing moved content fails (G10)
  - **Verify RED**: same command · **Expected RED**: 3 failing

- [ ] T044 [P] [US3] Write the concept-classification test (G11) in `scripts/__tests__/check-openwiki-governance.test.mjs`
  - **Scenarios covered**: FR-030, FR-037, FR-038; SC-017a
  - Assert: every concept is **exactly one** of derived (carries a resolving `resource`) or authoritative (listed under `authoritative:` in `protected.yaml`). A concept that is neither fails — it is either a missing citation or unclassified canonical content, and both make the routing rule undecidable. A concept that is **both** fails
  - **Verify RED**: `node --test scripts/__tests__/check-openwiki-governance.test.mjs --test-name-pattern "classification"`
  - **Expected RED**: 3 failing
  - > This is what turns FR-037's routing rule from a convention into something checkable, and it fixes the FR-029e complaint that a concept does not disclose its own status.

- [ ] T045 [US3] Write the fingerprint-normalization test in `scripts/__tests__/check-openwiki-governance.test.mjs`
  - **Scenarios covered**: FR-029 ([data-model.md](data-model.md) E5)
  - Assert: trailing-whitespace and line-ending differences do **not** trip the check, but any word change does. Over-normalizing would let a meaning-changing edit pass
  - **Verify RED**: same command · **Expected RED**: 2 failing

- [ ] T046 [US3] Implement `scripts/check-openwiki-governance.mjs`
  - **Prerequisite**: T041–T045 verified RED · **Spec reference**: contracts C2; FR-030 (verify-only — `resource` is already optional at `scripts/check-openwiki-okf.mjs:39`, so authoritative concepts already validate and no OKF change is needed)
  - Rules G1–G11; `--selftest`; exit `0`/`1`/`2`; `node:` built-ins + `yaml` only; **fail-closed** — a missing or unparseable governance file is a violation, never a skip. Failures name concept, anchor, and what changed (FR-029e)
  - **Verify GREEN**: `node --test scripts/__tests__/check-openwiki-governance.test.mjs` → 0 failures; `node scripts/check-openwiki-governance.mjs --selftest` → exit 0

- [ ] T047 [US3] Add governance gate steps to the existing `okf` job in `.forgejo/workflows/guardrails.yml`
  - **Type**: Config · **Spec reference**: FR-029a, SC-014 · **Risk**: Low
  - Run `--selftest` then the scan, via `scripts/ci-log-step.sh`, mirroring the existing OKF steps
  - **Done when**: the gate runs on every change and `check-ci-digest-coverage.mjs` still passes
  - > Deliberately **steps in an existing job, not a new job** — a new job would incur its own failure-digest obligation for no benefit (research R5).

- [ ] T048 [P] [US3] Add the `okf-governance` Nx target to `infrastructure-as-code/project.json`
  - **Type**: Config · **Spec reference**: contracts C5
  - **Done when**: `pnpm nx okf-governance infrastructure-as-code` runs keyless and offline

### The trim

- [ ] T049 [US3] Plan the relocation from `CLAUDE.md` and review it before spending anything, via `scripts/wiki-maintain.mjs --plan`
  - **Type**: Implementation · **Spec reference**: FR-027aa, FR-004 · **Risk**: High
  - `node scripts/wiki-maintain.mjs --plan --since <pre-trim-ref>` — inspect every slice; confirm none mixes a new area with an existing one
  - **Done when**: the plan is reviewed and attached to the evidence document

- [ ] T050 [US3] 💰 Execute the relocation of `CLAUDE.md` content into `openwiki/` through the slice machinery (`scripts/wiki-maintain.mjs --execute`)
  - **Prerequisite**: T046–T049 complete; the gate must be green **before** content moves
  - **Spec reference**: FR-027, FR-027aa, FR-027ab, FR-028; SC-001, SC-002a
  - `pnpm nx wiki-maintain infrastructure-as-code`. Content moves **verbatim** — no abridgement, no rewording. This is the largest generation job in the feature and closely resembles what defeated 043 eight times; its run record **is** US1's acceptance evidence
  - **Verify GREEN**: every slice verified, `pnpm nx okf-lint infrastructure-as-code` → exit 0

- [ ] T051 [US3] Populate `openwiki/protected.yaml` with the `authoritative:` list and a fingerprint per relocated load-bearing passage
  - **Prerequisite**: T050 · **Spec reference**: FR-029, FR-041; [data-model.md](data-model.md) E5
  - Each passage entry: `concept`, `anchor`, `fingerprint`, `origin`, `relocatedAt`. **Only authoritative concepts** — never one carrying a `resource` link. Every relocated concept must also appear under `authoritative:` so G11 can classify it
  - **Verify GREEN**: `pnpm nx okf-governance infrastructure-as-code` → exit 0

- [ ] T052 [US3] Rewrite `CLAUDE.md` as a thin index
  - **Prerequisite**: T050, T051 · **Spec reference**: FR-027, FR-027a, FR-032, FR-039
  - Index entries only. Leave the three managed regions **byte-identical** (`nx configuration`, `SPECKIT`, `OPENWIKI`). Delete the correction note's "there is **no scheduled workflow**" clause — this feature makes that block's claim true
  - **Verify GREEN**: `pnpm nx okf-governance infrastructure-as-code` → exit 0; `grep -c "nx configuration start\|SPECKIT START\|OPENWIKI:START" CLAUDE.md` → `3`

- [ ] T053 [P] [US3] Reconcile the other assistant-facing surfaces — `AGENTS.md`, `opencode.json`, `.claude/`
  - **Spec reference**: FR-033, SC-011
  - **Verify GREEN**: `pnpm nx okf-governance infrastructure-as-code` → exit 0 (G10)

- [ ] T054 [US3] Validate the destination rule against six real subjects in `specs/044-openwiki-automation-migration/EVIDENCE.md`
  - **Type**: Validation · **Spec reference**: FR-037, SC-017a · **Risk**: Low
  - For ≥6 subjects spanning runbooks, decision records, the architecture document, and relocated instruction-file content, record the destination the rule yields and confirm exactly one correct answer per subject with no judgement call
  - **Done when**: all six resolve unambiguously; any ambiguity is a defect in the rule, not the record

- [ ] T055 [US3] Complete `specs/044-openwiki-automation-migration/EVIDENCE.md`
  - **Type**: Documentation · **Spec reference**: FR-034; SC-009, SC-010, SC-016 · **Risk**: None
  - Record the after-measurement against T003's baseline; ≥8 questions the file answered before the trim with the concept resolving each in ≤2 opens; the human judgement behind SC-010/SC-016, which no machine can re-check later
  - **Done when**: both criteria remain verifiable after merge

**Checkpoint**: all four stories delivered.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T056 [P] Verify no credential leaked into generated content under `openwiki/`
  - **Verify GREEN**: `node scripts/secret-scan.mjs` and `node scripts/check-topology-scrub.mjs` → exit 0
  - **Spec reference**: SC-013 · Remediation is `INSTRUCTIONS.md` + regenerate, **never** an allowlist entry (FR-015)

- [ ] T057 [P] Confirm every always-on gate in `.forgejo/workflows/guardrails.yml` remains keyless and fail-closed
  - **Spec reference**: FR-026, SC-014
  - **Done when**: the `okf` job's steps run with no `${{ secrets }}` reference

- [ ] T058 [P] Run the full script unit suite as CI does, over `scripts/__tests__/*.test.mjs`
  - **Verify GREEN**: `node --test scripts/__tests__/*.test.mjs` → 0 failures

- [ ] T059 Confirm V12 drift remains report-only in `scripts/check-openwiki-okf.mjs`
  - **Spec reference**: FR-036
  - **Done when**: the file is unchanged and drift still never affects the exit code

- [ ] T060 [P] Verify no egress or telemetry widening in `.devcontainer/init-firewall.sh` and `.forgejo/workflows/wiki-maintain.yml`
  - **Spec reference**: FR-022
  - **Done when**: the firewall script is unchanged on this branch, and the workflow sets no telemetry-enabling env — generation runs only via the target that sets `OPENWIKI_TELEMETRY_DISABLED=1`

- [ ] T061 [P] Verify credential hygiene across `.forgejo/workflows/wiki-maintain.yml` and the published digest
  - **Spec reference**: FR-023a, FR-024, FR-025; SC-013, SC-020
  - **Verify GREEN**: `node scripts/check-no-argv-secrets.mjs` → exit 0; neither secret value appears in any published log or digest; the model and write credentials are distinct; the Actions store gained **zero** entries

- [ ] T062 [P] Verify the maintenance proposal PR is gated like a human-authored change by `.forgejo/workflows/guardrails.yml`
  - **Spec reference**: FR-014, SC-005
  - **Done when**: `node scripts/ci-status.mjs status --pr <proposal>` shows `guardrails*` posting statuses on the proposal PR

- [ ] T063 Verify the relocation of `CLAUDE.md` is revertible in one step
  - **Spec reference**: FR-035 · **Risk**: Medium
  - Trial-revert the relocation commit on a scratch branch; confirm `okf-lint` and `okf-governance` pass with no regeneration run required
  - > This is the safety net that justified accepting a full trim over a measured tranche — untested, it is an assumption rather than a property

- [ ] T064 Final validation checklist across `frontend/mcm-app` and `backend/mc-service`
  - **Type**: Validation · **Risk**: Medium
  - `pnpm nx lint mcm-app` · `pnpm nx typecheck mcm-app` · `pnpm nx test mcm-app` · `pnpm nx test mc-service` · `pnpm nx e2e mcm-app` · `rtk gain` (>80%, last)
  - > The **web E2E regression is required for every feature**, including one that touches no application code. In this dev container it runs via the containerized browser path.

- [ ] T065 Update `docs/runbooks/agent-layer.md` and `CLAUDE.md`'s index for anything learned during implementation
  - **Type**: Documentation · **Spec reference**: constitution §AI Assistant Constraints; FR-037
  - > Post-trim, a learning goes to the **canonical home of its subject**: an operational learning into the runbook, not into the concept summarizing it.

---

## Dependencies

```text
Phase 1 Setup (T001–T003)
        ↓
Phase 2 Foundational (T004–T008)   ← BLOCKS everything
        ↓
Phase 3 US1 (T009–T025)  P1 🎯 MVP — planner, verifier, policy guard, budget, CLI
        ↓
   ┌────┴─────────────────────────┐
   ↓                              ↓
Phase 4 US2 (T026–T035) P1     Phase 5 US4 (T036–T038) P2
   │                              ↓
   │                        Phase 6 US3 (T039–T055) P2
   │                        (needs US4's local path — FR-027aa)
   └──────────┬───────────────────┘
              ↓
Phase 7 Polish (T056–T065)
```

**Story dependencies**:

- **US1** depends only on Foundational. Independently deliverable and the MVP.
- **US2** depends on US1 (it automates US1's machinery). Independent of US3/US4.
- **US4** depends on US1. **Must precede US3** — the trim runs through the local path.
- **US3** depends on US1 + US4, and internally on its own gate landing before the trim.

**Critical ordering inside US3**: T046 (gate) → T047/T048 (wiring) → T049 (plan) → T050 (trim) → T051
(protection manifest) → T052 (index). Running the trim before the gate is green would relocate
load-bearing content with no protection against a later paraphrase — the exact risk that justified
accepting a full trim.

---

## Parallel Opportunities

**Phase 1**: T001, T002 together (different fixture trees). T003 independent.

**Phase 2**: T005 and T006 in parallel (both edit `INSTRUCTIONS.md` — coordinate as one edit pass), both
parallel with T007.

**Phase 3**: T011 and T013 alongside the planner work (different test names, same file — coordinate
edits). T015 and T016 are written together, then T017 implements both. T018/T019 (policy guard) can
proceed in parallel with T020/T021 (budget guard) — different functions, same file.

**Phase 4**: T028, T030 and T032 in parallel (T032 is a different file).

**Phase 6**: T039/T040 (relocation) run in parallel with T041–T045 (gate tests) — disjoint files. T041,
T042, T043, T044 are four parallel test-writing tasks feeding one implementation (T046). T053 parallel
with T054.

**Phase 7**: T056, T057, T058, T060, T061, T062 all parallel.

---

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)** — 25 tasks. That alone ends the false-green failure: the
manual loop becomes honest, and no run can claim success without producing verified work. Everything after
it automates or exploits that guarantee.

**Increment 2 = + Phase 4 (US2)** — freshness without a human remembering. US1 + US2 is a complete,
shippable feature; the trim can wait indefinitely without either becoming stale.

**Increment 3 = + Phase 5 + Phase 6 (US4, US3)** — the payoff, and the highest-risk work. Deliberately
last: relocating load-bearing operational detail into a bundle is only safe once that bundle can be
regenerated reliably (US1) and does not silently fall behind (US2).

**Suggested stopping points**: after T025 (MVP), after T035 (automated freshness), after T055 (complete).
Each is a coherent state that can sit on `main` indefinitely.

**Highest-risk tasks**: T050 (the trim — paid, large, historically the failure case), T040 (relocation must
update concepts and inbound links in lockstep or the OKF gate fails), and T033 (debounce semantics are easy
to get subtly wrong and hard to observe).

**Deliberately untasked**: FR-023a — substituting a narrower write credential for `CD_PUSH_TOKEN` is an
operator decision about credential scope, not implementation work. It is recorded as a residual in
[plan.md](plan.md)'s Constitution Check rather than fabricated into a task.
