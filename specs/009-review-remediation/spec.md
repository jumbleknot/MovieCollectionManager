# Feature Specification: Full-Repo Review Remediation

**Feature Branch**: `009-review-remediation`

**Created**: 2026-06-02

**Status**: Draft

**Input**: User description: "docs\PRD-MCMFullRepoReview.md" — remediate the security and correctness findings (plus the confirmed lower-severity items) surfaced by the full-repository review.

## Clarifications

### Session 2026-06-02

- Q: For the IDOR fix (#2), what is the intended remediation scope? → A: Remove IDOR (#2) from this feature's scope (cross-tenant create-ownership + uniqueness re-keying not addressed here).
- Q: When the genuine client IP cannot be trusted (no configured upstream proxy / no forwarding header), how should rate-limiting derive the client identity? → A: Trust the forwarding header only from a configured trusted proxy; otherwise use the connection's remote address (never a shared bucket).
- Q: What status should be returned when a user accesses a collection/movie they don't own? → A: 404 Not Found (hide existence) — this is existing behavior and is preserved.
- Q: How should the email-verification endpoint (#7) be remediated? → A: Keep it but report success only on genuine verification success, distinguishing it from an error/expired/used outcome.

## User Scenarios & Testing *(mandatory)*

The "users" served by this feature are the people who own movie collections and the operators who run the service. Every story below protects an existing capability that today can be abused, corrupted, or silently weakened. Each story is independently testable: it can be exercised against a running system with a targeted security/behavior test and demonstrated on its own.

> **Scope note**: Finding #2 (cross-tenant IDOR on movie creation / owner-scoped uniqueness) is **out of scope** for this feature per the 2026-06-02 clarification and will be handled separately. The 404-for-non-owned convention below documents existing, preserved behavior, not new remediation work.

### User Story 1 - Links saved on movies can't attack me (Priority: P1)

A user can attach external reference links (e.g., to a movie database) to a movie and tap them later. Today a saved link with a dangerous scheme can execute code in the app or trigger an arbitrary device action when tapped.

**Why this priority**: This is a stored cross-site-scripting / unsafe-navigation vector (#1). Saved, attacker-controlled content executing in another user's session is a critical security risk, especially once collections can be shared.

**Independent Test**: Save a movie whose external link uses a non-web scheme (e.g., a script or data scheme), then open the movie detail and tap the link. The dangerous content must never execute or navigate; only safe web links open.

**Acceptance Scenarios**:

1. **Given** a movie is being saved with an external link whose scheme is not an allowed web scheme, **When** the save is processed, **Then** the link is rejected and never persisted as a tappable action.
2. **Given** a movie already holds a link with a disallowed scheme, **When** the user views the movie and taps the link, **Then** no script executes and no arbitrary device action is launched.
3. **Given** a movie with a normal web link, **When** the user taps it, **Then** it opens normally in a new tab (web) or the system browser (native).

---

### User Story 2 - Only I can affect my session (Priority: P1)

A user expects that ending or aging-out a session requires proof of identity. Today an unauthenticated caller who supplies a session identifier can trigger session-affecting actions (timeout enforcement, full logout of all of a user's sessions) without authenticating.

**Why this priority**: This lets an attacker force-logout or disrupt another user's sessions without credentials (#9) — an account-availability and CSRF-class risk.

**Independent Test**: Send session-affecting requests (the profile/session-status request and the logout request) with no valid authentication but a victim's session identifier. The victim's sessions must be unaffected and the request rejected.

**Acceptance Scenarios**:

1. **Given** no valid authenticated request, **When** a caller submits a session-status/profile request carrying a victim's session identifier, **Then** the victim's session state is not mutated and the request is rejected as unauthenticated.
2. **Given** no valid authenticated request, **When** a caller submits a logout request carrying a victim's session identifier, **Then** the victim's sessions are not terminated.
3. **Given** a properly authenticated user, **When** they log themselves out, **Then** their current session is terminated as expected (normal logout still works).

---

### User Story 3 - Abuse protections actually hold (Priority: P2)

Operators rely on rate limits to stop password brute-forcing and account/email spam. Today the login limit can be bypassed by manipulating a request header (and conversely can lock out everyone when no proxy is present), and registration is throttled per email only, so unique-email spam from one source is unlimited.

**Why this priority**: These are availability and abuse defects (#4, #8) — they weaken brute-force defense and allow account/email-bomb spam, but they do not by themselves expose another user's data.

**Independent Test**: (a) Drive repeated failed logins while varying the client-supplied forwarding header; the limit must still trip. (b) Submit many registrations with unique emails from one source; the source must be throttled. (c) In a deployment with no upstream proxy, confirm one client's failed logins do not lock out other clients.

**Acceptance Scenarios**:

1. **Given** repeated failed logins from one client, **When** the client varies the forwarding header on each attempt, **Then** the per-client login limit still triggers after the configured threshold.
2. **Given** the service runs without a trusted upstream proxy, **When** one client exceeds the login limit, **Then** other clients can still log in (no global lockout).
3. **Given** a single source submitting registrations, **When** it submits many requests using different email addresses, **Then** the source is throttled after the configured threshold regardless of the emails used.

---

### User Story 4 - My session lasts as long as the policy says (Priority: P2)

A user should stay signed in for the full configured inactivity window and the full configured maximum session lifetime. Today both are silently capped far below their configured values, logging users out early.

**Why this priority**: This is a correctness/usability defect in a security control (#3). It degrades experience and means the stated session policy is not the enforced one, but it fails safe (early logout).

**Independent Test**: Configure the idle and absolute windows, stay idle just under the idle window and confirm the session survives; cross the idle window and confirm it expires; keep active up to the absolute maximum and confirm expiry there.

**Acceptance Scenarios**:

1. **Given** an idle inactivity window of 30 minutes is configured, **When** a user is idle for less than 30 minutes, **Then** their next request still succeeds (no early logout).
2. **Given** the same configuration, **When** a user is idle beyond the configured idle window, **Then** the session is expired and re-login is required.
3. **Given** a configured absolute maximum session lifetime, **When** that maximum elapses, **Then** the session expires regardless of activity.

---

### User Story 5 - My data and status are accurate (Priority: P3)

Users rely on their data and on-screen status being truthful: a movie's original "added" date should survive edits; setting a default collection should fully succeed or fully fail; an email-verification result should reflect what actually happened; and malformed identifiers should be cleanly rejected.

**Why this priority**: These are correctness/data-integrity and accuracy defects (#5, #6, #7, #10). They mislead users or lose data, but are not direct cross-tenant security holes.

**Independent Test**: Edit a movie and confirm its creation date is unchanged; attempt to set an invalid/foreign collection as default and confirm the previous default is retained; verify an email with an invalid/expired link and confirm the result is reported as failure; send malformed collection/movie identifiers and confirm a clean validation rejection.

**Acceptance Scenarios**:

1. **Given** an existing movie with a creation date, **When** any field is edited and saved, **Then** the original creation date is preserved and only the last-modified date changes.
2. **Given** a user with a current default collection, **When** they attempt to set a non-existent or not-owned collection as default, **Then** the operation fails and their existing default remains unchanged.
3. **Given** a single request that both sets a collection as default and makes another change that fails validation, **When** the request is processed, **Then** neither change is applied (the default is not switched on a failed request).
4. **Given** an invalid, expired, or already-used email-verification link, **When** it is submitted, **Then** the user is told verification did not succeed (not a false success message).
5. **Given** a malformed collection or movie identifier, **When** it is submitted, **Then** the request is rejected with a clear client error rather than an opaque internal failure, and no unintended upstream path is reached.

---

### User Story 6 - Defensive hardening of the confirmed minor gaps (Priority: P3)

Several lower-severity confirmed gaps should be closed so they cannot grow into larger problems: the concurrent-session limit can be exceeded under simultaneous logins; a malformed pagination token silently restarts from the first page instead of erroring; the password-strength score can exceed its documented range; corrupt cached session data causes an unhandled failure; and required movie fields can be saved empty.

**Why this priority**: These are confirmed but low-impact (robustness and contract correctness). They are batched last and are independently testable.

**Independent Test**: Exercise each gap — simultaneous logins beyond the limit, a garbage pagination token, a maximal-strength password, a corrupt cached session entry, and an empty required movie field — and confirm each is handled safely.

**Acceptance Scenarios**:

1. **Given** the configured maximum concurrent sessions, **When** multiple logins occur simultaneously, **Then** the active session count never exceeds the configured maximum.
2. **Given** a movie list request, **When** the pagination token is malformed or tampered, **Then** the request returns a clear client error rather than silently restarting at the first page.
3. **Given** a password meeting all strength criteria, **When** its strength is evaluated, **Then** the reported score stays within the documented range.
4. **Given** a corrupt or unreadable cached session entry, **When** it is read during a request, **Then** the request fails gracefully (treated as no valid session) rather than producing an unhandled error.
5. **Given** a movie create/update request with an empty required field (such as title or language), **When** it is submitted, **Then** it is rejected with a validation error.

---

### Edge Cases

- Access to a collection or movie the caller does not own returns **404 Not Found** (existing behavior, preserved) and never reveals whether the resource exists.
- Allowed-scheme enforcement for links must apply both at save time and at render/open time (defense in depth) and must not break legitimate web links already stored.
- Session expiry changes must not extend any session beyond its configured maximum, and must keep failing safe (never leaving an expired session usable).
- Rate-limit client identification must remain correct both behind a configured trusted proxy and when directly connected, and must never collapse all clients into one shared identity.
- Identifier validation must reject traversal/smuggling attempts (separators, encoded separators, query characters) before any upstream call.
- The default-collection operation must be all-or-nothing even when composed with other changes in the same request.

## Requirements *(mandatory)*

### Functional Requirements

**Safe external links (US1)**
- **FR-001**: The system MUST restrict external-reference link URLs to an allowlist of safe web schemes (HTTP and HTTPS); URLs with other schemes MUST NOT be persisted as actionable links.
- **FR-002**: Validation of external-identifier fields (non-empty required parts, no duplicates, scheme allowlist) MUST be enforced on the create/update path, not only in an unused constructor.
- **FR-003**: When opening a stored link, the client MUST only navigate to allowed web schemes, so that pre-existing unsafe links are not actionable.

**Authenticated session actions (US2)**
- **FR-004**: Session-affecting endpoints MUST authenticate the request before performing any session lookup, mutation, timeout enforcement, or termination side effect.
- **FR-005**: A session-affecting action MUST act only on the authenticated caller's own session(s); a session identifier supplied without valid authentication MUST NOT cause any change.
- **FR-006**: Normal authenticated logout and session-status retrieval MUST continue to function unchanged for legitimate users.

**Abuse protection (US3)**
- **FR-007**: The system MUST derive the rate-limiting client identity by trusting forwarding headers only from a configured trusted proxy, and otherwise using the connection's remote address; untrusted client-supplied headers MUST NOT be able to spoof the identity.
- **FR-008**: The system MUST NOT collapse all clients into a single shared rate-limit identity when proxy headers are absent (no global lockout).
- **FR-009**: The system MUST apply a per-source throttle to registration attempts so that varying the email address does not grant unlimited registrations from one source.

**Session timeout policy (US4)**
- **FR-010**: The enforced idle-inactivity timeout MUST equal the configured idle window (not a shorter hidden cap).
- **FR-011**: The enforced absolute session lifetime MUST equal the configured maximum (not a shorter hidden cap).
- **FR-012**: Session expiry MUST continue to fail safe — an expired or aged-out session MUST never remain usable.

**Data & status accuracy (US5)**
- **FR-013**: Editing a movie MUST preserve its original creation timestamp; only the last-modified timestamp may change.
- **FR-014**: Setting a default collection MUST be all-or-nothing: if the target is invalid or not owned, the user's existing default MUST remain unchanged.
- **FR-015**: When a default-collection change is combined with other changes in one request, a failure of any part MUST leave the default unchanged (no partial application).
- **FR-016**: The email-verification result reported to the user MUST reflect the true outcome — reported as success only when verification genuinely succeeded, and as failure for an invalid, expired, or already-used link (a genuine success outcome MUST be distinguished from an error outcome rather than treating all redirects as success).
- **FR-017**: Resource identifiers received from clients MUST be validated for format before use, and rejected with a clear client error if malformed, with no possibility of reaching an unintended upstream path.

**Defensive hardening (US6)**
- **FR-018**: Concurrent-session creation MUST enforce the configured maximum even under simultaneous logins (no overshoot).
- **FR-019**: A malformed or tampered pagination token MUST produce a clear client error rather than silently restarting pagination.
- **FR-020**: The password-strength score MUST remain within its documented range for all inputs.
- **FR-021**: Reading corrupt or unreadable cached session data MUST be handled gracefully (treated as no valid session) rather than producing an unhandled error.
- **FR-022**: Required movie fields (e.g., title, language) MUST be validated as non-empty on create and update.

**Process / non-regression**
- **FR-023**: Each remediation MUST be covered by a test that fails on the pre-fix behavior and passes on the fixed behavior (no fix without a failing-first test).
- **FR-024**: All existing user-facing flows (browse/manage collections, manage movies, login, registration, logout, session timeout, email verification) MUST continue to pass their existing test suites after remediation.

### Key Entities *(include if feature involves data)*

- **Movie**: A record within a collection, with required descriptive fields (including a non-empty title and language), a creation timestamp that survives edits, a last-modified timestamp, and optional external-reference links.
- **External Identifier / Link**: A reference to an external system attached to a movie, including a system name, an identifier, and an optional URL constrained to safe web schemes (HTTP/HTTPS).
- **Collection**: A user-owned grouping of movies, with an optional default flag that must remain consistent (at most one default per owner; set-default is all-or-nothing).
- **Session**: A server-tracked sign-in for a user, with creation time, last-activity time, an idle window, and an absolute maximum lifetime; affected only by authenticated actions of its owner, and enforced for the full configured windows.
- **Rate-Limit Counter**: A per-identity, per-action counter used to throttle login, registration, and related endpoints; the identity must be derived in a non-spoofable way (trusted-proxy forwarding header, else connection address).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: **100%** of external links with a disallowed scheme are non-actionable — none execute code or launch an arbitrary action — across web and native, both at save time and when tapping pre-existing links.
- **SC-002**: **100%** of session-affecting requests that lack valid authentication produce **no** change to any session, verified for both the profile/session-status and logout paths.
- **SC-003**: Login brute-force protection cannot be bypassed by header manipulation (the limit still trips within the configured threshold in **100%** of header-rotation attempts), and a single abusive client never prevents other clients from logging in.
- **SC-004**: Registration from a single source is throttled within the configured threshold in **100%** of unique-email spam attempts.
- **SC-005**: A session remains valid for the full configured idle window and full configured absolute lifetime (measured tolerance within a few seconds), and never remains usable past expiry.
- **SC-006**: After any movie edit, the original creation date is unchanged in **100%** of cases.
- **SC-007**: A user's existing default collection is retained in **100%** of failed or unauthorized set-default attempts.
- **SC-008**: Email-verification outcomes match reality in **100%** of tested valid/invalid/expired/used-link cases (no false-success reports).
- **SC-009**: **100%** of malformed resource identifiers are rejected with a clear client error and never reach an unintended upstream path.
- **SC-010**: Every remediated finding has at least one test that fails on the original behavior and passes after the fix, and the full pre-existing test suite remains green (no regressions).

## Assumptions

- **Finding #2 (cross-tenant IDOR on movie creation / owner-scoped uniqueness) is out of scope** for this feature and will be addressed separately. Existing owner-scoped reads and the existing 404-for-non-owned behavior are preserved as-is.
- The allowed link schemes are the standard safe web schemes (HTTP and HTTPS); other schemes are out of scope and treated as disallowed.
- Access to a resource the caller does not own returns 404 (not 403), consistent with existing behavior, to avoid leaking resource existence.
- Existing configured values for idle (default 30 minutes) and absolute (default 24 hours) session timeouts are the intended policy; remediation makes enforcement match them rather than changing the policy.
- Rate-limit thresholds themselves are unchanged; only client-identity derivation (trusted-proxy forwarding header, else connection address) and the registration throttle dimension are corrected.
- The lower-severity items (US6) are in scope for this feature because they were confirmed during review; they are sequenced last (P3) and may be deferred only if explicitly de-scoped.
- Remediation reuses the existing access-control, validation, session, and error-handling mechanisms rather than introducing new frameworks, consistent with the project constitution and architecture.
- The BFF authenticates per-route-handler (Expo Router exposes no global pre-route middleware); centralizing BFF access control into a single wrapper is a known standing item, **out of scope** here. This feature corrects auth *ordering* within the existing pattern (US2) and does not introduce or worsen the per-handler model. mc-service's Tower-layer model remains the compliant reference.
- All work follows the repository's mandatory test-driven and spec-driven workflows; the "refuted" review item (JWT algorithm allowlist) is treated as optional defense-in-depth hardening, not a required fix.
