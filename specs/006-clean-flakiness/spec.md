# Feature Specification: Clean Up Project Flakiness

**Feature Branch**: `006-clean-flakiness`

**Created**: 2026-05-31

**Status**: Draft

**Input**: User description: "docs\PRD-CleanFlakiness.md — Pre-existing test-isolation flake (movie-detail-screen.test.tsx fails only in the full unit run, passes isolated; jsdom/timer leak) with the goal of full suite green in one pass; E2E flakiness under the loaded local emulator/Metro (environmental) with the goal of full suite green in one pass; cleaner CI on short paths for easier APK rebuilds; and preventing npm usage in favour of pnpm (e.g. via engines + engine-strict)."

## Clarifications

### Session 2026-05-31

- Q: Scope for the APK/short-path story (US4) — document a local short-path build, add a CI pipeline, or both? → A: Both — provide a reproducible, documented local short-path procedure AND add a CI pipeline that builds the APK on a short/clean path.
- Q: How strict should the npm guard (US3) be — hard block, warn only, or leave it out? → A: Hard block — `npm install` must fail immediately with a clear "use pnpm" message, via a robust guard (the fragile `engines`-sentence trick is not relied upon).
- Q: For E2E (US2), is "green in one pass" zero-retry, or are bounded retries acceptable? → A: Stabilize root causes AND keep a single (max 1) explicit, visible retry as a safety net for genuine environmental timing; a real regression must still fail the suite.
- Q: What should the new CI pipeline run (US4 / FR-011)? → A: APK build only — build the Android APK on a short/clean path and publish the artifact; CI does not run the test suites.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Unit suite passes reliably in a single full run (Priority: P1)

A developer (or CI) runs the complete unit test suite for the frontend app once, from clean, and it passes every time — with no test failing solely because it ran alongside the others. Today `movie-detail-screen.test.tsx` passes in isolation but fails in the full run due to leaked state (timers/jsdom artifacts) bleeding between tests.

**Why this priority**: A suite that only passes when run test-by-test is effectively red — it erodes trust in the signal, hides real regressions, and forces wasteful re-runs. This is the most concrete, highest-confidence flake to eliminate and is the foundation for trusting every other gate.

**Independent Test**: Run the full unit suite from clean repeatedly (e.g., 10 consecutive runs) and confirm 0 failures and a stable pass count, including the previously-flaky spec, with no test skipped or quarantined to achieve the pass.

**Acceptance Scenarios**:

1. **Given** a clean checkout, **When** the full unit suite is run in one pass, **Then** every test passes, including `movie-detail-screen.test.tsx`.
2. **Given** the full unit suite is run repeatedly, **When** the runs complete, **Then** the pass/fail result is identical every time (no intermittent failures).
3. **Given** the previously-flaky test, **When** it is run both in isolation and within the full suite, **Then** it passes in both contexts and asserts the same behavior (no weakened assertions, no `skip`).

---

### User Story 2 - End-to-end suites pass reliably without environmental flakiness (Priority: P2)

A developer runs the web and mobile end-to-end suites and gets a consistent green result, rather than intermittent failures caused by the local environment (a loaded emulator, a slow or degraded dev server, cold-compile timing). Failures, when they occur, reflect genuine product regressions — not environment noise.

**Why this priority**: E2E flakiness wastes developer time, trains people to ignore failures, and masks real breakage. It builds on US1 (trustworthy lower-level gates first) and is harder to fully eliminate because the root causes are partly environmental, so it is second.

**Independent Test**: Run each E2E suite (web, mobile) multiple times under normal local conditions and confirm a consistent green result, with any unavoidable environmental retry made explicit and bounded rather than masking failures.

**Acceptance Scenarios**:

1. **Given** the documented environment readiness steps have been followed, **When** the web E2E suite is run repeatedly, **Then** it produces a consistent green result with no intermittent timeouts attributable to environment warm-up.
2. **Given** the documented environment readiness steps have been followed, **When** the mobile E2E suite is run repeatedly, **Then** it produces a consistent green result.
3. **Given** a test fails, **When** the failure is examined, **Then** it is distinguishable as either a genuine regression or a clearly-flagged, bounded environmental retry — never a silently-swallowed failure.

---

### User Story 3 - Developers are steered to pnpm and prevented from corrupting the repo with npm (Priority: P3)

A developer who runs `npm install` in the repository is hard-stopped — the install fails immediately with a clear message telling them to use pnpm instead — so a stray npm run can never generate a conflicting lockfile or an inconsistent `node_modules` layout.

**Why this priority**: The monorepo's tooling (Nx, the pnpm workspace, the hoisting/store layout) assumes pnpm; an accidental npm install can corrupt dependency resolution and break builds. Guarding against it is cheap, deterministic, and high-value, but it is a guard rail rather than a flake fix, so it ranks below the test-stability stories.

**Independent Test**: Attempt the disallowed package-manager install in the repo and confirm it is refused with a message directing the developer to pnpm, while the sanctioned pnpm install continues to work unchanged.

**Acceptance Scenarios**:

1. **Given** the repository, **When** a developer runs the disallowed npm install, **Then** the install fails (non-zero exit, no packages written) with a clear message naming pnpm as the required tool.
2. **Given** the repository, **When** a developer runs the sanctioned pnpm install, **Then** it succeeds exactly as before with no new friction.
3. **Given** the guard is in place, **When** the existing developer and CI workflows run, **Then** none of them are broken by the guard.

---

### User Story 4 - The Android APK rebuild is reproducible on a short path, locally and in CI (Priority: P4)

The Android APK can be rebuilt cleanly on a short filesystem path — both via a documented local procedure and via an automated CI pipeline — so the Windows native-build path-length wall (the CMake object-path limit that forced the `C:\m` junction + flat-node_modules workaround) is avoided and rebuilds are routine rather than an expedition.

**Why this priority**: APK rebuilds are occasional (only after native-layer changes) and a working — if awkward — local recipe already exists, so this is the lowest priority. Documenting the short-path local build and adding a CI pipeline that builds on a clean short path removes friction and de-risks future native upgrades, but does not block day-to-day work.

**Independent Test**: Rebuild the APK following the short-path procedure from clean (locally) and trigger the CI pipeline; confirm both produce an installable APK without manually fighting the path-length limit, and that the local procedure is documented well enough for someone else to repeat it.

**Acceptance Scenarios**:

1. **Given** a clean state on a short build path, **When** the APK is rebuilt following the documented local procedure, **Then** it completes without hitting the native object-path-length limit and yields an installable APK.
2. **Given** the procedure is followed, **When** the resulting APK is installed and launched on the emulator, **Then** the app starts and the existing mobile E2E suite can run against it.
3. **Given** the CI pipeline, **When** it is triggered to build the APK, **Then** it completes on a short/clean path without the path-length workaround and publishes an installable APK artifact.

---

### Edge Cases

- A unit test other than the known one also leaks state into the suite: the fix must address the shared-state mechanism (proper teardown/fake-timer cleanup), not just the single named test, so latent siblings are covered.
- An E2E failure is genuinely a product regression, not environmental: the hardening must not hide it — bounded retries apply only to clearly environmental conditions and a real regression must still fail the suite.
- A retry mechanism masks a flaky-but-real defect: retries must be bounded, visible in output, and never the means by which an otherwise-failing test is reported green.
- A developer uses yet another package manager (e.g., yarn) or a global/older npm: the guard's behavior for non-pnpm managers should be defined (refuse, or at minimum not silently allow corruption).
- The package-manager guard interferes with a legitimate tool that shells out to npm internally: the guard must not break sanctioned workflows (CI, Nx, Expo tooling).
- The short-path APK build is attempted on a machine/path that is already short enough: the procedure must still work (be a no-op for the path workaround) rather than assuming the long-path environment.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The full unit test suite MUST pass in a single run from a clean state, with the same result on every run (no intermittent failures).
- **FR-002**: The `movie-detail-screen.test.tsx` flake MUST be fixed by eliminating the cross-test state leak (e.g., uncleaned timers/jsdom artifacts) so the test passes both in isolation and within the full suite.
- **FR-003**: The fix MUST NOT weaken, skip, quarantine, or otherwise disable any test to achieve a green result; assertions MUST remain equivalent to or stronger than before.
- **FR-004**: Test isolation MUST be restored at the mechanism level (proper setup/teardown and timer/mocked-state cleanup) so that other tests relying on the same shared state do not silently regress.
- **FR-005**: The web and mobile end-to-end suites MUST produce a consistent, repeatable green result under documented normal local conditions, free of intermittent failures caused by environment warm-up or dev-server degradation.
- **FR-006**: The primary remedy MUST be root-cause stabilization; at most ONE explicit, visible retry MAY be used per E2E test as a safety net for genuine environmental timing. Retries MUST be bounded to this maximum, surfaced in the run output, and MUST NOT cause a genuinely failing test (a real regression) to be reported as passing.
- **FR-007**: The environment readiness steps required for reliable E2E runs (emulator/dev-server warm-up, tunnels, ordering) MUST be documented so the green result is reproducible by another operator.
- **FR-008**: A disallowed `npm install` in the repository MUST hard-fail (non-zero exit, no packages installed) with a clear message directing the developer to use pnpm, so it cannot create a conflicting lockfile or inconsistent dependency layout. The guard MUST NOT rely solely on the fragile `engines`-string trick to achieve this.
- **FR-009**: The package-manager guard MUST NOT break the sanctioned pnpm workflow or any existing developer/CI/tooling workflow.
- **FR-010**: The Android APK MUST be rebuildable from clean on a short filesystem path without manually fighting the native object-path-length limit, and the local procedure MUST be documented for repeatability.
- **FR-011**: A CI pipeline MUST be able to build the Android APK on a short/clean path — without the path-length workaround — and produce an installable APK artifact. The CI pipeline's scope is the APK build and artifact publication only; it does NOT run the test suites.
- **FR-012**: This feature MUST NOT change any end-user-facing application behavior; it changes only test reliability, build reproducibility, and developer tooling guard rails.
- **FR-013**: All affected project documentation (developer/test/build guidance) MUST be updated to reflect the new guard rails and procedures, leaving no stale instructions.

### Key Entities

*Not applicable — this feature changes test reliability, build reproducibility, and developer tooling; it introduces no new domain data entities.*

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The full unit suite run from clean passes 100% of the time across at least 10 consecutive runs, including the previously-flaky `movie-detail-screen.test.tsx`, with no test skipped or quarantined.
- **SC-002**: The unit-suite pass count after the fix is equal to or greater than the pre-fix count (no tests removed or disabled to achieve green).
- **SC-003**: Each E2E suite (web, mobile) produces a consistent green result across at least 3 consecutive runs under documented conditions, with zero failures attributable to environment warm-up.
- **SC-004**: Any environmental retry used is bounded to at most 1 retry per E2E test and surfaced in run output; zero genuine regressions are masked by a retry.
- **SC-005**: A disallowed `npm install` hard-fails (non-zero exit, no packages written) 100% of the time with a message naming pnpm; the sanctioned pnpm install succeeds unchanged.
- **SC-006**: The APK rebuild on a short path completes successfully without manual path-length intervention — both via the documented local procedure and via the CI pipeline — and the resulting APK installs and launches on the emulator.
- **SC-007**: Zero end-user-facing behavior changes are introduced (existing functional tests continue to pass with identical outcomes).
- **SC-008**: A search of developer/test/build documentation shows the new guard rails and procedures documented, with zero stale instructions describing the old (flaky/unguarded) state as current.

## Assumptions

- "Full suite green in one pass" refers to the existing project test suites (frontend unit, BFF integration, web E2E via Playwright, mobile E2E via Maestro, and the Rust mc-service suites) as currently defined; this feature does not add new test types, it makes the existing ones reliable.
- The `movie-detail-screen.test.tsx` failure is a test-side isolation/teardown defect (timer/jsdom state leak), not a product defect; the application code under test is correct and stays unchanged.
- "Environmental" E2E flakiness means failures caused by the local run environment (loaded emulator, degraded/cold Metro dev server, GPU/timing contention) rather than product regressions; the remedy is stabilization plus bounded, explicit handling — not blanket retries that hide defects.
- The package-manager guard targets `npm install` specifically (the corruption risk called out in the PRD) and is a **hard block** (the install fails); behavior for other non-pnpm managers is defined defensively but pnpm remains the only sanctioned manager.
- The `engines` + `engine-strict` approach named in the PRD is, on its own, a fragile mechanism (it depends on npm's semver parsing of the `engines.npm` value and is easily bypassed). The binding requirement is the outcome — a reliable hard refusal of `npm install` that steers to pnpm — so a robust guard (e.g., a `preinstall` `only-allow pnpm` gate, optionally combined with `engines`/`engine-strict`) will be chosen at planning time rather than the `engines`-sentence trick alone.
- "Both" for US4 means a documented local short-path build procedure **and** a CI pipeline that builds the APK on a short/clean path; the CI provider/runner choice is an implementation decision deferred to planning.
- The supported verification platforms remain web and Android (the project's current targets); iOS is out of scope.
- Backend services (mc-service) are exercised only to confirm no regression; this feature does not change their behavior.
