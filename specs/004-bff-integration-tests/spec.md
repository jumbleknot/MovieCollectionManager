# Feature Specification: BFF Integration Test Replacement

**Feature Branch**: `004-bff-integration-tests`
**Created**: 2026-05-30
**Status**: Draft
**Input**: `MCM-Testing-Strategy.docx` (finding: the BFF integration tests rely on client-side HTTP mocking and verify only hardcoded fixture serialization, not the real BFF ↔ identity-provider ↔ session-store contract)

## Clarifications

### Session 2026-05-30

- Q: How should integration tests acquire real identity-provider tokens without a browser? → A: Use a non-interactive direct-credential token grant on a dedicated, test-only client. This grant is restricted to the test environment and must not be enabled on any production client.
- Q: Should the browser-initiated authorization-code exchange be integration-tested? → A: No. It requires a browser-driven flow and is already exercised by the end-to-end global setup (feature 003). The integration-test boundary begins after code exchange: token validation, session creation, session-store persistence, and downstream endpoints (refresh, current-user, logout) are all in scope.
- Q: Should existing test files be rewritten in-place or deleted and replaced? → A: Deleted and replaced. The existing files provide no meaningful coverage and their structure (mocking the HTTP client) cannot be salvaged. New files follow the module-per-file structure matching the backend service's integration tests.
- Q: Does this feature change production code? → A: No. One identity-provider configuration change is required (a new test-only client with the direct-credential grant enabled). No BFF source code is modified.

---

## User Scenarios & Testing *(mandatory)*

The actors are the **developer** and the **AI assistant** maintaining the BFF; the system under test is the BFF, exercised against a real identity provider and a real session store. "Integration test" here means a test driving real upstreams and asserting the observable contract — not a unit test with mocked collaborators.

### User Story 1 — Real token validation contract (Priority: P0)

As a developer changing the BFF's token validation logic, the integration suite catches regressions against the real identity provider's public-key endpoint — not a hardcoded fixture token.

**Why this priority**: Token validation is the BFF's primary security mechanism. A mock that returns a pre-built "valid" response gives zero coverage of signature verification, claim validation (issuer, audience, expiry, token-hash), or public-key caching. A regression here is a silent security hole.

**Independent Test**: Obtain a real token from the identity provider via the direct-credential grant, pass it to the token-validation module, and verify the claims are correctly extracted and validated.

**Acceptance Scenarios**:

1. **Given** a valid token issued by the identity provider, **When** the token-validation module validates it, **Then** signature verification passes and all standard claims (subject, issuer, audience, roles) are correctly extracted.
2. **Given** a token with an expired expiry claim, **When** the module validates it, **Then** validation fails with a typed expired-token error.
3. **Given** a token signed by a different key, **When** the module validates it, **Then** validation fails with a typed invalid-token error.
4. **Given** a token missing the required application role (`mc-user` or `mc-admin`), **When** roles are extracted, **Then** the roles do not include the missing role and the role-check functions return false.

---

### User Story 2 — Real session management contract (Priority: P0)

As a developer changing the session-management module, the integration suite catches regressions against the real session store — including idle-timeout enforcement, concurrent-session limits, and session key structure.

**Why this priority**: Session bugs are invisible until production. A mock that asserts "session created" without checking the session store cannot catch timeout misconfiguration, key collision, or eviction bugs.

**Independent Test**: Create a session with a real token payload, then inspect the session store directly to verify the key, timeout, and stored data.

**Acceptance Scenarios**:

1. **Given** a valid token payload, **When** a session is created, **Then** the session key exists in the session store with a time-to-live matching the configured idle timeout.
2. **Given** an existing session, **When** it is retrieved, **Then** the returned data matches the original payload and the session's absolute expiry is respected.
3. **Given** an idle session whose time-to-live has elapsed, **When** it is retrieved, **Then** it returns nothing (session expired).
4. **Given** a user already at the configured maximum concurrent sessions, **When** a new session is created, **Then** the oldest session is evicted from the session store before the new one is stored.
5. **Given** an active session, **When** it is deleted, **Then** the key no longer exists in the session store.

---

### User Story 3 — Real token refresh contract (Priority: P1)

As a developer changing the BFF refresh endpoint, the integration suite verifies that a real refresh token is exchanged with the identity provider, the new access token is validated, and the stored session is updated atomically.

**Why this priority**: Silent token refresh keeps users logged in. A mock returning a canned success response cannot catch misconfigured refresh-token rotation, a stale stored session after refresh, or rejection of an already-rotated refresh token.

**Independent Test**: Create a real stored session with a real refresh token (obtained via the direct grant), call the refresh endpoint, and verify the stored session now contains the new access and refresh tokens issued by the identity provider.

**Acceptance Scenarios**:

1. **Given** a valid session cookie backed by a real stored session with a real refresh token, **When** the refresh endpoint is called, **Then** the identity provider issues new tokens and the stored session is updated with them.
2. **Given** a refresh token that has already been used (rotated), **When** the refresh endpoint is called again with the old token, **Then** the identity provider rejects it and the endpoint returns unauthorized.
3. **Given** no session cookie, **When** the refresh endpoint is called, **Then** the endpoint returns unauthorized without contacting the identity provider.

---

### User Story 4 — Real logout contract (Priority: P1)

As a developer changing the BFF logout endpoint, the integration suite verifies that the stored session is deleted AND the identity provider's SSO session is terminated via its administrative API.

**Why this priority**: The constitution (Session Invalidation, v1.1.0) requires logout to terminate the IAM SSO session — not just the BFF session. A mock that asserts only a success response cannot verify the identity provider was called.

**Independent Test**: Create a real stored session, call the logout endpoint, then verify the session key is absent from the session store and the identity provider reports no active sessions for the user.

**Acceptance Scenarios**:

1. **Given** a valid session cookie, **When** the logout endpoint is called, **Then** the stored session key is deleted.
2. **Given** a valid session cookie, **When** the logout endpoint is called, **Then** the identity provider's user session is terminated (verified via its administrative API: no active sessions for the user).
3. **Given** no session cookie, **When** the logout endpoint is called, **Then** the endpoint returns unauthorized and no session-store or identity-provider state is modified.

---

### User Story 5 — Real registration contract (Priority: P1)

As a developer changing the BFF registration endpoint, the integration suite verifies that the identity provider's administrative API is called correctly to create users, assign the `mc-user` role, and trigger email verification.

**Why this priority**: Registration calls the administrative API with a service account. A mock cannot catch a misconfigured service account, a missing role assignment, or a broken email-verification trigger.

**Independent Test**: Call the registration endpoint with valid credentials, then verify via the administrative API that the user exists, has the `mc-user` role, and has a pending email verification.

**Acceptance Scenarios**:

1. **Given** valid registration credentials, **When** the registration endpoint is called, **Then** the identity provider creates the user account with the `mc-user` role assigned and email verification pending.
2. **Given** a username that already exists, **When** the registration endpoint is called, **Then** the endpoint returns conflict and no duplicate user is created.
3. **Given** a password that does not meet the identity provider's policy, **When** the registration endpoint is called, **Then** the request is rejected and the endpoint returns a policy-violation error.

*(Note: email delivery is out of scope — the dev mail capture tool receives the message; the test verifies only that the identity provider's verification state is set.)*

---

### User Story 6 — Real rate limiter contract (Priority: P2)

As a developer changing the rate-limiting module, the integration suite verifies that repeated requests from the same client are counted and blocked using the real session store.

**Why this priority**: The rate limiter is the first line of defence against brute-force login attacks. A mock that asserts only that a rate-limited response can be returned cannot catch a key-naming bug or a window that resets prematurely.

**Independent Test**: Call the login endpoint repeatedly from the same client until the real counter triggers the limit; verify the rate-limited response and the counter key's time-to-live.

**Acceptance Scenarios**:

1. **Given** repeated login attempts from the same client exceeding the configured limit, **When** the next request arrives, **Then** the endpoint returns the rate-limited response and the counter key exists in the session store with a non-zero time-to-live.
2. **Given** the rate-limit window has elapsed (time-to-live expired), **When** a new login attempt arrives, **Then** the request is accepted normally (counter reset).

---

### Edge Cases

- **Direct-credential grant used only in test scope**: the test-only client has the direct-credential grant enabled; the production client must not. Tests must never import the token-acquisition helper into production code.
- **Authorization-code exchange is out of scope**: the browser-initiated code exchange cannot be automated headlessly. It is covered by the end-to-end global setup (feature 003) and is documented explicitly in the test files; integration coverage begins after token acquisition.
- **Test user cleanup**: every test user created during a run must be deleted in teardown. Leaked test users in the identity provider are a defect.
- **Session-store isolation**: integration tests must use a dedicated session-store namespace (separate key prefix or database index) so they never collide with the running development BFF.
- **Rate-limiter test ordering**: rate-limit tests must reset their counter keys before each test so one test's state cannot affect the next.

---

## Requirements *(mandatory)*

### Functional Requirements

**Test Infrastructure**

- **FR-001**: A dedicated, **test-only** identity-provider client configured for a non-interactive direct-credential token grant MUST exist, restricted to the test/dev environment and never enabled in production.
- **FR-002**: A test helper MUST exist to acquire real identity-provider tokens via the direct-credential grant for use in integration-test setup.
- **FR-003**: A test helper MUST exist to inspect session-store state directly (key existence, value, time-to-live) for use in integration-test assertions.
- **FR-004**: Integration tests MUST run against a real identity provider and a real session store. No client-side HTTP mocking may be used in any integration test file.
- **FR-005**: All test users created during integration runs MUST be deleted from the identity provider in teardown. Tests MUST NOT leave orphaned users.
- **FR-006**: Integration tests MUST use an isolated session-store namespace to avoid colliding with the development BFF session store.

**Token Validation**

- **FR-007**: Integration tests MUST verify that the token-validation module correctly validates a real identity-provider-issued token against the live public-key endpoint.
- **FR-008**: Integration tests MUST verify that the token-validation module rejects expired, tampered, and role-missing tokens with the correct typed error codes.

**Session Management**

- **FR-009**: Integration tests MUST verify that the session-management module creates, retrieves, and deletes sessions using the real session store.
- **FR-010**: Integration tests MUST verify that the configured idle timeout is correctly applied to new sessions.
- **FR-011**: Integration tests MUST verify that exceeding the configured maximum concurrent sessions evicts the oldest session from the session store.

**Auth Endpoints**

- **FR-012**: Integration tests MUST verify the refresh endpoint exchanges a real refresh token with the identity provider and updates the real stored session.
- **FR-013**: Integration tests MUST verify the logout endpoint deletes the stored session and terminates the identity provider's SSO session.
- **FR-014**: Integration tests MUST verify the registration endpoint creates a real identity-provider user with the `mc-user` role and email verification pending.
- **FR-015**: Integration tests MUST verify the current-user endpoint returns the correct user profile from a real stored session backed by a real token.

**Rate Limiting**

- **FR-016**: Integration tests MUST verify that the rate limiter correctly counts requests in the real session store and returns the rate-limited response after the configured threshold.

### Key Entities

- **Direct-Grant Test Client**: a test-only identity-provider client configured for the non-interactive direct-credential grant, used exclusively by integration tests to acquire real tokens without a browser.
- **Test User**: a short-lived identity-provider user created in setup for each test suite and deleted in teardown.
- **Session-Store Test Namespace**: a dedicated key prefix or database index used by integration tests to isolate their session data from the running BFF.

---

## Success Criteria *(mandatory)*

- **SC-001**: The integration suite passes with **no client-side HTTP mocking** used in any integration test.
- **SC-002**: The token-validation integration tests validate a real identity-provider token against the live public-key endpoint and correctly reject invalid tokens.
- **SC-003**: The session-management integration tests create, read, and expire sessions in the real session store; idle timeout and concurrent-session eviction are verified by direct session-store inspection.
- **SC-004**: The refresh-endpoint integration test uses a real refresh token and verifies the stored session is updated with the new tokens.
- **SC-005**: The logout-endpoint integration test verifies both stored-session deletion and identity-provider SSO session termination.
- **SC-006**: The registration-endpoint integration test creates a real identity-provider user with the correct role and cleans up the user in teardown.
- **SC-007**: The rate-limiter integration test verifies the rate-limited response is returned after the real counter reaches the threshold.
- **SC-008**: No integration test uses a client-side HTTP-mocking library.
- **SC-009**: All integration tests pass with the identity provider and session store running.

## Assumptions

- The identity provider and session store are reachable during integration runs (the same dependencies the existing integration tests nominally require).
- The BFF server is running for HTTP-level endpoint tests.
- The service account already holds the administrative permissions required to create and delete users (per feature 001 assumptions).
- A test-user password meeting the identity provider's policy is available in a gitignored environment file.
- The browser-initiated authorization-code exchange is intentionally out of scope — it is covered by the end-to-end global setup (feature 003).
- No production application code is modified; this feature adds tests, test-only helpers, and one test-only identity-provider client configuration.
