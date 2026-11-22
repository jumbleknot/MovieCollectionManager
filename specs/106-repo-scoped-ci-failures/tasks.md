---

description: "Task list for feature 106: repo-scoped CI evidence-bundle package"
---

# Tasks: Repo-scoped CI evidence-bundle package

**Input**: Design documents from `specs/106-repo-scoped-ci-failures/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/evidence-package.md](contracts/evidence-package.md),
[quickstart.md](quickstart.md)

**Tests**: REQUIRED (constitution "Test-Driven Development"). Test tasks carry the scenarios covered and a
**Verify RED**; the paired implementation task carries **Verify GREEN**. Doc and config tasks use
"Done when". Format: `docs/templates/feature-test-tasks-template.md`.

All commands run from the repository root. A `node --test` file argument goes AFTER any node flag
(AGENTS.md instrument trap). The suite baseline is the same suite on unmodified `main`: on a Windows
host, failures present on `main` (e.g. `(m6)`, the `ajv`-less `sast-scan.guard`) are not regressions.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 **Doc-impact sweep** (constitution "Documentation"). Terms: `ci-failures`, `BUNDLE_PACKAGE`.
  Command, per term: `git grep -n -F "<term>" -- '*.md' ':!specs/' ':!docs/proposals/' ':!docs/decisions/'`
  (run 2026-11-22 at task generation). `BUNDLE_PACKAGE`: 0 hits. `ci-failures` hits:
  - [x] `docs/runbooks/Server-Setup-Runbook.md:429` (retention: bundles pruned by the digest) → T023
  - [x] `docs/runbooks/Server-Setup-Runbook.md:589`, `:594`: no change. A size/count comparison naming the kind of bundle; true of either name.
  - [x] `docs/runbooks/ci-diagnostics.md:610`: no change. A dated incident record (`ci-failures:3946--…` is that run's real name).
  - [x] `docs/runbooks/ci-diagnostics.md:616`, `:803`, `:1236` (list/fetch commands) → T021
  - [x] `docs/runbooks/ci-diagnostics.md:875`: no change. A dated measurement table.
  - [x] `docs/runbooks/ci-evidence-pipeline.md:68`, `:330` → T022
  - [x] `docs/runbooks/wiki-maintenance.md:437`, `:439` → T024
  - [x] `openwiki/projects/ci-cd-pipeline.md:151` (canonical, no upstream) → T025
  - [x] `openwiki/runbooks/ci-diagnostics.md`, `ci-evidence-pipeline.md`, `server-setup.md`, `wiki-maintenance.md`, `index.md`: derived summaries, refreshed from their resources → T026

---

## Phase 2: Foundational (naming)

**Purpose**: the single source of the package name that every later task uses
([contract](contracts/evidence-package.md) § Exported surface).

- [ ] T002 Write naming tests in `scripts/__tests__/ci-failure-digest.test.mjs`:
  - `bundlePackageFor('mcm')` → `mcm-ci-failures`
  - `bundlePackageFor('BELAY')` → `belay-ci-failures`
  - `bundlePackageFor('')` and `bundlePackageFor(undefined)` throw
  - `bundlePackagesFor('mcm')` → `['mcm-ci-failures', 'ci-failures']`
  - `isEvidencePackage` is true for `ci-failures`, `mcm-ci-failures` and `belay-ci-failures`, and false for `mcm-app-android` and `ci-failures-old`
  - `BUNDLE_PACKAGE` is no longer exported
  - **Scenarios covered**: US1-AC1, US1-AC2; FR-001, FR-002 (data-model.md `Evidence package.name`)
  - **Verify RED**: `node --test --test-name-pattern="bundle package" scripts/__tests__/ci-failure-digest.test.mjs` → expected: the new tests fail (`bundlePackageFor is not a function`)
- [ ] T003 Implement `LEGACY_BUNDLE_PACKAGE`, `bundlePackageFor`, `bundlePackagesFor` and `isEvidencePackage` in `scripts/ci-failure-digest.mjs`, and remove `BUNDLE_PACKAGE` (prerequisite: T002 RED)
  - **Verify GREEN**: the T002 command → 0 failures

**Checkpoint**: naming exists. `ci-status.mjs` still imports `BUNDLE_PACKAGE` and is fixed in T012.

---

## Phase 3: User Story 1 - New evidence lands in this repository's own package (P1) 🎯 MVP

**Goal**: the digest writes only to `<repo>-ci-failures`, and its posted reference and link name it.

**Independent Test**: stub `fetch`, drive the exported `httpApi` for repo `jumbleknot/mcm` and a
decoy identity, and assert every write URL.

### Tests for User Story 1 ⚠️

- [ ] T004 [US1] Test in `scripts/__tests__/ci-failure-digest.test.mjs`: `httpApi({ base, owner: 'jumbleknot', repo: 'mcm', token })`
  `.uploadBundle(v, 'bundle.json.gz', buf)` PUTs to `/api/packages/jumbleknot/generic/mcm-ci-failures/<v>/bundle.json.gz`
  (stubbed `globalThis.fetch` records the URL). With `repo: 'BELAY'` it PUTs to `belay-ci-failures`.
  No call ever targets `/generic/ci-failures/`.
  - **Scenarios covered**: US1-AC1, US1-AC2; FR-001, FR-003
  - **Verify RED**: `node --test --test-name-pattern="repo-scoped upload" scripts/__tests__/ci-failure-digest.test.mjs` → expected: fails (`httpApi` not exported, or URL `…/ci-failures/…`)
- [ ] T005 [US1] Test: `bundleRefFor(pkg, version)` → `mcm-ci-failures:1--x`, and `bundleUrlFor({ base: 'https://f/api/v1', owner: 'o', pkg, version })` → `https://f/o/-/packages/generic/mcm-ci-failures/1--x`
  - **Scenarios covered**: US1-AC1; FR-004 (data-model.md `Bundle reference.bundleRef`, `.bundleUrl`)
  - **Verify RED**: `node --test --test-name-pattern="bundle reference" scripts/__tests__/ci-failure-digest.test.mjs` → expected: fails (not exported)
- [ ] T006 [US1] Test: `forgeEndpoint({})` with a git remote that does not parse throws `could not resolve the forge API base`. It never yields a legacy-name fallback.
  - **Scenarios covered**: US1-AC3, spec edge case "no repository identity"; FR-002
  - **Verify RED**: `node --test --test-name-pattern="no repository identity" scripts/__tests__/ci-failure-digest.test.mjs` → expected: fails (`forgeEndpoint` not exported)

### Implementation for User Story 1

- [ ] T007 [US1] In `scripts/ci-failure-digest.mjs`:
  - export `httpApi` and `forgeEndpoint` (add an optional injected `remote` reader so T006 needs no real git)
  - compute `pkg = bundlePackageFor(repo)` once inside `httpApi`; `uploadBundle` uses it
  - add and export `bundleRefFor` and `bundleUrlFor`; `main()` sets `context.bundleRef` and `context.bundleUrl` through them

  (prerequisite: T004–T006 RED)
  - **Verify GREEN**: the T004, T005 and T006 commands → 0 failures; then `node --test scripts/__tests__/ci-failure-digest.test.mjs` and `node scripts/ci-failure-digest.mjs --selftest` pass

**Checkpoint**: new evidence is repo-scoped.

---

## Phase 4: User Story 2 - Existing evidence stays reachable (P1)

**Goal**: `ci-status` reads both names: exact filter, dedupe, fallback fetch, per-version durations.

**Independent Test**: the ci-status fake forge (`scripts/__tests__/ci-status.test.mjs`, the
`/generic/…/bundle.json.gz` stub near line 2051) serves versions under `mcm-ci-failures`,
`ci-failures` and a `belay-ci-failures` decoy.

### Tests for User Story 2 ⚠️

- [ ] T008 [P] [US2] Test in `scripts/__tests__/ci-status.test.mjs`:
  - `mergeBundleListings([{name:'mcm-ci-failures', items}, {name:'ci-failures', items}])` tags each item with `name`
  - it drops any item whose `name` differs from its listing (the `belay-ci-failures` decoy that a substring `q=` search returns)
  - it dedupes by `version`, the repo-scoped entry winning
  - **Scenarios covered**: US2-AC5, spec edge cases "substring search" and "both names"; FR-006 (data-model.md `Listed version.name`)
  - **Verify RED**: `node --test --test-name-pattern="bundle listings" scripts/__tests__/ci-status.test.mjs` → expected: fails (`mergeBundleListings` not exported)
- [ ] T009 [P] [US2] Test: `failure --run <id> --full` against the fake forge:
  - a run present only under `ci-failures` is fetched from the legacy URL, after a 404 from `mcm-ci-failures`
  - a run under `mcm-ci-failures` is fetched with one GET
  - a run under neither prints the unchanged "no bundle exists" line
  - **Scenarios covered**: US2-AC1, US2-AC2, US2-AC4; FR-007
  - **Verify RED**: `node --test --test-name-pattern="legacy bundle fallback" scripts/__tests__/ci-status.test.mjs` → expected: fails (the legacy-only run reports absent)
- [ ] T010 [P] [US2] Test: `durations --job app-e2e --runs 3` with run ids 10 and 9 under `mcm-ci-failures`, and 8 and 7 under `ci-failures`, samples 10, 9 and 8. It requests 8's durations file from `/generic/ci-failures/8--app-e2e/…` and 10's from `/generic/mcm-ci-failures/…`.
  - **Scenarios covered**: US2-AC3; FR-008
  - **Verify RED**: `node --test --test-name-pattern="durations across both" scripts/__tests__/ci-status.test.mjs` → expected: fails (samples one package, or wrong URL)
- [ ] T011 [US2] Update the existing fake-forge regex (`/\/generic\/ci-failures\/…/`, near line 2051) and the `describeAuthFailure` fixture path (near line 77) to accept `([^/]+)` as the package. Existing tests otherwise unchanged.
  - **Done when**: the existing ci-status tests pass unchanged in intent after T012

### Implementation for User Story 2

- [ ] T012 [US2] In `scripts/ci-status.mjs`:
  - import `bundlePackagesFor`, and export `mergeBundleListings`
  - `listBundleVersions(conn)` lists each package by exact name (paginated as today) and merges
  - `fetchBundle` tries each package in order and returns `null` only when every one 404s
  - `cmdDurations` builds each URL from `v.name`
  - messages name the repo-scoped package

  (prerequisite: T008–T010 RED)
  - **Verify GREEN**: the T008–T010 commands → 0 failures; then `node --test scripts/__tests__/ci-status.test.mjs` passes

**Checkpoint**: no pre-cutover evidence is unreachable.

---

## Phase 5: User Story 3 - Retention covers both names, legacy drains (P2)

**Goal**: the digest prunes both names by exact name. The retention guard holds for every evidence
package, and the committed config lists both.

**Independent Test**: unit tests over the exported prune and loader, and over the committed YAML.

### Tests for User Story 3 ⚠️

- [ ] T013 [P] [US3] Test in `scripts/__tests__/ci-failure-digest.test.mjs`: exported `pruneExpiredBundles(api)` with a fake api.
  - `listBundleVersions()` returns tagged items: expired and fresh under `mcm-ci-failures` and under `ci-failures`
  - `deleteBundleVersion(version, name)` is called exactly for the expired ones, each with its own `name`
  - `httpApi(...).listBundleVersions()` (stubbed fetch) queries both names and excludes a `belay-ci-failures` item from the response
  - **Scenarios covered**: US3-AC3, US3-AC4; FR-005
  - **Verify RED**: `node --test --test-name-pattern="prune both names" scripts/__tests__/ci-failure-digest.test.mjs` → expected: fails (not exported, or deletes without a name)
- [ ] T014 [P] [US3] Test in `scripts/__tests__/registry-retention.test.mjs`: the existing short-window refusals (near lines 97 and 103) are repeated for `mcm-ci-failures`, and each error names that package. A non-evidence generic package with a short window still loads.
  - **Scenarios covered**: US3-AC2; FR-010 (data-model.md `Retention entry.keepDays`, `.keepNewest`)
  - **Verify RED**: `node --test --test-name-pattern="evidence package" scripts/__tests__/registry-retention.test.mjs` → expected: fails (`mcm-ci-failures` with a short window loads)
- [ ] T015 [P] [US3] Test: the committed `infrastructure-as-code/forgejo/registry-retention.yaml`, loaded, lists exactly the names `bundlePackagesFor('mcm')` returns among its evidence packages, with equal `keepDays` and `keepNewest`.
  - **Scenarios covered**: US3-AC1; FR-009
  - **Verify RED**: `node --test --test-name-pattern="committed config covers both" scripts/__tests__/registry-retention.test.mjs` → expected: fails (`mcm-ci-failures` missing)

### Implementation for User Story 3

- [ ] T016 [US3] In `scripts/ci-failure-digest.mjs`, `httpApi`:
  - `listBundleVersions()` loops `bundlePackagesFor(repo)` with an exact-name filter and tags each item
  - `deleteBundleVersion(version, name)` deletes under `name`
  - export `pruneExpiredBundles`, which passes `p.name`

  (prerequisite: T013 RED)
  - **Verify GREEN**: the T013 command → 0 failures
- [ ] T017 [US3] In `scripts/registry-retention.mjs`, apply the floor guard to `isEvidencePackage(p.name)` (imported from the digest), with messages naming `p.name`. Update the `bundlePublishingJobs` doc comment. (prerequisite: T014 RED)
  - **Verify GREEN**: the T014 command → 0 failures
- [ ] T018 [US3] In `infrastructure-as-code/forgejo/registry-retention.yaml`, add `{ name: mcm-ci-failures, type: generic, keepNewest: 650, keepDays: 45 }` beside the legacy entry, with a comment stating the transition and its end (contract § Transition end). (prerequisite: T015 RED)
  - **Verify GREEN**: the T015 command → 0 failures; `node --test scripts/__tests__/registry-retention.test.mjs` passes

**Checkpoint**: legacy drains within 30 days, and neither name can be configured short.

---

## Phase 6: User Story 4 - The runbook says when to drop the legacy name (P3)

- [ ] T019 [US4] Add a "Evidence package name (feature 106)" note to `docs/runbooks/ci-diagnostics.md` covering:
  - the `<repo>-ci-failures` derivation
  - the transition (readers and prune cover `ci-failures`)
  - the cutover = this PR's merge date
  - the earliest drop date = cutover + 30 days, confirmed by an empty listing
  - the three removals (contract § Transition end)
  - **Done when**: the note exists and names all three removal sites; US4-AC1

---

## Phase 7: Polish & Cross-Cutting

- [ ] T020 [P] Update `specs/042-ci-self-serve-diagnostics/contracts/bundle-layout.md` § Identity: the package becomes `<repo>-ci-failures` (no longer a constant), with a dated amendment pointing to `specs/106-repo-scoped-ci-failures/contracts/evidence-package.md`. Update `contracts/digest-format.md:53`'s example reference to `mcm-ci-failures:…`.
  - **Done when**: no line in either contract presents `ci-failures` as the current name
- [ ] T021 [P] Update `docs/runbooks/ci-diagnostics.md` commands at lines 616, 803 and 1236 to the repo-scoped name. Keep the dated incident at 610 and the table at 875.
  - **Done when**: each command lists or fetches `<repo>-ci-failures` (and the transition note covers legacy)
- [ ] T022 [P] Update `docs/runbooks/ci-evidence-pipeline.md:68` and `:330` to the repo-scoped name.
  - **Done when**: both lines name `<repo>-ci-failures`
- [ ] T023 [P] Update `docs/runbooks/Server-Setup-Runbook.md:429` (retention: both evidence names are pruned by the digest; the config floors both).
  - **Done when**: the paragraph names both names and the transition
- [ ] T024 [P] Update `docs/runbooks/wiki-maintenance.md:437` and `:439` to `<repo>-ci-failures`.
  - **Done when**: both lines name the repo-scoped package
- [ ] T025 Update canonical `openwiki/projects/ci-cd-pipeline.md:151` ("raises the `ci-failures` retention floor") to name both evidence entries.
  - **Done when**: `node scripts/check-openwiki-okf.mjs` and `node scripts/check-openwiki-governance.mjs` pass (re-fingerprint a protected passage only via `--fingerprint`, in the same change)
- [ ] T026 Refresh every derived page `node scripts/wiki-refresh.mjs --stale` lists (expected: the openwiki mirrors of ci-diagnostics, ci-evidence-pipeline, server-setup and wiki-maintenance). Per page run `--diff`, edit only what it invalidates, then `--record`. Then fix `openwiki/runbooks/index.md` if a page description changed.
  - **Done when**: `--stale` prints nothing; okf and governance pass
- [ ] T027 **Close-out re-search**: re-run T001's searches. Every remaining `ci-failures` hit in a current-procedure doc either names the legacy package inside the transition note, or is a record listed as "no change" in T001.
  - **Done when**: the result is recorded under this task
- [ ] T028 Run the validation in [quickstart.md](quickstart.md) §1–§2:
  - the three test files
  - `node scripts/ci-failure-digest.mjs --selftest`
  - `node scripts/check-ci-digest-coverage.mjs`
  - `node scripts/registry-retention.mjs --package mcm-ci-failures` (report mode, needs `MCM_FORGE_URL` + `MCM_FORGE_TOKEN`)
  - the full `node --test scripts/__tests__/*.test.mjs` compared with `main`
  - **Done when**: no failure absent on `main`; the counts are recorded in the PR body
- [ ] T029 File a backlog item (`scripts/backlog.mjs`, forgejo-issues skill): "Drop the legacy `ci-failures` evidence package (feature 106)", due cutover + 30 days, listing the three removals.
  - **Done when**: the item number is quoted in the PR body
- [ ] T030 **Open the PR** from a real branch (`git push origin HEAD:106-repo-scoped-ci-failures`, then `node scripts/forge-pr.mjs open`). Tick this task in the branch's LAST commit, quoting the branch, PR number and that commit's sha. CI evidence goes in the PR's closing comment, never here.

---

## Dependencies & Execution Order

- **T001** done. **T002 → T003** blocks everything.
- **US1** (T004–T007) and **US2** (T008–T012) both need T003; they touch different files and can run
  in parallel. T012 also clears the `BUNDLE_PACKAGE` import that T003 breaks, so do T012 before running
  the full suite.
- **US3**: T013/T016 share `ci-failure-digest.mjs` with US1, so run after T007. T014/T017 and T015/T018
  are independent of US1 and US2.
- **US4** and **Polish** follow the code. T026 follows T019–T025, since they change wiki resources.
  T027 follows T026. T030 is last.

## Parallel Example

```bash
# After T003:
Task: "T008–T010 ci-status tests"          # scripts/__tests__/ci-status.test.mjs
Task: "T014–T015 registry-retention tests" # scripts/__tests__/registry-retention.test.mjs
Task: "T004–T006 digest tests"             # scripts/__tests__/ci-failure-digest.test.mjs
```

## Implementation Strategy

MVP = Phase 2 + US1 + US2 together. Shipping US1 alone would make pre-cutover evidence unreachable,
so the two P1 stories are one increment. US3 is required in the same PR because the retention config
must cover the new name from its first version. US4 and the polish finish the transition record. This
is one PR: per the PR-batching rule, a failure in any part is unambiguous to its file.
