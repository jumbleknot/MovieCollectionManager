# Feature Specification: Replace MinIO with RustFS

**Feature Branch**: `080-minio-to-rustfs`

**Created**: 2026-10-10

**Status**: Draft

**Input**: Backlog item #560 — "minio-image has failed its CVE gate for two weeks in silence — and its
Renovate channel does not exist, though renovate.json says it does". Item #577 (closed) recorded the
promotion gap underneath it, and #560's own 2026-09-26 comment recorded the finding that turns a
backlog of fixes into a replacement: **MinIO's community edition has stopped releasing.** Its last
release is `RELEASE.2025-10-15T17-29-55Z`; `master`'s `go.mod` is frozen. A from-source image whose
upstream has stopped shipping accumulates advisories with no remediation path, and the three
`amqp091-go` Criticals suppressed by PR #573 expire on **2026-12-01** with nothing that can clear them.

## Overview

This repository runs an S3-compatible object store in three places, and all three are MinIO:

1. **The production (and dev) Langfuse object store** — `langfuse-minio`, which holds Langfuse's raw
   event uploads and trace media. Production data lives in it.
2. **The BFF backup feature's S3 test destination** — `mcm-bff-backup-minio`, the real server the
   backup driver's integration tier and the backups E2E run against. Fixture data only.
3. **The Nx remote-cache store** — a host-managed MinIO on the production daemon
   (`/home/prod/minio/`, Server-Setup-Runbook Phase 8) behind the self-hosted Nx cache server that
   every CI run consults. Not in a git-tracked compose file, which is why it is easy to miss — and it
   runs an **unpinned** `quay.io/minio/minio`, frozen at whatever that registry last received.

The first two run an image this repository builds from source (features 069/070), because MinIO
deleted its published images. That build was the right answer to a withdrawn image; it is the wrong
answer to an abandoned project. It gave this repository control of the **builder**, never of
upstream's dependency graph, and upstream has stopped moving that graph. So the build machinery — the
weekly workflow, the promotion script, the version-keyed allowlist entries, the Renovate rule that
matches nothing — now maintains an artifact that can only get worse.

This feature replaces every MinIO with **RustFS**, an Apache-2.0, S3-compatible object store that
publishes its own images on a live release cadence (1.0.0 on 2026-09-16, 1.0.1 on 2026-10-03), and
that documents reading MinIO's on-disk format directly. RustFS is consumed the way every other
third-party server image here is consumed: pulled by digest, proposed by Renovate, gated by the
infra-image sweep. The from-source build is retired entirely.

**Production data is preserved, in place.** RustFS reads a copy of MinIO's drive — not an S3-level
re-upload — and the original drive is left untouched so that rollback is real.

### What this feature deliberately does not do

- **It does not touch `otel-lgtm` / Grafana storage.** Measured 2026-10-10: the bundled Tempo in
  `grafana/otel-lgtm` (both 0.34.0 and the currently pinned 0.35.0) uses `storage: trace: backend:
  local` on its own `/data` volume, and no config file in that image names S3 or MinIO. It never used
  MinIO. It is in scope only in the sense that monitoring must still work afterwards; nobody needs to
  hunt for a MinIO inside it.
- **It does not change the BFF backup driver's logic.** The driver speaks S3 to a destination the user
  supplies; the test server behind it changes, and the feature proves the driver did not have to.
- **It does not migrate through the S3 API.** An S3-level copy would re-write every object through a
  second client, lose the on-disk metadata the parity check compares against, and double the bytes
  in flight. The operator ruled it out.
- **It does not upgrade Langfuse.** A parallel change (item #642) moves Langfuse to 4.56.0 in the same
  compose files; this feature lands after it and rebases on it.

### Why preserving Langfuse data is consistent with ADR-0002 §4

ADR-0002 §4 ratified that production Langfuse traces need not survive a **Langfuse major upgrade**,
because there the data format itself changes and preservation is a feature in its own right. This is
not a Langfuse upgrade: the trace rows in ClickHouse and Postgres are untouched, and only the store
behind the event/media blobs changes. Discarding the blobs here would not reset Langfuse cleanly — it
would leave every surviving trace pointing at media that no longer exists, a mixed state worse than
either keeping or discarding everything. And preservation is cheap: a volume copy whose parity can be
counted. §4 is a judgement about cost against benefit for one kind of change; it is not a policy that
production Langfuse data is disposable. The operator explicitly wants it preserved here.

## Clarifications

### Session 2026-10-10 (operator decisions, fixed before specification)

- Q: Which MinIO instances are replaced? → A: All of them. The Langfuse object store (dev and prod)
  and the BFF backup S3 test destination are named; the specification adds the host-managed Nx-cache
  store found while tracing every occurrence (see Open Questions for its handling).
- Q: How is production data moved? → A: In place — RustFS reads MinIO's on-disk data. Not an S3-level
  copy.
- Q: What must be proven afterwards? → A: The application and monitoring work, and CI, CD, their
  triggers and every gate work — each demonstrated, not inferred.
- Q: What happens to the from-source MinIO build (features 069/070)? → A: Retired entirely: its
  workflow, Dockerfile, promotion script and their guards. RustFS is consumed as an upstream pulled
  image through Renovate and the infra-image sweep.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Production Langfuse keeps every object it had, on RustFS, with a real way back (Priority: P1)

The operator moves the production Langfuse object store from MinIO to RustFS. Before anything stops,
the existing drive is inventoried and confirmed to be a layout RustFS can read. Langfuse's writers are
stopped, the drive is copied to a new volume, RustFS starts on the copy, and the result is checked
object-for-object against what MinIO held. Langfuse comes back, old traces still show their media, new
traces upload. If anything is wrong, the operator returns to MinIO on the untouched original drive.

**Why this priority**: It is the only part of this feature that holds production data, and the only
part where a mistake is not recoverable by re-running CI. Everything else is in service of getting
here safely.

**Independent Test**: On a rehearsal drive seeded by the current MinIO with objects of every shape
Langfuse writes (small inline, multipart, many keys under deep prefixes), run the migration and
confirm the parity check passes, the original drive is byte-identical to before, and a deliberate
rollback brings MinIO back serving every original object.

**Acceptance Scenarios**:

1. **Given** the production drive, **When** it is inventoried, **Then** its layout, drive count,
   presence or absence of server-side-encrypted or tiered objects, bucket configuration, object count
   and total bytes are recorded — and the migration refuses to proceed for any layout RustFS cannot
   read.
2. **Given** a verified-readable drive and stopped writers, **When** the migration runs, **Then** a new
   drive is produced and the original drive is not modified in any way.
3. **Given** RustFS started on the new drive, **When** parity is checked, **Then** object count, total
   bytes and every object's size and ETag match the pre-migration manifest, and a content checksum of
   a sample of objects (including every multipart object) matches.
4. **Given** the migrated store, **When** an operator opens a trace that existed before the
   migration and carries media, **Then** the media loads.
5. **Given** the migrated store, **When** the assistant produces a new trace, **Then** its events and
   media are written and the trace loads.
6. **Given** a failed verification or a defect found after cutover, **When** the operator rolls back,
   **Then** MinIO serves the original drive exactly as it was before the migration began.
7. **Given** a completed migration, **When** the rollback window closes, **Then** the original drive
   and the retired credential are deleted deliberately, not left behind.
8. **Given** the migrated stack, **When** Grafana and the infra telemetry pipeline are checked,
   **Then** they behave exactly as before.

---

### User Story 2 - Backups still work, proven against a real RustFS (Priority: P1)

A user's scheduled and manual backups to an S3 destination keep working. The backup integration
tier — every suite that talks to the S3 test destination — runs against a real RustFS with nothing
skipped, and the backups E2E passes. The driver code does not change.

**Why this priority**: The backup feature's S3 path is user-facing, and its integration tier is the
only oracle for the signer's S3 dialect. If that oracle changes, the evidence that the driver is
correct must be re-earned, not assumed.

**Independent Test**: Bring up the backup destinations with RustFS as the S3 server, run the backup
integration suites with a skip becoming a failure, and read the skip count.

**Acceptance Scenarios**:

1. **Given** the S3 test destination running RustFS, **When** the backup integration suites run with
   skipping forbidden, **Then** every suite passes and zero tests are skipped.
2. **Given** the same, **When** the backups web E2E runs, **Then** it passes.
3. **Given** a fresh environment with no prior volume, **When** the destinations come up, **Then** the
   S3 server becomes healthy and its test bucket exists without manual steps.
4. **Given** the driver and signer source, **When** this feature is complete, **Then** their logic is
   unchanged; only comments naming the oracle are updated.

---

### User Story 3 - RustFS stays current on its own, and its findings are seen (Priority: P2)

RustFS is a pulled, digest-pinned image. Renovate proposes its updates through the same channel as
every other server image, and the infra-image sweep scans it. The from-source MinIO build, its
weekly workflow, its promotion machinery and every allowlist entry keyed to it are gone, in the same
change, so nothing is left that matches nothing.

**Why this priority**: This is the defect #560 actually reports — a supply chain with no working
update channel and a red gate nobody sees. Replacing the image without a working channel would rebuild
the same trap with a different name.

**Independent Test**: After merge, read Renovate's Dependency Dashboard and confirm it lists the RustFS
dependency in each compose file that pins it; run the infra-image sweep and confirm RustFS is among
the scanned images; run the allowlist expiry check and confirm no unmatched entry remains.

**Acceptance Scenarios**:

1. **Given** the merged change, **When** Renovate next runs, **Then** its Dependency Dashboard lists
   `rustfs/rustfs` for every compose file that references it.
2. **Given** a configuration change that would hide those files from Renovate, **When** the guards
   run, **Then** they fail.
3. **Given** the infra-image sweep, **When** it runs on a pull request and on its weekly schedule,
   **Then** RustFS is scanned and the run is green.
4. **Given** the allowlist, **When** the expiry check runs, **Then** no entry keyed to the retired
   image remains, and the scheduled sweep reports its expiry step as successful.
5. **Given** the repository, **When** this feature merges, **Then** no workflow, schedule or path
   trigger builds, scans or promotes a MinIO image.

---

### User Story 4 - Nothing still says MinIO, except history (Priority: P2)

Every live reference — configuration, scripts, tests, gates, runbooks, the README and the generated
knowledge wiki — describes RustFS. Historical records (completed specs, ADRs, proposals) keep their
MinIO references because they record what was true. A guard keeps it that way.

**Why this priority**: A runbook that tells an operator to run `mc ready local` against a server that
has no `mc` is a production incident waiting for a bad night.

**Independent Test**: Run the new guard; then add a MinIO reference to a live file and confirm the
guard fails naming that file.

**Acceptance Scenarios**:

1. **Given** the repository, **When** the guard runs, **Then** no MinIO reference survives outside the
   declared historical exemptions.
2. **Given** a new MinIO reference in a live file, **When** the guard runs, **Then** it fails and names
   the file and line.
3. **Given** the regenerated knowledge wiki, **When** an agent asks how Langfuse stores media or what
   backs the backup tests, **Then** the answer is RustFS.

---

### User Story 5 - The Nx remote cache keeps working on RustFS (Priority: P3)

The host-managed object store behind the Nx remote cache is replaced with RustFS by the same
procedure, and CI's remote-cache hits keep working.

**Why this priority**: The data is rebuildable — a cold cache costs time, not correctness — and the
store is host state outside any git-tracked compose file. It is in scope because it is a MinIO, it is
unpinned, and CI depends on it; it is last because nothing is lost if it goes wrong.

**Independent Test**: After the swap, run an Nx target twice in CI and confirm the second run reports a
remote-cache hit.

**Acceptance Scenarios**:

1. **Given** the swapped store, **When** a CI run executes a cacheable target already executed by an
   earlier run, **Then** it is a remote-cache hit.
2. **Given** the runbook, **When** an operator rebuilds the host from it, **Then** the Nx-cache store
   it describes is a digest-pinned RustFS.

---

### Edge Cases

- **The production drive is in MinIO's legacy single-directory ("FS") layout**, not the erasure
  ("xl-single") layout. RustFS cannot read that layout. The migration must detect it from the drive's
  format record and refuse, and the feature then needs a different path (an S3-level copy, which the
  operator would have to approve as a departure from the in-place decision).
- **The drive contains server-side-encrypted objects.** Released RustFS builds fail closed on them.
  The inventory must detect any and the migration must refuse.
- **The drive contains tiered/transitioned objects.** Not fixture-proven upstream; the inventory must
  detect any and the migration must refuse.
- **The new drive is started by a process running as a different numeric user than owns its files.**
  The server fails at startup (measured: `Permission denied` on local-disk initialisation). Ownership
  must be set as part of producing the new drive, and verified by counting files not owned by the
  runtime user, not by inspecting the top directory.
- **Anything writes to the original drive after migration starts.** That would invalidate it as a
  rollback target. Writers are stopped first; MinIO itself is stopped before the copy; the copy reads
  the original read-only.
- **Writes accepted by RustFS between cutover and a rollback.** Migration is one-way (MinIO cannot read
  a drive RustFS has written to), so rollback returns to the pre-migration state and those writes are
  lost. This is accepted and bounded by verifying immediately after cutover.
- **A fresh, empty volume** (dev, CI's per-run backup destination). It must come up healthy with no
  migration step — which rules out any runtime identity that differs from the image's own.
- **The bucket already exists** when the bucket-creation step runs (every restart after the first).
  Creation must be idempotent.
- **The stack's required inputs change.** A new required variable in a production compose is a change
  to that stack's Komodo inputs, and must exist in Komodo before the deploy that needs it (feature
  069 R9).
- **A Langfuse upgrade (item #642) lands first and touches the same files.** This feature rebases on
  it rather than racing it.

## Requirements *(mandatory)*

### Functional Requirements

**Migration (production data)**

- **FR-001**: Before any production change, the operator MUST record an inventory of the production
  Langfuse drive: format record (layout and drive count), presence of server-side-encrypted objects,
  presence of tiered objects, bucket configuration (versioning, lifecycle, notification), object count
  and total bytes per bucket. The inventory MUST be produced by a committed tool, not by hand.
- **FR-002**: The migration MUST refuse to proceed when the layout is not single-drive erasure format,
  when any server-side-encrypted or tiered object is present, when any bucket carries a notification
  configuration, or when the drive count is not one.
- **FR-003**: The migration MUST stop every writer (Langfuse web and worker) and then the old store
  before copying, and MUST read the original drive read-only.
- **FR-004**: The migration MUST copy the original drive to a **new** volume and MUST NOT modify the
  original. The original's integrity MUST be checkable before and after (content digest of the tree).
- **FR-005**: The new volume's files MUST be owned by the numeric user the RustFS image runs as, read
  from the pinned image at migration time rather than written as a literal, and verified by counting
  entries with any other owner (expected: zero).
- **FR-006**: Parity MUST be verified against a manifest taken from the old store before cutover:
  object count, total bytes, and every object's key, size and ETag; plus a content checksum of every
  multipart object and a sample of the rest.
- **FR-007**: After cutover, a pre-existing trace with media and a newly produced trace MUST both load
  in the Langfuse UI.
- **FR-008**: Rollback MUST be a revert of the compose change, restoring MinIO on the untouched
  original volume with its original credential. The original volume and the original credential MUST
  be kept until the rollback window closes, then deleted in a recorded step.
- **FR-009**: The migration MUST be rehearsed — first by an automated rehearsal that seeds a drive
  with the currently deployed MinIO and asserts parity, original-drive immutability and rollback; then
  on the dev Langfuse drive — before production.
- **FR-010**: The migration tool MUST default to a read-only mode and require an explicit flag to
  write; an unrecognised argument MUST be rejected, never ignored.

**Object store service (all instances)**

- **FR-011**: Every instance MUST run a digest-pinned upstream RustFS image, as the image's own
  runtime user, with no override of that user in compose.
- **FR-012**: Every instance MUST have a healthcheck that reflects real readiness, so that every
  dependant gated on health waits for a store that can serve.
- **FR-013**: Bucket creation MUST be idempotent, MUST NOT place credentials in any process's
  arguments, and MUST keep the production stack's always-running, health-reported shape (Komodo
  counts an exited container as unhealthy).
- **FR-014**: Server logs MUST go to the container's standard output, so container log tooling, CI
  log dumps and log rotation see them.
- **FR-015**: No instance MUST expose an administrative console port.
- **FR-016**: Services, volumes and variables MUST be renamed from MinIO to RustFS names and satisfy
  the resource-naming, restart-policy, published-port and no-inline-secret gates.

**Application**

- **FR-017**: Langfuse's event and media upload configuration MUST point at the RustFS service with
  path-style addressing and the same bucket.
- **FR-018**: The BFF backup S3 driver and request signer MUST NOT change in logic; comments naming
  the test oracle MUST be updated.
- **FR-019**: Every integration suite that uses the S3 test destination MUST pass against RustFS with
  skipping forbidden and a skip count of zero, and the backups web E2E MUST pass.
- **FR-020**: Dev and CI environment generation MUST produce the RustFS destination host and internal
  endpoint; dev env examples and the Komodo stack definition MUST carry the renamed variable.

**CI, CD, triggers and gates**

- **FR-021**: CI's backup-destination bring-up, health waits, log dumps and step ceilings MUST
  reference the RustFS containers; a requirement for the forge registry that existed only for the
  from-source image MUST be removed.
- **FR-022**: The MinIO image workflow, its schedule and path triggers, its Dockerfile, its promotion
  script and every guard that exists only for them MUST be removed; every comment or test that cites
  them as a precedent MUST be updated so it does not describe a mechanism that no longer exists.
- **FR-023**: Renovate MUST extract `rustfs/rustfs` from every compose file that references it, with
  the standard supply-chain cooldown; the MinIO rules and the prose describing a non-existent manager
  MUST be removed. A guard MUST assert the extraction (visibility), not merely a rule.
- **FR-024**: The infra-image sweep MUST scan RustFS; every allowlist entry keyed to the retired image
  MUST be deleted in the same change.
- **FR-025**: A guard MUST fail if a MinIO reference appears outside a deliberate, reasoned list of
  historical exemptions.
- **FR-026**: The development-container egress entries that exist only for the from-source Go build
  MUST be removed, after confirming nothing else needs them.
- **FR-027**: Production observability health after the CD deploy MUST be demonstrated, since the
  post-deploy probe covers only the identity issuer and the app.

**Documentation**

- **FR-028**: Runbooks, README and environment examples MUST describe RustFS; the knowledge wiki MUST
  be regenerated through its build target.

**Nx remote cache (host-managed)**

- **FR-029**: The host-managed Nx-cache store MUST be replaced by a digest-pinned RustFS by the same
  procedure, and Server-Setup-Runbook Phase 8 MUST describe it.

### Key Entities

- **Drive**: an object store's on-disk data set — a single directory holding a format record, a
  system area (bucket configuration, identity configuration) and object data. Has a layout, a drive
  count and an owner.
- **Inventory**: the recorded facts about a drive that decide whether it may be migrated.
- **Manifest**: the list of every object (bucket, key, size, ETag) the old store served, taken before
  cutover.
- **Parity report**: the comparison of the manifest with what the new store serves, plus content
  checksums; pass or fail with every discrepancy named.
- **Rollback target**: the original drive, unmodified, plus the original credential and the reverted
  compose.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Production parity report: 100% of pre-migration objects present with matching size and
  ETag; 0 checksum mismatches; original drive's content digest identical before and after.
- **SC-002**: A pre-migration trace with media and a post-migration trace both load in production
  Langfuse.
- **SC-003**: The backup integration suites that use the S3 destination report 0 failures and **0
  skipped**, locally and in CI; the backups web E2E passes.
- **SC-004**: On the merge pull request: `guardrails`, `app-ci` (integration tier with 0 skips and
  `app-e2e`) and `infra-image-scan` are green.
- **SC-005**: A real **scheduled** weekly infra-image sweep after merge scans RustFS and reports its
  allowlist expiry step as `success` — before the retired entries' 2026-12-01 expiry would have
  mattered.
- **SC-006**: A `cd-deploy` run with `deploy=true` after cutover leaves `prod-observability` with every
  container healthy (or, for the init container, running and healthy), demonstrated on the host.
- **SC-007**: Renovate's Dependency Dashboard lists `rustfs/rustfs` under each compose file that pins it.
- **SC-008**: Grafana loads, infra telemetry is still arriving, and the Langfuse UI loads — unchanged.
- **SC-009**: The no-MinIO guard passes, and fails when a MinIO reference is planted in a live file.
- **SC-010**: CI reports a remote-cache hit against the RustFS-backed Nx cache.
- **SC-011**: No workflow, schedule or allowlist entry for a MinIO image remains.

## Assumptions

- RustFS 1.0.1 (or a later 1.x proposed by Renovate before implementation) reads MinIO `xl.meta`
  versions 1–3 from a single-drive set, imports bucket and identity configuration from MinIO's system
  area at first start, and fails closed on encrypted objects — per its published compatibility
  document, and confirmed for this repository's MinIO build by the 2026-10-10 measurement in
  research.md.
- All three production-relevant instances run with root credentials only, no KMS, no notification
  targets, no tiering. This is verified on the host as a task (FR-001), not assumed for production.
- Prometheus-style metrics from the object store are not consumed by anything today; none are added.

## Dependencies

- Item #642 (Langfuse 4.56.0) lands first; implementation rebases on it.
- Item #552 (BACKUP_TEST_* credentials missing from the dev `stacks/mcm.env`) is a precondition for
  the **local** zero-skip proof of SC-003. CI is unaffected because it mints its own credentials.
- A Komodo Variable for the new store credential exists before the production deploy (operator).

## Out of Scope

- Changing what Langfuse stores or how it addresses the bucket.
- Changing the BFF backup driver, signer or destination guard logic.
- Object-store metrics, erasure-coded multi-drive layouts, encryption at rest.
- Re-litigating ADR-0002 §4 for future Langfuse majors.

## Open Questions (for the operator)

1. **Nx-cache store (User Story 5)** — it is host state, holds only rebuildable cache, and is outside
   the in-place decision as stated. Default here: migrate it in place by the same tool (one procedure,
   warm cache). Acceptable alternative: recreate empty. Or defer it to its own item.
2. **Rollback window length** — default 14 days, then the original volume and old Komodo Variable are
   deleted.
3. **New credential value** — default: a freshly generated secret under the new variable name
   (measured: RustFS accepts different root credentials on a migrated MinIO drive), which rotates the
   credential for free. Alternative: copy the old value.
