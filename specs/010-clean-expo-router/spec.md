# Feature Specification: Clean Expo Router

**Feature Branch**: `010-clean-expo-router`

**Created**: 2026-06-03

**Status**: Draft

**Input**: User description: "docs\PRD-CleanExpoRouter.md"

## Clarifications

### Session 2026-06-03

- Q: US3 (centralized gate) depends on a still-maturing platform capability — what is its commitment level in this feature? → A: Spike first; ship the gate in this feature if the viability check passes, otherwise descope the gate to a follow-up while US1+US2 still ship.
- Q: Should the token-refresh route be exempt from the gate (allowlisted as public), alongside sign-in/register/verify-email/resend/init? → A: Yes — refresh is gate-exempt and performs its own session-cookie validation (a strict access-token gate would otherwise block the refresh flow when the access token is already expired).
- Q: How should the gate's behavior be verified for the mobile client (FR-013 / US3 scenario 3)? → A: Server-side integration test (handler not executed when unauthenticated) plus the existing web E2E; no new mobile E2E flow — the gate is server-side and client-agnostic, so mobile's API calls traverse the identical server path.

## User Scenarios & Testing *(mandatory)*

This feature hardens three weak points at the application's request-handling boundary that surfaced during the previous remediation work: a fixed-name sub-route that was being handled by the wrong handler, an error boundary that silently dropped most client-error responses from its logs, and the absence of a single, centralized access-control gate for the server-side API.

### User Story 1 - Movie filter options always reach the correct handler (Priority: P1)

A signed-in user opens a movie collection and the filter controls (genre, content type, rating, language, decade, etc.) populate every time, reliably. Internally, the request that fetches those filter options must always be served by the dedicated filter-options handler — never misrouted to the single-movie handler, which happens to share a similar address.

**Why this priority**: This is the concrete defect that caused a real, user-visible outage (filter controls failing to load) and was repeatedly misdiagnosed as flaky tests. The previous fix is a permissive workaround, not a guarantee; without a deterministic routing guarantee plus a regression guard, the outage can silently return the next time the identifier rules are tightened or a new fixed-name sub-route is added.

**Independent Test**: Request a collection's filter options and confirm the response is the filter-options payload produced by the dedicated handler (not a single-movie response or an error), and confirm an automated guard fails if that request is ever served by the single-movie handler. Delivers value on its own: a permanently-protected filter feature.

**Acceptance Scenarios**:

1. **Given** a signed-in user with at least one collection, **When** they open the collection, **Then** the filter options load successfully on every attempt.
2. **Given** a request for a collection's filter options, **When** it is routed, **Then** it is handled by the dedicated filter-options handler and returns the filter-options result.
3. **Given** the request for a collection's filter options, **When** routing is tested, **Then** an automated guard fails if the request is rejected at the edge or does not return the filter-options result (the user-observable guarantee).
4. **Given** a request that carries a genuinely malformed/smuggling resource identifier, **When** it is received, **Then** it is still rejected with a clear client error before any downstream call (the permissive identifier rule is retained, not reverted to a strict format).

---

### User Story 2 - Every client-side error at the API boundary is diagnosable from logs (Priority: P2)

When a server-side API request fails with a client error (a 4xx), an operator or developer can determine, from the logs alone, which route failed and with what status — without having to add temporary instrumentation or reproduce the failure. Today only authentication/authorization failures are recorded; other client errors (for example, a rejected identifier) leave no trace and masquerade as random flakiness.

**Why this priority**: The missing log line is what turned a deterministic break into hours of misattributed "environment degradation." It is small, isolated, and high-leverage: it makes the whole class of boundary failures self-explaining. It is P2 because the user-facing defect (US1) is fixed independently, but this prevents the next mystery from costing the same diagnosis time.

**Independent Test**: Trigger a non-auth client-error response from the API boundary and confirm exactly one diagnostic log entry is emitted containing the route/action and the status, with no secrets or personal data. Delivers value on its own regardless of US1/US3.

**Acceptance Scenarios**:

1. **Given** an API request that results in any 4xx response at the shared error boundary, **When** the response is returned, **Then** a diagnostic log entry is recorded that identifies the action/route and the status code.
2. **Given** an authentication failure (401) or access-denied (403), **When** it occurs, **Then** it continues to be recorded as a security/audit event, with no duplication or downgrade.
3. **Given** any boundary log entry, **When** it is written, **Then** it contains no secrets, tokens, session identifiers, email addresses, or usernames.
4. **Given** an unexpected server error (5xx), **When** it occurs, **Then** its existing logging behavior is unchanged.

---

### User Story 3 - The server-side API enforces access centrally (Priority: P3)

Every protected server-side API request passes through a single, centralized access-control gate that rejects unauthenticated callers before any route-specific logic runs. Public endpoints (sign-in, registration, email verification, etc.) remain reachable. The gate covers requests from all client types (web and mobile) that reach the server over the network. This realizes the product's "centralized access control" principle for the API tier, which until now relied solely on each route remembering to check for itself.

**Why this priority**: This is the largest change and depends on a newer, still-maturing framework capability, so it is sequenced last. It is independently valuable: it closes a standing architectural gap (defense-in-depth, deny-by-default) and reduces the per-route duplication that makes a forgotten check possible.

**Independent Test**: Send an unauthenticated request to a protected API route and confirm it is rejected by the central gate without the route's own logic executing; send an unauthenticated request to a public route and confirm it still succeeds; disable the gate and confirm an automated safeguard fails. Delivers value on its own regardless of US1/US2.

**Acceptance Scenarios**:

1. **Given** an unauthenticated request to a protected API route, **When** it is received, **Then** it is rejected with an authentication error and standard security headers, and the route's own handler does not execute.
2. **Given** an unauthenticated request to a public API route (sign-in, registration, email verification, resend-verification, session init, token refresh), **When** it is received, **Then** it is processed normally.
3. **Given** a request from the mobile client over the network to a protected API route, **When** it is received, **Then** the same central gate applies as for the web client.
4. **Given** an authenticated request to a protected route, **When** it is processed, **Then** existing per-route authorization (role and resource-ownership checks) still applies in addition to the gate.
5. **Given** the central gate is removed or stops covering the protected routes, **When** the test suite runs, **Then** an automated safeguard fails.

---

### Edge Cases

- **New fixed-name sub-route added later**: When a future fixed-name sub-route is added next to the dynamic single-movie route, it must resolve to the fixed-name handler — the routing guarantee and guard should cover this general case, not just the one known sub-route.
- **Malformed / smuggling identifier**: A request whose identifier contains separators, encoded separators, traversal, whitespace, or is empty is rejected with a clear client error before any downstream call — and that rejection is now logged (US2).
- **Gate vs per-route check disagreement**: If the central gate denies, the request is rejected before the per-route check runs; the two never produce conflicting outcomes for the same request.
- **Client-side navigation**: In-app navigation that does not produce a network request to the server is unaffected by the central gate (the gate governs network API requests only).
- **Upstream client errors**: A 4xx returned by an upstream service and surfaced through the boundary is also logged (US2), with status preserved.
- **Framework capability unavailable/disabled**: If the centralized-gate capability is later turned off or removed by a framework/version change, the safeguard test (US3) fails rather than silently leaving the API ungated.

## Requirements *(mandatory)*

### Functional Requirements

**Routing correctness (US1)**

- **FR-001**: A request for a collection's movie filter options MUST be served by the dedicated filter-options handler and MUST NOT be served by the single-movie handler.
- **FR-002**: The system MUST include an automated regression guard that fails if a `…/movies/filter-options` request is rejected at the edge (e.g. a 400) or does not return the filter-options result. (Handler identity is not black-box observable — the dedicated and dynamic handlers forward to an identical upstream path — and is moot for correctness; the observable guarantee is the correct result, never an edge rejection.)
- **FR-003**: A request addressed to a fixed-name sub-route that sits alongside the dynamic single-movie route MUST resolve to the fixed-name handler (general precedence guarantee, covering future sub-routes).
- **FR-004**: Resource-identifier validation at the boundary MUST remain a permissive safe-character check (rejecting only smuggling/traversal), and MUST NOT be reverted to a strict storage-format check that would reject legitimate fixed-name sub-paths.

**Observable error boundary (US2)**

- **FR-005**: The shared API error boundary MUST emit a diagnostic log entry for every 4xx response it returns, not only for authentication/authorization failures.
- **FR-006**: Each 4xx diagnostic log entry MUST include enough information to locate the failure: the action/route and the response status code.
- **FR-007**: Authentication failures (401) and access-denied (403) MUST continue to be recorded as security/audit events, without duplication or downgrade.
- **FR-008**: No log entry introduced or modified by this feature may contain secrets, tokens, session identifiers, email addresses, usernames, or other personal data (existing redaction rules continue to apply).
- **FR-009**: Logging of unexpected server errors (5xx) MUST remain unchanged.

**Centralized access control (US3)**

- **FR-010**: The server-side API MUST enforce authentication for protected routes through a single centralized gate that runs before any route-specific logic.
- **FR-011**: An unauthenticated request to a protected API route MUST be rejected by the gate with an authentication error and standard security headers, and the route's own handler MUST NOT execute.
- **FR-012**: Public API routes (sign-in, registration, email verification, resend-verification, session initialization, token refresh, and logout) MUST be exempt from the gate and remain reachable without an authenticated access token. Token refresh performs its own session-cookie validation downstream of the gate, so the gate MUST NOT block a refresh whose access token is already expired. Logout is exempt because the BFF owns the HttpOnly cookies — an expired-session logout must still reach the handler to emit clear-cookie headers (the handler performs no server-side side effects when unauthenticated).
- **FR-013**: The centralized gate MUST apply to protected API requests from all client types (web and mobile) that reach the server over the network.
- **FR-014**: Existing per-route authorization (role membership and resource-ownership checks) MUST remain in effect; the gate augments and does not replace it.
- **FR-015**: The system MUST include an automated safeguard that fails if the centralized gate is disabled or stops covering the protected API routes.
- **FR-018**: US3 MUST begin with a viability check of the centralized-gate capability. If viable, the gate ships in this feature (FR-010–FR-015). If not viable, the gate is descoped to a follow-up and recorded as such; US1 and US2 still ship independently.
- **FR-019**: The gate's enforcement MUST be verified by a server-side integration test (unauthenticated request to a protected route is rejected without the route handler executing) plus the existing web end-to-end suite. A dedicated mobile end-to-end flow is NOT required for the gate, as enforcement is server-side and client-agnostic.

**Cross-cutting**

- **FR-016**: Each change MUST be delivered test-first (a failing test demonstrating the gap, then the fix turning it green), and all existing automated suites MUST remain green (no regressions).
- **FR-017**: Project documentation MUST be updated to record that centralized access control for the API tier is now in place, retiring the prior assumption that no centralized pre-route gate was available.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Filter options load successfully on 100% of attempts across the regression and end-to-end suites; zero occurrences of a filter-options request being served by the wrong handler.
- **SC-002**: 100% of 4xx responses returned by the shared API error boundary produce a corresponding diagnostic log entry (verified by test).
- **SC-003**: Any client-error failure at the API boundary can be attributed to a specific route and status from the logs alone, with no added temporary instrumentation and no reproduction required.
- **SC-004**: 100% of protected API routes reject unauthenticated requests at the central gate without executing the route handler, and 0 public routes (including token refresh) are blocked — verified by a server-side integration test plus the web end-to-end suite (no mobile end-to-end flow required).
- **SC-005**: No regressions — all existing web end-to-end (93), mobile end-to-end, unit, and integration suites remain green.
- **SC-006**: 0 secrets, tokens, session identifiers, or personal-data fields appear in any log output added or changed by this feature (verified against the redaction list).

## Assumptions

- **Source of truth**: This spec is derived from `docs/PRD-CleanExpoRouter.md`; the two follow-up memos (`project_expo_router_filter_options_shadowing`, `project_handlemcapierror_4xx_logging`) and the prior remediation's research record provide the background.
- **Permissive identifier rule stays**: The safe-character identifier validation introduced in the previous feature is correct and is retained; this feature does not re-tighten it.
- **Public route list**: The public (gate-exempt) API routes are sign-in, registration, email verification, resend-verification, session initialization, token refresh, and logout; all other API routes are protected. Token refresh and logout are exempt because they operate on the session/refresh cookie directly — refresh runs when the access token is expired; logout must emit clear-cookie headers even for an expired session (logout added during implementation, 2026-06-03; refresh clarified 2026-06-03). This list is confirmed against the current routes during planning.
- **Centralized gate viability (decided 2026-06-03)**: US3 begins with a viability check of the platform's centralized pre-route capability for server API requests (covering web and mobile network calls but not in-app client navigation). If viable, the gate ships in this feature; if not, the gate is descoped to a follow-up while US1 and US2 still ship — US1 and US2 do not depend on it.
- **Gate verification (decided 2026-06-03)**: Gate enforcement is verified by a server-side integration test plus the existing web E2E suite; no dedicated mobile E2E flow is added, because enforcement is server-side and client-agnostic.
- **Gate is a guard, not a context provider**: The central gate enforces deny-by-default but does not supply per-request identity/context to downstream handlers; handlers that need the authenticated user continue to derive it themselves. This keeps per-route authorization (FR-014) intact.
- **No data-model changes**: This feature changes request handling, logging, and access enforcement only; it introduces no new stored entities and no schema changes.
- **Mobile network calls covered, navigation excluded**: "All client types" in FR-013 means network API requests from web and mobile reaching the server; purely client-side screen navigation is intentionally out of scope.

## Dependencies

- The previous remediation feature (resource-identifier validation and the shared API error boundary) is merged and is the baseline this feature builds on.
- The existing automated test suites (unit, integration, web and mobile end-to-end) are the regression gate for FR-016 / SC-005.
