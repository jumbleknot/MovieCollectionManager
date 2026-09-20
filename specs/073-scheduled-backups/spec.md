# Feature Specification: Per-user scheduled collection backups with versioning, retention and non-destructive restore

**Feature Branch**: `073-scheduled-backups`

**Created**: 2026-09-19

**Status**: Draft

**Input**: Backlog item #236 — "Per-user scheduled collection backups to a user-supplied remote, with versioning, retention and non-destructive restore". Unblocked by item #235 (feature 062, Settings split), which created the Backups sub-page this feature fills.

## Overview

A user's movie collections exist in exactly one place. There is no user-facing way to take a copy
off the system, no way to return to a known-good state after a bad bulk edit or an accidental
cascade delete, and no protection against the data tier itself being lost. The only export that
exists today is a one-shot spreadsheet download, which is lossy, manual, and not a restore path.

This feature gives each user scheduled and on-demand backups of their own collections to a
**destination they own and supply**, keeps multiple versions, prunes old ones on a retention
policy, and offers a restore that can never overwrite live data.

The user owns the destination. The system never provides storage, never holds a shared bucket, and
never becomes the custodian of another copy of the user's data — it writes to somewhere the user
already controls, using credentials the user supplies.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Add and verify a destination I own (Priority: P1)

A user opens Settings → Backups and adds a place for their backups to go: either an
S3-compatible object store (a self-hosted MinIO, or a commercial bucket) or a WebDAV share (a
Nextcloud instance or a NAS). They give it a label, the address, and their credentials, then press
"Test connection" and get a definite yes or no before saving anything they will later depend on.

**Why this priority**: Nothing else in this feature can be built or demonstrated without somewhere
to write. It is also the entire security surface — a user-supplied address that the system fetches
on the user's behalf — so it must be right before anything automated uses it.

**Independent Test**: Add an S3-compatible destination and a WebDAV destination, test both, edit
one, delete the other. Delivers value on its own: the user has verified, stored credentials for a
place they control, and has been told plainly whether the system can reach it.

**Acceptance Scenarios**:

1. **Given** a user with no destinations, **When** they add an S3-compatible destination with a
   valid address and credentials and press "Test connection", **Then** the system reports success,
   and saving the destination makes it available for selection by a backup job.
2. **Given** a user adding a destination with a wrong secret, **When** they press "Test connection",
   **Then** the system reports a failure that distinguishes "could not reach the address" from
   "reached it, but the credentials were rejected", and does not report success.
3. **Given** a saved destination, **When** the user re-opens it to edit the label, **Then** the
   stored secret is never displayed or returned to the client, and leaving the secret field
   untouched preserves the existing secret rather than blanking it.
4. **Given** a user supplies an address that resolves to a loopback, link-local, private, or
   cloud-metadata address, **When** they test or save it, **Then** the system refuses it and
   explains that the address is not permitted, both at save time and again at every use.
5. **Given** a saved destination, **When** the user deletes it, **Then** its stored credentials are
   erased, and any job referencing it is disabled rather than left pointing at nothing.

---

### User Story 2 - Take a backup right now (Priority: P1)

A user selects which of their collections to include, picks a destination, and presses "Back up
now". A single versioned artifact appears at the destination, covering everything selected, and the
run shows up in a history list with what it contained.

**Why this priority**: This is the feature's core value and the thing every other story depends on.
A user who has only this already has a real off-system copy of their data.

**Independent Test**: Configure a job, press "Back up now", inspect the destination, confirm one
artifact exists whose recorded contents match the live data. Delivers value with no scheduler and no
restore path built.

**Acceptance Scenarios**:

1. **Given** a job selecting two collections, **When** the user presses "Back up now", **Then** one
   artifact is written to the destination containing both collections, with every movie, every
   piece of movie metadata, and every external identifier present.
2. **Given** a completed run, **When** the artifact's recorded per-collection counts and integrity
   check are compared against the live collections, **Then** they match exactly.
3. **Given** a job, **When** the user presses "Back up now" while a run for that user is already in
   progress, **Then** the second request is refused with a clear message rather than starting a
   concurrent run.
4. **Given** a user who presses "Back up now" repeatedly, **When** they exceed the permitted rate,
   **Then** further requests are refused until the limit resets.
5. **Given** a destination that becomes unreachable mid-run, **When** the run fails, **Then** the
   run is recorded as failed with a reason, and no partial artifact is left behind that could later
   be mistaken for a complete version.
6. **Given** a user whose selected collections exceed the documented size ceiling, **When** a run
   starts, **Then** the run fails with an explicit "too large" reason naming the ceiling, rather
   than truncating the data or exhausting system resources.

---

### User Story 3 - Recover from a version without risking what I have now (Priority: P1)

A user made a bad bulk edit, or deleted a collection by accident. They open the version list for a
job, pick a version from before the mistake, and restore it. New collections appear alongside the
existing ones, named after the originals with the backup's timestamp. Nothing they currently have is
touched.

**Why this priority**: A backup that cannot be restored is not a backup. The non-destructive
guarantee is what makes restore safe to offer at all — a mis-clicked version costs a delete, not
data.

**Independent Test**: Take a backup, change the live data, restore the version, and confirm both the
restored copy is faithful and the live data is untouched. Delivers the feature's actual promise.

**Acceptance Scenarios**:

1. **Given** a list of versions for a job, **When** the user restores one, **Then** new collections
   are created named for the source collection plus the backup's timestamp, and every pre-existing
   collection is left byte-for-byte unchanged.
2. **Given** a restored version, **When** the restored collections are compared with what was backed
   up, **Then** movie count, every metadata field, and every external identifier match exactly.
3. **Given** an artifact that has been corrupted or truncated at the destination, **When** the user
   attempts to restore it, **Then** the integrity check fails and the restore is abandoned **before
   any collection is created**.
4. **Given** an artifact written by a future, unrecognised version of the backup format, **When**
   the user attempts to restore it, **Then** the system refuses it with a clear reason rather than
   guessing at the contents.
5. **Given** a version, **When** the user chooses "Download" instead of "Restore", **Then** they
   receive the artifact itself, so they are not dependent on this system to read their own backup.
6. **Given** a restore that fails partway, **When** the user looks at their collections, **Then**
   the partially restored collections are identifiable as such, and the live collections remain
   untouched.

---

### User Story 4 - Backups happen without me (Priority: P2)

A user sets a job to run daily at 03:00 in their own timezone and stops thinking about it. It runs
while they are logged out, asleep, and holding no session.

**Why this priority**: Unattended running is what turns a manual export into a backup. It is P2 only
because on-demand backup (US2) already delivers standalone value, and because this story carries the
feature's hardest decision — how an unattended job is authorised to read the user's data.

**Independent Test**: Configure a daily schedule, log out entirely, and confirm the run fires at the
configured local time and produces a valid artifact.

**Acceptance Scenarios**:

1. **Given** a job scheduled daily at a set local time, **When** that time arrives and the user has
   no active session, **Then** the job runs and produces a valid artifact.
2. **Given** a user enabling a schedule for the first time, **When** they enable it, **Then** they
   are asked to explicitly consent to the system acting on their behalf while they are away, and the
   schedule does not become active until they do.
3. **Given** an enabled schedule, **When** the user disables it or deletes the job, **Then** the
   system's standing permission to act on their behalf is revoked at the identity provider, not
   merely forgotten locally.
4. **Given** more than one instance of the application is running, **When** a job becomes due,
   **Then** it runs exactly once, not once per instance.
5. **Given** a weekly or monthly schedule, **When** the user picks a day of the week or day of the
   month plus a time and timezone, **Then** the next run is calculated correctly — including across
   a daylight-saving transition in both directions, and including a monthly date that does not
   exist in every month.
6. **Given** a job whose scheduled time passed while the system was down, **When** the system
   returns, **Then** the job runs once on recovery rather than once per missed occurrence.
7. **Given** the user's standing permission has expired or been revoked at the identity provider,
   **When** a scheduled run attempts to read their data, **Then** the run fails with a reason that
   tells the user to re-enable the schedule, and the system does not fall back to any
   broader-privileged path to read the data anyway.

---

### User Story 5 - Old versions are pruned so the destination does not fill up (Priority: P2)

A user sets "keep the last 7". After each successful run, the eighth-oldest version and anything
older is deleted from their destination.

**Why this priority**: Without it a daily job fills the user's storage indefinitely. P2 because a
user can live with manual cleanup for a short while; they cannot live without the backup itself.

**Independent Test**: Set keep-last-3, run four times, confirm three versions remain and the oldest
was the one removed.

**Acceptance Scenarios**:

1. **Given** a job with keep-last-N and more than N versions, **When** a run **succeeds**, **Then**
   versions beyond N are deleted oldest-first, leaving exactly N.
2. **Given** a job with more than N versions, **When** a run **fails**, **Then** nothing is pruned —
   a failed run must never be the reason a good version is deleted.
3. **Given** pruning is under way, **When** a delete at the destination fails, **Then** the run is
   still recorded as successful, the pruning failure is recorded separately, and the next successful
   run retries the prune.
4. **Given** a user lowers the retention count on an existing job, **When** the next run succeeds,
   **Then** the new, lower count is applied.
5. **Given** a destination containing files the system did not write, **When** pruning runs, **Then**
   only artifacts belonging to that job are considered for deletion.

---

### User Story 6 - I can see what happened and when it went wrong (Priority: P3)

A user opens Settings → Backups and sees, per job, when it last ran, whether it worked, how big the
result was, and when it will run next. A failure is visible rather than silent.

**Why this priority**: A backup nobody checks is a backup nobody has. P3 because the underlying run
records are created by US2 and US4 regardless; this story is the surfacing of them.

**Independent Test**: Force a failing run, then confirm the failure is visible on next login with a
reason the user can act on.

**Acceptance Scenarios**:

1. **Given** a completed run, **When** the user opens the Backups page, **Then** they see its
   outcome, time, duration, artifact size and per-collection counts.
2. **Given** the most recent run failed, **When** the user opens the Backups page, **Then** a
   prominent indication of the failure is shown with a reason, and it stays until a later run
   succeeds.
3. **Given** a job with a schedule, **When** the user views it, **Then** the next run time is shown
   in the user's own configured timezone.
4. **Given** any recorded run, **When** its details are displayed or logged, **Then** no destination
   credential and no collection content appears anywhere in them.

---

### Edge Cases

- **A destination address that passes at save time but resolves elsewhere later** (DNS rebinding):
  the address check must be applied at every use, against the address actually connected to, not
  only against the text the user typed at save time.
- **A collection is deleted between the run starting and being read**: the run records the
  collection as absent rather than failing the whole backup or silently writing an artifact whose
  manifest disagrees with its body.
- **A restore target name already exists**: collection names are unique per user, so the restored
  name must remain legal even if the user has already restored the same version once.
- **The user's timezone changes** (travel, or an edited preference): the next run time is
  recalculated from the job's stored timezone, which is a property of the job, not of the device.
- **A monthly job set for the 31st**: behaviour in months with fewer days must be defined and
  consistent, never a skipped month.
- **Clock moves backwards across a DST boundary**: a job must not run twice for the same occurrence.
- **A job references a destination the user has deleted**: the job is disabled with a reason, not
  silently failing every night.
- **The user's account is deleted**: their destinations, credentials, jobs, run history and standing
  permission are all erased; artifacts at their own destination are theirs and are not touched.
- **Two jobs write to the same destination and prefix**: each job's artifacts must be
  distinguishable so retention for one never deletes the other's versions.
- **An artifact is present but zero-length or unreadable**: it must be reported as unusable in the
  version list rather than appearing as a restorable version.

## Requirements *(mandatory)*

### Functional Requirements

#### Destinations

- **FR-001**: Users MUST be able to create, view, edit, test and delete their own backup
  destinations, of at least two kinds: an S3-compatible object store and a WebDAV share.
- **FR-002**: The system MUST store destination credentials encrypted at rest and MUST NEVER return
  them to the client, echo them in any response, or write them to any log or audit record.
- **FR-003**: Editing a destination without supplying a new secret MUST preserve the existing
  secret.
- **FR-004**: The system MUST provide a "test connection" action that verifies reachability,
  credential validity, and write permission, and MUST report which of those failed.
- **FR-005**: Every user-supplied destination address MUST be validated against the resolved network
  address — not the hostname text — and rejected if it resolves to a loopback, link-local, private,
  or cloud-metadata range. This validation MUST be re-applied at every use, not only at save time.
- **FR-006**: Deleting a destination MUST erase its stored credentials and MUST disable any job that
  referenced it.

#### Backup jobs and artifacts

- **FR-007**: Users MUST be able to define a job that names a destination, selects specific
  collections, sets a retention count, and may be enabled or disabled.
- **FR-008**: A run MUST produce exactly one artifact covering all of that job's selected
  collections, so that one version is one internally consistent restore point.
- **FR-009**: An artifact MUST capture the full domain data — collections, movies, all movie
  metadata, and all external identifiers — with sufficient fidelity that a restore reproduces them
  exactly. A lossy, presentation-oriented export format MUST NOT be used.
- **FR-010**: An artifact MUST carry a manifest recording its format version, creation time,
  per-collection counts, and an integrity check value covering the data.
- **FR-011**: Artifacts MUST be named and located so that a job's versions can be listed in time
  order and distinguished from any other job's artifacts and from unrelated files at the same
  destination.
- **FR-012**: Users MUST be able to trigger a run on demand, subject to a rate limit.
- **FR-013**: The system MUST run at most one backup at a time per user.
- **FR-014**: A failed run MUST NOT leave an artifact that could later be listed or restored as a
  complete version.
- **FR-015**: The system MUST enforce a documented, operator-configurable ceiling on the size of a
  single run. Exceeding it MUST fail the run with an explicit reason naming the ceiling. Silent
  truncation and unbounded resource growth are both prohibited.

#### Scheduling

- **FR-016**: Users MUST be able to set a schedule of daily, weekly (choosing a day), or monthly
  (choosing a date), each with a time of day and a timezone. Free-text recurrence expressions MUST
  NOT be offered, because a malformed one silently means "never".
- **FR-017**: A scheduled run MUST fire at the configured local time with no user session present.
- **FR-018**: A job MUST run exactly once per due occurrence regardless of how many application
  instances are running.
- **FR-019**: The next run time MUST be computed from the job's stored timezone and MUST be correct
  across daylight-saving transitions in both directions, and for monthly dates absent from some
  months.
- **FR-020**: A job whose scheduled time passed while the system was unavailable MUST run once on
  recovery, not once per missed occurrence.

#### Acting on the user's behalf

- **FR-021**: An unattended run MUST read the user's data with that user's own identity, so that
  existing per-user access control applies unchanged. A broadly-privileged or impersonating path
  MUST NOT be introduced.
- **FR-022**: Enabling a schedule MUST require the user's explicit, informed consent to the system
  acting on their behalf while they are absent.
- **FR-023**: Disabling a schedule, deleting the job, or deleting the account MUST revoke that
  standing permission at the identity provider — not merely delete the local record of it.
- **FR-024**: If the standing permission is missing, expired or revoked, the run MUST fail with an
  actionable reason and MUST NOT fall back to any alternative path to read the data.

#### Retention

- **FR-025**: After a **successful** run, versions beyond the job's retention count MUST be deleted
  from the destination, oldest first.
- **FR-026**: A **failed** run MUST prune nothing.
- **FR-027**: A pruning failure MUST NOT mark an otherwise successful run as failed; it MUST be
  recorded separately and retried on the next successful run.

#### Restore

- **FR-028**: Users MUST be able to list the versions available for a job, and for each one either
  restore it or download the artifact.
- **FR-029**: A restore MUST be non-destructive: it creates **new** collections and MUST NOT modify
  or delete any existing collection.
- **FR-030**: Restored collections MUST be named identifiably after the source collection plus the
  backup's timestamp, and the resulting name MUST satisfy the system's collection-naming rules.
- **FR-031**: The manifest and integrity check MUST be validated **before any data is written**. A
  corrupt, truncated or mismatched artifact MUST be refused with nothing created.
- **FR-032**: An artifact whose format version is not recognised MUST be refused rather than
  interpreted on a best-effort basis.
- **FR-033**: A restore MUST write through the same access-controlled path a user's own actions use,
  so that all ordinary validation and authorisation applies.

#### Isolation, audit and visibility

- **FR-034**: A user MUST NOT be able to read, modify, restore from, or write to another user's
  destinations, jobs, versions or run history. The owning user MUST always be taken from the
  validated session and never from request input.
- **FR-035**: The system MUST record audit events for: destination saved, destination tested,
  destination deleted, schedule enabled, schedule disabled, run started, run succeeded, run failed,
  restore started, restore completed, restore refused. Each MUST record counts, sizes and
  identifiers only — never a credential and never collection content.
- **FR-036**: Users MUST be able to see each job's last run outcome, time, duration, artifact size,
  per-collection counts, and next scheduled run in their own timezone.
- **FR-037**: A failed most-recent run MUST be surfaced prominently on the Backups page and MUST
  persist until a later run succeeds.

### Key Entities

- **Destination** — a place the user owns and has authorised the system to write to. Has a kind
  (S3-compatible or WebDAV), a user-facing label, an address, a container/path, and credentials
  held only in encrypted form. Belongs to exactly one user. One destination may serve many jobs.
- **Backup job** — what to back up, where to, how often, and how many versions to keep. References
  one destination and a set of the user's collections; carries a schedule (frequency, time,
  timezone), a retention count, an enabled flag, and the computed next run time.
- **Run** — one execution of a job, on demand or scheduled. Records start and end time, outcome,
  failure reason if any, artifact size, and per-collection counts. Runs are what the history list
  and the failure indicator are built from.
- **Version (artifact)** — one self-contained, integrity-checked snapshot produced by one successful
  run, stored at the destination. It is the unit of both retention and restore.
- **Manifest** — the artifact's self-description: format version, creation time, per-collection
  counts, and integrity check value. It is what makes a refusal-before-write possible.
- **Standing permission** — the user's revocable consent allowing the system to act with their
  identity while they are absent. Held encrypted, one per user, and destroyed when the last schedule
  is disabled.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with no prior setup can go from opening Settings → Backups to holding a
  verified backup of their collections at their own storage in under 5 minutes.
- **SC-002**: 100% of restores from an intact artifact reproduce collection count, movie count,
  every movie metadata field and every external identifier exactly, with zero differences.
- **SC-003**: 100% of restores leave every pre-existing collection unchanged — measured by
  comparing all live collections before and after.
- **SC-004**: 100% of corrupt, truncated, or unrecognised-format artifacts are refused with nothing
  written.
- **SC-005**: A scheduled job fires within 5 minutes of its configured local time with no user
  session present, and fires exactly once when multiple application instances are running —
  verified over a run of consecutive scheduled occurrences.
- **SC-006**: Next-run calculation is correct for 100% of cases across daylight-saving transitions
  in both directions and for monthly dates absent from some months.
- **SC-007**: After a successful run, the number of versions retained equals the configured
  retention count exactly, and the versions removed are the oldest.
- **SC-008**: A failed run results in zero versions deleted.
- **SC-009**: Zero destination credentials and zero collection contents appear in any response body,
  log line or audit record — verified by inspection across all enumerated operations.
- **SC-010**: 100% of cross-user access attempts against destinations, jobs, versions and run
  history are refused.
- **SC-011**: 100% of destination addresses resolving to loopback, link-local, private or
  cloud-metadata ranges are rejected, including when the hostname text alone looks benign.
- **SC-012**: Disabling the last schedule results in the standing permission being unusable at the
  identity provider — verified by attempting to use it afterwards, not by observing a local delete.

## Assumptions

- **The user owns the destination; the system never provides storage.** There is no system-operated
  bucket, no shared destination, and no fallback location. A user without their own storage cannot
  use this feature, and that is intentional — it keeps the system from becoming custodian of a
  second copy of everyone's data.
- **Two destination kinds in the first release** — S3-compatible and WebDAV — chosen together
  deliberately: two real implementations are what proves the destination abstraction is genuinely
  an abstraction. A third kind should later be an addition, not a redesign.
- **The size ceiling is explicit and it fails loudly.** The first release builds a run's snapshot
  whole rather than streaming it, bounded by a documented configurable ceiling. This is a
  deliberate, reversible trade: streaming is the follow-up, and the ceiling exists so that the need
  for it arrives as a clear error rather than as a resource exhaustion. Silent truncation is never
  acceptable.
- **Failure notification is in-app only in the first release.** Run history plus a persistent
  failure indicator on the Backups page, plus audit events. No outbound email or push. The existing
  email capability in the system triggers identity-provider account flows only and is not a
  general-purpose sender, so email would mean building a new outbound channel for a single
  notification — that is its own piece of work, not a rider on this one.
- **Backups cover movie-collection domain data only.** Application settings, assistant
  configuration, and the user's account itself are out of scope.
- **Restore creates new collections; it never merges.** There is no "restore into the existing
  collection" mode, no conflict resolution, and no partial/selective restore of individual movies in
  the first release. Non-destructiveness is the guarantee that makes restore safe to offer, and
  merge semantics would compromise it.
- **The user's timezone is a property of the job**, captured when the schedule is set, not read from
  whichever device happens to trigger a view.
- **Destination credentials are third-party service credentials the user supplies, not user identity
  credentials.** The constitution's prohibition on local credential stores governs user
  authentication material; this follows the existing precedent for per-user third-party
  configuration already held in the system under the same encryption.
- **The Backups page already exists** as a placeholder route from feature 062. This feature replaces
  its body; the route, its navigation entry and its reported screen identity stay as they are.
- **The existing per-user access control model is unchanged by this feature.** An unattended run
  reads data as the user, so no new authorisation path, role, or exemption is introduced.

## Out of Scope

- Any system-provided or system-operated storage destination.
- Destination kinds beyond S3-compatible and WebDAV (SFTP, FTP, local filesystem, consumer cloud drives).
- Streaming very large snapshots — bounded instead by an explicit ceiling (see Assumptions).
- Email, push or any outbound failure notification.
- Merge, in-place, or selective per-movie restore.
- Backing up anything other than movie-collection domain data.
- Cross-user, team, or administrator-initiated backup and restore.
- Client-side or user-supplied encryption of the artifact beyond the transport and the destination's own protections.

## Dependencies

- **Feature 062 (Settings split)** — provides the Backups sub-page this feature fills. Already shipped.
- **The identity provider must be able to grant a revocable standing permission** for the system to
  act on a user's behalf while they are absent, and must honour revocation of it.
- **An S3-compatible store and a WebDAV server must both be available in the development and test
  environments** for integration testing against real dependencies rather than substitutes.
