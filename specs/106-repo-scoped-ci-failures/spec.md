# Feature Specification: Repo-scoped CI evidence-bundle package

**Feature Branch**: `106-repo-scoped-ci-failures`

**Created**: 2026-11-22

**Status**: Draft

**Input**: User description: "Rename the owner-level `ci-failures` evidence-bundle package to `<repo>-ci-failures` (derived, never hard-coded), because other repositories under the same owner (BELAY) now run the same failure digest. Keep a transition period in which readers, retention and posted links still work for the legacy name, and record when the legacy name can be dropped."

## Context

When a CI job fails, the failure digest publishes an **evidence bundle** (plus a small per-step
**durations file**) as a version of one generic package in the forge's package registry, and posts a
short digest comment that links to it. Agents and maintainers then use the `ci-status` tool to fetch a
bundle, or to sample the durations files of a job's recent runs to calibrate step ceilings. A weekly
**registry-retention** job decides which package versions to keep.

That package is **owner-level**, named `ci-failures`, while the digest is now shared tooling: the BELAY
repository under the same owner runs it too. One shared name means one repository's bundles occupy
another's retention quota, that one repository's prune deletes another's evidence, and that a lookup by
job name can return another repository's bundle. BELAY publishes to `belay-ci-failures` from its first
run; this feature moves MCM to the same convention, `<repo>-ci-failures`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - New evidence lands in this repository's own package (Priority: P1)

A CI job in this repository fails. The digest publishes the evidence bundle and durations file to a
package whose name carries this repository's name (`mcm-ci-failures` here), and the digest comment's
bundle reference and link name that package. Nothing new is written to the legacy shared name.

**Why this priority**: It ends the cross-repository collision for all new evidence, the reason for the
feature. Everything else exists to keep the transition lossless.

**Independent Test**: Run the digest's publish path against a recorded forge, and against a repository
identity other than this one. Confirm every write targets `<that repo>-ci-failures` and none targets
`ci-failures`.

**Acceptance Scenarios**:

1. **Given** a failing job in repository `jumbleknot/mcm`, **When** the digest publishes, **Then** the
   bundle and durations file are written as a version of `mcm-ci-failures`, and the posted bundle
   reference and link name `mcm-ci-failures`.
2. **Given** a repository whose name has uppercase letters (e.g. `Owner/BELAY`), **When** the digest
   derives the package name, **Then** it is the lowercased `belay-ci-failures`.
3. **Given** the digest runs outside CI, with no runner-provided repository identity, **When** it
   derives the package name, **Then** it uses the repository named by the `origin` remote.

---

### User Story 2 - Existing evidence stays reachable during the transition (Priority: P1)

An agent diagnosing a failure asks `ci-status` for a run's bundle, or for a job's recent durations. The
run may predate the rename, so its bundle is in the legacy package. The tool finds it, and samples
durations across both packages, newest first. Links already posted in PR comments keep working while
the legacy versions exist.

**Why this priority**: Without it, the rename makes up to 30 days of evidence unreachable, the window
in which a just-failed PR is most likely to be diagnosed, and breaks step-ceiling calibration
until the new package fills.

**Independent Test**: Against a recorded forge holding versions under both names, fetch a bundle that
exists only under the legacy name, fetch one under the new name, and request durations for a job with
runs under both. Each succeeds, and each durations file is read from the package its version lives in.

**Acceptance Scenarios**:

1. **Given** a run whose bundle exists only in `ci-failures`, **When** `ci-status` fetches it, **Then**
   it is retrieved from the legacy package.
2. **Given** a run whose bundle exists in `mcm-ci-failures`, **When** `ci-status` fetches it, **Then**
   it is retrieved from the new package. The new name is tried first.
3. **Given** a job with recent runs in both packages, **When** `ci-status durations` samples it,
   **Then** the sample is the newest N runs across both, and each durations file is fetched from the
   package that holds that version.
4. **Given** a bundle under neither name, **When** `ci-status` fetches it, **Then** it reports the
   bundle absent, exactly as today.
5. **Given** the owner holds other repositories' packages (e.g. `belay-ci-failures`), **When**
   `ci-status` lists versions, **Then** none of them is included.

---

### User Story 3 - Retention covers both names, and the legacy name drains (Priority: P2)

The weekly retention job keeps the new package's evidence for the same window as before, refuses a
config whose window is too short for either name, and leaves legacy versions to expire. The digest's
own age-based prune deletes expired versions under both names, so the legacy package empties within
its retention period and never lingers.

**Why this priority**: Retention mistakes lose evidence silently, or keep the legacy package forever.
The count-based keep rule alone would hold the last 650 legacy versions indefinitely, because nothing
writes that name again.

**Independent Test**: Load retention configs that set a too-short window on the new name, and on the
legacy name; both are refused. Run the digest's prune selection over versions of both names and
confirm the expired versions of each are selected, and that no other repository's package is touched.

**Acceptance Scenarios**:

1. **Given** the committed retention config, **When** it is loaded, **Then** both `mcm-ci-failures`
   and `ci-failures` are covered, with the same keep-days and keep-newest window.
2. **Given** a config where either name's keep-days is below the evidence window, or its keep-newest
   is below the durations floor, **When** it is loaded, **Then** it is refused, naming that package.
3. **Given** versions older than the digest's retention period under both names, **When** the digest
   prunes, **Then** expired versions under both are deleted and younger ones are not.
4. **Given** versions in another repository's package, **When** the digest prunes, **Then** none is
   deleted.

---

### User Story 4 - The runbook says when to drop the legacy name (Priority: P3)

A maintainer reading the CI-diagnostics runbook learns the new package name, how it is derived, that
the legacy name is read during a transition, and the date on which the legacy name can be removed
from the readers, the prune and the retention config.

**Why this priority**: The transition code is temporary. Without a recorded end it becomes permanent
dead weight.

**Independent Test**: Read the runbook: it names the cutover, the earliest drop date (cutover + the
digest's retention period), and the exact places to remove the legacy name.

**Acceptance Scenarios**:

1. **Given** the runbook after this change, **When** a maintainer looks up the bundle package, **Then**
   every command and path shown uses the repo-scoped name, and the legacy name appears only in the
   transition note.

---

### Edge Cases

- No repository identity at all (no runner variable, no parsable `origin` remote): the derivation
  fails loudly. It never silently falls back to the shared legacy name, which would recreate the
  collision.
- Package-search queries match by substring, so a search for `ci-failures` also returns
  `mcm-ci-failures` and `belay-ci-failures`. Every reader and the prune filter by exact name.
- A run's bundle under BOTH names (a run published across the cutover, or a manual re-publish): the
  new name wins on fetch, and the durations sample counts that version once.
- A legacy version not yet expired when the drop date arrives: it is unreachable after the drop. That
  is acceptable only once the retention period has passed, which is why the drop date is cutover + the
  digest's retention period.
- The retention durations floor counts bundle-publishing jobs. That count is unchanged by the rename.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The digest MUST publish each evidence bundle and durations file to the package
  `<repo>-ci-failures`, where `<repo>` is the lowercased repository name.
- **FR-002**: The repository name MUST be derived at run time: from the runner-provided repository
  identity in CI, else from the `origin` remote. It MUST NOT be hard-coded in any script. Failure to
  derive it MUST be an error, never a fallback to the legacy name.
- **FR-003**: The digest MUST NOT write to the legacy `ci-failures` package.
- **FR-004**: The bundle reference and bundle link the digest posts MUST name the repo-scoped package.
- **FR-005**: The digest's age-based prune MUST cover both the repo-scoped and the legacy package, by
  exact name, and MUST NOT delete versions of any other package.
- **FR-006**: `ci-status` MUST list versions from both packages, by exact name, ordered newest first,
  with each version tagged with the package it came from.
- **FR-007**: `ci-status` bundle retrieval MUST try the repo-scoped package first and fall back to the
  legacy package. It reports "absent" only when neither holds the version.
- **FR-008**: `ci-status durations` MUST sample the newest N runs of a job across both packages,
  counting a version present under both names once, and MUST fetch each durations file from the
  package holding that version.
- **FR-009**: The retention config MUST list both packages with the same keep-days and keep-newest
  window.
- **FR-010**: The retention loader's short-window refusal (keep-days at least the evidence window;
  keep-newest at least the durations floor) MUST apply to both packages.
- **FR-011**: Links already posted for legacy versions MUST keep resolving for as long as those
  versions exist. The legacy versions are not renamed, moved or deleted early.
- **FR-012**: The CI-diagnostics runbook, the evidence-pipeline runbook, the bundle-layout contract and
  their wiki summaries MUST describe the repo-scoped name. The runbook MUST record the cutover, the
  earliest legacy drop date (cutover + the digest's retention period), and the places to remove the
  legacy name.
- **FR-013**: The local `$HOME` evidence directories (`mcm-ci-last-failure`, `mcm-ci-step-logs`) MUST
  stay unchanged.

### Key Entities

- **Evidence package**: an owner-level generic package in the forge registry. Its versions are
  `<run id>--<job slug>`, each holding `bundle.json.gz` and, for newer runs, a durations file. It is
  now one per repository (`<repo>-ci-failures`), plus the read-only legacy `ci-failures` during the
  transition.
- **Bundle reference / link**: the `<package>:<version>` string and the registry URL in a digest
  comment. Old ones name the legacy package.
- **Retention entry**: a package's keep window in the committed retention config, held to a floor for
  evidence packages.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After merge, 100% of bundles published by this repository land in `mcm-ci-failures`, and
  0 new versions appear in `ci-failures`.
- **SC-002**: During the transition, every bundle that existed before the cutover and is still inside
  its retention period can be fetched by `ci-status`. 0 runs report "absent" because of the rename.
- **SC-003**: A durations sample taken in the first week after cutover contains the same number of runs
  it would have contained without the rename.
- **SC-004**: The legacy package holds 0 versions no later than cutover + the digest's retention period,
  with no manual deletion.
- **SC-005**: 0 versions of another repository's evidence package are listed, fetched or deleted by
  this repository's tooling.
- **SC-006**: The full script test suite and the affected self-tests pass with no new failures.

## Assumptions

- BELAY never wrote to the legacy `ci-failures` package: it publishes to `belay-ci-failures` from its
  first run. So every legacy version is this repository's, and pruning legacy by age cannot delete
  BELAY evidence.
- The repository's name on the forge is `mcm` (from the `origin` remote), so the package is
  `mcm-ci-failures`.
- The digest's retention period (30 days) is what drains the legacy package. The retention config's
  longer keep-days applies to deletions it makes itself, and does not delay the digest's prune.
- The repository's CI token can already write and delete generic package versions under any name for
  the owner, so creating the new package needs no new credential or permission.
- Removing the legacy name after the drop date is a separate, small follow-up change, recorded in the
  runbook and the backlog, not part of this feature.
