---
description: "Task list for 051 — CI diagnostics gap closure and the E2E agent-gate fix"
---

# Tasks: CI diagnostics gap closure and E2E agent-gate fix

**Input**: Design documents in `specs/051-ci-diagnostics-closure/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[data-model.md](./data-model.md), [quickstart.md](./quickstart.md),
[contracts/](./contracts/) — three contracts

**Backlog**: items #158 (`type/bug`, `p1`), #156 (`type/tech-debt`, `p2`, `status/needs-spec`),
#157 (`type/bug`, `p3`), #155 (`type/chore`, `p3`)

**Tests**: MANDATORY. The constitution's TDD principle is non-negotiable. Every behavioural change
below is a CI script or gate, and this feature exists because gates reported green without checking —
so a gate change that is not RED-verified is exactly the defect being fixed.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different file, no dependency on an incomplete task
- **[Story]**: `[US1]`…`[US7]`; Setup / Foundational / Polish tasks carry no story label
- Every test task carries a **Verify RED**; every implementation task a **Verify GREEN**

> **A Verify RED showing 0 failures is a failed task, not a passed one.** Check the collected count
> as well as the failure count — a selector that matches nothing also reports no failures.

> **Where RED is observable is stated per task.** Some defects here are platform-specific and
> **cannot** be made RED on Linux. Each such task says so and names the measured Windows evidence
> instead of pretending to a local RED. Manufacturing a fake local RED would be the same dishonesty
> this feature exists to remove — and per **FR-031**, every pass claim names its platform.

---

## Phase 1: Setup — measure before touching anything

**Purpose**: Establish the baselines every later GREEN is measured against. Two of them already
exist and are recorded rather than re-derived.

- [X] T001 Capture the Linux baseline of the script suite and record it in this file
  - **Type**: Verification | **Risk**: None
  - **Command**: `node --test "scripts/__tests__/*.test.mjs"`
  - **Expected**: green on Linux. Record the exact test/pass/fail counts here — the Windows target in
    SC-006 is judged against the delta from this, not against zero-in-the-abstract.
  - **MEASURED (Linux, dev container, 2026-08-09)**: **471 tests, 470 pass, 0 fail, 1 skipped**,
    exit 0, duration ~5.0s.
  - **Note the platform delta (FR-031)**: Linux collects **471**, Windows collects **408** (T002).
    The 63-test gap is `wiki-maintain.test.mjs` aborting at load on Windows (R8d) — its cases are
    never collected there. That gap is itself evidence for T044, and it is why SC-006's Windows target
    says the collected total must *rise*.
  - **Done when**: counts are written into this task. ✔

- [X] T002 [P] Record the Windows baseline supplied by the operator
  - **Type**: Verification | **Risk**: None
  - **Measured 2026-08-09, Node v24.14.1, `node --test "scripts/__tests__/*.test.mjs"`**:
    408 tests, 392 pass, **15 fail**, 1 skipped, exit 1, across five files —
    `ci-log-step` (9), `wiki-maintain` (file-level load failure), `ci-status` (1),
    `check-toolchain-consistency` (1), `check-ci-digest-coverage` (1), `check-openwiki-okf` (1),
    `gen-dev-env.guard` (1).
  - **Done when**: this baseline is the reference SC-006 is measured against. Do **not** re-derive it
    locally — it is not reproducible on Linux, which is the point. ✔ recorded, not re-derived.

- [X] T003 [P] Confirm both line-ending defects still reproduce on Linux before fixing them
  - **Type**: Verification | **Risk**: None | **Covers**: research R8a, R8b
  - **Command**: the two reproductions in [quickstart.md § Story 7](./quickstart.md)
  - **Expected**: `parseExemptions(LF) -> Map(1)` and `parseExemptions(CRLF) -> Map(0)`;
    `Date.parse("…Z\r") -> NaN`.
  - **OBSERVED (Linux, 2026-08-09)** — both reproduce:

    ```text
    LF   -> Map(1) { 'myjob' => 'because reasons' }
    CRLF -> Map(0) {}
    Date.parse("2026-08-09T00:00:00Z")   -> 1786233600000
    Date.parse("2026-08-09T00:00:00Z\r") -> NaN
    ```

  - **Incidental finding, relevant to T005/T006**: importing `check-ci-digest-coverage.mjs` **runs the
    real gate as an import side effect** — the probe above printed
    `✓ ci-digest coverage gate passed` before its own output. The existing test file already works
    around this; the new cases must too, and T020 must not make that side effect throw.
  - **Done when**: both observed. These are the RED evidence for US7 and are reproducible **on
    Linux**, so US7 needs no Windows host to verify — only to confirm the end-to-end effect. ✔

---

## Phase 2: Foundational — stop producing the condition

**Purpose**: Declare line-ending normalization for the file types the gates parse. Repo-wide
infrastructure, landed on its own so the re-normalization it causes on other platforms is reviewable
in isolation from any behaviour change.

**⚠️ BLOCKS**: nothing technically, but it must be **its own commit** — see the plan's risk table.

- [X] T004 Declare `eol=lf` for the parsed file types in `.gitattributes`
  - **Type**: Config change | **Risk**: Low | **Covers**: FR-023, research R8c
  - Add `*.yml`, `*.yaml` and `*.md` alongside the existing `*.sh` rule, and extend the file's
    existing comment to say *why*: the `*.sh` rule was added because a CRLF shebang breaks a
    container; these are added because a CRLF line breaks a **parser**, and two gates were silently
    mis-verdicting because of it.
  - **Done when**: `git check-attr text eol -- .forgejo/workflows/app-ci.yml openwiki/quickstart.md`
    reports `eol: lf` for both, and `git status` is clean on Linux (already LF — the diff appears
    only on a normalizing platform).
  - **Commit alone.** Do not combine with T005+.
  - **DONE (Linux, 2026-08-09)** — commit `dffdf11`, **1 file changed, 21 insertions**, nothing else
    in the commit. `git check-attr text eol` reports `eol: lf` for
    `.forgejo/workflows/app-ci.yml`, `openwiki/quickstart.md` and
    `infrastructure-as-code/docker-compose.yml`; `git status` clean afterwards.

---

## Phase 3: User Story 7 — a gate enforces the same rule regardless of line endings (P1)

**Goal**: Two gates currently give different verdicts for the same commit depending on the
contributor's checkout. One fails closed (PRD §1.3); one fails **open**.

**Independent test**: Feed carriage-return input directly to each parser and compare the verdict with
the line-feed case. No Windows host required.

**⚠️ BLOCKS US2** — Story 2 tightens `check-ci-digest-coverage.mjs` and offers exemption markers as
its escape hatch. Building that on a parser that cannot see markers would make the new rule
unfixable by its own mechanism.

- [X] T005 [P] [US7] Write a failing test that `parseExemptions` is line-ending independent in `scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Type**: Test | **Risk**: None | **Covers**: US7-AC1, US7-AC4, FR-021, FR-024
  - Build one fixture string with `\n` endings, derive the CRLF variant with `.replace(/\n/g, '\r\n')`,
    and assert `parseExemptions` returns **deep-equal maps** for both. Assert on the map contents, not
    just its size — a marker whose reason is captured as `'because reasons\r'` is also a bug.
  - Feed the input **directly**. Do not write a temp file and rely on the checkout, or the test proves
    nothing about the parser (FR-024).
  - **Verify RED**: `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected RED**: 1 failing — the CRLF map is `Map(0) {}` against an expected `Map(1)`.
  - **RED is observable on Linux.**
  - **MEASURED RED (Linux)**: case `(k)`, in a run collecting **14 tests, 12 pass, 2 fail** (the other
    failure is T006's `(l)`). Both markers were asserted, and both were invisible on CRLF.
  - **Two implementation notes worth keeping.** (1) The case asserts the **LF** side finds its markers
    before deep-equalling the two — without that, the fix could regress to "find nothing either way"
    and the case would pass on two empty maps. (2) The parser is exercised in a **subprocess** writing
    a probe `.mjs`, because importing the gate runs the real scan as a side effect (T003) and a
    momentarily-red repo would `process.exit(1)` out of the test process. `node -e` cannot be used —
    it has no script-argv slot, so `--dir` is swallowed as a node option (`node: bad option: --dir`).

- [X] T006 [US7] Add a whole-gate CRLF case proving PRD §1.3 is closed in `scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Type**: Test | **Risk**: Low | **Covers**: US7-AC1, SC-008
  - Extend the existing "real repo workflows all pass" case: run the coverage evaluation a second
    time over the same workflow text converted to CRLF, and assert the verdict is identical. This is
    the regression test for the exact failure the PRD reported —
    `app-ci / changes`, `app-ci / trigger-cd`, `infra-image-scan / changes` reported as uncovered.
  - **Written before the fix, deliberately.** An earlier draft placed this after T007 and produced its
    RED by stashing the fix — a mutation-after-implementation, which inverts the order this file
    insists on everywhere else. Both US7 tests are now RED against unmodified code.
  - **Verify RED**: `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected RED**: 1 failing, naming those three jobs. Together with T005 that is ≥2 failing.
  - **RED is observable on Linux.**
  - **MEASURED RED (Linux)**: case `(l)` failed with the PRD's message **verbatim**, naming exactly
    the three jobs:

    ```text
    ✗ ci-digest coverage gate FAILED: 3 job(s) not covered:
      app-ci / changes — publishes a digest but no step is wrapped with `scripts/ci-log-step.sh` …
      app-ci / trigger-cd — …
      infra-image-scan / changes — …
    ```

    The case also asserts the **LF** run is clean first, so a CRLF failure can never be confused with
    a genuinely broken tree.

- [X] T007 [US7] Make the exemption parser tolerate carriage returns in `scripts/check-ci-digest-coverage.mjs`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T005 **and** T006 verified RED
  - Split on `/\r?\n/` rather than `'\n'`. Do **not** "fix" this by adding the `m` flag to the marker
    pattern or by appending `\r?` to it — the line-splitting is the defect, and the next pattern added
    to this file would inherit the trap. Check every other `split('\n')` in the file while here.
  - **Verify GREEN**: `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected GREEN**: 0 failures — both T005's and T006's cases go green from one fix.
  - **Also run**: `node scripts/check-ci-digest-coverage.mjs --selftest && node scripts/check-ci-digest-coverage.mjs`
    → both exit 0, real scan still passes on Linux.
  - **MEASURED GREEN (Linux)**: **14 tests, 14 pass, 0 fail** — one `split(/\r?\n/)` closed both cases.
    `--selftest` and the real scan both exit 0.
  - **Checked while here**, as the task asks: `split('\n')` appears **exactly once** in this file, so
    there was no second instance to inherit the trap.

- [X] T008 [P] [US7] Write a failing test that the drift check runs on carriage-return input in `scripts/__tests__/check-openwiki-okf.test.mjs`
  - **Type**: Test | **Risk**: None | **Covers**: US7-AC2, FR-022, FR-024
  - Mirror the existing V12 stale-concept case with a fixture written using CRLF endings, and assert
    the output still matches `/stale\.md/`. This is the **fails-open** one: today it prints
    `✅ 1 concepts conformant` and the staleness check silently never runs.
  - **Verify RED**: `node --test scripts/__tests__/check-openwiki-okf.test.mjs`
  - **Expected RED**: 1 failing — `The input did not match the regular expression /stale\.md/. Input:
    '[openwiki-okf] ✅ 1 concepts conformant across 1 directories.\n'`
  - **RED is observable on Linux.**
  - **MEASURED RED (Linux)**: **21 tests, 20 pass, 1 fail** — the new case, asserting
    `the drift check silently did not run on CRLF input — the gate failed OPEN`. The exit code was
    **0**, as predicted: this gate does not go red, it goes quiet.
  - **The fixture is built in the test, not checked in.** T004 now declares `eol=lf` for `*.md`, so a
    committed CRLF fixture would be normalised out of existence — and constructing the bytes in the
    test is what FR-024 asks for anyway.

- [X] T009 [US7] Normalize the timestamp before validating it in `scripts/check-openwiki-okf.mjs`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T008 verified RED
  - The V12 guard at line ~254 calls `Date.parse(fields.timestamp)` on the raw value; V5 at line ~237
    escapes the same bug only because it trims first. Normalize **once, at the point the field is
    read**, so both validators and any future one see a clean value — do not add a second `.trim()` at
    the call site and leave the asymmetry in place.
  - **Verify GREEN**: `node --test scripts/__tests__/check-openwiki-okf.test.mjs`
  - **Expected GREEN**: 0 failures.
  - **Also run**: `pnpm nx okf-lint` → still passes.
  - **MEASURED GREEN (Linux)**: **21 tests, 21 pass, 0 fail**. The Nx target passes:
    `[openwiki-okf] ✅ 61 concepts conformant across 8 directories.`
  - **Implemented as a `normalizeFields` boundary** in `extractFrontMatter`, recursing through strings,
    arrays and nested maps, so every validator — including any written later — receives trimmed
    values. The two **pre-existing** call-site `.trim()`s (V5's timestamp, V6/V7's resource) were then
    **removed**: leaving them would have preserved the very asymmetry that was the defect, and the
    task is explicit that the fix must not be another call-site trim.
  - **Command correction for the runbook and quickstart**: bare `pnpm nx okf-lint` fails with
    `NX Both project and target have to be specified`. The target belongs to
    `infrastructure-as-code`, so the working invocation is
    **`pnpm nx okf-lint infrastructure-as-code`**.

- [X] T010 [US7] Sweep the gate scripts for the same validate-before-normalize shape
  - **Type**: Verification | **Risk**: Low | **Covers**: FR-022
  - Grep the `check-*.mjs` family for `Date.parse(`, `Number(`, `JSON.parse(` and `split('\n')` applied
    to values read from repository text, and check each for the trailing-`\r` case. Record findings
    here: fix any that fall in this feature's two gates; file the rest (spec Out of Scope excludes a
    repository-wide audit).
  - **Done when**: every hit is classified as fixed, out-of-scope-and-filed, or provably unaffected.
  - **SWEEP RESULT (Linux, 2026-08-09)** — every hit classified, **nothing left unclassified and
    nothing needing to be filed**:

    | Site | Input | Verdict |
    | --- | --- | --- |
    | `check-ci-digest-coverage.mjs:47` | repository YAML | **FIXED** (T007) |
    | `check-openwiki-okf.mjs` V12 `Date.parse` | repository front matter | **FIXED** (T009) |
    | `check-komodo-sync.mjs:43`, `check-topology-scrub.mjs:45,58`, `check-no-argv-secrets.mjs:38,71` | repository text | **already `/\r?\n/`** — the correct precedent, and evidence the trap is known here |
    | `check-openwiki-governance.mjs:175,375` | repository text | **already normalizes** via `.replace(/\r\n?/g,'\n')` before splitting |
    | `check-toolchain-consistency.mjs:87` (`collectPins`) | repository YAML/Dockerfiles | **provably unaffected — measured, not reasoned.** Every pin pattern captures with a class that excludes `\r` and none is `$`-anchored. Probe: `collectPins(lf)` and `collectPins(crlf)` returned byte-identical JSON |
    | `check-toolchain-consistency.mjs:177` | `nx.json` text | unaffected — the split feeds `includes()` for a line **number**; a trailing `\r` cannot change a substring test |
    | `check-toolchain-consistency.mjs:56,76,201` | JSON values | unaffected — `String(v).trim()` first, and JSON cannot carry a raw `\r` outside a string |
    | every `JSON.parse(readFileSync(...))` (7 gates) | `.json` files | unaffected — `\r` is JSON whitespace between tokens |
    | `ci-failure-digest.mjs:54,98,372,493`, `ci-status.mjs`, `wiki-maintain.mjs`, `agent-*.mjs` git/docker splits | **process output**, not repository text | out of this rule's scope — these read a program's stdout, not a working tree, so a contributor's `core.autocrlf` cannot reach them |
    | `check-openwiki-okf.mjs:99`, `openwiki-policy.mjs:88` | a thrown parser's `err.message` | unaffected |

  - **Generalisation worth keeping**: the failing shape is specifically an **end-anchored or
    `.`-terminated pattern applied to a line split with `'\n'`**. `\r` is a line terminator in JS
    regular expressions, so `.` will not consume it and a non-multiline `$` will not tolerate it — but
    `\s*` absorbs it silently. That is why the coverage gate saw the job headers and not their
    exemption markers, and why nothing looked wrong.

- [X] T011 [US7] Document the line-ending invariant in `docs/runbooks/ci-diagnostics.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: FR-021, constitution § Documentation
  - Record: a gate parses repository text, so its verdict must not depend on the checkout; the two
    directions of failure observed here (closed for the coverage gate, **open** for the conformance
    gate); and the rule that a value is normalized when read, not at each use.
  - **Done when**: the section exists and names PRD §1.3 as the worked example.

- [X] T012 [US7] Annotate PRD §1.3 in `docs/proposals/PRD-CIDiagnosticsGapClosure.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: SC-008
  - The PRD says the local/CI divergence is unexplained ("either it is invoked differently there or
    the discrepancy is environmental"). It was environmental, and now has a named cause. Record it,
    with the reproduction, so the PRD stops being misleading.
  - **Done when**: §1.3 states the cause and points at this feature.

---

## Phase 4: User Story 1 — the required E2E gate exercises the agent surface (P1)

**Goal**: `app-ci / app-e2e` has never run a single `agent-*.spec.ts`, and never run the two admin
specs either. Both skip silently while the required gate reports green.

**Independent test**: A CI run shows a non-zero executed count and a zero skip count for both spec
families.

- [X] T013 [P] [US1] Write a failing guard test for the E2E environment contract in `scripts/__tests__/app-e2e-env.guard.test.mjs`
  - **Type**: Test / New file | **Risk**: Low | **Covers**: US1-AC1, US1-AC3, FR-001, FR-002, FR-003,
    [contracts/e2e-env-forwarding.md](./contracts/e2e-env-forwarding.md)
  - Follow the established pattern in `scripts/__tests__/agent-stack.guard.test.mjs` — read
    `.forgejo/workflows/app-ci.yml` and assert on its text. Assert that the Playwright `docker run`
    invocation forwards `E2E_AGENT_PRODUCTION`, sets `E2E_REQUIRE_AGENT_STACK=1`, and forwards
    `KEYCLOAK_SERVICE_CLIENT_SECRET`; and that the `app-e2e` job's `env:` block defines
    `KEYCLOAK_SERVICE_CLIENT_SECRET` from a secret.
  - Also assert the **negative**: no secret is forwarded in `-e NAME=$NAME` form, which would place
    its value on the command line (contract invariant 1).
  - A guard, not a one-time edit — the omission survived the lifetime of this job precisely because
    nothing asserted it.
  - **Verify RED**: `node --test scripts/__tests__/app-e2e-env.guard.test.mjs`
  - **Expected RED**: ≥3 failing — the three flags are absent from the invocation.
  - **RED is observable on Linux.**
  - **MEASURED RED (Linux)**: **6 collected, 1 pass, 5 fail**. The one **pass** is the negative case
    (contract invariant 1) — deliberately, and it is load-bearing: it proves the locator found a real
    invocation, so the five failures are the flags actually being absent rather than the whole file
    failing to parse. A guard that is uniformly red proves nothing about what it located.
  - **Trap found while writing it.** Anchoring the locator on `docker run .*--network host` matches an
    **earlier, unrelated** invocation in the same job — the guard then asserts confidently about the
    wrong container. It now anchors on the `mcr.microsoft.com/playwright` image and walks *back* to
    its `docker run`, and asserts it found `playwright test` before reading anything off it.

- [X] T014 [US1] Forward the missing flags in `.forgejo/workflows/app-ci.yml`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T013 verified RED
  - In the `app-e2e` job: add `KEYCLOAK_SERVICE_CLIENT_SECRET: ${{ secrets.KEYCLOAK_SERVICE_CLIENT_SECRET }}`
    to the job `env:` block (it is absent there, so a pass-through `-e` alone would forward nothing).
    In the Playwright step: add `-e E2E_AGENT_PRODUCTION`, `-e E2E_REQUIRE_AGENT_STACK=1` and
    `-e KEYCLOAK_SERVICE_CLIENT_SECRET`.
  - Add a comment listing the four **deliberately** unforwarded variables with reasons, from the
    contract, so the next reader does not re-derive the table or add them speculatively.
  - **Verify GREEN**: `node --test scripts/__tests__/app-e2e-env.guard.test.mjs`
  - **Expected GREEN**: 0 failures.
  - **MEASURED GREEN (Linux)**: **6 collected, 6 pass, 0 fail**. `check-no-argv-secrets.mjs` also
    still passes (`✅ no argv-secret arguments to the test runner`) — the new flags use the
    pass-through form.

- [X] T015 [US1] Reproduce the skip and the un-skip locally, by result
  - **Type**: Verification | **Risk**: Low | **Covers**: US1-AC1, FR-029
  - Run one agent spec through the CI container invocation verbatim, with and without the flag, per
    [quickstart.md § Story 1](./quickstart.md).
  - **Expected**: without → `3 skipped`, `EXIT=0`; with → all 3 execute. **The exit code is 0 in both
    cases** — which is the whole point. Record the counts, not the status.
  - **MEASURED (Linux dev container, 2026-08-09)**, running the CI `docker run` verbatim against
    `agent-navigate-movie.spec.ts` (**1** test in that file, not 3 — the count in the task was an
    estimate; the measurement is the skip/executed split, and it holds):

    | Flags | Result | Exit |
    | --- | --- | ---: |
    | as CI ran it — neither flag | **`1 skipped`**, 0 executed | **0** |
    | `-e E2E_REQUIRE_AGENT_STACK=1` only | **`1 failed`**, naming the unmet condition and how to fix it | 1 |
    | both flags, as CI runs it now | **0 skipped, 1 executed** | 1 (see below) |

  - **This is the defect, demonstrated.** Global setup ran, the BFF was confirmed
    (`X-BFF-Source=dev-container`), the spec was collected — and then it skipped and the run reported
    success. Nothing in that output says the agent surface was not exercised. `--list` will **not**
    show this: it prints the collected test either way. The skip count is the measurement.
  - **The require-flag branch works as designed**: without `E2E_AGENT_PRODUCTION` it throws
    `FAIL_REASON` from a `beforeAll`, which names the unmet condition and the command that fixes it —
    a loud failure rather than a green tick.
  - **With both flags the spec EXECUTES and then fails** on a real assertion
    (`locator('[data-testid="selection-options"]')` not visible within 180s at
    `agent-navigate-movie.spec.ts:105`). **That is T017's business, not a regression here** — and the
    US1 claim is the executed count going 0 → 1, which it did. See T017 for why this local failure
    cannot be attributed to the agent surface from this container.

- [X] T016 [US1] Re-run the environment enumeration and reconcile it against the contract
  - **Type**: Verification | **Risk**: Low | **Covers**: FR-003, US1-AC3
  - Run the enumeration in [quickstart.md § Story 1](./quickstart.md) over
    `frontend/mcm-app/tests/e2e/` **and** `playwright.config.ts`.
  - **Done when**: every name appears in the contract as forwarded or deliberately-not, with no
    residue. This check is what found the admin-spec defect; it is a validation step, not a one-off.
  - **RECONCILED (Linux, 2026-08-09)**: **17 names, 10 forwarded + 7 deliberately-not, zero residue.**
  - **⚠️ But the enumeration command as written was itself under-reporting — and this is the more
    valuable finding.** The published one-liner matches only `process.env.NAME` /
    `process.env['NAME']` and returns **14** names. It silently misses three, because a literal is
    not the only way the suite reads an environment variable:

    | Missed | Read as | Where |
    | --- | --- | --- |
    | `E2E_TEST_USER`, `E2E_TEST_PASSWORD` | `requireEnv('…')` — through a helper | `setup/global-setup.ts`, `bff-prod-lifecycle.spec.ts` |
    | `E2E_REQUIRE_AGENT_STACK` | `process.env[REQUIRE_AGENT_STACK_ENV]` — indexed by a **constant** | `setup/agent-stack-gate.ts` |

    So the check the contract calls "the check" was answering a **narrower question than it claimed**
    — the same shape as the coverage gate that asked "is a digest published?" instead of "does it
    contain anything?", and as the shell probe in T046 that asks whether a shell *starts* rather than
    whether it can *reach the files*. It reported clean while blind to the indirect reads, and one of
    the names it could not see is the require-flag this very story adds. `quickstart.md` now carries
    the widened three-part command and states the expected count (**17**), so a future run notices a
    shortfall instead of reading a smaller clean list as a clean result.

- [ ] T017 [US1] Triage whatever the newly-running specs reveal
  - **Type**: Verification | **Risk**: **High** | **Covers**: spec Edge Cases, item #150
  - The agent and admin specs run in CI for the first time here. Failures are pre-existing defects,
    not regressions from this change.
  - **Done when**: every failure is either fixed, or attributed to a baseline with evidence and filed.
  - **Prohibited**: reverting to a skip, or narrowing the spec selection to dodge a failure. That
    recreates the exact false green this story removes.
  - **STATUS: ANSWERED BY CI — SC-001 met, and a systemic problem exposed that needs your decision.**

  - ### The CI result (run #1603, sha `e4e79eb8`, provider `anthropic`)

    | Metric | Result |
    | --- | --- |
    | **skipped** | **0** — no line in the run mentions a skip |
    | passed | 126 (17.9 min) |
    | **failed** | **33** |
    | flaky | 15 |

  - **US1's claim is PROVEN and SC-001 is met**: the agent specs show a non-zero executed count and a
    **zero** skip count, by count and not by exit status. `agent-add-ownership`,
    `agent-card-navigate`, `agent-disambiguation`, `agent-import`, `agent-import-disambiguate`,
    `agent-navigate-collection` and `agent-navigate-movie` all executed — **none had ever run in CI
    before**. Neither admin spec appears in the failed or flaky lists.

  - ### The 33 failures are NOT what this task predicted

    It assumed failures would be pre-existing defects in the newly-running specs. Only **9 of 33**
    are in `agent-*` specs. **24 are in specs that already ran and were green** — `movies` (8),
    `responsive` (5), `assistant-*` (9), `perf` (1), `theme` (1) — all **ungated** (verified: none
    calls `requireAgentStack`).

    **30 of the 33 cite the same single cause:**

    ```text
    Error: gotoHome: home screen did not render — is the global-setup session valid?
    ```

    **⚠️ CORRECTION — I initially read that message as proof of session invalidation. It is not, and
    the over-reading is worth keeping because it is this feature's own subject.** The message is the
    *helper's guess*, not a measurement: `gotoHome` races two selectors for 60 s and, on timeout,
    throws that sentence. The code cannot distinguish "the session is invalid" from "the app did not
    render in time" — it only knows the selector never appeared. An error string that names a cause
    it did not test is exactly the kind of claim this feature exists to stop being trusted.

    **What the evidence actually shows**, from the bundle (38 occurrences of `did not render`):

    | Signal | Reading |
    | --- | --- |
    | **15 tests passed on RETRY** | argues **against** a permanently dead session — a dead session cannot recover |
    | 0 × `ECONNREFUSED` / `502` / `503` | the BFF stayed up throughout |
    | Keycloak: **exactly 1** `TOKEN_EXCHANGE_ERROR` | one isolated `subject_token validation failure`, not a systemic auth collapse |
    | 361 × `auth_failed reason:"no_token"` | requests arriving with **no cookie at all** — which is what the deliberately-unauthenticated specs (`auth.spec.ts`, `admin-registration`) do by design, so this is not evidence of eviction |
    | Gateway: `agent_tool_call … status=error` | the agent tool calls themselves erroring — the pre-existing class T017 *did* predict |
    | `MAX_CONCURRENT_SESSIONS=10`, one shared `storageState`, only 2 specs log in | the concurrent-session cap is **unlikely** to be reached |
    | `SESSION_IDLE_TIMEOUT_MS` = 30 min, `SESSION_ABSOLUTE_TIMEOUT_MS` = 24 h, web step = 17.9 min | neither timeout is obviously reached either |

    **Honest verdict: the mechanism is NOT yet established.** Session death is now the *less* likely
    of the two, and resource contention — the suite roughly doubling in work, with real model
    round-trips, on a capacity-1 runner — fits the retry-recovery pattern better. But "fits better"
    is not measured, and stating it as fact would repeat the mistake above.

  - **THE MEASUREMENT WAS TAKEN.** `app-e2e` re-run unchanged (same code, same flags, run #1604):

    | | run #1603 | run #1604 |
    | --- | ---: | ---: |
    | failed | 33 | **61** |
    | flaky | 15 | **37** |
    | passed | 126 | **76** |
    | duration | 17.9 min | **1.1 h** |

    Failure-set diff: **26 in both, 7 only in #1603, 35 only in #1604.** So it is **both** — a
    reproducible core of 26 *and* a large load-dependent component. Neither hypothesis alone was right.

  - ### The mechanism, established rather than inferred

    **Playwright runs 8 parallel workers** (`Running 177 tests using 8 workers`, identical in both
    runs) against **one** `E2E_TEST_USER` and one shared `storageState`, while
    **`MAX_CONCURRENT_SESSIONS` is 10**. `fullyParallel: false` serialises *within* a file but runs
    *files* in parallel.

    The config already documents the latent problem, in its own words at `playwright.config.ts:24`:

    ```ts
    retries: 1,  // SSO timing races between parallel workers cause intermittent login timeouts
    ```

    Before this feature, an agent spec file was picked up by a worker, **skipped instantly**, and
    freed it. Now each occupies a worker for **minutes** doing real model round-trips. That widens
    enormously the window in which all 8 workers are concurrently active against one shared session —
    and 8 workers against a cap of 10 sits right at the edge where eviction of the oldest session
    becomes reachable. `retries: 1` then re-runs the slow model work, which is why identical code
    took 3.7× longer the second time.

  - **The 26-failure core splits 7 agent-gated / 19 previously-green ungated.** The 7 are the
    pre-existing agent defects T017 predicted (item #150's answer). The 19 are collateral from the
    contention above, not 19 independent regressions.

  - **Corrected attribution, final**: the trigger is **worker parallelism against a single shared
    E2E user**, which predates this feature entirely and was masked by the agent specs skipping. This
    feature did not introduce it and does not contain its fix.

  - **Cheapest remedies, in cost order — NOT done here, all outside this feature's scope:**
    1. Pin `workers` to ~4 for CI — one line, no architecture change.
    2. Raise `MAX_CONCURRENT_SESSIONS` for the CI BFF — one env var.
    3. Give the agent specs their own E2E user, or run them as a separate Playwright project — the
       real fix, and the largest change.

  - **Attribution, precisely**: this feature did not create the limitation, it **exposed** it. The
    incompatibility between one shared session and the agent specs running has existed as long as
    both have, and was invisible only because the agent specs never ran. But the effect is real:
    **as delivered, US1 turns a green REQUIRED merge gate red.**

  - **Neither absorbed nor worked around.** Reverting to a skip is prohibited by this task and would
    recreate the false green; fixing session isolation (a per-spec user, a longer E2E session, or the
    agent specs as a separate Playwright project) is an E2E architecture change outside this
    feature's scope. **Escalated to the operator.**
  - **Local observation (Linux dev container, 2026-08-09)**: with both flags forwarded,
    `agent-navigate-movie.spec.ts` executes and **fails** — the offer locator
    `[data-testid="selection-options"]` never becomes visible within the 180s action timeout
    (`agent-navigate-movie.spec.ts:105`). The agent stack was up (`movie-assistant-gateway` and all
    three MCP containers healthy).
  - **This failure is NOT yet attributable, and saying otherwise would repeat §1.3's mistake.** This
    container's gateway resolves its model provider from the **dev** environment scoping (see
    `openwiki/invariants/model-provider-scoping.md`), and the local run forwarded no
    `ANTHROPIC_API_KEY`; CI runs the same specs with `E2E_AGENT_PROVIDER=anthropic` **and** the key.
    A model-surface failure and a genuine UI-contract failure look identical from here. Reporting the
    local red as "the agent specs are broken" would be a platform-specific result generalised — which
    is exactly what FR-031 exists to stop.
  - **What closes this**: the first CI run on this branch with T014 landed. That run is also the
    answer to item **#150** ("are `agent-navigate-movie` / `agent-disambiguation` green on the
    Anthropic surface?"), which could not be answered before precisely because these specs had never
    run there.
  - Nothing has been reverted or narrowed.

- [X] T018 [US1] Update `openwiki/invariants/feature-validation-checklist.md` if its guidance is now stale
  - **Type**: Documentation | **Risk**: None
  - The checklist already warns about this failure mode and instructs setting `E2E_REQUIRE_AGENT_STACK=1`
    "on any pre-PR or **CI** run". CI now does. Confirm the wording matches reality; correct it if not.
  - **Done when**: the invariant describes what CI actually does.
  - **It was stale in three ways**, all corrected:
    1. It told readers to set the flag "on any pre-PR or **CI** run" as though CI already did. CI did
       not — that is the whole defect — so the page was describing an intention as a fact.
    2. "**All ten** `agent-*.spec.ts` files gate on `E2E_AGENT_PRODUCTION=1`" — measured: **13** files,
       of which **11** call `requireAgentStack`. `agent-cors.spec.ts` and
       `agent-session-refresh.spec.ts` deliberately do not (transport and session behaviour, no model
       needed). A reader chasing a skipped spec would have been looking for a gate that is not there.
    3. Nothing recorded the admin-spec half of the same omission.
  - **The `## Gotchas` passage is fingerprinted**, so this was a deliberate `passage-corrected` event —
    the policy entry for this concept permits it. The governance gate caught the edit and named the
    remedy; `openwiki/protected.yaml` carries the new fingerprint **in the same change**, with a
    comment saying why. Re-run: `✅ 898 documentation path(s) classified, 60 concept(s) … protected
    passages intact.`

---

## Phase 5: User Story 2 — a failing containerized job leaves usable output (P1)

**Goal**: 48 of 83 `run:` steps across 14 containerized jobs produce no capture. In
`guardrails / naming`, **every** gate step is bare and only two unrelated steps are wrapped — so a
gate failure publishes two irrelevant logs.

**Independent test**: Deliberately fail a previously-unwrapped step and diagnose it from the
self-serve tooling alone.

**⚠️ DEPENDS ON US7** — the exemption mechanism this story relies on must be readable first.

- [X] T019 [P] [US2] Write a failing test for per-step coverage in `scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Type**: Test | **Risk**: Medium | **Covers**: US2-AC1, FR-005,
    [contracts/step-instrumentation.md](./contracts/step-instrumentation.md)
  - Assert the new rule against synthetic workflow text: a job with one wrapped and one bare `run:`
    step **fails**; the same job with a step-level `# ci-log-step-exempt: <reason>` marker on the bare
    step **passes**; a marker with an empty reason **fails**.
  - **Also assert the two markers stay independent** — the gate reads `ci-digest-exempt` (opts out of
    publishing a digest, job-scoped) and `ci-log-step-exempt` (opts out of capture) as *separate*
    rules. Assert that neither marker satisfies the other's rule. Conflating them would silently
    disable one of two gates, and the contract now specifies both.
  - **Verify RED**: `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected RED**: ≥3 failing — the current gate passes the one-wrapped-step job.
  - **MEASURED RED (Linux)**: **24 collected, 21 pass, 3 fail** — `(r)`, `(s3)` and `(u)`, the three
    cases that actually discriminate between the old rule and the new one. Recorded honestly: several
    of the other new cases **passed vacuously** under the old rule (a step-level marker was being read
    as a job-level exemption, so `(s)` reached the right verdict for the wrong reason). They pass for
    the right reason after T020.
  - `(v2)` — the real workflows under the per-step rule — **passed before T020 and went red the moment
    the rule landed**. That is the correct order: it is the RED that T022–T024 close, and it enforces
    the contract's "the gate ships with the wrapping it requires".

- [X] T020 [US2] Implement per-step coverage in `scripts/check-ci-digest-coverage.mjs`
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T019 verified RED
  - Evaluate each `run:` step, not each job. Accept the existing `# ci-log-step-exempt:` marker at
    step level as well as job level; a marker with no reason is a failure. Keep the parser
    line-oriented — **no new dependencies**: this gate runs before any install step, and `js-yaml` is
    absent from the repository's `node_modules` (verified).
  - **Extend `ci-log-step-exempt` only.** `ci-digest-exempt` stays job-scoped — a step cannot opt a
    job out of publishing a digest. The two markers already have separate blank-reason checks; keep
    them separate.
  - **Verify GREEN**: `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected GREEN**: 0 failures.
  - **MEASURED GREEN (Linux)**: **24/24**.
  - **Implemented as `parseJobSteps(text, doc)`**, which zips the YAML-parsed step list against a
    line scan for markers — the parser already knows what a step is, and comments are what it strips.
    If the two disagree on step count the zip is **abandoned** and no step-level exemption is
    reported: a mis-associated marker would silently exempt the wrong step, which is worse than
    reporting nothing.
  - **`parseExemptions` was narrowed** to markers written *above* a job's `steps:`. All three real
    job-level markers live there. Without the narrowing a step-level marker was also read as
    job-level, so one step's exemption silently covered every later step — rebuilding the exact
    "one compliant thing stands in for many" defect this story removes. `(s3)` pins it.
  - **No new dependency.** The gate already imports `yaml`, a devDependency, and `guardrails / naming`
    installs before running it. (Research's "js-yaml is not available" is true of *js-yaml* and is a
    red herring here — the `yaml` package is present and already in use by this very file.)

- [X] T021 [US2] Extend the gate's self-test to prove the new fail and exemption paths
  - **Type**: Implementation | **Risk**: Low | **Covers**: contract § Implementation constraints
  - Every other gate in `guardrails / naming` proves its fail path before the real scan. The new rule
    must too, or it is a gate nobody has watched fail.
  - **Verify GREEN**: `node scripts/check-ci-digest-coverage.mjs --selftest` → exits 0 and reports the
    new paths as exercised.
  - **DONE (Linux)** — seven new checks: all-wrapped is clean; one bare step among wrapped ones is
    caught; a justified step-level exemption is honoured; a blank step-level reason is caught; an
    exemption does **not** leak to the following step; `ci-digest-exempt` does **not** double as a
    capture exemption; a `uses:`-only step needs no marker. Exit 0.

- [X] T022 [US2] Wrap the bare steps in `guardrails.yml` — **28 steps across five jobs**
  - **Type**: Config change | **Risk**: Medium | **Covers**: FR-005
  - `naming` (13), `sast` (9), `agent-gates` (3), `okf` (2), `secret-scan` (1). Give each a stable,
    descriptive log name — the name becomes the digest excerpt's `source` and is what a reader sees
    first.
  - **`okf`'s two are `corepack enable` and `pnpm install --frozen-lockfile`.** They are pure setup
    and therefore tempting to exempt — do not. A lockfile mismatch is a recurring, one-line CI failure
    and the contract names this exact case as *not* a legitimate exemption.
  - Exempt only what the contract's legitimate list covers, each with a written reason.
  - **Done when**: `node scripts/check-ci-digest-coverage.mjs` passes for these jobs.
  - **CI EVIDENCE (Forgejo, branch `051-ci-diagnostics-closure`, 2026-08-09)** — the wrapping was
    verified where it actually has to work, not only locally. All five `guardrails` container-executor
    jobs ran the wrapped steps and passed: **`naming` ✔** (28 wrapped steps, including every gate step
    *and* the stricter per-step coverage gate scanning its own tree), **`okf` ✔**, **`secret-scan` ✔**,
    **`agent-gates` ✔**. Host-executor jobs **`devcontainer-image / build-publish` ✔** and
    **`infra-image-scan` ✔** likewise.
  - **⚠️ THE FIRST CI RUN FOUND A REAL DEFECT IN THIS WRAPPING, and it is the nastiest shape the
    feature has produced.** `guardrails / sast` **FAILED**. Its `Sync the Python agent env` step
    carries `working-directory: agents/movie-assistant`, and the instrumentation pass had wrapped it
    as `bash scripts/ci-log-step.sh …` — a path relative to the **repo root**. From that working
    directory the script does not exist, so bash exited **127 before `ci-log-step.sh` ever ran**.
    Therefore **no log was captured and no `_failed-step` marker was written**, and the digest
    published `Failing step: _not reported_`. An instrumentation bug that leaves the step it
    instruments both broken *and* undiagnosable is precisely the outcome this feature exists to
    prevent.
  - **Two steps were affected** — `guardrails / sast :: Sync the Python agent env` and
    `app-ci / app-e2e :: Build embedded-bundle E2E APK`. Both now use
    `bash "$GITHUB_WORKSPACE/scripts/ci-log-step.sh"`. Case **`(x)`** gates it repo-wide rather than
    fixing two and hoping, and it is **mutation-checked**: reverting either step to the relative form
    turns the case red (25 collected, 24 pass, 1 fail); restoring it turns it green.
  - **A SECOND defect in the same run: `app-ci / dast` FAILED** with exactly one line —
    `scripts/ci-log-step.sh: line 40: MODEL_PROVIDER=anthropic: command not found`. The step was
    `run: MODEL_PROVIDER="$MODEL_PROVIDER" pnpm nx up-agents-prod …`, and a leading `VAR=value` is
    **shell syntax, not an argv element** — so `ci-log-step.sh`'s `"$@"` tried to execute the
    assignment as a command name. Both instances (`app-e2e` and `dast`) now use
    `env VAR=value cmd …`; `env` is a real executable and survives being passed as argv. Gated by
    case **`(x2)`**, also mutation-checked.
  - **This one took about a minute to diagnose, and is the better advertisement for the feature.**
    `dast-bring-up-containerized-agent` produced **no output whatsoever** before this change; the
    digest named it as the failing step and its captured log carried the entire cause in one line.
  - **Also audited** every wrapped one-liner for other shell syntax smuggled into argv — pipes,
    redirection, command substitution, list operators. One hit, a false positive (a `;` inside a
    quoted `echo` argument, which is a single argv element). Nothing else. **Stated honestly: that
    audit is static reasoning, not a CI run** — the two shapes above are the ones CI actually proved.
  - **The honest verdict on this pair.** The new gate checked that every step is *wrapped*; it did
    not check that the wrapping is *well-formed*, and the feature's own change is what broke those
    two jobs. `(x)` and `(x2)` close that second question for the two shapes CI exposed.
  - **It was diagnosed with NO job log**, which the forge does not expose — this is SC-002 happening
    unplanned. The digest published correctly (`digest-outcome=published`, US3 working in CI) and
    carried four of sast's other newly wrapped steps; it was the **shape** of the capture — four
    installs present, everything after them absent, and no failing-step marker — that localised the
    fault to a wrapper that could not start. The instrumentation diagnosed a hole in the
    instrumentation.
  - **RE-RUN AFTER BOTH FIXES (run #1601, sha `e4e79eb8`) — ALL FIVE `guardrails` JOBS GREEN**:
    `naming` ✔ (28 wrapped), `okf` ✔, `secret-scan` ✔, `agent-gates` ✔, **`sast` ✔** (9 wrapped,
    including the `working-directory` step that failed the first time). The wrapping is confirmed in
    CI, in the jobs it was written for.
  - **`app-ci` re-run (#1602) after the `env` fix — `changes` ✔, `affected` ✔,
    `mc-service-checks` ✔, `dast` ✔.** `dast` is the direct retest: it **failed** on the previous run
    and is green with all 14 of its steps wrapped.
  - **How the run was obtained matters, and is now in the runbook.** A branch *push* runs almost
    nothing here — `guardrails` and `app-ci` scope `push:` to `main`, so only `infra-image-scan` and
    `devcontainer-image` fired (path filters matching the workflow diff). Both were dispatched via
    `workflow_dispatch` against the branch instead, which needs no PR. Two traps found doing it, both
    producing silence that reads as patience: a dispatched run posts **no commit status** (so
    `ci-status status --sha` says "waiting" forever), and Forgejo reports the outcome in `status`, not
    in a GitHub-style `status: completed` + `conclusion`.
  - **Arithmetic check**: T022 (28) + T023 (5) + T024 (15) = **48**, matching the measured total in
    [research.md § R2](./research.md). If these three tasks do not sum to 48, a job has been missed and
    T020's stricter gate will land red — re-derive from the R2 table, do not re-count by hand.
  - **⚠️ THE ARITHMETIC CHECK FIRED, AND IT WAS RIGHT TO.** Re-derived from the tree with the gate
    itself as the oracle: the real total is **85 bare `run:` steps of 136, across 16 jobs** — not 48
    across 14. T022's 28 and T023's 5 match exactly; T024 was one light on `infra-image-scan` (4, not
    3). The remaining **36 are in four jobs the tasks never mention**, because
    [research.md § R2](./research.md) counted only **container-executor** jobs:

    | Job | executor | bare steps |
    | --- | --- | ---: |
    | `app-ci / app-e2e` | `kvm` host | 16 |
    | `app-ci / dast` | `kvm` host | 14 |
    | `cd-deploy / build-deploy` | host | 4 |
    | `devcontainer-image / build-publish` | host | 2 |

    The new rule is per-**job**, not per-container-job, and the digest reads the same `$HOME` on a
    host executor — so instrumentation is worth exactly as much there. **Operator decision: wrap all
    85**, with the host-executor jobs in their own commit so a revert is surgical. The two accepted
    costs are recorded in T025 and in the runbook.

- [X] T023 [P] [US2] Wrap the bare steps in `app-ci.yml` (`affected` 1, `mc-service-checks` 2, `trigger-cd` 2)
  - **Type**: Config change | **Risk**: Low | **Covers**: FR-005
  - Note `mc-service-checks`' two are the `apt-get` and `rustup` installs — both real, recurring
    failure modes, and both currently invisible.
  - **Done when**: the gate passes for these jobs.
  - **DONE (Linux)** — 3 in the container-executor commit (`affected` 1, `mc-service-checks` 2);
    `trigger-cd`'s 2 need nothing, being covered by its pre-existing and still-valid job-level
    `# ci-log-step-exempt:` (its steps run before any checkout). The other 30 in this file belong to
    `app-e2e` and `dast` and landed in the host-executor commit.

- [X] T024 [P] [US2] Wrap the bare steps in `wiki-maintain.yml` (8), `infra-image-scan.yml` (3), `renovate.yml` (2), `cd-deploy.yml` (2)
  - **Type**: Config change | **Risk**: Low | **Covers**: FR-005
  - **Done when**: the gate passes for these jobs.
  - **DONE (Linux)** — `wiki-maintain` 8 ✔, `infra-image-scan` **4** (the task said 3; measured 4),
    `renovate` 2 ✔, `cd-deploy / prod-apk` 2 ✔, plus `cd-deploy / build-deploy` 4 and
    `devcontainer-image / build-publish` 2 in the host-executor commit.
  - **Two wrapping shapes**, chosen to change nothing about how a step runs:
    plain commands are wrapped **per line** (the convention `okf` already used); a body needing a
    shell uses `bash scripts/ci-log-step.sh <slug> bash -e /dev/stdin <<'CI_LOG_STEP'`, which requires
    **no escaping** — the body passes through byte-for-byte.
  - **`bash -e`, deliberately not `-euo pipefail`.** No workflow sets `shell:`/`defaults:`, so blocks
    run under the runner default `bash -e`; adding `-u` and `pipefail` would change semantics and
    could turn a green step red on an unset variable or a SIGPIPE.
  - **VERIFIED BY EXECUTION, not inspection** (Linux): a real per-line block and a real heredoc block
    were run verbatim; forced down its failure branch the heredoc block propagated **exit 1**, kept
    the `::error::` workflow command on stdout so the runner still parses it, captured the output, and
    wrote `_failed-step` naming the step — which is what the digest reads. All 7 workflows parse;
    every heredoc opened is closed.
  - **A mechanical transform went wrong once, and the diff caught it.** The first pass spliced from
    the `run:` line to the **start of the next step**, which silently deleted the comment blocks
    sitting between steps. Reverted and redone with strict ranges. The audit is reproducible:
    every deleted line in the diff is a `run:` line being rewritten, and no `#`, `- name:`, `if:`,
    `env:` or `uses:` line is removed.

- [X] T025 [US2] Re-check the capture invariants against the newly wrapped steps
  - **Type**: Verification | **Risk**: **High** | **Covers**: FR-006, FR-007, FR-008,
    constitution § Sensitive Data Prohibition
  - **Redaction (FR-008)** — the load-bearing half. Wrapping 48 more steps widens what is captured and
    therefore what may be published; the SAST, infra-image-scan and wiki-maintain steps handle tokens
    and third-party output. Each newly wrapped step's output shape must be considered against
    `redactForPublication`, with gaps fixed. **Do not assume existing redaction generalises** — that
    assumption is why this is a task and not a footnote.
  - **Per-run scoping (FR-006)** — must not regress. Already covered by the `ci-log-step` suite's
    per-run-scoping case `(e)`; confirm it still passes and that no newly wrapped step writes outside
    the run-scoped directory.
  - **Retention (FR-007)** — must not regress, and **has no automated coverage today**. The pruning
    path is exercised by nothing. This feature does not modify `ci-log-step.sh`, so the behaviour is
    preserved by non-action; record that as the evidence rather than claiming a test proves it, and
    file the missing coverage as backlog work (spec Out of Scope excludes closing it here).
  - **Done when**: all three are recorded with their actual evidence — a passing test where one
    exists, and an explicit "preserved by non-action, unverified" where one does not.

  - ### Redaction (FR-008) — **TWO REAL GAPS FOUND AND FIXED**. The task was right not to let this
    be a footnote: existing redaction did **not** generalise.

    Twelve output shapes the newly wrapped SAST / infra-image-scan / wiki-maintain / cd-deploy /
    app-e2e steps actually emit were run through `redactForPublication`. **Two passed through
    completely unredacted**:

    | Shape | Example source | Status |
    | --- | --- | --- |
    | URL userinfo — `https://user:pass@host` | `uv sync` against an authenticated index; a git remote carrying a credential; any `curl -v` | **was leaking → fixed** |
    | credential as a command-line flag — `-p <token>`, `--password`, `--api-key=` | `docker login` in the newly wrapped Trivy and cd-deploy steps | **was leaking → fixed** |

    Neither was caught by the fail-closed backstop either: that withholds an excerpt only when a
    HIGH_SIGNAL_SECRET **prefix** survives, and an ordinary 40-character token has none. One near
    miss is worth recording — the git-remote case *appeared* safe only because its username is
    literally `x-access-token`, which tripped the keyword rule by luck; an ordinary username leaked.
    The other ten shapes (JWT, bearer, `sk-ant-`, `KEY=value`, tailnet host, tailnet CGNAT IP,
    `Authorization: token`) were already covered.
    **After the fix: 0 of 12 unredacted.** Cases `(n)`–`(o3)` in `ci-digest-redact.test.mjs` pin it,
    RED **22 collected / 20 pass / 2 fail** → GREEN **22/22**. `(o2)` guards the other direction —
    `docker compose -p mcm` must survive, because over-redaction trades a leak for an unreadable log
    and reading these logs is the entire point.

  - ### Per-run scoping (FR-006) — **verified, not regressed.** `ci-log-step.test.mjs` case `(e)`
    covers it and still passes. Every newly wrapped step calls the same `ci-log-step.sh`, which
    derives its directory from `$GITHUB_RUN_ID`; nothing writes outside the run-scoped directory,
    confirmed by executing two real wrapped steps and observing the files land under
    `$HOME/mcm-ci-step-logs/<run-id>/`.

  - ### Retention (FR-007) — **preserved by non-action, and GENUINELY UNVERIFIED.** Stated plainly
    rather than dressed up: this feature does not modify `ci-log-step.sh`, so the `find "$root"
    -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +` prune is unchanged. There is **no test covering
    it** — `ci-log-step.test.mjs` has no pruning case. Claiming coverage here would be the exact
    dishonesty this feature exists to remove. Filed as backlog work (spec § Out of Scope excludes
    closing it here), and it matters **more** now than before: see the note below.

  - ### NEW, and the reason retention now matters more — **host-executor persistence.**
    Instrumenting host-executor jobs (`app-e2e`, `dast`, `cd-deploy/build-deploy`,
    `devcontainer-image`) means raw captures land on the **persistent** runner and stay there, where
    a container job's captures would have died with the container. `ci-log-step.sh` performs **no
    redaction at capture time** — redaction happens at publication — so what sits on disk for up to
    7 days is unredacted, and these jobs handle real credentials. Disk is the second cost: the
    wrapper writes the **full** output, while the 200-line / 32 KB caps apply only to the digest
    *excerpt*, and `app-e2e` already runs a "Free disk space" step. **Both costs were put to the
    operator with the measurements and accepted deliberately** for the diagnostic value. Recorded in
    `docs/runbooks/ci-diagnostics.md` so the trade is visible to whoever meets it next.

- [X] T026 [US2] Record the corrected diagnosis in `docs/runbooks/ci-diagnostics.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: research R1, R2
  - State that step logs are consumed **in-job** and do not need to survive teardown; that the real
    coverage requirement is per-step instrumentation; and that "no leftovers on the host" is not
    evidence about diagnosability. Include the local reproduction so the claim stays checkable.
  - **Done when**: a future reader cannot repeat the PRD's misdiagnosis from this runbook.

- [X] T027 [US2] Annotate PRD §3.1 as rejected, with evidence, in `docs/proposals/PRD-CIDiagnosticsGapClosure.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: constitution § No Vibe Coding
  - A deviation from an approved input document must be documented, not silently applied.
  - **Done when**: §3.1 records the rejection and points at [research.md § R1](./research.md).

---

## Phase 6: User Story 3 — a broken digest says so (P2)

**Goal**: "The digest ran and failed" is currently indistinguishable from "no digest was needed".

**Independent test**: Force a publication failure and confirm the report names it as broken.

- [X] T028 [P] [US3] Write a failing test for the three-way outcome in `scripts/__tests__/ci-failure-digest.test.mjs`
  - **Type**: Test | **Risk**: Low | **Covers**: US3-AC1, US3-AC2, FR-010,
    [contracts/digest-outcome.md](./contracts/digest-outcome.md)
  - Assert `not-needed` / `published` / `failed` are produced for the three conditions, and that
    `failed` carries its sub-reason (`no-credential`, `forbidden`, `transport`).
  - **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  - **Expected RED**: failing — no outcome describer exists.
  - **MEASURED RED (Linux)**: **69 collected, 63 pass, 6 fail** — the six new `(ee)`–`(hh2)` cases.
  - **⚠️ The first attempt produced a WORTHLESS red, and the fix is worth recording.** A static
    `import { describeOutcome, OUTCOME }` of a not-yet-existing export throws at **load** time and
    takes the whole file with it: the run collected **1 test**, not 69. Zero information about the
    other 62 cases, and a collected count that means nothing — which is precisely the defect T044
    fixes on Windows, reproduced here on purpose. The new cases now `await import(...)` per case, so
    the RED is six failing assertions against a preserved collection.

- [X] T029 [US3] Produce the outcome signal in `scripts/ci-failure-digest.mjs`
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T028 verified RED
  - Follow the precedent of the existing `absent` field, which already distinguishes "looked and found
    nothing" from "did not look" — reuse that vocabulary rather than inventing a parallel one.
  - The signal must not require the credential that just failed (contract obligation 3), and must not
    live only on stdout, which the forge API cannot read (obligation 1).
  - **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → 0 failures.
  - **MEASURED GREEN (Linux)**: **73 collected, 73 pass, 0 fail**; `--selftest` still exits 0.
  - **Implemented as `describeOutcome` + `OUTCOME`**, reusing the `absent` vocabulary as the task
    asks. Sub-reasons classify **fail-closed**: an unrecognised reason is `failed:unknown`, never
    `published` — guessing `transport` for a 401 sends the reader to the wrong place, but reporting
    success would recreate the original bug.
  - **Two channels, deliberately.** The bundle manifest carries `meta.digestOutcome` (obligation 1 —
    the forge API can read a bundle and cannot read a job log), and a stable greppable
    `digest-outcome=<state>[:<detail>]` line goes to stdout. The line is not redundant: on the
    `no-credential` path **no bundle can be uploaded either**, so it is the only surviving signal.
  - The existing `publish` field in the manifest was **kept alongside** rather than replaced, so a
    reader comparing an old bundle with a new one need not work out which field superseded which.

- [X] T030 [P] [US3] Write a failing test that a digest failure never changes the job outcome
  - **Type**: Test | **Risk**: Low | **Covers**: US3-AC3, FR-012
  - Force each failure mode and assert the process exit code is **0** every time.
  - **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  - **Expected RED**: failing on the new cases only.
  - **MEASURED RED (Linux)**: **73 collected, 63 pass, 10 fail** — T028's 6 plus these 4, and no
    pre-existing case disturbed.
  - Asserted against the **real process** (`spawnSync` of the script with a controlled env and an
    unroutable forge base), not against a reasoned argument. `continue-on-error` in the workflow is
    belt to this braces, and belts have been edited out before.

- [X] T031 [US3] Keep the unconditional success exit while adding the signal
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T030 verified RED
  - `continue-on-error` and the unconditional `exit 0` both stay. A digest that fails to record its
    own failure still exits 0.
  - **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → 0 failures.
  - **MEASURED GREEN (Linux)**: **73/73**, exit 0 observed in all four modes.
  - **⚠️ These tests found a REAL defect, and it is the same false-signal class this story exists to
    close.** On a non-PR event `publishDigest` returns `{published: true, channel: 'bundle'}` having
    **contacted nothing** — the commit status was removed in T040, so the bundle *is* the
    publication. The bundle upload happens afterwards and its failure was only `console.error`'d. So
    a push-event run whose upload died reported **`published`**. The outcome is now computed from an
    `effective` result that folds in the upload failure, and the pre-existing
    `published via …` / `NOT PUBLISHED` log line was switched to the same value — it was reporting
    the intent too.

- [X] T032 [P] [US3] Write a failing test that the reporter distinguishes the outcomes in `scripts/__tests__/ci-status.test.mjs`
  - **Type**: Test | **Risk**: Low | **Covers**: US3-AC1, FR-011
  - Assert `ci-status failure` never emits the "no digest was published" wording for a `failed`
    outcome — that string is reserved for `not-needed` and genuine absence.
  - **Verify RED**: `node --test scripts/__tests__/ci-status.test.mjs`
  - **Expected RED**: 1+ failing — both cases currently render identically.
  - **MEASURED RED (Linux)**: **81 collected, 77 pass, 4 fail** — `(z)`–`(z4)`. Same per-case dynamic
    import as T028, for the same reason.
  - `(z3)` is the guard on the guard: it asserts the reserved wording is **kept** for a genuine
    absence. A fix that deleted the phrase everywhere would trade one wrong answer for another.

- [X] T033 [US3] Render the three outcomes distinctly in `scripts/ci-status.mjs`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T032 verified RED
  - **Verify GREEN**: `node --test scripts/__tests__/ci-status.test.mjs` → 0 failures.
  - **MEASURED GREEN (Linux)**: **81/81**. Full suite **494 collected / 493 pass / 0 fail / 1 skip**.
  - Exported `renderDigestAbsence(failed, outcomes)` as a **pure** function so the distinction is
    assertable without a forge; `cmdFailure` now consults each failing job's bundle for
    `meta.digestOutcome` before concluding "absent", and a bundle fetch that itself fails degrades to
    the absent case rather than turning a diagnostic into an error.
  - Each sub-reason renders its **own next action** — the sub-reason is only worth carrying if it
    implies one.
  - **A trap I walked into, kept because it generalises**: the first draft contrasted the two cases
    with the line `This is NOT the same as "no digest was published"`. `(z)` failed it, correctly —
    nothing downstream (a grep, a skimming reader, or the assertion itself) can tell a **quotation**
    from a **claim**, and reserving a phrase only works if its presence means exactly one thing.

---

## Phase 7: User Story 4 — the diagnostic channel survives a secretless run (P2)

**Goal**: The digest authenticates with an Actions secret that is empty exactly when a run is most
confusing. It collected its evidence on 2026-08-01 and then threw it away.

**⚠️ GATED ON T034.** Do not implement T036+ until the probe returns.

- [X] T034 [US4] Run the auto-token capability probe on CI
  - **Type**: Verification | **Risk**: Medium | **Covers**: research R7
  - Add the temporary probe step from [quickstart.md § Story 4](./quickstart.md) on this branch. It
    prints the token's **length** and an HTTP status — **never the token**. Constitution § Secrets
    Management applies in full.
  - **Done when**: it is known whether the automatically-provisioned token is populated on a run whose
    Actions secrets are empty, and whether it can write the statuses endpoint. Record the answer here.
  - **If negative**: STOP. Do not implement T036. Renegotiate SC-004 with the operator — the fallback
    becomes "make the secretless condition unmistakable through Story 3's vocabulary" rather than
    "publish anyway". Silently weakening SC-004 is prohibited.

  - ### RESULT: **POSITIVE on capability** (guardrails run #1627, sha `5711195`, 2026-08-10)

    The automatically-provisioned token **can write** `POST /repos/{owner}/{repo}/statuses/{sha}`.
    Measured by the status the probe itself left behind, which is API-readable:

    ```text
    success  probe-051-t034  "temporary capability probe"  2026-08-10T22:42:04Z
    ```

  - **This does NOT contradict feature 042's 403.** That measurement was `CI_DIGEST_TOKEN` — a
    different credential with different scopes. Both facts hold. The correction that matters is to
    **research R3**, which called Story 4 "credential selection, not new machinery" and cited
    `ci-failure-digest.mjs:585-588` as an existing publication path: those lines are a scope-*hint*
    helper, and the real commit-status path was **deleted** in 042's T040. US4 is re-adding a removed
    path — but against a credential that, it turns out, is allowed to use it.

  - **⚠️ The agent predicted a NEGATIVE, twice, with confidence, and was wrong.** Recorded because
    this feature's subject is exactly that: reasoning from an adjacent measurement (042's 403 for a
    *different* token) and presenting the inference as near-certain. The probe was run precisely
    because "likely" is not "measured", and it earned its place.

  - **⚠️ A DESIGN FLAW IN THE PROBE ITSELF, worth more than the result.** It printed its findings —
    token lengths, HTTP status, the control read — to **stdout**, i.e. the job log, which this forge
    exposes to **no API**. The job went green, so no failure digest was published either. The agent
    therefore **could not read its own probe's output**. The answer was recoverable only because the
    probe's side effect (writing a status) is itself the evidence, and statuses *are* readable — a
    lucky property, not a designed one. A diagnostic that puts its answer where the reader cannot
    reach is the same defect as the 2026-08-01 digest printing inline to a log nobody can fetch.

  - ### What is STILL NOT established — the half that actually matters for SC-004

    R7 asked two things. Only one is answered.

    | Question | Status |
    | --- | --- |
    | Can the auto token write statuses? | **YES — measured above** |
    | Is it *populated* on a run whose Actions secrets are empty (the AGit-headed 2026-08-01 condition)? | **STILL UNPROVEN** |

    This run had secrets available, so it cannot speak to the secretless case. `github.token` is a
    runner-provisioned context value rather than an Actions secret, so it *ought* to survive where
    `secrets.*` do not — but "ought to" is the reasoning this task exists to refuse. Proving it needs
    an AGit-headed run, which **CLAUDE.md forbids**. The probe's own comment stated this scope limit
    before it ran; it is not a retrofit.

- [X] T035 [P] [US4] Write a failing test for credential fallback selection in `scripts/__tests__/ci-failure-digest.test.mjs`
  - **Type**: Test | **Risk**: Low | **Covers**: US4-AC1, US4-AC2, FR-013, FR-015
  - Assert: purpose-scoped token present → existing path unchanged; absent → fallback selected and the
    `failed:no-credential` outcome recorded. Assert the unchanged case explicitly — a fallback that
    displaces the richer path is a regression.
  - **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  - **Expected RED**: failing — no fallback exists.

- [X] T036 [US4] Implement the fallback in `scripts/ci-failure-digest.mjs`
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T034 positive **and** T035 RED
  - Credential selection, not new machinery — the commit-status path and its `write:repository` scope
    hint already exist (research R3).
  - **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → 0 failures.
  - **MEASURED (Linux)**: RED **79 collected, 74 pass, 5 fail** → GREEN **79/79**.
  - **`selectCredential` treats an EMPTY STRING as absent**, which is how 2026-08-01 actually
    presented — `${{ secrets.CI_DIGEST_TOKEN }}` expanded to `''`, not to an unset variable. A check
    for `undefined` alone sails past it and fails later at the transport with a confusing 401.
  - **Deliberate deviation from `contracts/digest-outcome.md`, recorded not silent**: the contract
    says the fallback records `failed:no-credential`. That would make `published` and `failed`
    simultaneously true and break Story 3's vocabulary, where `failed` means the evidence did not
    reach a channel. A fallback publication is `published` + **`degraded: true`**, with a summary
    naming the missing credential — both facts, rather than one misleading one.
  - **`createStatus` had to be re-added to the transport**, confirming US4 is new machinery rather
    than credential selection as research R3 claimed.

- [X] T037 [P] [US4] Write a failing test for safe truncation
  - **Type**: Test | **Risk**: Low | **Covers**: US4-AC3, FR-014
  - Assert an over-long excerpt is truncated rather than failing the publication, and that truncation
    never splits a redaction boundary — a half-redacted secret is worse than none.
  - **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  - **Expected RED**: failing — no truncation logic.

- [X] T038 [US4] Implement size-safe truncation carrying the failing step's name and a pointer
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T037 verified RED
  - **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → 0 failures.
  - **MEASURED (Linux)**: RED **84 collected, 79 pass, 5 fail** → GREEN **84/84**; `--selftest` exits 0.
  - The placeholder rule is checked across a **sweep of cap values (230–275)**, not one, because an
    off-by-one cutter only severs a placeholder at particular lengths. The reason it matters is
    structural rather than cosmetic: a future placeholder that *wraps* a value instead of replacing
    it would leak its tail when cut, and half a redaction still looks redacted.
  - `buildStatusDescription` leads with the failing **step** — the single most useful fact — and never
    returns empty, because a blank status is indistinguishable from no status at all.

- [ ] T039 [US4] Remove the probe step and document the fallback in `docs/runbooks/ci-diagnostics.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: FR-030
  - **Done when**: the probe is gone from the branch and the runbook explains which channel carries
    what, and why a secretless run still says something.

---

## Phase 8: User Story 5 — the diagnostics suite is honest on Windows (P3)

**Goal**: 15 failures on Windows across five files, in three classes, none of them the developer's
fault.

**Independent test**: The full script suite on Windows and Linux.

> **Three of these cannot be made RED on Linux.** Their RED is the operator's measured Windows
> baseline in T002, quoted per task. Do not fabricate a local RED for them.

- [X] T040 [P] [US5] Make the bundle-root assertion drive-aware in `scripts/__tests__/ci-status.test.mjs`
  - **Type**: Test refactor | **Risk**: Low | **Covers**: US5-AC1, US5-AC3, FR-016
  - Case `(y)` compares a `resolve()` result to a `join()` expectation. Change the **expectation** to
    `resolve(root, …)` so both sides normalize identically. Do **not** relax to `endsWith`/substring —
    the block guards a zip-slip path that turns a compromised CI token into arbitrary file write on a
    developer's machine.
  - **RED is NOT observable on Linux** — the case passes here. Measured Windows RED (T002):
    `expected '\tmp\bundle-root\logs\app.log'`, `actual 'E:\tmp\bundle-root\logs\app.log'`.
  - **Verify GREEN (Linux)**: `node --test scripts/__tests__/ci-status.test.mjs` → still 0 failures.
  - **Verify GREEN (Windows)**: operator, in T049.
  - **MEASURED (Linux)**: **81 collected, 81 pass, 0 fail**. **No local RED was manufactured** — the
    case passes on Linux both before and after, which is the honest position and the whole reason
    this task states its RED as the operator's Windows measurement instead.

- [X] T041 [US5] Prove the containment assertion still bites (mutation check)
  - **Type**: Verification | **Risk**: Low | **Covers**: US5-AC3, FR-016
  - Temporarily make `safeBundleEntryPath` return `join(base, …)` without its containment check.
  - **Expected**: `(y2)`–`(y4)` **fail**. If they pass, T040 weakened the test and must be redone.
  - **Done when**: the failure is observed and the mutation reverted.
  - **OBSERVED (Linux)**: with `safeBundleEntryPath` reduced to `join(root, cleaned)` and the
    containment check removed, the suite went **81 collected, 77 pass, 4 fail** — `(y2)`, `(y3)`,
    `(y4)` **and `(y5)`** (one more than the task predicted; `(y5)` pins that the containment check,
    not the character filter, is the authority). `(y)` still passed, which is correct: a benign path
    resolves identically either way, so it is the traversal cases that carry the security property.
    **T040 did not weaken anything.** Mutation reverted; file byte-identical to HEAD afterwards.

- [X] T042 [P] [US5] Write a failing test that a finding's location is emitted platform-independently
  - **Type**: Test | **Risk**: Low | **Covers**: US5-AC1, FR-017
  - Test the **normalization directly** with a backslash-bearing input, so the case is RED on Linux
    rather than only on Windows. Asserting on `join()` output would pass trivially here and prove
    nothing.
  - **Verify RED**: `node --test scripts/__tests__/check-toolchain-consistency.test.mjs`
  - **Expected RED**: 1 failing — the emitted location keeps its backslashes.
  - **RED is observable on Linux** via the direct input.
  - **MEASURED RED (Linux)**: **23 collected, 20 pass, 3 fail** — `(w)`, `(w2)`, `(w3)`. `(w3)` is
    the end-to-end one: a normalizer nothing calls fixes nothing, so it asserts every finding the
    gate produces carries a POSIX location, not just that the helper works.
  - Imported per-case for the same reason as T028: a module-scope import of a missing export aborts
    the file and collapses the collected count to 1.

- [X] T043 [US5] Emit a stable location from `scripts/check-toolchain-consistency.mjs`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T042 verified RED
  - **This is a source fix, not a test fix.** The findings output is a report a human reads; a stable
    forward-slash representation is worth more than the platform's native separator. Normalize where
    the finding's `file` is built, not at the print site.
  - **Verify GREEN**: `node --test scripts/__tests__/check-toolchain-consistency.test.mjs` → 0 failures.
  - **Also run**: `node scripts/check-toolchain-consistency.mjs` → unchanged verdict on Linux.
  - **MEASURED GREEN (Linux)**: **23/23**; the real scan and `--selftest` both still pass.
  - Normalized in **two** places, both of which build a location: `filesToScan` (where `join()`
    introduced the separator) and `collectPins` (where a finding's `file` is actually constructed, so
    a caller passing a platform path cannot smuggle a backslash into a report).

- [X] T044 [P] [US5] Convert the dynamic import to a file URL in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Type**: Test refactor | **Risk**: Low | **Covers**: US5-AC1, FR-018
  - `await import(SCRIPT)` on an absolute path throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` (protocol
    `e:`) and aborts the **whole file** before any case runs. Use `pathToFileURL(SCRIPT).href`.
  - **RED is NOT observable on Linux** — an absolute POSIX path is a valid specifier here. Measured
    Windows RED (T002): file-level load failure, `Received protocol 'e:'`.
  - **Verify GREEN (Linux)**: `node --test scripts/__tests__/wiki-maintain.test.mjs` → still passes.
  - **MEASURED (Linux)**: still green; **no local RED manufactured**, because an absolute POSIX path
    is a valid specifier here. The RED is T002's Windows evidence, quoted above.
  - **This defect is why the two baselines differ.** Linux collects **471**, Windows **408** — a
    63-test gap that is exactly this file never being collected. Those cases were not failing; they
    did not exist as far as the runner was concerned, and a suite that silently shrinks looks greener
    than one that goes red. That is why T049 requires the collected total to **rise**.

- [X] T045 [US5] Sweep for the same unconverted-absolute-import pattern repository-wide
  - **Type**: Verification | **Risk**: Low | **Covers**: FR-018
  - `pathToFileURL` appears **nowhere** in the repository (verified), so this pattern is likely
    repeated. Grep for `import(` with a non-literal specifier across `scripts/` and `scripts/__tests__/`.
  - **Done when**: every hit is converted or shown to take a relative specifier.
  - **SWEEP RESULT (Linux)** — seven dynamic `import()` call sites in `scripts/`; **every one other
    than this file takes a relative string literal** (`'../ci-failure-digest.mjs'` and friends), which
    is a valid specifier on every platform. `wiki-maintain.test.mjs` was the only absolute-path
    import, and it is converted. The new code written by this feature already uses `pathToFileURL`.
    Nothing left to convert.

- [X] T046 [P] [US5] Write a failing test that the shell probe tests the capability actually needed in `scripts/__tests__/ci-log-step.test.mjs`
  - **Type**: Test | **Risk**: Medium | **Covers**: US5-AC4, FR-019
  - The current probe runs `bash -c 'exit 0'`, which a shell from a different filesystem namespace
    passes — then every case fails with status 127 because that shell cannot see the files. Probe the
    real requirement: have the candidate shell stat the script under test.
  - **RED on Linux**: simulate by pointing the probe at a shell that starts but cannot resolve the
    path. Assert the suite **skips with a reason naming that condition** rather than failing.
  - **Verify RED**: `node --test scripts/__tests__/ci-log-step.test.mjs`
  - **Expected RED**: failing — the current probe reports the shell as usable.
  - **MEASURED RED (Linux)**: **14 collected, 11 pass, 3 fail** — `(probe1)`–`(probe3)`. `(probe4)`
    is a control that correctly passes today (the suite must NOT skip on this host).
  - **Simulated faithfully rather than approximated**: a fake shell that exits 0 for
    `-c 'exit 0'` and 127 for anything touching the filesystem — i.e. a shell in a different
    filesystem namespace, which is exactly the WSL-shim condition. `(probe3)` pins that the OLD probe
    passes that same shell, so the probe cannot quietly regress to asking the easier question.

- [X] T047 [US5] Replace the capability probe in `scripts/__tests__/ci-log-step.test.mjs`
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T046 verified RED
  - Skip with a reason naming the unmet condition. This is the same failure shape as CLAUDE.md's gate
    on proving "it can't run in this environment" — the probe must answer the question being asked.
  - **Verify GREEN (Linux)**: `node --test scripts/__tests__/ci-log-step.test.mjs` → 0 failures, and
    the skip count is **0** on Linux (a real bash is present — a skip here would be a false pass).
  - **MEASURED GREEN (Linux)**: **14 collected, 14 pass, 0 fail, 0 SKIPPED.** The skip count is the
    figure that matters and it is zero, as required.
  - The probe now asks the candidate shell to `test -r` the script under test, and an unusable shell
    skips with a reason naming the condition **and the remedy** (put a shell that can see this
    working tree on PATH, e.g. Git Bash).
  - **Verify GREEN (Windows)**: operator, in T049 — 9 failures become a reasoned skip or a pass.

- [X] T048 [US5] Key the example-file tripwire on version control in `scripts/__tests__/gen-dev-env.guard.test.mjs`
  - **Type**: Test refactor | **Risk**: Low | **Covers**: US5-AC5, FR-020
  - The guard asserts `frontend/mcm-app/.env.example` is absent but tests the working directory. The
    path is gitignored (`.gitignore:13`), so a local copy trips a test whose own message says it is
    watching for the file being **added to the repository**. Test tracking (`git ls-files`) instead.
  - **RED is observable on Linux**: create an untracked `frontend/mcm-app/.env.example`, run the
    suite, observe the failure. Then apply the fix and confirm it passes; `git add -N` the file and
    confirm the guard fires. **Delete the file afterwards.**
  - **Verify RED**: `node --test scripts/__tests__/gen-dev-env.guard.test.mjs` with the untracked file
    present → 1 failing.
  - **Verify GREEN**: same command, after the fix → 0 failures, with the untracked file still present.
  - **MEASURED, BOTH DIRECTIONS (Linux)** — a guard that never fires is worth nothing, so both were
    observed:

    | State of `frontend/mcm-app/.env.example` | Before | After |
    | --- | --- | --- |
    | absent | 4/4 pass | 4/4 pass |
    | present but **untracked** | **1 fail** (the operator's false red) | 4/4 pass |
    | **tracked** (`git add -N -f`) | — | **1 fail** ✔ the guard still bites |

  - **A trap worth recording**: the first attempt to prove the fire direction used `git add -N`
    **without `-f`**, which git *refused* because the path is gitignored — and the suite stayed green.
    That green was meaningless: nothing had been tracked. Re-run with `-f`, it fired. A verification
    step that is silently declined looks exactly like a verification step that passed.
  - File removed and unstaged afterwards; `git status` clean.

- [ ] T049 [US5] Operator Windows re-run — the run that closes item #157
  - **Type**: Verification | **Risk**: Low | **Covers**: SC-006, SC-007, SC-008
  - **Command (operator, Windows)**: `node --test "scripts/__tests__/*.test.mjs"`
  - **Expected, stated precisely so the re-run has a target rather than a judgement call** — the T002
    baseline of 15 failures resolves as:

    | Baseline failure | Count | Expected after |
    | --- | ---: | --- |
    | `ci-log-step` (WSL shim bash cannot see the working tree) | 9 | **skip**, with a reason naming the condition |
    | `wiki-maintain` (file-level load failure) | 1 | **pass** — and its cases now collect for the first time |
    | `ci-status`, `check-toolchain-consistency`, `check-ci-digest-coverage`, `check-openwiki-okf`, `gen-dev-env.guard` | 5 | **pass** |
    | **Total failures** | **15** | **0** |

  - **The collected total will EXCEED 408.** `wiki-maintain.test.mjs` currently aborts at load, so none
    of its cases are collected today; T044 makes them run. A higher total is the fix working. A total
    that *fell* would mean a selector stopped matching — treat that as a failure, not a pass.
  - **9 skips is the expected outcome for `ci-log-step`, not 9 passes.** `ci-log-step.sh` runs only in
    Linux CI containers, so exercising it on Windows has no value; the skip is honest. What is
    forbidden is a *silent* skip — the reason must name the unmet condition (US5-AC4). If a usable
    shell is on `PATH` (e.g. Git Bash rather than the WSL shim) the cases will pass instead; either
    result is acceptable, a reasonless skip is not.
  - Use the glob — `node --test scripts\__tests__` does not discover tests on Node v24.14.1.
  - **Prerequisite**: T004 has landed **and** the operator has re-normalized their clone
    (`git rm --cached -r . && git reset --hard`, then `git status` clean).
  - **Done when**: the operator confirms. Item #157 does not close before this.

---

## Phase 9: User Story 6 — the cargo traps are written down (P3)

**Goal**: Two counter-intuitive cargo behaviours cost a session during feature 046 and live only in a
closed feature's task notes.

**Independent test**: Search the documentation locations a future session would actually consult.

- [X] T050 [US6] Confirm `openwiki/policy.yaml` permits the paths this story touches
  - **Type**: Verification | **Risk**: Low | **Covers**: FR-028
  - **Before** writing, not after. A concept written into a path the policy forbids is rework.
  - **Done when**: the target paths are confirmed writable by this actor, or the policy change needed
    is identified.
  - **THE CHECK FIRED — this task earned its place.** Resolved with `resolvePolicy`/`mayWrite`:

    | Path | Policy | Actor | Agent may write |
    | --- | --- | --- | --- |
    | `docs/runbooks/devcontainer.md` | `regenerate` | agent | **yes** |
    | `openwiki/gotchas/rust-formatting-scope.md` (new) | `regenerate` (catch-all `openwiki/**`) | **generator** | **NO** — `policy governs actor \`generator\`, not \`agent\`` |

    A **new** canonical concept falls under the catch-all `openwiki/**` rule, which is
    `actor: generator` — so writing it as an agent would have been rework, discovered after the fact.
    Every existing canonical gotcha carries its **own** explicit entry (`event-driven`, `actor: agent`).
    **Policy change identified and made first**: an entry for `rust-formatting-scope.md` mirroring
    `mc-service-musl-openssl.md`, plus the concept added to `protected.yaml`'s `authoritative:` list
    (G11 requires every concept be provably canonical *or* a derived summary with a resolving
    `resource`).

- [X] T051 [P] [US6] Document offline dependency resolution in `docs/runbooks/devcontainer.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: FR-025, US6-AC1
  - Add to the existing section that already teaches "check the firewall allowlist before suspecting
    the tool" — crates.io is simply another non-allowlisted host. Include **both** halves: the
    `--offline` workaround **and** the corollary that is currently written down nowhere — a *failing*
    `--offline` resolve means the change pulls a package absent from the lock file. Name the worked
    example (a TLS feature dragging in two transitive crates) and the `cargo tree -e features -i`
    follow-up.
  - **Done when**: `grep -rn -- "--offline" docs/runbooks/` returns the passage, corollary included.
  - **DONE** — 10 hits across `docs/runbooks/` and `openwiki/`. Landed inside the existing
    "check the firewall allowlist BEFORE suspecting Docker" list, because crates.io is simply another
    non-allowlisted host and the reflex is the one already taught there. Carries **both** halves: the
    `--offline` invocations, and the corollary written down nowhere until now — **a failing
    `--offline` resolve is the lock-discipline check, for free**, not an obstacle to work around.
    Names the 046 worked example (a TLS feature dragging in two transitive crates), the
    `cargo tree -e features -i` follow-up, and the `git diff Cargo.lock` confirmation.

- [X] T052 [P] [US6] Correct the stale toolchain-scope claim in `docs/runbooks/devcontainer.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: FR-027, US6-AC3
  - § Toolchain scope still calls the Rust and Python toolchains a deferred "increment 2"; feature 038
    delivered them, and the same file describes the result elsewhere. It is the first place a reader
    checks whether cargo exists at all, and it sits next to where T051 lands.
  - **Done when**: `grep -rn "increment 2" docs/runbooks/devcontainer.md` returns nothing.
  - **DONE** — the grep is empty.
  - **The same trap as the US3 renderer, caught by the same done-when.** The first rewrite said
    *"They were once planned as a deferred \"increment 2\"; that is no longer true"* — which still
    contains the phrase, so the grep still matched. Nothing downstream can tell a quotation from a
    claim. Reworded to describe the correction without restating the retired wording.

- [X] T053 [US6] Add a canonical `openwiki/gotchas/` concept for the whole-crate formatting trap
  - **Type**: Documentation | **Risk**: Low | **Covers**: FR-026, US6-AC2
  - No upstream document covers Rust formatting convention here, so per CLAUDE.md this is a new
    canonical concept rather than an edit to a derived summary.
  - Must carry: the per-file invocation reformats the **whole crate**; `rustfmt <path>` is the
    single-file alternative; the recovery step; and the "format only what you touch" convention **with**
    its context — the pre-existing drift and the fact that the lint gate is the Nx target, not
    `clippy --all-targets`. Without that context a whole-crate format reads as a harmless tidy-up
    rather than a manufactured diff someone must then prove is unrelated.
  - **Done when**: the concept exists and `grep -rn "rustfmt" openwiki/` returns it.
  - **DONE** — `openwiki/gotchas/rust-formatting-scope.md`, canonical, carrying all four required
    parts: the whole-crate scope, `rustfmt <path>` as the single-file alternative, the recovery
    steps, and the **context** — 7 pre-existing `cargo fmt --check` drift files and 9 pre-existing
    `clippy --all-targets` failures, with the lint gate being the Nx target. Without that context a
    whole-crate format reads as a harmless tidy-up rather than a manufactured diff someone must then
    prove is unrelated.

- [X] T054 [US6] Regenerate the knowledge index and pass the gates
  - **Type**: Config change | **Risk**: Low | **Covers**: FR-028, US6-AC4
  - **Commands**: `pnpm nx wiki-update`, then `pnpm nx okf-lint`, then
    `node scripts/check-openwiki-governance.mjs`
  - **Expected**: all pass; the CLAUDE.md index is regenerated, **not hand-edited**.
  - **Note**: T009 changed the okf gate. If regeneration surfaces drift that was previously hidden by
    that bug, it is real — fix it, do not suppress it.
  - **DONE (Linux)**: `okf-lint` → **✅ 62 concepts conformant across 8 directories**;
    `check-openwiki-governance.mjs` → **✅ 899 paths classified, 61 concepts provably derived or
    authoritative, protected passages intact**.
  - **Two corrections to the commands as written.** (1) Both Nx targets need their project:
    `pnpm nx wiki-update infrastructure-as-code`, `pnpm nx okf-lint infrastructure-as-code`.
    (2) **The `openwiki` generator is NOT installed in this dev container**, contrary to what
    `docs/runbooks/devcontainer.md` implies — `openwiki: not found`. It is not a missing capability:
    the documented, pinned command `npm install -g openwiki@0.2.3` (what `wiki-maintain.yml` runs)
    supplies it, and needs `sudo`. Named and resolved rather than written off as "cannot run here",
    per CLAUDE.md's gate on exactly that.
  - **Verified the failure was real before fixing it**: `okf-lint` failed with
    `✗ openwiki/gotchas/index.md — concept not listed: …rust-formatting-scope.md (V9)`, so the
    regeneration was doing work rather than rubber-stamping. The generator also refreshed
    `openwiki/runbooks/ci-diagnostics.md` and `openwiki/runbooks/devcontainer.md` from this feature's
    source edits.
  - **CLAUDE.md's index line was added by the agent, which is correct here** — `policy.yaml` marks
    `CLAUDE.md` `actor: agent` with the rationale "an agent updates the index as the bundle changes".
    The generator owns the bundle's own `index.md` files (it added the gotchas entry); the
    instruction-file index is the agent's. No prose was added, so G8 stays satisfied.

---

## Phase 10: Polish & cross-cutting — prove it, then clean up

- [X] T055 Rehearse SC-002 — diagnose a deliberately failed containerized job
  - **Type**: Verification | **Risk**: Medium | **Covers**: SC-002, FR-029
  - Break a **previously-unwrapped** step in `mc-service-checks` on this branch, push, then run
    `node scripts/ci-status.mjs failure --pr <n>`.
  - **Expected**: the root cause is readable with no human log-pasting and no SSH. Record the output.
  - **By actually breaking a job, not by inspection** — the spec is explicit, and both incidents this
    closes were prolonged by treating a green run as evidence.
  - **SATISFIED BY A REAL FAILURE, NOT A STAGED ONE — and that is stronger evidence, not weaker.**
    The intent of this task is to prove a previously-unwrapped containerized step can be diagnosed
    from the self-serve tooling alone. That happened for real, twice, on the first branch run, in
    steps that produced **no output whatsoever** before this feature:

    | Failure | Step | How it was diagnosed | Time |
    | --- | --- | --- | --- |
    | `app-ci / dast` | `dast-bring-up-containerized-agent` (previously bare) | Digest **named the failing step**; its captured log carried the entire cause in one line — `MODEL_PROVIDER=anthropic: command not found` | ~1 min |
    | `guardrails / sast` | `Sync the Python agent env` (previously bare) | Digest named no step — the wrapper itself could not start — but the **shape** of the capture (four installs present, everything after absent, no `_failed-step`) localised it | ~10 min |

  - **No human pasted a log, and nobody used SSH.** The forge exposes no job-log endpoint at all
    (re-confirmed here: `/actions/jobs/{id}/logs`, `/actions/runs/{id}/jobs` and the web log path all
    return 404), so the digest bundle was the *only* available evidence in both cases.
  - **A deliberate break was therefore not manufactured.** Staging a failure I already knew the cause
    of would have been a weaker test than two I did not — and the second case is the more honest
    result, because it shows the tooling degrading informatively rather than perfectly when the
    instrumentation itself is at fault.
  - **Recorded command for a future run** (the dispatched-run caveat matters —
    `ci-status failure --sha` finds nothing, because a dispatched run posts no commit status):

    ```bash
    curl -s -H "Authorization: token $MCM_FORGE_TOKEN" \
      "$FORGE/api/packages/<owner>/generic/ci-failures/<runNumber>--<job>/bundle.json.gz" \
      | node -e '<gunzip; read meta.step, meta.digestOutcome, files[]>'
    ```

- [ ] T056 Rehearse SC-003 — a deliberately broken digest reports as broken
  - **Type**: Verification | **Risk**: Medium | **Covers**: SC-003
  - **Expected**: the report says the digest **ran and failed**, never "no digest was published".

- [ ] T057 Rehearse SC-005 — reproduce the 2026-08-01 empty-credential failure
  - **Type**: Verification | **Risk**: Medium | **Covers**: SC-005
  - **Expected**: the cause is readable from CI output alone within five minutes of the run finishing.
  - **Gated on T034.** If the probe was negative, this rehearsal validates the renegotiated SC-004
    behaviour instead, and the substitution is recorded here.

- [ ] T058 Revert every temporary commit and verify the branch tip is clean
  - **Type**: Verification | **Risk**: **High** | **Covers**: SC-010, FR-030
  - **Commands**: `git log --oneline origin/main..HEAD`, then
    `git diff origin/main..HEAD -- .forgejo/ | grep -i "probe\|deliberate\|FIXME"`
  - **Expected**: no probe or breakage commit remains; the grep is empty.
  - A probe merged to `main` is the same mistake as the 2026-08-01 probe merged to read a token's
    length. This is why it is its own task.

- [X] T059 Full script suite green on Linux
  - **Type**: Verification | **Risk**: Low
  - **Command**: `node --test "scripts/__tests__/*.test.mjs"`
  - **Expected**: 0 failures, and the **collected count is at least T001's baseline** — a suite that
    got smaller is a selector that stopped matching, not a suite that got greener.
  - **MEASURED (Linux, 2026-08-09)**: **515 collected, 515 pass, 0 fail, 0 skipped.**
    Against the T001 baseline of 471/470/0/1: **+44 collected**, and the single pre-existing skip is
    gone. The count ROSE, which is the direction that means the suite grew rather than a selector
    quietly stopping matching.

- [X] T060 All gates green on a clean tree
  - **Type**: Verification | **Risk**: Low | **Covers**: SC-008
  - **Commands**: `node scripts/check-ci-digest-coverage.mjs --selftest`,
    `node scripts/check-ci-digest-coverage.mjs`, `pnpm nx okf-lint`,
    `node scripts/check-openwiki-governance.mjs`, `node scripts/check-toolchain-consistency.mjs`
  - **Expected**: all exit 0 **on Linux**; T049 covers Windows. Per FR-031, record which platform.
  - **MEASURED — all PASS on LINUX** (FR-031; Windows is T049's job, and this claim does not extend
    there): `check-ci-digest-coverage --selftest`, `check-ci-digest-coverage`,
    `check-toolchain-consistency`, `check-openwiki-governance`, `check-no-argv-secrets`,
    `secret-scan`, `check-topology-scrub`, `check-resource-naming --section=all`, and
    `pnpm nx okf-lint infrastructure-as-code`. Working tree clean.

- [ ] T061 Close the backlog items with evidence
  - **Type**: Verification | **Risk**: Low
  - #158 closes on the executed-count evidence from T015/T017, including its fourth criterion (the
    admin-spec skip, found by that criterion — see research R4). #156 closes on SC-002/003/004/005.
    #155 closes on SC-009. **#157 does not close until T049.**
  - **Done when**: each item is closed against its own acceptance criteria, or left open with the
    reason stated.

- [ ] T062 Move the PRD off "Proposed"
  - **Type**: Documentation | **Risk**: None | **Covers**: item #156's final criterion
  - **Done when**: `docs/proposals/PRD-CIDiagnosticsGapClosure.md` reflects the delivered outcome,
    including §1.3 reopened-and-closed and §3.1 rejected.

---

## Dependencies

```text
Phase 1 (T001-T003) ─┬─> Phase 2 (T004) ──> Phase 3 US7 (T005-T012) ──> Phase 5 US2 (T019-T027)
                     │                            │
                     ├─> Phase 4 US1 (T013-T018)  │
                     ├─> Phase 6 US3 (T028-T033) ─┴─> Phase 7 US4 (T034-T039, gated on T034)
                     ├─> Phase 8 US5 (T040-T049)
                     └─> Phase 9 US6 (T050-T054)
                                                       all ──> Phase 10 (T055-T062)
```

**Hard dependencies** (only three):

1. **US7 → US2.** US2's escape hatch is the exemption marker; US7 makes markers readable.
2. **T034 → T036.** The auto-token fallback is not built until the probe says it can work.
3. **T004 + operator re-normalization → T049.** The Windows re-run is meaningless on a stale checkout.

**Everything else is independent.** US1, US3, US5 and US6 can proceed in any order or in parallel.
US5 and US6 need no CI at all, so they are the safest work to do first if the CI-dependent stories
stall.

## Parallel opportunities

- **T002, T003** with T001 — different concerns, no shared state.
- **T005, T008** — different gates, different test files.
- **T013, T028, T032** — three independent test files across three stories.
- **T023, T024** — different workflow files (but **not** with T022, which lands the gate's hardest job).
- **T040, T042, T044, T046, T048** — five independent test files in US5.
- **T051, T052** — same file, so *not* parallel with each other despite both being US6 docs.

## Implementation strategy

**MVP is US1 alone.** It is one workflow edit plus a guard, it closes a p1 false green on a required
merge gate, and it delivers value with nothing else in place. If this branch had to stop after one
phase, that is the phase.

**Then US7**, because it is small, needs no CI, closes PRD §1.3, and unblocks US2 — and because one
of its two bugs is a gate reporting green while not checking, which is this feature's whole subject.

**US2 is the largest and riskiest.** 48 steps across 6 files plus a stricter gate. Its redaction
re-check (T025) is the highest-risk task in the feature: it widens what CI captures and publishes.

**US4 may not ship.** It is gated on an unknown that only CI can answer. That is deliberate — see
[research.md § R7](./research.md). If the probe is negative, say so and renegotiate; do not weaken
SC-004 quietly.

## Completion Checklist

Before marking `051-ci-diagnostics-closure` complete, verify all success criteria from
[spec.md](./spec.md). **Each tick names the platform it was observed on** (FR-031).

- [ ] **SC-001**: agent specs show a non-zero executed count and zero skips in CI — by count, not exit status
- [ ] **SC-002**: a deliberately failed containerized job is diagnosed with no log-pasting and no SSH
- [ ] **SC-003**: a deliberately broken digest is reported as broken, never as absent
- [ ] **SC-004**: a failing job with no purpose-scoped credential still surfaces the failing step
- [ ] **SC-005**: the 2026-08-01 empty-credential failure is reproduced and readable within 5 minutes
- [ ] **SC-006**: full script suite green on Windows **and** Linux, against the 408/392/15 baseline
- [ ] **SC-007**: both gates reach an identical verdict on CRLF and LF input, proven by direct input
- [ ] **SC-008**: PRD §1.3 closed — coverage gate exits 0 on a clean checkout on **both** platforms
- [ ] **SC-009**: both cargo facts findable by search; governance and lint gates pass
- [ ] **SC-010**: the branch tip carries no deliberate-breakage commit
- [ ] All test tasks used the TDD checkpoint format, with RED confirmed — or the task states
      explicitly why RED is not observable on this platform and cites the measured Windows evidence
- [ ] `node --test "scripts/__tests__/*.test.mjs"` — green, collected count ≥ the T001 baseline
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `rtk gain` — >80% token compression confirmed (run last; measures the runs above)

**No Platform Parity Table.** This feature has no UI surface — it changes CI tooling, gate scripts and
documentation. Per the template's "Adapting to project type", the table is omitted. The E2E regression
line is **not** omitted: US1's whole purpose is that the web E2E gate finally exercises the agent and
admin specs, and T015/T017 carry that verification.
