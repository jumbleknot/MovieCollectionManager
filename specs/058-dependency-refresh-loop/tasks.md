# Tasks: close the dependency-refresh gaps 057 left open

**Feature**: `058-dependency-refresh-loop` · **Date**: 2026-08-13
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md)

Format per `docs/templates/feature-test-tasks-template.md`. Every test task states its **Verify RED**
command, the expected failure, **and why that failure is the right one** — a test that goes red for an
unintended reason (a typo, a missing import, a file that does not parse) is not evidence of anything.

**Phase order is a requirement, not a convenience.** Phase A (#186) precedes Phase B (#184's refresh)
so that a partial landing cannot produce weekly refreshes nothing end-to-end tests (FR-025).

**Baselines to measure against** (all 2026-08-13, on `main` at `d615cb7`):

| Thing | Baseline |
| --- | --- |
| `node --test scripts/__tests__/*.test.mjs` | 653 tests passing |
| `pnpm nx preflight infrastructure-as-code` | 27 checks |
| `node scripts/check-override-consistency.mjs` | exit 0 — 11 keyed floors, 11 agreeing |
| `node scripts/sast-scan.mjs --scope full --only pnpm-audit` | 55 findings, 2 blocking |
| web E2E (dev container) | 135 passed / 39 skipped / 0 failed |

---

## Phase A — US1: a dependency PR is tested by the tier that can catch a bad floor (#186)

### T001 — Pin the six filter-wiring facts as a test

**Type**: New file | **Time**: 45m | **Risk**: Medium

**Spec reference**: [spec.md](./spec.md) US1 — FR-001…FR-006, FR-008

**Scenarios covered**:
- US1-AC1: a lockfile-only PR runs the end-to-end tier
- US1-AC2: the emulator-gated steps are not selected by a lockfile change
- US1-AC3: a workspace-manifest-only PR likewise runs the tier
- US1-AC4: the pull-request filter and the push paths filter agree
- US1-AC5: removing the end-to-end job's dependency on the filter fails by name

**File(s)**: `scripts/__tests__/app-ci-lockfile-filter.guard.test.mjs`

Parses `.forgejo/workflows/app-ci.yml` and asserts six facts. Note the shape trap recorded in
[data-model.md §4](./data-model.md): `filters` is a YAML **string** nested inside the `dorny/paths-filter`
step's `with:`, so it must be parsed as a *second* YAML document. Indexing into the outer parse yields
`undefined`, and an assertion against `undefined` can pass vacuously — which is the exact failure mode
this file exists to prevent, so the test must first assert that both filter sets are non-empty.

1. `app` contains `pnpm-lock.yaml` (FR-001)
2. `app` contains `pnpm-workspace.yaml` (FR-002)
3. `mobile` contains neither (FR-003)
4. `mobile ⊆ app` (FR-004) — asserted in a comment today and enforced nowhere
5. `push.paths` contains both (FR-005)
6. `jobs.app-e2e.if` references `needs.changes.outputs.app` (FR-006)

**Verify RED** (run before implementing):
```bash
node --test scripts/__tests__/app-ci-lockfile-filter.guard.test.mjs
```
**Expected RED**: 3 of 6 tests failing — the `app` filter lists neither dependency file, `push.paths`
does not list `pnpm-workspace.yaml`, and **the `mobile ⊆ app` assertion fails**.

**Why that is the right RED**: the first two are precisely the measured gap (research R2's table). The
remaining three assertions (filters parse non-empty, `mobile` excludes both files, `app-e2e` gated on
`app`) must be **GREEN from the start** — they describe behaviour that is already correct and that this
feature must not break. A run showing 6 failures means the test cannot read the file and is testing
nothing; a run showing 0 failures means it is not reading the filters at all.

> **ACTUAL RESULT — one unpredicted failure, and it was a real bug.** The `mobile ⊆ app` assertion was
> written expecting GREEN, on the strength of the workflow comment claiming *"It is a STRICT SUBSET of
> `app`"*. It came back RED: `scripts/ci-mobile-agent-flows.sh` and `scripts/maestro-run.sh` were in
> `mobile` and not in `app`. That makes them **inert** — `mobile` gates only steps *inside* `app-e2e`,
> and `app-e2e` requires `app == 'true'`, so a pull request touching only the Maestro runner set
> `mobile=true`, `app=false`, skipped the entire job, and ran **no mobile flow at all** while reading
> as covered. Fixed at the cause in T002 by adding both paths to `app`, per the repository's rule that
> a guard failing because you changed what it protects gets updated at the cause, never deleted — here
> the guard was new and the *premise* was already broken. Measured RED: 3 failing tests / 4 failing
> facts.

**Verified RED 2026-08-13**: `✖ 3` — app-filter assertion, subset assertion, push-agreement assertion.
`✔ 3` — parse/non-empty, mobile-exclusion, app-e2e gating.

---

### T002 — Add both files to the `app` filter and to `push:` paths; rewrite the superseded rationale

**Type**: Implementation | **Time**: 30m | **Risk**: Medium

**Spec reference**: same as T001, plus FR-007

**Prerequisite**: T001 complete and verified RED.

1. `changes.app` gains `pnpm-lock.yaml` and `pnpm-workspace.yaml`.
2. `push.paths` gains `pnpm-workspace.yaml` (`pnpm-lock.yaml` is already there).
3. `changes.mobile` gains **nothing** — the emulator half stays excluded (operator's cost decision).
   `changes.app` additionally gains `scripts/ci-mobile-agent-flows.sh` and `scripts/maestro-run.sh`,
   repairing the subset violation T001 uncovered (see the note there). Its stale "STRICT SUBSET"
   comment is rewritten to explain why the property is load-bearing rather than merely tidy.
4. **Rewrite, do not delete, the comment at `app-ci.yml:44`.** It currently argues that a lockfile PR
   deliberately skips the E2E suite. The replacement must carry the reasoning that supersedes it: 057's
   FR-013 (the E2E tier is the only one that catches a bad JS floor, because `nx test` passes over a
   build-time break) and the fact that 057 restored a bot that will now open these PRs weekly. A file
   that argues for the opposite of what it does is worse than one that argues for nothing.
5. **Record why `Cargo.lock` deliberately differs** (research R2): it has the same
   `push`/`pull_request` disagreement, but `mc-service-checks` runs clippy and the unit tier on every
   PR and both compile the crate, so a bad Cargo floor fails there. #186's third acceptance criterion
   explicitly permits a difference the file records.

**Verify GREEN**:
```bash
node --test scripts/__tests__/app-ci-lockfile-filter.guard.test.mjs
```
**Expected GREEN**: 0 failures — 6 assertions passing.

**Also run** (regression — the workflow must still parse for every other guard that reads it):
```bash
node --test scripts/__tests__/allowlist-expiry-wiring.guard.test.mjs
node --test scripts/__tests__/*workflow*.test.mjs
```
**Expected**: previously passing tests still pass.

---

### T003 — Mutation-test all six assertions

**Type**: Test verification | **Time**: 30m | **Risk**: Low

**Spec reference**: SC-003

**Prerequisite**: T002 GREEN.

A green wiring test proves nothing until each assertion has been shown to fail when its subject breaks.
Apply each mutation from [quickstart.md §2](./quickstart.md), one at a time, reverting between:

| # | Mutation | Must fail |
| --- | --- | --- |
| 1 | drop `pnpm-lock.yaml` from `app` | FR-001 assertion |
| 2 | drop `pnpm-workspace.yaml` from `app` | FR-002 assertion |
| 3 | add `pnpm-lock.yaml` to `mobile` | FR-003 assertion |
| 4 | add a path to `mobile` absent from `app` | FR-004 assertion |
| 5 | drop `pnpm-workspace.yaml` from `push.paths` | FR-005 assertion |
| 6 | change `app-e2e`'s `if:` to a literal `true` | FR-006 assertion |

```bash
# per mutation:
node --test scripts/__tests__/app-ci-lockfile-filter.guard.test.mjs   # expect 1 failure, named
git checkout -- .forgejo/workflows/app-ci.yml
```
**Expected**: exactly one named failure per mutation, and a clean tree after each revert. Mutation 6 is
the one that matters most — the other five are inert the moment `app-e2e` stops consuming the filter.

---

## Phase B — US2: the lockfile refreshes itself on a schedule (#184, option 4)

> **Do not start before Phase A is complete.** FR-025.

### T004 — Extend the renovate guard with the schedule-inheritance trap

**Type**: Test refactor | **Time**: 40m | **Risk**: Medium

**Spec reference**: US2 — FR-009…FR-012

**Scenarios covered**:
- US2-AC1: scheduled lockfile maintenance carries its **own explicit** window
- US2-AC2: that window intersects the workflow's weekly trigger under **both** DST offsets

**File(s)**: `scripts/__tests__/renovate-workflow.guard.test.mjs` (extended, not replaced)

Reuses the file's existing `cronSlots`, `expandCronField` and `windowSlotsInUtc` helpers and its
`TIMEZONE_OFFSETS` table — this is the same class of fault as #153, in the same pair of files, so it
belongs in the same guard rather than a new one.

Two assertions:
1. `renovate.json` declares `lockFileMaintenance.enabled === true` **and** a non-empty
   `lockFileMaintenance.schedule`. The failure message must name the trap explicitly: without its own
   key it inherits `["before 4am on monday"]` from the option's default (research R1) and can never fire.
2. That schedule intersects at least one workflow cron under **both** EDT and EST.

**Verify RED**:
```bash
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```
**Expected RED**: 1 test failing — `renovate.json` has no `lockFileMaintenance` key at all, so the
enabled/explicit-schedule assertion fails.

**Why that is the right RED**: it fails on the *absence of the setting*, which is today's true state.
The pre-existing two tests in this file (Node pinning, cron-in-window) must stay **GREEN** throughout —
if they go red, the extension broke the shared helpers rather than adding a case.

**Verified RED 2026-08-13**: `✖ 2 / ✔ 2` — the assertion was split into two tests (enabled+explicit,
and intersects-under-both-offsets) so a failure names *which* window drifted; both went red on the
absent key. Both pre-existing tests stayed green, confirming the shared `cronSlots` /
`windowSlotsInUtc` helpers were reused rather than disturbed.

---

### T005 — Enable `lockFileMaintenance` with an explicit window

**Type**: Implementation | **Time**: 20m | **Risk**: Medium

**Spec reference**: US2 — FR-009…FR-011, FR-013

**Prerequisite**: T004 complete and verified RED.

Add to `renovate.json`:

```json
"lockFileMaintenance": {
  "enabled": true,
  "schedule": ["* 2-4 * * 5"]
}
```

with a `description` recording **why the schedule is repeated rather than inherited** — measured, not
assumed: `renovate@44.29.3`'s option default already carries `schedule: ["before 4am on monday"]`, the
child wins over the top-level key, and that window (Monday 04:00–08:00 UTC under EDT, 05:00–09:00 under
EST) intersects neither `0 3 * * *` nor `0 7 * * 5` under either offset. Enabling it the obvious way
produces a setting that is on and can never fire, reporting nothing.

The window matches the global `schedule` exactly, per the operator's cadence decision: refreshes share
the existing `prConcurrentLimit 5` / `prHourlyLimit 2` throttles, and a crowded-out refresh defers a
week. The nightly schedule-exempt run still handles urgent advisories.

**Verify GREEN**:
```bash
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```
**Expected GREEN**: 0 failures — 3 tests passing (2 pre-existing + 1 new).

**Also run** (FR-013 — the config must validate under the pinned major):
```bash
npx --yes --package renovate@44 -- renovate-config-validator renovate.json
```
**Expected**: validation passes with no errors.

---

### T006 — Mutation-test the schedule trap

**Type**: Test verification | **Time**: 15m | **Risk**: Low

**Spec reference**: SC-004

**Prerequisite**: T005 GREEN.

```bash
# delete ONLY the "schedule" key from lockFileMaintenance, leaving enabled:true
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
git checkout -- renovate.json
```
**Expected**: 1 named failure stating that the inherited default window never intersects a workflow
cron. This is the single most important mutation in the feature: it proves the guard catches the trap
rather than the repository merely having avoided it once.

---

## Phase C — US3: the security gate names the remediation lever (#184, option 5)

### T007 — Freeze the incident and pin the decision table

**Type**: New file | **Time**: 1h | **Risk**: Medium

**Spec reference**: US3 — FR-014…FR-021 · **Contract**:
[contracts/override-lever.module.md](./contracts/override-lever.module.md)

**Scenarios covered**: US3-AC1, US3-AC2, US3-AC3, US3-AC4, US3-AC6

**File(s)**: `scripts/__tests__/override-lever.test.mjs`,
`scripts/__tests__/fixtures/fast-uri-reconstruction.json`

The fixture freezes the measured incident: `fast-uri@3.1.4` resolved, `fixAvailable: ">=3.1.5"`,
override `fast-uri@<3.1.4: '>=3.1.4 <4'`. It is required even though live cases exist (research R5),
because this feature's own PR-B remediates the live ones and the test must keep failing for the right
reason afterwards.

All 17 cases from the contract's coverage table, including the ones that must return `null`:
`undici@7.24.7` (resolution outside the override's range, FR-019), plain pins, unparseable halves, and
an already-remediated resolution.

**Verify RED**:
```bash
node --test scripts/__tests__/override-lever.test.mjs
```
**Expected RED**: the whole file errors — `Cannot find module '../override-lever.mjs'`.

**Why that is the right RED**: the module does not exist yet, so a module-resolution error is the
correct and only possible failure. It is **not** sufficient evidence on its own — a missing-module error
would look identical if the test asserted nothing. T008's GREEN, showing 17 passing assertions, is what
closes that gap; if GREEN reports materially fewer than 17, the cases were not written.

**Verified RED 2026-08-13**: `ERR_MODULE_NOT_FOUND: Cannot find module '…/scripts/override-lever.mjs'`,
`pass 0 / fail 1`. **Verified GREEN after T010**: `tests 17 / pass 17 / fail 0` — the count is the
evidence, per the caveat above.

> **Two of the 17 were wrong, and finding out cost the useful part of this task.** Recorded because
> both are the kind of thing that reads as a code bug and is not:
>
> 1. **Test 8 asserted a logically unreachable case.** It expected `raise-floor` for a fix floor
>    *below* the override's lower bound, from the contract's decision table. Reaching that branch
>    requires `R ≥ L` and `R < F`; adding `F < L` gives `R ≥ L > F > R`. Exhaustively confirmed over
>    the ordering space: zero satisfying combinations. **The table was wrong, not the module** —
>    `raise-floor` is entered only via `F ≥ U`. Contract and data-model corrected; the test now
>    documents the unreachability so it is not re-derived.
> 2. **Test 17 failed twice for reasons that were not the feature.** First
>    `Unknown argument(s): --report` — from `check-override-consistency.mjs`, which ran its CLI at
>    *top level* with no import guard, so importing it for its parsers ran the scan inside the gate's
>    process. Then `allowlist must be a YAML list` — my fixture used a mapping. Neither was the
>    advice logic. The first was a genuine latent bug and is fixed at the cause (T008).

---

### T008 — Implement the advice module; export the comparator it reuses

**Type**: Implementation | **Time**: 1.5h | **Risk**: Medium

**Spec reference**: US3 — FR-014…FR-016, FR-019…FR-021

**Prerequisite**: T007 complete and verified RED.

1. `scripts/override-lever.mjs` per the contract — `parseLocation`, `parseFixFloor`, `adviseLever`,
   `selectAdvice`, `formatAdvice`. Pure: no clock, no I/O, no `process.exit`.
2. **Export** `check-override-consistency.mjs`'s currently-private version comparator so this module
   imports it rather than reimplementing range logic. A second range dialect is how the two halves drift
   apart (FR-021). Only an *equality* helper exists, so add an ordered `compareVersions` and express
   `sameVersion` in terms of it — behaviour-preserving, and the guard's own tests prove it.
2b. **Add the missing import guard to `check-override-consistency.mjs`.** Its CLI body runs at top
   level, so importing it executes the scan and can `process.exit` out of the *importing* process,
   reporting that exit as the caller's result. Nothing had noticed because its own test shells out;
   this module is its first importer. Same `invokedPath === fileURLToPath(import.meta.url)` guard
   `check-sast-findings.mjs` already uses. **CLI behaviour must stay byte-for-byte identical** — the
   file's own tests shell out exactly as before and passing unchanged is the proof.
3. `raise-floor` messages MUST name **both** halves. A message naming only the value half reproduces the
   half-bump the repository already has a guard for.

**Do not weaken `check-override-consistency.mjs`.** Its rule, scope and exit codes are untouched; only a
function becomes exported. Its own tests passing unchanged is the proof (T011).

**Verify GREEN**:
```bash
node --test scripts/__tests__/override-lever.test.mjs
```
**Expected GREEN**: 0 failures — 17 assertions passing.

---

### T009 — Pin the invariant that advice cannot change the exit code

**Type**: Test | **Time**: 30m | **Risk**: Medium

**Spec reference**: US3 — FR-017, FR-018 (AC4, AC5)

**Scenarios covered**: US3-AC4 (advice on non-blocking findings), US3-AC5 (exit code unchanged)

**File(s)**: `scripts/__tests__/override-lever.test.mjs` (appended) or the existing SAST gate test file,
whichever already owns end-to-end gate invocation.

Runs `check-sast-findings.mjs` over a report whose **only** advice-eligible findings are non-blocking,
and requires **exit 0** plus the advice section present in stdout. This is the single assertion standing
between "improve the message" and "silently add a second blocking axis alongside severity and scope" —
which would red `main` on merge for the two live cases.

**Verify RED**:
```bash
node --test scripts/__tests__/override-lever.test.mjs
```
**Expected RED**: 1 failing assertion — the advice section is absent from the gate's output (exit 0
already holds, since the gate does not yet know about advice).

**Why that is the right RED**: the exit-code half of this test is GREEN before implementation **by
design** — it asserts something that must not change. Only the output half may go red. A RED on the exit
code would mean the fixture is wrong (it contains a blocking finding), not that the feature is missing.

---

### T010 — Wire the advice into the gate's output

**Type**: Implementation | **Time**: 45m | **Risk**: Medium

**Spec reference**: US3 — FR-015…FR-018

**Prerequisite**: T009 complete and verified RED.

`check-sast-findings.mjs` reads `pnpm-workspace.yaml`'s `overrides:`, calls `selectAdvice`, and prints a
dedicated section when the result is non-empty — alongside the existing `EXPIRING SOON` / `EXPIRED` /
`UNMATCHED ENTRIES` sections, following how `allowlist-expiry.mjs` is already consumed.

**Nothing in this task may touch the exit-code path.** The gate's contract
(`specs/033-sast-semgrep/contracts/check-sast-findings.cli.md`) stands: exit 1 iff an un-allowlisted
blocking finding is present, exit 2 on bad input.

**Verify GREEN**:
```bash
node --test scripts/__tests__/override-lever.test.mjs
node scripts/check-sast-findings.mjs --selftest
```
**Expected GREEN**: 0 failures; selftest ok.

---

### T011 — Run against live `main` and confirm the guard is unweakened

**Type**: Verification | **Time**: 30m | **Risk**: Low

**Spec reference**: SC-006, SC-008

**Prerequisite**: T010 GREEN.

```bash
node scripts/sast-scan.mjs --scope full --only pnpm-audit
node scripts/check-sast-findings.mjs
node scripts/check-override-consistency.mjs
node scripts/check-override-consistency.mjs --selftest
```

**Expected**:
- **Finding count 55, 2 blocking** — check the count, not the exit code. The bare `--scope full` scan
  fail-closes (semgrep.dev is outside the egress allowlist by design) and leaves a 0-finding report the
  gate passes **vacuously**; `--only pnpm-audit` is the remedy.
- The advice section names `hono 4.12.29` and `undici 6.27.0`, and **omits** `undici 7.24.7`.
- Override guard: exit 0, 11 keyed floors, 11 agreeing — **unchanged** (SC-008).

---

## Phase D — US4: the record (#184 option 1; item #152)

### T012 — Record the two-fault decision in the bot's rationale

**Type**: Documentation | **Time**: 30m | **Risk**: None

**Spec reference**: US4 — FR-022

`renovate.json`'s `description` must distinguish, in terms a later reader cannot conflate:

- **the half-bump fault** — the bot rewrites an override's value and has no mechanism for rewriting a
  depName, so every floor raise it proposes is a half-bump by construction. **Decision: option 1,
  accept.** `check-override-consistency.mjs` fails a half-bump by name on every PR, floor raises are
  hand-written in practice, and the option-2 regex manager stays rejected on the measured grounds 057
  already recorded (double-management; suppressing the built-in manager also drops
  `postcss`/`@expo/dom-webview`/`react-dom`).
- **the stale-lockfile fault** — the bot proposes *nothing*, because the range already permits the fix
  and it reasons about the manifest rather than the lockfile. **Decision: options 4 + 5**, delivered by
  this feature. This is the one that cost ten days and reddened `main`.

---

### T013 — Correct the superseded "extracts zero dependencies" claim

**Type**: Documentation | **Time**: 30m | **Risk**: None

**Spec reference**: US4 — FR-023 · **Research**: R6

Add a **dated correction note** — do not rewrite the historical record — to:

- `specs/057-dependency-security-loop/research.md` (~lines 125, 127, 139)
- `specs/057-dependency-security-loop/spec.md`
- `docs/proposals/PRD-ForgejoIssueTracking.md`

`renovate.json` and 057's `tasks.md` already carry the correction; leave them alone.

The truth: run 1704 (2026-08-13, head `6afc2c8`) extracted **twelve** dependencies from
`pnpm-workspace.yaml` via the built-in npm manager. There is no zero baseline. This matters beyond
tidiness — the false premise is what made a regex `customManager` look like a free win, and it is why
#184 was originally filed against the wrong fault.

```bash
grep -rn "extracts zero\|zero dep" --include=*.md . | grep -v node_modules
```
**Expected**: every remaining hit sits adjacent to a dated correction.

---

### T014 — Knowledge-bundle updates, with fingerprints

**Type**: Documentation | **Time**: 45m | **Risk**: Low

**Spec reference**: US4 — FR-024

Update `openwiki/projects/ci-cd-pipeline.md` (the filter change and why the two filters now agree) and
`docs/runbooks/sast-scanning.md` (the new advice section and how to read it).

`openwiki/projects/ci-cd-pipeline.md` is **[canonical]** — any edit ships with its fingerprint updated
in the **same** change:

```bash
node scripts/check-openwiki-governance.mjs --fingerprint openwiki/projects/ci-cd-pipeline.md "<section>"
node scripts/check-openwiki-governance.mjs
```
**Expected**: governance check passes.

---

## Phase E — verification and delivery

### T015 — Full sweep

**Type**: Verification | **Time**: 30m | **Risk**: Low

**Spec reference**: all

```bash
node --test scripts/__tests__/*.test.mjs
pnpm nx preflight infrastructure-as-code
```
**Expected**: test count **above** 653 — an unchanged count means the new files were not discovered by
`guardrails.yml:147`'s glob, so check the number rather than the colour. Preflight: 27 checks passing.

---

### T016 — Open PR-A

**Type**: Delivery | **Time**: 30m | **Risk**: Medium

**Spec reference**: research R7

Push a **real branch**, then `POST …/pulls` with the `git credential fill` credential — **not**
`MCM_FORGE_TOKEN`, which is read-only and 403s. **Never AGit**: a `refs/pull/N/head` head runs with no
Actions secrets, and the empty nx cache token surfaces as a bogus `Misconfigured remote cache endpoint`.

`app-ci.yml` is itself in the `app` filter, so PR-A runs the full end-to-end suite — expected and
correct: a change to the suite's gating must re-prove the suite.

```bash
node scripts/ci-status.mjs watch <pr>   # --timeout is in SECONDS
```
**Expected**: all required checks green. Verify the merge landed with
`git merge-base --is-ancestor <sha> origin/main` — the API's `merged: true` does **not** mean your
commits did.

---

### T017 — PR-B: the observation #186 actually requires

**Type**: Verification | **Time**: 45m + CI | **Risk**: Medium

**Spec reference**: SC-001, SC-002, SC-007 · **Prerequisite**: T016 merged.

```bash
pnpm update hono undici --lockfile-only
git status --porcelain      # MUST show pnpm-lock.yaml and NOTHING else
```

If any other file changed, **the observation is void** — a second changed path could be what matched the
filter. This PR's content is exactly the remedy T011's advice recommends, so one pull request discharges
both SC-001 and SC-007.

**Expected**: `app-ci/app-e2e` reports a real conclusion, **not `skipped`** (it was `skipped` on both PR
#185 and PR #187). Then re-run T011's scan: `hono` and `undici` findings gone **by count**.

**Stated limit, to be repeated in the evidence comment**: the job's conclusion is observable; its step
list is not (`/actions/runs/<id>/jobs` → 404). That the emulator half did not run rests on T003's
mutation-tested wiring assertion, not on an observation. Do not claim otherwise.

Before any local web E2E on this branch, force-recreate the BFF or you test the **old** image:
```bash
pnpm nx build mcm-app
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-nonsecure \
  up -d --force-recreate mcm-bff-service-nonsecure
```
`pnpm nx e2e mcm-app` cannot run here — use the Playwright container recipe in
`docs/runbooks/devcontainer.md` §3; `--user "$(id -u):$(id -g)"` is not optional. Baseline 135/39/0.

---

### T018 — Close #186 and #184 with evidence

**Type**: Delivery | **Time**: 30m | **Risk**: None

**Spec reference**: SC-009, SC-010

**#186** closes after T017: post the end-to-end job's conclusion on the lockfile-only PR, the accepted
cost, and the recorded reason the two filters now agree (and why `Cargo.lock` deliberately does not).

**#184 does not close yet.** SC-009 requires the **first Friday run after merge** to produce a
`lock-file-maintenance` proposal. The configuration being correct is necessary, not sufficient —
research R1 exists precisely because a config that looks right can be one that never fires.

Traps when checking for that run: a dispatch returns 204 and is **invisible** in `/actions/tasks` until
it starts (an empty listing is not evidence of failure; re-dispatching queues duplicates), `inputs`
values must be strings, and a **successful** run publishes no failure digest so its log is unreadable.

Close #184 only once the proposal is observed, with: the decision across options 1–5 distinguishing the
two faults, the reconstruction result (T007/T011), and confirmation that
`check-override-consistency.mjs` still passes unweakened.

---

## Dependency graph

```text
T001 → T002 → T003 ─┐
                    ├→ T015 → T016 → T017 → T018
T004 → T005 → T006 ─┤              (needs Friday run for #184)
                    │
T007 → T008 ─┐      │
             ├→ T011┤
T009 → T010 ─┘      │
                    │
T012, T013, T014 ───┘
```

Phase A strictly precedes Phase B (FR-025). Phase C is independent of A and B and may run in parallel
with either. Phase D depends on the decisions being final, not on the code.
