# Feature Specification: BFF Auth Fail-Closed Hardening

**Feature Branch**: `085-bff-auth-fail-closed`

**Created**: 2026-11-01

**Status**: Draft

**Input**: User description: "BFF auth fail-closed hardening — combine backlog items #607 (refresh ownership check, server-side Bearer acceptance, idle timeout enforced only on two routes, dead code/wrong comments), #844 (fail the agent run with an auth error the client turns into re-login when the subject-token mint is refused with invalid_token, instead of running identity-less; decide transient-failure behaviour) and #753 (ensureClientRedirectUris latches its success flag after a rejected PUT)."

## Context

Three backlog items share one defect class: the server-side session layer **degrades silently** where it
should **refuse**. Each has been verified against `main`:

- **Item #844** (split from #702). When the assistant cannot obtain a run-scoped identity for the member,
  the turn runs anyway, without identity. The member then sees "No caller identity is available for
  this action" from whichever step needed it. The message names no cause and offers no remedy. In CI it
  has failed at least four gate-tier E2E runs on unrelated pull requests (runs 5618, 5748, 5757, 5820),
  and one of them held back a production deploy.
- **Item #607** (found reviewing wiki proposal #606).
  - Session refresh extends a session without checking that it belongs to the caller.
  - The server accepts a bearer credential ahead of the session cookie, contrary to the ratified client
    auth model (constitution v2.0.0: clients authenticate *exclusively* through the session cookie).
  - The idle timeout, the comments describing it, and the reported expiry reason disagree with the code.
- **Item #753** (found reviewing wiki proposal #747). If the identity provider rejects the update that
  registers the app's sign-in redirect addresses, the server still records the step as done. It never
  retries until the process restarts.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The assistant refuses a turn it cannot attribute, and says why (Priority: P1)

A signed-in member asks the assistant to do something. If the system cannot establish who the member is
for that turn, the turn does not run. The member is not shown a confusing refusal from deep inside the
assistant. Instead:

- **Their sign-in is no longer valid:** they are sent through the existing re-sign-in path. When the
  only cause was a stale credential the app can renew silently, the turn is retried with no visible
  interruption.
- **The identity service is temporarily unavailable:** they are told the assistant is temporarily
  unavailable and can retry.

**Why this priority**: This is the only item with user-visible harm today. Members get an unexplained
refusal, and the same fault makes required CI runs fail on unrelated changes, which has blocked a
deploy.

**Independent Test**: Make the identity provider reject the member's credential when the assistant
requests its run-scoped identity. Then send a message. Either the turn completes after one silent
renewal, or the member lands on sign-in. In both cases no assistant step runs without identity.

**Acceptance Scenarios**:

1. **Given** a member whose credential the identity provider rejects as invalid, **When** they send an
   assistant message, **Then** the turn is refused with an authentication failure the app already
   treats as "renew, else sign in again", and no assistant step executes.
2. **Given** a member whose credential was merely stale and can be renewed, **When** they send an
   assistant message, **Then** the app renews it once, the turn runs with the member's identity, and
   the member sees a normal reply.
3. **Given** the identity provider is unreachable or answers with a server error, **When** a member sends
   an assistant message, **Then** the turn is refused with a retryable "assistant temporarily
   unavailable" outcome, distinct from an authentication failure. The member is not signed out, and no
   assistant step executes.
4. **Given** a member resumes a paused assistant turn (for example, approving a pending action), **When**
   their identity cannot be established, **Then** the same three outcomes apply to the resume.
5. **Given** an environment where run-scoped identity is deliberately not configured, **When** a member
   sends a message, **Then** behaviour is unchanged from today (the turn runs, and this is not treated
   as a failure).

---

### User Story 2 - Refreshing a session can only extend the caller's own session (Priority: P1)

The session-refresh step must extend a session only when the credential presented belongs to the same
member as the session. A caller holding someone else's session reference cannot use their own
credential to keep that session alive.

**Why this priority**: This is a direct gap against a rule the other session endpoints already enforce
(feature 009 finding #9: a caller "must not be able to slide … that victim's session"). Exploiting it
requires already knowing a secret session reference, so impact is bounded, but the check is cheap and
its absence is inconsistent.

**Independent Test**: Present member A's session reference together with member B's renewal credential
to the refresh step. The refresh is refused, A's session is not extended, no new credentials are issued,
and a security event is recorded.

**Acceptance Scenarios**:

1. **Given** a session belonging to member A, **When** a refresh presents a renewal credential that
   resolves to member B, **Then** the refresh is refused as unauthorized, A's session activity is not
   updated, no credentials are set on the response, and a security audit event records the mismatch
   (without any credential or session reference in the record).
2. **Given** a session belonging to member A, **When** member A refreshes normally, **Then** the refresh
   succeeds exactly as today.

---

### User Story 3 - The server accepts only the session cookie in production (Priority: P2)

In production, the server authenticates members only through the session cookie, as the constitution
requires. A bearer credential presented directly to the server is not honoured. Non-production
behaviour depends on the answer to FR-009.

**Why this priority**: The bearer path is not a known exploit. A caller needs a valid token either way.
But it is an authentication path the ratified auth model says must not exist, it is consulted *before*
the cookie, and nothing records that it is deliberate.

**Independent Test**: In a production-configured server, call an authenticated endpoint with only a
valid bearer credential and no session cookie. The call is refused as unauthenticated. The same call
with the session cookie succeeds.

**Acceptance Scenarios**:

1. **Given** a production-configured server, **When** a request carries a valid bearer credential and no
   session cookie, **Then** it is refused as unauthenticated.
2. **Given** a production-configured server, **When** a request carries both a bearer credential and a
   valid session cookie, **Then** only the cookie is used to authenticate it.
3. **Given** the decision recorded for FR-009, **When** a reviewer looks for why the bearer path exists
   (or does not), **Then** the decision and its scope are written down next to the code and in the
   auth-chain documentation.

---

### User Story 4 - Sign-in redirect registration recovers from a rejected update (Priority: P3)

At startup, the server makes sure the identity provider knows the app's sign-in redirect addresses. If
the provider rejects that update, the server must not record it as done. It retries on the next
sign-in attempt and logs a warning an operator can act on.

**Why this priority**: When it happens, members cannot complete sign-in from an address that was never
registered, and nothing says why until the process restarts. It is rare, and only after a provider
permission change or outage.

**Independent Test**: Make the provider reject the registration update once and accept it the next time.
The first sign-in attempt logs a warning, the second retries and succeeds, and no restart is needed.

**Acceptance Scenarios**:

1. **Given** the provider rejects the redirect-registration update (permission denied, bad request, or
   server error), **When** a sign-in begins, **Then** the step is not recorded as done and a structured
   warning is logged (with no credential and no client configuration in it).
2. **Given** a previous attempt was rejected, **When** the next sign-in begins, **Then** the update is
   attempted again.
3. **Given** the update succeeded, or nothing was missing, **When** later sign-ins begin, **Then** no
   further update is attempted (unchanged from today).

---

### User Story 5 - Session expiry is reported and documented as it actually behaves (Priority: P3)

When a session ends, the member and the audit trail get the true reason: inactivity, or the maximum
session length. The code's own comments describe where the idle timeout is enforced, and match it.

**Why this priority**: These are correctness and maintainability gaps. Comments that overstate a
security control have already misled the generated wiki once (#606). Collapsing an absolute expiry into
"idle" mislabels audit events.

**Independent Test**: Let a session pass its maximum length while it is still active, then make a
request. The recorded and returned reason is "maximum session length reached", not "idle". The comments
on session activity and timeout name the routes that actually enforce it.

**Acceptance Scenarios**:

1. **Given** a session past its absolute lifetime, **When** the member makes a request that checks
   session validity, **Then** the outcome and the audit event say "absolute timeout", not "idle timeout".
2. **Given** a session idle past the idle window, **When** the member makes such a request, **Then** the
   outcome says "idle timeout" (unchanged).
3. **Given** the codebase, **When** a reviewer reads the session-activity and session-timeout code,
   **Then** the comments state where idle expiry is enforced, and the cookie-only session reference is
   described correctly (not as a request header).
4. **Given** the codebase, **When** searched for the unused session-activity helper, **Then** it is gone.

### Edge Cases

- **The identity provider times out partway through minting the run-scoped identity.** This is a
  transient failure: the turn is refused as "temporarily unavailable" and is not run without identity.
- **The member's renewal credential is itself invalid during the silent renewal that follows a
  refusal.** The app's existing behaviour applies (the member signs in again). This feature does not add
  a second retry loop.
- **Refresh with no renewal credential, or with a session reference that does not exist.** These are
  refused as today. The ownership check applies only once both resolve.
- **Two browser tabs refresh at the same moment for the same member.** Both pass the ownership check.
  Existing rate-limiting and rotation behaviour is unchanged.
- **The redirect registration fails at the client-lookup step, before any update.** This already leaves
  the step unrecorded today, and must still do so.
- **A test harness or tool authenticates to the server with a bearer credential.** Covered by FR-009 and
  its migration consequence.

## Requirements *(mandatory)*

### Functional Requirements

**Assistant identity (item #844)**

- **FR-001**: When run-scoped identity is configured and cannot be obtained because the identity provider
  rejects the member's credential as invalid, the system MUST refuse the assistant turn with an
  authentication failure that the existing client renewal path handles (renew once, then sign in again).
  No assistant step may execute for that turn.
- **FR-002**: When run-scoped identity cannot be obtained for a transient reason (provider unreachable,
  timeout, or provider server error), the system MUST refuse the turn with a retryable "temporarily
  unavailable" outcome, distinguishable from an authentication failure. It MUST NOT sign the member out,
  and MUST NOT execute any assistant step.
- **FR-003**: FR-001 and FR-002 MUST apply equally to starting a turn and to resuming a paused turn.
- **FR-004**: When run-scoped identity is not configured for the environment, the system MUST behave as
  it does today.
- **FR-005**: Each refusal under FR-001/FR-002 MUST emit a structured log event that names the outcome
  class (auth or transient) and the provider's status. It MUST NOT contain any credential or token.

**Session refresh ownership (item #607, finding 1)**

- **FR-006**: The session-refresh step MUST verify, before extending the session or issuing credentials,
  that the identity resolved from the presented renewal credential is the session's owner.
- **FR-007**: On an ownership mismatch, the system MUST refuse the refresh as unauthorized, MUST NOT
  update the session's activity, MUST NOT set credentials on the response, and MUST emit a security
  audit event recording the mismatch, without credentials or session references.

**Bearer credential acceptance (item #607, finding 2)**

- **FR-008**: In production, the server MUST authenticate member requests only through the session
  cookie, and MUST NOT honour a bearer credential presented by the caller.
- **FR-009**: Outside production, bearer acceptance MUST be [NEEDS CLARIFICATION: kept for test
  harnesses (27 of 59 server integration test files and 1 E2E file authenticate this way today), or
  removed everywhere with those tests migrated to the session cookie?]. Whatever is chosen MUST be
  recorded next to the code and in the auth-chain documentation.

**Redirect registration (item #753)**

- **FR-010**: The system MUST record redirect registration as done only when the identity provider
  confirms the update succeeded, or when no address was missing.
- **FR-011**: A rejected update MUST be logged as a structured warning with no credential and no client
  configuration, and MUST be retried on the next sign-in attempt.

**Session expiry accuracy (item #607, findings 3–5)**

- **FR-012**: When a session ends because it reached its maximum lifetime, the reported outcome and audit
  event MUST say "absolute timeout", not "idle timeout".
- **FR-013**: Code comments describing session activity and timeout MUST state where idle expiry is
  actually enforced, and MUST describe the session reference as cookie-only.
- **FR-014**: The unused session-activity helper MUST be removed.

**Verification**

- **FR-015**: Each of FR-001–FR-003, FR-006–FR-008, FR-010–FR-012 MUST have an automated test that fails
  without the change. Where the behaviour already exists, use a mutation RED: show that the test fails
  when the change is reverted.

### Key Entities

- **Member session**: the server-side record of a signed-in member. It has an owner, a
  last-activity time, a creation time, and a reference the client holds only as a cookie.
- **Renewal credential**: what the client presents to extend a session. It resolves to an identity that
  must match the session's owner.
- **Run-scoped identity**: the short-lived identity the assistant uses to act as the member for one
  turn. It is obtained from the identity provider at the start of each turn or resume.
- **Redirect registration**: the set of sign-in return addresses the identity provider must know for the
  app's client. The server ensures it once per process.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In automated tests, zero assistant turns or resumes execute any step after run-scoped
  identity is refused, across the auth-rejected, transient, and not-configured cases (in the
  not-configured case, the turn runs as today).
- **SC-002**: In the E2E gate tier, the "No caller identity is available" failure signature from item
  #702 no longer appears. Measured over the first 10 gate-tier runs after merge: 0 occurrences, against at
  least 4 in the 3 days before (runs 5748, 5757, 5820, and main run 5618).
- **SC-003**: 100% of refresh attempts that pair one member's session with another member's renewal
  credential are refused and audited in tests. Same-member refresh succeeds unchanged.
- **SC-004**: In a production-configured server, 0 requests authenticate through a bearer credential
  alone.
- **SC-005**: After a single rejected redirect-registration update, the next sign-in attempt retries it,
  with no restart. Covered by an automated test.
- **SC-006**: Sessions that end by maximum lifetime are reported as such in 100% of test cases.

## Assumptions

- **Idle-timeout reach.** Comments are corrected to match the code rather than enforcing idle expiry on
  every route. Idle expiry is enforced whenever a session is checked or refreshed. Access credentials
  live about 5 minutes and must be refreshed to continue, so an idle session cannot keep acting for more
  than one credential lifetime past the idle window. Enforcing it on every request would add a
  session-store round trip to each request for at most that gain. Revisit if credential lifetimes grow.
- **Transient failures fail closed (FR-002).** This was chosen over the alternative of degrading to an
  identity-less turn. The assistant's steps now need identity, so an identity-less turn produces exactly
  the confusing refusal this feature removes. "Temporarily unavailable" is honest and retryable.
- **Re-sign-in reuses the existing client path.** The client already renews once and retries an
  assistant turn on an authentication failure. No new client UI is required for FR-001, only an
  outcome the existing path recognises. FR-002's "temporarily unavailable" message may need a client
  string.
- **Ownership is established from the renewal result.** The identity the provider returns for the
  renewed credential is compared with the session's owner before the session is touched. If the
  comparison can be made before renewal without an extra provider call, that is preferable.
- **Out of scope.** The access credential currently travels to the client in an `HttpOnly` cookie. That
  sits awkwardly with the constitution's "only an opaque session reference in the client cookie" rule,
  but it was not part of these three items and changes the transport for every request. It should be
  triaged as its own backlog item, not folded in here.
