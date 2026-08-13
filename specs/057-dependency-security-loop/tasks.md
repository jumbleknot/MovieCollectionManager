# Tasks: restore the dependency-security maintenance loop

**Feature**: `057-dependency-security-loop` · **Backlog**: items #160, #153, #152, #154
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md)
**Contracts**: [allowlist-expiry](./contracts/allowlist-expiry.module.md) · [check-expiring](./contracts/check-expiring.cli.md) · [check-override-consistency](./contracts/check-override-consistency.cli.md)

## Format

`- [ ] **TNNN** [P?] [USn] Description with file path` — `[P]` = parallelisable (different file, no
incomplete dependency). Test tasks carry **Verify RED**; their paired implementation tasks carry
**Verify GREEN**, per the constitution's non-negotiable TDD checkpoint format
(`docs/templates/feature-test-tasks-template.md`).

## The rule that shapes this feature

**A fix that leaves no artifact behind is not a fix.** Three of the four faults were invisible
precisely because nothing checked them: a comment asserted a schedule relationship that did not hold,
an engine requirement had no pin to violate, and an expiry had no tier between silent and blocking.
So every story here ends in a *check* — a guard test, a gate, or a scheduled run — not in a corrected
line. A task that only edits prose is marked as such and is never the whole of a story.

**Verify RED means it fails for the stated reason.** A RED that fails because a file is missing when
you expected an assertion failure is not the RED you wrote down. Read the message, not the exit code.

---

## Phase 1 — Setup: baselines that must be taken BEFORE anything changes

**Purpose**: three later acceptance criteria compare against a "before" number. Measured afterwards,
they prove nothing.

- [x] **T001** [P] Record the Renovate extraction baseline: dispatch `renovate` with `dryRun=true`
      and capture the dependency count extracted from `pnpm-workspace.yaml`. **Expected: zero.**
      Write the number and the run id into this file beside the task. This is the baseline SC-004 and
      FR-014 are measured against — after the manager exists, "non-zero" is only meaningful relative
      to a recorded zero. (SC-004)

      > **MEASURED 2026-08-13: the baseline is 12, NOT zero. The expectation was wrong, and this
      > falsifies R4's central premise.**
      >
      > **Source**: run **1704** (task 5753), event `schedule`, `2026-08-13T03:00:14Z`, head
      > `6afc2c8`, exit 1. No dispatch was needed — that run is itself a pre-change measurement, and
      > its full `step:renovate` log survives in the failure-digest bundle
      > `ci-failures/1704--renovate`. A `dryRun=true` dispatch would have measured the *same broken
      > bot* and returned the same numbers, so this is the identical measurement without a second
      > red run.
      >
      > **The count**: Renovate's *built-in* `npm` manager already covers `pnpm-workspace.yaml`.
      > Extraction stats from that run: `npm: {fileCount: 4, depCount: 115}` (total 48 files / 355
      > deps). The Dependency Dashboard the same run wrote at `03:02:59Z` lists
      > **`pnpm-workspace.yaml (12)`** under Detected Dependencies — all **10** keyed override floors
      > plus `postcss` and `@expo/dom-webview` (`react-dom` is extracted but hidden by the
      > react-lock `packageRule`).
      >
      > **It already proposes bumps to them.** Pending updates listed for override entries:
      > `fast-uri@<3.1.4` `>=3.1.4 <4` → `>=3.1.4 <5`; `undici@<6.27.0` → `>=6.27.0 <9`;
      > `js-yaml@>=3.0.0 <3.15.1` → `>=3.15.1 <6`; `js-yaml@>=4.0.0 <4.3.1` → `>=4.3.1 <6`;
      > `nanoid@>=3.0.0 <3.3.17` → `>=3.3.17 <7`. All five are queued in the `js majors` group under
      > Awaiting Schedule.
      >
      > **What this does and does not change** — see the US4 note in Phase 6:
      > - **FR-014 / SC-004 are already satisfied** and cannot be "improved from zero". There is no
      >   zero to beat.
      > - **FR-016 is already satisfied for the value half**: Renovate can and does propose raising
      >   an override floor's patched-version value.
      > - **The key half is NOT rewritten and cannot be.** Renovate parses `fast-uri@<3.1.4` as the
      >   *depName* and `>=3.1.4 <4` as the *version*. The vulnerable-range key is an opaque name to
      >   it. So the bot's proposals are **half-bumps by construction** — which makes T018-T020's
      >   consistency guard more load-bearing than planned, not less.
      > - The five pending bumps above happen to keep their lower bounds fixed (they widen the upper
      >   bound only), so today's queue would pass the guard. A real floor *raise* would not.
- [x] **T002** [P] Record the deferred-update baseline from the dependency dashboard:
      `node scripts/backlog.mjs show 29`, capturing the count of groups under **Awaiting Schedule**.
      **Expected: 8.** SC-002 asserts this reaches zero. (SC-002)

      > **MEASURED 2026-08-13: 10 groups, not 8.** Counted as `grep -c 'unschedule-branch='` on
      > `node scripts/backlog.mjs show 29` (the eleventh checkbox,
      > `create-all-awaiting-schedule-prs`, is a control, not a group). The groups are:
      > `ci-actions`, `nx-monorepo`, `cargo-deps`, `js-patchminor`, `docker-base-images`,
      > `major-ci-actions`, `major-nx-monorepo`, `major-docker-base-images`,
      > `major-js-majors-(review-individually)`, `major-cargo-deps`.
      > Two more accumulated between the spec's measurement and implementation, which is the fault
      > continuing to cost. **SC-002 is measured against 10.**
- [x] **T003** [P] Record the allowlist baseline: run `node scripts/check-sast-findings.mjs` and
      capture that `GHSA-7p8r-x3mc-p8w7` and `GHSA-mwp4-54f8-5fhr` currently appear as **suppressed**,
      plus the total of 8 expiry-bearing entries across `security/sast/allowlist.yaml` (5) and
      `security/infra-images/allowlist.yaml` (3). (SC-003, SC-005)

      > **Entry count confirmed: 8.** `security/sast/allowlist.yaml` — `click` (2026-10-12),
      > `fast-uri` (2026-08-31), `ip-address` (2026-08-31), `image-size` ×2 (2026-09-07);
      > `security/infra-images/allowlist.yaml` — 3 entries, all 2026-10-24.
      >
      > **Instrument check first.** Running `check-sast-findings.mjs` against the checked-out tree
      > printed an EMPTY summary and `exit=0`. That is not a baseline: the committed
      > `security/sast/reports/findings.json` is a stale 794-byte artifact holding **0 findings**, so
      > the gate had nothing to classify and passed *vacuously*. Suppression baseline was taken only
      > after `node scripts/sast-scan.mjs --scope full` regenerated the report — see the recorded
      > result beneath T013.

---

## Phase 2 — Foundational

**None, and that is deliberate.** No task in any story blocks another: US1 and US2 edit different
regions of one workflow, US3 touches only dependency and allowlist files, US4 and US5 add new scripts.
The clarification that split US3 from US4 exists precisely so a failed dry run cannot block a dated
remediation. Inventing a foundational phase here would create a dependency the design removed.

**Checkpoint**: after Phase 1, any story may begin.

---

## Phase 3 — US1: the bot runs on an engine it supports (P1)

**Goal**: the nightly job stops failing, and the security path that still works is served by a
supported Renovate.

**Independent test**: dispatch the workflow — exit 0, no `EBADENGINE`, no "Unsupported node
environment". Needs no other story.

- [ ] **T004** [US1] Write the guard FIRST in `scripts/__tests__/renovate-workflow.guard.test.mjs`:
      a case asserting `.forgejo/workflows/renovate.yml` contains a `setup-node` step with an
      explicit `node-version`, because a job with no pin silently inherits the runner container's
      Node. Covers **US1-AC1**.
      **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
      **Expected RED**: 1 failing — the workflow has no `setup-node` step (it is the only workflow in
      the repository without one). A failure reading "cannot find module" means the file is empty,
      not that the assertion works. (FR-001)
- [ ] **T005** [US1] Add `actions/setup-node@<sha> # v4` with `node-version: 24.14.1` to
      `.forgejo/workflows/renovate.yml`, placed **before** the `corepack enable` step at line 64 —
      corepack is provisioned from whichever Node is on PATH, so ordering is the requirement, not a
      preference. SHA-pin the action as every other workflow does. Covers **US1-AC1, US1-AC2**.
      **Prerequisite**: T004 verified RED.
      **Verify GREEN**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs` → 0 failures.
      **Also run**: `node scripts/check-toolchain-consistency.mjs` → exit 0. This existing gate
      validates every `node-version:` in `.forgejo/workflows` against `engines.node` (`>=22.13`), so
      a typo'd version fails here rather than in CI. (FR-001, FR-002, FR-003)
- [ ] **T006** [US1] Extend the major-pin rationale block at `.forgejo/workflows/renovate.yml:87-99`
      with the residual risk it does not currently reason about: a major-only pin does not protect
      against an **engine-requirement bump inside the major** — which is exactly what 44.14.12 did —
      and `setup-node` is what covers it. **Type**: Documentation, no RED/GREEN. Covers **US1-AC3**.
      **Done when**: the block names the engine-bump risk and the step that mitigates it. (FR-004)
- [ ] **T007** [US1] Dispatch `renovate` and confirm the fix in the log. **Requires CI.**
      **Done when**: exit 0, with **no** `EBADENGINE` warning and **no** "Unsupported node
      environment" error — compared against run 1587 (task 5278), which showed both. (SC-001)

**Checkpoint**: US1 complete and independently verified.

---

## Phase 4 — US2: routine updates are actually proposed (P1)

**Goal**: base-image, Actions, Cargo, Python and JS patch/minor updates get proposed again after four
weeks of silent deferral.

**Independent test**: the guard test passes, a dry run lists branches it would open, and item #29's
"Awaiting Schedule" list shrinks.

- [ ] **T008** [US2] Add a second case to `scripts/__tests__/renovate-workflow.guard.test.mjs`:
      parse every `cron:` in `renovate.yml` and the `schedule` + `timezone` in `renovate.json`,
      convert both to UTC, and assert at least one trigger falls inside the permitted window **under
      both DST offsets** (EDT and EST). Covers **US2-AC1, US2-AC3**.
      **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
      **Expected RED**: 1 failing — no trigger intersects. Today's arithmetic: cron `0 3 * * *` is
      03:00 UTC daily; the window `* 3 * * 5` in `America/New_York` is 07:00-07:59 UTC Friday. The
      sets are disjoint. **This test must fail on `main` before any fix.** (FR-005, FR-007)
      **Note**: T004 and T008 edit the same file, so they are **not** parallel with each other.
- [ ] **T009** [US2] Add `- cron: '0 7 * * 5'` alongside the existing nightly cron in
      `.forgejo/workflows/renovate.yml` (**add**, never move — the nightly run is what keeps
      schedule-exempt security PRs prompt), and widen `renovate.json`'s `schedule` from
      `["* 3 * * 5"]` to `["* 2-4 * * 5"]` so the UTC cron lands inside the window in both EDT and
      EST. Covers **US2-AC1, US2-AC2, US2-AC3**.
      **Prerequisite**: T008 verified RED.
      **Verify GREEN**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs` → 0 failures,
      including the EST case.
      **Also run the touched suite**: `node --test scripts/__tests__/*.test.mjs` and
      `node scripts/check-toolchain-consistency.mjs` — this task edits a workflow file that the
      toolchain gate also parses, so a YAML slip here is reachable beyond the guard you just wrote.
      **Expected**: previously passing checks still pass. (FR-005, FR-006, FR-007)
- [ ] **T010** [US2] Correct the comment on the nightly cron at `.forgejo/workflows/renovate.yml:34`.
      It currently reads "nightly 03:00 UTC (matches the renovate.json schedule window)" — the bug
      stated in one sentence. Give each cron a comment describing what it actually does.
      **Type**: Documentation, no RED/GREEN. Covers **US2-AC4**.
      **Done when**: neither comment asserts a relationship that the guard test would contradict.
      (FR-008)
- [ ] **T011** [US2] Dispatch `renovate` with `dryRun=true` and confirm the log **names branches it
      would create**. **Requires CI.** Do this before a live run — it previews the eight deferred
      groups without opening them.
      **Done when**: the dry-run log lists candidate branches where it previously listed none.
- [ ] **T012** [US2] After the first live run inside the window, re-check the dashboard:
      `node scripts/backlog.mjs show 29`. **Requires CI + a Friday run.**
      **Done when**: the **Awaiting Schedule** group count has fallen from T002's baseline of 8 to 0,
      with those groups now open pull requests. `prConcurrentLimit: 5` / `prHourlyLimit: 2` throttle
      the release, so expect this over more than one run. (SC-002)

**Checkpoint**: the bot both runs and is allowed to act.

---

## Phase 5 — US3: the two acceptances are remediated, not renewed (P2)

**Goal**: clear the `fast-uri` and `ip-address` advisories by raising versions, so the gate does not
turn red on every branch on **2026-08-31**.

**Independent test**: the gate reports neither advisory as blocking *nor* as suppressed, and both
entries are gone from the file.

**Ordering note — this is the RED/GREEN, and it is worth doing in this order.** Deleting the entries
*first* proves they were load-bearing; if the gate stays green after deletion, the acceptance was
unnecessary and the remediation would have been busywork. Raising the floors then turns it back green
for the right reason.

> **T013 and T014 land in ONE commit.** The RED between them is real — the `sast` gate exits 1 with
> both advisories blocking — and it is meant to be observed locally, never published. Pushing T013
> alone puts a red required gate on the branch, which is the exact symptom this feature exists to
> remove. This is the one place where the "commit after each task" note in Notes does not apply.

- [ ] **T013** [US3] Delete both entries from `security/sast/allowlist.yaml` — the
      `GHSA-7p8r-x3mc-p8w7` (fast-uri) and `GHSA-mwp4-54f8-5fhr` (ip-address) blocks at lines
      111-121. **Delete, never re-date** (FR-010). Covers **US3-AC2**.
      **Verify RED**: `node scripts/sast-scan.mjs --scope full && node scripts/check-sast-findings.mjs`
      **Expected RED**: exit 1, with both advisories now listed as **blocking** findings. If the gate
      still exits 0, stop — the entries were suppressing nothing and that is a different finding worth
      recording. (FR-010)
- [ ] **T014** [US3] Raise `fast-uri`'s floor and add one for `ip-address` in `pnpm-workspace.yaml`'s
      `overrides:` map. **Move both halves together** — the key's vulnerable range *and* the value's
      patched floor — per the invariant in [data-model.md](./data-model.md). `fast-uri` already
      carries `fast-uri@<3.1.4: '>=3.1.4 <4'` (this advisory bypasses the previous fix, so it is a
      raise); `ip-address` has no override at all. Then update the **existing** `fast-uri@3.1.4` entry
      in `minimumReleaseAgeExclude` at line 28 — it is already there, so this is an edit, not an
      append — and refresh the lockfile. Covers **US3-AC1, US3-AC4**.
      **Prerequisite**: T013 verified RED.
      **Verify GREEN**: `node scripts/sast-scan.mjs --scope full && node scripts/check-sast-findings.mjs`
      → exit 0, and:
      ```bash
      node scripts/check-sast-findings.mjs | grep -E 'GHSA-7p8r-x3mc-p8w7|GHSA-mwp4-54f8-5fhr'
      ```
      **Expected**: no matches. A hit under *either* heading — blocking or suppressed — means the work
      is not done. (FR-009, FR-011, FR-012)
- [ ] **T015** [US3] Confirm the lockfile actually resolved the floors, not just that the override
      text is present: check `pnpm-lock.yaml` resolves `fast-uri` and `ip-address` at or above each
      advisory's fixed version.
      **Done when**: both resolved versions satisfy their advisory. An override that does not change
      resolution is a no-op that reads as a fix. (FR-009)
- [ ] **T016** [US3] Run the build and the web E2E baseline. These are JS-toolchain transitives, so a
      bad floor surfaces at **build** time, not in unit tests — `nx test` will pass over a broken
      floor. Covers **US3-AC3**.
      **Verify**: `pnpm nx build mcm-app`, then the web E2E baseline per
      `docs/runbooks/e2e-testing.md`.
      **Expected**: build succeeds; E2E counts unchanged from baseline. (FR-013, SC-008)
- [ ] **T017** [US3] If no fixed release exists for one advisory at implementation time, re-date
      **that single entry** with the absence of a fix written into its justification, following the
      `image-size` precedent — and do not touch the other. Covers **US3-AC5**.
      **Done when**: either this task is recorded as not-needed, or exactly one entry carries a new
      date and a justification naming the missing fix.

**Checkpoint**: the 2026-08-31 deadline is cleared and cannot re-block.

---

## Phase 6 — US4: override floors stop being invisible (P2)

**Goal**: the next transitive advisory produces a proposal instead of a hand-written bump under
deadline — with both halves of the override guaranteed to move together.

**Independent test**: the guard detects a deliberately mismatched pair; the dry run reports non-zero
extraction against T001's recorded zero.

**Ordering note**: the **guard lands before the manager**, so the repository already refuses
half-bumps when the first bot proposal arrives. It is also green on today's map (10 keyed floors, 10
agreements), so it is safe to add alone.

- [ ] **T018** [P] [US4] Write `scripts/__tests__/check-override-consistency.test.mjs` FIRST,
      covering the cases in the
      [contract](./contracts/check-override-consistency.cli.md): value raised with a stale key; key
      raised with a stale value (the mismatch is symmetric); both halves agreeing; the three
      **plain pins** (`react-dom`, `postcss`, `@expo/dom-webview`) passing because they have no key
      half; a scoped name (`@scope/name@<1.2.3`) parsed on the **last** `@`; and a value with no `>=`
      bound exiting 2 rather than being silently skipped. Use the `--dir` seam so no test touches the
      real file. Covers **US4-AC3, US4-AC4**.
      **Verify RED**: `node --test scripts/__tests__/check-override-consistency.test.mjs`
      **Expected RED**: all cases fail — the script does not exist yet. (FR-017)
- [ ] **T019** [US4] Implement `scripts/check-override-consistency.mjs` with `--selftest` and `--dir`,
      shaped after `check-toolchain-consistency.mjs` (same flags, same exit codes 0/1/2). Rule: for
      every override whose key carries an `@<range>` suffix, the key's exclusive upper bound must
      equal the value's inclusive lower bound. **Scope it to keyed entries only** — three legitimate
      plain pins exist and flagging them is the single most likely way to get this wrong.
      **Prerequisite**: T018 verified RED.
      **Verify GREEN**: `node --test scripts/__tests__/check-override-consistency.test.mjs` → 0
      failures; `node scripts/check-override-consistency.mjs --selftest` → exit 0;
      `node scripts/check-override-consistency.mjs` → **exit 0 against the real map (10 of 10 agree)**.
      (FR-017, SC-009)
- [ ] **T020** [US4] Wire the guard into the `naming` job of `.forgejo/workflows/guardrails.yml`,
      selftest-then-scan, beside the toolchain gate at lines 133-134. Unlike the expiry check this
      **does** run on pull requests — blocking a half-bumped proposal before merge is its purpose.
      Its unit test is discovered automatically by the existing `node --test
      scripts/__tests__/*.test.mjs` glob at line 147; no additional wiring. (FR-018)
- [ ] **T021** [US4] Add a second `customManager` to `renovate.json` over `pnpm-workspace.yaml`, with
      **two `matchStrings`** — one capturing the version inside the vulnerable-range key, one
      capturing the version inside the patched value — both emitting the same `depName` and the `npm`
      datasource. Capture the **bare version** (`3.1.4`), never the whole range: Renovate substitutes
      a captured `currentValue` in place, so this makes the bump a character substitution and moves
      both halves in one PR. Use `managerFilePatterns`, **not** the pre-v41 `fileMatch`. Covers
      **US4-AC1**.
      **Verify**: `npx --yes --package renovate@44 -- renovate-config-validator renovate.json` →
      passes. Covers **US4-AC2**. (FR-015, FR-016)
- [ ] **T022** [US4] Prove extraction with a `dryRun=true` dispatch and read the count for
      `pnpm-workspace.yaml` specifically. **Requires CI.** Covers **US4-AC1, US4-AC5**.
      **Done when (1 of 2)**: the count is **non-zero**, against T001's recorded baseline of zero.
      **Done when (2 of 2) — extraction is NOT proposal.** A non-zero count proves Renovate can *see*
      the floors; it does not prove it can *rewrite* them, and rewriting both halves in one PR is this
      story's central claim (FR-016). In the same dry-run log, find an override dependency with a
      pending update and confirm the proposed change moves **both** the vulnerable-range key and the
      patched value. If **no** upgrade happens to be available for any of the 10 floors, record
      FR-016 as **unproven — deferred to the first real proposal**, and say so in the pull request.
      Do not let T022's count stand in for it: passing on the count alone is how a green tick comes
      to mean less than it appears to.
      **This is the task most likely to fool you.** A mis-keyed manager does not error —
      `renovate.json`'s own comment records that v41 renamed `fileMatch` to `managerFilePatterns` and
      *"a config using the wrong key does not fail loudly, it silently manages nothing"*. A zero count
      is indistinguishable from having made no change at all.
      **If the count is zero**: revert T021, document the limitation in `renovate.json`'s comment
      block, and file a backlog item for the follow-up. **Do not merge the manager.** T018-T020 still
      ship — the guard is valuable on its own. (FR-014, FR-019, SC-004)

**Checkpoint**: half-bumps are refused repo-wide, whether or not the manager survives T022.

---

## Phase 7 — US5: deadlines announce themselves before they bite (P3)

**Goal**: a time-boxed acceptance is heard about while there is still time to remediate, and a
newly-re-blocking finding explains itself.

**Independent test**: both gates' selftests pass with the new cases, and no gate's exit code moves on
a normal run.

- [ ] **T023** [P] [US5] Write `scripts/__tests__/allowlist-expiry.test.mjs` FIRST — the 11 cases in
      the [module contract](./contracts/allowlist-expiry.module.md), including **both inclusive
      boundaries** (exactly 14 days out → `expiring`; `expiry === today` → `expiring`, still
      suppressing; yesterday → `expired`) and the two unmatched cases that differ only in whether the
      scanner produced findings. Covers **US5-AC1, US5-AC3, US5-AC4**.
      **Verify RED**: `node --test scripts/__tests__/allowlist-expiry.test.mjs`
      **Expected RED**: all 11 fail — the module does not exist. (FR-020, FR-023, FR-024)
- [ ] **T024** [US5] Implement `scripts/allowlist-expiry.mjs` as a flat sibling module (there is no
      `scripts/lib/`; sharing here is by sibling import). Export `WARNING_WINDOW_DAYS = 14` as **the
      only definition in the repository**, plus `classifyExpiry`, `daysUntil`, `selectUnmatched` and
      the three formatters. Pure functions — `today` is always passed in, never read from the clock,
      so every case is testable without mocking time. Compute on UTC date boundaries so a runner's TZ
      cannot shift a classification.
      **Prerequisite**: T023 verified RED.
      **Verify GREEN**: `node --test scripts/__tests__/allowlist-expiry.test.mjs` → 0 failures.
      **Also run the touched suite**: `node scripts/check-sast-findings.mjs --selftest` and
      `node scripts/check-infra-image-findings.mjs --selftest` → both exit 0. Nothing imports the new
      module yet, so this is a baseline: it proves the gates were healthy *before* T026/T028 wire it
      in, which is what makes a later failure attributable. (FR-020, FR-023, FR-024)
- [ ] **T025** [US5] Add selftest cases (g1)-(g6) from the
      [CLI contract](./contracts/check-expiring.cli.md) to `scripts/check-sast-findings.mjs`,
      extending the existing harness beside case (f). Covers **US5-AC1, US5-AC2, US5-AC3, US5-AC4**.
      **Verify RED**: `node scripts/check-sast-findings.mjs --selftest`
      **Expected RED**: exit 1, listing the new cases as failures — not a crash. A crash means the
      harness was extended wrongly, not that the behaviour is missing. (FR-027)
- [ ] **T026** [US5] Implement the warning tier in `scripts/check-sast-findings.mjs`: import the
      shared module, print `EXPIRING SOON`, `EXPIRED` and `UNMATCHED ENTRIES` sections, and evaluate
      unmatched **only for scanners that produced at least one finding**. The expired message must
      state that the finding *was suppressed until* the date by an entry added by that person.
      **Prerequisite**: T025 verified RED.
      **Verify GREEN**: `node scripts/check-sast-findings.mjs --selftest` → exit 0.
      **Also verify the binding constraint**: `node scripts/check-sast-findings.mjs; echo "exit=$?"`
      → **`exit=0`**, unchanged. An entry inside the window must still suppress. (FR-020, FR-021,
      FR-022, FR-023)
- [ ] **T027** [US5] Repeat T025's test-first cycle for `scripts/check-infra-image-findings.mjs`,
      extending its harness beside case (h). Covers **US5-AC5** (identical behaviour).
      **Verify RED**: `node scripts/check-infra-image-findings.mjs --selftest` → exit 1 on the new
      cases. (FR-027)
- [ ] **T028** [US5] Implement the same tier in `scripts/check-infra-image-findings.mjs`, importing
      the **same** constant — no second definition of the window anywhere.
      **Prerequisite**: T027 verified RED.
      **Verify GREEN**: `node scripts/check-infra-image-findings.mjs --selftest` → exit 0; normal run
      exit code unchanged. (FR-024)
- [ ] **T029** [US5] Add the `--check-expiring` mode to both gates: report-only, skipping the
      blocking-finding gate entirely, exiting 1 if any entry is expiring, expired or unmatched.
      **Verify**: both `--selftest` runs still pass. The real-repository exit code is **conditional —
      derive it, do not assume it**, because stories are independent and this one may land before or
      after US3:
      | State of the repository when you run it | Correct exit |
      | --- | --- |
      | No entry within 14 days (e.g. 2026-08-13, or after US3 deleted the 08-31 pair) | **0** |
      | The 08-31 pair still present and you are running on/after **2026-08-17** | **1**, naming both |
      | Any entry already past its expiry | **1** |
      Exit 1 in the middle row is the mechanism **working**, not a failure of this task. Check which
      row you are in before judging the result. (FR-025)
- [ ] **T030** [US5] Wire the check into the scan job of `.forgejo/workflows/infra-image-scan.yml`,
      guarded by `if: github.event_name == 'schedule'`, covering **both** allowlists. That job is the
      only one with a real recurring trigger (`0 7 * * 5`) — `wiki-maintain.yml` has no cron at all,
      so the "weekly maintain job" named in item #154 does not exist in that form. Covers **US5-AC6**.
      **Done when**: the step exists and carries the event guard. (FR-026)
- [ ] **T031** [US5] Verify no pull request is newly blocked by **reading a real PR run's step list**,
      not by trusting the `if:` expression. Covers **US5-AC7**.
      **Done when**: the expiry step is **absent** from a `pull_request` run of `infra-image-scan`.
      A wrong guard that still evaluates true produces a green PR today and a blocked one the moment
      an entry enters the window — which is why this is checked by observation. (FR-021, SC-007)
      **And the inverse, in the same PR run**: confirm the override-consistency step **is present**
      in `guardrails.yml`'s `naming` job. FR-018 depends on that guard actually running on pull
      requests; an absent step and a passing one look identical from the job's green tick. (FR-018)
- [ ] **T032** [P] [US5] Document the warning window in `security/sast/README.md` so the next person
      adding an entry knows when they will hear about it: the 14-day window, that an expiring entry
      still suppresses, that an expired one explains itself, and that unmatched entries are reported.
      **Type**: Documentation, no RED/GREEN.
      **Done when**: the README states the window and its three behaviours. (FR-028)

**Checkpoint**: all five stories complete.

---

## Phase 8 — Polish & cross-cutting

- [ ] **T033** Run [quickstart.md](./quickstart.md) end to end and confirm each stated expectation,
      including that the three new test files **appear by name** in the
      `node --test scripts/__tests__/*.test.mjs` output. If they do not appear they are not being
      discovered — which reads as a pass.
- [ ] **T034** Confirm the predicted signal behaviour: the first weekly `--check-expiring` run after
      merge is **green**, and the first red is **Friday 2026-08-28**, naming the `image-size` pair.
      Record the actual dates. A red earlier or later than predicted means the window constant or a
      classification boundary is wrong — the prediction is a test, not a note. (SC-005, SC-006)
- [ ] **T035** [P] Record this feature's learnings where `openwiki/INSTRUCTIONS.md` says they belong —
      into the **cited source** for any concept that cites a resource, not into a derived summary and
      never into the root `CLAUDE.md` index. Candidates: the schedule-disjointness arithmetic and its
      guard, the engine-bump residual risk of a major-only pin, the override key/value lockstep
      invariant, and the measured fact that a mis-keyed custom manager extracts zero **silently**.
- [ ] **T036** Close backlog items **#152**, **#153**, **#154** and **#160** — each only when its own
      acceptance criteria are met **and verified**, with the evidence in a comment. Closure is an
      explicit act, not a consequence of a merged pull request. Note that #154's body claims "seven
      live entries" where the true count is **eight**; correct that in a comment before closing rather
      than closing against a wrong number.

---

## Dependencies & execution order

### Story independence

| Story | Depends on | Blocks |
| --- | --- | --- |
| US1 (P1) | Phase 1 | nothing |
| US2 (P1) | Phase 1; shares a test file with US1 (T004/T008) | nothing |
| US3 (P2) | Phase 1 | nothing |
| US4 (P2) | Phase 1; T001's baseline for T022 | nothing |
| US5 (P3) | Phase 1 | nothing |

No story blocks another. US3 is deliberately independent of US4 so a failed T022 cannot delay a dated
remediation.

### Within stories

- T004 → T005 (RED before GREEN) · T008 → T009 · T013 → T014 · T018 → T019 → T020 ·
  T023 → T024 → {T025 → T026, T027 → T028} → T029 → T030 → T031
- **T004 and T008 edit the same file** and are therefore sequential, not parallel — the one place the
  two P1 stories touch.
- T021 → T022; a zero result at T022 reverts T021 but leaves T018-T020 shipped.

### Parallel opportunities

```bash
# Phase 1 — all three baselines are independent reads
T001  Renovate dry-run extraction count
T002  Dashboard "Awaiting Schedule" count
T003  Allowlist suppression + entry count

# Across stories, once Phase 1 is done — different files entirely
T018  scripts/__tests__/check-override-consistency.test.mjs     [US4]
T023  scripts/__tests__/allowlist-expiry.test.mjs               [US5]
T032  security/sast/README.md                                   [US5]
```

## Implementation strategy

**Deadline-aware, not strictly priority-ordered.** US3 carries an external date (2026-08-31, 18 days
from spec creation) while US1 and US2 fix a bot that is already broken. If implementation is not
comfortably ahead of 08-24, land **Phase 5 (US3) first** — it is independent of everything and its
four tasks are the smallest slice with a real deadline behind them.

Otherwise the natural order holds: **US1 → US2 → US3 → US4 → US5**, fixing the bot, then the gap,
then the warning tier.

**Incremental delivery**: each phase is separately mergeable. US1+US2 are one small workflow PR; US3
is a dependency PR; US4 splits at T020 (guard) and T022 (manager); US5 is the largest and stands
alone. Given a single CI runner and a ~35-minute `app-e2e`, batch by default and split only where a
red run would be ambiguous — the guard and the manager are the one pair worth separating, because
their failure modes are unrelated.

## Notes

- `[P]` = different file, no incomplete dependency.
- Every test task states the RED **reason**, not just the command — a RED for the wrong reason is not
  a RED.
- Commit after each task or logical group.
- `pnpm nx preflight infrastructure-as-code` runs every cheap gate plus the `scripts/__tests__` tier
  before pushing; it deliberately excludes `app-e2e`, DAST and the integration tiers.
