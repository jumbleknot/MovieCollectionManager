# Feature Specification: `app-e2e` worker/session contention

**Feature Branch**: `052-e2e-worker-session-contention`

**Created**: 2026-08-09

**Status**: Draft

**Input**: [docs/proposals/PRD-E2EWorkerSessionContention.md](../../docs/proposals/PRD-E2EWorkerSessionContention.md)

## Context

Feature 051 forwarded `E2E_AGENT_PRODUCTION` into the Playwright container, so `agent-*.spec.ts`
executes in CI for the first time — with a **zero** skip count. That is 051's SC-001 and it must not
regress. Forwarding it also exposed a pre-existing fragility: eight parallel Playwright workers share
one `E2E_TEST_USER` identity, and once the agent specs hold those workers for minutes at a time the
suite degrades badly. Two runs of identical code produced 33 vs 61 failures and 17.9 min vs 1.1 h.
`app-e2e` is red, and feature 051 cannot merge until this is resolved.

**This feature is sequenced deliberately: measure first, then fix.** The PRD's §6 states plainly that
session eviction has never been directly observed — the "8 workers against a cap of 10" mechanism is
inferred from the config, not measured. Reading the code during planning surfaced a second candidate
that fits the evidence at least as well (a per-session refresh rate limit of 2 requests per 30 s,
shared by all eight workers because they share one `sessionId`). Committing to a remedy before
distinguishing them would be the same class of error the PRD exists to correct. Stories 1 and 2
produce the number; Story 3 spends it.

**Not established, and deliberately not assumed** — carried forward from PRD §6 so it is not lost:
`gotoHome: … is the global-setup session valid?` is a helper's guess on a 60 s timeout, not a
measurement, and is not evidence of session death. The 361 `auth_failed reason:"no_token"` events are
what the deliberately-unauthenticated specs produce by design and are not counted as evidence.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The BFF says out loud when it drops a session (Priority: P1)

Today the BFF silently evicts a session when the concurrent-session cap is reached, and silently
rejects a token refresh when the per-session rate limit is exceeded. Both produce the same downstream
symptom — a client redirected to login — and neither leaves a trace. An engineer diagnosing a red
`app-e2e` therefore has nothing to read, which is exactly why PRD §6's first question has stayed open.
After this story, both events are visible with a count, so the question is answered with a number
rather than an inference.

**Why this priority**: Every remedy in the PRD's §3 targets a different mechanism. Without this, the
choice between them is a guess, and a guess that happens to go green is indistinguishable from a fix.

**Independent Test**: Drive the BFF past each threshold in an integration test — create more sessions
than the cap for one user, and issue more refreshes than the limit within one window — and assert the
corresponding event is emitted. Delivers value on its own: the BFF gains permanent, honest
observability of two silent security-control activations, useful well beyond this feature.

**Acceptance Scenarios**:

1. **Given** a user at the concurrent-session cap, **When** a further session is created, **Then** the
   BFF emits a session-eviction event identifying the user and the evicted session.
2. **Given** a session that has exhausted its refresh allowance within the window, **When** it requests
   another refresh, **Then** the BFF emits a refresh-rejected event before returning 429.
3. **Given** any token-refresh request, **When** it completes, **Then** the BFF emits an event carrying
   its outcome, so rejections have a denominator rather than a bare count.
4. **Given** any of the above events, **When** the log is inspected, **Then** it contains no token,
   cookie, password or other credential material.

---

### User Story 2 - The measurement survives the trip back (Priority: P1)

A count that exists only inside a container log on the CI host is not a result. The BFF log is
collected only under `failure()`, is uploaded as an artifact the forge API cannot read, and is fed to
a tail-biased digest that would show only the last fraction of a multi-thousand-line file. This story
puts the tally into the one channel that is readable from a working session, so the answer arrives
instead of merely existing.

**Why this priority**: Without it Story 1 produces evidence nobody can reach — the same
silence-that-reads-as-a-result failure mode feature 051 was built to eliminate. Story 1 is worthless
alone.

**Independent Test**: Run `app-e2e` and confirm the tally appears in the published failure digest, on
both a passing and a failing run, with values that match the container log it was derived from.

**Acceptance Scenarios**:

1. **Given** a completed web-E2E run, **When** the job reaches the tally step, **Then** a single line
   reporting refresh attempts, refresh rejections and session evictions is emitted.
2. **Given** the job failed, **When** the failure digest is published, **Then** the tally is present in
   it, not held back behind higher-ranked evidence.
3. **Given** the job passed, **When** the job completes, **Then** the tally is still emitted — a green
   run's counts are what prove the contention is gone, so they must not be discarded.
4. **Given** the CI stacks are torn down at the end of the job, **When** the tally is produced,
   **Then** it has already been read from the running container.

---

### User Story 3 - The contention is removed, not tuned around (Priority: P2)

With the measurement in hand, remove the coupling it identifies so that eight workers no longer
contend over one shared resource. The remedy is chosen by the number, not selected in advance.

**Why this priority**: It is the actual objective, but it depends on Stories 1 and 2 to be chosen
correctly rather than plausibly.

**Independent Test**: Re-run `app-e2e` and confirm the tally's contention counts fall to zero (or to a
level the measurement shows is harmless) while the agent-spec executed count is unchanged and the skip
count stays at zero.

**Acceptance Scenarios**:

1. **Given** the Story 1 measurement, **When** a remedy is chosen, **Then** it addresses the mechanism
   that was actually observed to fire, and the rejected candidates are recorded with the number that
   rejected them.
2. **Given** the remedy is in place, **When** `app-e2e` runs, **Then** every `agent-*.spec.ts`
   executes and none is skipped.
3. **Given** the remedy is in place, **When** the suite is inspected, **Then** no spec has been
   skipped, deselected, narrowed or gated to achieve the result.
4. **Given** the measurement shows neither candidate mechanism fired, **When** the result is reported,
   **Then** the hypothesis is stated as refuted rather than replaced with another untested one.

---

### User Story 4 - The result is proven twice, by count (Priority: P2)

One green run does not distinguish a fix from the favourable end of a variance already measured at
33-vs-61 failures. This story is the evidence standard the result is held to.

**Why this priority**: It is what makes the other three trustworthy. It is P2 only because it cannot
run before them.

**Independent Test**: Two consecutive `workflow_dispatch` runs on this branch, compared by test
identity.

**Acceptance Scenarios**:

1. **Given** two consecutive runs, **When** their results are compared, **Then** both passed, judged by
   executed/skipped/failed counts and never by exit status alone.
2. **Given** two consecutive runs, **When** their failure sets are diffed by test identity, **Then** the
   diff is empty.
3. **Given** a residual failure in either run, **When** it is triaged, **Then** it is one of the seven
   known `agent-*` defects and is filed under backlog item #150.
4. **Given** the runs completed, **When** their durations are checked, **Then** both finished inside the
   job's 75-minute budget.

### Edge Cases

- **The measurement comes back all zeros.** Both candidate mechanisms are refuted. The honest outcome
  is to say so and re-open diagnosis with the Playwright report and first-retry traces, not to ship the
  cheapest remedy anyway.
- **A remedy reduces but does not remove the variance.** SC-004's empty-diff requirement catches this.
  A shrinking-but-still-varying failure set means the contention was reduced, and must be reported as
  reduced rather than accepted as fixed.
- **A remedy lengthens the job past its timeout.** `app-e2e` already runs to ~35 min against a
  75-minute limit on a capacity-1 runner; a remedy that serialises more work can fail the job for a
  brand-new reason that looks like the old one.
- **The instrumentation itself changes the timing it measures.** Log volume under eight workers is not
  free; the measurement must not become the perturbation.
- **A green Phase-1 run.** The measurement run is expected to be red. A green one is not a success — it
  is a sample from the known variance, and the counts still have to be read.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The BFF MUST emit a structured log event whenever the concurrent-session cap causes a
  session to be evicted, identifying the affected user and the evicted session.
- **FR-002**: The BFF MUST emit a structured log event whenever a token-refresh request is rejected by
  the per-session refresh rate limit.
- **FR-003**: The BFF MUST emit a structured log event carrying the outcome of every token-refresh
  attempt, so a rejection count can be expressed against a denominator.
- **FR-004**: These events MUST carry no token, cookie, password or other credential material, per the
  repository's logging-and-audit conventions.
- **FR-005**: `app-e2e` MUST emit a single-line tally of refresh attempts, refresh rejections and
  session evictions observed during the web-E2E window.
- **FR-006**: The tally MUST be emitted on both passing and failing runs, and MUST be produced before
  the CI stacks are torn down.
- **FR-007**: The tally MUST reach a channel readable through the published CI failure digest, and MUST
  NOT depend on artifact download or host access to be read.
- **FR-008**: The measurement stage MUST NOT alter worker count, retry count, spec selection, timeouts
  or any merge gate — it measures the failing condition, it does not treat it.
- **FR-009**: The remediation MUST NOT reduce the number of `agent-*.spec.ts` tests executed, and MUST
  keep their skip count at zero.
- **FR-010**: The remediation MUST NOT achieve its result by skipping, deselecting, narrowing or gating
  any spec.
- **FR-011**: The remediation MUST NOT weaken a production security control in order to suit the test
  harness; where a control is implicated, the test topology changes rather than the control.
- **FR-012**: The seven known `agent-*` defects MUST remain tracked separately under backlog item #150
  and MUST NOT be remediated by this feature.
- **FR-013**: The rejected remedy candidates MUST be recorded together with the measurement that
  rejected them, so the reasoning stays checkable rather than being re-derived later.

### Key Entities

- **Contention tally**: the per-run triple (refresh attempts, refresh rejections, session evictions)
  observed by the BFF during the web-E2E window. The unit of evidence this feature produces.
- **Failure set**: the set of failing tests in a run, keyed by test identity (file + title) rather than
  by count, so two runs can be diffed rather than merely compared in size.
- **Shared E2E identity**: the single `E2E_TEST_USER`, its one `storageState` session, and everything
  keyed on that session — the resource eight workers currently contend over.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After the measurement stage, each candidate mechanism has a **numeric** answer from a real
  CI run — a count, including zero. "No matches found" from a log search does not satisfy this.
- **SC-002**: `app-e2e` passes on **two consecutive** runs.
- **SC-003**: In **both** runs, `agent-*.spec.ts` shows a non-zero executed count and a **zero** skip
  count. (Feature 051's SC-001; it must not regress.)
- **SC-004**: The failure-set diff between the two runs, by test identity, is **empty**.
- **SC-005**: Any residual failure in either run is one of the seven known `agent-*` defects from PRD
  §1.4, and each is filed under backlog item #150.
- **SC-006**: Both runs complete inside the job's 75-minute budget.
- **SC-007**: The contention tally is present and readable in the published digest for every run of this
  feature, including the ones that pass.

## Assumptions

- The eight-worker count is Playwright's default on the `kvm` runner and is not pinned anywhere; it may
  differ on another host, so the measurement is authoritative only for that runner.
- A local devcontainer reproduction, if achievable, is a cheap first probe but not authoritative: the
  local model provider's latency profile differs from the CI provider's, and latency is the variable
  driving the contention. A local null result refutes nothing.
- The measurement run is expected to fail, and may consume the full 75-minute budget and real model
  spend on both the first attempt and its retry. This is the accepted price of measuring.
- This branch is cut from `051-ci-diagnostics-closure` and merges back into it; the fix cannot be
  verified on a branch cut from `main`, because `main` still skips every agent spec and would go green
  regardless of what the fix does.
- The two `TEMPORARY(051)` commits are inherited by this branch and are **not** this feature's to
  revert; feature 051's T058 owns that, and it must happen before 051 merges to `main`.
- Feature 051's landed instrumentation, gates and digest work are unchanged by this feature.
