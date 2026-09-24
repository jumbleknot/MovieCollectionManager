# Feature Specification: Self-service account deletion

**Feature Branch**: `076-account-deletion`

**Created**: 2026-09-24

**Status**: Draft

**Input**: Backlog item #544 — "Account deletion does not exist, so backup teardown is never called — a deleted user leaves a live offline token at Keycloak". Item labelled `status/needs-spec`: the exposure is a defect, but the work is a feature. Depends on feature 073 (scheduled backups), which built the per-user teardown this feature must invoke, and on feature 062 (Settings split), which created the Settings surface this feature adds to.

## Overview

A user can create an account in this system without asking anyone. They cannot remove one.

There is no deletion path of any kind — not self-service, not operator-assisted. A user who wants
to leave has no way to do so, and nothing in the system acts on their behalf when they stop using
it. Their collections remain, their configuration remains, and — the reason this is urgent rather
than merely incomplete — **the standing permission they granted for unattended backups remains live
at the identity provider**.

Feature 073 built the teardown that gives up that permission and erases what this system holds for
a user. Nothing calls it. That teardown was correct to build and correct to leave unwired: inventing
an account-deletion feature to justify a cleanup hook would have been the wrong order. This is that
feature, specified on its own terms.

The result is a deletion a user performs themselves, which proves who they are before it destroys
anything, which gives up the standing permission **first**, and which leaves the user's own property
alone.

### What this feature deliberately does not do

**It does not delete the user's backup artifacts.** Those files sit at a destination the user
supplied, in storage the user owns and pays for, written with credentials the user provided. They
are the user's property. Removing them would not be this system cleaning up after itself — it would
be destroying the data the user trusted it to copy, at the moment the user has least reason to
expect it and least ability to object. After deletion the user keeps their files and their
credentials; what they lose is this system's ability to reach either.

This is stated as a requirement rather than left implicit because the capability to delete those
artifacts already exists in the system, one call away, for retention pruning. "Clean up their
backups" is a plausible and wrong reading of this feature.

## Clarifications

### Session 2026-09-24

- Q: If the user closes the tab or loses connectivity part-way through a deletion, what must happen? → A: Once the confirmation is accepted the server completes the whole ordered sequence regardless of the client; the client is only observing.
- Q: How strong must the re-authentication be — merely recent, or must it satisfy the identity provider's high-privilege policy? → A: It must satisfy whatever the identity provider is configured to require for a high-privilege action, including a second factor where one is configured. The application does not set that bar itself.
- Q: After an account is deleted, can the same email address register again? → A: Yes, immediately. The address and username are released, and registering again produces a new, empty account with no connection to the old one. No record of the deleted address is retained.
- Q: How long should an unconfirmed deletion request live? → A: 5 minutes — the same window as the authentication freshness check, so neither half can outlive the other.
- Q: Should the user receive an email confirming their account was deleted? → A: No. The system has no general-purpose outbound email channel, and a confirmation would have to be sent after the account no longer exists. In-app notification only, matching feature 073's ruling; backlog item #551 records the missing channel.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Delete my account and everything this system holds for me (Priority: P1)

A user decides to leave. From Settings they choose to delete their account, confirm that they mean
it, and the system destroys what it holds for them: the standing permission, their backup
destinations and the stored credentials for them, their backup schedules, their run history, their
assistant configuration, their active sessions, their collections and movies, and finally their
account itself. They are signed out and cannot sign in again.

**Why this priority**: This is the feature. Without it the system has no deletion path at all and
backlog item #544's exposure stays open. Every other story hardens or protects this one.

**Independent Test**: Create an account, populate it with collections, a backup destination and a
schedule, delete the account, and confirm from outside the application that the standing permission
no longer works and the account can no longer sign in.

**Acceptance Scenarios**:

1. **Given** a signed-in user with collections, backup destinations, schedules and run history,
   **When** they complete account deletion, **Then** every one of those records is gone and their
   account no longer exists.
2. **Given** a user who granted a standing permission for unattended backups, **When** they complete
   account deletion, **Then** that permission is unusable at the identity provider — demonstrated by
   attempting to use it, not by observing a local record disappear.
3. **Given** a user with backup artifacts at their own destination, **When** they complete account
   deletion, **Then** every one of those artifacts is still present and unmodified at that
   destination.
4. **Given** a user with active sessions on more than one device, **When** they complete account
   deletion, **Then** none of those sessions can make a further request.
5. **Given** a deleted account, **When** anyone attempts to sign in with its credentials, **Then**
   sign-in fails.
6. **Given** a completed deletion, **When** the audit trail is inspected, **Then** it records who
   was deleted, when, and from where.

---

### User Story 2 - Prove it is me before anything is destroyed (Priority: P2)

Before the system destroys anything, the user re-authenticates at the identity provider. A session
alone is not enough: someone who obtains a signed-in session must not be able to destroy the account
that session belongs to.

**Why this priority**: Deletion is irreversible and unauthenticated destruction is the worst failure
this feature can have. It is P2 rather than P1 only because the deletion pipeline must exist before
there is anything to gate.

**Independent Test**: Attempt deletion carrying an authentication older than the freshness window,
or none at all, and confirm it is refused with nothing destroyed.

**Acceptance Scenarios**:

1. **Given** a signed-in user whose last authentication is older than the freshness window, **When**
   they request deletion, **Then** they are required to authenticate again before it proceeds.
2. **Given** a user who abandons the re-authentication without completing it, **When** they return,
   **Then** nothing has been destroyed and their account is unchanged.
3. **Given** a re-authentication completed by a **different** account than the one that requested
   deletion, **When** the deletion is submitted, **Then** it is refused and nothing is destroyed.
4. **Given** a completed re-authentication, **When** the same proof is submitted a second time,
   **Then** the second attempt is refused.
5. **Given** a re-authentication that completes outside the freshness window, **When** the deletion
   is submitted, **Then** it is refused as stale.
6. **Given** an account for which the identity provider requires a second factor, **When** the user
   re-authenticates, **Then** they are asked for that second factor and the deletion proceeds only
   after it is satisfied.
7. **Given** an account with no second factor enrolled, **When** the user re-authenticates, **Then**
   a fresh authentication is sufficient and the deletion is not refused for lack of one.
8. **Given** an identity provider that returns a weaker authentication than was asked for, **When**
   the deletion is submitted, **Then** it is refused and nothing is destroyed.

---

### User Story 3 - A deletion that fails is safe to try again (Priority: P3)

Deletion touches several independent stores and can fail part way. When it does, the user is told
plainly that the account was not deleted, and trying again completes the job rather than
compounding the damage.

**Why this priority**: It changes a rare failure from a silent, dangerous half-state into an
inconvenience. It matters most for the one failure the whole ordering exists to prevent — giving up
the standing permission.

**Independent Test**: Force each step of the deletion to fail in turn and confirm that the account
remains usable enough to retry, that the standing permission is never stranded, and that a retry
succeeds.

**Acceptance Scenarios**:

1. **Given** the standing permission cannot be given up at the identity provider, **When** deletion
   is attempted, **Then** it stops before destroying anything, the user is told the account was not
   deleted, and every record remains.
2. **Given** deletion fails after some records are already destroyed, **When** the user tries again,
   **Then** the retry completes without error despite those records already being gone.
3. **Given** any failure during deletion, **When** the user reads the result, **Then** they are told
   the account was **not** deleted, never that it was.

---

### Edge Cases

- **The standing permission cannot be given up.** The identity provider is unreachable, or refuses.
  Deletion stops before anything is destroyed. This is the ordering the whole feature is arranged
  around: destroying the local record of a permission that is still live at the identity provider
  leaves a standing permission nothing in this system knows about — exactly backlog item #544, in a
  worse form, because there is then no user left to notice.
- **The user never granted a standing permission.** There is nothing to give up; deletion proceeds
  normally. Not an error.
- **Deletion fails after some collections are already destroyed.** Those collections are gone and
  are not recoverable. The account survives and a retry finishes the job. The user is told the
  deletion did not complete.
- **The user is the last remaining administrator.** Deletion is refused: a system with no
  administrator cannot be administered, and self-service deletion must not be the way that happens.
- **Two deletion requests for the same account arrive at once.** One completes; the other finds the
  work already done or the account already gone, and neither reports a false success.
- **An unattended backup run is in flight when deletion happens.** The run loses its permission and
  its destination records mid-flight. It must fail and stop, not retry indefinitely against records
  that no longer exist.
- **The user abandons re-authentication.** Nothing is destroyed. The pending request expires on its
  own without requiring the user to cancel it.
- **A second account signs in during the re-authentication.** The proof does not match the account
  that asked, and the deletion is refused rather than deleting whichever account happens to be
  current.
- **The user signs in on another device between requesting and confirming deletion.** Deletion still
  terminates every session, including that one.
- **The same person registers again with the same email.** They get a new, empty account. Nothing
  from the deleted account reaches it — and in particular no standing permission, no backup
  destination and no stored credential, so the new account cannot reach the old account's storage
  through anything this system kept.
- **The user's client disappears immediately after confirming.** The deletion is already committed
  to and runs to completion server-side. The user learns the outcome the next time they try to sign
  in. This is deliberately not treated as a cancellation: a half-finished deletion is a worse state
  for the user than a finished one, and the point of no return is the confirmation, not the
  response.

## Requirements *(mandatory)*

### Functional Requirements

**Initiating and confirming**

- **FR-001**: A signed-in user MUST be able to request deletion of their own account from Settings.
- **FR-002**: The system MUST NOT allow a user to delete any account other than their own.
- **FR-003**: Before deletion proceeds, the user MUST be shown what will be destroyed and what will
  not, including the explicit statement that artifacts at their own destination are not touched.
- **FR-004**: The user MUST take a deliberate confirming action; deletion MUST NOT be reachable by a
  single click from a normal navigation path.
- **FR-005**: The system MUST require the user to authenticate again at the identity provider, and
  MUST NOT accept a session alone as proof of identity for this operation.
- **FR-006**: The system MUST NOT collect, transmit, store or verify the user's credentials itself;
  re-authentication MUST happen at the identity provider.
- **FR-007**: The system MUST ask the identity provider for an authentication meeting its configured
  requirement for a high-privilege action, and MUST accept the identity provider's determination of
  whether that requirement was met. Where a second factor is configured for the account, the user
  will be asked for it; where none is configured, a fresh authentication suffices.
- **FR-008**: The system MUST NOT define, evaluate or enforce the authentication-strength policy
  itself, and MUST NOT refuse deletion on the grounds that an account has no second factor enrolled.
  A user with no second factor must still be able to leave.
- **FR-009**: The system MUST verify that the authentication actually performed satisfies what was
  asked for, and MUST refuse the deletion if the identity provider returns a weaker authentication
  than requested.
- **FR-010**: The system MUST reject a re-authentication that is older than the freshness window,
  that belongs to a different account than the one requesting deletion, or that has already been
  used once.
- **FR-011**: A pending deletion request that is never confirmed MUST expire without effect after 5
  minutes, without requiring the user to cancel it. The request and the authentication proof share
  one window, so neither can outlive the other.
- **FR-012**: An expired deletion request MUST be refused rather than renewed. A user who takes too
  long MUST start again from Settings, and MUST be told that is what happened.
- **FR-013**: The system MUST refuse to delete the last remaining administrator account and MUST say
  why.

**What is destroyed, and in what order**

- **FR-014**: On deletion the system MUST give up the user's standing permission at the identity
  provider **before** destroying any record, and MUST verify that it succeeded.
- **FR-015**: If the standing permission cannot be given up, the system MUST abort, destroy nothing,
  and report failure. It MUST NOT proceed, and MUST NOT report success.
- **FR-016**: The system MUST destroy the user's backup destinations and the stored credentials for
  them, their backup schedules, and their run history.
- **FR-017**: The system MUST destroy the user's collections and the movies within them.
- **FR-018**: The system MUST destroy the user's assistant configuration in full, including any
  stored secrets, rather than merely disabling it.
- **FR-019**: The system MUST destroy transient per-user state held for the user, including cached
  profile data and any pending assistant or consent state.
- **FR-020**: The system MUST terminate every one of the user's sessions, on every device, and MUST
  terminate the user's session at the identity provider, not only within this application.
- **FR-021**: The system MUST delete the user's account at the identity provider, and MUST do so
  **last** — it is the only step that cannot be retried, because afterwards there is no account left
  to authenticate as.
- **FR-022**: The system MUST destroy the record holding the standing permission only **after** that
  permission has been given up, never before.

**What is preserved**

- **FR-023**: The system MUST NOT delete, modify, overwrite or truncate any artifact at the user's
  own destination, and MUST NOT authenticate to that destination at any point during deletion.
- **FR-024**: The system MUST NOT retain any record identifying the user after deletion completes,
  other than audit entries.
- **FR-025**: The deleted account's email address and username MUST become available for
  registration again immediately. The system MUST NOT keep a list of deleted addresses in order to
  block their reuse — that would retain personal data for exactly the people who asked to be
  forgotten.
- **FR-026**: An account registered afterwards with a previously deleted address MUST be a new,
  empty account. It MUST NOT inherit collections, backup destinations, schedules, run history,
  assistant configuration or any standing permission from the deleted account.

**Failure, retry and reporting**

- **FR-027**: Every step before the account is deleted MUST be safe to run again, so that a retry
  after a partial failure completes rather than failing on work already done.
- **FR-028**: On any failure the system MUST report that the account was **not** deleted, and MUST
  NOT report partial success.
- **FR-029**: Failure messages MUST tell the user whether to retry, without exposing internal system
  detail.
- **FR-030**: On success the user MUST be signed out and returned to a signed-out surface that does
  not imply they still have an account.
- **FR-031**: The confirmation of a completed deletion MUST be delivered in the application. The
  system MUST NOT attempt to notify the user by email, and MUST NOT retain the user's email address
  in order to do so later.
- **FR-032**: Once the user's confirmation is accepted, the system MUST run the deletion through to
  completion irrespective of whether the user remains connected. Losing the client — a closed tab,
  a dropped connection, a device going to sleep — MUST NOT stop the sequence part way.
- **FR-033**: A user who reconnects after losing the client during a deletion MUST be able to
  determine whether it completed, either because they can no longer sign in or because they are
  told the account still exists and can be deleted again.
- **FR-034**: An unattended backup run that is in flight when its owner is deleted MUST fail and
  stop. It MUST NOT retry against records that no longer exist, and MUST NOT report success.

**Audit**

- **FR-035**: The system MUST record a security audit event when deletion is requested, when
  re-authentication fails or is rejected, when deletion fails, and when deletion completes.
- **FR-036**: Audit entries MUST identify the account, the time, and the originating network
  address, and MUST be written before the operation they record is treated as complete.
- **FR-037**: Audit entries MUST NOT contain credentials, tokens, session identifiers, or the user's
  personal details.

### Key Entities

- **Deletion request** — a user's in-progress intent to delete their own account. Holds the
  identity of the requesting account and the state needed to match the re-authentication that
  follows. Single-use, and expires on its own after five minutes.
- **Re-authentication proof** — evidence from the identity provider that the requesting user
  authenticated again, recently. Carries the account it belongs to and when the authentication
  happened. Valid once, within the freshness window.
- **Standing permission** — the user's revocable consent allowing the system to act with their
  identity while they are absent, granted by feature 073 for unattended backups. One per user.
  Giving it up is the first destructive act of a deletion and the precondition for every later one.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a completed deletion, the user's standing permission is unusable at the identity
  provider — verified by attempting to use it afterwards and requiring rejection, not by observing a
  local record disappear.
- **SC-002**: After a completed deletion, sign-in with that account fails, in 100% of attempts.
- **SC-003**: After a completed deletion, the artifacts at the user's own destination are unchanged:
  the same number of objects, with the same contents, as before the deletion began.
- **SC-004**: After a completed deletion, no query by the deleted user's identity returns any
  record, across every store the system holds, except the audit trail.
- **SC-005**: In 100% of simulated failures of the standing-permission step, nothing is destroyed
  and the account remains fully usable.
- **SC-006**: In 100% of simulated failures at any later step, a retry completes successfully.
- **SC-007**: No deletion completes on an authentication older than the freshness window, on one
  belonging to a different account, or on one already used — 0 successes across all such attempts.
- **SC-008**: No deletion reports success unless the account is actually gone — 0 false successes
  across all failure simulations.
- **SC-009**: A user with a typical collection (up to 10 collections and 1,000 movies) completes
  deletion in under 30 seconds from confirmation.
- **SC-010**: An attempt to delete the last remaining administrator is refused, in 100% of attempts.
- **SC-011**: Every deletion attempt, successful or not, appears in the audit trail, and no audit
  entry contains a credential, token, session identifier or personal detail.
- **SC-012**: A deletion whose client disconnects immediately after confirmation still completes, in
  100% of attempts, with the same outcome as one observed to the end.
- **SC-013**: Where the identity provider requires a second factor for a high-privilege action, no
  deletion completes without it — 0 successes across all attempts that skip it. Where no second
  factor is enrolled, deletion succeeds normally — 0 refusals on that ground.
- **SC-014**: An account registered with a deleted account's email address afterwards contains zero
  collections, zero backup destinations, zero schedules, zero run history and no standing
  permission.

## Assumptions

Decisions taken where the backlog item did not specify, agreed with the operator before this spec
was written:

- **Self-service only.** A user deletes their own account. Operator- or administrator-initiated
  deletion of another user's account is out of scope; it would require a user-management surface
  that does not exist, and it does not close backlog item #544. Self-service is also the symmetric
  counterpart to self-registration, which the system already has.
- **Immediate and irreversible.** There is no grace period, no soft-delete and no recovery window.
  The backlog item's requirement that a failure be retryable "while the token is still reachable"
  presumes a synchronous deletion, and a grace period would leave the standing permission live
  throughout it — the exposure this feature exists to close.
- **The user's collections and movies are destroyed.** A deletion that leaves the user's data behind
  under an identity that no longer resolves is not a deletion. Destroying them reuses the existing
  per-collection delete, which already removes a collection and its movies together.
- **Artifacts at the user's own destination are preserved.** Carried forward from feature 073, which
  made this choice deliberately and documented the reasoning. This feature restates it as a
  requirement because the means to violate it exists in the system.
- **The freshness window for re-authentication is 5 minutes**, and a pending deletion request
  expires on the same 5-minute clock. Long enough to complete an authentication that requires a
  second factor, short enough that a proof is not useful later. One number rather than two, because
  a request that outlives the proof it waits for serves no purpose.
- **Re-authentication happens at the identity provider, by redirect.** The constitution prohibits
  any in-application re-authentication flow that does not redirect through the identity provider,
  and prohibits the application from handling credentials at all. Verifying a password inside the
  application was considered and rejected on that basis.
- **The last administrator cannot delete themselves.** Chosen as the safe default over allowing a
  system to be left unadministrable. There is no existing rule in the system to inherit here.
- **A user is assumed to have at most one standing permission**, consistent with feature 073.
- **No email notification, because there is no channel to send one on.** The system's only email
  capability triggers identity-provider account flows for a user who still exists; it is not a
  general-purpose sender, and a deletion confirmation would by definition be sent after the account
  is gone. Feature 073 reached the same conclusion for backup-failure notification and declined to
  build an outbound channel as a rider. The threat an email would mitigate — learning that someone
  else destroyed the account — is largely closed by FR-007, which requires an attacker to satisfy
  the identity provider's high-privilege bar, not merely hold a stolen session. Backlog item #551
  records the missing channel.

## Dependencies

- **Feature 073 (scheduled backups)** supplies the per-user teardown that gives up the standing
  permission and erases backup records. This feature is its missing caller. The teardown's existing
  ordering guarantee — give up the permission first, destroy nothing if that fails — is a
  precondition this feature relies on and must not weaken.
- **Feature 062 (Settings split)** supplies the Settings surface this feature adds to.
- **The identity provider must support** forcing a fresh authentication on demand, reporting when
  that authentication happened, terminating a user's sessions, and deleting a user account.
- **The existing per-collection delete** must remain the mechanism that removes a collection and its
  movies together.

## Out of Scope

- Administrator-initiated deletion of another user's account.
- Account deactivation, suspension, or any reversible alternative to deletion.
- Exporting or offering the user a copy of their data as part of the deletion flow. Feature 073's
  backup and the existing spreadsheet export already provide this, and coupling them to deletion
  would make leaving slower without making it safer.
- Deleting or altering anything at the user's own destination.
- Any change to what the audit trail retains or who can read it.
- Building a general-purpose outbound email channel — backlog item #551. Deletion confirmation is
  recorded there as a candidate consumer.
