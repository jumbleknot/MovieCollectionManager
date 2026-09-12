# Feature Specification: MinIO built from source

**Feature Branch**: `408-minio-from-source`

**Created**: 2026-09-11

**Status**: Draft

**Input**: User description: "Build a secure, production-ready MinIO Docker image completely from source without relying on minio base images using a multi-stage Dockerfile. The justification: both Docker Hub and Quay had stale images that weren't including updates — in October 2025 MinIO transitioned to a source-only distribution model for its community edition, and the maintainers stopped building and pushing official Docker images to Docker Hub and Quay.io."

## Why now

On 2026-09-11 MinIO removed `minio/minio` and `minio/mc` from Docker Hub. Both repositories return
`404 object not found`; the `minio` organisation is intact with 20 other repositories, and
`library/node` returns `200` as a control, so this is neither an outage nor a local egress fault. The
removal landed between 10:24Z (the last clean infra sweep) and 22:13Z (the first failed pull).

The observability stack pins both images by digest, in local **and** production compose. Three things
follow, and only the first is visible today:

1. The infra-image scan is fail-closed red on every infra-touching pull request and on the weekly
   sweep. One pull request is already blocked by it and every future one will be.
2. The observability stack cannot be started from a cold image cache.
3. Production references both images. Any host that pulls — a redeploy, a rebuild, a new node — fails.
   Containers already running are unaffected, so this is a **latent** failure rather than a live
   outage, which is precisely what makes it easy to leave until it is urgent.

Switching registry does not fix it. MinIO moved the community edition to source-only distribution in
October 2025 and stopped publishing images anywhere, so the copies still on Quay are frozen at the
same point. The evidence is visible in the version numbers: the newest **source** tag is
`RELEASE.2025-10-15T17-29-55Z`, titled *"Security/CVE"*, and no registry ever received it. Building
from source is therefore not only the durable answer, it recovers a security release the project
has been silently missing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The observability stack starts from a cold cache (Priority: P1)

An operator brings up the observability stack on a machine that has never pulled these images — a new
developer, a rebuilt host, a redeployed production node. Today this fails because the images no longer
exist upstream. After this change the images come from the project's own registry and the stack
starts.

**Why this priority**: This is the failure that already exists in production, merely deferred until
something pulls. Every other story is prevention; this one is repair.

**Independent Test**: On a host with the relevant images removed from the local cache, start the
observability stack and confirm every service reaches a healthy state.

**Acceptance Scenarios**:

1. **Given** a host with no cached MinIO image, **When** the observability stack is started, **Then**
   the storage service pulls successfully and reports healthy.
2. **Given** the storage service is healthy, **When** the bucket-initialisation step runs, **Then** the
   `langfuse` bucket exists and the step reports success.
3. **Given** the stack is fully up, **When** an application trace is recorded, **Then** it is stored
   without a "Failed to upload JSON to S3" error.
4. **Given** an existing data volume written by the currently-running version, **When** the replacement
   image starts against it, **Then** existing objects remain readable and writable.

---

### User Story 2 - The change gate stops being blocked by a dead dependency (Priority: P1)

A contributor opens any pull request that touches infrastructure. Today the image scan fails
fail-closed because it cannot pull a deleted image, blocking work unrelated to the diff. After this
change the scan resolves every referenced image and reports on its findings rather than its
inability to fetch.

**Why this priority**: Equal to P1 above because it blocks all infrastructure work, including the
change that fixes P1. It is also the only story whose failure is currently visible.

**Independent Test**: Run a full scan sweep on a branch carrying the change and confirm it completes
and reports findings rather than a fetch failure.

**Acceptance Scenarios**:

1. **Given** the replacement image is referenced, **When** a full sweep runs, **Then** every image is
   resolved and the sweep completes with a findings verdict.
2. **Given** the sweep completes, **When** its result is inspected, **Then** it is confirmed to be a
   real sweep and not a skipped one.

---

### User Story 3 - Security updates become possible again (Priority: P2)

A maintainer needs the storage service patched for a newly published vulnerability. Today there is no
upstream image to move to, so the only options are accepting the finding or removing the service.
After this change the project controls the build and can rebuild against a patched toolchain or a
newer source release.

**Why this priority**: It is the durable value of the change rather than the immediate repair, and it
is only realisable once P1 lands.

**Independent Test**: Trigger a rebuild without changing the source version and confirm a new image is
produced and published.

**Acceptance Scenarios**:

1. **Given** no source-version change, **When** a scheduled rebuild runs, **Then** a new image is
   produced incorporating current base and toolchain patches.
2. **Given** the replacement image, **When** it is scanned, **Then** vulnerabilities inherited from an
   outdated build toolchain are absent.

---

### User Story 4 - Supply-chain provenance is verifiable (Priority: P3)

A reviewer asks what is actually inside the image and where it came from. The build must identify the
exact upstream source it was produced from, in a way a mutable tag cannot be substituted for.

**Why this priority**: It matters for trust and audit but no operational flow depends on it.

**Independent Test**: Inspect the build definition and confirm the upstream source is identified by an
immutable reference, and that a tampered or moved tag would fail the build rather than silently
produce a different artifact.

**Acceptance Scenarios**:

1. **Given** the build definition, **When** the upstream source reference is inspected, **Then** it
   names both a human-readable release and an immutable commit identifier.
2. **Given** an upstream tag that has been moved to a different commit, **When** a build runs, **Then**
   it fails rather than producing an unexpected artifact.

---

### Edge Cases

- **Upstream deletes or moves the source repository too.** The build fetches from the same
  organisation that just deleted its images. The failure must be loud at build time; the last
  successfully published image remains usable in the meantime because it lives in the project's own
  registry.
- **The build succeeds but the artifact is wrong.** A compiled binary that starts but misreports its
  version, or lacks the client used by the healthcheck, would pass a naive build check and fail in
  service. Verification must exercise the running service, not the build exit code.
- **Existing production data is unreadable by the new image.** Mitigated by building the identical
  version already running, so the on-disk format is unchanged by construction. This is the reason the
  version bump is deliberately excluded from this change.
- **The replacement runs under a different identity than the data volume expects.** The live volume was
  created by the upstream image's runtime identity; a replacement that differs cannot write to it.
- **The scan reports success without examining anything.** A scan that is skipped reports the same
  green as one that ran. Any claim that the images are clean must distinguish the two.
- **The image falls outside every scanner.** The project has two scanners with deliberately disjoint
  scopes. A new artifact that belongs to neither would be published unexamined and nothing would say
  so.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project MUST publish its own storage-service image to its own registry, built from
  upstream source, with no dependency on an upstream-published image at run time.
- **FR-002**: The published image MUST contain both the storage server and the companion client
  program, because the existing health check invokes the client inside the server container.
- **FR-003**: The image MUST be produced from upstream source identified by both a release name and an
  immutable commit identifier; a release name alone MUST NOT be sufficient.
- **FR-004**: The build MUST be hermetic with respect to its toolchain — it MUST NOT fetch an
  additional compiler at build time, so that a build is reproducible from its pinned inputs.
- **FR-005**: The build MUST preserve the upstream version stamp, because the health check and version
  reporting depend on the program reporting its own version correctly.
- **FR-006**: This change MUST build the same upstream versions currently in service, so that any
  regression is attributable to packaging rather than to a version move.
- **FR-007**: The image MUST run under the same runtime identity as the image it replaces, so that the
  existing production data volume remains writable.
- **FR-008**: The stack MUST continue to work with its existing health check and bucket-initialisation
  behaviour unchanged, so the change surface is limited to which image is referenced.
- **FR-009**: The project MUST be able to produce a patched image without waiting for anything upstream
  to be published. Two distinct mechanisms are required, and they are not interchangeable:
  - **On change** — when a pinned input moves (a new build toolchain, a new runtime base, a new
    upstream release), a rebuild MUST be produced. This is the path by which a security patch actually
    reaches the image.
  - **On a schedule** — a recurring rebuild MUST run even when no input has changed. Its purpose is to
    prove the build still works — that upstream source is still fetchable and the pinned inputs still
    compile — so that a failure is discovered on a quiet day rather than during an incident.
- **FR-010**: The published image MUST be covered by a vulnerability scanner, and it MUST NOT be
  possible for it to fall outside every scanner's scope.
- **FR-011**: The scanner's scope rule MUST be expressed so that any future artifact built outside the
  deployment pipeline is also covered, rather than fixing only this one case.
- **FR-012**: Suppression entries written for the now-replaced upstream images MUST be removed, so that
  no suppression outlives the artifact it was written for.
- **FR-013**: Dependency-update tracking MUST follow the upstream source releases and MUST keep those
  releases orderable, so a newer release is recognised as newer.
- **FR-014**: Any existing guard whose premise this change invalidates MUST be updated to assert the
  new premise. Guards MUST NOT be deleted or weakened to accommodate the change.
- **FR-015**: The project MUST record that running under the replaced image's identity is a knowing,
  temporary acceptance, with the follow-up work identified rather than left implicit.

### Key Entities

- **Storage service image**: The project-built artifact replacing the deleted upstream image. Carries
  the server and client programs, is addressed by an immutable digest, and is owned by the project's
  registry.
- **Upstream source reference**: The release name plus immutable commit identifier the image is built
  from. The unit that dependency tracking proposes changes to.
- **Object data volume**: Persistent storage holding production objects, written by the version in
  service today. Its format and ownership constrain what the replacement may change.
- **Scanner scope rule**: The definition of which images each scanner examines. Currently a broad
  pattern that would let this new artifact escape both scanners.
- **Suppression entry**: A recorded acceptance of a known finding against a specific image reference.
  Four exist for the images being replaced and must not outlive them.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The observability stack starts successfully on a host with no cached storage image —
  currently impossible.
- **SC-002**: Recording an application trace stores it successfully, with zero storage-upload errors.
- **SC-003**: Existing stored objects remain fully readable and writable after the replacement, with no
  migration step and no data loss.
- **SC-004**: A full infrastructure image sweep completes with a findings verdict rather than a fetch
  failure, and is demonstrably a real sweep rather than a skipped one.
- **SC-005**: Infrastructure pull requests are no longer blocked by an unfetchable image — the blocked
  pull request proceeds.
- **SC-006**: Every image the project publishes is examined by exactly one scanner, with none
  unexamined — verifiable by inspection rather than assumed.
- **SC-007**: Zero suppression entries remain that reference an image the project no longer uses.
- **SC-008**: A rebuild can be produced on demand with no upstream version change, so the time to
  respond to a newly published vulnerability is bounded by the project's own process rather than by
  upstream publishing anything.
- **SC-009**: Vulnerabilities arising from an outdated build toolchain are absent from the published
  image, where the replaced upstream image carried them.

## Assumptions

- The upstream source repositories remain available. If they are removed, this change still leaves the
  project better off than today, because the last published image lives in the project's own registry
  rather than someone else's.
- Building the identical upstream version from source produces a functionally equivalent service. The
  verification bar exercises the running stack rather than assuming this.
- The existing data volume was created by the replaced image's runtime identity, so matching that
  identity preserves access. Inspection of the upstream image's configuration supports this, and the
  acceptance criteria verify it against a real volume.
- The companion client's newest upstream source release is the version already in service, so no client
  version decision is deferred by this change.
- The project's registry is an acceptable distribution point for an infrastructure image. It already
  serves this role for other project-built images.
- Ongoing maintenance is accepted. Upstream no longer publishes images, so responsibility for noticing
  and responding to storage-service vulnerabilities transfers to the project. The recurring rebuild is
  the mechanism, but the commitment is real and continuing.

## Out of Scope

- Moving to the newer `RELEASE.2025-10-15T17-29-55Z` security release. Deliberately separate: pairing a
  version move with a packaging change on a stateful service makes a failure unattributable.
- Running under a non-root identity. Requires a one-time ownership change on the live data volume and
  is tracked as its own work.
- Mirroring or self-building any other third-party image.
- Re-evaluating the runtime base of other project-built images.
- The OpenSearch and Langfuse major upgrades tracked separately.
