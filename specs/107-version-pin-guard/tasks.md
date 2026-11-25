---

description: "Task list for feature 107: version-pin guard"
---

# Tasks: Version-pin guard — every pin is managed or excused

**Input**: Design documents from `/specs/107-version-pin-guard/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli.md, contracts/exclusions-file.md, quickstart.md

**Tests**: REQUIRED (constitution "Test-Driven Development", NON-NEGOTIABLE). Each test task carries
**Verify RED**, and its paired implementation task carries **Verify GREEN**
(`docs/templates/feature-test-tasks-template.md`). Doc and config tasks use **Done when**.

**Organization**: grouped by user story. US1 and US2 are both P1:
- US1 (detector, verdict, exclusion validity) is the MVP;
- US2 (the honest day-one inventory) builds on it;
- US3 (stale and redundant exclusions) is P2.

**Instrument notes** (item #1135, AGENTS.md):

- node's flags go BEFORE the path: `node --test --test-name-pattern="<pattern>" scripts/__tests__/check-version-pins.test.mjs`. A pattern placed after the path is ignored, and everything runs.
- The node reporter's summary lines are `ℹ pass N` / `ℹ fail N`, not `# pass`.
- If rtk swallows grep or `git log -S` output, re-run it under `rtk proxy`.

All new code goes in `scripts/check-version-pins.mjs`, and all new tests in
`scripts/__tests__/check-version-pins.test.mjs`. Tasks in the same file run in sequence. **[P]**
appears only where a task touches a different file.

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Create `scripts/check-version-pins.mjs` as an `isMain` CLI shell (`scripts/lib/is-main.mjs`) over the shared argv contract (`scripts/lib/argv-contract.mjs`: `wantsHelp`, `partitionArgs`, `dieOnArgvError`). It accepts only `--json` and `--help`/`-h` (contracts/cli.md). Export stubs `detectPins`, `managedOccurrences`, `classifyPins`, `loadExclusions`, `formatReport` and `checkTree`, so the tests fail on behaviour, not on import. Node built-ins only.
  - **Done when**: `node scripts/check-version-pins.mjs --help` prints a usage text naming `node scripts/check-version-pins.mjs` and exits 0, and `--bogus` exits 2.
- [X] T002 Create `scripts/__tests__/check-version-pins.test.mjs` with fixture helpers: an in-memory tree `{ path: text }` and a minimal renovate config object. Every rule test is then a pure function call.
  - **Done when**: `node --test scripts/__tests__/check-version-pins.test.mjs` exits 0.
- [x] T003 **Doc-impact sweep** (REQUIRED; constitution "Documentation").
  - Terms:
    - the new identifiers `check-version-pins` and `version-pin-exclusions`;
    - the day-one pins whose management changes: `DOCKER_COMPOSE_VERSION`, `POWERSHELL_VERSION`, `GRADLE_VERSION`, `ANDROID_CLT_VERSION`, `SPECKIT_VERSION`, `CCUSAGE_VERSION`;
    - the surfaces edited: `customManager`, `renovate-config`.

    Nothing is renamed or removed.
  - Command, per term, with `--untracked` (item #1134): `git grep -n --untracked -F "<term>" -- '*.md' ':!specs/' ':!docs/proposals/' ':!docs/decisions/'`
  - Results (2026-11-24, branch `107-version-pin-guard`):
    - `check-version-pins`, `version-pin-exclusions`: no hits. They are new; written in T030.
    - `DOCKER_COMPOSE_VERSION`, `POWERSHELL_VERSION`, `ANDROID_CLT_VERSION`, `CCUSAGE_VERSION`: no hits. The §8 pin table gains rows → T031.
    - `GRADLE_VERSION` `openwiki/projects/repository.md:186`: no change. It says SDK 58's wrapper holds the version, which is exactly the T022 exclusion reason.
    - `SPECKIT_VERSION` `docs/runbooks/spec-kit.md:47` (upgrade table row 6) → T032: say the pin is deliberately excluded from Renovate.
    - `SPECKIT_VERSION` `docs/runbooks/dev-environment-setup.md:52`: no change. It is an install instruction, not about management.
    - `customManager` `docs/runbooks/renovate.md:1093-1099` (§8 pin table) → T031. Lines 635, 927-929, 1051, 1187 and 1198: no change, as specific past cases.
    - `customManager` `docs/runbooks/wiki-maintenance.md:64`: no change. G14 reads `managerFilePatterns` at check time. The new manager targets Dockerfiles, which G14 already treats as bot-rewritten. No openwiki page has a Dockerfile as `resource` (re-verified by `okf-governance` in T036).
    - `customManager` in `openwiki/projects/ci-cd-pipeline.md:57,60`, `openwiki/runbooks/ci-diagnostics.md:154` and `openwiki/runbooks/infra-image-scanning.md:515,596`: no change. These are specific past managers.
    - `customManager` `openwiki/runbooks/renovate.md`: refreshed from its resource → T033.
    - `renovate-config` `docs/runbooks/renovate.md:1239-1241` (§9 "where" table) and `:1294` (Related) → T030.
    - `renovate-config` `docs/runbooks/sast-scanning.md:467` and `openwiki/projects/sast.md:749`: no change. The sha256 `--check` still runs there.
    - `renovate-config` `docs/MCM-Learnings.md:435`: no change (history). `openwiki/projects/ci-cd-pipeline.md:65` and `openwiki/runbooks/renovate.md:578`: no change (about the validator).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the coverage evaluator (research R1, R2).

- [X] T004 Write the coverage tests (test names prefixed `coverage:`) in `scripts/__tests__/check-version-pins.test.mjs`:
  - **(a)** a customManager whose `managerFilePatterns` match and whose `matchStrings` capture `currentValue` on line N covers line N only;
  - **(b)** the same file pattern with a `matchStrings` that captures nothing covers nothing (the nx #194 shape);
  - **(c)** `/regex/` and glob `managerFilePatterns` entries, resolved against repository-relative forward-slash paths;
  - **(d)** a multi-line match is attributed to the line where `currentValue` starts;
  - **(e)** `matchStringsStrategy: "combination"` makes `managedOccurrences` throw, naming the manager;
  - **(f)** a captured `depName` group names the manager when there is no `depNameTemplate` (the annotation-driven manager, research R4);
  - **(g)** `BUILTIN_ACTION_INPUTS` is exactly the four entries in research R2.
  - **Scenarios covered**: FR-003; spec Edge Case "file pattern covers but match pattern misses"; FR-010 bullet 2; research R1 Known limit; R2 Drift guard.
  - **Verify RED**: `node --test --test-name-pattern="coverage:" scripts/__tests__/check-version-pins.test.mjs` → expected: 6 failing, with (a), (c), (d), (e), (f) and (g) red: `expected line 12 covered`, `Missing expected exception`. **(b) passes against the empty stub**, so its RED is the mutation in T005.
- [X] T005 Implement `managedOccurrences(tree, renovateConfig)` and `BUILTIN_ACTION_INPUTS` in `scripts/check-version-pins.mjs`:
  - compile each `matchStrings` entry with flags `gd`;
  - run it over each file a `managerFilePatterns` entry matches;
  - map each `currentValue` capture's start index to a 1-based line (data-model.md `Pin.line`);
  - return `Map<file, Map<line, manager>>`, where the manager is the captured `depName`, else `depNameTemplate`, else `packageNameTemplate` (data-model.md `Coverage.manager`);
  - throw on any `matchStringsStrategy` other than `any` or absent.

  (Prerequisite: T004 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="coverage:" scripts/__tests__/check-version-pins.test.mjs` → `ℹ fail 0`, 7 passing. Then a **mutation RED for (b)**: change the evaluator to mark every line of a pattern-matched file as covered. (b) must turn red. Revert.

**Checkpoint**: coverage is decided per captured occurrence.

---

## Phase 3: User Story 1 — A new unmanaged pin cannot merge silently (Priority: P1) 🎯 MVP

**Goal**: The detector finds every pin shape. An uncovered, unexcluded pin fails with file, line, name,
value and both remedies. A malformed exclusion fails.

**Independent Test**: quickstart.md scenario 2. Append `FOO_VERSION=1.2.3` to
`scripts/ci-install-trivy.sh`: exit 1 with `UNMANAGED scripts/ci-install-trivy.sh:<n> FOO_VERSION =
1.2.3`. Revert: exit 0.

### Tests for User Story 1 (REQUIRED — TDD checkpoint format) ⚠️

- [X] T006 [US1] Write the `assignment` tests (prefix `assignment:`) in `scripts/__tests__/check-version-pins.test.mjs`. Each case yields exactly one Pin with the right `file`, `line`, `shape`, `name` and `value`:
  - `FOO_VERSION=1.2.3` in a `.sh` file;
  - `ARG GRADLE_VERSION=9.4.1` in a Dockerfile;
  - `ENV X_VERSION 1.2` in a Dockerfile;
  - `export const CCUSAGE_VERSION = '20.0.48';` in a `.mjs` file;
  - `SEMGREP_PIN: '1.2.3'` in a workflow `env:`;
  - `$PNPM_VERSION = '11.17.0'` in a `.ps1` file;
  - the digits-only `ARG ANDROID_CLT_VERSION=11076708` in a Dockerfile.

  These yield nothing:
  - `SPINNER_INTERVAL=100`, because `PIN` is not a whole token;
  - `export const PARSER_VERSION = 2` in a `.mjs` file, because a digits-only value counts only outside JS;
  - `X_VERSION=latest`;
  - `X_VERSION=${Y}`.
  - **Scenarios covered**: US1-AC1; FR-002 bullet 1; data-model.md `Pin.value` and `Pin.name`.
  - **Verify RED**: `node --test --test-name-pattern="assignment:" scripts/__tests__/check-version-pins.test.mjs` → expected: 7 failing (`expected 1 pin, got 0`). The four negative cases pass against the stub; their RED is the mutation in T011.
- [X] T007 [US1] Write the `action-input` tests (prefix `action-input:`) in `scripts/__tests__/check-version-pins.test.mjs`. Each case yields a Pin named `<owner>/<action>:<input>` on the input's own line:
  - block form: `- uses: actions/setup-node@<sha>`, then a comment line, then `with:`, then an indented `node-version: 26.13.1`;
  - flow form: `with: { node-version: 26.13.1, cache: pnpm }`;
  - `version: '0.13.9' # uv-version` under `astral-sh/setup-uv`.

  `cache:` yields nothing. A `with:` under a step with no `uses:` throws, naming file and line.
  - **Scenarios covered**: FR-002 bullet 2; research R3 (flow form).
  - **Verify RED**: `node --test --test-name-pattern="action-input:" scripts/__tests__/check-version-pins.test.mjs` → expected: 4 failing.
- [X] T008 [US1] Write the `command-spec` and not-a-pin tests (prefixes `command-spec:` and `not a pin:`) in `scripts/__tests__/check-version-pins.test.mjs`.

  Each of these yields one Pin:
  - `npm install -g openwiki@1.2.3` in a workflow `run: |` block;
  - the same in a `.sh` file;
  - `cargo-audit@0.23.0 \` on a continuation line of a Dockerfile `RUN`;
  - `pip install semgrep==1.2.3` in a `.sh` file.

  Each of these yields nothing:
  - `pnpm@11.17.0` inside a `.mjs` string;
  - `uses: actions/checkout@v4.1.0` (not a `run:` context);
  - `#`, `//` and `*` comment lines, in every shape;
  - any file outside `SCANNED_SURFACES`: a `*.md`, a `specs/` file, `pnpm-lock.yaml`, `.devcontainer/devcontainer-lock.json`, or a `scripts/__tests__/fixtures/` file.
  - **Scenarios covered**: FR-001; FR-002 bullet 3; FR-010 bullet 5; spec Edge Case "Versions that are not pins".
  - **Verify RED**: `node --test --test-name-pattern="command-spec:|not a pin:" scripts/__tests__/check-version-pins.test.mjs` → expected: 4 failing, the four positive cases. The negative cases pass against the stub; their RED is the mutation in T011.
- [X] T009 [US1] Write the verdict tests (prefix `verdict:`) in `scripts/__tests__/check-version-pins.test.mjs`:
  - **(a)** an uncovered, unexcluded Pin → `unmanaged`, `ok: false`;
  - **(b)** a covered Pin → `managed` with its manager, and `coverage: "custom"`;
  - **(c)** a setup-node action-input → `managed` by `github-actions:actions/setup-node`, with `coverage: "builtin"`;
  - **(d)** a setup-uv input covered by both a customManager and the built-in table reports the **customManager** (data-model.md: custom before builtin, first match wins);
  - **(e)** an unmanaged Pin with a valid exclusion → `excluded`, carrying its reason;
  - **(f)** `formatReport` prints `UNMANAGED <file>:<line> <name> = <value>`, then the two-remedy line, and a `── N pins: … ──` summary, on both pass and fail;
  - **(g)** CLI exit codes, through `checkTree` with injected inputs: 1 for (a), 0 for (b)–(e), and 3 when renovate.json does not parse.
  - **Scenarios covered**: US1-AC1, US1-AC2, US1-AC3; FR-004; FR-008; FR-010 bullet 1; contracts/cli.md.
  - **Verify RED**: `node --test --test-name-pattern="verdict:" scripts/__tests__/check-version-pins.test.mjs` → expected: 7 failing.
- [X] T010 [US1] Write the exclusion-validity tests (prefix `invalid exclusion:`) in `scripts/__tests__/check-version-pins.test.mjs`. Each of these is invalid and names the entry:
  - **(a)** a missing `reason`;
  - **(b)** `reason: "n/a"`, which is under 20 characters;
  - **(c)** a `name` containing `*`;
  - **(d)** a `file` containing `?`;
  - **(e)** a duplicate `{file, name}`.

  Also:
  - **(f)** a file that is not a JSON array throws, which is exit 3;
  - **(g)** an invalid entry makes `ok: false`.
  - **Scenarios covered**: US1-AC3; FR-005; FR-010 bullet 3; contracts/exclusions-file.md.
  - **Verify RED**: `node --test --test-name-pattern="invalid exclusion:" scripts/__tests__/check-version-pins.test.mjs` → expected: 7 failing.

### Implementation for User Story 1

- [X] T011 [US1] Implement `detectPins(tree)` and `SCANNED_SURFACES` in `scripts/check-version-pins.mjs`.

  The shapes (research R3; data-model.md `Pin.file`, `Pin.line`, `Pin.shape`, `Pin.name`, `Pin.value`):
  - `assignment`: in every scanned file;
  - `action-input`: in workflows, with an indentation-aware step/`with:` scanner covering block and flow forms;
  - `command-spec`: only in workflow `run:` blocks, `*.sh` files, and Dockerfile `RUN` instructions including their backslash continuations.

  Comment lines are skipped. `SCANNED_SURFACES` is one exported list (FR-001):
  - `.forgejo/workflows/*.yml`;
  - `scripts/**/*.{sh,mjs,ps1}`, excluding `scripts/__tests__/`;
  - Dockerfiles (`Dockerfile*` and `*.Dockerfile`);
  - `.devcontainer/**`, excluding `*-lock.json`.

  `checkTree` reads the tree with `git ls-files`. Paths are normalised to forward slashes. (Prerequisite: T006–T008 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="assignment:|action-input:|command-spec:|not a pin:" scripts/__tests__/check-version-pins.test.mjs` → `ℹ fail 0`. Then a **mutation RED** for each negative rule, one at a time, each reverted:
    - remove the whole-token name rule;
    - remove the JS dotted-only rule;
    - remove the comment skip;
    - remove the shell-context restriction;
    - remove the surface filter.

    Each removal must turn its named test red.
- [X] T012 [US1] Implement `classifyPins(pins, coverage, exclusions)`, `formatReport`, the `--json` output and the exit codes in `scripts/check-version-pins.mjs`. Classification follows data-model.md `Verdict.managed`, `Verdict.excluded` and `Verdict.unmanaged`, with `Coverage.kind` custom before builtin. Failures go to stderr as well. Every instrument failure exits 3, never 1. (Prerequisite: T009 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="verdict:" scripts/__tests__/check-version-pins.test.mjs` → `ℹ fail 0`, 7 passing. Then a **mutation RED for (d)**: swap the order to builtin first. (d) must turn red. Revert.
- [X] T013 [US1] Implement `loadExclusions(text)` in `scripts/check-version-pins.mjs`. The validity rules are data-model.md `Exclusion.file`, `Exclusion.name` and `Exclusion.reason`, plus the duplicate rule. Invalid entries are reported as `Verdict.invalidExclusions`. Unparseable input, or input that is not an array, throws, and the throw becomes exit 3. A missing exclusions file is an empty list. (Prerequisite: T010 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="invalid exclusion:" scripts/__tests__/check-version-pins.test.mjs` → `ℹ fail 0`, 7 passing; then the whole file → `ℹ fail 0`.
- [X] T014 [US1] Run quickstart.md scenario 2 by hand on the real tree.
  - **Done when**: exit 1 with the `UNMANAGED scripts/ci-install-trivy.sh:<n> FOO_VERSION = 1.2.3` line and both remedies; then `git checkout -- scripts/ci-install-trivy.sh`. The day-one pins may also be listed; US2 resolves them.

**Checkpoint**: detector, verdict and exclusion validity work on fixtures and on the real tree.

---

## Phase 4: User Story 2 — Every pin in the tree today is accounted for (Priority: P1)

**Goal**: The real tree passes on an honest, per-pin inventory.

**Independent Test**: quickstart.md scenario 1. Exit 0. Every pin is listed `managed` or `excluded`,
and the summary reads `0 unmanaged · 0 stale · 0 redundant · 0 invalid`.

### Tests for User Story 2 (REQUIRED — TDD checkpoint format) ⚠️

- [X] T015 [US2] Write the repository tests (prefix `repository tree:`) in `scripts/__tests__/check-version-pins.test.mjs`:
  - **(a)** `checkTree()` on the real tree returns `ok: true`. On failure, the message lists each unmanaged pin as `file:line name = value`.
  - **(b)** Two `checkTree()` calls return deep-equal results (SC-004).
  - **(c)** The script's imports are only `node:` built-ins and `./lib/` modules, and it contains no `fetch(`, `node:http` or `node:https` (FR-009).
  - **Scenarios covered**: US2-AC2; SC-002; SC-004; FR-009; FR-011.
  - **Verify RED**: `node --test --test-name-pattern="repository tree:" scripts/__tests__/check-version-pins.test.mjs` → expected: (a) fails, listing the day-one pins (research R4: six). (b) and (c) pass by construction; their RED is a mutation in T026.
- [X] T016 [US2] Record the day-one inventory from `node scripts/check-version-pins.mjs --json` on the unmodified tree: the count by status, and every `unmanaged` entry.
  - **Done when**: pasted below. Any pin beyond research R4's six gets a resolution task appended here.
  - Inventory (2026-11-24, `node scripts/check-version-pins.mjs` on the unmodified tree): **44 pins: 38 managed, 0 excluded, 6 unmanaged**.
    The 38 managed: 25 setup-node inputs (built-in), 5 setup-uv inputs (customManager `astral-sh/uv`, which wins over the built-in), and 8 customManager pins (openwiki, cargo-audit ×2, MAESTRO, RUSTUP, TRIVY, SEMGREP, PIP_AUDIT).
    The 6 unmanaged pins, exactly research R4's six, so T025 had nothing to add:
    - `.devcontainer/toolchain.Dockerfile:145 DOCKER_COMPOSE_VERSION = v5.3.1` → T017
    - `.devcontainer/toolchain.Dockerfile:176 ANDROID_CLT_VERSION = 11076708` → T021
    - `.devcontainer/toolchain.Dockerfile:224 GRADLE_VERSION = 9.4.1` → T022
    - `.devcontainer/toolchain.Dockerfile:285 SPECKIT_VERSION = v1.4.2` → T020
    - `.devcontainer/toolchain.Dockerfile:312 POWERSHELL_VERSION = 7.6.5` → T017 + T018
    - `scripts/lib/cc-usage/write-oracle.mjs:13 CCUSAGE_VERSION = 20.0.48` → T023
    After resolution: **44 pins: 40 managed, 4 excluded, 0 unmanaged · 0 stale · 0 redundant · 0 invalid** (found 6 = resolved 6, SC-003).

### Implementation for User Story 2

The resolutions are in research R4. The repository test (T015) is the RED, and T026 is the GREEN.

- [X] T017 [US2] Add the annotation-driven customManager to `renovate.json` (research R4):
  - `managerFilePatterns`: Dockerfiles;
  - `matchStrings`: `# renovate: datasource=… depName=…[ extractVersion=…]` followed by an `ARG`/`ENV` `NAME=value` line;
  - capture groups: `datasource`, `depName`, `extractVersion`, `currentValue`;
  - a `description` saying why it exists (the two annotations no manager read).
  - **Done when**: `node scripts/check-version-pins.mjs` reports `DOCKER_COMPOSE_VERSION ← docker/compose` as managed.
- [X] T018 [P] [US2] Add `extractVersion=^v(?<version>.+)$` to the `POWERSHELL_VERSION` annotation in `.devcontainer/toolchain.Dockerfile`: the tags are `v7.6.5`, and the ARG is `7.6.5`.
  - **Done when**: the check reports `POWERSHELL_VERSION ← PowerShell/PowerShell` as managed.
- [X] T019 [US2] Validate the edited config: `npx --yes --package renovate@"$(cat .forgejo/renovate-version)" -- renovate-config-validator --strict --no-global renovate.json` (the guardrails invocation).
  - **Done when**: exit 0.
- [X] T020 [US2] Create `.forgejo/version-pin-exclusions.json` (contracts/exclusions-file.md; data-model.md `Exclusion.file`, `Exclusion.name`, `Exclusion.reason`) with entries for `.devcontainer/toolchain.Dockerfile` `SPECKIT_VERSION`, carrying the research R4 reason.
  - **Done when**: the check lists it `excluded` with that reason.
- [X] T021 [US2] Add the `ANDROID_CLT_VERSION` exclusion to `.forgejo/version-pin-exclusions.json` (research R4 reason).
  - **Done when**: listed `excluded`.
- [X] T022 [US2] Add the `GRADLE_VERSION` exclusion to `.forgejo/version-pin-exclusions.json`. The reason says it must equal the wrapper version that `expo prebuild` generates (`android/` is gitignored, CNG), so it moves with an Expo SDK upgrade.
  - **Done when**: listed `excluded`.
- [X] T023 [US2] Add the `scripts/lib/cc-usage/write-oracle.mjs` `CCUSAGE_VERSION` exclusion to `.forgejo/version-pin-exclusions.json`. The reason says the committed oracle records `ccusage@<this version>`, and a bump means a re-record plus a review (research R4).
  - **Done when**: listed `excluded`.
- [X] T024 [US2] Run `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`. If one of its guards fails because of the new manager, update that guard at the cause so it asserts the new premise; never delete it (AGENTS.md).
  - **Done when**: `ℹ fail 0`.
- [X] T025 [US2] Resolve each additional unmanaged pin that T016 found, as in T017–T023.
  - **Done when**: the count found equals the count resolved, recorded in T016 (SC-003).
- [X] T026 [US2] Make the repository tests pass. (Prerequisite: T015 verified RED; T017–T025 done.)
  - **Verify GREEN**: `node --test --test-name-pattern="repository tree:" scripts/__tests__/check-version-pins.test.mjs` → `ℹ fail 0`; `node scripts/check-version-pins.mjs` → exit 0 with the zero summary (SC-005).
  - Then the **mutation REDs** for (b) and (c), each reverted:
    - add a `Math.random()` field to the result, and (b) must turn red;
    - add `import 'node:https'`, and (c) must turn red.

**Checkpoint**: the real tree is green on a per-pin inventory.

---

## Phase 5: User Story 3 — Exclusions do not rot (Priority: P2)

**Goal**: A stale or redundant exclusion fails, naming the entry.

**Independent Test**: quickstart.md scenario 4.

### Tests for User Story 3 (REQUIRED — TDD checkpoint format) ⚠️

- [X] T027 [US3] Write the stale and redundant tests (prefixes `stale:` and `redundant:`) in `scripts/__tests__/check-version-pins.test.mjs`:
  - **(a)** an exclusion matching no Pin → `STALE exclusion {file: x, name: Y} matches no pin — delete it`;
  - **(b)** an exclusion whose Pins are all covered → `REDUNDANT`, naming the manager;
  - **(c)** an exclusion matching two occurrences, one covered and one not, is neither;
  - **(d)** (a) and (b) each make `ok: false`.
  - **Scenarios covered**: US3-AC1, US3-AC2; FR-006; FR-010 bullet 4; data-model.md state transitions.
  - **Verify RED**: `node --test --test-name-pattern="stale:|redundant:" scripts/__tests__/check-version-pins.test.mjs` → expected: 3 failing ((a), (b), (d)). (c)'s RED is the mutation in T028.

### Implementation for User Story 3

- [X] T028 [US3] Extend `classifyPins` in `scripts/check-version-pins.mjs` with data-model.md `Verdict.staleExclusions` and `Verdict.redundantExclusions` and their report lines (contracts/cli.md). (Prerequisite: T027 verified RED.)
  - **Verify GREEN**: `node --test --test-name-pattern="stale:|redundant:" scripts/__tests__/check-version-pins.test.mjs` → `ℹ fail 0`. Then a **mutation RED**: change "redundant" to mean "any matched pin is covered". (c) must turn red. Revert. Then the whole file → `ℹ fail 0`.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T029 Add the step `run: bash scripts/ci-log-step.sh renovate-config-version-pins node scripts/check-version-pins.mjs` to the `renovate-config` job in `.forgejo/workflows/guardrails.yml`, after the pinned-sha256 step (research R5). Add `check-version-pins.mjs` to `PROBES` in `scripts/__tests__/cli-entry-guard.guard.test.mjs`.
  - **Done when**: `node --test scripts/__tests__/cli-entry-guard.guard.test.mjs` → `ℹ fail 0`, and every guard test naming `renovate-config` passes.
- [X] T030 [P] Add the section "The version-pin guard (item #1128)" to `docs/runbooks/renovate.md` after §9 (FR-012). It covers:
  - the scanned surfaces, including `.ps1`, and what is out of sight;
  - the three shapes, and the value rules;
  - per-occurrence coverage, and the built-in table with its re-read on a Renovate major;
  - the annotation-driven manager, and how to annotate a new Dockerfile pin;
  - how to add an exclusion, and the legitimate-reason rule;
  - the exit codes;
  - the known limit (research R1).

  Also update the §9 "where" table and the Related entry (T003 hits).
  - **Done when**: the section exists, and the T003 hits are updated.
- [X] T031 [P] Add §8 pin-table rows in `docs/runbooks/renovate.md` for docker compose and PowerShell (managed by the annotation manager), and for gradle, Android command-line tools, Spec Kit and ccusage (excluded, with their file).
  - **Done when**: there is one row per day-one pin.
- [X] T032 [P] In `docs/runbooks/spec-kit.md:47` (row 6), say that `SPECKIT_VERSION` is deliberately excluded from Renovate in `.forgejo/version-pin-exclusions.json`, so the upgrade procedure is the only way it moves.
  - **Done when**: the row says so.
- [X] T033 Refresh the openwiki pages whose `resource` changed: `node scripts/wiki-refresh.mjs --stale`, then per page `--diff`, an edit, and `--record` (`.claude/skills/wiki-refresh/SKILL.md`).
  - **Done when**: `--stale` reports nothing.
- [X] T034 **Close-out re-search**: re-run T003's searches. Nothing was renamed, so confirm the converse: the new identifiers appear in `docs/runbooks/renovate.md` and its openwiki page, and every hit T003 sent to a task is updated.
  - **Done when**: one line per term is recorded here.
  - Result: `check-version-pins` → `docs/runbooks/renovate.md` §10 and Related, and `openwiki/runbooks/renovate.md`. `version-pin-exclusions` → those two plus `docs/runbooks/spec-kit.md` row 6 and `openwiki/runbooks/spec-kit.md`.
    The T003 hits: §8 pin table (T031) updated; Related updated; spec-kit row 6 (T032) updated.
    The §9 "where" table is left unchanged on reflection: it lists where the *validator* runs, and the guard is a separate step, documented in §10 and in Related.
- [X] T035 Run quickstart.md scenarios 1, 2 and 6 by hand.
  - **Done when**: as stated there.
- [X] T036 Run the touched tiers against a `main` baseline:
  - `node --test scripts/__tests__/` on this branch and on `origin/main`, where any failure new on the branch is a regression;
  - `pnpm nx okf-lint infrastructure-as-code`;
  - `pnpm nx okf-governance infrastructure-as-code`;
  - `node scripts/check-toolchain-consistency.mjs`.

  No `backend/`, `frontend/`, `agents/` or `mcp-servers/` path changes, so the app tiers and the web E2E regression do not apply (`openwiki/invariants/feature-validation-checklist.md`). Record that here.
  - Result (Windows host, Node 24.14.1):
    - `node --test scripts/__tests__/*.test.mjs` (the CI glob): branch 2386 tests, 87 fail; `origin/main` 6dd409d1, 2329 tests, 87 fail. The failure sets are **identical** (`comm` of the sorted `✖` names: nothing new, nothing fixed). They are host-shaped (bash, pnpm on PATH, systemd units) and pass in CI. The 57 new tests all pass.
    - `okf-lint` ✅ 78 concepts; `okf-governance` ✅; `check-toolchain-consistency` ✅.
    - The strict validator (T019) exited 0: "Config validated successfully".
    - All mutation REDs (T005, T011, T012, T026, T028) turned their named tests red, with the source restored after each.
  - **Done when**: every command passes, or each failure is shown identical on `origin/main`.
- [X] T037 **Open the PR** from a real branch: `git push origin HEAD:107-version-pin-guard`, then `node scripts/forge-pr.mjs open` (`docs/runbooks/ci-diagnostics.md`). Tick this task in the LAST commit, quoting the branch, the PR number and the sha. **No CI evidence here**: it goes in the PR's closing comment and item #1128's, posted with `MCM_FORGE_ISSUE_TOKEN`.
  - Opened: branch `107-version-pin-guard`, **PR #1138**, implementation commit `0d8ae545`. This tick is the branch's last commit.

---

## Dependencies & Execution Order

- **Setup → Foundational → US1 → US2 → US3 → Polish**, in priority order. T003 is already done.
- **US1** depends on Foundational: the verdict (T009, T012) needs `managedOccurrences` (T005).
- **US2** depends on all of US1, because the inventory runs the real detector, verdict and exclusion loader.
- **US3** depends on US1's `classifyPins`. It is independent of US2.
- **Same file, so sequential**: everything in `scripts/check-version-pins.mjs` and its test file, and T020–T023 in the exclusions file.

### Parallel Opportunities

- T018 (`toolchain.Dockerfile`) alongside T017 (`renovate.json`).
- T030 and T031 (separate sections of the renovate runbook; serialise the edits) alongside T032 (`spec-kit.md`).
- US3's tests (T027) can be written while US2's config tasks (T017–T023) proceed: different files.

## Parallel Example: User Story 2

```bash
Task: "T017 annotation-driven customManager in renovate.json"
Task: "T018 extractVersion on the POWERSHELL_VERSION annotation in .devcontainer/toolchain.Dockerfile"
```

## Implementation Strategy

- **MVP (US1)**: the guard works and names the real tree's gaps. It is not mergeable alone: FR-007 makes the check required, and SC-002 needs a green `main`.
- **First mergeable state**: US1 + US2.
- **Same PR**: US3 ships with them (`openwiki/process/pull-request-batching.md`): one feature, one failure surface.

## Notes

- A Verify RED with 0 failures is a trivially passing test. Every negative case that passes against a stub names its mutation RED in the paired GREEN task.
- Commit from `E:\Programming\VSCode\mcm-wt\spec107`, never the shared checkout.
