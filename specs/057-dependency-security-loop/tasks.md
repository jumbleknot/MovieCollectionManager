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

- [x] **T004** [US1] Write the guard FIRST in `scripts/__tests__/renovate-workflow.guard.test.mjs`:
      a case asserting `.forgejo/workflows/renovate.yml` contains a `setup-node` step with an
      explicit `node-version`, because a job with no pin silently inherits the runner container's
      Node. Covers **US1-AC1**.
      **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
      **Expected RED**: 1 failing — the workflow has no `setup-node` step (it is the only workflow in
      the repository without one). A failure reading "cannot find module" means the file is empty,
      not that the assertion works. (FR-001)
- [x] **T005** [US1] Add `actions/setup-node@<sha> # v4` with `node-version: 24.14.1` to
      `.forgejo/workflows/renovate.yml`, placed **before** the `corepack enable` step at line 64 —
      corepack is provisioned from whichever Node is on PATH, so ordering is the requirement, not a
      preference. SHA-pin the action as every other workflow does. Covers **US1-AC1, US1-AC2**.
      **Prerequisite**: T004 verified RED.
      **Verify GREEN**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs` → 0 failures.
      **Also run**: `node scripts/check-toolchain-consistency.mjs` → exit 0. This existing gate
      validates every `node-version:` in `.forgejo/workflows` against `engines.node` (`>=22.13`), so
      a typo'd version fails here rather than in CI. (FR-001, FR-002, FR-003)
- [x] **T006** [US1] Extend the major-pin rationale block at `.forgejo/workflows/renovate.yml:87-99`
      with the residual risk it does not currently reason about: a major-only pin does not protect
      against an **engine-requirement bump inside the major** — which is exactly what 44.14.12 did —
      and `setup-node` is what covers it. **Type**: Documentation, no RED/GREEN. Covers **US1-AC3**.
      **Done when**: the block names the engine-bump risk and the step that mitigates it. (FR-004)
- [x] **T007** [US1] Dispatch `renovate` and confirm the fix in the log. **Requires CI.**
      **Done when**: exit 0, with **no** `EBADENGINE` warning and **no** "Unsupported node
      environment" error — compared against run 1587 (task 5278), which showed both. (SC-001)

      > **PRE-FIX EVIDENCE IS EXACT** — from run **1704**'s `step:renovate` log, the same fault four
      > runs later than the one the spec cites:
      > ```
      > npm warn EBADENGINE Unsupported engine {
      > npm warn EBADENGINE   package: 'renovate@44.27.0',
      > npm warn EBADENGINE   required: { node: '^24.11.0', pnpm: '^11.0.0' },
      > npm warn EBADENGINE   current: { node: 'v22.23.2', npm: '10.9.8' }
      > ERROR: Unsupported node environment detected. Please update your node version.
      > …
      > INFO: Renovate is exiting with a non-zero code due to the following logged errors
      > ```
      > Worth noting for whoever reads the next one: the error is logged **before** `Repository
      > started`, and Renovate then completes the whole run anyway — extraction, dashboard write and
      > all — before exiting 1 at the end. So "the bot is broken" and "the bot did its work" were both
      > true, which is part of why this went four days unread.
      >
      > **INSTRUMENT FINDING — `POST /actions/workflows/<file>/dispatches` returns `204` and the run
      > does not appear.** Measured three times (ref `057-dependency-security-loop` ×2, ref `main` ×1).
      > It is not the ref, and it is not a silent no-op: `GET /actions/tasks` **only lists runs that
      > have STARTED**. PR #185's own `naming`, `sast`, `okf` and `secret-scan` jobs were absent from
      > that same listing while queued, which is what identifies it. On a single-runner forge a
      > dispatched run is invisible until the queue reaches it — so an empty listing is **not**
      > evidence the dispatch failed, and re-dispatching on that belief just queues more copies.
      > Also measured: `inputs` values must be **strings** — `{"dryRun": true}` is rejected `422
      > cannot unmarshal bool`, while `{"dryRun": "true"}` is accepted.
      >
      > **RESULT — run 1708 (task 5766), `workflow_dispatch` on `057-dependency-security-loop`,
      > `dryRun=true`: SUCCESS.** Against run 1704's exit 1 on identical repository content, the only
      > difference being the `setup-node` step.
      >
      > **Why exit 0 settles SC-001 even though the log is unreadable.** A successful run publishes
      > **no** failure-digest bundle (confirmed: the package registry's newest `ci-failures` entry is
      > still `1704--renovate`), and this forge exposes no log endpoint — so the log cannot be read
      > back to grep for the two messages. It does not need to be. Run 1704's tail is explicit:
      > *"Renovate is exiting with a non-zero code due to the following logged errors"*, with
      > `loggerErrors` containing exactly one entry — `Unsupported node environment detected`. That
      > error **is** what made the exit non-zero, so an exit of 0 means it was not logged. And
      > `EBADENGINE` is emitted by npm when the installed package's `engines` do not match the running
      > Node; with Node 24.14.1 against `^24.11.0` it cannot fire. Both halves of the Done-when
      > follow from the exit code rather than needing the text.

**Checkpoint**: US1 complete and independently verified.

---

## Phase 4 — US2: routine updates are actually proposed (P1)

**Goal**: base-image, Actions, Cargo, Python and JS patch/minor updates get proposed again after four
weeks of silent deferral.

**Independent test**: the guard test passes, a dry run lists branches it would open, and item #29's
"Awaiting Schedule" list shrinks.

- [x] **T008** [US2] Add a second case to `scripts/__tests__/renovate-workflow.guard.test.mjs`:
      parse every `cron:` in `renovate.yml` and the `schedule` + `timezone` in `renovate.json`,
      convert both to UTC, and assert at least one trigger falls inside the permitted window **under
      both DST offsets** (EDT and EST). Covers **US2-AC1, US2-AC3**.
      **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
      **Expected RED**: 1 failing — no trigger intersects. Today's arithmetic: cron `0 3 * * *` is
      03:00 UTC daily; the window `* 3 * * 5` in `America/New_York` is 07:00-07:59 UTC Friday. The
      sets are disjoint. **This test must fail on `main` before any fix.** (FR-005, FR-007)
      **Note**: T004 and T008 edit the same file, so they are **not** parallel with each other.
- [x] **T009** [US2] Add `- cron: '0 7 * * 5'` alongside the existing nightly cron in
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
- [x] **T010** [US2] Correct the comment on the nightly cron at `.forgejo/workflows/renovate.yml:34`.
      It currently reads "nightly 03:00 UTC (matches the renovate.json schedule window)" — the bug
      stated in one sentence. Give each cron a comment describing what it actually does.
      **Type**: Documentation, no RED/GREEN. Covers **US2-AC4**.
      **Done when**: neither comment asserts a relationship that the guard test would contradict.
      (FR-008)
- [ ] **T011** [US2] Dispatch `renovate` with `dryRun=true` and confirm the log **names branches it
      would create**. **Requires CI.** Do this before a live run — it previews the eight deferred
      groups without opening them.
      **Done when**: the dry-run log lists candidate branches where it previously listed none.

      > **NOT VERIFIABLE AS WRITTEN, for two independent reasons — recorded rather than fudged.**
      >
      > 1. **A successful run's log is unreadable on this forge.** The failure digest is the only log
      >    channel and it publishes on **failure** only (confirmed: no `1708--renovate` bundle exists;
      >    the newest is still `1704--renovate`). Run 1708 succeeded, so there is no log to grep.
      > 2. **Even with the log, right now it would list nothing — correctly.** Renovate honours
      >    `schedule` for branch creation in dry run too. The dispatch ran on a **Thursday**; the
      >    permitted window is `* 2-4 * * 5` (Friday). A dry run inside the window is the only one
      >    whose branch list means anything, and that first exists on **Friday 2026-08-14**, after
      >    merge.
      >
      > **The substitutes are equivalent or better, and both already exist**: the Dependency Dashboard
      > (item #29) *is* the maintained list of what the bot would open — 10 groups under Awaiting
      > Schedule, enumerated under T002 — and **T012** is the real proof, those groups becoming open
      > pull requests. This task was a preview of T012; T012 is the thing itself.
- [ ] **T012** [US2] After the first live run inside the window, re-check the dashboard:
      `node scripts/backlog.mjs show 29`. **Requires CI + a Friday run.**
      **Done when**: the **Awaiting Schedule** group count has fallen from T002's baseline of 8 to 0,
      with those groups now open pull requests. `prConcurrentLimit: 5` / `prHourlyLimit: 2` throttle
      the release, so expect this over more than one run. (SC-002)

      > **BLOCKED ON MERGE — genuinely, not as an excuse.** The Friday cron only exists once
      > `renovate.yml` is on `main`. First opportunity: **Friday 2026-08-14**, then 08-21. Measure
      > against T002's **10** (not the 8 in this task's text). Expect it over more than one run —
      > `prConcurrentLimit: 5` / `prHourlyLimit: 2` throttle the release, so a single Friday landing
      > five of ten is the mechanism working, not a partial fix.

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

- [x] **T013** [US3] Delete both entries from `security/sast/allowlist.yaml` — the
      `GHSA-7p8r-x3mc-p8w7` (fast-uri) and `GHSA-mwp4-54f8-5fhr` (ip-address) blocks at lines
      111-121. **Delete, never re-date** (FR-010). Covers **US3-AC2**.
      **Verify RED**: `node scripts/sast-scan.mjs --scope full && node scripts/check-sast-findings.mjs`
      **Expected RED**: exit 1, with both advisories now listed as **blocking** findings. If the gate
      still exits 0, stop — the entries were suppressing nothing and that is a different finding worth
      recording. (FR-010)

      > **INSTRUMENT NOTE — the scan command in this task cannot run in this devcontainer, and the
      > reason matters.** `node scripts/sast-scan.mjs --scope full` fail-closes: semgrep resolves its
      > rule packs from `semgrep.dev`, which the devcontainer firewall blocks by design (it must be
      > re-applied, never allowlisted). The orchestrator then aborts before writing findings, leaving
      > a report with **0 findings** — which the gate reads as a clean pass. That is the false green
      > T003 caught.
      >
      > This is **not** "the tier cannot run here". Both target advisories are `pnpm-audit` findings,
      > and that scanner has no such dependency. `node scripts/sast-scan.mjs --scope full --only
      > pnpm-audit` runs to completion locally: **59 findings, 4 blocking** before this task. The
      > semgrep half remains CI's to run.
      >
      > **T003 baseline, taken against that real report**: both advisories present and **suppressed** —
      > `[pnpm-audit] High GHSA-7p8r-x3mc-p8w7 — fast-uri@3.1.4 — allowlisted by steve` and
      > `[pnpm-audit] High GHSA-mwp4-54f8-5fhr — ip-address@10.2.0 — allowlisted by steve`;
      > 4 suppressed in total; gate exit 0.
      >
      > **RED observed** after deleting both entries: `Blocking (un-allowlisted): 2`, naming both
      > advisories, **exit 1**. The entries were load-bearing. Observed locally only and never pushed —
      > T013 and T014 landed in one commit, as this phase requires.
- [x] **T014** [US3] Raise `fast-uri`'s floor and add one for `ip-address` in `pnpm-workspace.yaml`'s
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
- [x] **T015** [US3] Confirm the lockfile actually resolved the floors, not just that the override
      text is present: check `pnpm-lock.yaml` resolves `fast-uri` and `ip-address` at or above each
      advisory's fixed version.
      **Done when**: both resolved versions satisfy their advisory. An override that does not change
      resolution is a no-op that reads as a fix. (FR-009)

      > **Resolved, verified in `pnpm-lock.yaml`**: `fast-uri@3.1.5` (advisory fix `>=3.1.5` ✓) and
      > `ip-address@10.5.0` (advisory fix `>=10.3.1` ✓). Floors written as
      > `fast-uri@<3.1.5: '>=3.1.5 <4'` (a RAISE — both halves moved, the old key said `<3.1.4`) and
      > `ip-address@<10.3.1: '>=10.3.1 <11'` (new). `check-override-consistency.mjs` reports
      > **11 keyed floors agreeing** afterwards, up from 10.
      >
      > **T014 GREEN**: rescan gives **55 findings, 2 blocking** (down from 59/4 — the two High
      > advisories plus the two Medium `ip-address` advisories the same floor cleared). Neither
      > advisory appears as blocking **or** suppressed; gate exit 0. The 2 remaining blocking findings
      > are the `image-size` pair, still legitimately allowlisted.
      >
      > **FR-012**: `minimumReleaseAgeExclude`'s stale `fast-uri@3.1.4` updated to `3.1.5`, and
      > `ip-address@10.5.0` added — that release is dated 2026-08-10, inside the 3-day cooldown.
- [x] **T016** [US3] Run the build and the web E2E baseline. These are JS-toolchain transitives, so a
      bad floor surfaces at **build** time, not in unit tests — `nx test` will pass over a broken
      floor. Covers **US3-AC3**.
      **Verify**: `pnpm nx build mcm-app`, then the web E2E baseline per
      `docs/runbooks/e2e-testing.md`.
      **Expected**: build succeeds; E2E counts unchanged from baseline. (FR-013, SC-008)

      > **Build: PASS.** `pnpm nx build mcm-app` → *"Successfully ran target build for project
      > mcm-app"* — Expo web export plus the `mcm-bff:latest` image. This is the signal FR-013 exists
      > for: `nx test` passes over a broken toolchain floor, a build does not.
      >
      > **Web E2E: 135 passed, 39 skipped, 0 failed** (3.3m), dev-container target — the deterministic
      > baseline, not Metro.
      >
      > **Two instrument checks, because both would have produced a false green.**
      > 1. `mcm-bff-service-nonsecure` had been up 24 hours on the PREVIOUS image. Run as-is, the
      >    suite would have exercised a bundle built before these floors existed and reported green
      >    for the wrong artifact. Force-recreated onto the new image first, and confirmed
      >    `Up 20 seconds (healthy) mcm-bff:latest`.
      > 2. **The skip count is accounted for, not waved through.** All 39 skips are the agent tier
      >    (`agent-*.spec.ts` = 20 tests, `assistant-*.spec.ts` = 21; two of those 41 do not gate on a
      >    live model and ran). They gate on `E2E_AGENT_PRODUCTION=1`, which the *web* baseline
      >    deliberately does not set — that tier runs separately per
      >    `openwiki/invariants/testing-tiers.md`. **No non-agent test skipped**, so nothing outside
      >    the agent tier went unexercised.
- [x] **T017** [US3] If no fixed release exists for one advisory at implementation time, re-date
      **that single entry** with the absence of a fix written into its justification, following the
      `image-size` precedent — and do not touch the other. Covers **US3-AC5**.
      **Done when**: either this task is recorded as not-needed, or exactly one entry carries a new
      date and a justification naming the missing fix.

      > **NOT NEEDED — recorded, not skipped.** The spec's assumption held: a fixed release exists for
      > BOTH advisories, checked against npm rather than assumed. `fast-uri@3.1.5` (published
      > 2026-07-31) satisfies `>=3.1.5`; `ip-address@10.3.1` (2026-07-25) satisfies `>=10.3.1`, and
      > resolution picked up 10.5.0. Neither entry was re-dated; both were deleted. US3-AC5's escape
      > hatch was not used, which is the outcome the story wanted.

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

- [x] **T018** [P] [US4] Write `scripts/__tests__/check-override-consistency.test.mjs` FIRST,
      covering the cases in the
      [contract](./contracts/check-override-consistency.cli.md): value raised with a stale key; key
      raised with a stale value (the mismatch is symmetric); both halves agreeing; the three
      **plain pins** (`react-dom`, `postcss`, `@expo/dom-webview`) passing because they have no key
      half; a scoped name (`@scope/name@<1.2.3`) parsed on the **last** `@`; and a value with no `>=`
      bound exiting 2 rather than being silently skipped. Use the `--dir` seam so no test touches the
      real file. Covers **US4-AC3, US4-AC4**.
      **Verify RED**: `node --test scripts/__tests__/check-override-consistency.test.mjs`
      **Expected RED**: all cases fail — the script does not exist yet. (FR-017)
- [x] **T019** [US4] Implement `scripts/check-override-consistency.mjs` with `--selftest` and `--dir`,
      shaped after `check-toolchain-consistency.mjs` (same flags, same exit codes 0/1/2). Rule: for
      every override whose key carries an `@<range>` suffix, the key's exclusive upper bound must
      equal the value's inclusive lower bound. **Scope it to keyed entries only** — three legitimate
      plain pins exist and flagging them is the single most likely way to get this wrong.
      **Prerequisite**: T018 verified RED.
      **Verify GREEN**: `node --test scripts/__tests__/check-override-consistency.test.mjs` → 0
      failures; `node scripts/check-override-consistency.mjs --selftest` → exit 0;
      `node scripts/check-override-consistency.mjs` → **exit 0 against the real map (10 of 10 agree)**.
      (FR-017, SC-009)
- [x] **T020** [US4] Wire the guard into the `naming` job of `.forgejo/workflows/guardrails.yml`,
      selftest-then-scan, beside the toolchain gate at lines 133-134. Unlike the expiry check this
      **does** run on pull requests — blocking a half-bumped proposal before merge is its purpose.
      Its unit test is discovered automatically by the existing `node --test
      scripts/__tests__/*.test.mjs` glob at line 147; no additional wiring. (FR-018)
> ### T021/T022 OUTCOME — **the manager is NOT merged. FR-019's path, reached for a different reason.**
>
> T001's measured baseline (12, not 0) falsifies the premise both tasks rest on, so they cannot be
> executed as written and the fallback is the correct branch. Stated plainly:
>
> | Requirement | Status |
> | --- | --- |
> | FR-014 / SC-004 — non-zero extraction from the override-map file | **Already true before this feature.** 12 deps, run 1704. There is no zero to beat, and no measurement that could show an improvement. |
> | FR-015 — config passes the bot's own validator | **Met.** `renovate-config-validator` (renovate@44): *"Config validated successfully against 1 file(s)"*. |
> | FR-016 — the bot can *propose* raising a floor's patched value | **Already true for the value half.** Five override entries carry pending updates on the dashboard today. |
> | FR-016 — *both halves in one PR* | **Not achievable by the planned mechanism. Recorded UNPROVEN and deferred.** |
> | FR-017 / FR-018 — the consistency guard | **Met** (T018-T020), and more load-bearing than planned. |
> | FR-019 — document the limitation, file a follow-up, do not merge the manager | **Met.** |
>
> **Why a second manager would be worse than none.** Renovate's built-in `npm` manager already reads
> `pnpm-workspace.yaml`. A regex `customManager` over the same file would double-manage it — two
> depNames for one package, two branches, both editing the same lines. The planned design assumed the
> file was unmanaged; it is not.
>
> **What is actually missing, and why it is not fixable here.** The built-in manager parses
> `fast-uri@<3.1.4` as an opaque **depName** and `>=3.1.4 <4` as the version. It rewrites the value
> and leaves the vulnerable-range key stale, and Renovate has no mechanism for rewriting a depName.
> Handing the file to a regex manager instead would mean suppressing the built-in one for that file —
> a far larger and riskier change than was scoped, which would also drop `postcss`,
> `@expo/dom-webview` and `react-dom` extraction.
>
> **Net effect on the story's safety property: it is delivered.** Every floor raise the bot proposes
> is a half-bump *by construction*, and the guard fails it by name on the pull request. The accepted
> cost is that a bot-authored floor raise arrives RED and needs its key half fixed by hand — visible
> and cheap, against a silent half-remediation that still looks correct. The five updates queued
> today happen to widen upper bounds only, so they would pass; a real raise would not.
>
> Recorded in `renovate.json`'s description block, where the next person to reach for a custom
> manager will read it, and filed as **backlog item #184** with the measurement, the three options
> and acceptance criteria that make extraction-vs-proposal a separate check.

- [ ] **T021** [US4] ~~Add a second `customManager` to `renovate.json` over `pnpm-workspace.yaml`, with
      **two `matchStrings`** — one capturing the version inside the vulnerable-range key, one
      capturing the version inside the patched value — both emitting the same `depName` and the `npm`
      datasource. Capture the **bare version** (`3.1.4`), never the whole range: Renovate substitutes
      a captured `currentValue` in place, so this makes the bump a character substitution and moves
      both halves in one PR. Use `managerFilePatterns`, **not** the pre-v41 `fileMatch`. Covers
      **US4-AC1**.
      **Verify**: `npx --yes --package renovate@44 -- renovate-config-validator renovate.json` →
      passes.~~ Covers **US4-AC2**. (FR-015, FR-016)
      **NOT DONE — see the outcome note above.** The validator step WAS run against the edited
      `renovate.json` and passes, so FR-015/US4-AC2 stand on their own.
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

- [x] **T023** [P] [US5] Write `scripts/__tests__/allowlist-expiry.test.mjs` FIRST — the 11 cases in
      the [module contract](./contracts/allowlist-expiry.module.md), including **both inclusive
      boundaries** (exactly 14 days out → `expiring`; `expiry === today` → `expiring`, still
      suppressing; yesterday → `expired`) and the two unmatched cases that differ only in whether the
      scanner produced findings. Covers **US5-AC1, US5-AC3, US5-AC4**.
      **Verify RED**: `node --test scripts/__tests__/allowlist-expiry.test.mjs`
      **Expected RED**: all 11 fail — the module does not exist. (FR-020, FR-023, FR-024)
- [x] **T024** [US5] Implement `scripts/allowlist-expiry.mjs` as a flat sibling module (there is no
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
- [x] **T025** [US5] Add selftest cases (g1)-(g6) from the
      [CLI contract](./contracts/check-expiring.cli.md) to `scripts/check-sast-findings.mjs`,
      extending the existing harness beside case (f). Covers **US5-AC1, US5-AC2, US5-AC3, US5-AC4**.
      **Verify RED**: `node scripts/check-sast-findings.mjs --selftest`
      **Expected RED**: exit 1, listing the new cases as failures — not a crash. A crash means the
      harness was extended wrongly, not that the behaviour is missing. (FR-027)
- [x] **T026** [US5] Implement the warning tier in `scripts/check-sast-findings.mjs`: import the
      shared module, print `EXPIRING SOON`, `EXPIRED` and `UNMATCHED ENTRIES` sections, and evaluate
      unmatched **only for scanners that produced at least one finding**. The expired message must
      state that the finding *was suppressed until* the date by an entry added by that person.
      **Prerequisite**: T025 verified RED.
      **Verify GREEN**: `node scripts/check-sast-findings.mjs --selftest` → exit 0.
      **Also verify the binding constraint**: `node scripts/check-sast-findings.mjs; echo "exit=$?"`
      → **`exit=0`**, unchanged. An entry inside the window must still suppress. (FR-020, FR-021,
      FR-022, FR-023)
- [x] **T027** [US5] Repeat T025's test-first cycle for `scripts/check-infra-image-findings.mjs`,
      extending its harness beside case (h). Covers **US5-AC5** (identical behaviour).
      **Verify RED**: `node scripts/check-infra-image-findings.mjs --selftest` → exit 1 on the new
      cases. (FR-027)
- [x] **T028** [US5] Implement the same tier in `scripts/check-infra-image-findings.mjs`, importing
      the **same** constant — no second definition of the window anywhere.
      **Prerequisite**: T027 verified RED.
      **Verify GREEN**: `node scripts/check-infra-image-findings.mjs --selftest` → exit 0; normal run
      exit code unchanged. (FR-024)
- [x] **T029** [US5] Add the `--check-expiring` mode to both gates: report-only, skipping the
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
- [x] **T030** [US5] Wire the check into the scan job of `.forgejo/workflows/infra-image-scan.yml`,
      guarded by `if: github.event_name == 'schedule'`, covering **both** allowlists. That job is the
      only one with a real recurring trigger (`0 7 * * 5`) — `wiki-maintain.yml` has no cron at all,
      so the "weekly maintain job" named in item #154 does not exist in that form. Covers **US5-AC6**.
      **Done when**: the step exists and carries the event guard. (FR-026)
- [x] **T031** [US5] Verify no pull request is newly blocked by **reading a real PR run's step list**,
      not by trusting the `if:` expression. Covers **US5-AC7**.
      **Done when**: the expiry step is **absent** from a `pull_request` run of `infra-image-scan`.
      A wrong guard that still evaluates true produces a green PR today and a blocked one the moment
      an entry enters the window — which is why this is checked by observation. (FR-021, SC-007)
      **And the inverse, in the same PR run**: confirm the override-consistency step **is present**
      in `guardrails.yml`'s `naming` job. FR-018 depends on that guard actually running on pull
      requests; an absent step and a passing one look identical from the job's green tick. (FR-018)

      > **THE STEP LIST IS NOT READABLE ON THIS FORGE — verified, not assumed.**
      > `GET /repos/jumbleknot/mcm/actions/runs/<id>/jobs` → **404 page not found**, and the UI's
      > internal `POST /<owner>/<repo>/actions/runs/<id>/jobs/<n>` route is not reachable over the
      > API either. `GET /actions/runs/<id>` returns run metadata with no steps. Consistent with the
      > repository's existing finding that this forge exposes no log or artifact endpoint. The
      > failure-digest bundle is the usual way round that, but it publishes only on **failure**, and
      > both jobs here pass.
      >
      > **And a green tick genuinely cannot settle it**, exactly as this task warns. `naming` passed
      > on PR #185 (run 1706, task 5760) and `infra-image-scan` is expected to pass — but
      > `--check-expiring` **exits 0 today** (earliest expiry 2026-09-07, 25 days out), so a wrong
      > `if:` would produce precisely this green PR now and a blocked one from 2026-08-24. Observing
      > "green" would have been the false confirmation.
      >
      > **Substituted with a durable artifact instead of a one-off observation**, which is this
      > feature's own rule: `scripts/__tests__/allowlist-expiry-wiring.guard.test.mjs` asserts, in the
      > tooling tier that runs on every PR —
      > 1. exactly one `--check-expiring` step exists in `infra-image-scan`, it covers **both**
      >    allowlists, and it carries `if: github.event_name == 'schedule'`;
      > 2. that job still serves `pull_request` (or the guard's premise has changed);
      > 3. **no other workflow** invokes `--check-expiring` — a second unguarded copy would
      >    reintroduce the fault while the first assertion still passed;
      > 4. the override-consistency gate IS in `guardrails.yml`'s `naming` job, selftest-then-scan,
      >    and carries **no** event guard.
      >
      > **Mutation-tested, because a passing guard proves nothing until it has been seen to fail.**
      > Replacing the `if:` with `always()` → RED. Deleting the infra-image half of the step → RED.
      > Working tree restored clean afterwards (`git diff` empty).
      >
      > **Residual, stated rather than buried**: this pins the WIRING, not the runner's evaluation of
      > `github.event_name`. That expression is used identically elsewhere in these workflows. The
      > decisive behavioural test — make `--check-expiring` fail deliberately and confirm a pull
      > request stays green — costs a throwaway commit plus a full ~35-minute `app-e2e` cycle, and is
      > worth doing on the first PR raised *after* 2026-08-24, when the check is red on its own and
      > the experiment is free.
- [x] **T032** [P] [US5] Document the warning window in `security/sast/README.md` so the next person
      adding an entry knows when they will hear about it: the 14-day window, that an expiring entry
      still suppresses, that an expired one explains itself, and that unmatched entries are reported.
      **Type**: Documentation, no RED/GREEN.
      **Done when**: the README states the window and its three behaviours. (FR-028)

**Checkpoint**: all five stories complete.

---

## Phase 8 — Polish & cross-cutting

- [x] **T033** Run [quickstart.md](./quickstart.md) end to end and confirm each stated expectation,
      including that the three new test files **appear by name** in the
      `node --test scripts/__tests__/*.test.mjs` output. If they do not appear they are not being
      discovered — which reads as a pass.
- [x] **T034** Confirm the predicted signal behaviour: the first weekly `--check-expiring` run after
      merge is **green**, and the first red is **Friday 2026-08-28**, naming the `image-size` pair.
      Record the actual dates. A red earlier or later than predicted means the window constant or a
      classification boundary is wrong — the prediction is a test, not a note. (SC-005, SC-006)

      > **PREDICTION CONFIRMED against the live allowlists** (classifying the real 6 remaining
      > expiry-bearing entries at each future Friday, using the shipped `classifyExpiry`):
      >
      > | Friday | `--check-expiring` | Named |
      > | --- | --- | --- |
      > | 2026-08-14 | **green** | — |
      > | 2026-08-21 | **green** | — |
      > | **2026-08-28** | **RED** | `GHSA-w3rx-r6r6-pgpr` (10d), `GHSA-5p2g-fcmc-qvqq` (10d) |
      > | 2026-09-04 | RED | same pair (3d) |
      > | 2026-09-11 | RED | same pair (**-4d**, now expired) |
      >
      > Exactly R8's prediction: first red **Friday 2026-08-28**, naming the `image-size` pair. This
      > is a *derivation* from the shipped code and the live files, which is the whole prediction —
      > the remaining step is the trivial one of observing the actual run on the day.
      >
      > **SC-005 — OPERATOR DECISION (accepted with this as its proxy).** "No entry reaches its expiry
      > without 14 days' notice" is a claim about future scheduled runs and is not verifiable inside
      > the feature. It is accepted on the strength of the table above rather than rescoped or left
      > unproven: the mechanism, the window constant and both inclusive boundaries are verified, and
      > the first entry it will fire for is named with its date.
      >
      > Note the entry count SC-005 quantifies over is now **6**, not 8 — US3 deleted the two dated
      > 2026-08-31.
- [x] **T035** [P] Record this feature's learnings where `openwiki/INSTRUCTIONS.md` says they belong —
      into the **cited source** for any concept that cites a resource, not into a derived summary and
      never into the root `CLAUDE.md` index. Candidates: the schedule-disjointness arithmetic and its
      guard, the engine-bump residual risk of a major-only pin, the override key/value lockstep
      invariant, and the measured fact that a mis-keyed custom manager extracts zero **silently**.
> ### T036 STATUS — **evidence posted on all four; closure is deliberately merge-gated.**
>
> The task's own rule decides this: *"each only when its own acceptance criteria are met **and
> verified**"*, and *"closure is an explicit act, not a consequence of a merged pull request."* The
> fixes are on an unmerged branch, so nothing is on `main` yet and none of the four can honestly be
> called done. Closing them now would be closing against a branch.
>
> A detailed evidence comment is posted on each, and each names exactly what remains:
>
> | Item | Evidence posted | Remaining before closure |
> | --- | --- | --- |
> | **#160** | run 1704's exact `EBADENGINE` / `Unsupported node environment` extract; the fix and its guard; the major-pin-says-nothing-about-the-runtime lesson | a `schedule` or dispatched run **on `main`** at exit 0 with neither message |
> | **#153** | the disjointness arithmetic; the EDT/EST table showing the widened window is load-bearing; the cost re-measured at **10** groups, not 8 | a Friday run on `main` (08-14, then 08-21) turning Awaiting Schedule groups into open PRs |
> | **#152** | the RED/GREEN table (59/4 → 55/2, both advisories absent); lockfile resolution; build + web E2E; **and a correction** — its "extracts zero deps" claim is measurably false | merge |
> | **#154** | the whole warning tier; the 2026-08-28 prediction; **and the correction this task explicitly requires** — its prose says "seven live entries", the true count is **eight**, which its own table already agrees with | merge |
>
> #154's count correction was posted **before** any closure, as this task requires — closing against
> a wrong number was the specific thing to avoid.

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
