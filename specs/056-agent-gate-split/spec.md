# Feature Specification: which agent assertions may block a merge

**Feature Branch**: `054-app-e2e-reliability-cluster` (shared — see [Branching](#branching))

**Created**: 2026-08-12

**Status**: Draft

**Input**: Backlog item **#170** (`node scripts/backlog.mjs show 170`), deferred from item #150 and
held open until the residual failure rate was known. It now is.

## Context

`app-e2e` is a required merge gate, and 41 of its 161 tests assert on the output of a live LLM and
live TMDB. Whether that belongs in a blocking gate has been an open question since #150. It was
deferred deliberately — deciding it before knowing the real failure rate would have been guessing.

### The evidence that settles it

Two `app-ci` runs on **identical code** (sha `1fada7a`), same worker count, same stack:

| run | counts | verdict | contention | identities |
| --- | --- | --- | --- | --- |
| **#1684** | `failed=0 flaky=0 passed=177 did-not-run=0 skipped=0` | healthy | `refresh_429=0 session_evicted=0` | 8 minted |
| **#1685** | `failed=1 flaky=7 passed=166 did-not-run=3 skipped=0` | healthy | `refresh_429=0 session_evicted=0` | 8 minted |

Every alternative explanation is excluded **by measurement**, not by argument:

- not the #173 collapse — `verdict=healthy`, 93 gateway posts per 100 tests, inside the measured band;
- not worker/session contention — `refresh_429=0`, `session_evicted=0` in both;
- not the shared identity — `minted 8 worker identities` in both (feature 054 US4);
- not the gateway livelock — fixed and closed as #179, and the gateway answered throughout;
- not a harness defect — zero identity-mismatch, login, 403 or fixture errors.

All eight affected entries in #1685 are model-decision assertions: `assistant-context:136`,
`agent-add-ownership:215`, `agent-import-progress:78`, `agent-search:134`,
`assistant-disambiguate:198`, `assistant-organize-update-move:119`, `assistant-organize:107`.

### What that means

**A required gate that fails on identical code roughly half the time is not gating.** It taxes every
pull request with a coin flip and teaches people to re-run — the habit that hid five stale specs for
three weeks (#150) and caused a sound fix to be reverted on a two-run inference (#166/#173).

Feature 054 records its **T028 as unmet** for exactly this reason and hands it here: no amount of work
inside 054's scope can produce two consecutive runs with an empty failure-set diff while these
assertions block a merge.

### What this feature must not do

Move the flakiness somewhere nobody looks. 051's SC-001 and 054's FR-017 both forbid reaching green by
skipping, deselecting or deleting a spec, and a "scheduled tier" that nobody reads is the same thing
wearing a schedule. Whatever leaves the gate has to keep running, keep publishing counts, and be
readable by the same channel the gate uses.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - There is a written rule, and it is checkable (Priority: P1)

Today "which agent assertions may block a merge" is a judgement each person makes again. There must be
one rule, written where the testing tiers are defined, that a reader can apply to a specific test and
get the same answer as everyone else.

**Why this priority**: The classification in US2 is arbitrary without it, and an arbitrary
classification is one the next person re-litigates.

**Independent Test**: Hand the rule and three tests — one deterministic, one model-decision, one
borderline — to someone who has not seen the classification, and get the same answers.

**Acceptance Scenarios**:

1. **Given** the rule, **When** it is applied to a test, **Then** it yields *blocks* or *does not
   block* from a property of the test, not from how often it has failed.
2. **Given** the rule, **When** a NEW agent test is written, **Then** the author can tell which tier
   it belongs to before running it.
3. **Given** the rule, **When** it is read, **Then** it states what is lost by moving an assertion out
   of the gate, not only what is gained.

---

### User Story 2 - Every agent test is classified, and the classification is enforced (Priority: P1)

Each of the 41 agent/dock tests is classified against US1's rule and carries that classification in a
form the runner can act on — so the gate runs one set and the scheduled tier runs the other, without
anyone maintaining a list in two places.

**Why this priority**: It is the change itself.

**Independent Test**: Run the gate selection and the scheduled selection; confirm every agent test
appears in exactly one, and that the two together are the whole set.

**Acceptance Scenarios**:

1. **Given** the classification, **When** the two selections are run, **Then** their union is every
   agent test and their intersection is empty.
2. **Given** a test tagged as model-decision, **When** `app-e2e` runs, **Then** it does not execute
   there — and its absence is *counted and reported*, never silent.
3. **Given** an agent test with NO classification, **When** the gate runs, **Then** that is a failure,
   not a default — an unclassified test must not drift into either tier by accident.
4. **Given** the change, **When** the suite is inspected, **Then** no test has been deleted, skipped
   or `.only`-ed to achieve the result.

---

### User Story 3 - What leaves the gate still runs, and is still read (Priority: P1)

The model-decision assertions run on a schedule, publish their counts through the same channel the
gate uses, and fail loudly when they fail.

**Why this priority**: Without it this feature is quarantine. The repository's own history is that a
suite nobody reads decays silently — five stale specs for three weeks — and this must not become the
mechanism for the next instance of that.

**Independent Test**: Run the scheduled tier; read its counts from outside CI without re-running it.

**Acceptance Scenarios**:

1. **Given** the scheduled tier runs, **When** it completes, **Then** its counts are published and
   readable through the same bundle channel as `app-e2e`.
2. **Given** the scheduled tier fails, **When** it does, **Then** the failure is visible without
   anyone opening a job log.
3. **Given** the scheduled tier has not run for longer than its interval, **When** that is checked,
   **Then** the staleness is detectable — a tier that silently stopped running must not read as one
   that is passing.

---

### User Story 4 - The decision states its price (Priority: P2)

#170 requires the effect on `app-e2e` wall clock and on model spend per run to be stated, not implied.

**Why this priority**: It is what makes the trade reviewable rather than asserted. P2 because it is a
measurement of the other three.

**Acceptance Scenarios**:

1. **Given** the split, **When** `app-e2e` runs, **Then** its wall clock and live-turn count are
   compared with the pre-split baseline and both are recorded.
2. **Given** the split, **When** the cost is stated, **Then** it covers BOTH tiers — moving spend to a
   schedule is not the same as removing it.

### Edge Cases

- **A borderline test.** Some assertions are half deterministic. The rule must say which way borderline
  falls, and the answer is: **into the gate only if the deterministic half can be asserted on its
  own.** Splitting a test is allowed; guessing is not.
- **The scheduled tier goes red and stays red.** That is the failure mode this feature could create.
  US3-AC3 exists for it.
- **A model-decision test that is ALSO the only coverage of a wiring path.** Moving it would silently
  drop gate coverage of that path. The wiring assertion must stay, split out, before the model half
  leaves.
- **The classification drifts** as specs are edited. US2-AC3 makes an unclassified test fail rather
  than default.

---

## Requirements *(mandatory)*

- **FR-001**: A written rule MUST exist in `openwiki/invariants/testing-tiers.md` stating which agent
  assertions may block a merge, expressed as a property of the assertion rather than of its history.
- **FR-002**: Every agent/dock test MUST carry an explicit classification the runner can select on.
- **FR-003**: An agent test with no classification MUST fail the gate rather than default into a tier.
- **FR-004**: The gate selection and the scheduled selection MUST partition the agent tests — union
  complete, intersection empty.
- **FR-005**: No test may be deleted, skipped, `.only`-ed, or deselected without a tier that runs it.
  (051 SC-001, 054 FR-017.)
- **FR-006**: The scheduled tier MUST publish its counts through the same readable channel as
  `app-e2e`, and MUST NOT require a job log to diagnose.
- **FR-007**: A scheduled tier that has stopped running MUST be detectable as stale rather than
  reading as passing.
- **FR-008**: The effect on `app-e2e` wall clock, on live turns per run, and on model spend across
  BOTH tiers MUST be measured and stated.
- **FR-009**: Where a model-decision test is the only coverage of a wiring path, the wiring assertion
  MUST remain in the gate — split out, not moved wholesale.

## Success Criteria *(mandatory)*

- **SC-001**: The rule exists, and applying it to three named sample tests yields the recorded answers.
- **SC-002**: Every agent test is classified; an unclassified test fails the gate (demonstrated).
- **SC-003**: Gate ∪ scheduled = all agent tests; gate ∩ scheduled = ∅.
- **SC-004**: **Two consecutive `app-e2e` runs on identical code produce an empty failure-set diff** —
  the criterion 054's T028 could not meet, which is the point of this feature.
- **SC-005**: The scheduled tier runs, publishes readable counts, and its staleness is detectable.
- **SC-006**: `app-e2e` wall clock and live-turn count are recorded against the pre-split baseline,
  and the model spend across both tiers is stated.
- **SC-007**: No spec deleted or skipped; the agent test count across both tiers equals the pre-split
  count.

## Assumptions

- The pre-split baseline is app-ci runs **#1684/#1685** on sha `1fada7a`: 177 collected, ~148–163
  gateway turns, ~28 min, one run green and one with 8 affected tests.
- The golden-replay tier (`test:golden movie-assistant`) is the eventual home for model-DECISION
  coverage at the graph level, but re-expressing a browser assertion as a golden one is a
  re-implementation, not a move. This feature relocates *where the existing tests run*; deepening
  golden coverage is separate.

## Out of scope

- **Rewriting agent E2E specs as golden tests.** Different layer, different assertions.
- **#173.** Still open, still unexplained, and unaffected by this.
- Any change to the non-agent E2E specs.

## Branching

Shares feature 054's branch: it is 054's T028 that this unblocks, and the two would otherwise have to
merge in lockstep anyway.
