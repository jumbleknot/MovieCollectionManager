# Feature Specification: Authenticated HTTP authorization tests for mc-service

**Feature Branch**: `046-authenticated-authz-tests`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "G2 — mc-service authenticated HTTP authorization tests: a ROPC token helper for the Rust integration suite, plus authenticated 200, cross-tenant 404 (no existence leak) and RFC 9457 problem+json assertions at the HTTP boundary. Defers the require_app_role 403 (needs a role-less identity that cannot be self-provisioned)."

**Parent**: `docs/proposals/PRD-McServiceHttpAuthzIntegration.md` (G2 — the sole outstanding goal).
Feature 045 delivered G1/G3/G4/G5: the suite runs with zero ignored tests, but every assertion in it
is **unauthenticated**. This feature adds the authenticated half.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A tenant cannot discover another tenant's data (Priority: P1)

A signed-in user requests a collection that belongs to somebody else. The service must behave as
though the collection does not exist — not "you may not see this", which would confirm it exists.

**Why this priority**: This is the highest-value assertion in the feature and the one the parent PRD
was really about. The isolation rule is enforced by owner-scoped queries far below the HTTP layer, so
the only way to know the boundary still holds *as served over HTTP* is to ask for a foreign resource
with a real credential. Nothing in the suite does that today. A regression here leaks the existence
of other tenants' data.

**Independent Test**: Seed a collection owned by another subject, then request it over HTTP with a
real token. Delivers the isolation guarantee on its own, with no other story implemented.

**Acceptance Scenarios**:

1. **Given** a collection owned by another subject, **When** a signed-in user requests it,
   **Then** the response is `404` and the body reveals nothing about the resource beyond
   "not found".
2. **Given** a collection owned by another subject, **When** a signed-in user attempts to modify or
   delete it, **Then** the response is `404` — not `403`, which would confirm existence.
3. **Given** a movie inside another subject's collection, **When** a signed-in user requests it,
   **Then** the response is `404`.

---

### User Story 2 - A signed-in user can reach their own data (Priority: P1)

A user with a valid credential and the required role reaches their own resources normally.

**Why this priority**: Equal-priority with US1 because it is the control. Without it, a `404` from
US1 is ambiguous — it could mean isolation works, or it could mean the credential was rejected and
*everything* returns an error. This story is what makes US1's result interpretable, and it is also
the only end-to-end proof that a token issued by the identity provider is accepted at all.

**Independent Test**: Create a collection over HTTP with a real credential and read it back.

**Acceptance Scenarios**:

1. **Given** a valid credential carrying the required role, **When** the user creates a collection,
   **Then** it succeeds and the stored owner is that user's identity.
2. **Given** a collection the user owns, **When** they request it, **Then** it is returned.
3. **Given** a valid credential, **When** any protected endpoint is called, **Then** the response is
   never `401` — distinguishing "credential accepted" from the unauthenticated suite's `401`s.

---

### User Story 3 - Authorization failures are machine-readable (Priority: P2)

A client receiving a refusal gets a structured, predictable error body rather than an ad-hoc string
or a stack trace.

**Why this priority**: P2 because it hardens an existing contract rather than closing a security
gap. It is worth doing here because these are the first *authenticated* error paths the suite
exercises, and the response shape on them has never been checked.

**Independent Test**: Trigger a cross-tenant refusal and assert on the response's content type and
body fields.

**Acceptance Scenarios**:

1. **Given** a cross-tenant refusal, **When** the client inspects the response, **Then** the content
   type is the standard problem format and the body carries the type, title and status fields.
2. **Given** any authenticated error response, **When** the client inspects the body, **Then** it
   contains no stack trace or internal diagnostic text.

---

### Edge Cases

- **The identity provider is unreachable, or credentials are absent.** The suite must fail loudly and
  name what is missing. It must never pass by silently skipping the authenticated assertions —
  feature 045 established that a suite passing for the wrong reason is worse than one that is
  ignored.
- **The credential is rejected by the service** (wrong audience, wrong realm). This must surface as a
  clear failure of this feature's setup, distinguishable from a genuine authorization result.
- **Two tests run concurrently.** Each must operate on its own data so a foreign-owner fixture from
  one cannot be observed by another.
- **A credential expires mid-run.** Out of scope: the suite completes in well under the credential's
  lifetime.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The test suite MUST be able to obtain a real end-user credential for a seeded test
  identity, without a human supplying one interactively.
- **FR-002**: The credential MUST be accepted by the service under test — i.e. it MUST carry the
  audience and role claims the service requires.
- **FR-003**: The suite MUST assert that a signed-in user can create and read their own collection,
  and that the recorded owner matches the authenticated identity.
- **FR-004**: The suite MUST assert that read, modify and delete of another subject's collection all
  answer `404`, and MUST NOT accept `403` as a pass for those cases.
- **FR-005**: The suite MUST assert the same `404` behaviour for a movie inside another subject's
  collection.
- **FR-006**: Authenticated error responses MUST be asserted to use the standard problem format with
  its required fields, and to contain no diagnostic leakage.
- **FR-007**: When credentials or the identity provider are unavailable, the suite MUST fail with a
  message naming the missing input. It MUST NOT skip, and MUST NOT reintroduce an ignored test.
- **FR-008**: The authenticated tests MUST run in the same continuous-integration step that already
  runs the rest of the suite, so they gate a merge.
- **FR-009**: Obtaining a credential MUST NOT require operator action per run, and MUST NOT require
  administrative privileges on the identity provider.
- **FR-010**: The feature MUST NOT change any production authorization behaviour.

### Key Entities

- **Test identity** — a seeded end-user account whose credential the suite can obtain. Carries the
  role the service requires and resolves to a stable subject.
- **Credential** — a short-lived bearer token proving the test identity, scoped to the service's
  expected audience.
- **Foreign-owner fixture** — a collection (and its movies) recorded against a subject that is
  deliberately *not* the test identity, existing solely to be refused.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A signed-in user can read their own collection and is refused another's, verified
  automatically on every merge — where today zero authenticated requests are verified anywhere in
  this suite.
- **SC-002**: Every cross-tenant refusal reports "not found"; **zero** report "forbidden". A change
  that turns any of them into "forbidden" fails the build.
- **SC-003**: Removing the owner scoping from a single read path turns the suite red — the
  broken-on-purpose proof, matching the standard feature 045 set for the unauthenticated half.
- **SC-004**: The suite still reports **zero ignored tests**, and the added authenticated tests
  extend its runtime by no more than a few seconds.
- **SC-005**: With the identity provider unreachable, the suite fails and names the cause; it does
  not report success.

## Assumptions

- A seeded test identity with the required role already exists in every environment where this suite
  runs, and its credentials are already available to continuous integration for other suites.
  **Verified** for the local environment: a credential was obtained successfully and carries the
  correct audience and role.
- The service treats the authenticated subject as the owner of resources it creates.
- Elevated roles do not bypass owner scoping, so an administrator identity is not a special case for
  isolation. **Verified**: no application or storage code branches on the elevated role.
- Cross-tenant refusal is intended to be indistinguishable from absence. This is the documented
  design, not an inference.
- The suite's runtime is far shorter than a credential's lifetime, so refreshing is unnecessary.

## Out of Scope

- **The insufficient-role refusal (`403`).** Proving that a credential *without* the required role is
  refused needs a role-less identity. The realm is runtime-managed with no committed source, so
  creating one requires either an operator step on the identity provider plus a re-export, or an
  administrative credential that is deliberately not available to a developer session. Deferred with
  its prerequisites recorded; it guards a small, centralized role check, whereas the isolation
  boundary this feature covers is the security-critical one.

  **This deferral has a second prerequisite, found while planning.** The insufficient-role refusal is
  the one authorization failure the service does **not** emit in the standard problem format every
  other refusal uses — it carries a different content type and a different problem-type namespace.
  FR-006 is written for all authenticated error responses, so whoever picks this up must align that
  refusal with the standard format *before* it can satisfy FR-006, or the requirement and the code
  will contradict each other. That alignment is a production change and is therefore out of scope
  here, where FR-010 forbids one.
- Seeded access-control-list levels (contributor/viewer). The refusal they would produce has no
  reachable production code path today.
- Any change to production authorization behaviour, or to the unauthenticated suite delivered by
  feature 045.
