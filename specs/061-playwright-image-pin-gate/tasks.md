# Tasks: Playwright image-pin consistency gate

**Feature**: 061-playwright-image-pin-gate | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Test discipline**: TDD is NON-NEGOTIABLE per the constitution. Every test task carries a **Verify
RED** command with its expected failure output; every paired implementation task carries a **Verify
GREEN**. Format per [docs/templates/feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md).

**Platform Parity Table**: omitted — `N/A — toolchain/process feature, no UI flow on any client`.

---

## Task summary

| Phase | Story | Tasks | Independently shippable? |
|---|---|---|---|
| 1 Setup | — | T001 | — |
| 2 Foundational | — | *(none — see note)* | — |
| 3 | US1 (P1) — fast drift gate | T002–T009 | **Yes — this is the MVP** |
| 4 | US2 (P2) — bot moves both halves | T010–T014 | Yes |
| 5 | US3 (P3) — runbooks name the gate | T015–T016 | Yes |
| 6 Polish | — | T017–T020 | — |

**No Foundational phase is needed.** The three stories touch disjoint files (`scripts/`,
`renovate.json`, `docs/runbooks/`) and share no prerequisite code. US1 ships alone and delivers the
entire measured value; US2 and US3 are additive.

---

## Phase 1: Setup

### T001 ✅ — Capture the Renovate extraction baseline before any config change

**Type**: Utility script | **Time**: 5 min | **Risk**: None

**Spec reference**: FR-011

Run the offline extraction and keep the output. This is what makes T013's verification *evidence*
rather than a screenshot of the status quo — the tag is currently extracted by nothing, and that has
to be recorded **before** `renovate.json` is touched.

```bash
LOG_LEVEL=debug RENOVATE_PLATFORM=local RENOVATE_DRY_RUN=extract \
  npx --yes --package renovate@44 -- renovate > /tmp/extract-before.log 2>&1
echo "exit=$?"
grep -c "playwright" /tmp/extract-before.log
grep -n "Matched .* file(s) for manager" /tmp/extract-before.log
```

**Done when**: `/tmp/extract-before.log` exists and confirms all three baseline facts from
[research.md](./research.md) R6 — `@playwright/test` extracted by the `npm` manager; `app-ci.yml`
matched by `github-actions` **only**; **no** `custom.regex` entry for `app-ci.yml`.

> If a `custom.regex` entry for `app-ci.yml` already exists, stop — the working copy is not at the
> assumed baseline and T010–T013 need rethinking.

---

## Phase 2: Foundational

*None.* See the note under Task summary.

---

## Phase 3: User Story 1 — A drifted pin fails in seconds, not in 35 minutes (P1) 🎯 MVP

**Goal**: convert a ~35-minute, mis-attributed "app-e2e failed" into a ~1-second failure that names
the drift, both versions and every offending location.

**Independent test**: break one image tag, run the gate, get exit 1 with a diagnosable message;
restore, get exit 0. Delivers the item's entire measured value with no bot or docs change.

### T002 ✅ — [US1] Extend the test `repo()` helper to write a lockfile and a Playwright workflow

**Type**: Test refactor | **Time**: 20 min | **Risk**: Low

**Spec reference**: [spec.md#user-story-1](./spec.md)

**File**: `scripts/__tests__/check-toolchain-consistency.test.mjs`

The existing `repo({ pkg, workflows, dockerfiles, nxJson })` helper cannot express this feature's
fixtures. Add two optional inputs — `lockfile` (written to `pnpm-lock.yaml`) and the ability to pass
`app-ci.yml` through the existing `workflows` map — so every case below is one call.

Accept the lockfile as **YAML text**, not as an object, so a fixture can express the malformed and
multi-resolution shapes that FR-004 requires and that a serialised object cannot represent.

**Verify RED** (a pure refactor task — no behaviour yet, so this only proves nothing regressed):
```bash
node --test scripts/__tests__/check-toolchain-consistency.test.mjs
```
**Expected**: still all passing — this task adds capability, not assertions. The RED comes in T003.

### T003 ✅ — [US1] Write the lockfile-resolution unit tests

**Type**: Test | **Time**: 30 min | **Risk**: None

**Spec reference**: [spec.md#user-story-1](./spec.md)

**Scenarios covered**:
- US1-AC1: a matched pair passes
- Edge case: `@playwright/test` cannot be resolved from the lockfile
- Edge case: the lockfile resolves more than one version

**File**: `scripts/__tests__/check-toolchain-consistency.test.mjs`

Import `resolveLockfilePlaywrightVersion` and assert, using fixture lockfile text:

| Case | Assertion |
|---|---|
| `packages:` contains `'@playwright/test@1.62.1':` | returns `1.62.1` |
| only `snapshots:` contains it | returns `1.62.1` — the documented fallback |
| a compound peer key `'@nx/playwright@22.7.8(@playwright/test@1.62.1)':` **only** | resolves **nothing** — the name inside another key is not a resolution |
| the package is absent | throws / signals, never returns `undefined` |
| two distinct versions present | throws / signals, never silently picks one |

The compound-key case is the one that justifies parsing over text-matching; without it a regex
implementation would pass this suite. Take the literal shape from
[pnpm-lock.yaml:15801](../../pnpm-lock.yaml#L15801).

**Verify RED**:
```bash
node --test --test-name-pattern="lockfile" scripts/__tests__/check-toolchain-consistency.test.mjs
```
**Expected RED**: all new cases fail — `SyntaxError: The requested module '../check-toolchain-consistency.mjs' does not provide an export named 'resolveLockfilePlaywrightVersion'`.

### T004 ✅ — [US1] Implement `resolveLockfilePlaywrightVersion`

**Type**: Implementation | **Time**: 30 min | **Risk**: Low

**Spec reference**: [spec.md#user-story-1](./spec.md) · **Prerequisite**: T003 verified RED.

**File**: `scripts/check-toolchain-consistency.mjs`

Parse `pnpm-lock.yaml` with `yaml`; read the keys of `packages`, falling back to `snapshots`; select
keys prefixed `@playwright/test@`; reduce to distinct versions; require exactly one. Per
[data-model.md](./data-model.md), zero or several is a signalled condition, never a pick.

Add a JSDoc recording **why** the lockfile and not `package.json` (`^1.36.0` did not change across
the measured failure) — provenance, which is the constitution's sanctioned comment exception. No
`FR-###` in the identifier.

**Verify GREEN**:
```bash
node --test --test-name-pattern="lockfile" scripts/__tests__/check-toolchain-consistency.test.mjs
```
**Expected GREEN**: 0 failures.

**Also run the touched suite**:
```bash
node --test scripts/__tests__/check-toolchain-consistency.test.mjs
```
**Expected**: previously passing tests still pass.

### T005 ✅ — [US1] Write the image-occurrence scanning unit tests

**Type**: Test | **Time**: 30 min | **Risk**: None

**Spec reference**: [spec.md#user-story-1](./spec.md)

**Scenarios covered**:
- US1-AC3: two occurrences, only one bumped → must be detectable
- Edge case: the image tag disappears entirely
- Edge case: comment prose naming a past pin

**File**: `scripts/__tests__/check-toolchain-consistency.test.mjs`

Import `collectPlaywrightImagePins` and assert against literal workflow text — matching how the
existing selftest and test (d) assert `collectPins()` on single lines:

| Case | Assertion |
|---|---|
| one `mcr.microsoft.com/playwright:v1.62.1-noble` line | one occurrence, `value === '1.62.1'`, correct 1-indexed `line` |
| two occurrences at different lines | **both** returned, with distinct line numbers |
| three occurrences | all three — the scan is not capped |
| a `#`-commented image line | **not** counted |
| no image line at all | empty |
| a `-jammy` suffixed line | not counted — the suffix is part of the anchor |
| a Windows-style path passed as `file` | `file` comes back POSIX-normalised |

**Verify RED**:
```bash
node --test --test-name-pattern="image" scripts/__tests__/check-toolchain-consistency.test.mjs
```
**Expected RED**: all new cases fail — `does not provide an export named 'collectPlaywrightImagePins'`.

### T006 ✅ — [US1] Implement `collectPlaywrightImagePins`

**Type**: Implementation | **Time**: 30 min | **Risk**: Low

**Spec reference**: [spec.md#user-story-1](./spec.md) · **Prerequisite**: T005 verified RED.

**File**: `scripts/check-toolchain-consistency.mjs`

Line scan for `mcr.microsoft.com/playwright:v<version>-noble`, skipping `/^\s*#/` lines exactly as
`collectPins()` does, returning `{file, line, value}` routed through the existing `posixLocation()`.

**Verify GREEN**:
```bash
node --test --test-name-pattern="image" scripts/__tests__/check-toolchain-consistency.test.mjs
```
**Expected GREEN**: 0 failures.

### T007 ✅ — [US1] Write the drift-detection and wiring tests

**Type**: Test | **Time**: 40 min | **Risk**: None

**Spec reference**: [spec.md#user-story-1](./spec.md)

**Scenarios covered**:
- US1-AC1: agreeing pair → clean
- US1-AC2: `1.62.1` vs `1.60.0` → finding naming both versions and the file:line
- US1-AC3: partial bump → finding
- Edge cases: zero occurrences; unresolvable lockfile

**File**: `scripts/__tests__/check-toolchain-consistency.test.mjs`

Import `findPlaywrightPinDrift` and `findDrift`, and assert:

| Case | Assertion |
|---|---|
| lockfile `1.62.1`, both tags `v1.62.1-noble` | no findings |
| lockfile `1.62.1`, both tags `v1.60.0-noble` | findings naming **both** versions, with real line numbers |
| lockfile `1.62.1`, one tag bumped one not | **a finding** — the partial bump |
| lockfile `1.62.1`, zero occurrences | a finding — no vacuous pass |
| lockfile with the package absent | a finding |
| **the REAL repo** | `findPlaywrightPinDrift()` returns `[]` — mirrors existing test (k) |
| **the REAL repo via `findDrift()`** | the Playwright relation is reached through `findDrift`, **not merely exported** — mirrors existing test (h7) |

The last row is the one that catches "implemented but never wired in", which is exactly the failure
the `nx` suite added (h7) for.

**Verify RED**:
```bash
node --test --test-name-pattern="playwright" scripts/__tests__/check-toolchain-consistency.test.mjs
```
**Expected RED**: all new cases fail — `does not provide an export named 'findPlaywrightPinDrift'`.

### T008 ✅ — [US1] Implement `findPlaywrightPinDrift` and wire it into `findDrift`

**Type**: Implementation | **Time**: 45 min | **Risk**: Medium

**Spec reference**: [spec.md#user-story-1](./spec.md) · **Prerequisite**: T007 verified RED.

**File**: `scripts/check-toolchain-consistency.mjs`

Compose T004 and T006 into the repo-standard `{file, line, problem}[]`, and add
`findings.push(...findPlaywrightPinDrift(root))` to `findDrift()` beside the existing
`findNxPinDrift(root)` line.

Per [contracts/gate-cli.md](./contracts/gate-cli.md), the `problem` string must name the resolved
lockfile version, the disagreeing tag version and the consequence — a failure has to be diagnosable
from the message alone (SC-002), because the failure it replaces required reading a container log.

**Risk is Medium** for one reason: only `.forgejo/workflows/app-ci.yml` may be scanned. Do **not**
reuse the directory-walking `PINNED_FILES` — `specs/**` carries the old `v1.60.0-noble` string as a
point-in-time record and is explicitly out of scope; scanning it would fail the gate on history.

**Verify GREEN**:
```bash
node --test --test-name-pattern="playwright" scripts/__tests__/check-toolchain-consistency.test.mjs
```
**Expected GREEN**: 0 failures.

**Also run the touched suite**:
```bash
node --test scripts/__tests__/check-toolchain-consistency.test.mjs
node scripts/check-toolchain-consistency.mjs; echo "exit=$?"
```
**Expected**: all pass; the gate exits `0` on the real repo (SC-007).

### T009 ✅ — [US1] Extend `--selftest` to prove the new relation can fail

**Type**: Test | **Time**: 30 min | **Risk**: None

**Spec reference**: FR-006, FR-007 · SC-004

**File**: `scripts/check-toolchain-consistency.mjs` (the `selftest()` function)

Add the cases from [research.md](./research.md) R7 to the existing `selftest()`, driven by in-memory
fixture strings — it must write no files. At minimum: a matched pair produces no finding, a
**mismatched pair produces one**, a partial bump produces one, zero occurrences produces one, and a
commented image line is not counted.

**Verify RED** — this task's proof is that the selftest *catches a broken gate*, so break it
deliberately:
```bash
# Temporarily make the comparison always agree, e.g. return [] early from findPlaywrightPinDrift
node scripts/check-toolchain-consistency.mjs --selftest; echo "exit=$?"
```
**Expected RED**: exit `1` — `✗ toolchain-consistency --selftest FAILED:` listing the mismatched-pair
case. **Then revert the deliberate break.**

> A `--selftest` that still exits 0 with the comparison disabled is not proving anything, and must be
> fixed before this task is done.

**Verify GREEN** (after reverting):
```bash
node scripts/check-toolchain-consistency.mjs --selftest; echo "exit=$?"
```
**Expected GREEN**: exit `0`, `✓ … --selftest passed`.

**Checkpoint — US1 is complete and independently shippable here.** Run the drill in
[quickstart.md](./quickstart.md) §3 end to end before moving on.

---

## Phase 4: User Story 2 — The bot moves both halves in one pull request (P2)

**Goal**: stop the drift being introduced at all, so the P1 gate becomes a backstop rather than a
recurring chore.

**Independent test**: config validates; the offline extraction shows the tag discovered; the guard
test shows both halves in one group across all three update tracks.

### T010 ✅ — [US2] Write the grouping and control assertions

**Type**: Test | **Time**: 45 min | **Risk**: Low

**Spec reference**: [spec.md#user-story-2](./spec.md)

**Scenarios covered**:
- US2-AC3: both halves resolve to the same group
- US2-AC4: the new grouping wins over the generic JS rules

**File**: `scripts/__tests__/renovate-workflow.guard.test.mjs`

Mirror the existing `NX_FAMILY` block with a `PLAYWRIGHT_PAIR`:

```
{ label: 'app-ci.yml image tag', manager: 'custom.regex', packageFile: '.forgejo/workflows/app-ci.yml', depName: '@playwright/test' }
{ label: 'lockfile @playwright/test', manager: 'npm',     packageFile: 'package.json',                  depName: '@playwright/test' }
```

Assert, via the file's own `resolvedGroupName()`, all five invariants from
[contracts/renovate-config.md](./contracts/renovate-config.md): one shared group on `patch`/`minor`/
`major`; the **last** rule grouping Playwright matches **both** managers; it carries **no**
`matchUpdateTypes`; a `customManagers` entry with `depNameTemplate: "@playwright/test"` exists and
targets `app-ci.yml`; and the **controls** — `@nx/playwright` still resolves to `nx monorepo`, and
`typescript` does not resolve to the Playwright group.

The controls are not optional. Without them, widening the rule until everything shares one group
would satisfy every other assertion while collapsing the config — the same reason the `nx` suite
carries its own control test.

**Verify RED**:
```bash
node --test --test-name-pattern="playwright" scripts/__tests__/renovate-workflow.guard.test.mjs
```
**Expected RED**: the grouping cases fail — `AssertionError: no packageRule in renovate.json groups
@playwright/test` / the customManager assertion fails with `renovate.json has no customManager with
depNameTemplate "@playwright/test"`.

### T011 ✅ — [US2] Add the `customManagers` entry

**Type**: Config change | **Time**: 30 min | **Risk**: Medium

**Spec reference**: FR-008 · **Prerequisite**: T010 verified RED.

**File**: `renovate.json`

Add the entry per [contracts/renovate-config.md](./contracts/renovate-config.md) — `customType:
regex`, `managerFilePatterns` matching `.forgejo/workflows/app-ci.yml`, `matchStrings` capturing
`(?<currentValue>…)` out of `mcr.microsoft.com/playwright:v<here>-noble`, `depNameTemplate:
"@playwright/test"`, `datasourceTemplate: "npm"`.

**`managerFilePatterns`, never `fileMatch`** — v41 renamed it, and the repo's own note records that a
config using the old key *"does not fail loudly, it silently manages nothing"*.

Write the `description` array in the house style: state the measured failure (PR #199, zero tests
ran), and state that **extraction is not grouping** so the next reader does not delete T012's rule as
redundant.

**Done when**: `npx --yes --package renovate@44 -- renovate-config-validator` passes.

### T012 ✅ — [US2] Add the `packageRules` grouping entry, ordered last

**Type**: Config change | **Time**: 30 min | **Risk**: Medium

**Spec reference**: FR-009, FR-010 · **Prerequisite**: T011 complete.

**File**: `renovate.json`

Append **after** the `nx monorepo` rule — and therefore after `js patch/minor` and `js majors`:
`matchManagers: ["npm", "custom.regex"]`, `matchPackageNames: ["@playwright/test"]`, a stable
`groupName`, `automerge: false`, and **no** `matchUpdateTypes`.

Two things this must not do: match `@nx/playwright` (use the exact string, never a `/playwright/`
regex — it would steal that package from the `nx monorepo` group and break the existing guard), and
use any rule key outside `ruleMatches()`'s `known` set (it **throws** on an unknown key by design).

**Verify GREEN**:
```bash
node --test --test-name-pattern="playwright" scripts/__tests__/renovate-workflow.guard.test.mjs
```
**Expected GREEN**: 0 failures.

**Also run the touched suite** (the `nx` controls must be unaffected):
```bash
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```
**Expected**: all pass, including `the whole nx family is proposed in ONE group` on all three tracks.

### T013 ✅ — [US2] Verify extraction by result against the T001 baseline

**Type**: Config change (verification) | **Time**: 15 min | **Risk**: None

**Spec reference**: FR-011 · US2-AC1, US2-AC2 · **Prerequisite**: T011, T012 complete.

```bash
npx --yes --package renovate@44 -- renovate-config-validator

LOG_LEVEL=debug RENOVATE_PLATFORM=local RENOVATE_DRY_RUN=extract \
  npx --yes --package renovate@44 -- renovate > /tmp/extract-after.log 2>&1
echo "exit=$?"
diff <(grep -o '"depName": "[^"]*"' /tmp/extract-before.log | sort -u) \
     <(grep -o '"depName": "[^"]*"' /tmp/extract-after.log  | sort -u)
```

**Done when**: the validator passes, and `/tmp/extract-after.log` contains a `custom.regex` entry
with `packageFile: .forgejo/workflows/app-ci.yml`, `depName: @playwright/test` and `currentValue:
1.62.1` — appearing **twice**, once per occurrence — where `/tmp/extract-before.log` has none.

**Record the measured before/after in the commit message.** This is the criterion the item words as
"verified by result, not by reading config"; a claim without the diff does not satisfy it.

### T014 ✅ — [US2] Record the residual risk in the config's own description

**Type**: Documentation | **Time**: 10 min | **Risk**: None

**Spec reference**: [research.md](./research.md) R4

**File**: `renovate.json`

State in the customManager's `description` that the npm datasource can propose a version whose
`-noble` image tag does not yet exist, that this is **accepted** because it fails loudly at
`docker pull` rather than silently, and that the `docker` datasource alternative was rejected for
colliding with `docker:pinDigests` and splitting the pair's depName.

**Done when**: a reader hitting a `manifest unknown` failure finds the explanation in the file that
caused it, rather than having to reconstruct it.

---

## Phase 5: User Story 3 — The runbooks name the gate (P3)

### T015 ✅ — [P] [US3] Name the enforcing gate in the devcontainer runbook

**Type**: Documentation | **Time**: 10 min | **Risk**: None

**Spec reference**: FR-013 · US3-AC1

**File**: `docs/runbooks/devcontainer.md`

The file already states *"Pin the image to the repo's Playwright version … so the browser build
matches"*. Add what now enforces it: `scripts/check-toolchain-consistency.mjs`, in the `naming`
guardrails job, in ~1 s. Note that Renovate now moves both halves in one PR.

**Done when**: `grep -n "check-toolchain-consistency" docs/runbooks/devcontainer.md` returns a hit
adjacent to the pin rule.

### T016 ✅ — [P] [US3] Name the enforcing gate in the E2E testing runbook

**Type**: Documentation | **Time**: 15 min | **Risk**: None

**Spec reference**: FR-013 · US3-AC2

**File**: `docs/runbooks/e2e-testing.md`

Same addition, plus the diagnostic that is this file's job: **a mismatched pin presents as
`failed=0 flaky=0 passed=0` with no Playwright summary, not as a test failure** — so if the e2e
result gate reports "no summary found", check the image pin against the lockfile first. That is the
signature of PR #199 and it took a container-log read to diagnose.

**Done when**: `grep -n "check-toolchain-consistency" docs/runbooks/e2e-testing.md` returns a hit,
and the zero-count signature is written down.

---

## Phase 6: Polish & cross-cutting

### T017 ✅ — Extend the gate's success line to name the fourth relation

**Type**: Implementation | **Time**: 10 min | **Risk**: None

**Spec reference**: [contracts/gate-cli.md](./contracts/gate-cli.md)

**File**: `scripts/check-toolchain-consistency.mjs`

Add a Playwright clause to the `✓ toolchain-consistency gate passed (…)` message. **Not cosmetic** —
a gate that checks four relations and enumerates three leaves a reader unable to tell whether the
fourth ran, which is the "a green tick proves less than it appears to" trap this repo has already
been bitten by.

**Done when**: `node scripts/check-toolchain-consistency.mjs` prints a line naming the Playwright
pair, and any test asserting that line is updated with it.

### T018 ✅ — Update the guardrails step comment

**Type**: Documentation | **Time**: 5 min | **Risk**: None

**Spec reference**: FR-002, FR-007

**File**: `.forgejo/workflows/guardrails.yml`

The step is named *"Toolchain-consistency gate (selftest + scan — every Node/pnpm pin agrees)"* and
its comment describes only the pnpm-11 class. Extend both to mention the Playwright pair and what it
replaces (~35 min → ~1 s). **No `run:` line changes** — the existing two lines already invoke
`--selftest` then the real scan.

**Done when**: the step name and comment describe what the gate now checks.

### T019 ✅ — Run the full local validation

**Type**: Test | **Time**: 15 min | **Risk**: None

**Spec reference**: every SC

```bash
node --test scripts/__tests__/*.test.mjs
node scripts/check-toolchain-consistency.mjs --selftest
node scripts/check-toolchain-consistency.mjs
node scripts/preflight.mjs
```

Then the deliberate-break drill, [quickstart.md](./quickstart.md) §3, **including the restore** — and
confirm `git status` is clean afterwards. A left-behind break is the drift the gate exists to catch.

Derive any further tiers from what the diff actually touches — the repo rule is to run the tiers your
diff touches, not the ones you remember. This diff is `scripts/`, `renovate.json`,
`.forgejo/workflows/guardrails.yml` and `docs/`; it touches **no** application code, so no
`nx test`/`nx lint`/`nx e2e` project target is implicated.

**Expected**: all green; `git status` clean.

### T020 ⏳ (blocked on merge) — Close backlog item #204 against its acceptance criteria

**Type**: Documentation | **Time**: 10 min | **Risk**: None

**Spec reference**: all six of item #204's criteria

Verify each criterion is met, comment the evidence (the before/after extraction diff, the drill
output), then close. Per the backlog rules: closure is an explicit act after verification, never
because a PR merged.

```bash
node scripts/backlog.mjs show 204
node scripts/backlog.mjs comment 204 --body-file <evidence>
node scripts/backlog.mjs update 204 --state closed
```

**Done when**: item #204 is closed with the evidence recorded. **Do this only after the change has
actually merged** — the criteria include CI-tier behaviour that a local run does not prove.

---

## Dependencies

```
T001 (baseline)  ─────────────────────────────► T013
                                                  ▲
US1:  T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009 ──► SHIPPABLE (MVP)
US2:  T010 → T011 → T012 → T013 → T014          ──────────────► SHIPPABLE
US3:  T015 [P] ─┐
      T016 [P] ─┴──────────────────────────────────────────────► SHIPPABLE
Polish: T017 (needs T008) · T018 · T019 (needs all) · T020 (needs merge)
```

**Story independence**: US1, US2 and US3 touch disjoint files and can be implemented in any order.
The sequence above is priority order, so stopping after any checkpoint leaves a coherent increment.

**T001 must precede T011** — once `renovate.json` changes, the baseline can no longer be captured.

## Parallel opportunities

- **T015 and T016** are two different runbooks with no shared content — fully parallel.
- **US2 and US3 are parallel with each other** once US1 is done; they share no file.
- Within US1 the TDD pairs are strictly sequential — that is the point of RED-then-GREEN.
- **T003/T005 could be written together** (both are test-authoring in one file), but their paired
  implementations must still be verified GREEN separately, so the marginal gain is small and the risk
  of a muddled RED is not.

## Implementation strategy

**MVP = US1 (T001–T009).** It closes the measured failure on its own: the next Playwright bump,
whatever its origin, is caught in ~1 s with a diagnosable message instead of ~35 min with a generic
one. US2 then removes the recurring repair, and US3 makes the rule traceable to its enforcement.

Ship US1 first and confirm the gate starts green on `main` for the right reason (lockfile `1.62.1`,
both tags `v1.62.1-noble`) before adding the bot half — that ordering means the bot's first Playwright
PR arrives into a repository that can already detect a half-bump.

## Measured outcomes

| Claim | Measured |
|---|---|
| Gate runtime (SC-001, budget 30 s) | **0.425 s** — versus the ~35 min the same drift took on PR #199 |
| A partial bump is rejected (SC-003) | `app-ci.yml:752 — Playwright image v1.60.0-noble disagrees with the 1.62.1 that pnpm-lock.yaml resolves…`, exit 1, drill restored clean |
| The selftest can fail (SC-004) | Comparison disabled ⇒ exit 1 naming all four rejection cases; restored ⇒ exit 0 |
| Gate passes for the right reason (SC-007) | lockfile `1.62.1`; both tags `v1.62.1-noble`; exit 0 |
| Extraction before (FR-011) | 2 `@playwright/test` deps, both manifest **ranges** (`^1.36.0`, `^1.59.1`); `app-ci.yml` matched by `github-actions` **only** |
| Extraction after (FR-011) | **4** deps — the 2 new ones `packageFile .forgejo/workflows/app-ci.yml`, `depName @playwright/test`, `currentValue 1.62.1`, `replaceString mcr.microsoft.com/playwright:v1.62.1-noble`, **×2** |
| Config validity | `renovate-config-validator` — `Config validated successfully against 1 file(s)` |
| Unit tests | `check-toolchain-consistency.test.mjs` 45/45; `renovate-workflow.guard.test.mjs` 14/14 |
| Full script suite | 733 tests, **731 pass, 1 fail** — pre-existing and unrelated (see below) |
| Preflight | 26 of 27 checks pass; the 1 failure is the same pre-existing test |

**The one failure is pre-existing and out of scope.** `wiki-maintain.test.mjs` → *"CLI: --execute
without a credential exits 2"* fails identically on `main` @ `68a40784`. Cause: its `runCli()` helper
deletes `ANTHROPIC_API_KEY` from the child environment but not **`MCM_ANTHROPIC_API_KEY`**, which is
the name this repo actually carries the key under — so in any environment with the key set, the
child finds a credential and does not exit 2. Proven: `env -u MCM_ANTHROPIC_API_KEY node --test …`
⇒ 1 pass. Filed as a separate backlog item rather than folded into this feature.

## Deviations from the plan

Both were refinements discovered while implementing, recorded rather than made silently:

1. **`collectLockfilePlaywrightVersions` returns the version SET instead of a throwing
   `resolveLockfilePlaywrightVersion`** — lets the caller tell *absent* from *ambiguous* (different
   findings, different messages) without exception control flow. See
   [contracts/gate-cli.md](./contracts/gate-cli.md).
2. **`comparePlaywrightPins` was split out** so `--selftest` proves rejection with no filesystem
   access, keeping the demonstration runnable in CI on every PR.

And one correction to this file itself: every `Verify RED`/`Verify GREEN` command originally wrote
`node --test <file> --test-name-pattern "x"`, which is **silently inert** — everything after the
script path becomes the script's own argv. Corrected to put the flag first; measured in
[research.md](./research.md) R9.

## Completion Checklist

Before marking `061-playwright-image-pin-gate` complete, verify all success criteria from
[spec.md](./spec.md):

- [x] **SC-001**: a drifted pin is rejected in under 30 s of check runtime
- [x] **SC-002**: a drift failure is diagnosable from the message alone — no container logs
- [x] **SC-003**: a partial bump is rejected; no combination of occurrences yields a false pass
- [x] **SC-004**: `--selftest` runs in CI on every PR and demonstrates the gate can fail
- [ ] **SC-005**: a Playwright bump arrives as exactly one PR containing both halves
- [x] **SC-006**: bot behaviour confirmed by an executed validation/extraction run, not by inspection
- [x] **SC-007**: the gate passes on the current tree for the right reason (`1.62.1` / `v1.62.1-noble` ×2)
- [x] **SC-008**: both runbooks state the rule **and** name its enforcement
- [x] Platform parity table — N/A, toolchain feature with no UI flow
- [x] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [x] `node --test scripts/__tests__/*.test.mjs` — script unit tests pass
- [x] `node scripts/check-toolchain-consistency.mjs --selftest` and the real scan both pass
- [ ] `node scripts/preflight.mjs` — the local pre-push path is green
- [x] `git status` clean — the deliberate-break drill was restored
- [ ] `rtk gain` — token compression confirmed (run last; measures the runs above)
