# Feature Specification: BFF Integration Tests

**Feature Branch**: `004-bff-integration-tests`

**Created**: 2026-05-30

**Status**: Draft

**Input**: User description: "bff-integration-tests"

## Overview

The Backend-for-Frontend (BFF) is the security boundary between the client apps and the backend: it validates sessions, enforces access control, injects user identity, proxies to the movie-collection backend service, and maps upstream errors to safe, standard responses. Its **auth** endpoints have integration coverage today, but the **collection and movie proxy endpoints** (added for the manage-movie-collection feature) have **no service-to-service integration tests** — their auth enforcement, identity propagation, and error mapping are unverified against the real backend, identity provider, and session store.

This feature delivers comprehensive BFF **integration tests** that verify the BFF's service-to-service and service-to-session-store contracts end to end, closing the collection/movie gap and confirming the auth baseline. Tests follow the established hardening conventions (verified base data set, self-cleanup, isolated and repeatable). No production application code changes.

## User Scenarios & Testing *(mandatory)*

The actors are the **developer** and the **AI assistant** maintaining the BFF; the system under test is the BFF itself, exercised against the running backend service, identity provider, and session store. "Integration test" here means a test that drives a BFF endpoint with a real (or realistically provisioned) upstream and asserts the observable contract — status, body shape, identity propagation, and error mapping — not a unit test with mocked collaborators.

### User Story 1 - Collection & movie proxy routes are contract-tested (Priority: P1)

Every BFF collection and movie endpoint (list, create, read, update, delete, filter options) has integration tests that drive it against the real backend service and assert the full contract: an authenticated, authorized request is proxied and returns the backend's response unchanged; the user's identity is propagated to the backend; and the route behaves correctly for the success path and each documented failure.

**Why this priority**: These routes are the largest untested surface of the security boundary and the most recently added. Verifying them is the core value — it's where real regressions are most likely and currently invisible.

**Independent Test**: For each collection/movie endpoint, run its integration tests against the running stack and confirm a happy-path request succeeds with the expected response shape and that the user's identity reaches the backend.

**Acceptance Scenarios**:

1. **Given** an authenticated user with the required role, **When** they call any collection/movie endpoint with valid input, **Then** the request is proxied to the backend and the backend's status and body are returned unchanged.
2. **Given** a request with no valid session, **When** it hits any collection/movie endpoint, **Then** the BFF rejects it with an unauthorized response before contacting the backend.
3. **Given** an authenticated user lacking the required application role, **When** they call any collection/movie endpoint, **Then** the BFF rejects it with a forbidden response before contacting the backend.
4. **Given** an authenticated, authorized request, **When** the BFF proxies it, **Then** the caller's identity is included in the forwarded request to the backend.
5. **Given** the backend returns a domain error (e.g., not found, conflict/duplicate, validation failure), **When** the BFF receives it, **Then** the BFF returns an equivalent standard error response to the client without altering its meaning or leaking internals.

---

### User Story 2 - Auth route integration coverage is complete and verified (Priority: P2)

The BFF auth endpoints (session init, login, logout, token refresh, registration, email verification, resend verification, current-user profile) all have integration tests covering their success and failure paths, and any gaps in the existing baseline are filled.

**Why this priority**: Auth is the foundation of the boundary and already has partial coverage; verifying completeness and filling gaps protects the most security-critical flows, but it extends an existing baseline rather than creating new coverage from nothing.

**Independent Test**: Produce a matrix of auth endpoints versus their documented outcomes and confirm each cell has a passing integration test (or a justified exclusion).

**Acceptance Scenarios**:

1. **Given** the set of auth endpoints, **When** the auth integration suite runs, **Then** each endpoint has at least one success-path test and tests for each of its documented failure responses.
2. **Given** repeated rapid auth attempts beyond the allowed limit, **When** the limit is exceeded, **Then** the BFF returns a rate-limited response and the event is auditable.
3. **Given** a user exceeding the concurrent-session limit, **When** a new session is established, **Then** the oldest session is invalidated as specified.

---

### User Story 3 - Cross-cutting boundary guarantees are verified (Priority: P2)

Integration tests assert the BFF's cross-cutting security contracts independent of any single endpoint: deny-by-default access control, safe error responses that never expose internals, audit logging of security-relevant events, and correct identity propagation.

**Why this priority**: These guarantees are constitutional requirements that span every route; verifying them once as cross-cutting tests prevents a per-route omission from silently weakening the boundary.

**Independent Test**: Add a new (or temporarily unprotect a) protected endpoint and confirm the deny-by-default and error-safety tests catch any boundary regression.

**Acceptance Scenarios**:

1. **Given** any internal endpoint, **When** it is called without a valid session, **Then** access is denied by default.
2. **Given** any error condition (upstream failure, invalid input, missing permission), **When** the BFF responds, **Then** the response contains no stack traces, internal paths, or upstream implementation details.
3. **Given** a security-relevant event (auth success/failure, access denied, rate-limit hit), **When** it occurs during a test, **Then** a corresponding audit record is produced with the user identifier (never email/username) where available.

---

### User Story 4 - Integration tests are isolated, repeatable, and self-cleaning (Priority: P3)

The integration suite verifies-or-creates its required base data before running, cleans up any data it creates beyond the base set, and produces the same result on repeated back-to-back runs.

**Why this priority**: Reliability of the suite is what makes it trustworthy for continuous use; it builds on the established hardening conventions and is lower urgency than the coverage itself.

**Independent Test**: Run the integration suite twice in a row from a clean state and confirm both runs pass with no residue and no collisions.

**Acceptance Scenarios**:

1. **Given** the required base data is missing, **When** the suite starts, **Then** it creates the base data before running tests.
2. **Given** a test creates data beyond the base set, **When** the test finishes (pass or fail), **Then** that data is removed.
3. **Given** a completed run, **When** the suite is run again immediately, **Then** it passes with no failures attributable to leftover data.

### Edge Cases

- **Backend service unavailable**: the BFF returns a safe, typed error (not a stack trace), and the test asserts that mapping.
- **Identity provider unavailable** during a token operation: the BFF returns a safe error; no partial/half-authenticated state leaks.
- **Session store unavailable**: the BFF fails closed (denies access) rather than failing open.
- **Expired or tampered session/token**: rejected as unauthorized; not proxied.
- **Malformed request body** to a create/update endpoint: rejected with a validation error before or consistently with backend validation.
- **Conflict/duplicate** (e.g., duplicate collection or movie) and **not-found**: the backend's status is propagated unchanged with no internal detail.
- **A protected endpoint added without an auth guard**: the deny-by-default cross-cutting test fails, surfacing the omission.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every BFF collection and movie endpoint and method (collection list, collection create, collection read, collection update, collection delete, movie list, movie create, movie read, movie update, movie delete, movie filter options) MUST have at least one happy-path integration test asserting the proxied response matches the backend's status and body.
- **FR-002**: Each collection/movie endpoint MUST have an integration test asserting that a request without a valid session is rejected as unauthorized **before** any backend call.
- **FR-003**: Each collection/movie endpoint MUST have an integration test asserting that an authenticated user lacking the required application role is rejected as forbidden **before** any backend call.
- **FR-004**: Integration tests MUST assert that, on an authorized request, the caller's identity is propagated to the backend service.
- **FR-005**: For each collection/movie endpoint, integration tests MUST assert that documented backend domain errors (not-found, conflict/duplicate, validation failure) are returned to the client as equivalent standard error responses, unchanged in meaning.
- **FR-006**: Every BFF auth endpoint (session init, login, logout, refresh, register, verify email, resend verification, current-user) MUST have integration tests for its success path and each documented failure response.
- **FR-007**: Integration tests MUST verify rate limiting on the endpoints that enforce it (e.g., login, logout) and that exceeding the limit yields the rate-limited response.
- **FR-008**: Integration tests MUST verify the concurrent-session limit behavior (oldest session evicted when the limit is exceeded).
- **FR-009**: Integration tests MUST assert deny-by-default: a protected endpoint is inaccessible without a valid session.
- **FR-010**: Integration tests MUST assert that error responses never expose stack traces, internal file paths, or upstream implementation details.
- **FR-011**: Integration tests MUST assert that security-relevant events produce audit records identifying the user by stable identifier only (never email or username), where a user identity is available.
- **FR-012**: Integration tests MUST cover the unavailability of each upstream dependency (backend service, identity provider, session store) and assert the BFF returns a safe error and fails closed for access decisions.
- **FR-013**: The integration suite MUST verify-or-create its required base data set before running and MUST restore the base set if it is missing or incomplete.
- **FR-014**: Integration tests MUST remove any data they create beyond the base set, whether the test passes or fails.
- **FR-015**: The integration suite MUST be runnable through the project's standard test invocation and MUST produce a consistent pass result on repeated back-to-back runs.
- **FR-016**: Each integration test MUST follow the project's TDD checkpoint conventions and the reusable test-task template.

### Key Entities *(include if data involved)*

- **BFF Endpoint Under Test**: A single BFF route + method, with its required role, expected success contract, and documented failure responses.
- **Endpoint Coverage Matrix**: The mapping of every BFF endpoint/method to its success-path and failure-path tests (used to prove completeness).
- **Upstream Dependency**: A service the BFF integrates with (backend service, identity provider, session store), each with an available and an unavailable test condition.
- **Base Data Set**: The verified, reusable fixture data the integration suite requires (e.g., an authenticated test identity with the required role, seed collections/movies).
- **Audit Record**: The security-event log entry an integration test asserts, identified by user identifier only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of BFF collection/movie endpoint+method combinations have a passing happy-path integration test.
- **SC-002**: 100% of BFF collection/movie endpoints have unauthorized (no session) and forbidden (wrong role) integration tests that confirm rejection before any backend call.
- **SC-003**: 100% of BFF auth endpoints have integration tests for the success path and every documented failure response.
- **SC-004**: Every documented backend domain error (not-found, conflict/duplicate, validation) has an integration test confirming it is propagated unchanged in meaning.
- **SC-005**: 0 integration test responses expose internal details (stack traces, paths, upstream specifics) — verified by assertion.
- **SC-006**: Deny-by-default is proven: removing the auth guard from any single protected endpoint causes an integration test to fail.
- **SC-007**: Each upstream dependency has at least one unavailability test asserting a safe error and fail-closed access behavior.
- **SC-008**: The integration suite passes on two consecutive back-to-back runs with 0 residual data and 0 collision failures.
- **SC-009**: BFF integration line/branch coverage meets or exceeds the project minimum (≥70%) for the BFF modules under test.
- **SC-010**: The full integration suite completes within a bounded, documented time budget suitable for routine pre-merge runs.

## Assumptions

- **Scope**: all BFF endpoints are in scope, with **priority on the currently-untested collection/movie proxy routes**; existing auth integration tests are treated as a baseline to verify and extend, not rewrite. End-to-end (UI) tests and unit tests are out of scope except where a unit-level assertion is the only way to observe a contract.
- "Integration" means tests run against the real backend service, identity provider, and session store as provisioned for local/CI integration runs (the same dependencies the existing auth integration tests require), not fully mocked collaborators. Where a real upstream cannot be made to fail on demand, a controlled fault-injection or substitute is acceptable to exercise unavailability paths.
- The base data set and cleanup follow the conventions established by the test-hardening work (verify-or-create fixtures, self-cleanup, isolated/repeatable), reusing them where applicable.
- Audit-record assertions inspect the structured log/audit stream the BFF already emits; no new production logging is required by this feature.
- Required infrastructure (identity provider, session store, backend service, and its database) is available when the integration suite runs, consistent with current integration-test prerequisites.
- No production application code is modified; this feature adds test coverage and any necessary test-only fixtures/helpers.
