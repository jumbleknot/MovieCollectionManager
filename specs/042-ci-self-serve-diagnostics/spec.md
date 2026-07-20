# Feature Specification: CI Self-Serve Diagnostics

**Feature Branch**: `042-ci-self-serve-diagnostics`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "docs/proposals/PRD-CISelfServeDiagnostics.md — CI Self-Serve Diagnostics (Agent-Readable Failure Digests from the Forge)"

## Clarifications

### Session 2026-07-19

- Q: When multiple jobs fail in one run, how is the evidence bundle keyed? → A: Key the bundle per **run + job**, so each failing job gets its own bundle
- Q: Do failing non-required checks affect the merge verdict? → A: No — the verdict covers **required checks only**; non-required failures are reported separately as **advisory**, clearly marked non-blocking
- Q: What is the evidence retention policy, and what triggers pruning? → A: **Age-based, 30 days**, pruned **opportunistically at publish time** — no new scheduled pipeline
- Q: Should a cancelled/superseded job publish a failure summary? → A: **No** — the write side cross-checks the run's own state before publishing, mirroring FR-014 on the read side
- Q: How is a failure summary reached when there is no pull request to comment on? → A: **From the bundle, located by run + job.** Originally the summary was to be published against the commit as a status whose link resolved to the bundle. Measured 2026-07-20: that publication route requires a broader write permission than the diagnostics credential holds, and granting it would restore most of the privilege deliberately avoided when choosing that credential. Since the published pointer only ever *named* the bundle, and the reader already knows the run and job, it derives the location itself. One fewer moving part, no extra permission.
- Q: Which environments must the read tooling support? → A: The **development container** is the supported environment; the credential is read from an environment variable so other contexts work if it is set, but they are not separately supported or tested

## User Scenarios & Testing *(mandatory)*

The actor throughout is the **AI assistant working a feature branch** (secondarily, the human
operator). Today that actor can see *which* CI job failed but not *why*, so a human must open the CI
web interface, find the failing step, and paste the output into the session — acting as a manual
transport layer. That round-trip is slow, lossy (only what the human thought to copy arrives), and
repeats on every retry.

### User Story 1 - Know the state of a commit without a human (Priority: P1)

The assistant has just pushed a branch and needs to know whether the change is passing, still
running, or broken — and specifically whether the commit is *mergeable*, which depends on a set of
required checks rather than on any single job.

**Why this priority**: This is the highest-frequency question in the operator loop and the
prerequisite for everything else — you cannot ask "why did it fail" until you know something failed.
It is also independently valuable: even with no failure-reason capability at all, replacing the
manual status check removes most of the human round-trips.

**Independent Test**: Query the status of a known commit and confirm the reported per-check results
and the overall mergeable/not-mergeable verdict match what the CI system's own merge gate reports,
with no human transcription involved.

**Acceptance Scenarios**:

1. **Given** a commit whose checks are all complete and passing, **When** the assistant requests its
   status, **Then** each check is listed with its outcome and the commit is reported as satisfying
   the merge requirements.
2. **Given** a commit where a gated check was skipped because its trigger paths were untouched,
   **When** the assistant requests its status, **Then** the skipped check counts as satisfied and the
   commit is reported mergeable — not blocked or pending.
3. **Given** a commit whose checks are still queued behind saturated build capacity, **When** the
   assistant requests its status, **Then** the result is reported as still-running (waiting), not as
   a failure.
4. **Given** a run that was superseded and cancelled by a newer push, **When** the assistant requests
   its status, **Then** the result is reported as superseded, not as a failure — even though the
   underlying check records read as failed.
5. **Given** a commit where a non-required check has failed but all required checks pass, **When** the
   assistant requests its status, **Then** the commit is reported mergeable and the non-required
   failure is still surfaced, distinctly labelled as advisory rather than blocking.
6. **Given** any status query, **When** results are returned, **Then** no raw upstream response is
   emitted wholesale and the private infrastructure host name never appears in the output.

---

### User Story 2 - Read why a job failed, without a human relay (Priority: P2)

A required check has failed. The assistant needs the failing step's identity and enough of its output
— plus the environment evidence already captured on failure — to form a hypothesis, without anyone
opening the CI web interface.

**Why this priority**: This is the feature's core value, but it depends on US1 to locate the failing
job first. Delivered alone it would have nothing to point at.

**Independent Test**: Cause a deliberate failure on a throwaway branch and confirm the assistant can
retrieve the failing step's name and a usable excerpt of its output entirely through the same channel
it already uses to read status.

**Acceptance Scenarios**:

1. **Given** a job that fails in any of the repository's automated check pipelines, **When** the run
   completes, **Then** a failure summary is published that identifies the pipeline, the job, the
   failing step, the commit, and the pull request where one applies.
2. **Given** a failing job whose output is very large, **When** the summary is produced, **Then** the
   included excerpt is drawn from the **end** of the output and is capped in size, because failures
   surface at the end and a beginning-biased excerpt is worthless.
3. **Given** a failing job that captured environment health evidence, **When** the summary is
   produced, **Then** that evidence is included alongside the output excerpt.
4. **Given** a failing job on a pull request, **When** the same job fails again after a retry,
   **Then** the existing summary for that job is replaced in place rather than a new one accumulating
   beside it.
5. **Given** a failing job on a commit with no associated pull request, **When** the summary is
   produced, **Then** it is still published and still reachable by the assistant.
6. **Given** any published summary, **When** it is generated, **Then** all credential-shaped content
   and the private infrastructure host name have been removed before it leaves the build machine.
7. **Given** the summary mechanism itself fails or is misconfigured, **When** the job completes,
   **Then** the job's real pass/fail outcome is unchanged and unmasked.

---

### User Story 3 - Retrieve the complete evidence on demand (Priority: P3)

The summary is deliberately small. For a failure the excerpt does not explain, the assistant needs the
complete captured evidence — full logs, full health records — without escalating to direct access on
the build host.

**Why this priority**: A fallback for the minority of failures the distilled summary cannot resolve.
Valuable, but most diagnoses will end at US2.

**Independent Test**: For a known failure, retrieve the complete evidence set and confirm it contains
material beyond what the summary showed, obtained through the same read channel and credential.

**Acceptance Scenarios**:

1. **Given** a failed run, **When** its complete evidence set is requested, **Then** the full bundle
   is retrieved to local working storage rather than printed into the conversation.
2. **Given** a failed run, **When** its summary is read, **Then** the summary indicates where the
   complete evidence set can be found.
3. **Given** an evidence bundle, **When** it is published, **Then** its size is capped so retrieval
   over the constrained network link stays bounded.

---

### Edge Cases

- **A job dies before the summary step is reached** (build machine crash, malformed pipeline
  definition, or a fault in the summary mechanism itself): nothing is published. This is a knowingly
  accepted limit — see Out of Scope and Assumptions.
- **A run is cancelled by a newer push** while in progress: the check records read as failed for a
  commit that was never broken. Both sides must handle this. On the **read** side it must be
  classified as superseded, not failed (US1 scenario 4). On the **write** side no summary or bundle
  may be published at all (FR-001a) — otherwise a single re-push would upsert noise onto the pull
  request for every cancelled job. The tell is that every job dies together on a change that could
  not have affected them all.
- **The read credential lacks a required permission**: the failure must name the missing permission
  rather than surfacing a bare authorization error, which is otherwise indistinguishable from an
  expired credential and costs a full diagnostic cycle.
- **The build machine's automatic credential lacks publish permission**: the summary cannot be
  published. This must be resolvable as a configuration change, not a redesign.
- **Repeated failures accumulate evidence bundles** indefinitely: storage must be pruned.
- **A very large upstream listing is requested** without correct narrowing: the read must not degrade
  into a multi-megabyte, multi-minute transfer.
- **A job produces no capturable output at all** (e.g. the failure is in the pipeline's own setup):
  the summary must still identify the job and step and state that no output was captured.

## Requirements *(mandatory)*

### Functional Requirements

**Publishing the diagnosis (write side)**

- **FR-001**: Every job in every automated pipeline in the repository MUST publish a failure summary
  when it genuinely fails. Scope is **every pipeline definition, with no exception list** — including
  build and maintenance pipelines, whose failures are exactly as undiagnosable today as a check
  pipeline's, and for which a carve-out would cost more to maintain than the coverage does.
- **FR-001a**: A job belonging to a **cancelled or superseded run** MUST NOT publish a summary or a
  bundle. Because such a job's records read as failed, the write side MUST cross-check the run's own
  state before publishing — the same cross-check FR-014 requires of the read side. The newer run that
  superseded it will publish the authoritative result.
- **FR-002**: The summary MUST identify the pipeline, the job, the failing step, the commit, and the
  pull request where one applies.
- **FR-003**: Included output excerpts MUST be biased toward the end of the output and MUST be capped
  in size per source.
- **FR-004**: The summary MUST include the environment health evidence already captured on failure,
  when present.
- **FR-005**: All summary content MUST pass through the repository's existing credential-redaction
  rules before leaving the build machine.
- **FR-006**: The complete evidence bundle MUST be published to durable storage keyed to the
  **run *and* the job**, so that two jobs failing in the same run each retain their own bundle and
  neither overwrites nor collides with the other. Each job's summary MUST reference its own bundle.
- **FR-007**: For pull-request-triggered failures, the summary MUST be published in place on the pull
  request, keyed per job, so a retry replaces the prior summary instead of stacking a new one.
- **FR-008** *(amended 2026-07-20 — see Clarifications)*: For failures with no associated pull
  request, the summary MUST travel **inside the evidence bundle**, and the reader MUST be able to
  locate that bundle from the run and job alone — without any separately published pointer.
- **FR-009**: The summary mechanism MUST NOT change, mask, or delay a job's real outcome under any
  circumstance, including when the mechanism itself fails.
- **FR-010**: The publish credential MUST be configurable, defaulting to the build system's automatic
  credential with a documented higher-permission alternative, so insufficient permissions are a
  configuration change rather than a redesign.

**Consuming the diagnosis (read side)**

- **FR-011**: The assistant MUST be able to report per-check outcomes and an overall merge verdict for
  a given commit, pull request, or branch, defaulting to the current commit.
- **FR-011a**: The merge verdict MUST be computed over the **required** checks only. A failing
  non-required check MUST NOT make the verdict not-mergeable.
- **FR-011b**: Failing non-required checks MUST still be reported, distinctly labelled as **advisory
  / non-blocking**, so a real regression in them is visible rather than silently dropped.
- **FR-012**: The merge verdict MUST treat a skipped check as satisfied.
- **FR-013**: A still-queued or still-running state MUST be reported as waiting, never as a failure,
  and any polling MUST continue rather than terminate.
- **FR-014**: A cancelled/superseded run MUST be reported as superseded, never as a failure. Because
  the per-check records of a cancelled run read as failed, the run's own state MUST be cross-checked
  before any failure is announced.
- **FR-015**: The assistant MUST be able to retrieve the failure summary for a failing job, and on
  request the complete evidence bundle.
- **FR-016**: Raw upstream responses MUST NOT be emitted to the conversation; they MUST be written to
  local working storage with only a distilled result surfaced.
- **FR-017**: All surfaced output MUST replace the private infrastructure host name with a redacted
  placeholder, by construction rather than by the operator remembering to.
- **FR-018**: Read access MUST use a dedicated **read-only** credential granted only the permissions
  required to read checks, discussions, and stored evidence. It MUST NOT reuse the existing
  write-capable credential the repository already uses for pushing and opening pull requests.
- **FR-019**: The read credential MUST be supplied through the existing environment-passthrough
  mechanism used for other developer-machine secrets; no credential value may enter version control
  and no credential file is introduced.
- **FR-019a**: The **development container is the supported environment** for the read tooling. The
  credential MUST be read from an environment variable, so any other context (host shell, headless
  or scheduled agent) works when that variable is set — but no additional environment is separately
  supported or covered by the test matrix.
- **FR-019b**: When the credential variable is absent, the tooling MUST fail with a message naming
  the variable and how to supply it — consistent with the no-silent-degradation rule in FR-020.
- **FR-020**: When a credential lacks a required permission, tooling MUST fail with the missing
  permission named. Silent degradation and bare authorization errors are prohibited.
- **FR-021**: Stored evidence bundles MUST be retained for **30 days** and then pruned, so storage
  does not grow without bound.
- **FR-021a**: Pruning MUST occur **opportunistically as part of publishing** a new bundle — each
  publish removes bundles past the retention window. No new scheduled pipeline may be introduced for
  this purpose.
- **FR-021b**: A pruning failure MUST NOT fail the publish, and MUST NOT fail the job (per FR-009).

### Non-Functional Requirements

- **NFR-001**: A common-path status lookup MUST complete in under 5 seconds over the constrained
  network link between the development environment and the build system.
- **NFR-002**: Listings MUST be narrowed at the source. The read path MUST NOT fetch an unbounded
  result set and filter afterwards; where the source silently ignores a narrowing option, the
  filtering MUST be applied locally *after* a correctly narrowed fetch.
- **NFR-003**: The complete evidence bundle MUST be capped in size so on-demand retrieval over the
  constrained link stays bounded.

### Key Entities

- **Check run**: One execution of one pipeline against one commit. Has a state (waiting, passed,
  failed, skipped, superseded) and belongs to a commit and optionally a pull request.
- **Merge verdict**: The roll-up over the set of *required* checks for a commit — the actual signal
  that determines whether the change can merge. Not the same as "no job failed": a non-required check
  may fail without changing the verdict, and is reported alongside it as advisory.
- **Failure summary**: A small, redacted, tail-biased description of one failing job: pipeline, job,
  step, commit, pull request, output excerpt, environment health evidence, and a pointer to the
  evidence bundle.
- **Evidence bundle**: The complete captured material for **one failed job** — full logs, full health
  records, test artifacts — stored durably, keyed to the run *and* the job, size-capped and pruned.
  A run with several failing jobs produces several bundles, one per job.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a failing check, the assistant obtains the failing job, step, and a usable output
  excerpt with **zero** human copy-paste steps.
- **SC-002**: **100%** of genuinely failing jobs that reach their summary step publish a retrievable
  summary, across every automated check pipeline in the repository.
- **SC-003**: A status lookup for a commit returns in **under 5 seconds**, and a full diagnosis
  (status → reason) is available in **under 1 minute** — replacing a human round-trip previously
  measured in minutes to hours of waiting for an operator.
- **SC-004**: **Zero** credential values and **zero** occurrences of the private infrastructure host
  name appear in any published summary or any surfaced output, verified against known credential
  shapes.
- **SC-005**: **Zero** job outcomes are changed, masked, or delayed by the diagnostics mechanism,
  including when that mechanism itself fails.
- **SC-006**: The merge verdict classifies **100%** of the four known-tricky states correctly —
  passed, skipped-as-satisfied, waiting-not-failed, and superseded-not-failed.
- **SC-007**: A missing-permission or missing-credential condition produces a message naming what is
  missing in **100%** of cases, never a bare authorization error.
- **SC-008**: Requesting the complete evidence for a failed run succeeds without any new standing
  access to the build host.
- **SC-009**: A run cancelled by a newer push publishes **zero** summaries and **zero** bundles, so a
  rapid re-push adds no noise to the pull request.
- **SC-010**: Two jobs failing in the same run yield **two** independently retrievable evidence
  bundles, with neither overwriting the other.
- **SC-011**: A failing non-required check leaves the merge verdict mergeable while still being
  surfaced as advisory — **zero** false "blocked" reports and **zero** silently dropped regressions.

## Out of Scope

- Replacing the CI web interface for human use.
- Any new standing direct access (e.g. shell access) to the build host.
- Diagnosing failures that occur *before* the summary step is reached — see Assumptions.
- Log shipping or a general observability platform; the existing observability and audit stacks are
  unaffected.
- Any change to the merge gate, branch protection, or the set of required checks.
- Changing the build system itself to expose new capabilities.

## Assumptions

- **The build system exposes no log or artifact read capability**, and this is by design in the
  version in use. The design therefore inverts direction: the pipeline *pushes* a curated summary into
  a channel that is already readable, rather than the assistant *pulling* logs. This was measured, not
  assumed.
- **The existing write-capable credential is insufficient for the read side.** It was verified to be
  scoped narrowly enough that it can read checks but cannot read discussions or stored evidence — so
  a separate, strictly *lower*-privilege read-only credential is required. This reverses an earlier
  assumption and is the single most consequential finding behind FR-018.
- **The build system's automatic credential's publish permissions cannot be observed from outside a
  running job** and remain unverified. FR-010 de-risks this by making the credential configurable;
  it is confirmed on first real run rather than resolved on paper.
- **Failures occurring before the summary step are not covered.** Direct build-host access was the
  only design covering that class and was knowingly rejected as widening the security posture for a
  rare failure class. Such failures are usually self-evident from the run's own state, and the
  existing out-of-band procedure remains documented as the fallback.
- **Evidence retention is 30 days** (decided — see Clarifications), matching the repository's existing
  general log-retention standard. Pruning is opportunistic at publish time, so no new scheduled
  pipeline is introduced. A consequence worth stating: if failures stop entirely, expired bundles
  linger until the next failure publishes — accepted, since the storage floor is bounded by the same
  cap that bounds each bundle.
- **Excerpt and bundle size caps require real-world calibration** against a large end-to-end test
  failure. They are bounded from two directions — the assistant's context budget and the constrained
  network link — and initial values are expected to be tuned after first use.
- **The network link between the development environment and the build system is slow and constrained**
  (~1 Mbit/s effective, measured), making transfer size a latency constraint and not merely a context
  one. This is why NFR-002 is a requirement rather than an optimization.
- **The existing on-failure environment-evidence capture is already in place** and is a dependency,
  not something this feature introduces.
- **The redaction rules this feature reuses already exist** in the repository and are already enforced
  by automated checks.
