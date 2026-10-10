# Feature Specification: Major dependency upgrades

**Feature Branch**: `081-major-dependency-upgrades`

**Created**: 2026-10-10

**Status**: Draft

**Input**: Backlog item #254 — "Major dependency updates: the order, and why Expo/RN 57 comes before
jest/babel/TS", including its 2026-08-27 correction comment. Operator decision (2026-10-10): **one**
specification covers **all eight** stages of that item; each stage is its own user story and its own pull
request, in order; no stage is silently dropped or deferred to "a later spec". The item's statement that
the mobile-platform SDK stage would get its own specification is overridden — it is a user story here.

## Overview

The repository runs on a set of third-party components — the CI building blocks, the package manager, the
monorepo task runner, the mobile/web application platform, the test and language toolchain, the
server-side web framework and session store client, the assistant transport libraries, the datastore
images, and the backend's data-format and HTTP libraries. For each of these a new **major** version has
been published, and the automated dependency bot proposes them every week. A major version can break the
build, the tests, the running product, or stored data; it cannot be made safe by configuration alone.

Left unmanaged, these proposals arrive red every week, crowd routine security patches out of the bot's
weekly budget, and invite a stateful migration to be waved through because a gate went green that never
exercised it. Taken in the wrong order, the same work is done twice: several of these components are
hard-locked to the mobile platform's release line and cannot move until it does.

This feature brings every one of those majors to a decided end state — **upgraded**, or **held with a
measured, recorded reason and a re-check rule** — in an order that keeps every failure attributable to
one change, and without losing stored user data.

### The order, and why

1. **CI building blocks** — everything else is verified by CI, so CI moves first, in two halves.
2. **Package manager** — the next two stages each rewrite the dependency lock wholesale; doing this first
   means each of them happens once, under the final package manager.
3. **Monorepo task runner** — with its plugins.
4. **Mobile/web application platform SDK** — the release line that pins the test toolchain.
5. **Test, lint and language toolchain** — what the platform no longer pins moves; what it still pins is
   recorded as blocked.
6. **Server-side web framework + session store client** — request and session paths.
7. **Assistant transport** — the client/runtime libraries for the conversational assistant.
8. **Datastore images** — stateful; each is a data migration.
9. **Backend data-format and HTTP libraries** — last, because the data-format move depends on the
   datastore driver and on stage 8 having settled the server.

### What this feature deliberately does not do

- It does **not** upgrade anything routine (patch or minor) that the bot already handles on its weekly
  schedule.
- It does **not** take a pre-release. Where the next platform release exists only as a release candidate,
  this feature records what it would change and stops.
- It does **not** widen a security floor's version range to admit a new major of a transitive dependency.
  Those five proposals are rejected and made not to recur (US5).
- It does **not** lift a security-motivated hold because a newer version exists. A held image moves only
  when a scan with the gate's own criteria shows it is no worse.

## Clarifications

### Session 2026-10-10 (operator, via the coordinating session)

- Q: One spec or one per stage? → A: One spec, all eight stages, each its own user story and PR, in order.
- Q: Does the platform SDK stage get its own spec, as item #254 said? → A: No — it is a user story here.
- Q: Spec number? → A: 081 (080 is a parallel object-storage migration).

## User Scenarios & Testing *(mandatory)*

The "user" of every story is the **maintainer** of this repository (and the coding assistant acting for
them). Each story is independently mergeable and leaves `main` releasable.

### User Story 1 - CI building blocks on current majors (Priority: P1)

The maintainer moves the eight CI building blocks to their current majors in **two** pull requests —
the three that every job uses, then the remaining five — so that a red run names one half.

**Why this priority**: Every other story is proven by CI. A CI change landing underneath any of them
would make that story's red ambiguous.

**Independent Test**: The required CI contexts pass on each PR with the job logs showing the new major
actually executed (not skipped); a deliberate probe shows which majors the runner supports.

**Acceptance Scenarios**:

1. **Given** the parallel object-storage migration (feature 080) has merged, **When** the first half
   lands, **Then** every workflow job that checks out code, sets up the runtime, or uploads an artifact
   runs on the new majors and all required contexts pass.
2. **Given** a building block the runner cannot execute at its new major, **When** this is measured,
   **Then** that block is held at its current major by a recorded bot rule whose text names the measured
   error, and the bot stops proposing it.
3. **Given** the second half lands, **Then** a path-filtered job that SHOULD run on a relevant change is
   shown to run (not skip), so a filter regression cannot read as a pass.
4. **Given** the CI building block that installs the Android JDK also carries a JDK major, **Then** the JDK
   major is NOT moved in this story; it is decided in US4 against the platform SDK's requirements.

---

### User Story 2 - Package manager on its current major (Priority: P1)

The maintainer moves the package manager to its next major, against a quiet lock, with every security
override still in force.

**Why this priority**: Two later stories rewrite the lock wholesale; doing this first means each rewrite
happens once.

**Independent Test**: A cold, frozen install succeeds in CI and in every container build; every
security-floored transitive resolves to the same version (or higher within its major) as before.

**Acceptance Scenarios**:

1. **Given** no open bot PR and not inside the bot's weekly window, **When** the package manager major
   lands, **Then** all required contexts pass and every container image builds with a frozen install.
2. **Given** the workspace settings file, **When** the new major reads it, **Then** every setting is
   recognised — none is ignored and none fails the install.
3. **Given** the 14 version overrides, **When** the lock is regenerated, **Then** each overridden package
   still resolves inside its patched range.

---

### User Story 3 - Monorepo task runner and its plugins on current majors (Priority: P1)

The maintainer moves the language plugins first, then the task runner, so that every build/test/lint
target across Rust, Python and TypeScript still runs through the task runner.

**Why this priority**: Every test tier is invoked through the task runner; it must be current before the
platform SDK move relies on it.

**Independent Test**: Every project's targets resolve and run; the affected-project computation on CI
still selects the right projects.

**Acceptance Scenarios**:

1. **Given** the plugins at their new majors on the current runner, **Then** the Rust and Python projects'
   test and lint targets run and pass.
2. **Given** the task runner at its new major, **Then** the two places that pin its version agree, every
   project graph resolves, and all required contexts pass.
3. **Given** a plugin with no release for the new runner major, **Then** it is shown to still load and run,
   or the story stops with that measured fact recorded.

---

### User Story 4 - Mobile/web platform SDK 56 → 57 (Priority: P1)

The maintainer moves the application platform SDK and its native runtime to the current stable release
line, through the platform's own upgrade tooling, on web and Android.

**Why this priority**: It is a full major behind the current stable release, and it pins the test
toolchain; until it moves, US5 is constrained by it.

**Independent Test**: The web E2E regression and the Android mobile flows pass on the new SDK; the
platform's own dependency check reports no mismatches.

**Acceptance Scenarios**:

1. **Given** a quiet lock, **When** the SDK upgrade lands, **Then** every platform-companion package sits at
   the version the SDK declares, and the platform's dependency check is clean.
2. **Given** the new native runtime, **Then** typecheck reports no new errors — in particular none of the
   press-event narrowing measured on PR #217 (that narrowing belongs to a later runtime line).
3. **Given** an Android build, **Then** it builds with the JDK the SDK's template requires, and the mobile
   flows pass on an emulator with hardware virtualisation.
4. **Given** the two supply-chain allowlist entries that ride on the platform tooling (items #633, #648),
   **Then** a fresh audit shows whether the upgrade discharged them; if it did not, they still match their
   exact pinned versions and nothing is re-dated.
5. **Given** the project's governing constitution names the SDK version, **Then** it is amended in the same
   change with human approval.

---

### User Story 5 - Test, lint and language toolchain: move what is free, record what is blocked (Priority: P2)

The maintainer stops the five security-override range proposals for good, moves the lint toolchain and
the component-test library to their current majors, and records each still-blocked toolchain major with a
measured reason and a re-check rule — so the bot stops proposing what cannot land.

**Why this priority**: Re-scoped after US4 as item #254 requires; much of it is gated by US4 and by the
lint toolchain.

**Independent Test**: Lint and unit tiers pass on the new lint major; the bot's resolved configuration no
longer proposes the blocked majors or the override-range widenings; a guard fails if an override's range
is widened past its major.

**Acceptance Scenarios**:

1. **Given** a proposal that widens a security override's upper bound into a new major, **When** it is
   presented, **Then** a guard rejects it and the bot does not propose it again; a genuine floor raise
   is still proposable.
2. **Given** the lint toolchain at its new major, **Then** both TypeScript projects lint clean with no
   warnings, under the new configuration format.
3. **Given** a toolchain major that the platform SDK or the lint toolchain still pins below (test runner,
   transpiler, language compiler, async storage), **Then** it is held behind an explicit approval, and its
   re-check rule names the exact upstream fact that would release it.

---

### User Story 6 - Server web framework and session store client on current majors (Priority: P2)

The maintainer moves the server-side web framework and its type definitions together, and the session
store client, without changing authentication, session or eviction behaviour.

**Why this priority**: These sit on the request and session paths; their failures are security-relevant.

**Independent Test**: Integration and E2E tiers covering login, session lifetime and concurrent-session
eviction pass.

**Acceptance Scenarios**:

1. **Given** the new framework major, **Then** every server route still matches the same paths, rejects
   the same malformed input, and returns the same problem responses.
2. **Given** the new session-store client major, **Then** idle/absolute timeouts and the concurrent-session
   cap evict exactly as before.

---

### User Story 7 - Assistant transport libraries on current releases (Priority: P2)

The maintainer moves the assistant runtime/client library and its event-protocol client together, then
the model-SDK packages the runtime needs at load time, with verification stronger than the merge gate
alone.

**Why this priority**: The tier that would catch a model-behaviour regression does not block merges, so a
green gate proves less here than elsewhere.

**Independent Test**: The blocking assistant E2E tier passes; the non-blocking model-decision tier, run on
the branch on demand, shows no new failures against `main`; the production server image loads the
assistant route.

**Acceptance Scenarios**:

1. **Given** the runtime and client libraries pin an exact protocol-client version, **Then** they move as
   one change and the app's direct pin matches theirs.
2. **Given** model-SDK packages that exist only to satisfy the runtime's load-time imports, **Then** each is
   either moved or — if no longer needed — removed, and the production image still loads the route.
3. **Given** the non-blocking model-decision tier, **Then** it is run on the branch and its failures are no
   worse than `main`'s most recent run.

---

### User Story 8 - Datastore images: decided, with stored data preserved (Priority: P3)

The maintainer moves the document-database image to its next major with user data preserved, decides the
shared observability relational-database pin as one change for both its consumers, and re-tests the
security-held secrets-store image.

**Why this priority**: Stateful and high-blast-radius; it waits until everything above is settled so that
its red is only ever about data.

**Independent Test**: Before/after document counts match exactly on every preserved store; rollback is
rehearsed; the infra-image scan passes.

**Acceptance Scenarios**:

1. **Given** the document-database major, **When** it lands in local and production stacks, **Then** every
   collection's document count is identical before and after, both drivers connect, and a rollback was
   rehearsed by restore.
2. **Given** the shared observability relational-database pin, **Then** both consumers move together or
   neither does, the guard asserting the shared pin is updated at its cause, and the consumer whose state
   must survive is restored and verified.
3. **Given** the security-held secrets-store image, **Then** it moves only if a scan with the gate's own
   criteria shows it no worse than the current one; otherwise the hold is re-recorded with the new
   evidence.

---

### User Story 9 - Backend data-format and HTTP libraries (Priority: P3)

The maintainer moves the backend's document data-format library to its next major through the datastore
driver's supported switch, and re-checks the two approval-gated libraries against their upstream blockers.

**Why this priority**: Last — it depends on US8's server and on upstream crates that do not yet support
the new versions.

**Independent Test**: The backend's unit and integration tiers, and the full E2E regression, pass; the
release binary's linkage is unchanged.

**Acceptance Scenarios**:

1. **Given** the data-format library at its next major, **Then** every stored document round-trips
   unchanged and the backend's integration tier passes against the US8 server.
2. **Given** an approval-gated library whose upstream dependents still require the old version, **Then** it
   is not moved (which would only duplicate it), and a backlog item records the blocker and its re-check
   rule.
3. **Given** any change to the HTTP library, **Then** the statically-linked release build is shown to link
   the same TLS stack as before.

### Edge Cases

- **A bot PR opens mid-stage** for a lockfile-wholesale story (US2, US3, US4): the stage pauses; it is
  rebased only after that PR merges or closes, never run concurrently.
- **The bot's weekly window arrives** while a lockfile-wholesale stage is open: the stage must not be open
  inside the window; it is started on a non-Friday or the window's run is waited out.
- **A fresh transitive dependency younger than the package manager's release-age policy** makes a
  whole-board red: treated per the install-first triage — wait it out, never exclude it.
- **The SDK's next release becomes stable mid-feature**: US4 stays on the release line measured at its
  start unless the operator chooses otherwise (OQ-1); US5's re-check rule then fires.
- **A held item's blocker clears mid-feature**: the hold is lifted inside its story, not left for later.
- **An upgrade discharges an allowlist entry**: the entry is deleted in the same change, never left to
  expire.
- **An upgrade changes a security-override's resolution**: the change is reviewed as a security change.

## Requirements *(mandatory)*

### Functional Requirements

**Ordering and isolation**

- **FR-001**: The stories MUST land in the order US1 → US2 → US3 → US4 → US5 → US6 → US7 → US8 → US9, each as
  its own pull request (US1 as two; US7 as two; US8 as one per datastore image; US9 as one per library
  family).
- **FR-002**: US1 MUST NOT start until feature 080 has merged.
- **FR-003**: Each lockfile-wholesale story (US2, US3, US4) MUST start only against a merged, quiet lock: no
  open bot pull request, not inside the bot's weekly window, and no other lockfile-wholesale story open.
  The quiet state MUST be recorded (time and evidence) in the PR description.
- **FR-004**: No two lockfile-wholesale stories may be open at the same time.

**Outcomes**

- **FR-005**: Every major pending on 2026-10-10 (research R1) MUST end in exactly one of: **upgraded**, or
  **held** with (a) the measured reason, (b) the upstream fact that would release it, and (c) a bot rule
  that keeps it off the weekly budget. No pending major may be left with neither.
- **FR-006**: A held major MUST have its own backlog item (created during implementation) carrying the
  reason and re-check rule, so item #254 can close with nothing silently outstanding.
- **FR-007**: The five security-override range proposals MUST be rejected, and a guard MUST fail when any
  keyed override's version cap admits a major beyond the one its key names.

**Verification**

- **FR-008**: Each story MUST run the test tiers its diff touches (derived per story in plan.md), plus the
  full web E2E regression; a skipped suite MUST be treated as a failure (skip-escalation flags set).
- **FR-009**: US4 MUST verify Android on an emulator with hardware virtualisation, in addition to web.
- **FR-010**: US7 MUST run the non-blocking model-decision tier on its branch and compare to `main`, and
  MUST load the assistant route in the production server image.
- **FR-011**: US8 MUST preserve user data in the document database: document counts per collection
  identical before and after, verified on the production store, with a rehearsed restore as rollback.
- **FR-012**: US8's observability relational-database change MUST move both consumers together and update
  the shared-pin guard at its cause; it MUST NOT delete the guard.
- **FR-013**: A held image MUST only move on a scan, with the gate's own criteria, showing it no worse.
- **FR-014**: US9 MUST show the statically-linked release build's TLS linkage is unchanged.

**Governance**

- **FR-015**: Where the governing constitution names a version this feature changes (the platform SDK and
  native runtime; the document database image), it MUST be amended in the same PR, with human approval.
- **FR-016**: The toolchain majors held on the platform SDK MUST carry the re-check rule *"re-read the SDK's
  test-preset and transpiler-preset companion metadata at each new SDK"*; the language-compiler major
  MUST carry *"re-read the lint parser's supported compiler range"*.
- **FR-017**: Each story's PR MUST state its rollback and its exit criterion (plan.md, per story).
- **FR-018**: An allowlist entry an upgrade discharges MUST be deleted in that change; one it does not
  discharge MUST be shown still to match its exact pinned version.

### Key Entities

- **Pending major**: a dependency with a new major available; attributes — current version, target,
  where it is declared, which story owns it, outcome (upgraded / held).
- **Hold**: a recorded decision not to move; attributes — measured reason, release condition, the bot
  rule enforcing it, its backlog item.
- **Quiet lock**: the state in which a lockfile-wholesale stage may start (no open bot PR, outside the
  window, no other wholesale stage open).
- **Stage PR**: one pull request per story (or half-story); attributes — tiers run, rollback, exit
  criterion, quiet-lock evidence where applicable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

These restate item #254's acceptance criteria as measurable outcomes, plus what this spec adds.

- **SC-001** (item #254 AC1): Every one of the eight stages — and the two majors the item did not list
  (package manager, assistant runtime) — is either landed or has its own backlog item with a recorded
  reason; the count of pending majors from research R1 with neither outcome is **zero**. Item #254 closes
  only then.
- **SC-002** (item #254 AC2): US2, US3 and US4 each record quiet-lock evidence showing **zero** open bot
  PRs at start, and no two of them overlap in time.
- **SC-003** (item #254 AC3): US5's scope is re-derived from the metadata of the SDK US4 landed, not
  carried forward from item #254's list — evidenced by the companion-metadata read recorded in its PR.
- **SC-004**: After US5, the bot's weekly "major" proposals contain **none** of the held majors and none of
  the five override-range widenings.
- **SC-005**: Zero data loss — every preserved store's per-collection document counts match before/after.
- **SC-006**: Every story's PR passes all required CI contexts with **zero** skipped required suites, and the
  full web E2E regression passes on each.
- **SC-007**: No security floor is lowered and no allowlist entry is re-dated as a side effect of any story.

## Assumptions

- The repository's single CI runner and its ~35-minute E2E job make one PR per story the right
  granularity (PR batching rule: split when a red would otherwise be ambiguous).
- The platform's current stable SDK is 57 (research R4); its next release is a release candidate.
- The document database's production data must be preserved; there is no acceptable wipe.
- The observability traces may be discarded per ADR-0002 §4; the feature-flag store's state may not
  (to be confirmed — OQ-3).

## Dependencies

- Feature 080 (object-storage migration) must merge before US1 (it rewrites the same workflow files).
- A parallel PR moving the observability trace service within its current major does not block anything
  here, but US8's relational-database PR must start after it merges (same compose files).
- Android verification requires the hardware-virtualisation-capable dev container, not the sandbox VM.

## Out of Scope

- Routine patch/minor updates; the next SDK's release candidate; any change to product behaviour.

## Open Questions (for the operator)

- **OQ-1**: If SDK 58 becomes stable before US4 starts, take 57 as specified or go straight to 58 (which
  brings the press-event narrowing of PR #217 into scope and forces the test-runner major with it)?
- **OQ-2**: The two approval-gated backend libraries (US9) and the toolchain majors still pinned by the
  platform or the lint toolchain (US5) are blocked upstream today — accept "held with its own backlog
  item and re-check rule" as their end state if the blockers still stand when their story runs, as item
  #254's acceptance criterion permits?
- **OQ-3**: In the shared observability relational-database move, is the feature-flag store's state to be
  preserved (assumed yes) and the trace store's discarded (ADR-0002 §4), or both preserved?
- **OQ-4**: The secrets-store image is dormant: if its scan is still worse, is a re-recorded hold acceptable
  as the end state for that part of US8?
