# Feature Specification: `app-e2e` reliability cluster — a trustworthy signal, a labelled collapse, and one identity per worker

**Feature Branch**: `054-app-e2e-reliability-cluster`

**Created**: 2026-08-11

**Status**: Draft

**Input**: Backlog items **#176, #167, #173, #169, #166, #168** (`node scripts/backlog.mjs show <n>`) — filed
by three sessions (051, 052, 053) and read here as one thread rather than six items. Item **#170 is
deliberately out of scope**; see [Out of scope](#out-of-scope).

**Prior art, read in full before this was written**:
[PRD-E2EWorkerSessionContention.md](../../docs/proposals/PRD-E2EWorkerSessionContention.md),
[specs/052-e2e-worker-session-contention/](../052-e2e-worker-session-contention/),
[specs/053-assistant-queued-turn-drop/](../053-assistant-queued-turn-drop/),
[specs/051-ci-diagnostics-closure/tasks.md](../051-ci-diagnostics-closure/tasks.md) (T017, T049).

---

## Context

`app-e2e` is a required merge gate. Six things are wrong with it at once, and they are not independent:

- roughly **one run in seven collapses** — every agent/dock spec fails together, `flaky=0`, and the gateway
  receives ~40 turns where a healthy run drives ~155 (#173);
- a **green** run publishes no bundle, so its counts and retry churn are unreadable without making it fail (#167);
- `ci-status` reports a **stale** `failure` as blocking after a successful re-run of the same context (#176);
- six Playwright workers act as **one** `E2E_TEST_USER`, which has already produced three separate defects
  that each read as something else (#169);
- a real user-facing defect — a message typed while the assistant is answering is **silently dropped** — has a
  fix that exists and was reverted on an attribution that has since been overturned (#166);
- and a developer **cannot get a valid local full-suite result at all**, because 052 scoped its token-lifespan
  fix to `ci-realm` and left `dev-realm` at 300 s (#168).

### The one thing this feature is really about

**Three conclusions in this thread were each drawn from two runs and later overturned by a wider sample.**
053 attributed a whole-suite collapse to its own fix (refuted by run 1633, which reproduced the identical
signature with the change absent). 051 concluded "five green, one red" was noise (it was a defect). And the
original framing — "live model = inherently flaky" — was substantially wrong, which is why the reflex of
re-running agent specs hid five stale specs for three weeks.

Every one of those errors has the same shape: **a verdict about a change, taken against a background whose
own variance was neither measured nor labelled.** So this feature's ordering is not by priority label. It is
by *what makes the next verdict trustworthy*: the signal first (US1, US2), then the collapse detector (US3),
and only then the two changes whose effect has to be judged against it (US4, US5).

### What is measured, and must not be re-derived

Carried forward so it is not lost or re-argued:

| Fact | Source |
| --- | --- |
| Healthy runs drive **99–114** Anthropic calls; collapsed runs drive **24–34**, with `flaky=0` | #173, runs 1614/1619 vs 1621/1622/1633 |
| Every collapsed run reports `refresh_total=3 refresh_429=0 session_evicted=0` — 052's gate passes | #173 |
| `assistant_not_configured` short-circuits are **0** in both healthy and collapsed runs | #173 |
| The `@expo/server` "Cannot pipe to a closed or destroyed stream" drop appears once in **both** a healthy and a collapsed run — not the discriminator | #173 |
| Collection median lifetime under the shared user was **1.3 s** across four runs | #169 / #165 |
| `refresh_429` went 32 → 35 → 0 via per-worker sessions **plus** a CI token that outlives the job | 052 R10 |
| The collapse is **not** caused by 053's `isRunning` change — run 1633 has the signature with the change absent | #173, #166 correction |

### What was checked against the code while writing this spec, rather than assumed

Four inherited claims hold. One does not, and it changes US2's approach:

| Claim | Verdict |
| --- | --- |
| `computeMergeVerdict` does not collapse duplicate statuses per context | **Holds** — [ci-status.mjs:356-372](../../scripts/ci-status.mjs#L356-L372) maps straight over `selectEventContexts`. Its "never counted twice" comment concerns a *different* duplication (an unsuffixed context matching both events). |
| The 053 fix is currently reverted | **Holds** — [use-assistant.tsx:86](../../frontend/mcm-app/src/hooks/use-assistant.tsx#L86) reads `[agent, resolveAgent, fire]`. |
| Per-worker *sessions* exist; per-worker *users* do not | **Holds** — [worker-session.ts](../../frontend/mcm-app/tests/e2e/web/fixtures/worker-session.ts) exists; [playwright.config.ts:17](../../frontend/mcm-app/playwright.config.ts#L17) documents `MAX_E2E_WORKERS = 6` purely as headroom against `MAX_CONCURRENT_SESSIONS`. |
| Nothing captures the browser console | **Holds** — the only `page.on(...)` under `tests/e2e/web/` is a `'response'` listener in `perf.spec.ts:37`. |
| **Publishing green counts is a small extension of feature 051's `createStatus`** | **Does NOT hold.** [ci-failure-digest.mjs:863-864](../../scripts/ci-failure-digest.mjs#L863-L864) hardcodes `state: 'failure'`, and line 906 reaches it **only** on the degraded path — when `CI_DIGEST_TOKEN` is empty. On a normal run the function is never called. US2 therefore extends the **bundle** path instead, which already carries the `step:`-ranked sources *and* the retention story #167 asks for. |

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A verdict about CI describes the current state of CI (Priority: P1)

An engineer runs `ci-status status` against a commit whose failing job has since been re-run successfully on
the same event. Today the stale `failure` still lands in `blocking`, and the tool reports
`NOT mergeable — 1 required context(s) failed` for a PR the forge would merge. The same context can appear
twice in one verdict, as both `passed` and `failed`.

**Why this priority**: It is P1 by *sequence*, not by severity — item #176 is p3 and fails closed, so it will
never call a broken PR mergeable. It is first because this feature will dispatch and read many CI verdicts,
and because it is entirely self-contained: one function, one existing test file, no CI run needed to verify.

**Independent Test**: Call `computeMergeVerdict` with two statuses for one context — an older `failure` and a
newer `success` — and assert the verdict is mergeable with that context appearing exactly once.

**Acceptance Scenarios**:

1. **Given** a context with an older `failure` and a newer `success` on the **same** event, **When** the
   verdict is computed, **Then** the context resolves to `passed` and the verdict is mergeable.
2. **Given** a context with an older `success` and a newer `failure`, **When** the verdict is computed,
   **Then** it resolves to `failed` — newest wins in **both** directions, not "any success passes".
3. **Given** `foo (push)` and `foo (pull_request)` statuses, **When** the verdict is computed, **Then** they
   remain independent checks and may legitimately disagree.
4. **Given** any verdict, **When** its `all` list is inspected, **Then** no context appears more than once.

---

### User Story 2 - A green run publishes its own counts (Priority: P1)

A green `app-e2e` today proves only that nothing failed and nothing was hidden. It cannot say whether a test
needed its retry, because `flaky` appears only in the failure digest and **the digest publishes only on
failure**. To read a passing run's counts you would have to make it fail.

**Why this priority**: "Green twice in a row" is the strongest statement currently available about this
suite, and it cannot distinguish *stable* from *passed on the second attempt*. Every judgement the rest of
this feature makes — US4's, US5's, and the ten-run standard in SC-006 — is a two-run verdict until a passing
run reports its own numbers.

**Independent Test**: Dispatch `app-ci`, let `app-e2e` pass, and read `failed / flaky / passed / skipped /
did-not-run` and the contention triple from outside CI without re-running the job and without host access.

**Acceptance Scenarios**:

1. **Given** an `app-e2e` run that PASSED, **When** its counts are sought from a working session, **Then**
   `failed`, `flaky`, `passed`, `skipped` and `did-not-run` are all readable without re-running the job and
   without SSH to the runner.
2. **Given** the same passing run, **When** the contention tally is sought, **Then** `refresh_total`,
   `refresh_429` and `session_evicted` are readable through the same channel.
3. **Given** the publication path itself fails, **When** the job completes, **Then** the job's own result is
   unchanged — a reporter must never fail the build it measures.
4. **Given** publication now happens on every run rather than only on failures, **When** the package registry
   is inspected over time, **Then** a retention rule bounds its growth and is stated.

---

### User Story 3 - A collapsed run says so, and leaves client-side evidence (Priority: P1)

Roughly one run in seven collapses. Every server-side channel has been exhausted: the gateway answers
everything it receives with `200`, the containers are healthy, contention reads zero, and
`assistant_not_configured` never fires. What distinguishes a collapse is that **turns are not being sent** —
and nothing currently captures the one place that would show why, the browser.

This story does not fix the collapse. It makes a collapse **cheap to catch** and **impossible to misread**.

**Why this priority**: It is the pivot the whole ordering turns on. Without it, judging US4 or US5 means
running the same two-run experiment that has been overturned three times in this thread. With it, a collapsed
run is labelled and excluded, and two or three *non-collapsed* runs become a legitimate judgement. It also
means every run US4, US5 and US6 dispatch doubles as a sampling opportunity for the collapse itself — which
is why diagnosing #173 in series ahead of them would throw those runs away.

**Independent Test**: Run the web E2E suite, then confirm the run is classified `collapsed` or `healthy` from
its published counts alone, and that a browser console/request capture for the failing specs is present in
the published bundle.

**Acceptance Scenarios**:

1. **Given** any completed web-E2E run, **When** its result is published, **Then** it carries a signal that
   distinguishes **collapsed** from **some tests failed**, derived from the turn/gateway-call count and not
   from reading gateway logs by hand.
2. **Given** a run that failed, **When** the bundle is read, **Then** it contains browser console output and
   the client-side request record for the failing agent/dock specs.
3. **Given** a healthy run, **When** the same capture runs, **Then** the web-suite wall clock is within
   **5%** of the pre-capture baseline and the five counts are **identical** — the instrument must not become
   the perturbation.
4. **Given** the capture is present, **When** the log is inspected, **Then** it contains no token, cookie,
   password or other credential material.
5. **Given** a collapse is caught with capture, **When** it is triaged, **Then** the evidence distinguishes
   "the client never dispatched" from "the client dispatched and the request never left" — the two remaining
   candidates #173 could not separate.

---

### User Story 4 - Each worker owns its own data (Priority: P2)

Six Playwright workers act as the same `E2E_TEST_USER`, so everything that user owns is shared mutable state
across concurrently-running spec files. That has already produced three defects that each read as something
else: a teardown race whose collections died at a median age of **1.3 s** and was blamed on live-model
nondeterminism for months; 052's refresh contention; and a designed-in near-miss where the worker bound sits
at 6 purely to stay under `MAX_CONCURRENT_SESSIONS = 10`. Still shared and merely un-raced: the per-user
agent config, the default collection, and the MUTATION fixture.

**Why this priority**: All three prior sessions independently called this the highest-leverage item. Each of
the three defects was fixed individually; the pattern says the shared identity **is** the defect. Per-worker
users retire the class by construction rather than by discipline, and lift the six-worker ceiling that pins
the wall clock.

**Independent Test**: Run the full suite and confirm that a `listCollections` for any worker returns only
that worker's data, and that a blanket teardown in one worker cannot delete another's fixtures.

**Acceptance Scenarios**:

1. **Given** the suite is running, **When** any worker lists or deletes its data, **Then** no other worker's
   data is visible to it or affected by it.
2. **Given** per-worker identities, **When** global setup completes, **Then** its added cost is **measured
   and stated as a number**, and `app-e2e` stays inside its 75-minute budget.
3. **Given** the specs that deliberately assert on GLOBAL state (`admin-registration` toggles a realm-wide
   flag; `bff-prod-lifecycle` performs a real logout), **When** the suite runs, **Then** they are enumerated
   and keep working in the `lifecycle` project.
4. **Given** sessions are now per-user as well as per-worker, **When** the worker bound is re-evaluated
   against `MAX_CONCURRENT_SESSIONS`, **Then** the chosen number is justified by that headroom rather than
   inherited.
5. **Given** the change is complete, **When** the suite is inspected, **Then** no spec has been skipped,
   deselected, narrowed or gated to achieve the result.

---

### User Story 5 - A follow-up typed mid-answer is not lost (Priority: P2)

A message typed into the assistant dock while the assistant is still answering is silently discarded — no
error, no echo, no request to the gateway. `run()` queues it, and the flush effect is keyed on
`[agent, resolveAgent, fire]`, none of which change when a run *finishes*.

The fix exists (`81e03e9`) and was reverted because two runs appeared to show it breaking the suite. **That
attribution was overturned**: run 1633 reproduced the identical signature with the change absent. Item #166
nevertheless says *do not simply re-apply it*, and that instruction is honoured here — not by waiting for
#173's mechanism, but by re-landing it against US3's detector, which is the mechanically correct fix for the
inference error that caused the revert.

**Why this priority**: It is a genuine user-facing defect — losing typed input with no indication is the
worst failure mode a chat surface has. It is P2 only because it must be judged against US3's `verdict` to be
judged at all.

**Independent Test**: Drive `useAssistantRun` with an agent whose `isRunning` is true, send a message, flip
`isRunning` to false and re-render. The message is delivered exactly once.

**Acceptance Scenarios**:

1. **Given** the assistant is mid-run, **When** the member sends a message and the run then finishes,
   **Then** the message is delivered exactly once, without the member resending it.
2. **Given** the assistant is idle, **When** the member sends a message, **Then** it is delivered immediately
   — unchanged from today.
3. **Given** a queued message was delivered, **When** a further run completes, **Then** it is not delivered a
   second time.
4. **Given** no agent is registered, **When** the member sends a message and an agent then registers,
   **Then** the empty-registry self-heal still delivers it exactly once.
5. **Given** two messages are typed while a run is in flight, **When** the run finishes, **Then** the
   member is not left unable to tell what happened to the first — today it is overwritten silently.
6. **Given** the change is verified in CI, **When** its runs are judged, **Then** collapsed runs are excluded
   by US3's `verdict` field, and the judgement rests on non-collapsed runs only.

---

### User Story 6 - A developer can get a valid local full-suite result (Priority: P3)

Feature 052 raised `accessTokenLifespan` to 5400 s in `ci-realm` and deliberately left `dev-realm` at **300
s**. The consequence was not noticed: any local run lasting more than ~5 minutes crosses the expiry boundary
repeatedly and six workers re-enter exactly the contention 052 removed from CI. Measured 2026-08-10: two
full-suite local runs took 44 minutes each with **62** `refresh_rate_limited`, 401s, and 42 ×
`gotoHome: home screen did not render` — the message 052's own research calls out as naming a cause it never
tested.

`openwiki/invariants/feature-validation-checklist.md` asks for a local `pnpm nx e2e mcm-app` before a PR. On
the current `dev-realm` that instruction cannot produce a valid result.

**Why this priority**: It is the same identity/session problem on a developer machine, so US4's identity
model largely determines the shape of the fix. P3 because CI has a valid signal today and a developer has a
documented subset workflow.

**Independent Test**: Run the documented local full-suite command and read the contention counters for the
same window.

**Acceptance Scenarios**:

1. **Given** the documented local command, **When** a full suite is run, **Then** its contention counters
   read zero — **or** the checklist states plainly that the full local suite is not a valid gate and names
   what is.
2. **Given** the failure mode can still occur, **When** it does, **Then** the error names the token lifespan
   rather than surfacing as `gotoHome: home screen did not render`.
3. **Given** the change is complete, **When** `feature-validation-checklist.md` and
   `docs/runbooks/e2e-testing.md` are read together, **Then** they agree.

---

---

### User Story 7 - A missing script fails its tests instead of skipping them (Priority: P2)

`scripts/__tests__/shell-probe.mjs` decides whether a suite can shell out by running
`test -r "<script>"` **through the shell**. That predicate is false for a script that does not exist
just as it is for one the shell cannot reach — and the two are reported identically, with the reason
written for the second:

> `bash` starts but cannot read `<script>` — it is a shell from a different filesystem namespace
> (typically the WSL bash on PATH for a Windows checkout)…

So a suite whose script under test is simply **absent** gets a confident, specific, wrong diagnosis
pointing at Windows and WSL — and, far worse, gets **skips instead of failures**.

**Why this is in this feature rather than in the backlog.** It was found by this feature, writing this
feature's tests, and it silently weakened this feature's own evidence. Measured 2026-08-11 on Linux
with a perfectly usable `bash`, writing `e2e-turn-tally.test.mjs` (T011):

| | tests | pass | fail | skipped |
| --- | ---: | ---: | ---: | ---: |
| test file written, script not yet created | 15 | 0 | 3 | **12** |
| identical test file, empty stub script created | 15 | 1 | **14** | 0 |

Twelve cases that should have been the RED half of a RED→GREEN pair reported as **skips**. Under this
repository's own rule — *a skip reads as a pass* — that is the failure class feature 051 exists to
remove, reproduced inside the helper written to prevent it. It bites exactly when the discipline is
being followed, because writing the test before the implementation is the only order in which the
script is missing.

Tracked as backlog item **#178**, pulled into this feature because every remaining RED verification
here depends on it.

**Why this priority**: It does not change what the suite tests; it changes whether this feature's own
RED verifications mean anything. P2 rather than P1 only because the three suites that use the probe
are correct on a healthy host today.

**Independent Test**: Point a probe at a path that does not exist and assert it reports *usable* — so
the cases run and fail — while a path that exists but is unreadable through the shell still skips with
its reason.

**Acceptance Scenarios**:

1. **Given** a script path that does not exist on the host, **When** the probe runs, **Then** it
   reports the suite as runnable, so the cases FAIL rather than skip.
2. **Given** a script that exists but the shell cannot read (a different filesystem namespace),
   **When** the probe runs, **Then** it skips and the reason names that condition.
3. **Given** a shell that cannot be started at all, **When** the probe runs, **Then** it skips and the
   reason names that condition.
4. **Given** any skip this probe produces, **When** it is read, **Then** it never attributes an absent
   file to a namespace problem.

### Edge Cases

- **No collapse occurs during the whole feature.** US3's detector is still delivered and correct; #173's
  mechanism stays open and is reported as *not yet caught*, not as *fixed*. A quiet period is a sample, not
  a result — this is exactly the inference SC-006's stated power exists to prevent.
- **The capture in US3 changes the timing it measures.** Log volume under six workers is not free. If the
  suite's wall clock or counts move materially, the capture is the suspect and must be re-scoped before any
  other conclusion is drawn from a run that carries it.
- **US4 lifts the worker ceiling and the job exceeds `timeout-minutes: 75`.** The job then fails for a
  brand-new reason that looks exactly like the old one. The budget is checked before the ceiling moves.
- **US4's per-worker agent-config PUT runs live credential probes N times.** N× a live probe at setup is a
  real cost in wall clock and in provider spend, and could itself trip a rate limit — it is measured before
  it is adopted.
- **A dispatched run posts no commit status.** US1's fix is therefore not observable on the
  `workflow_dispatch` runs used to verify the rest of this feature; it is verified by unit test and on a PR.
- **US5 goes green over its non-collapsed runs but the underlying collapse rate rises.** Two effects would be
  confounded. US3's per-run `verdict` is what separates them; if it is unavailable for a run, that run is
  discarded rather than interpreted.

---

## Requirements *(mandatory)*

### Functional Requirements

**Verdict correctness (US1)**

- **FR-001**: `computeMergeVerdict` MUST collapse statuses to the newest per context before classifying,
  keyed on the full context string including its event suffix.
- **FR-002**: Newest MUST win in both directions — a newer `failure` after an older `success` resolves to
  `failed`.
- **FR-003**: No context may appear more than once in a single verdict.
- **FR-004**: `(push)` and `(pull_request)` contexts for the same job MUST remain independent.

**Readable counts (US2)**

- **FR-005**: `failed`, `flaky`, `passed`, `skipped` and `did-not-run` MUST be readable from outside CI for a
  run that PASSED, without re-running it and without host access.
- **FR-006**: The contention triple (`refresh_total`, `refresh_429`, `session_evicted`) MUST be readable
  through the same channel for a passing run.
- **FR-007**: Publication MUST NOT be able to fail the job it measures.
- **FR-008**: Publication on every run MUST be bounded by a stated retention/pruning rule.

**Collapse detection and client evidence (US3)**

- **FR-009**: Every completed web-E2E run MUST publish a signal that distinguishes a **collapsed** run from
  one where **some tests failed**, derived from the turn/gateway-call count.
- **FR-010**: The harness MUST capture browser console output and the client-side request record for failing
  agent/dock specs, and that capture MUST reach the published bundle.
- **FR-011**: The capture MUST carry no token, cookie, password or other credential material.
- **FR-012**: The capture MUST NOT perturb what it measures. Stated as a threshold so the check can fail:
  with the capture enabled, the web-suite wall clock MUST be within **5%** of the pre-capture baseline and
  the five counts MUST be **identical**. Outside that, the capture is the suspect and is re-scoped before
  any other conclusion is drawn from a run carrying it.

**Per-worker identity (US4)**

- **FR-013**: Each Playwright worker MUST operate on data no other worker can see or delete.
- **FR-014**: The added global-setup cost MUST be measured and stated as a number, and `app-e2e` MUST stay
  inside its 75-minute budget.
- **FR-015**: Specs that deliberately assert on global/shared state MUST be enumerated and MUST keep working.
- **FR-016**: The worker bound MUST be re-evaluated against `MAX_CONCURRENT_SESSIONS` and its value justified
  by the resulting headroom.
- **FR-017**: No spec may be skipped, deselected, narrowed or gated to achieve any result in this feature.
  (Feature 051's SC-001; it must not regress.) This is the **prohibition**; SC-009 is the **measurement**
  that detects a breach. Both are kept deliberately — a rule nobody counts is not enforced.

**Queued turn (US5)**

- **FR-018**: A message accepted by the dock MUST eventually be delivered or surfaced as an error. It MUST
  NOT be silently discarded.
- **FR-019**: A message queued because the agent was mid-run MUST be flushed when that run completes, exactly
  once.
- **FR-020**: The existing empty-registry self-heal MUST keep working.
- **FR-021**: Delivery MUST NOT depend on the member interacting again. (This narrows FR-018 rather than
  restating it: FR-018 forbids losing the message, FR-021 forbids requiring a second Send to recover it.)
- **FR-022**: Where a member sends a second message while one is already queued, **each message MUST either
  be delivered or have its supersession surfaced to the member.** Stated as the property rather than as one
  of its implementations, because both candidate fixes satisfy it differently — a queue delivers both; a
  single slot must show that the first was replaced.

**Local signal (US6)**

- **FR-023**: A documented local command MUST produce a full-suite result whose contention counters are zero,
  or the checklist MUST state that the full local suite is not a valid gate and name what is.
- **FR-024**: Where the local failure mode can still occur, the error MUST name the token lifespan rather
  than a rendering timeout.
- **FR-025**: `openwiki/invariants/feature-validation-checklist.md` and `docs/runbooks/e2e-testing.md` MUST
  agree.

**Probe honesty (US7)**

- **FR-028**: The shared shell probe MUST distinguish *the script under test is absent* from *the
  shell cannot reach it*. An absent script MUST NOT produce a skip.
- **FR-029**: The namespace case (the file exists on the host, the shell cannot read it) MUST still
  skip, and MUST still name that condition — the defect it was written for is real.
- **FR-030**: The probe's own behaviour MUST be pinned by tests covering both directions. It is a
  helper whose failure mode is silence, so an unpinned helper is the same defect one level up.

**Cross-cutting**

- **FR-026**: No production security control may be weakened to suit the test harness. Where a control is
  implicated, the test topology changes. (052's FR-011.)
- **FR-027**: Any claim about the collapse rate MUST state the number of runs it rests on and the power that
  number buys. A bare count of green runs is not a claim.

### Key Entities

- **Run verdict** — the per-run classification `healthy | collapsed | indeterminate`, derived from the
  turn/gateway-call count and emitted as the `verdict=` field of the `[e2e-turns]` line. **`verdict` is the
  canonical name for this concept** across spec, plan and contract — it is what the CI line actually emits,
  so naming it anything else in prose creates a second vocabulary for one thing.
- **Run counts** — the quintuple `failed / flaky / passed / skipped / did-not-run` from `e2e-result-gate`,
  plus the contention triple. Published on every run, not only failures.
- **Per-worker identity** — one Keycloak user, one BFF session, and one fixture dataset per Playwright
  worker. Replaces the single `E2E_TEST_USER` as the unit of E2E data ownership.
- **Client-side evidence** — browser console output and the request record for a failing spec. The one
  channel #173 has never had.

---

## Success Criteria *(mandatory)*

Stated as observed results, because a green tick on this suite is the thing that has been wrong before.

- **SC-001**: A context with an older `failure` and a newer `success` on the same event resolves to `passed`
  and the verdict is mergeable; the regression test is RED before the fix.
- **SC-002**: For an `app-e2e` run that PASSED, all five counts and all three contention numbers are read
  from a working session with no re-run and no host access.
- **SC-003**: A run is classified `healthy`, `collapsed` or `indeterminate` from its published output alone,
  and that verdict is **checked against** the Anthropic-call signature already measured (healthy 99–114,
  collapsed 24–34) on every run this feature produces. The criterion is that the check is **performed and
  its result recorded** — a disagreement is a finding about the detector and must be written down, not
  smoothed over. Perfect agreement is deliberately **not** required: the threshold is heuristic, calibrated
  on five runs, and a near-boundary run is one to read by hand.
- **SC-004**: At least one run's bundle contains browser console output for a failing agent/dock spec — the
  evidence channel that did not exist before this feature.
- **SC-005**: With per-worker identities in place, no test failure in the suite is attributable to another
  worker's teardown, config change or fixture mutation.
- **SC-006**: **Ten consecutive `app-ci` runs show no collapse, judged by the `e2e-result-gate` counts and
  US3's `verdict` — and this criterion is recorded as 79%-powered, not as proof.** Against the measured ~1-in-7
  rate, (6/7)¹⁰ = 0.214: a clean ten has a **21% chance of occurring even if nothing was fixed**. Twenty runs
  would be needed for 95%. This criterion is deliberately the cheaper one, and any report of it MUST carry
  that sentence rather than reading as a proof of absence.
- **SC-007**: US5's change is judged over **at least three non-collapsed runs**, with collapsed runs excluded
  by US3's `verdict` and named in the report. A two-run judgement is not accepted for this change, for the reason
  recorded in #166's correction.
- **SC-008**: `assistant-disambiguate.spec.ts:154` passes without retries.
- **SC-009**: In every run of this feature, `agent-*.spec.ts` shows a non-zero executed count and a **zero**
  skip count.
- **SC-010**: A documented local command produces a full-suite result with zero contention counters, or the
  checklist states the full local suite is not a valid gate and names the substitute.
- **SC-012**: A suite whose script under test is absent reports **failing** cases, not skipped ones,
  and the three suites that use the probe are unchanged on a healthy host. Demonstrated against the
  measured 12-skip case, which becomes 12 failures.
- **SC-011**: The global-setup cost added by US4 is stated as a measured number, and both verification runs
  finish inside the 75-minute budget.

---

## Assumptions

- The collapse rate is ~1 in 7 based on 5 measured runs (1614, 1619, 1621, 1622, 1633 plus the runs behind
  #150's "five green, one red"). That estimate is itself imprecise, which is *why* SC-006 states its power
  rather than asserting a threshold.
- `workflow_dispatch` is the only way to exercise `app-ci` on this branch — `guardrails` and `app-ci` scope
  `push:` to `main`. A dispatched run posts **no** commit status, so `ci-status status --sha` will say
  "waiting" forever regardless of outcome, and results are read from the run's own outcome and bundle.
- The Anthropic call count remains available in the failure bundle's gateway log, and US3's detector can be
  derived from a signal the harness already produces rather than requiring a new gateway change.
- US4's per-worker users can be minted with the machinery that already exists (`keycloak-admin.ts`, and the
  per-worker login global setup already performs). If that proves false, the cost re-opens the trade in
  FR-014 rather than being absorbed silently.
- Model spend for the verification runs is accepted: each `app-e2e` drives ~100 live Anthropic calls and the
  job takes ~35 minutes on a capacity-1 runner. SC-006's ten runs are therefore ~6 hours of runner time.

---

## Out of scope

- **Item #170 — whether live-model / live-TMDB assertions belong in the merge gate.** It is a decision, not a
  build, and deciding it before the residual failure rate is known would be guessing. Its input is exactly
  what US3 and US4 produce. It stays open and is re-triggered by this feature's results; a comment on #170
  records that trigger.
- **#173's mechanism and its fix.** Deliberately *evidence-gated* rather than scheduled: it opens when a
  collapse is caught with US3's capture. Nothing in this feature can fix a mechanism nobody has observed, and
  committing to a remedy first is the error this thread has already made three times.
- Failing the build on `flaky > 0`. #167 explicitly declines to propose it: it is a policy change with real
  consequences and should be decided on the data US2 makes available.
- Reducing overall E2E runtime as an objective. US4 may lift the worker ceiling as a side effect; speed is
  not the goal, determinism is.
- Any change to the retry/idempotency behaviour of `/run` itself.
