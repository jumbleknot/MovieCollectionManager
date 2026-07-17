# Feature Specification: Integration-Test CI Enforcement

**Feature Branch**: `041-integration-test-ci-enforcement`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "docs\proposals\PRD-IntegrationTestCIEnforcement.md — Enforce the integration-test tier in CI: un-quarantine the agent suite and run mc-service / mcm-app integration in the shared CI stack."

## User Scenarios & Testing *(mandatory)*

The stakeholders here are the developers and maintainers of the movie-collection platform, whose trust in a
"green build" depends on that build actually exercising the integration tier the project's testing standard
requires. Today, whole classes of integration tests either do not run in CI at all, or are excluded from the
gate — so a passing build can hide a broken integration path. Each user story below closes one such gap and
is independently shippable.

### User Story 1 - Restore the muted agent integration signal (Priority: P1)

A maintainer changes the conversational-assistant (agent) layer and opens a pull request. Today, eight agent
integration tests are excluded from the CI gate (quarantined), so their signal is muted — a change that breaks
one of those paths still shows a green build. This story removes every exclusion by resolving the underlying
issue for each test (fixing the product, correcting the test, or relocating a model-decision assertion to the
place designed to test it deterministically), so that a break in any of those paths turns the build red.

**Why this priority**: Highest signal. This is the debt the predecessor work explicitly deferred, and at least
one of the muted tests (approval-gated persistence) may be masking a real product defect rather than a test
artifact. Every agent-layer change is currently validated against a weaker set than the standard demands.

**Independent Test**: With the quarantine removed, run the full agent integration suite in the shared CI stack
and confirm it passes with zero excluded tests; separately confirm that a deliberately broken agent path turns
the previously-quarantined tests red.

**Acceptance Scenarios**:

1. **Given** the agent integration suite in the shared CI stack, **When** the CI gate runs, **Then** no test is
   excluded on the grounds of being a known pre-existing failure, and the suite passes.
2. **Given** a model-decision assertion that was brittle in a live run, **When** it is relocated to the
   deterministic model-regression harness, **Then** the same behavior is still verified but no longer flakes the
   live gate.
3. **Given** the approval-gated add-and-persist path, **When** an approved add is exercised end-to-end against
   the real stack, **Then** the record is actually created (a genuine persistence failure is reported as a
   product defect, not silently tolerated as a flake).

---

### User Story 2 - Gate every backend-service change on its integration suite (Priority: P2)

A maintainer changes the movie-collection backend service (e.g., the cascade-delete transaction path) and opens
a pull request. Today the backend service's integration suite — which must run against a real replica-set-capable
document database — runs in no workflow, so that change ships with only unit coverage. This story runs the backend
integration suite in CI against the real database that the shared CI stack already provides, so every backend PR
is gated on it.

**Why this priority**: The backend's most safety-critical behaviors (atomic multi-document deletes, ownership
enforcement, uniqueness constraints) live in the integration tier and are currently unverified in CI. High value,
low cost — the required real dependencies are already running in the shared stack.

**Independent Test**: Trigger a CI run and confirm the backend integration suite executes against the real
database and passes; introduce a deliberate repository regression and confirm the suite fails (proving it is a
real gate, not a no-op).

**Acceptance Scenarios**:

1. **Given** the shared CI stack is up with its real replica-set-capable database, **When** the CI gate runs,
   **Then** the backend-service integration suite executes against that real database and passes.
2. **Given** a deliberately broken repository change, **When** the CI gate runs, **Then** the backend-service
   integration suite fails and blocks the build.

---

### User Story 3 - Gate every BFF change on its integration suite (Priority: P3)

A maintainer changes the frontend app's backend-for-frontend (BFF) layer — session handling, rate limiting, or
registration — and opens a pull request. Today the BFF integration suite, which must run against a real identity
provider and a real session cache, runs nowhere. This story runs it in CI against the real identity provider and
session cache the shared CI stack already provides, so every BFF PR is gated on it.

**Why this priority**: The BFF's session-lifetime, concurrent-session-eviction, and rate-limit behaviors are only
meaningfully verified against real dependencies, and are currently unverified in CI. Lowest of the three only
because it is last in sequence and the least likely to be hiding an active defect — still required by the standard.

**Independent Test**: Trigger a CI run and confirm the BFF integration suite executes against the real identity
provider and session cache and passes; introduce a deliberate BFF regression and confirm the suite fails.

**Acceptance Scenarios**:

1. **Given** the shared CI stack is up with its real identity provider and session cache, **When** the CI gate
   runs, **Then** the BFF integration suite executes against those real dependencies and passes.
2. **Given** a deliberately broken BFF change, **When** the CI gate runs, **Then** the BFF integration suite fails
   and blocks the build.

---

### User Story 4 - A misconfigured integration run must never report green (Priority: P1)

A maintainer (or a future infrastructure change) leaves one of the required real dependencies partially down when
the CI gate runs. Today a suite with "dependency-absent" guards could silently skip its tests and still report a
pass. This story ensures that for every newly-wired integration suite, a run where the required dependencies are
not fully available **fails loudly** rather than skipping to a false green.

**Why this priority**: This is the load-bearing guarantee behind all three other stories — without it, wiring a
suite into CI provides only the appearance of coverage. It is P1 alongside Story 1 because a false green is worse
than a known gap: it actively misleads.

**Independent Test**: Run each newly-wired suite with its required stack intentionally partially down and confirm
the CI gate fails (does not skip to green); run it with the stack fully up and confirm it passes.

**Acceptance Scenarios**:

1. **Given** a required real dependency is unavailable, **When** an integration suite that guards on that
   dependency runs in CI, **Then** the run fails rather than reporting a skipped-but-green result.
2. **Given** a legitimately optional dependency (an opt-in observability/audit profile that is intentionally not
   running), **When** the default CI gate runs, **Then** the tests that require it remain legitimately skipped and
   do not fail the gate.

---

### Edge Cases

- **A required host tool is missing on the CI runner** (e.g., a language toolchain or database client the newly-wired
  suite needs). The host prerequisites for each suite must be enumerated and confirmed present before wiring, so a
  missing tool surfaces as a clear provisioning fix — not an opaque late failure. (A predecessor discovered a missing
  build toolchain the same way.)
- **A model-decision assertion is genuinely correct-but-different on the CI model.** Rather than loosen a live
  assertion (which becomes the next quarantine), the assertion is moved to the deterministic model-regression harness.
- **The shared CI job's wall-clock grows too large.** If adding the suites makes the shared job unacceptably slow, the
  integration tier may run as its own dependency-gated job that reuses the same stack bring-up — coverage is never
  dropped to save time, and cheap checks still run before the expensive legs.
- **A quarantined test was masking a real product bug** (highest concern for the approval-gated persistence path). Such
  a case must be diagnosed as a potential product defect first, not dismissed as a flake.
- **A newly-wired suite leaks test data into the shared stack.** Each suite must clean up the accounts and records it
  creates and use an isolated namespace so it does not collide with other suites sharing the stack.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The agent integration suite MUST run in CI with **zero** tests excluded on the grounds of being known
  pre-existing failures; the "known-failure" exclusion mechanism MUST be entirely removed once every affected test
  passes.
- **FR-002**: For each currently-excluded agent test, the system MUST resolve it by one of: fixing the underlying
  product behavior, correcting an incorrect test, or relocating a model-decision assertion to the deterministic
  model-regression harness — and MUST NOT resolve it by merely loosening a live assertion to accept any outcome.
- **FR-003**: The approval-gated add-and-persist behavior MUST be verified end-to-end against the real stack such that
  a failure to persist an approved add is reported as a defect rather than tolerated.
- **FR-004**: The backend-service integration suite MUST execute in CI against the real replica-set-capable document
  database provided by the shared CI stack, and MUST gate every pull request that changes the backend service.
- **FR-005**: The BFF integration suite MUST execute in CI against the real identity provider and real session cache
  provided by the shared CI stack, and MUST gate every pull request that changes the BFF.
- **FR-006**: For every newly-wired integration suite, a CI run in which a required real dependency is unavailable MUST
  fail; it MUST NOT report a skipped-but-passing result. (No false green.)
- **FR-007**: Integration tests that depend on a legitimately optional, opt-in dependency profile MUST remain skipped
  (not failed) when that profile is intentionally not running in the default gate.
- **FR-008**: Each newly-wired integration suite's host prerequisites MUST be enumerated and confirmed present on the
  CI runner before the suite is wired into the gate.
- **FR-009**: Each newly-wired integration suite MUST clean up the test data and accounts it creates and MUST use an
  isolated namespace so concurrent suites sharing the CI stack do not collide.
- **FR-010**: Integration tests MUST exercise real external dependencies (identity provider, session cache, databases,
  downstream services) and MUST NOT substitute mocks or in-memory fakes for the dependency under test, per the project's
  test-integrity standard.
- **FR-011**: The CI gate MUST preserve fast-fail ordering — cheaper checks run before the most expensive legs — so a
  common failure is reported quickly.
- **FR-012**: The "a misconfigured run must fail, not skip" discipline SHOULD be captured as a single shared convention
  reused by every newly-wired suite, rather than reinvented per suite, including a documented list of which skips are
  legitimate for each suite.
- **FR-013**: Each broken-on-purpose acceptance check (a deliberate regression per suite) MUST demonstrably turn the
  corresponding suite red, proving each gate actually bites.
- **FR-014**: Developer-facing documentation MUST state that the integration tier now runs in CI for all three projects
  and MUST describe how to run each suite locally against the shared stack.

### Key Entities *(include if data involves data)*

- **Integration test tier**: The category of tests that verify a component against its **real** external dependencies
  (databases, identity provider, session cache, downstream services). Distinct from unit tests (isolated, may mock) and
  end-to-end tests (full stack through a real surface).
- **Agent integration suite**: The conversational-assistant layer's integration tests; currently the only integration
  suite wired into CI, but with eight tests excluded.
- **Backend-service integration suite**: The movie-collection backend's integration tests (e.g., atomic cascade-delete,
  ownership, uniqueness), requiring a real replica-set-capable document database. Currently unrun in CI.
- **BFF integration suite**: The frontend app's backend-for-frontend integration tests (sessions, rate limiting,
  registration), requiring a real identity provider and session cache. Currently unrun in CI.
- **Shared CI stack**: The already-provisioned set of real dependencies the CI end-to-end job stands up (document
  database with replica set, identity provider with realm, session cache) that all three suites can reuse.
- **Quarantine exclusion**: The mechanism currently deselecting the eight agent tests from the gate; its complete
  removal is the definition-of-done for Story 1.
- **Model-regression harness**: The deterministic record/replay mechanism that is the correct home for assertions about
  the model's exact decisions, keeping model-sensitivity out of the live gate.
- **Skip-escalation convention**: The shared rule that converts an unexpected "dependency absent" skip into a failure,
  while allowing an explicit allowlist of legitimate skips.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The count of integration tests excluded from the CI gate on "known pre-existing failure" grounds is **0**
  across all three projects (down from 8 in the agent suite).
- **SC-002**: **100%** of the three projects' non-optional integration suites (agent, backend-service, BFF) execute on
  every qualifying pull request and gate the merge.
- **SC-003**: For each of the three suites, a deliberately introduced regression causes that suite to fail in CI —
  demonstrated at least once per suite (3 for 3).
- **SC-004**: For each newly-wired suite, a run with its required dependencies intentionally partially down fails rather
  than reporting green — demonstrated at least once per suite.
- **SC-005**: No integration suite leaves residual test data or accounts in the shared CI stack after a run (verified by
  inspecting the shared dependencies after a full CI run).
- **SC-006**: The CI gate's total wall-clock increase attributable to this feature is bounded and justified, and the
  fast-fail ordering is preserved (cheap checks still precede the expensive legs); the existing collision, secret, and
  naming gates remain green.
- **SC-007**: Developer documentation describing the now-enforced integration tier and how to run each suite locally
  exists and is discoverable.

## Assumptions

- The CI end-to-end job's existing stack already provides every real dependency the three suites need (replica-set-capable
  document database, identity provider with realm, session cache); no separate integration-test stack is provisioned —
  the suites reuse the existing bring-up.
- The three workstreams are independent and may land in sequence; the agent un-quarantine (Story 1) is sequenced first as
  the highest-signal, potentially-defect-revealing work, with the backend and BFF wiring (Stories 2 and 3) following and
  able to proceed in parallel with it.
- Model-decision assertions belong in the deterministic model-regression harness; relocating them there (rather than
  loosening them in the live gate) is the preferred resolution for the model-sensitive tests.
- The predecessor work that first wired the agent suite into CI is complete and is not re-litigated here; this feature
  builds on it.
- Optional, opt-in dependency profiles (observability/audit/policy/feature-flag tooling) are out of scope for the default
  gate and remain legitimately skipped unless their profile is explicitly running.
- The root-cause of the currently-muted external-data-provider agent failures (a downstream data call returning an error
  inside a healthy container) is not yet confirmed; diagnosis against the live stack is part of the work, and the fix may
  be a provisioning correction, a resilience change, or a genuine bug fix depending on what diagnosis reveals.
