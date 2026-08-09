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

- [ ] T001 Capture the Linux baseline of the script suite and record it in this file
  - **Type**: Verification | **Risk**: None
  - **Command**: `node --test "scripts/__tests__/*.test.mjs"`
  - **Expected**: green on Linux. Record the exact test/pass/fail counts here — the Windows target in
    SC-006 is judged against the delta from this, not against zero-in-the-abstract.
  - **Done when**: counts are written into this task.

- [ ] T002 [P] Record the Windows baseline supplied by the operator
  - **Type**: Verification | **Risk**: None
  - **Measured 2026-08-09, Node v24.14.1, `node --test "scripts/__tests__/*.test.mjs"`**:
    408 tests, 392 pass, **15 fail**, 1 skipped, exit 1, across five files —
    `ci-log-step` (9), `wiki-maintain` (file-level load failure), `ci-status` (1),
    `check-toolchain-consistency` (1), `check-ci-digest-coverage` (1), `check-openwiki-okf` (1),
    `gen-dev-env.guard` (1).
  - **Done when**: this baseline is the reference SC-006 is measured against. Do **not** re-derive it
    locally — it is not reproducible on Linux, which is the point.

- [ ] T003 [P] Confirm both line-ending defects still reproduce on Linux before fixing them
  - **Type**: Verification | **Risk**: None | **Covers**: research R8a, R8b
  - **Command**: the two reproductions in [quickstart.md § Story 7](./quickstart.md)
  - **Expected**: `parseExemptions(LF) -> Map(1)` and `parseExemptions(CRLF) -> Map(0)`;
    `Date.parse("…Z\r") -> NaN`.
  - **Done when**: both observed. These are the RED evidence for US7 and are reproducible **on
    Linux**, so US7 needs no Windows host to verify — only to confirm the end-to-end effect.

---

## Phase 2: Foundational — stop producing the condition

**Purpose**: Declare line-ending normalization for the file types the gates parse. Repo-wide
infrastructure, landed on its own so the re-normalization it causes on other platforms is reviewable
in isolation from any behaviour change.

**⚠️ BLOCKS**: nothing technically, but it must be **its own commit** — see the plan's risk table.

- [ ] T004 Declare `eol=lf` for the parsed file types in `.gitattributes`
  - **Type**: Config change | **Risk**: Low | **Covers**: FR-023, research R8c
  - Add `*.yml`, `*.yaml` and `*.md` alongside the existing `*.sh` rule, and extend the file's
    existing comment to say *why*: the `*.sh` rule was added because a CRLF shebang breaks a
    container; these are added because a CRLF line breaks a **parser**, and two gates were silently
    mis-verdicting because of it.
  - **Done when**: `git check-attr text eol -- .forgejo/workflows/app-ci.yml openwiki/quickstart.md`
    reports `eol: lf` for both, and `git status` is clean on Linux (already LF — the diff appears
    only on a normalizing platform).
  - **Commit alone.** Do not combine with T005+.

---

## Phase 3: User Story 7 — a gate enforces the same rule regardless of line endings (P1)

**Goal**: Two gates currently give different verdicts for the same commit depending on the
contributor's checkout. One fails closed (PRD §1.3); one fails **open**.

**Independent test**: Feed carriage-return input directly to each parser and compare the verdict with
the line-feed case. No Windows host required.

**⚠️ BLOCKS US2** — Story 2 tightens `check-ci-digest-coverage.mjs` and offers exemption markers as
its escape hatch. Building that on a parser that cannot see markers would make the new rule
unfixable by its own mechanism.

- [ ] T005 [P] [US7] Write a failing test that `parseExemptions` is line-ending independent in `scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Type**: Test | **Risk**: None | **Covers**: US7-AC1, US7-AC4, FR-021, FR-024
  - Build one fixture string with `\n` endings, derive the CRLF variant with `.replace(/\n/g, '\r\n')`,
    and assert `parseExemptions` returns **deep-equal maps** for both. Assert on the map contents, not
    just its size — a marker whose reason is captured as `'because reasons\r'` is also a bug.
  - Feed the input **directly**. Do not write a temp file and rely on the checkout, or the test proves
    nothing about the parser (FR-024).
  - **Verify RED**: `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected RED**: 1 failing — the CRLF map is `Map(0) {}` against an expected `Map(1)`.
  - **RED is observable on Linux.**

- [ ] T006 [US7] Make the exemption parser tolerate carriage returns in `scripts/check-ci-digest-coverage.mjs`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T005 verified RED
  - Split on `/\r?\n/` rather than `'\n'`. Do **not** "fix" this by adding the `m` flag to the marker
    pattern or by appending `\r?` to it — the line-splitting is the defect, and the next pattern added
    to this file would inherit the trap. Check every other `split('\n')` in the file while here.
  - **Verify GREEN**: `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected GREEN**: 0 failures.
  - **Also run**: `node scripts/check-ci-digest-coverage.mjs --selftest && node scripts/check-ci-digest-coverage.mjs`
    → both exit 0, real scan still passes on Linux.

- [ ] T007 [US7] Add a whole-gate CRLF case proving PRD §1.3 is closed in `scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Type**: Test | **Risk**: Low | **Covers**: US7-AC1, SC-008
  - Extend the existing "real repo workflows all pass" case: run the coverage evaluation a second
    time over the same workflow text converted to CRLF, and assert the verdict is identical. This is
    the regression test for the exact failure the PRD reported —
    `app-ci / changes`, `app-ci / trigger-cd`, `infra-image-scan / changes` reported as uncovered.
  - **Verify RED**: stash T006's fix, then `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected RED**: 1 failing naming those three jobs. **Restore T006 afterwards.**

- [ ] T008 [P] [US7] Write a failing test that the drift check runs on carriage-return input in `scripts/__tests__/check-openwiki-okf.test.mjs`
  - **Type**: Test | **Risk**: None | **Covers**: US7-AC2, FR-022, FR-024
  - Mirror the existing V12 stale-concept case with a fixture written using CRLF endings, and assert
    the output still matches `/stale\.md/`. This is the **fails-open** one: today it prints
    `✅ 1 concepts conformant` and the staleness check silently never runs.
  - **Verify RED**: `node --test scripts/__tests__/check-openwiki-okf.test.mjs`
  - **Expected RED**: 1 failing — `The input did not match the regular expression /stale\.md/. Input:
    '[openwiki-okf] ✅ 1 concepts conformant across 1 directories.\n'`
  - **RED is observable on Linux.**

- [ ] T009 [US7] Normalize the timestamp before validating it in `scripts/check-openwiki-okf.mjs`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T008 verified RED
  - The V12 guard at line ~254 calls `Date.parse(fields.timestamp)` on the raw value; V5 at line ~237
    escapes the same bug only because it trims first. Normalize **once, at the point the field is
    read**, so both validators and any future one see a clean value — do not add a second `.trim()` at
    the call site and leave the asymmetry in place.
  - **Verify GREEN**: `node --test scripts/__tests__/check-openwiki-okf.test.mjs`
  - **Expected GREEN**: 0 failures.
  - **Also run**: `pnpm nx okf-lint` → still passes.

- [ ] T010 [US7] Sweep the gate scripts for the same validate-before-normalize shape
  - **Type**: Verification | **Risk**: Low | **Covers**: FR-022
  - Grep the `check-*.mjs` family for `Date.parse(`, `Number(`, `JSON.parse(` and `split('\n')` applied
    to values read from repository text, and check each for the trailing-`\r` case. Record findings
    here: fix any that fall in this feature's two gates; file the rest (spec Out of Scope excludes a
    repository-wide audit).
  - **Done when**: every hit is classified as fixed, out-of-scope-and-filed, or provably unaffected.

- [ ] T011 [US7] Document the line-ending invariant in `docs/runbooks/ci-diagnostics.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: FR-021, constitution § Documentation
  - Record: a gate parses repository text, so its verdict must not depend on the checkout; the two
    directions of failure observed here (closed for the coverage gate, **open** for the conformance
    gate); and the rule that a value is normalized when read, not at each use.
  - **Done when**: the section exists and names PRD §1.3 as the worked example.

- [ ] T012 [US7] Annotate PRD §1.3 in `docs/proposals/PRD-CIDiagnosticsGapClosure.md`
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

- [ ] T013 [P] [US1] Write a failing guard test for the E2E environment contract in `scripts/__tests__/app-e2e-env.guard.test.mjs`
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

- [ ] T014 [US1] Forward the missing flags in `.forgejo/workflows/app-ci.yml`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T013 verified RED
  - In the `app-e2e` job: add `KEYCLOAK_SERVICE_CLIENT_SECRET: ${{ secrets.KEYCLOAK_SERVICE_CLIENT_SECRET }}`
    to the job `env:` block (it is absent there, so a pass-through `-e` alone would forward nothing).
    In the Playwright step: add `-e E2E_AGENT_PRODUCTION`, `-e E2E_REQUIRE_AGENT_STACK=1` and
    `-e KEYCLOAK_SERVICE_CLIENT_SECRET`.
  - Add a comment listing the four **deliberately** unforwarded variables with reasons, from the
    contract, so the next reader does not re-derive the table or add them speculatively.
  - **Verify GREEN**: `node --test scripts/__tests__/app-e2e-env.guard.test.mjs`
  - **Expected GREEN**: 0 failures.

- [ ] T015 [US1] Reproduce the skip and the un-skip locally, by result
  - **Type**: Verification | **Risk**: Low | **Covers**: US1-AC1, FR-029
  - Run one agent spec through the CI container invocation verbatim, with and without the flag, per
    [quickstart.md § Story 1](./quickstart.md).
  - **Expected**: without → `3 skipped`, `EXIT=0`; with → all 3 execute. **The exit code is 0 in both
    cases** — which is the whole point. Record the counts, not the status.

- [ ] T016 [US1] Re-run the environment enumeration and reconcile it against the contract
  - **Type**: Verification | **Risk**: Low | **Covers**: FR-003, US1-AC3
  - Run the enumeration in [quickstart.md § Story 1](./quickstart.md) over
    `frontend/mcm-app/tests/e2e/` **and** `playwright.config.ts`.
  - **Done when**: every name appears in the contract as forwarded or deliberately-not, with no
    residue. This check is what found the admin-spec defect; it is a validation step, not a one-off.

- [ ] T017 [US1] Triage whatever the newly-running specs reveal
  - **Type**: Verification | **Risk**: **High** | **Covers**: spec Edge Cases, item #150
  - The agent and admin specs run in CI for the first time here. Failures are pre-existing defects,
    not regressions from this change.
  - **Done when**: every failure is either fixed, or attributed to a baseline with evidence and filed.
  - **Prohibited**: reverting to a skip, or narrowing the spec selection to dodge a failure. That
    recreates the exact false green this story removes.

- [ ] T018 [US1] Update `openwiki/invariants/feature-validation-checklist.md` if its guidance is now stale
  - **Type**: Documentation | **Risk**: None
  - The checklist already warns about this failure mode and instructs setting `E2E_REQUIRE_AGENT_STACK=1`
    "on any pre-PR or **CI** run". CI now does. Confirm the wording matches reality; correct it if not.
  - **Done when**: the invariant describes what CI actually does.

---

## Phase 5: User Story 2 — a failing containerized job leaves usable output (P1)

**Goal**: 48 of 83 `run:` steps across 14 containerized jobs produce no capture. In
`guardrails / naming`, **every** gate step is bare and only two unrelated steps are wrapped — so a
gate failure publishes two irrelevant logs.

**Independent test**: Deliberately fail a previously-unwrapped step and diagnose it from the
self-serve tooling alone.

**⚠️ DEPENDS ON US7** — the exemption mechanism this story relies on must be readable first.

- [ ] T019 [P] [US2] Write a failing test for per-step coverage in `scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Type**: Test | **Risk**: Medium | **Covers**: US2-AC1, FR-005,
    [contracts/step-instrumentation.md](./contracts/step-instrumentation.md)
  - Assert the new rule against synthetic workflow text: a job with one wrapped and one bare `run:`
    step **fails**; the same job with a step-level `# ci-log-step-exempt: <reason>` marker on the bare
    step **passes**; a marker with an empty reason **fails**.
  - **Verify RED**: `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected RED**: ≥3 failing — the current gate passes the one-wrapped-step job.

- [ ] T020 [US2] Implement per-step coverage in `scripts/check-ci-digest-coverage.mjs`
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T019 verified RED
  - Evaluate each `run:` step, not each job. Accept the existing `# ci-log-step-exempt:` marker at
    step level as well as job level; a marker with no reason is a failure. Keep the parser
    line-oriented — **no new dependencies**: this gate runs before any install step, and `js-yaml` is
    absent from the repository's `node_modules` (verified).
  - **Verify GREEN**: `node --test scripts/__tests__/check-ci-digest-coverage.test.mjs`
  - **Expected GREEN**: 0 failures.

- [ ] T021 [US2] Extend the gate's self-test to prove the new fail and exemption paths
  - **Type**: Implementation | **Risk**: Low | **Covers**: contract § Implementation constraints
  - Every other gate in `guardrails / naming` proves its fail path before the real scan. The new rule
    must too, or it is a gate nobody has watched fail.
  - **Verify GREEN**: `node scripts/check-ci-digest-coverage.mjs --selftest` → exits 0 and reports the
    new paths as exercised.

- [ ] T022 [US2] Wrap the bare steps in `guardrails.yml` (13 + 9 + 3 + 1 across four jobs)
  - **Type**: Config change | **Risk**: Medium | **Covers**: FR-005
  - `naming` (13), `sast` (9), `agent-gates` (3), `secret-scan` (1). Give each a stable, descriptive
    log name — the name becomes the digest excerpt's `source` and is what a reader sees first.
  - Exempt only what the contract's legitimate list covers, each with a written reason.
  - **Done when**: `node scripts/check-ci-digest-coverage.mjs` passes for these jobs.

- [ ] T023 [P] [US2] Wrap the bare steps in `app-ci.yml` (`affected` 1, `mc-service-checks` 2, `trigger-cd` 2)
  - **Type**: Config change | **Risk**: Low | **Covers**: FR-005
  - Note `mc-service-checks`' two are the `apt-get` and `rustup` installs — both real, recurring
    failure modes, and both currently invisible.
  - **Done when**: the gate passes for these jobs.

- [ ] T024 [P] [US2] Wrap the bare steps in `wiki-maintain.yml` (8), `infra-image-scan.yml` (3), `renovate.yml` (2), `cd-deploy.yml` (2)
  - **Type**: Config change | **Risk**: Low | **Covers**: FR-005
  - **Done when**: the gate passes for these jobs.

- [ ] T025 [US2] Re-check redaction coverage against the newly wrapped steps
  - **Type**: Verification | **Risk**: **High** | **Covers**: FR-008, constitution § Sensitive Data
  - Wrapping 48 more steps widens what is captured and therefore what may be published. The SAST,
    infra-image-scan and wiki-maintain steps handle tokens and third-party output.
  - **Done when**: each newly wrapped step's output shape has been considered against
    `redactForPublication`, with gaps fixed. **Do not assume existing redaction generalises** — that
    assumption is why this is a task and not a footnote.

- [ ] T026 [US2] Record the corrected diagnosis in `docs/runbooks/ci-diagnostics.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: research R1, R2
  - State that step logs are consumed **in-job** and do not need to survive teardown; that the real
    coverage requirement is per-step instrumentation; and that "no leftovers on the host" is not
    evidence about diagnosability. Include the local reproduction so the claim stays checkable.
  - **Done when**: a future reader cannot repeat the PRD's misdiagnosis from this runbook.

- [ ] T027 [US2] Annotate PRD §3.1 as rejected, with evidence, in `docs/proposals/PRD-CIDiagnosticsGapClosure.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: constitution § No Vibe Coding
  - A deviation from an approved input document must be documented, not silently applied.
  - **Done when**: §3.1 records the rejection and points at [research.md § R1](./research.md).

---

## Phase 6: User Story 3 — a broken digest says so (P2)

**Goal**: "The digest ran and failed" is currently indistinguishable from "no digest was needed".

**Independent test**: Force a publication failure and confirm the report names it as broken.

- [ ] T028 [P] [US3] Write a failing test for the three-way outcome in `scripts/__tests__/ci-failure-digest.test.mjs`
  - **Type**: Test | **Risk**: Low | **Covers**: US3-AC1, US3-AC2, FR-010,
    [contracts/digest-outcome.md](./contracts/digest-outcome.md)
  - Assert `not-needed` / `published` / `failed` are produced for the three conditions, and that
    `failed` carries its sub-reason (`no-credential`, `forbidden`, `transport`).
  - **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  - **Expected RED**: failing — no outcome describer exists.

- [ ] T029 [US3] Produce the outcome signal in `scripts/ci-failure-digest.mjs`
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T028 verified RED
  - Follow the precedent of the existing `absent` field, which already distinguishes "looked and found
    nothing" from "did not look" — reuse that vocabulary rather than inventing a parallel one.
  - The signal must not require the credential that just failed (contract obligation 3), and must not
    live only on stdout, which the forge API cannot read (obligation 1).
  - **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → 0 failures.

- [ ] T030 [P] [US3] Write a failing test that a digest failure never changes the job outcome
  - **Type**: Test | **Risk**: Low | **Covers**: US3-AC3, FR-012
  - Force each failure mode and assert the process exit code is **0** every time.
  - **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  - **Expected RED**: failing on the new cases only.

- [ ] T031 [US3] Keep the unconditional success exit while adding the signal
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T030 verified RED
  - `continue-on-error` and the unconditional `exit 0` both stay. A digest that fails to record its
    own failure still exits 0.
  - **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → 0 failures.

- [ ] T032 [P] [US3] Write a failing test that the reporter distinguishes the outcomes in `scripts/__tests__/ci-status.test.mjs`
  - **Type**: Test | **Risk**: Low | **Covers**: US3-AC1, FR-011
  - Assert `ci-status failure` never emits the "no digest was published" wording for a `failed`
    outcome — that string is reserved for `not-needed` and genuine absence.
  - **Verify RED**: `node --test scripts/__tests__/ci-status.test.mjs`
  - **Expected RED**: 1+ failing — both cases currently render identically.

- [ ] T033 [US3] Render the three outcomes distinctly in `scripts/ci-status.mjs`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T032 verified RED
  - **Verify GREEN**: `node --test scripts/__tests__/ci-status.test.mjs` → 0 failures.

---

## Phase 7: User Story 4 — the diagnostic channel survives a secretless run (P2)

**Goal**: The digest authenticates with an Actions secret that is empty exactly when a run is most
confusing. It collected its evidence on 2026-08-01 and then threw it away.

**⚠️ GATED ON T034.** Do not implement T036+ until the probe returns.

- [ ] T034 [US4] Run the auto-token capability probe on CI
  - **Type**: Verification | **Risk**: Medium | **Covers**: research R7
  - Add the temporary probe step from [quickstart.md § Story 4](./quickstart.md) on this branch. It
    prints the token's **length** and an HTTP status — **never the token**. Constitution § Secrets
    Management applies in full.
  - **Done when**: it is known whether the automatically-provisioned token is populated on a run whose
    Actions secrets are empty, and whether it can write the statuses endpoint. Record the answer here.
  - **If negative**: STOP. Do not implement T036. Renegotiate SC-004 with the operator — the fallback
    becomes "make the secretless condition unmistakable through Story 3's vocabulary" rather than
    "publish anyway". Silently weakening SC-004 is prohibited.

- [ ] T035 [P] [US4] Write a failing test for credential fallback selection in `scripts/__tests__/ci-failure-digest.test.mjs`
  - **Type**: Test | **Risk**: Low | **Covers**: US4-AC1, US4-AC2, FR-013, FR-015
  - Assert: purpose-scoped token present → existing path unchanged; absent → fallback selected and the
    `failed:no-credential` outcome recorded. Assert the unchanged case explicitly — a fallback that
    displaces the richer path is a regression.
  - **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  - **Expected RED**: failing — no fallback exists.

- [ ] T036 [US4] Implement the fallback in `scripts/ci-failure-digest.mjs`
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T034 positive **and** T035 RED
  - Credential selection, not new machinery — the commit-status path and its `write:repository` scope
    hint already exist (research R3).
  - **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → 0 failures.

- [ ] T037 [P] [US4] Write a failing test for safe truncation
  - **Type**: Test | **Risk**: Low | **Covers**: US4-AC3, FR-014
  - Assert an over-long excerpt is truncated rather than failing the publication, and that truncation
    never splits a redaction boundary — a half-redacted secret is worse than none.
  - **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  - **Expected RED**: failing — no truncation logic.

- [ ] T038 [US4] Implement size-safe truncation carrying the failing step's name and a pointer
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T037 verified RED
  - **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → 0 failures.

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

- [ ] T040 [P] [US5] Make the bundle-root assertion drive-aware in `scripts/__tests__/ci-status.test.mjs`
  - **Type**: Test refactor | **Risk**: Low | **Covers**: US5-AC1, US5-AC3, FR-016
  - Case `(y)` compares a `resolve()` result to a `join()` expectation. Change the **expectation** to
    `resolve(root, …)` so both sides normalize identically. Do **not** relax to `endsWith`/substring —
    the block guards a zip-slip path that turns a compromised CI token into arbitrary file write on a
    developer's machine.
  - **RED is NOT observable on Linux** — the case passes here. Measured Windows RED (T002):
    `expected '\tmp\bundle-root\logs\app.log'`, `actual 'E:\tmp\bundle-root\logs\app.log'`.
  - **Verify GREEN (Linux)**: `node --test scripts/__tests__/ci-status.test.mjs` → still 0 failures.
  - **Verify GREEN (Windows)**: operator, in T049.

- [ ] T041 [US5] Prove the containment assertion still bites (mutation check)
  - **Type**: Verification | **Risk**: Low | **Covers**: US5-AC3, FR-016
  - Temporarily make `safeBundleEntryPath` return `join(base, …)` without its containment check.
  - **Expected**: `(y2)`–`(y4)` **fail**. If they pass, T040 weakened the test and must be redone.
  - **Done when**: the failure is observed and the mutation reverted.

- [ ] T042 [P] [US5] Write a failing test that a finding's location is emitted platform-independently
  - **Type**: Test | **Risk**: Low | **Covers**: US5-AC1, FR-017
  - Test the **normalization directly** with a backslash-bearing input, so the case is RED on Linux
    rather than only on Windows. Asserting on `join()` output would pass trivially here and prove
    nothing.
  - **Verify RED**: `node --test scripts/__tests__/check-toolchain-consistency.test.mjs`
  - **Expected RED**: 1 failing — the emitted location keeps its backslashes.
  - **RED is observable on Linux** via the direct input.

- [ ] T043 [US5] Emit a stable location from `scripts/check-toolchain-consistency.mjs`
  - **Type**: Implementation | **Risk**: Low | **Prerequisite**: T042 verified RED
  - **This is a source fix, not a test fix.** The findings output is a report a human reads; a stable
    forward-slash representation is worth more than the platform's native separator. Normalize where
    the finding's `file` is built, not at the print site.
  - **Verify GREEN**: `node --test scripts/__tests__/check-toolchain-consistency.test.mjs` → 0 failures.
  - **Also run**: `node scripts/check-toolchain-consistency.mjs` → unchanged verdict on Linux.

- [ ] T044 [P] [US5] Convert the dynamic import to a file URL in `scripts/__tests__/wiki-maintain.test.mjs`
  - **Type**: Test refactor | **Risk**: Low | **Covers**: US5-AC1, FR-018
  - `await import(SCRIPT)` on an absolute path throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` (protocol
    `e:`) and aborts the **whole file** before any case runs. Use `pathToFileURL(SCRIPT).href`.
  - **RED is NOT observable on Linux** — an absolute POSIX path is a valid specifier here. Measured
    Windows RED (T002): file-level load failure, `Received protocol 'e:'`.
  - **Verify GREEN (Linux)**: `node --test scripts/__tests__/wiki-maintain.test.mjs` → still passes.

- [ ] T045 [US5] Sweep for the same unconverted-absolute-import pattern repository-wide
  - **Type**: Verification | **Risk**: Low | **Covers**: FR-018
  - `pathToFileURL` appears **nowhere** in the repository (verified), so this pattern is likely
    repeated. Grep for `import(` with a non-literal specifier across `scripts/` and `scripts/__tests__/`.
  - **Done when**: every hit is converted or shown to take a relative specifier.

- [ ] T046 [P] [US5] Write a failing test that the shell probe tests the capability actually needed in `scripts/__tests__/ci-log-step.test.mjs`
  - **Type**: Test | **Risk**: Medium | **Covers**: US5-AC4, FR-019
  - The current probe runs `bash -c 'exit 0'`, which a shell from a different filesystem namespace
    passes — then every case fails with status 127 because that shell cannot see the files. Probe the
    real requirement: have the candidate shell stat the script under test.
  - **RED on Linux**: simulate by pointing the probe at a shell that starts but cannot resolve the
    path. Assert the suite **skips with a reason naming that condition** rather than failing.
  - **Verify RED**: `node --test scripts/__tests__/ci-log-step.test.mjs`
  - **Expected RED**: failing — the current probe reports the shell as usable.

- [ ] T047 [US5] Replace the capability probe in `scripts/__tests__/ci-log-step.test.mjs`
  - **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T046 verified RED
  - Skip with a reason naming the unmet condition. This is the same failure shape as CLAUDE.md's gate
    on proving "it can't run in this environment" — the probe must answer the question being asked.
  - **Verify GREEN (Linux)**: `node --test scripts/__tests__/ci-log-step.test.mjs` → 0 failures, and
    the skip count is **0** on Linux (a real bash is present — a skip here would be a false pass).
  - **Verify GREEN (Windows)**: operator, in T049 — 9 failures become a reasoned skip or a pass.

- [ ] T048 [US5] Key the example-file tripwire on version control in `scripts/__tests__/gen-dev-env.guard.test.mjs`
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

- [ ] T050 [US6] Confirm `openwiki/policy.yaml` permits the paths this story touches
  - **Type**: Verification | **Risk**: Low | **Covers**: FR-028
  - **Before** writing, not after. A concept written into a path the policy forbids is rework.
  - **Done when**: the target paths are confirmed writable by this actor, or the policy change needed
    is identified.

- [ ] T051 [P] [US6] Document offline dependency resolution in `docs/runbooks/devcontainer.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: FR-025, US6-AC1
  - Add to the existing section that already teaches "check the firewall allowlist before suspecting
    the tool" — crates.io is simply another non-allowlisted host. Include **both** halves: the
    `--offline` workaround **and** the corollary that is currently written down nowhere — a *failing*
    `--offline` resolve means the change pulls a package absent from the lock file. Name the worked
    example (a TLS feature dragging in two transitive crates) and the `cargo tree -e features -i`
    follow-up.
  - **Done when**: `grep -rn -- "--offline" docs/runbooks/` returns the passage, corollary included.

- [ ] T052 [P] [US6] Correct the stale toolchain-scope claim in `docs/runbooks/devcontainer.md`
  - **Type**: Documentation | **Risk**: None | **Covers**: FR-027, US6-AC3
  - § Toolchain scope still calls the Rust and Python toolchains a deferred "increment 2"; feature 038
    delivered them, and the same file describes the result elsewhere. It is the first place a reader
    checks whether cargo exists at all, and it sits next to where T051 lands.
  - **Done when**: `grep -rn "increment 2" docs/runbooks/devcontainer.md` returns nothing.

- [ ] T053 [US6] Add a canonical `openwiki/gotchas/` concept for the whole-crate formatting trap
  - **Type**: Documentation | **Risk**: Low | **Covers**: FR-026, US6-AC2
  - No upstream document covers Rust formatting convention here, so per CLAUDE.md this is a new
    canonical concept rather than an edit to a derived summary.
  - Must carry: the per-file invocation reformats the **whole crate**; `rustfmt <path>` is the
    single-file alternative; the recovery step; and the "format only what you touch" convention **with**
    its context — the pre-existing drift and the fact that the lint gate is the Nx target, not
    `clippy --all-targets`. Without that context a whole-crate format reads as a harmless tidy-up
    rather than a manufactured diff someone must then prove is unrelated.
  - **Done when**: the concept exists and `grep -rn "rustfmt" openwiki/` returns it.

- [ ] T054 [US6] Regenerate the knowledge index and pass the gates
  - **Type**: Config change | **Risk**: Low | **Covers**: FR-028, US6-AC4
  - **Commands**: `pnpm nx wiki-update`, then `pnpm nx okf-lint`, then
    `node scripts/check-openwiki-governance.mjs`
  - **Expected**: all pass; the CLAUDE.md index is regenerated, **not hand-edited**.
  - **Note**: T009 changed the okf gate. If regeneration surfaces drift that was previously hidden by
    that bug, it is real — fix it, do not suppress it.

---

## Phase 10: Polish & cross-cutting — prove it, then clean up

- [ ] T055 Rehearse SC-002 — diagnose a deliberately failed containerized job
  - **Type**: Verification | **Risk**: Medium | **Covers**: SC-002, FR-029
  - Break a **previously-unwrapped** step in `mc-service-checks` on this branch, push, then run
    `node scripts/ci-status.mjs failure --pr <n>`.
  - **Expected**: the root cause is readable with no human log-pasting and no SSH. Record the output.
  - **By actually breaking a job, not by inspection** — the spec is explicit, and both incidents this
    closes were prolonged by treating a green run as evidence.

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

- [ ] T059 Full script suite green on Linux
  - **Type**: Verification | **Risk**: Low
  - **Command**: `node --test "scripts/__tests__/*.test.mjs"`
  - **Expected**: 0 failures, and the **collected count is at least T001's baseline** — a suite that
    got smaller is a selector that stopped matching, not a suite that got greener.

- [ ] T060 All gates green on a clean tree
  - **Type**: Verification | **Risk**: Low | **Covers**: SC-008
  - **Commands**: `node scripts/check-ci-digest-coverage.mjs --selftest`,
    `node scripts/check-ci-digest-coverage.mjs`, `pnpm nx okf-lint`,
    `node scripts/check-openwiki-governance.mjs`, `node scripts/check-toolchain-consistency.mjs`
  - **Expected**: all exit 0 **on Linux**; T049 covers Windows. Per FR-031, record which platform.

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
