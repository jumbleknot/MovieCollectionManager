# Tasks: `app-e2e` reliability cluster

**Feature**: 054-app-e2e-reliability-cluster
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Contract**: [contracts/run-health-signal.md](./contracts/run-health-signal.md)

Every test task follows the tasks-template's **Verify RED then Verify GREEN** rule: the test must be seen
failing against the unfixed code before the fix lands, or it is not evidence.

**Format**: `[ID] [P?] [Story] Description` — `[P]` = parallelisable (different files, no dependency).

## Standing rules for this feature

These are not advice; three of them were each learned by being got wrong in this thread.

1. **Judge by counts** — `failed / flaky / passed / skipped / did-not-run` — never by exit status.
2. **Two runs is not a sample.** Every claim states the number of runs it rests on. See the evidence
   standard in [plan.md](./plan.md#evidence-standard-fixed-in-advance).
3. **Do not re-run a red `app-e2e` as a reflex.** Read US3's `verdict=` field first, then the Anthropic call
   count in the bundle's gateway log.
4. **Check the mechanism; do not assert it.** Three separate times in this thread a session described how
   something worked from expectation rather than from reading it. Each was checkable in seconds.
5. **`workflow_dispatch`, not push** — `guardrails` and `app-ci` scope `push:` to `main`. A dispatched run
   posts **no** commit status, so `ci-status status --sha` says "waiting" forever regardless of outcome; read
   the run's own `status` field (`running/success/failure/skipped`, not a GitHub-style conclusion), and LIST
   the package versions rather than constructing a bundle name from `run_number`, which is offset from the id.

---

## Phase 1 — US1: a verdict about CI describes the current state of CI (P1)

**Goal**: a stale `failure` after a successful re-run of the same context stops blocking.
**Independently verifiable**: unit only, no CI run.

- [x] **T001** [US1] Add the reproduction from item #176 to `scripts/__tests__/ci-status.test.mjs`: one
      context with an older `failure` and a newer `success` on the same event resolves to `passed`, the
      verdict is mergeable, and the context appears exactly once. **Verify RED.**
      *(Done 2026-08-11: RED confirmed — `(ww)` failed with `blocking: 1` and `mergeable: false`,
      reproducing item #176 exactly. Cases `(ww)`, `(ww3)`, `(ww5)` added.)*
- [x] **T002** [P] [US1] Add the reverse case to the same file — an older `success` and a newer `failure`
      resolve to `failed` — plus a case asserting `foo (push)` and `foo (pull_request)` stay independent and
      may disagree, and a case where two statuses share a `created_at` (stable tiebreak). **Verify RED** for
      the first, GREEN-on-current for the others (they pin behaviour that already works). (FR-002, FR-004)
      *(Done 2026-08-11: `(ww2)` newest-failure-wins and `(ww4)` event-suffix independence both pass on
      the UNFIXED code, which is the point — they guard against an "any success passes" shortcut that
      would satisfy T001 while breaking the dangerous direction. `(ww5)` equal-timestamp tiebreak was
      RED: two entries survived where one was expected.)*
- [x] **T003** [US1] Add `collapseToNewestPerContext` to `scripts/ci-status.mjs` and apply it between
      `selectEventContexts` and the `.map` in `computeMergeVerdict`. Key on the **full context string**, not
      on `parseContext(s).job` — that is what keeps the event suffixes distinct and keeps an unsuffixed
      context distinct from a suffixed one. Order by `created_at`, original index as tiebreak.
      **Verify GREEN (T001–T002).** (FR-001, FR-003, SC-001)
      *(Done 2026-08-11: GREEN — 5/5 new cases. `ci-status.test.mjs` 86/86 pass, 0 fail, 0 skipped;
      collected total ROSE 81 → 86, which is the check that distinguishes a fix from a shrunk suite.
      Whole tooling tier `node --test "scripts/__tests__/*.test.mjs"`: **582 pass, 0 fail, 0 skipped**.)*

---

## Phase 2 — US2: a green run publishes its counts (P1)

**Goal**: the five counts and the contention triple are readable for a run that PASSED.
**Depends on**: nothing. **Blocks**: every later story's ability to read a green run.

- [x] **T004** [US2] Add cases to `scripts/__tests__/ci-failure-digest.test.mjs` pinning the three-way gate:
      `cancelled` → no publication (unchanged); `failure` → `digest` mode (unchanged); anything else →
      `counts` mode. **Verify RED** on the two new expectations. (FR-005)
      *(Done 2026-08-11: cases `(mm)`–`(mm4)` added, all RED. Two EXISTING assertions encoded the old
      contract and were updated rather than deleted — `(g3)` now asserts the property it actually
      guards (a passing job never emits a FAILURE digest) instead of a flag that now means something
      wider, and `(dd)`'s dropped-env guard is unchanged and is why counts is gated on an explicit
      `success`.)*
- [x] **T005** [US2] Add a case pinning that `counts` mode with **no** counts sources present publishes
      nothing and still emits its outcome line — the self-limiting behaviour that keeps every job other than
      `app-e2e` out of the package registry without a job allowlist. **Verify RED.**
      *(Done 2026-08-11: `(mm5)`/`(mm6)` RED, plus `(mm9)` driving the real process — a green `affected`
      job publishes nothing and says "this job runs no e2e counts steps".)*
- [x] **T006** [US2] Extend `shouldPublish` in `scripts/ci-failure-digest.mjs` to return a `mode`, and branch
      `run()` on it. `counts` mode collects only the `e2e-result-gate` and `e2e-contention-tally` `step:`
      sources, uploads a small bundle version via the existing `bundleVersion(runId, job)` naming, and
      publishes **no** PR comment. **Verify GREEN (T004–T005).** (FR-005, FR-006)
      *Forward reference, RESOLVED during implementation*: the third source, `e2e-turn-tally`, does not
      exist until **T013** — but naming it in `COUNTS_SOURCES` now costs nothing, because an absent
      source is simply not collected. It is listed up front, so T013 adds only the step.
      *(Done 2026-08-11: GREEN. **Deviation, recorded in plan.md**: the mode table said "anything else →
      counts"; it is now "explicit `success` → counts, unknown → nothing", because case (dd) exists to
      stop a dropped `CI_DIGEST_JOB_STATUS` from publishing and the looser rule would have resurrected
      that bug. **Second deviation**: `COUNTS_SOURCES` names `step:e2e-turn-tally` NOW rather than in
      T013 — an absent source is simply not collected, so naming it early costs nothing and removes the
      forward reference entirely.)*
- [x] **T007** [US2] Add a case asserting that a **thrown** error inside `counts` mode still exits 0 and
      leaves the job's own result untouched. A reporter must never fail the build it measures.
      **Verify RED against a deliberately throwing stub, then GREEN.** (FR-007)
      *(Done 2026-08-11: `(mm8)` drives the REAL process with a dead transport — exit 0, and the counts
      still reach the job log. Asserted against the process rather than reasoned from the shared
      try/catch, mirroring how `(ii2)` pins the same property for the digest path.)*
- [x] **T008** [US2] Verify retention actually prunes the new versions: read `selectExpiredVersions` and
      `RETENTION_DAYS`, and add a case covering a counts version older than the retention window.
      **Do not assume it applies** — confirm the pruning path runs on a `counts`-mode publish too. (FR-008)
      *(Done 2026-08-11: `(mm7)` shows `selectExpiredVersions` is version-agnostic and passed on the
      UNFIXED code — so the selector was never the question. The real gap was the CALL: `pruneExpiredBundles`
      ran only on the digest path. `publishCounts` now calls it too, which is what actually bounds a
      channel that fires on every green run rather than only on failures.)*
- [ ] **T009** [US2] **Read the counts back, from outside CI.** Dispatch `app-ci`, let `app-e2e` PASS, then
      from a working session LIST the generic-package versions (never construct the name — `run_number` is
      offset from the run id), fetch the counts bundle, and record all eight numbers:
      `failed / flaky / passed / skipped / did-not-run` plus `refresh_total / refresh_429 / session_evicted`.
      No re-run, no SSH to the runner. **This task, not T006, is what SC-002 asserts** — an implementation
      that publishes and a channel that can be read are different claims, and this feature exists because
      that difference was assumed once already. (SC-002, FR-005, FR-006)
- [x] **T010** [US2] Update `docs/runbooks/ci-diagnostics.md`: how to read a **passing** run's counts, and
      the fact that this channel now exists at all. State the bundle-name trap (`run_number` is offset; LIST
      the versions).
      *(Done 2026-08-11: new section "Reading a PASSING run's counts" with the LIST-don't-construct curl,
      the explicit-`success` gating, the self-limiting behaviour and the `CI_DIGEST_TOKEN` requirement.
      The old section's closing line — "to read counts for a green run today you must make it fail, which
      is not a plan" — is marked closed rather than deleted, so the follow-up's resolution is traceable
      from where it was recorded. `check-openwiki-governance` and `check-openwiki-okf` both exit 0.)*

---

## Phase 3 — US3: a collapsed run says so, and leaves client-side evidence (P1)

**Goal**: FR-009 to FR-012. **This is the pivot** — it is what makes US4's and US5's verdicts readable, and
what turns every subsequent dispatched run into a sampling opportunity for #173.
**Depends on**: US2 for the signal to be readable on a green run.

### (a) The run-health verdict

- [x] **T011** [US3] Write `scripts/__tests__/e2e-turn-tally.test.mjs` against fixture logs: a healthy
      signature classifies `healthy`, a collapsed one `collapsed`, an unreadable gateway log and a zero
      executed count both classify `indeterminate`, and the script exits **0** in every case including the
      zero-count one (the `grep -c` exits-1 trap). **Verify RED.**
      *(Done 2026-08-11. **RED was nearly invisible, and that is a finding.** With the test file
      written and the script not yet created, the run reported `0 pass / 3 fail / **12 skipped**` on
      Linux with a perfectly usable bash: `shellCanRunScript` probes with `test -r "$SCRIPT"`, which
      is false for a MISSING file exactly as for an unreachable one, so it skipped 12 cases while
      blaming WSL. A skip reads as a pass — the failure class 051 exists to remove, inside the helper
      written to prevent it. Filed as item **#178**. Re-verified against an empty stub: **14 fail,
      1 pass, 0 skipped**, which is the real RED.)*
- [x] **T012** [US3] Write `scripts/e2e-turn-tally.sh`, mirroring `scripts/e2e-contention-tally.sh`'s
      structure, with the classifier in a `classify_run_verdict` shell function. Emit the `[e2e-turns]` line
      from [contracts/run-health-signal.md](./contracts/run-health-signal.md), normalised by executed agent
      spec count. **Verify GREEN (T011).** (FR-009)
      *(Done 2026-08-11: GREEN, 12/12 behaviour cases. **The contract's denominator was wrong and is
      corrected**: it said "per spec file" quoting 17–19 vs 1.4–2.2, which was arithmetic on a guessed
      file count — there are 23 agent/dock spec files, giving ≈6.7. Recomputed from the 177-test total
      the PRD actually recorded: healthy 88–95, collapsed 22–32 posts per 100 tests, floor 50.
      Integer-scaled by 100 because bash has no floats.)*
- [x] **T013** [US3] Add the step to `.forgejo/workflows/app-ci.yml` under `ci-log-step.sh`, `if: always()`,
      positioned **after** the web E2E and **before** `Tear down CI stacks` — and add the comment saying why
      that position is load-bearing, alongside the contention tally's. (`e2e-turn-tally` is already in
      `COUNTS_SOURCES` — T006 listed it up front, so nothing is left to remember here.)
      *(Done 2026-08-11. **Both wiring assertions first failed against a correctly-wired workflow**,
      because `indexOf` matched COMMENT PROSE — the contention tally's own comment says it "must
      precede `Tear down CI stacks`" 3 kB earlier in the file. A grep that matched the wrong thing is
      the trap this feature is about, and it is not less of one for being in the test. Re-anchored on
      the run commands and the `- name:` headers, plus a new case pinning that the tally carries NO
      `--gate`. 16/16.)*
- [x] **T014** [US3] **Fix the healthy floor and record its provenance.** The contract deliberately carries
      no number yet. Set it from the calibration runs, and write into the contract file: the five run ids it
      came from, the healthy and collapsed ranges, and the sentence stating it is a triage aid rather than a
      proof.
      *(Done 2026-08-11: floor **50 posts per 100 tests**, from runs 1614/1619 (healthy, 95/88) and
      1621/1622/1633 (collapsed, 24/32/22) — 1.8× below the lowest healthy run and 1.6× above the
      highest collapsed one. The two boundary runs are pinned as their own test cases, so a threshold
      change that misclassifies either fails rather than drifts.)*

### (b) Client-side evidence

- [x] **T015** [US3] Write `frontend/mcm-app/tests/e2e/web/fixtures/client-evidence.ts`: an auto-fixture
      attaching `console`, `pageerror` and `requestfailed` listeners plus a record of requests to the BFF
      agent routes, buffered in a ring of the **last 500 entries per test** and flushed to disk **only** when
      `testInfo.status !== testInfo.expectedStatus`. On overflow drop the oldest and **record how many were
      lost in the written file** — a truncated capture must never read as a complete one. (FR-010, FR-012)
      *(Done 2026-08-11: the pure logic lives in `client-evidence-buffer.ts`, dependency-free, because
      `/tests/e2e/` is in jest's `testPathIgnorePatterns` and a module importing `@playwright/test`
      cannot be loaded by jest at all — so redaction would have been testable only inside a 30-minute
      E2E run. Request BODIES are never recorded; `msg.args()` is never touched (it would serialise
      live handles).)*
- [x] **T016** [US3] Add a unit test pinning redaction: `Cookie`, `Set-Cookie` and `Authorization` headers
      are dropped and request bodies are never recorded. **Verify RED against an unredacted draft, then
      GREEN.** "We do not log secrets" is exactly the claim that needs a test rather than a comment. (FR-011)
      *(Done 2026-08-11: `tests/unit/client-evidence-buffer.test.ts`, 7 cases. **The first RED was
      worthless and was redone**: module-not-found collected 0 tests, which proves the file fails to
      load, not that the assertions discriminate. Re-run against an inert stub: 5 failed / 2 passed /
      7 collected — the real RED. GREEN 7/7. `x-agent-config` is on the redaction list and is the easy
      one to miss: it carries the member's model-provider API key.)*
- [x] **T017** [US3] Compose the fixture into the `test` exported by `fixtures/worker-session.ts`, and write
      the accepted boundary into `docs/runbooks/e2e-testing.md`: `auth.spec.ts`, `security-headers.spec.ts`
      and `bff-prod-lifecycle.spec.ts` deliberately do not import it (the fixture replaces the
      `storageState` option), so they get no capture — and that is where the collapse does not manifest.
      *(Done 2026-08-11: `worker-session.ts` now composes from `./client-evidence` instead of
      `@playwright/test`. `e2e-worker-session.test.mjs` still passes 7/7, so the both-ways guard on
      which specs may import the session fixture is intact.)*
- [x] **T018** [US3] Ensure the capture output lands in the directory the `failure()` collect step already
      sweeps into the bundle. **Check the step, do not assume the path.**
      *(Done 2026-08-11: checked rather than assumed — the collect step builds `container-logs/` and
      copies it to `~/mcm-ci-last-failure`, which is what `collectEvidence` reads, and `selectSources`
      only admits `*.log` / `_ps.txt`. The Playwright container mounts the workspace at `/work`, so
      the fixture's `client-evidence/*.log` reaches the host; the collect step now copies them in
      with an `_` prefix, which ranks them above ordinary container logs. Added to
      `frontend/mcm-app/.gitignore`.)*
- [ ] **T019** [US3] **Measure the perturbation against a stated threshold** (FR-012): run the web suite with
      and without the capture and compare. **Pass = wall clock within 5% of the pre-capture baseline AND the
      five counts identical.** Outside that, the capture is the suspect and is re-scoped before anything else
      is concluded from a run carrying it. **Record both wall clocks and both count sets** — a threshold with
      no recorded measurement is not a check.
      *(BLOCKED 2026-08-11, and the blocker is item #168 itself: this needs two FULL local suite runs,
      and on the current `dev-realm` a full local run cannot produce a valid result — 300 s tokens put
      six workers back into the contention 052 removed from CI (measured: 44 min, 62
      `refresh_rate_limited`). **Resequencing, recorded**: US6 was placed after US4 because "US4's
      identity model determines the shape of the fix" — but the approach chosen in plan.md is option 1
      (raise the dev-realm lifespan), which does not depend on the identity model at all. So US6 is
      independent and moves BEFORE this task, which then measures locally instead of burning two CI
      dispatches.)*

---

## Phase 4 — US4: one identity per worker (P2)

**Goal**: FR-013 to FR-017. The root cause behind #165, 052's contention and the session-cap near-miss.
**Depends on**: US3 (so its verification runs are readable and double as collapse samples).

- [ ] **T020** [US4] **Check first, then build**: confirm that `check-realm-consistency.mjs` compares the
      **username set** between the two realm exports (it does — `users only in ci-realm` is one of its
      failure messages). This is why the per-worker users are minted at **runtime** through the Admin API
      rather than baked into `ci-realm.json`. Record the finding in the plan if it has changed.
- [ ] **T021** [US4] Extend `tests/e2e/web/setup/keycloak-admin.ts` usage in `global-setup.ts` to mint N
      per-worker users (N = the resolved worker count), assign `mc-user`, log each in, and write
      `authFileForWorker(i)`. Reuse the existing minting path rather than adding a second one.
- [ ] **T022** [US4] Seed the fixture dataset, the default collection and the agent config **per user**
      (`agent-config-seed.ts`, `large-library-seed.ts`, `assistant-add-flow.ts` as applicable).
- [ ] **T023** [US4] **Measure the setup cost before anything depends on it** (FR-014): global-setup wall
      clock before and after, and the number of live credential probes the N× agent-config PUT performs.
      **Record both as numbers in this task.** If the probes meet a provider rate limit, serialise the
      seeding or share the config read-only — and say which was done and why.
- [ ] **T024** [US4] Make `e2e-cleanup.ts`'s teardown worker-scoped. With per-user data, `listCollections`
      returns only the calling worker's collections, so a blanket teardown becomes correct again — remove the
      fixture-name special-casing that existed only to survive the shared identity, and pin the new
      behaviour with a test. (FR-013)
- [ ] **T025** [US4] Enumerate the specs that deliberately assert on global/shared state and confirm each
      still works: `admin-registration.spec.ts` (realm-wide self-registration flag), `bff-prod-lifecycle.spec.ts`
      (real logout), `auth.spec.ts` and `security-headers.spec.ts` (deliberately unauthenticated). Write the
      list into `docs/runbooks/e2e-testing.md`. (FR-015)
- [ ] **T026** [US4] Update `scripts/__tests__/e2e-worker-session.test.mjs` for the per-user model, keeping
      its both-ways assertion that unauthenticated specs do **not** import the session fixture.
- [ ] **T027** [US4] Re-evaluate `MAX_E2E_WORKERS` against `MAX_CONCURRENT_SESSIONS` **using T023's number**,
      and justify the value chosen in the config comment — including the case where it stays at 6 because the
      wall clock does not permit more. (FR-016)
- [ ] **T028** [US4] Two consecutive `workflow_dispatch` `app-ci` runs. Compare the **failure sets by test
      identity**, not by count — a shrinking-but-still-varying set means the contention was reduced, not
      removed, and must be reported as reduced. Record US3's `verdict=` for each run; a collapsed run is
      excluded and named, not interpreted.
      **For every residual failure, state explicitly whether a cross-worker cause was excluded and how** —
      another worker's teardown, its agent-config change, or its fixture mutation. SC-005 is that
      exclusion, not the bare failure count, and an unexamined failure leaves it unproven. (SC-005, SC-011)
- [ ] **T029** [US4] Confirm `agent-*.spec.ts` shows a non-zero executed count and **zero** skips in both
      runs, and that no spec was skipped, deselected, narrowed or gated to reach the result. (FR-017, SC-009)

---

## Phase 5 — US5: a follow-up typed mid-answer is not lost (P2)

**Goal**: FR-018 to FR-022. **Depends on**: US3's `verdict` (not on #173's mechanism — see
[plan.md](./plan.md#us5--re-land-the-queued-turn-judged-against-the-verdict)).

- [x] **T030** [US5] Reinstate 053's unit tests in `frontend/mcm-app/src/hooks/use-assistant.test.tsx`: a
      message sent while `agent.isRunning === true` is delivered exactly once when the run completes; the
      idle path still fires immediately; a delivered message is not delivered twice.
      **Verify RED.** Drive the transition by flipping `isRunning` on a **stable** agent object — 053 recorded
      that a double returning a fresh `copilotkit` per render repairs the bug it is meant to catch.
      *(Done 2026-08-11: RED 5 failed / 3 passed / 8 collected. The double is a module-level singleton.
      **A second correction of the same class was needed**: the first version mutated `isRunning`
      without the intermediate render CopilotKit actually produces, so the dependency never observed
      true→false and the case failed against a CORRECT fix. `useAgent` re-renders when `isRunning`
      flips — it is how the dock's thinking state appears at all — so the sequence now models it.)*
- [x] **T031** [US5] Reinstate the empty-registry case: a send with no resolvable agent is delivered once an
      agent registers. **Verify RED against a deliberately broken flush, then GREEN.** (FR-020)
      *(Done 2026-08-11: passes throughout, which is the point — it pins the behaviour the queue was
      originally written for, and a fix that traded one silent drop for another would break it.)*
- [x] **T032** [US5] Restore `isRunning` in the flush effect's dependency list in
      `frontend/mcm-app/src/hooks/use-assistant.tsx`, keeping `pendingRef.current = null` **before** `fire`.
      **Verify GREEN (T030–T031).** Land as its own commit. (FR-019, FR-021)
      *(Done 2026-08-11, commit `4ab0ba9` on its own: 5 failed → 5 passed, the two mid-answer cases
      flipping. Unit tier 1191 passed with only the 3 known FIFO failures outstanding.)*
- [x] **T033** [US5] Add tests for the second-message case: with one message already queued, a second is
      **either delivered or its supersession surfaced** — never silently lost — and the bound is enforced.
      **Verify RED.** (FR-022)
      *(Done 2026-08-11: 3 cases, all RED after T032 — order, no-silent-discard, and the bound.)*
- [x] **T034** [US5] Implement the FIFO queue bounded at **8** messages, replacing the single slot; on
      overflow **refuse the send and surface it** rather than dropping it. Land as a **separate commit** from
      T032 so a suite regression can be attributed to one of the two. **Verify GREEN (T033), and re-verify
      T030–T031.** If the replay semantics prove wrong under E2E, fall back to the single slot plus a visible
      pending indicator — which satisfies FR-022 the other way — and **record that decision here** rather
      than taking it quietly.
      *(Done 2026-08-11 as a separate commit `1798189`. **Design point worth keeping**: the flush
      delivers ONE message per run completion rather than draining the queue, so turns stay
      serialised — `fire` starts a run and the next flush is driven by that run finishing, exactly as
      if the member had waited. Draining would fire concurrent runs on one agent. `shift()` happens
      BEFORE `fire`, which keeps delivery at-most-once under React 19 StrictMode's double-invoked
      effects. GREEN 8/8. **The single-slot fallback was NOT needed.**)*
- [x] **T035** [US5] `pnpm nx test mcm-app`, `pnpm nx lint mcm-app`, `pnpm nx typecheck mcm-app` — all clean.
      *(Done 2026-08-11: **1194 passed / 123 suites, 0 failures, 0 skipped**; lint 0 errors (14
      pre-existing warnings, none in the new files); `tsc --noEmit` clean after typing the `getAgent`
      double to allow `undefined` — without that the empty-registry case cannot drive the real
      branch.)*
- [ ] **T036** [US5] **≥3 non-collapsed `app-ci` runs**, judged by the `e2e-result-gate` counts with
      collapsed runs excluded by US3's `verdict=` and **named in the report**. Two runs is explicitly not
      accepted for this change; that inference is what caused the revert. Confirm
      `assistant-disambiguate.spec.ts:154` passes without retries. (SC-007, SC-008)

---

## Phase 6 — US6: a valid local full-suite signal (P3)

**Goal**: FR-023 to FR-025. **Depends on**: US4's identity model.

- [x] **T037** [US6] Raise `accessTokenLifespan` in
      `infrastructure-as-code/docker/keycloak/dev-realm.json` to match `ci-realm`. Confirm
      `check-realm-consistency.mjs` still passes — its header states the realms may legitimately differ in
      non-contract fields, including token lifespans. **Run it; do not rely on the header.**
      *(Done 2026-08-11: 300 → 5400, matching `ci-realm`. Gate RUN, not trusted: `check-realm-consistency`
      prints "consistent (realm, app clients, e2e-test-user)" and exits 0. JSON re-parsed after the edit.)*
- [x] **T038** [US6] Name the substitute coverage for what this costs: assert that the BFF refresh path,
      including the 2-per-30 s bucket and its 429, is exercised by `pnpm nx test:integration mcm-app`.
      **If it is not, add it here** — dropping the local coverage without a replacement is not acceptable.
      *(Done 2026-08-11: it already exists and nothing needed adding — verified, not assumed.
      `tests/integration/rate-limiter.integration.test.ts` covers the 429 ("returns 429 after the real
      counter exceeds the limit; key has a TTL"), the 2-per-30 s refresh bucket, and both the
      `refresh_rate_limited` and `refresh_attempted` audit events. Named in the runbook and the
      checklist so the substitute is explicit rather than implied.)*
- [x] **T039** [US6] Make the local full-suite runner read the contention counters at the end of a run and
      fail with a message naming the **token lifespan** when `refresh_rate_limited > 0` — rather than leaving
      the member with `gotoHome: home screen did not render`, a sentence that names a cause it never tested.
      (FR-024)
      *(Done 2026-08-11: `tests/e2e/web/setup/global-teardown.ts`, wired in `playwright.config.ts`.
      Throws — which fails the run — naming the lifespan, the 2-per-30 s bucket, the frozen-storageState
      mechanism, and the re-import requirement. No-ops under CI, where the host-side gate already
      measures this and the Playwright container has no Docker CLI. With no Docker it prints **not
      measured**, which is deliberately not a pass.)*
- [ ] **T040** [US6] Run the full local suite and record the contention counters and the five counts.
      A pass here is a claim about the harness, not about the code. (SC-010)
- [x] **T041** [US6] Reconcile `openwiki/invariants/feature-validation-checklist.md` and
      `docs/runbooks/e2e-testing.md` so they agree on what a valid local pre-PR signal is. (FR-025)
      *(Done 2026-08-11: both now say a full local suite IS a valid gate, name the substitute coverage
      for the refresh path, and carry the trap that **a running Keycloak keeps the old lifespan until
      the realm is re-imported** — raising the number in the JSON changes nothing for a stack already
      up. openwiki governance and okf gates both exit 0.)*

---

## Phase 7 — Validation, reporting and closure

- [ ] **T042** `node --test "scripts/__tests__/*.test.mjs"` — record the **collected total** as well as the
      pass count. A total that *fell* means a selector stopped matching; treat that as a failure, not a pass.
- [ ] **T043** Full local gate sweep: `pnpm nx run-many --target=lint,test,typecheck`, plus the guardrails
      scripts touched by this feature. Record counts, not exit status.
      **Also verify FR-026 against the diff rather than against intent**: confirm the refresh rate limit
      (2 per 30 s in `rate-limiter.ts`), `MAX_CONCURRENT_SESSIONS` in `env.ts`, and the `ci-realm` and
      production token lifespans are **untouched** by this branch. The one permitted realm change is
      `dev-realm`'s lifespan in T037. A security control relaxed to suit the harness is a defect even when
      the suite goes green. (FR-026)
- [ ] **T044** **Ten consecutive `app-ci` runs**, judged by the `e2e-result-gate` counts and US3's
      `verdict=`. **The report MUST carry this sentence**: *against the measured ~1-in-7 rate, (6/7)¹⁰ =
      0.214 — a clean ten has a 21% chance of occurring even if nothing was fixed; twenty runs would be
      needed for 95%.* A clean ten is not proof of absence. (SC-006)
- [ ] **T045** For every run in T028, T036 and T044, check US3's `verdict` against the Anthropic-call
      signature in the bundle (healthy 99–114, collapsed 24–34) and **record the result of the check**.
      A disagreement is a finding about the detector and must be written down, not smoothed over. Perfect
      agreement is not the criterion — the threshold is heuristic and a near-boundary run is read by hand.
      (SC-003)
- [ ] **T046** Confirm at least one bundle contains browser console output for a failing agent/dock spec —
      the evidence channel that did not exist before this feature. If no run failed, say so plainly rather
      than claiming the criterion met. (SC-004)
- [ ] **T047** **If a collapse was caught with capture**: open #173's diagnosis from the client-side
      evidence, distinguishing "the client never dispatched" from "the client dispatched and the request
      never left". **If no collapse was caught**: record that plainly on #173, note that the detector and
      capture are in place for whoever hits it next, and leave the item open. Do not substitute an untested
      mechanism and ship against it.
- [ ] **T048** Close #176, #167, #169, #166 and #168 **on their own acceptance criteria, verified** — not
      because this PR merged. #173 closes only on T047's first branch. Where a criterion was met differently
      than written, edit it and say why in a comment before closing.
- [ ] **T049** Comment on **#170** naming this feature's residual failure rate (from T028, T036, T044) as the
      input it was waiting for, and state the trigger to pick it up. It stays open and out of scope: it is a
      decision, not a build.
- [ ] **T050** Open the PR: `git push origin HEAD:054-app-e2e-reliability-cluster`, then `POST …/pulls` with
      the **`git credential fill`** credential — never an AGit push (`refs/pull/N/head` runs with no Actions
      secrets and reports the empty nx cache token as `Misconfigured remote cache endpoint`), and never
      `MCM_FORGE_TOKEN`, which 403s on this endpoint.

---

## Dependencies

```text
US1 (T001-T003)  ── independent, unit-only ──────────────────┐
US2 (T004-T010)  ── independent ──┐                          │
                                  ├─> US3 (T011-T019) ─┬─> US4 (T020-T029) ─> US6 (T037-T041) ─┤
                                  │                    └─> US5 (T030-T036) ──────────────────── ┼─> Phase 7
                                  └─────────────────────────────────────────────────────────────┘
```

- **US2 before US3** — US3's signal has to be readable on a green run, which is precisely what US2 adds.
  One backward edge is deliberate and marked: T006 leaves the `e2e-turn-tally` source for T013 to add, so
  Phase 2 stays completable on its own.
- **US3 before US4 and US5** — both need a labelled background to be judged against. This is the whole
  ordering argument: it is also what makes their runs double as #173 samples.
- **US4 before US6** — the local fix takes its shape from the identity model.
- **US5 does NOT wait on #173's mechanism** — only on US3's `verdict`. Gating it on the mechanism would park
  a real user-facing defect behind an open-ended diagnosis.
- **#173's fix (T047) is evidence-gated**, not scheduled. It has no place in the dependency order because
  nothing in this feature can schedule the event it depends on.
