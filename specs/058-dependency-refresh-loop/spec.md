# Feature Specification: close the dependency-refresh gaps 057 left open

**Feature Branch**: `058-dependency-refresh-loop`

**Created**: 2026-08-13

**Status**: Draft

**Input**: Close the two gaps feature 057 deliberately left open — backlog item #186 (a lockfile /
override-floor pull request skips `app-e2e`, the only tier that catches a bad transitive floor) and
backlog item #184 (the dependency bot proposes nothing when an override range already permits a
published fix, because the lockfile is stale).

## Context

Feature 057 restored the dependency-security maintenance loop: it fixed the bot's runtime, widened
the schedule window so routine updates are actually proposed, remediated two expiring acceptances,
and shipped `check-override-consistency.mjs` to stop a half-remediated override merging. It closed
four faults and **deliberately deferred two**, which are what this feature is for.

### The two gaps, and why they are one feature

They are coupled, and the coupling runs one way:

- **#184** is fixed primarily by turning on a scheduled lockfile refresh, which produces a routine
  pull request whose entire content is a regenerated `pnpm-lock.yaml`.
- **#186** is the fact that a pull request whose content is a regenerated `pnpm-lock.yaml` **skips
  the only test tier that can catch what such a change breaks**.

Fix #184 alone and the repository starts shipping weekly dependency refreshes that nothing
end-to-end tests. So #186's remedy must be in force before #184's remedy can produce its first pull
request. A single change satisfies that ordering, because the filter takes effect the moment it
merges and the bot can only act on a later scheduled run — but the ordering is a requirement of this
feature, not an accident of how it is packaged.

### The measured fault behind #184

The fault is **not** the one the item was originally filed against. It was filed as "the bot rewrites
an override's value and cannot rewrite its vulnerable-range key" — a real defect, but second-order.
The item's own follow-up comment corrects the premise, and the correction is what this feature
addresses. Reproduced twice in one afternoon, on different packages:

|                       | `fast-uri`            | `nanoid`              |
| --------------------- | --------------------- | --------------------- |
| Override permitted    | `>=3.1.4 <4`          | `>=3.3.17 <4`         |
| Lockfile pinned       | 3.1.4 (vulnerable)    | 3.3.17 (vulnerable)   |
| Fix published         | 3.1.5 on 2026-07-31   | 3.3.18 on 2026-08-07  |
| Advisory published    | 2026-08-03 (**after**)| ~2026-08-13           |
| Outcome               | gate red for 10 days  | `main` went red       |

In both cases **the override range already permitted the fix and nothing applied it**. The blocker
was a stale lockfile, not the override. A four-week acceptance was written for `fast-uri` — for
something a lockfile refresh would have cleared.

Nothing proposed a fix, and structurally nothing could:

1. The bot proposes only when the current range does **not** satisfy the newest version. `>=3.1.5 <4`
   satisfies every 3.x, so there is nothing to propose. Confirmed by what the dependency dashboard
   actually lists for override entries: all five pending updates are *upper*-bound widenings
   (`<4`→`<5`, `<7`→`<9`), never floor raises.
2. The bot reasons about the **manifest range**, not the lockfile resolution. An override whose range
   permits the fix looks already-fixed to it while the lockfile stays vulnerable.
3. Scheduled lockfile maintenance is disabled — the upstream recommended default, never overridden
   here — so nothing refreshes the lockfile on a schedule either.

### The class is live on `main` today

This is not a historical incident to be reconstructed synthetically. Measured 2026-08-13 against the
current `main`, two packages are in exactly the `fast-uri` state right now:

| Package             | Override permits      | Lockfile pinned | Fix available | Advisories        |
| ------------------- | --------------------- | --------------- | ------------- | ----------------- |
| `hono`              | `>=4.12.25` (no upper)| **4.12.29**     | `>=4.12.34`   | 4 (runtime scope) |
| `undici` (6.x tree) | `>=6.27.0 <7`         | **6.27.0**      | `>=6.28.0`    | 3 (runtime scope) |

Both are runtime-scope. They are non-blocking today only because their severities are Medium/Low —
which is precisely the state `fast-uri` was in before its advisory landed and turned it into a
ten-day red. Nothing in the repository currently says a word about either.

### The #186 gap, precisely

- `pnpm-lock.yaml` **is** in the `push:` paths filter, with the comment *"a lockfile bump changes
  transitive deps → rebuild the affected images"*. A merge to `main` therefore re-runs the suite.
- It is **not** in the change-detection filter that gates the end-to-end suite on a **pull request**.
  Neither is `pnpm-workspace.yaml`. The two filters disagree about whether a lockfile change is
  app-affecting: the risk is acknowledged for `push` and denied for `pull_request`.
- The skip is currently **deliberate**, and the file says so. This feature argues against a
  considered decision, on two grounds that did not hold when it was taken: 057's FR-013 established
  that the end-to-end tier is the only one that catches a bad floor (these are JS-toolchain
  transitives, so breakage surfaces at build time and the unit tier passes straight over it), and 057
  restored a bot that will now open exactly these pull requests weekly. The volume of the untested
  class goes from approximately zero to weekly.
- Demonstrated twice: the end-to-end suite reported `skipped` on both PR #185 and PR #187.

### What this feature must not do

- **Must not weaken `check-override-consistency.mjs`.** It guards the key/value lockstep on every
  keyed override and passes today on 11 keyed floors. Nothing here may relax it to accommodate a
  refresh mechanism; if the two conflict, the guard wins.
- **Must not change what fails the security gate.** Making the gate's message name the remediation
  lever is a *message* change. Turning "an override exists whose range already permits the fix" into
  a second, orthogonal blocking axis alongside severity and scope is a policy change that would red
  `main` on merge for findings the existing policy classifies as non-blocking. Out of scope here.
- **Must not add a second manager over `pnpm-workspace.yaml`.** 057 evaluated and rejected it on
  measured grounds: the file is already extracted by the built-in manager, so a second one
  double-manages it, and doing it properly means suppressing the built-in manager for that file,
  which also drops three other extractions.
- **Must not add the emulator half to dependency pull requests.** The mobile flows are a strict
  subset carrying roughly 35 minutes of the run on a single runner, and a lockfile change is a
  web/bundle risk.

### Scope note on SDD

This feature touches CI workflow definitions, bot configuration and repository scripts — all outside
the directories the spec-driven-development gate governs. The lifecycle is run **by choice**, as
feature 057 did, because the change reverses a documented decision and needs its reasoning recorded
where the next reader will find it.

## Clarifications

### Session 2026-08-13

- Q: Which of #184's five options should the decision record? → A: Options **4 and 5** together for
  the stale-lockfile fault (enable scheduled lockfile maintenance, and make the security gate name
  the remediation lever); option **1** (accept manual repair) recorded for the separate half-bump
  fault, whose guard already blocks anything unsafe from merging.
- Q: What CI cost is accepted for #186? → A: Option **2** — add the lockfile and workspace manifest
  to the `app` change filter but **not** to `mobile`, so a dependency pull request pays for the web
  and integration tiers but not the emulator half.
- Q: What cadence for scheduled lockfile maintenance, given the bot's throttles? → A: The **same
  weekly window** as routine updates, sharing the existing throttles. A refresh that is crowded out
  defers by a week; the nightly schedule-exempt security run still handles urgent advisories.
- Q: Should the gate's new advice appear for non-blocking findings? → A: **Yes.** The advice's value
  is as an early signal — the two live cases are non-blocking today, and blocking-only advice would
  first appear at the moment the finding is already reddening every branch.
- Q: Should the new advice change the gate's exit code? → A: **No.** The gate's contract stays
  exactly "fail on an un-allowlisted blocking finding".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A dependency pull request is tested by the tier that can catch a bad floor (Priority: P1)

A pull request whose only content is a regenerated lockfile runs the end-to-end tier, so a transitive
dependency floor that breaks the application build is caught before merge instead of after.

**Why this priority**: This is the ordering constraint. Until it holds, turning on scheduled refreshes
ships weekly changes that nothing end-to-end tests. It also stands on its own: the untested class
already exists, it is merely about to get larger.

**Independent Test**: Open a pull request that touches only `pnpm-lock.yaml` and observe the
end-to-end job's reported status. Delivers value with no other part of this feature present.

**Acceptance Scenarios**:

1. **Given** a pull request whose only changed file is `pnpm-lock.yaml`, **When** the app CI workflow
   runs, **Then** the end-to-end job reports a real result rather than `skipped`.
2. **Given** the same pull request, **When** the end-to-end job runs, **Then** the emulator-gated
   steps do not run, because the mobile filter does not select the lockfile.
3. **Given** a pull request that touches only `pnpm-workspace.yaml`'s override map, **When** the
   workflow runs, **Then** the end-to-end job likewise reports a real result.
4. **Given** the workflow definition, **When** its two filters are compared, **Then** the pull-request
   filter and the push paths filter agree about the lockfile and the workspace manifest.
5. **Given** someone later removes the end-to-end job's dependency on the change filter, **When** the
   test suite runs, **Then** it fails by name, because a passing job cannot otherwise be
   distinguished from an absent one on this forge.

---

### User Story 2 - The lockfile refreshes itself on a schedule (Priority: P1)

A transitive fix that an existing override range already permits gets picked up automatically, within
a week, without anyone noticing the advisory first.

**Why this priority**: This is the direct remedy for the measured incident. Both `fast-uri` and
`nanoid` would have been cleared by it with no configuration change and no human in the loop.

**Independent Test**: Confirm the bot's configuration declares scheduled lockfile maintenance with a
window that intersects the workflow's trigger under both daylight-saving offsets, then observe the
first scheduled run after merge producing a refresh proposal.

**Acceptance Scenarios**:

1. **Given** the bot's configuration, **When** scheduled lockfile maintenance is enabled, **Then** it
   carries its **own explicit** permitted window rather than inheriting one.
2. **Given** that explicit window and the workflow's weekly trigger, **When** the two are compared
   under both standard and daylight offsets, **Then** they intersect under both.
3. **Given** the configuration, **When** it is validated against the pinned major version of the bot,
   **Then** validation passes.
4. **Given** the first scheduled run after merge, **When** it completes, **Then** a lockfile-refresh
   proposal exists.

---

### User Story 3 - The security gate names the remediation lever (Priority: P2)

When a finding's package already carries an override whose range permits the published fix, the gate
says so and names the one-command remedy, instead of leaving the reader to work out whether to raise
a floor or refresh a lockfile.

**Why this priority**: It is the safety net for what scheduled refreshes miss, and the early signal
for cases that are not yet blocking. It would have turned a ten-day red into a one-line fix. It
depends on nothing else in this feature.

**Independent Test**: Run the gate against a finding set reconstructing the `fast-uri` case and
confirm the advice names the range, the pinned version and the refresh command.

**Acceptance Scenarios**:

1. **Given** a finding whose package has an override whose range **already permits** the fixed
   version, **When** the gate reports, **Then** it states the permitting range, the version the
   lockfile pins, and that a lockfile refresh is the remedy.
2. **Given** a finding whose package has an override whose range does **not** permit the fixed
   version, **When** the gate reports, **Then** it states that the floor must be raised and names
   **both halves** that must move together.
3. **Given** a finding whose package has no override at all, **When** the gate reports, **Then** no
   lever advice is emitted for it.
4. **Given** a non-blocking finding in the first state, **When** the gate reports, **Then** the advice
   is still emitted.
5. **Given** any set of findings, **When** the gate runs, **Then** its exit code is determined solely
   by un-allowlisted blocking findings, exactly as before this feature.
6. **Given** the current repository state, **When** the gate runs, **Then** the two live cases are
   named.

---

### User Story 4 - The deferred decision and the corrected premise are on the record (Priority: P3)

A reader who finds a half-bumped override proposal, or who reads that the bot extracts no
dependencies from the workspace manifest, finds the measured truth instead of a stale claim.

**Why this priority**: Documentation of decisions already taken. It changes no behaviour, but a wrong
premise left in the record is what produced the original mis-filing of #184.

**Independent Test**: Read the configuration's rationale and the affected documents; confirm the two
faults are distinguished and the superseded claim is corrected wherever it survives.

**Acceptance Scenarios**:

1. **Given** the bot's configuration rationale, **When** it is read, **Then** it distinguishes the
   half-bump fault from the stale-lockfile fault and records the accepted decision for each.
2. **Given** any document still asserting the bot extracts zero dependencies from the workspace
   manifest, **When** it is read, **Then** it carries a dated correction.

---

### Edge Cases

- **A refresh proposal is crowded out by the throttles.** The window admits roughly two proposals per
  run. An accepted consequence: the refresh defers a week. Urgent advisories are unaffected, because
  the nightly run is schedule-exempt for security proposals.
- **A refresh proposal breaks the application build.** This is the case User Story 1 exists for: the
  end-to-end tier now runs on it and the proposal arrives red rather than merging untested.
- **An override range does not permit the fix.** The advice must say "raise the floor" and name both
  halves, not silently recommend a refresh that cannot help.
- **A package resolves to more than one version.** `undici` resolves at both 6.27.0 and 7.24.7, and
  the override governs only the 6.x tree. Advice must be per-resolution, not per-package, or it will
  recommend a refresh for a resolution the override does not reach.
- **A plain pin with no range half.** Three overrides are plain pins with no vulnerable-range key.
  They must not be parsed as keyed floors, and must not produce spurious advice.
- **An unparseable fix range or override value.** The advice is an aid, not a gate: when either half
  cannot be parsed, no advice is emitted for that finding and the gate's result is unaffected.
- **The end-to-end job's gate is later rewired.** A green job cannot distinguish "filter matched"
  from "filter deleted, job ran anyway" on this forge, because it exposes no step or log endpoint.
  The wiring must therefore be asserted directly.

## Requirements *(mandatory)*

### Functional Requirements

#### Change detection (#186)

- **FR-001**: The change-detection filter that gates the end-to-end suite on a pull request MUST
  select `pnpm-lock.yaml`.
- **FR-002**: That same filter MUST select `pnpm-workspace.yaml`.
- **FR-003**: The mobile sub-filter MUST NOT select either file, so a dependency pull request does not
  pay for the emulator half.
- **FR-004**: The mobile sub-filter MUST be a strict subset of the app filter. This was asserted in a
  comment and enforced nowhere — **and the comment was false**. Found while writing the guard test
  (2026-08-13): `scripts/ci-mobile-agent-flows.sh` and `scripts/maestro-run.sh` were in `mobile` and
  not in `app`, which makes them **inert**, because the mobile filter gates only steps *inside* the
  end-to-end job and that job itself requires the app filter to have matched. A pull request touching
  only the Maestro runner therefore skipped the whole job and ran no mobile flow, while reading as
  covered. Fixed at the cause by adding both to `app`; the assertion now enforces the property.
- **FR-005**: The push paths filter MUST select both files, so the two filters agree rather than
  disagree about whether a lockfile change is app-affecting.
- **FR-006**: The end-to-end job MUST remain gated on the change-detection filter's app output. A
  filter that nothing consumes is inert, and this is the wiring most likely to be lost silently.
- **FR-007**: The workflow comment that currently states the end-to-end skip for lockfile pull
  requests is deliberate MUST be replaced with the reasoning that supersedes it, not deleted. A file
  that argues for the opposite of what it does is worse than one that argues for nothing.
- **FR-008**: FR-001 through FR-006 MUST each be asserted by an automated test that fails when the
  assertion is violated, because the forge exposes no way to read a run's step list.

#### Scheduled lockfile refresh (#184, option 4)

- **FR-009**: Scheduled lockfile maintenance MUST be enabled.
- **FR-010**: It MUST declare its own explicit permitted window. Enabled without one, it inherits an
  upstream default window that never intersects this repository's weekly trigger — the same
  never-intersecting-schedules fault that cost four weeks of deferred updates before 057.
- **FR-011**: That window MUST intersect the workflow's weekly trigger under **both** daylight-saving
  offsets, because the forge's schedules are UTC-only and do not observe the change.
- **FR-012**: FR-009 through FR-011 MUST be asserted by an automated test that fails when the explicit
  window is absent or drifts out of intersection.
- **FR-013**: The configuration MUST validate against the pinned major version of the bot.

#### The gate names the lever (#184, option 5)

- **FR-014**: For a dependency finding whose package carries an override, the gate MUST determine
  whether the override's permitted range already admits the published fixed version.
- **FR-015**: When it does, the gate MUST report the permitting range, the version currently
  resolved, and that refreshing the lockfile is the remedy.
- **FR-016**: When it does not, the gate MUST report that the floor must be raised, naming **both**
  the vulnerable-range half and the patched-floor half.
- **FR-017**: The advice MUST be emitted for non-blocking findings as well as blocking ones.
- **FR-018**: The advice MUST NOT alter the gate's exit code, which stays determined solely by
  un-allowlisted blocking findings.
- **FR-019**: The advice MUST be computed per resolved version, not per package name, so a package
  resolving outside its override's range is not given a remedy that cannot work.
- **FR-020**: A finding whose fix range or override value cannot be parsed MUST be passed over
  silently for advice purposes and MUST NOT affect the gate's result.
- **FR-021**: The range-parsing logic MUST reuse the existing override-consistency guard's parsers
  rather than reimplementing them, and MUST NOT weaken that guard.

#### The record (#184, option 1; item #152)

- **FR-022**: The bot's configuration rationale MUST distinguish the half-bump fault from the
  stale-lockfile fault, and record the decision taken for each.
- **FR-023**: Every surviving assertion that the bot extracts zero dependencies from the workspace
  manifest MUST be corrected, dated, without rewriting the historical record that contains it.
- **FR-024**: Any edit to a canonical knowledge document MUST ship with its governance fingerprint
  updated in the same change.

#### Ordering

- **FR-025**: The change-detection remedy MUST be in force before the first scheduled lockfile-refresh
  proposal can exist. Shipping the refresh first would produce weekly proposals that nothing
  end-to-end tests.

### Key Entities

- **Override entry**: a mapping in the workspace manifest from a vulnerable-range key to a
  patched-floor value. Keyed entries carry both halves; plain pins carry only a value and are outside
  the consistency rule's scope.
- **Dependency finding**: a normalized security finding carrying the package name and resolved
  version, the available fix range, a severity, a scope, and whether it blocks a merge.
- **Lever advice**: a derived, non-authoritative statement pairing a finding with the specific action
  that clears it — refresh the lockfile, or raise both halves of the floor.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A pull request whose only changed file is the lockfile runs the end-to-end tier —
  observed on a real pull request, by reading the job's reported status, not by assuming the filter
  matched.
- **SC-002**: That same pull request does not run the emulator half.
- **SC-003**: Removing any one of the six wiring assertions from the workflow causes the test suite to
  fail by name — verified by mutation, one assertion at a time.
- **SC-004**: Removing the explicit refresh window from the bot's configuration causes the test suite
  to fail, proving the never-intersecting-schedules trap is caught rather than merely avoided.
- **SC-005**: Running the security gate against a reconstruction of the measured incident produces
  advice naming the permitting range and the refresh remedy.
- **SC-006**: Running the security gate against the repository's current state names both live cases.
- **SC-007**: After the recommended remedy is applied, the finding count for the named packages drops
  to zero, measured against the current baseline of 55 findings and 2 blocking.
- **SC-008**: The override-consistency guard passes unchanged, on the same 11 keyed floors, after
  every change in this feature.
- **SC-009**: The first scheduled run following the merge produces a lockfile-refresh proposal.
- **SC-010**: Both backlog items are closed only after their own criteria are met and verified, each
  with its evidence recorded.

## Assumptions

- The end-to-end tier's existing web and integration halves are sufficient to catch a broken
  transitive floor. This follows 057's FR-013: the breakage is a build-time failure in the JS
  toolchain, which the unit tier passes straight over and the web bundle does not.
- The single CI runner can absorb one additional end-to-end run per dependency pull request at the
  chosen weekly cadence. At roughly two proposals per run this is on the order of one extra run per
  week, not per day.
- A lockfile refresh is a web/bundle risk rather than a native-runtime risk, which is what justifies
  excluding the emulator half. The `mobile-e2e` label remains available as the escape hatch when a
  specific refresh warrants it.
- The forge exposes no endpoint for a run's step list or logs, so "this step ran" can only be
  established by asserting the wiring and mutation-testing the assertion. This is an existing,
  measured constraint, not an assumption about convenience.
- Scheduled lockfile maintenance proposals share the existing concurrency and hourly throttles with
  routine updates, and a crowded-out refresh defers by one window.
- The published fix versions and override ranges observed on 2026-08-13 remain the reconstruction
  case. If the live cases are remediated before this feature lands, the fixture-based reconstruction
  still stands on its own.
