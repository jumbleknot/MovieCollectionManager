---

description: "Task list for feature 107: version-pin guard"
---

# Tasks: Version-pin guard — every pin is managed or excused

**Input**: Design documents from `/specs/107-version-pin-guard/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli.md, contracts/exclusions-file.md, quickstart.md

**Tests**: REQUIRED (constitution "Test-Driven Development", NON-NEGOTIABLE). Test tasks carry
**Verify RED**; their paired implementation tasks carry **Verify GREEN**
(`docs/templates/feature-test-tasks-template.md`). Doc and config tasks use **Done when**.

**Organization**: grouped by user story. US1 and US2 are both P1; US1 (the detector and verdict) is
the MVP and US2 (the honest day-one inventory) builds on it. US3 (exclusion hygiene) is P2.

**Instrument notes** (item #1135, AGENTS.md):

- node's flags go BEFORE the path: `node --test --test-name-pattern="<pattern>" scripts/__tests__/check-version-pins.test.mjs`. A pattern after the path is ignored and runs everything.
- The node reporter's summary lines are `ℹ pass N` / `ℹ fail N`, not `# pass`.
- If rtk swallows grep or `git log -S` output, re-run it under `rtk proxy`.

All new code goes in `scripts/check-version-pins.mjs`, and all new tests in
`scripts/__tests__/check-version-pins.test.mjs`. Same-file tasks are therefore sequential, and **[P]**
appears only where a task touches a different file.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: the skeleton every story builds on.

- [ ] T001 Create `scripts/check-version-pins.mjs` as an `isMain` CLI shell (`scripts/lib/is-main.mjs`) over the shared argv contract (`scripts/lib/argv-contract.mjs`: `partitionArgs`, `dieOnArgvError`), accepting only `--json` and `--help` (contracts/cli.md). Export empty stubs `detectPins`, `managedOccurrences`, `classifyPins` and `loadExclusions`, so the test file can import them and fail on behaviour, not on import. Use Node built-ins only (plan, Technical Context).
  - **Done when**: `node scripts/check-version-pins.mjs --help` prints usage and exits 0, and `node scripts/check-version-pins.mjs --bogus` exits 2.
- [ ] T002 Create `scripts/__tests__/check-version-pins.test.mjs` with a fixture helper that builds an in-memory tree `{ path: text }` and a minimal `renovate.json` object, so every rule test is a pure function call with no disk access.
  - **Done when**: `node --test scripts/__tests__/check-version-pins.test.mjs` runs and reports `ℹ fail 0`, with zero tests.
- [x] T003 **Doc-impact sweep** (REQUIRED; constitution "Documentation"). Terms: the new identifiers `check-version-pins` and `version-pin-exclusions`; the day-one pins whose management changes (`DOCKER_COMPOSE_VERSION`, `GRADLE_VERSION`, `SPECKIT_VERSION`, `POWERSHELL_VERSION`, `CCUSAGE_VERSION`); and the surfaces edited (`customManager`, `renovate-config`). Nothing is renamed or removed.
  Command, per term (with `--untracked`, per item #1134):
  `git grep -n --untracked -F "<term>" -- '*.md' ':!specs/' ':!docs/proposals/' ':!docs/decisions/'`
  Results (2026-11-24, branch `107-version-pin-guard` at fb7f25e7):
  - `check-version-pins`, `version-pin-exclusions`: no hits. These are new; the docs are written in T030.
  - `DOCKER_COMPOSE_VERSION`, `POWERSHELL_VERSION`, `CCUSAGE_VERSION`: no hits. The new rows go in the §8 pin table → T031.
  - `GRADLE_VERSION` `openwiki/projects/repository.md:186`: no change. It states the version and that SDK 58's wrapper holds it, which stays true whether T018 decides on a manager or an exclusion.
  - `SPECKIT_VERSION` `docs/runbooks/spec-kit.md:47` (the upgrade table, row 6) → T032 if T021 resolves it as an exclusion: the row gains a pointer saying the pin is deliberately unmanaged, and why.
  - `SPECKIT_VERSION` `docs/runbooks/dev-environment-setup.md:52`: no change. It is an install instruction that names the pin, not its management.
  - `customManager` `docs/runbooks/renovate.md:1093-1099` (§8 pin table) → T031. Lines 635, 927-929 and 1051, 1187 and 1198: no change; each is a specific past case.
  - `customManager` `docs/runbooks/wiki-maintenance.md:64`: no change, as a rule. G14 reads `managerFilePatterns` at check time. A new pattern naming `scripts/lib/cc-usage/write-oracle.mjs` would make that file bot-rewritten. Checked: no openwiki page has it, or `.devcontainer/toolchain.Dockerfile`, as `resource`, so G14 stays green (re-verified in T036).
  - `customManager` in `openwiki/projects/ci-cd-pipeline.md:57,60`, `openwiki/runbooks/ci-diagnostics.md:154` and `openwiki/runbooks/infra-image-scanning.md:515,596`: no change. These are specific past managers.
  - `customManager` `openwiki/runbooks/renovate.md` (multiple lines): refreshed from its resource → T033.
  - `renovate-config` `docs/runbooks/renovate.md:1239-1241` (the §9 "where" table) → T030 adds the guard's step to the job description.
  - `renovate-config` `docs/runbooks/renovate.md:1294` (Related: the guardrails job) → T030 names the new step.
  - `renovate-config` `docs/runbooks/sast-scanning.md:467` and `openwiki/projects/sast.md:749`: no change. They state that the job runs the sha256 `--check`, which stays true.
  - `renovate-config` `docs/MCM-Learnings.md:435`: no change. It is history.
  - `renovate-config` `openwiki/projects/ci-cd-pipeline.md:65` and `openwiki/runbooks/renovate.md:578`: no change. They concern the validator.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the coverage evaluator (research R1, R2). US1's verdict and US2's inventory both depend on
it.

- [ ] T004 Write the coverage tests in `scripts/__tests__/check-version-pins.test.mjs`. They must show:
  - **(a)** a customManager whose `managerFilePatterns` match the file and whose `matchStrings` capture `currentValue` on line N covers line N only;
  - **(b)** the same file pattern with a `matchStrings` that captures nothing covers nothing (the nx #194 shape);
  - **(c)** a `managerFilePatterns` `/regex/` entry versus a glob entry, both resolved against a repository-relative forward-slash path;
  - **(d)** a capture spanning a line break is attributed to the line where `currentValue` starts;
  - **(e)** a manager with `matchStringsStrategy: "combination"` makes `managedOccurrences` throw an error naming the manager;
  - **(f)** the built-in table covers `actions/setup-node:node-version`, `actions/setup-python:python-version`, `actions/setup-go:go-version` and `astral-sh/setup-uv:version`, and nothing else (pinned, naming `dist/modules/manager/github-actions/known-actions/github-releases.js` as the file to re-read on a Renovate major).
  - **Scenarios covered**: FR-003; spec Edge Case "file pattern covers but match pattern misses"; FR-010 (the second bullet); research R1 Known limit; R2 Drift guard.
  - **Verify RED**: `node --test --test-name-pattern="coverage" scripts/__tests__/check-version-pins.test.mjs` → expected: 6 failing. The stubs return an empty map, so the assertion `line 12 is covered by aquasecurity/trivy` fails, and (e) fails with `Missing expected exception`.
- [ ] T005 Implement `managedOccurrences(tree, renovateConfig)` in `scripts/check-version-pins.mjs`:
  - compile each `matchStrings` entry as a JS RegExp with flags `gd`;
  - run it over each file that a `managerFilePatterns` entry matches;
  - map each `currentValue` capture's start index to a 1-based line number;
  - return `Map<file, Map<line, managerName>>`, where the manager name is the `depNameTemplate`, or the `packageNameTemplate` if there is no depName (data-model.md `Coverage.manager`);
  - throw on any `matchStringsStrategy` other than `any` or absent.

  Add the exported `BUILTIN_ACTION_INPUTS` table (research R2). (Prerequisite: T004 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="coverage" scripts/__tests__/check-version-pins.test.mjs` → expected: `ℹ fail 0`, 6 passing.

**Checkpoint**: coverage is decided per captured occurrence. Detection can now be built on it.

---

## Phase 3: User Story 1 — A new unmanaged pin cannot merge silently (Priority: P1) 🎯 MVP

**Goal**: The detector finds every pin shape. Any pin that is neither covered nor excluded fails the
check, which names the file, line, name, value and both remedies.

**Independent Test**: quickstart.md scenario 2. Append `FOO_VERSION=1.2.3` to
`scripts/ci-install-trivy.sh`, run the check, and see exit 1 with an `UNMANAGED
scripts/ci-install-trivy.sh:<n> FOO_VERSION = 1.2.3` line. Revert, and see exit 0.

### Tests for User Story 1 (REQUIRED — TDD checkpoint format) ⚠️

- [ ] T006 [US1] Write the detector tests for shape `assignment` in `scripts/__tests__/check-version-pins.test.mjs`:
  - `FOO_VERSION=1.2.3` in a `.sh` file;
  - `ARG GRADLE_VERSION=9.4.1` and `ENV X_VERSION 1.2` in a Dockerfile;
  - `const CCUSAGE_VERSION = '20.0.48';` in a `.mjs` file;
  - `SEMGREP_PIN: '1.2.3'` in a workflow `env:`.

  Each yields one Pin with the right `file`, `line`, `shape`, `name` and `value` (data-model.md `Pin.file`, `Pin.line`, `Pin.shape`, `Pin.name`, `Pin.value`). A name without `VERSION` or `PIN` yields nothing. A value that fails the `Pin.value` validation (`latest`, `${X}`) yields nothing.
  - **Scenarios covered**: US1-AC1; FR-002 (first bullet).
  - **Verify RED**: `node --test --test-name-pattern="assignment" scripts/__tests__/check-version-pins.test.mjs` → expected: 5 failing — `expected 1 pin, got 0`.
- [ ] T007 [US1] Write the detector tests for shape `action-input` in `scripts/__tests__/check-version-pins.test.mjs`:
  - block form (`- uses: actions/setup-node@<sha>` then `with:` then an indented `node-version: 26.13.1`);
  - flow form (`with: { node-version: 26.13.1, cache: pnpm }`);
  - a `version: '0.13.9' # uv-version` under `astral-sh/setup-uv`.

  Each yields a Pin named `<owner>/<action>:<input>` on the input's own line. A `with:` key that is not a version input (`cache:`) yields nothing. A `with:` whose step has no attributable `uses:` makes the detector throw, naming file and line (research R3: "a test fails on any `with:` form it cannot attribute").
  - **Scenarios covered**: FR-002 (second bullet); research R3 (flow form: 18 of 25 node-version pins).
  - **Verify RED**: `node --test --test-name-pattern="action-input" scripts/__tests__/check-version-pins.test.mjs` → expected: 4 failing — `expected 1 pin, got 0`.
- [ ] T008 [US1] Write the detector tests for shape `command-spec`, and for the exclusions from detection, in `scripts/__tests__/check-version-pins.test.mjs`:
  - `npm install -g openwiki@1.2.3` in a workflow `run:` block, in a `.sh` file and in a Dockerfile `RUN` each yields a Pin named `openwiki`;
  - `pip install semgrep==1.2.3` yields a Pin named `semgrep`;
  - the same text inside a `.mjs` string literal yields **nothing** (the `pnpm@11.17.0` selftest false positive);
  - lines starting with `#`, `//` or `*` yield nothing in every shape;
  - a file outside the scanned surfaces (a `*.md`, a `specs/` file, a lockfile, a `__tests__/fixtures/` file) yields nothing.
  - **Scenarios covered**: FR-001; FR-002 (third bullet); FR-010 ("a version in a comment or fixture is not flagged"); spec Edge Case "Versions that are not pins".
  - **Verify RED**: `node --test --test-name-pattern="command-spec|not a pin" scripts/__tests__/check-version-pins.test.mjs` → expected: 3 failing on the positive cases — `expected 1 pin, got 0`. The negative cases pass trivially against the stub, so each must be confirmed by a mutation RED in T010.
- [ ] T009 [US1] Write the verdict tests in `scripts/__tests__/check-version-pins.test.mjs`:
  - **(a)** an uncovered, unexcluded Pin classifies as `unmanaged`, `ok: false` (data-model.md `Verdict.unmanaged`);
  - **(b)** a covered Pin classifies as `managed` with its manager name (`Verdict.managed`);
  - **(c)** an action-input Pin on a built-in action is `managed` by `github-actions:<action>`;
  - **(d)** an unmanaged Pin with a valid exclusion `{file, name, reason}` classifies as `excluded` with its reason (`Verdict.excluded`);
  - **(e)** `formatReport` prints `UNMANAGED <file>:<line> <name> = <value>` followed by the two-remedy line, and a summary `── N pins: … ──` on pass and on fail (contracts/cli.md);
  - **(f)** the CLI exits 1 on (a), exits 0 on (b)–(d), and exits 3 on an unreadable `renovate.json`.
  - **Scenarios covered**: US1-AC1, US1-AC2, US1-AC3; FR-004; FR-008; FR-010 (first bullet); contracts/cli.md exit codes.
  - **Verify RED**: `node --test --test-name-pattern="verdict" scripts/__tests__/check-version-pins.test.mjs` → expected: 6 failing — `expected status unmanaged, got undefined`.

### Implementation for User Story 1

- [ ] T010 [US1] Implement `detectPins(tree)` in `scripts/check-version-pins.mjs`:
  - the three shapes in research R3 (data-model.md `Pin.shape`, `Pin.name`);
  - the `Pin.value` validation;
  - comment-line skipping;
  - `command-spec` only in shell contexts: workflow `run:` blocks, `*.sh`, Dockerfile `RUN`;
  - an indentation-aware `with:` scanner covering block and flow forms;
  - one exported `SCANNED_SURFACES` list (FR-001: "listed in one place"): `.forgejo/workflows/*.yml`, `scripts/**/*.{sh,mjs}` minus `scripts/__tests__/`, `**/Dockerfile*` and `*.Dockerfile`, `.devcontainer/**`.

  Read the tree with `git ls-files` (tracked files only; plan, Constraints). Normalise paths to forward slashes (data-model.md `Pin.file`). (Prerequisite: T006–T008 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="assignment|action-input|command-spec|not a pin" scripts/__tests__/check-version-pins.test.mjs` → expected: `ℹ fail 0`. Then run a **mutation RED** for each negative case: delete the comment skip, then the shell-context restriction, then the surface filter, one at a time. Each deletion must turn its named test red. Revert each one.
- [ ] T011 [US1] Implement `classifyPins(pins, coverage, exclusions)`, `formatReport(verdict)`, the `--json` output (contracts/cli.md `--json`), and the exit codes in `scripts/check-version-pins.mjs`. Failures go to stderr as well as stdout. Wrap any instrument failure (an unreadable `renovate.json` or exclusions file, a `managedOccurrences` throw, `git ls-files` failing) as exit 3, never 1. (Prerequisite: T009 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="verdict" scripts/__tests__/check-version-pins.test.mjs` → expected: `ℹ fail 0`, 6 passing. Then `node --test scripts/__tests__/check-version-pins.test.mjs` → `ℹ fail 0`.
- [ ] T012 [US1] Run quickstart.md scenario 2 by hand against the real tree (append `FOO_VERSION=1.2.3` to `scripts/ci-install-trivy.sh`, run, then `git checkout -- scripts/ci-install-trivy.sh`).
  - **Done when**: exit 1, with the `UNMANAGED scripts/ci-install-trivy.sh:<n> FOO_VERSION = 1.2.3` line and both remedies; then the file is restored. The tree as a whole may still fail here on the day-one pins, which US2 resolves.

**Checkpoint**: the detector and verdict work on fixtures and on the real tree.

---

## Phase 4: User Story 2 — Every pin in the tree today is accounted for (Priority: P1)

**Goal**: The real tree passes on an honest inventory. Each unmanaged pin gets a manager, or a
pin-specific exclusion.

**Independent Test**: quickstart.md scenario 1. `node scripts/check-version-pins.mjs` exits 0. Every
pin is listed as `managed (<manager>)` or `excluded ("<reason>")`, and the summary reads
`0 unmanaged · 0 stale · 0 redundant · 0 invalid`.

### Tests for User Story 2 (REQUIRED — TDD checkpoint format) ⚠️

- [ ] T013 [US2] Write the repository-state test in `scripts/__tests__/check-version-pins.test.mjs`. It runs the exported `checkTree()` against the real working tree (`git ls-files`, the real `renovate.json` and `.forgejo/version-pin-exclusions.json`) and asserts `ok: true` and `unmanaged.length === 0`. On failure, the assertion message lists each unmanaged pin as `file:line name = value`.
  - **Scenarios covered**: US2-AC2; SC-002; FR-011.
  - **Verify RED**: `node --test --test-name-pattern="repository tree" scripts/__tests__/check-version-pins.test.mjs` → expected: 1 failing, listing the day-one unmanaged pins (research R4 expects at least `DOCKER_COMPOSE_VERSION`, `GRADLE_VERSION`, `SPECKIT_VERSION`, `POWERSHELL_VERSION` and `CCUSAGE_VERSION`).
- [ ] T014 [US2] Record the day-one inventory. Run `node scripts/check-version-pins.mjs --json` on the unmodified tree and paste into this task the count of pins by status, and every `unmanaged` entry (file:line, name, value). The real detector's output is the answer; the prototype counts in research R4 are a floor (US2-AC1, SC-003).
  - **Done when**: the list is pasted below and its count is stated. Each entry has its own resolution task below (T015–T023). A pin the real detector finds beyond research R4's five gets a resolution task appended here before continuing.
  - Inventory: _(to be filled)_

### Implementation for User Story 2

For each pin given a customManager, the TDD unit is the evaluator itself. The repository-state test
(T013) is the RED, and the paired coverage assertion is the GREEN.

- [ ] T015 [P] [US2] Add a customManager to `renovate.json` for `DOCKER_COMPOSE_VERSION` in `.devcontainer/toolchain.Dockerfile`. Use datasource `github-releases`, depName `docker/compose`, and a `matchStrings` that captures the `v5.3.1` form (research R4).
  - **Done when**: `node scripts/check-version-pins.mjs` reports `managed … DOCKER_COMPOSE_VERSION … ← docker/compose`, and `npx --yes --package renovate@"$(cat .forgejo/renovate-version)" -- renovate-config-validator --strict renovate.json` exits 0.
- [ ] T016 [P] [US2] Add a customManager to `renovate.json` for `POWERSHELL_VERSION` in `.devcontainer/toolchain.Dockerfile` (datasource `github-releases`, depName `PowerShell/PowerShell`, `extractVersionTemplate` stripping a leading `v` if the tag carries one). Read the Dockerfile's download URL first, to confirm which tag form the value has to match.
  - **Done when**: as T015, with `← PowerShell/PowerShell`.
- [ ] T017 [P] [US2] Add a customManager to `renovate.json` for `CCUSAGE_VERSION` in `scripts/lib/cc-usage/write-oracle.mjs` (datasource `npm`, depName `ccusage`). Add a comment beside the constant saying that a bump must re-record the oracle fixtures, naming the command from `docs/runbooks/dev-usage.md` (research R4). Confirm that no openwiki page has `scripts/lib/cc-usage/write-oracle.mjs` as `resource` (G14; T003).
  - **Done when**: as T015, with `← ccusage`, and `pnpm nx okf-governance infrastructure-as-code` passes.
- [ ] T018 [US2] Decide `GRADLE_VERSION` against `docs/runbooks/android-emulator.md` and the Expo SDK's gradle wrapper. A wrapper or prebuild that fixes the version that is actually used means the Dockerfile pin follows the SDK, so it gets an exclusion naming that. A pin that is independent gets a customManager (datasource `gradle-version`). Record the decision and its evidence (file:line) in this task.
  - **Done when**: the decision and its evidence are written here, and T019 or T020 is struck through as not applicable.
- [ ] T019 [US2] (if T018 says manager) Add the `GRADLE_VERSION` customManager to `renovate.json`.
  - **Done when**: as T015, with `← gradle`.
- [ ] T020 [US2] (if T018 says exclusion) Add the `GRADLE_VERSION` entry to `.forgejo/version-pin-exclusions.json`. Its reason names the Expo SDK wrapper that holds the version (data-model.md `Exclusion.file`, `Exclusion.name`, `Exclusion.reason`).
  - **Done when**: the check lists it as `excluded` with that reason.
- [ ] T021 [US2] Create `.forgejo/version-pin-exclusions.json` (contracts/exclusions-file.md) with the `SPECKIT_VERSION` entry for `.devcontainer/toolchain.Dockerfile`. Its reason: Spec Kit upgrades are the reviewed procedure in `docs/runbooks/spec-kit.md`, and the overrides must be re-checked against the new templates (data-model.md `Exclusion.file`, `Exclusion.name`, `Exclusion.reason`). If T020 applies, add its entry in the same file.
  - **Done when**: the check lists `SPECKIT_VERSION` as `excluded` with its reason, and the file parses as a JSON array.
- [ ] T022 [US2] Run `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`. The new customManagers must satisfy its per-manager assertions (for example, that each manager captures in its named file). If one of its guards fails because of a new manager, update the guard at the cause, per AGENTS.md: make it assert the new premise, and never delete it.
  - **Done when**: `ℹ fail 0`.
- [ ] T023 [US2] Resolve every additional unmanaged pin T014 found beyond research R4's five, one task appended per pin under T014, each resolved as T015 or T021 is.
  - **Done when**: T014's list has a resolution against every entry, and the count found equals the count resolved (SC-003).
- [ ] T024 [US2] Make the repository-state test pass. (Prerequisite: T013 verified RED; T015–T023 done.)
  - **Verify GREEN**: `node --test --test-name-pattern="repository tree" scripts/__tests__/check-version-pins.test.mjs` → expected: `ℹ fail 0`. Then `node scripts/check-version-pins.mjs` exits 0, with summary `0 unmanaged · 0 stale · 0 redundant · 0 invalid` (quickstart scenario 1; SC-005).

**Checkpoint**: the real tree is green on an honest, per-pin inventory.

---

## Phase 5: User Story 3 — Exclusions do not rot (Priority: P2)

**Goal**: A stale, redundant or malformed exclusion fails the check, naming the entry.

**Independent Test**: quickstart.md scenario 4. Each bad exclusion fixture fails, naming its entry.

### Tests for User Story 3 (REQUIRED — TDD checkpoint format) ⚠️

- [ ] T025 [US3] Write the exclusion-validity tests in `scripts/__tests__/check-version-pins.test.mjs`. Each of the following is `invalid` and names the entry (data-model.md `Verdict.invalidExclusions`):
  - **(a)** a missing `reason` (`Exclusion.reason`);
  - **(b)** a `reason` of `"n/a"` (under 20 characters after trimming, `Exclusion.reason`);
  - **(c)** a `name` containing `*` (`Exclusion.name`);
  - **(d)** a `file` containing `?` (`Exclusion.file`);
  - **(e)** two entries with the same `{file, name}`;
  - **(f)** an exclusions file that is not a JSON array, which exits 3, not 1.
  - **Scenarios covered**: FR-005; FR-010 ("an exclusion without a reason fails"); contracts/exclusions-file.md.
  - **Verify RED**: `node --test --test-name-pattern="invalid exclusion" scripts/__tests__/check-version-pins.test.mjs` → expected: 6 failing — `expected 1 invalid exclusion, got 0`.
- [ ] T026 [US3] Write the stale and redundant tests in `scripts/__tests__/check-version-pins.test.mjs`. They must show:
  - **(a)** an exclusion matching no Pin is `stale` and the line reads `STALE exclusion {file: x, name: Y} matches no pin — delete it` (`Verdict.staleExclusions`);
  - **(b)** an exclusion whose matched Pins are all covered is `redundant`, naming the manager (`Verdict.redundantExclusions`);
  - **(c)** an exclusion matching two occurrences of one name in one file, one covered and one not, is neither stale nor redundant;
  - **(d)** each of (a) and (b) makes `ok: false`.
  - **Scenarios covered**: US3-AC1, US3-AC2; FR-006; FR-010 ("a stale exclusion fails"); data-model.md state transitions.
  - **Verify RED**: `node --test --test-name-pattern="stale|redundant" scripts/__tests__/check-version-pins.test.mjs` → expected: 3 failing — `expected 1 stale exclusion, got 0`. (c) passes trivially; T028 confirms it by mutation RED.

### Implementation for User Story 3

- [ ] T027 [US3] Implement `loadExclusions(text)` in `scripts/check-version-pins.mjs`, with the validity rules for data-model.md `Exclusion.file`, `Exclusion.name` and `Exclusion.reason`, plus the duplicate rule. A file that does not parse, or is not an array, throws, and the throw becomes exit 3. (Prerequisite: T025 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="invalid exclusion" scripts/__tests__/check-version-pins.test.mjs` → expected: `ℹ fail 0`, 6 passing.
- [ ] T028 [US3] Extend `classifyPins` in `scripts/check-version-pins.mjs` with stale and redundant detection and their report lines (contracts/cli.md). (Prerequisite: T026 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="stale|redundant" scripts/__tests__/check-version-pins.test.mjs` → expected: `ℹ fail 0`. Then a **mutation RED**: make "redundant" mean "any matched pin is covered" instead of "all", and (c) must turn red. Revert. Then the full file: `node --test scripts/__tests__/check-version-pins.test.mjs` → `ℹ fail 0`.

**Checkpoint**: all three stories work. Exclusions are exact, reasoned, live and needed.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: wiring, docs and validation.

- [ ] T029 Wire the check into `.forgejo/workflows/guardrails.yml`: add a step to the `renovate-config` job after the `refresh-pinned-sha256.mjs --check` step, `run: bash scripts/ci-log-step.sh renovate-config-version-pins node scripts/check-version-pins.mjs` (research R5). Add `check-version-pins.mjs` to the `--help` `PROBES` list in `scripts/__tests__/cli-entry-guard.guard.test.mjs` (research R7).
  - **Done when**: `node --test scripts/__tests__/cli-entry-guard.guard.test.mjs` → `ℹ fail 0`. Any guardrails workflow guard test that enumerates the job's steps still passes (`git grep -l "renovate-config" scripts/__tests__` lists them; run each).
- [ ] T030 [P] Add a section "The version-pin guard (item #1128)" to `docs/runbooks/renovate.md`, after §9 (FR-012). It must cover:
  - what is scanned (the `SCANNED_SURFACES` list);
  - the three pin shapes, and why `command-spec` is shell-only;
  - how "managed" is decided (per captured offset; the built-in action table and its re-read on a Renovate major);
  - how to add a manager;
  - how to add an exclusion, and the legitimate-reason rule from contracts/exclusions-file.md;
  - the exit codes;
  - the known limit (research R1).

  Also update the §9 "where" table and the Related entry for the `renovate-config` job (T003 hits `docs/runbooks/renovate.md:1239-1241` and `:1294`).
  - **Done when**: the section exists, and the T003 hits are updated.
- [ ] T031 [P] Add rows for docker compose, PowerShell, ccusage, and gradle if T019 applies, to the §8 pin table in `docs/runbooks/renovate.md` (T003 hit `:1093-1099`), each naming its pin file and its customManager.
  - **Done when**: each new customManager has a row.
- [ ] T032 [P] If `SPECKIT_VERSION` is excluded (T021), add to row 6 of the upgrade table in `docs/runbooks/spec-kit.md:47` that the pin is deliberately unmanaged by Renovate and recorded in `.forgejo/version-pin-exclusions.json`, so the upgrade procedure is the only way it moves (T003 hit).
  - **Done when**: the row says so. If spec-kit.md is any openwiki page's `resource`, that page is refreshed in T033.
- [ ] T033 Refresh the openwiki pages whose `resource` changed: `node scripts/wiki-refresh.mjs --stale`; then, per stale page, `--diff`, edit only what the diff invalidates, and `--record`. `openwiki/runbooks/renovate.md` is expected; `openwiki/runbooks/spec-kit.md` is expected if T032 applied (`.claude/skills/wiki-refresh/SKILL.md`).
  - **Done when**: `node scripts/wiki-refresh.mjs --stale` reports nothing stale.
- [ ] T034 **Close-out re-search**: re-run T003's searches. No identifier was renamed or removed, so the check is the converse: confirm that `check-version-pins` and `version-pin-exclusions` now appear in `docs/runbooks/renovate.md` (and in `openwiki/runbooks/renovate.md`), and that every hit T003 sent to a task is updated.
  - **Done when**: the result is recorded here, one line per term.
- [ ] T035 Run quickstart.md scenarios 1, 2 and 6 by hand.
  - **Done when**: scenario 1 exits 0 with the zero summary; scenario 2 exits 1 naming the file and line, and the file is restored; scenario 6 shows `ℹ fail 0`.
- [ ] T036 Run the touched tiers against a `main` baseline:
  - `node --test scripts/__tests__/` on this branch and on `origin/main` (a worktree or a stash-free checkout), comparing the failure sets, where any failure new on the branch is a regression;
  - `pnpm nx okf-lint infrastructure-as-code`;
  - `pnpm nx okf-governance infrastructure-as-code`;
  - `node scripts/check-toolchain-consistency.mjs`;
  - `npx --yes --package renovate@"$(cat .forgejo/renovate-version)" -- renovate-config-validator --strict renovate.json`.

  No `backend/`, `frontend/` or `agents/` path changes, so the app tiers and the web E2E regression do not apply. Record why here, per `openwiki/invariants/feature-validation-checklist.md`.
  - **Done when**: every command passes, or each pre-existing failure is shown to fail identically on `origin/main`.
- [ ] T037 **Open the PR** from a real branch: `git push origin HEAD:107-version-pin-guard`, then `node scripts/forge-pr.mjs open` (per `docs/runbooks/ci-diagnostics.md`). Tick this task in the branch's LAST commit, quoting the branch, the PR number and that commit's sha. **CI evidence is never recorded here.** The run ids, the `ci-status.mjs` verdict and the merge sha go in the PR's closing comment and in item #1128's closing comment, posted with `MCM_FORGE_ISSUE_TOKEN`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies. T003 is already done.
- **Foundational (Phase 2)**: depends on T001 and T002, and blocks US1's verdict (T009, T011) and all of US2.
- **US1 (Phase 3)**: its detector tests (T006–T008) need only T001 and T002. The verdict (T009, T011) needs T005.
- **US2 (Phase 4)**: needs US1 complete, because the inventory runs the real detector and verdict.
- **US3 (Phase 5)**: needs T011's `classifyPins`. It is independent of US2, so it may run before or after it; the repository-state test (T024) does depend on `loadExclusions` (T027) parsing the committed file. If US3 is done after US2, T021's file is parsed by a stub. Do T027 before T024 in either order.
- **Polish (Phase 6)**: depends on all stories.

### User Story Dependencies

- **US1 (P1)**: depends on Foundational only. This is the MVP.
- **US2 (P1)**: depends on US1 (the detector, the verdict and the CLI) and on T027.
- **US3 (P2)**: depends on US1's `classifyPins`.

### Within Each User Story

- Each test task is Verify RED before its paired implementation task, which is Verify GREEN.
- All code is in one source file and one test file, so tasks in those files run in sequence.
- T015, T016 and T017 touch `renovate.json` in separate entries. They are marked [P] as independent decisions, but the edits must be serialised or merged: one file.

### Parallel Opportunities

- T015, T016 and T017: three independent manager decisions, researched in parallel (one file; merge the edits).
- T030, T031 and T032: docs in separate sections and files.
- US3's tests (T025, T026) can be written while US2's manager research (T015–T018) proceeds, since they touch different files.

---

## Parallel Example: User Story 2

```bash
# Research the three customManagers in parallel; land the renovate.json edits one at a time:
Task: "T015 customManager for DOCKER_COMPOSE_VERSION in renovate.json"
Task: "T016 customManager for POWERSHELL_VERSION in renovate.json"
Task: "T017 customManager for CCUSAGE_VERSION in renovate.json"
# Independently, decide the Android pin:
Task: "T018 decide GRADLE_VERSION against docs/runbooks/android-emulator.md"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 (T001, T002) and Phase 2 (T004, T005): the evaluator.
2. Phase 3 (T006–T012): detector and verdict.
3. **Stop and validate**: quickstart scenario 2 fails correctly on a mutated tree.

US1 alone is not mergeable: the real tree fails on its day-one pins. The merge unit is US1 + US2,
because FR-007 makes the check required and SC-002 requires a green `main`.

### Incremental Delivery

1. US1: the guard works on fixtures and names the real tree's gaps.
2. US2: the gaps are resolved and the tree is green. This is the first mergeable state, and it could
   ship on its own with a minimal `loadExclusions`.
3. US3: exclusion hygiene. Ship it in the same PR (`openwiki/process/pull-request-batching.md`: one
   feature, one failure surface), since a stale-exclusion rule written after the exclusions file exists
   is cheap now and easy to forget later.

---

## Notes

- `[P]` means a different file with no dependency on an incomplete task. Most tasks here share
  `scripts/check-version-pins.mjs` and are sequential on purpose.
- A Verify RED that shows 0 failures means the test is trivially passing. Fix it before implementing;
  where a negative case passes trivially, its mutation RED is named in the paired GREEN task.
- Commit from the `E:\Programming\VSCode\mcm-wt\spec107` worktree, never the shared checkout.
