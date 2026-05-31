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

1. **Given** no session cookie, **When** the refresh endpoint is called, **Then** the endpoint returns unauthorized without contacting the identity provider.
2. **Given** a session cookie whose session does not exist (or has expired) in the session store, **When** the refresh endpoint is called, **Then** the endpoint returns unauthorized.
3. **Given** a valid session but no refresh-token cookie, **When** the refresh endpoint is called, **Then** the endpoint returns unauthorized.
4. *(Happy-path token rotation — valid session + valid refresh token → new tokens issued and stored session updated — is verified by the feature-003 E2E PKCE flow, not here: the refresh endpoint refreshes against the production client, whose refresh tokens are obtainable only via the browser authorization-code flow. The direct-grant test client must not be enabled on the production client, so a refreshable production-client token cannot be acquired headlessly. Same rationale as the login code-exchange exclusion.)*

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
2. **Given** the rate-limit counter key is cleared/expired in the session store, **When** a new login attempt arrives, **Then** the request is accepted normally (counter reset).

---

### User Story 7 — Collection & movie proxy routes contract-tested (Priority: P1)

As a developer changing the BFF proxy layer, the integration suite verifies every collection and movie endpoint enforces auth and role checks **before** contacting the backend service, propagates the caller's identity, proxies the success response unchanged, and maps the backend's domain errors unchanged — against the real backend, not a mock.

**Why this priority**: The proxy routes are the largest BFF surface with **no integration coverage at all** today, and they are the security boundary in front of the backend. A regression in auth/role enforcement or error mapping here is a silent hole.

**Independent Test**: For each collection/movie endpoint, drive it against the running backend with a real session and assert the success contract, the unauthorized/forbidden rejections, identity propagation, and unchanged error propagation.

**Acceptance Scenarios**:

1. **Given** an authenticated user with the required role, **When** they call any collection/movie endpoint with valid input, **Then** the request is proxied and the backend's status and body are returned unchanged.
2. **Given** no valid session, **When** any collection/movie endpoint is called, **Then** it is rejected as unauthorized **before** any backend call (proven mock-free: the response is the BFF's typed auth error, and for write methods a backend-state probe shows no mutation).
3. **Given** an authenticated user lacking the required role, **When** any collection/movie endpoint is called, **Then** it is rejected as forbidden **before** any backend call (proven mock-free, as above).
4. **Given** an authorized request, **When** the BFF proxies it, **Then** the caller's identity is included in the forwarded request to the backend.
5. **Given** the backend returns a domain error (not-found, conflict/duplicate, validation failure), **When** the BFF receives it, **Then** an equivalent standard error is returned to the client, unchanged in meaning and without leaking internals.

---

### User Story 8 — Remaining auth endpoints contract-tested (Priority: P2)

As a developer maintaining the auth boundary, the integration suite covers the remaining auth endpoints — session-init, email-verification, and resend-verification — for their success and documented failure paths.

**Why this priority**: These complete the auth surface so no auth endpoint is left unverified, but they are lower-traffic than the core token/session/proxy flows.

**Independent Test**: Drive each of these endpoints against the running identity provider/session store and assert the documented outcomes.

**Acceptance Scenarios**:

1. **Given** the session-init endpoint, **When** it is called, **Then** it returns ok. *(It ensures the identity-provider client's redirect URIs and is auth-agnostic — it does not report a per-caller authentication status, so it returns ok with or without a session.)*
2. **Given** the email-verification endpoint, **When** it is called with no token, **Then** it returns an invalid-token error; **and when** called with a malformed/expired token, **Then** it returns an invalid/expired-token error. *(Happy-path verification consumes a Keycloak email action-token from the verification link, which is not obtainable headlessly — it is covered by the manual/E2E verification flow, same rationale as the login exclusion.)*
3. **Given** the resend-verification endpoint, **When** called with an invalid email, **Then** it returns a validation error; **when** called with an unknown email, **Then** it returns a generic success (no user enumeration); **when** called beyond the per-email limit, **Then** it returns rate-limited.

---

### User Story 9 — No untested BFF route (coverage completeness gate) (Priority: P1)

As a developer adding or changing BFF routes, a completeness gate guarantees every BFF route is backed by at least one integration test (or a written, justified exclusion), and fails when a new route ships without coverage.

**Why this priority**: Per-endpoint tests can drift as routes are added; a structural gate turns "no untested routes" from a one-time audit into an enforced invariant — the deny-by-default principle applied to coverage.

**Independent Test**: Add a throwaway route file with no test and confirm the gate test fails; remove it and confirm the gate passes.

**Acceptance Scenarios**:

1. **Given** the set of BFF route files, **When** the coverage gate runs, **Then** it confirms each route file maps to at least one integration test **or** a written justified exclusion in the endpoint-coverage matrix.
2. **Given** a route file with no mapped test and no exclusion, **When** the gate runs, **Then** it fails and names the uncovered route.
3. **Given** the one intentional exclusion — the login code-exchange endpoint (covered by the end-to-end suite) — **When** the gate runs, **Then** that exclusion is accepted because it is explicitly justified.

---

### Edge Cases

- **Backend service unavailable** (proxy routes): the BFF returns a safe, typed error (not a stack trace), and the proxy test asserts that mapping.
- **A new route file added without a test or exclusion**: the coverage-gate test fails, surfacing the omission before merge.
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

- **FR-012**: Integration tests MUST verify the refresh endpoint's guard paths against the real session store: missing session cookie → unauthorized; session absent/expired in the store → unauthorized; missing refresh-token cookie → unauthorized. The happy-path token rotation (valid refresh token → new tokens + updated stored session) is covered by the feature-003 E2E PKCE flow — the refresh endpoint refreshes against the production client, whose refresh tokens are not obtainable via the direct-grant test client (which must never be enabled on the production client).
- **FR-013**: Integration tests MUST verify the logout endpoint deletes the stored session and terminates the identity provider's SSO session.
- **FR-014**: Integration tests MUST verify the registration endpoint creates a real identity-provider user with the `mc-user` role and email verification pending.
- **FR-015**: Integration tests MUST verify the current-user endpoint returns the correct user profile from a real stored session backed by a real token.

**Rate Limiting**

- **FR-016**: Integration tests MUST verify that the rate limiter correctly counts requests in the real session store and returns the rate-limited response after the configured threshold.

**Collection & Movie Proxy Endpoints**

- **FR-017**: Every BFF collection and movie endpoint and method (collection list, create, read, update, delete; movie list, create, read, update, delete; movie filter options) MUST have an integration test asserting an authorized request is proxied to the backend and the backend's status and body are returned unchanged.
- **FR-018**: Each collection/movie endpoint MUST have an integration test asserting a request without a valid session is rejected as unauthorized. "Before any backend call" MUST be proven without mocking the backend, by both: (a) the response being the BFF's typed unauthorized error (not a proxied backend body or 5xx upstream error), and (b) for write methods, a direct backend-state probe confirming no document was created/modified/deleted.
- **FR-019**: Each collection/movie endpoint MUST have an integration test asserting an authenticated caller lacking the required role is rejected as forbidden. "Before any backend call" MUST be proven without mocking the backend, by both: (a) the response being the BFF's typed forbidden error (not a proxied backend body), and (b) for write methods, a direct backend-state probe confirming no mutation occurred.
- **FR-020**: Integration tests MUST assert that, on an authorized proxy request, the caller's identity is propagated to the backend service.
- **FR-021**: For each collection/movie endpoint, integration tests MUST assert that documented backend domain errors (not-found, conflict/duplicate, validation) are returned to the client unchanged in meaning, with no internal detail leaked.

**Remaining Auth Endpoints**

- **FR-022**: Integration tests MUST cover the session-init endpoint (returns ok), the email-verification endpoint's documented failure paths (missing token, malformed/expired token → typed errors), and the resend-verification endpoint (invalid email → validation error; unknown email → generic success with no enumeration; per-email limit exceeded → rate-limited). The email-verification happy path (valid Keycloak action-token) is covered by the manual/E2E verification flow — the action-token is not obtainable headlessly.

**Route Coverage Completeness**

- **FR-023**: An endpoint-coverage matrix MUST map every BFF route file and method to its integration test(s) or to a written, justified exclusion.
- **FR-024**: A structural coverage-gate integration test MUST fail if any BFF route file lacks a mapped integration test or a justified exclusion (deny-by-default for coverage). The only permitted exclusion is the login code-exchange endpoint, justified by its end-to-end coverage.

### Key Entities

- **Direct-Grant Test Client**: a test-only identity-provider client configured for the non-interactive direct-credential grant, used exclusively by integration tests to acquire real tokens without a browser.
- **Test User**: a short-lived identity-provider user created in setup for each test suite and deleted in teardown.
- **Session-Store Test Namespace**: a dedicated key prefix or database index used by integration tests to isolate their session data from the running BFF.
- **Endpoint Coverage Matrix**: the mapping of every BFF route file + method to its integration test(s) or a written justified exclusion — the artifact the coverage gate enforces.
- **Proxy Endpoint Under Test**: a collection/movie route + method, with its required role, success contract, and documented backend failure responses.

---

## Success Criteria *(mandatory)*

- **SC-001**: The integration suite passes with **no client-side HTTP mocking** used in any integration test.
- **SC-002**: The token-validation integration tests validate a real identity-provider token against the live public-key endpoint and correctly reject invalid tokens.
- **SC-003**: The session-management integration tests create, read, and expire sessions in the real session store; idle timeout and concurrent-session eviction are verified by direct session-store inspection.
- **SC-004**: The refresh-endpoint integration tests verify the real guard paths (no session cookie, absent/expired session, missing refresh-token cookie → 401) against the real session store + BFF. Happy-path token rotation is covered by the feature-003 E2E PKCE flow (production-client refresh tokens are not obtainable headlessly).
- **SC-005**: The logout-endpoint integration test verifies both stored-session deletion and identity-provider SSO session termination.
- **SC-006**: The registration-endpoint integration test creates a real identity-provider user with the correct role and cleans up the user in teardown.
- **SC-007**: The rate-limiter integration test verifies the rate-limited response is returned after the real counter reaches the threshold.
- **SC-008**: No integration test uses a client-side HTTP-mocking library.
- **SC-009**: All integration tests pass with the identity provider, session store, and backend service running.
- **SC-010**: 100% of BFF collection/movie endpoint+method combinations have integration tests for the success path, the unauthorized (no session) rejection, and the forbidden (wrong role) rejection.
- **SC-011**: The session-init (ok), email-verification (missing/invalid-token failures), and resend-verification (invalid email, unknown email, rate-limit) endpoints each have real integration tests. The email-verification valid-token happy path is covered by the manual/E2E flow (Keycloak action-token not obtainable headlessly).
- **SC-012**: Every BFF route file has ≥1 integration test or a written justified exclusion, verified by the coverage-gate test; the only exclusion is the login code-exchange endpoint (covered end-to-end).
- **SC-013**: The coverage-gate test fails when a new route file is added without an integration test or a justified exclusion (no untested route can ship silently).

## Assumptions

- **Scope**: **all** BFF route files are in scope. Integration coverage spans the auth endpoints (real replacements for the former mock tests), the token-validation / session-management / rate-limiting modules, and the collection/movie proxy endpoints (new coverage). The login code-exchange endpoint is the single justified exclusion (covered by the end-to-end suite, feature 003).
- The identity provider, session store, **and backend service** are reachable during integration runs (proxy-route tests require the backend and its database — the full local/CI stack).
- The BFF server is running for HTTP-level endpoint tests.
- The service account already holds the administrative permissions required to create and delete users (per feature 001 assumptions).
- A test-user password meeting the identity provider's policy is available in a gitignored environment file.
- The browser-initiated authorization-code exchange is intentionally out of scope — it is covered by the end-to-end global setup (feature 003).
- No production application code is modified; this feature adds tests, test-only helpers, and one test-only identity-provider client configuration.
