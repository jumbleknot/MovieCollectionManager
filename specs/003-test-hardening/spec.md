# Feature Specification: Test Suite Hardening

**Feature Branch**: `003-test-hardening`
**Created**: 2026-05-29
**Status**: Draft
**Input**: `MCM-Testing-Strategy.docx` (derived from analysis of features 001 and 002)

## Clarifications

### Session 2026-05-29

- Q: Should retroactive hardening touch tests for features 001 and 002? → A: Yes — all existing E2E tests are in-scope for session reuse, cleanup, and parity tables. Unit and integration tests are not in-scope unless directly implicated by the fixture strategy.
- Q: Should the output-compression tool be optional per developer? → A: No — it is mandatory for all AI-assisted development sessions on this project. Document in the codebase documentation Prerequisites.
- Q: Should platform parity enforcement be retroactive or forward-only? → A: Both. Add parity tables retroactively for features 001 and 002; require them from day 1 for all future features.
- Q: Does this feature change what end-users see? → A: No — purely developer infrastructure. No production application code is modified.
- Q: Where does the reusable task template live? → A: `docs/templates/feature-test-tasks-template.md`, referenced from the codebase documentation.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Token-Efficient Command Output (Priority: P0)

As a developer running tests with the AI assistant, command output reaching the agent's context window is compressed to summary and failures only, preserving the context window for reasoning rather than boilerplate.

**Why this priority**: Token efficiency affects every command in every session. A large reduction in command output noise directly extends session length and improves reasoning quality. This has no code dependencies and should be active before any other work begins.

**Independent Test**: Run any test command with output compression active and confirm the output contains only a summary line and failure detail — not individual test names or progress bars. Verify the compression metric shows >80% reduction.

**Acceptance Scenarios**:

1. **Given** output compression is installed and activated globally, **When** any test command runs, **Then** output reaching the agent context is compressed to a summary line and failure details only.
2. **Given** the test reporter is configured for minimal output, **When** all tests pass, **Then** the output is a single summary line, not a test-name-per-line list.
3. **Given** a test fails, **When** the output is compressed, **Then** the complete failure detail including the assertion error and stack trace is preserved intact — nothing failure-relevant is stripped.

---

### User Story 2 — Single-Login E2E Session (Priority: P1)

As a developer running the full E2E test suite, the identity provider authentication flow runs exactly once (during global setup), and all subsequent tests inherit the authenticated session without re-triggering a login.

**Why this priority**: Repeated identity provider login flows are the largest single source of context token waste in E2E runs. Eliminating them directly reduces both run time and token consumption.

**Independent Test**: Run the full E2E suite and confirm that the identity provider prompt fires exactly once (global setup) and never appears in any individual test's output.

**Acceptance Scenarios**:

1. **Given** global setup completes, **When** any E2E test runs, **Then** the test begins in an authenticated state without triggering any identity provider redirect.
2. **Given** tests that explicitly test the login or logout flow, **When** those tests run, **Then** they opt out of the inherited session and function correctly in an unauthenticated state.
3. **Given** the authenticated session, **When** a test creates or modifies data, **Then** teardown calls the application's backend API directly — not the UI — so it succeeds regardless of the app's UI state at test end.

---

### User Story 3 — Seeded Fixture Dataset (Priority: P1)

As a developer writing search and filter tests, a typed, pre-seeded test dataset exists before any test runs, and tests assert against known expected counts derived from that dataset.

**Why this priority**: Tests that navigate to "the first collection" with no guaranteed content can pass vacuously on a clean environment. A pre-seeded dataset with known attribute combinations is the foundation for all data-dependent test assertions.

**Independent Test**: Run a filter test (e.g., decade filter for "1980s") against the seeded dataset and confirm the assertion expects exactly the documented number of fixture movies with that attribute.

**Acceptance Scenarios**:

1. **Given** global setup completes, **When** any search or filter test runs, **Then** the read-only fixture collection contains exactly the movies defined in the fixture definition.
2. **Given** a filter test exercises a specific attribute value, **When** the filter is applied, **Then** the test asserts the exact count of fixture movies with that attribute — not just "at least one row visible".
3. **Given** a previous test run left orphaned data in the write-only fixture collection, **When** global setup runs, **Then** that collection is reset to empty before tests begin.
4. **Given** the fixture dataset is missing or incomplete, **When** global setup detects the discrepancy, **Then** it creates the missing data via the application's backend API before any test runs.

---

### User Story 4 — Disciplined Test Execution Protocol (Priority: P1)

As a developer implementing a feature with the AI assistant, clear written guidance in the codebase documentation determines exactly which tests to run after each code change and in what order.

**Why this priority**: Without explicit protocol, the AI assistant defaults to running everything after every change — maximally safe but maximally token-expensive. A written protocol short-circuits this with no implementation cost.

**Independent Test**: Human review of the codebase documentation confirms it contains: isolated test first, user-story suite second, full suite only at final validation; plus a scope map and final checklist.

**Acceptance Scenarios**:

1. **Given** the codebase documentation contains the Test Run Protocol, **When** a single test fails during implementation, **Then** the documented procedure runs that test in isolation first.
2. **Given** the codebase documentation contains the Feature Branch Test Scope map, **When** code changes touch only one user story, **Then** the documented procedure runs only that story's test files.
3. **Given** the codebase documentation contains the Final Validation Checklist, **When** a feature is complete, **Then** the documented procedure runs all checklist items in order before marking the feature done.

---

### User Story 5 — Platform Parity Tracking (Priority: P2)

As a developer reviewing test coverage, a parity table in each feature's task list explicitly tracks whether every test scenario has both web and mobile coverage, with a written justification for any gap.

**Why this priority**: Without a parity table, gaps are invisible. The table makes missing mobile flows a task, not an oversight.

**Independent Test**: Read the parity tables for features 001 and 002 and confirm every scenario is either implemented for both platforms or carries a written N/A justification.

**Acceptance Scenarios**:

1. **Given** a feature's task list contains a parity table, **When** a new test scenario is added for one platform, **Then** the corresponding entry for the other platform exists (either implemented or N/A with justification).
2. **Given** the feature 002 parity table, **When** reviewed, **Then** all gaps identified in the strategy analysis are resolved — either a new mobile flow exists or a written N/A justification is present.

---

### User Story 6 — Reliable Test Cleanup (Priority: P2)

As a developer running E2E tests repeatedly, data created by tests that fail mid-run does not affect subsequent runs, because teardown uses a reliable mechanism independent of the app's UI state at the time of failure.

**Why this priority**: Dirty test state causes intermittent failures that waste debugging time and erode confidence in the test suite.

**Independent Test**: Intentionally fail a test mid-run (before teardown), then run the suite again. The second run must not fail due to leftover data from the first.

**Acceptance Scenarios**:

1. **Given** a test creates a record and the test body throws before teardown, **When** the post-test hook runs, **Then** the record is deleted via the application's backend API regardless of where the test failed.
2. **Given** a test run crashes entirely and leaves data, **When** the cleanup script is run, **Then** all test-prefixed collections are deleted.
3. **Given** the write-only fixture collection contains leftover movies from a previous run, **When** global setup runs, **Then** those movies are deleted before tests begin.

---

### User Story 7 — TDD Checkpoint Enforcement (Priority: P2)

As a developer following TDD, every test task in the feature task list includes the exact command to verify the test is RED before implementation, and the exact command to verify GREEN after — making it impossible to accidentally skip the RED verification gate.

**Why this priority**: Skeleton tests that always pass (because they were never verified RED) erode TDD discipline silently. Explicit verify commands embedded in each task make the RED gate a written instruction, not an assumption.

**Independent Test**: Read any TDD task pair in a feature task list and confirm it contains: a scenarios list, a Verify RED command with expected output, and a paired implementation task with a Verify GREEN command.

**Acceptance Scenarios**:

1. **Given** a test task is added to a feature task list, **When** reviewed, **Then** it contains a Scenarios list and a Verify RED command with the expected output (failure count > 0).
2. **Given** the paired implementation task, **When** reviewed, **Then** it contains a Verify GREEN command with the expected output (failure count = 0).
3. **Given** the Verify RED command is run and shows 0 failures, **Then** the test task is blocked — the test is trivially passing and must be fixed before implementation begins.

---

### Edge Cases

- **Output compression not installed**: The codebase documentation Prerequisites section makes it mandatory; a session must not begin without it active.
- **Fixture seed fails because the backend API is unavailable**: Global setup fails immediately with a clear error and does not proceed to run tests.
- **Post-test API teardown fails** (e.g., record already deleted): The failure is silently swallowed; the test result is not affected.
- **Fixture collection modified by a test**: Global setup detects the discrepancy on the next run and repairs it before tests run.
- **Mobile API teardown**: The mobile E2E framework supports calling the backend API from within a flow; in-flow UI teardown is acceptable where direct API calls are impractical.
- **A verify-RED command shows 0 failures**: The test task is wrong (trivially passing) and must be corrected before the implementation task begins. This is not a constitution violation — it is the constitution working correctly.

---

## Requirements *(mandatory)*

### Functional Requirements

**Token Efficiency**

- **FR-001**: An output-compression mechanism MUST be installed and globally activated on all developer machines used for AI-assisted development, so that test command output reaching the agent context is compressed to a summary line and failure detail only.
- **FR-002**: The web E2E test runner MUST be configured to a minimal output mode (one character per passing test) so verbose pass output does not reach the agent context.
- **FR-003**: The unit test runner MUST be configured to suppress console output from passing tests.

**Session Management**

- **FR-004**: Web E2E tests MUST use a pre-saved authenticated session loaded by global setup; no individual test triggers an identity provider authentication flow.
- **FR-005**: Global setup MUST perform the identity provider login exactly once per run and save the session state to a file before any test runs.
- **FR-006**: Tests that exercise authentication flows MUST opt out of the inherited session explicitly.

**Fixture Dataset**

- **FR-007**: A typed fixture definition MUST be specified in source code, declaring the exact collections and movies in the base test dataset (minimum: one read-only browse collection with 10 movies covering all attribute combinations needed for filter tests, one write-only mutation collection, one default-collection test collection).
- **FR-008**: Global setup MUST verify the fixture dataset exists and MUST create any missing elements via the application's backend API before any test runs.
- **FR-009**: The write-only fixture collection MUST be reset to empty at the start of every global setup run.
- **FR-010**: Search and filter tests MUST assert exact expected counts derived from the fixture definition.

**Test Discipline**

- **FR-011**: Codebase documentation MUST contain a Test Run Protocol specifying ordered steps: isolated test → user-story suite → full suite (final validation only).
- **FR-012**: Codebase documentation MUST contain a Feature Branch Test Scope map linking each user story to its corresponding test files.
- **FR-013**: Codebase documentation MUST contain a Final Validation Checklist enumerating all test and coverage commands that must pass before a feature is marked complete.

**Cleanup**

- **FR-014**: All E2E tests that create records MUST perform teardown in a post-test hook using calls to the application's backend API, not UI interactions.
- **FR-015**: A cleanup script MUST exist to delete all test-prefixed collections on demand, for use after crashed test runs.

**Parity**

- **FR-016**: Each feature's task list MUST contain a Platform Parity table listing every test scenario with its web and mobile implementation status.
- **FR-017**: Any scenario listed as N/A for one platform MUST include a written justification.

**TDD Checkpoints**

- **FR-018**: Every test task MUST include: the scenarios being covered, the command to verify RED, and the expected RED output.
- **FR-019**: Every paired implementation task MUST include: the command to verify GREEN, and the expected GREEN output.

**Template**

- **FR-020**: A reusable feature test template MUST exist and be referenced from codebase documentation, providing the standard format for test tasks, TDD checkpoints, and parity tables for all future features.

### Key Entities

- **Test Fixture**: Pre-seeded, typed dataset that E2E tests read from. Defined in code, seeded by global setup.
- **Global Setup**: A one-time pre-test step that authenticates once, seeds the fixture, and saves session state.
- **Platform Parity Table**: Per-feature table tracking web and mobile test coverage for every scenario.
- **Test Run Protocol**: Ordered procedure in codebase documentation governing which tests to run and when.

---

## Success Criteria *(mandatory)*

- **SC-001**: Full web E2E suite runs with exactly 1 identity provider login (global setup only); no login in any individual test.
- **SC-002**: The output-compression metric shows >80% token reduction on test commands after a full test run.
- **SC-003**: All filter and search E2E tests assert exact expected counts from the fixture definition.
- **SC-004**: Codebase documentation contains the Test Run Protocol, Feature Branch Test Scope map, and Final Validation Checklist.
- **SC-005**: Platform parity tables exist for features 001, 002, and 003.
- **SC-006**: All gaps in the feature 002 parity table are resolved (new flow or written N/A justification).
- **SC-007**: All write tests in the feature 001 and 002 E2E suites use post-test-hook + backend-API teardown.
- **SC-008**: Cleanup script exists and successfully removes test-prefixed collections.
- **SC-009**: Every test task added in this feature uses the TDD checkpoint format.
- **SC-010**: `docs/templates/feature-test-tasks-template.md` exists and is referenced in codebase documentation.

---

## Assumptions

- The output-compression mechanism is available for the primary development platform (Windows) and activates globally per shell.
- The application's backend is running during global setup (E2E tests require the full stack regardless).
- The web E2E framework supports pre-saved session state that correctly persists identity provider cookies across test files.
- The mobile E2E framework supports calling the application's backend API from within a flow via script evaluation.
- The E2E test user account is pre-configured in the identity provider with the `mc-user` role.
- No production application code is modified by this feature.
- Existing passing tests must not be broken by these changes; if a test was passing due to vacuous assertions, making it fail by replacing with exact-count assertions is expected and correct per TDD.
