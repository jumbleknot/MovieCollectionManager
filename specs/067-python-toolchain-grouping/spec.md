# Feature Specification: Python toolchain grouping

**Feature Branch**: `067-python-toolchain-grouping`

**Created**: 2026-09-07

**Status**: Draft

**Input**: Backlog item #366 — "Python interpreter minor is three unrelated Renovate dependencies (.python-version, 8 image tags, 4 uv.lock) — group them and decide the 3.14 move"

## Context

The "user" here is the operator or coding agent reviewing a dependency-update pull request, and the
automation that serves them: the update bot, the guard test that constrains its configuration, and
the image builds that prove the result runs.

The item was filed after PR #362, where a routine base-image sweep moved the interpreter minor for
four services in a pull request titled after container images. Nothing broke — the images built and
the end-to-end suite passed — but the interpreter for four production services was chosen by a
sweep, not by a person. An interim hold was added the same day so that only patch-level refreshes of
the current minor flow; this feature replaces that hold with the grouping the repository already
uses for its other pinned toolchains, and then makes the deferred move deliberately.

### Measured facts this specification rests on

Measured 2026-09-07 against this working copy with the update bot run locally in extraction and
lookup modes. These correct the item's own framing and are the reason the requirements below are
shaped as they are:

- The interpreter version is visible to the update bot at **four** kinds of site, not three. The
  fourth — the language-version **floor** declared in each of the four service manifests — was not
  identified in the item. It is a different kind of dependency, resolved from a different upstream
  source, and the interim hold does not reach it.
- The interpreter pin file and the eight container image references are **already treated as one
  dependency** by the bot, because both are resolved from the same upstream source. They will not
  drift apart. What is wrong is *where* they move: both currently ride the routine base-image group,
  so raising the ceiling would reproduce PR #362 exactly — the interpreter minor for four services
  decided inside a pull request about unrelated infrastructure images.
- The interim hold is working: the pin resolves to no available update, and the image references
  resolve to a patch-level refresh only.
- The four resolved lockfiles are each valid across the whole range their manifest floor permits,
  and that range already admits the target minor.

One measurement could **not** be taken here and must not be recorded as verified: the lookup of the
manifest floor's upstream source failed in this environment because that source is outside the
development container's permitted network egress. The reasoning that a floor of "at least the
current minor" already admits the next minor, and so should not be widened by the bot, is
*inference*, not measurement, and the requirements treat it accordingly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An interpreter change arrives as its own reviewable change (Priority: P1)

A reviewer opens a dependency-update pull request. When that pull request changes which interpreter
four production services run, the reviewer needs it to say so — by being about the interpreter and
nothing else, so the decision is visible, attributable, and reviewable on its own merits.

**Why this priority**: This is the defect the item was filed for. A change of this consequence
presented inside a sweep of unrelated images is a decision nobody made. The repository already
treats its other pinned toolchains this way, and has paid four separate times for assuming that
recognising the halves of a dependency is the same as keeping them together.

**Independent Test**: Resolve the update bot's rules against the interpreter pin and against a
container image reference, on every update track, and confirm both land in the same
interpreter-specific change and that no unrelated infrastructure image joins them. Delivers value on
its own: even with the version unchanged, the next minor is guaranteed to arrive reviewably.

**Acceptance Scenarios**:

1. **Given** the interpreter pin and the container image references, **When** a new interpreter minor
   becomes permitted, **Then** every one of those sites is proposed together, in a single change that
   contains nothing else.
2. **Given** an unrelated infrastructure image with an available update, **When** the same run
   proposes it, **Then** it arrives in the routine base-image change and not in the interpreter one.
3. **Given** the language-version floor declared in the service manifests, **When** rules are
   resolved against it, **Then** it is deliberately excluded from the interpreter change, and that
   exclusion is recorded with its reason rather than left to be rediscovered.

---

### User Story 2 - The four services run the interpreter that was chosen (Priority: P1)

The operator has decided which interpreter minor the agent gateway and the three tool servers should
run. All four services, the development pin, and the ceiling that constrains future proposals must
agree on that one number afterwards.

**Why this priority**: The hold added after PR #362 made the move deliberate but left it undone, so
the repository is currently sitting on a decision it deferred. Leaving it deferred is not neutral:
the current minor drops to security-only maintenance when the next one ships, which is imminent.

**Independent Test**: Read the pin, the eight image references and the configured ceiling, and
confirm all three describe the same interpreter minor; then build all four service images and
confirm each resolves its locked dependencies against the new interpreter without relaxing the lock.

**Acceptance Scenarios**:

1. **Given** the change is applied, **When** the pin, the image references and the ceiling are
   compared, **Then** all three name the same interpreter minor and the ceiling admits it.
2. **Given** the change is applied, **When** all four service images are built, **Then** each
   installs its dependencies from the existing lockfile without regenerating it, and every image
   builds.
3. **Given** a dependency in any of the four services has no prebuilt artefact for the new
   interpreter, **When** its image is built, **Then** the build either compiles it from source
   successfully or fails loudly — it never silently installs something other than what is locked.

---

### User Story 3 - The pin and the running images cannot silently disagree (Priority: P2)

An operator or agent editing any one of these files by hand needs the repository to reject the state
where the development interpreter and the interpreter four services actually run are different
minors.

**Why this priority**: A configured ceiling constrains only what the *bot* proposes. It is silent
about a hand edit, and a hand edit is exactly how the deferred move would otherwise have been made.
This is the assertion that gives the item's second acceptance criterion teeth; it is a lower priority
than the two above only because it protects a state the grouping already makes unlikely.

**Independent Test**: Change the interpreter named in one image reference without changing the pin,
run the repository's own configuration guards, and confirm they fail and name the disagreement.

**Acceptance Scenarios**:

1. **Given** the pin and the eight image references agree, **When** the configuration guards run,
   **Then** they pass.
2. **Given** any image reference names a different interpreter minor from the pin, **When** the
   guards run, **Then** they fail and identify which sites disagree.
3. **Given** the pin is raised without raising the ceiling, **When** the guards run, **Then** they
   fail, so the ceiling can never leave the images a minor behind.

---

### User Story 4 - The security-patch stream keeps flowing regardless (Priority: P3)

Whether the interpreter minor is being held or moved, the operator needs the routine patch-level
refresh of the running image to keep arriving, because that is the stream that clears vulnerabilities
in the base image between minor releases.

**Why this priority**: This has already been broken once, silently, in precisely this area: a
same-image version proposal and its patch refresh collided, the refresh lost every run, and nothing
reported it — so the image was never refreshed at all. Any new grouping of this dependency can
recreate that collision. Lower priority only because it is a property to preserve rather than a new
capability.

**Independent Test**: Resolve the update bot's rules against a container image reference on the
patch-refresh track and confirm it is still separated from the interpreter change.

**Acceptance Scenarios**:

1. **Given** the new grouping is in place, **When** a patch refresh of the running image becomes
   available, **Then** it is proposed separately from any interpreter version change and is not
   discarded.
2. **Given** an interpreter version change and a patch refresh are both available in the same run,
   **When** both are processed, **Then** neither suppresses the other.

### Edge Cases

- **The next minor ships during review.** The ceiling admits exactly one minor. A newer one becoming
  available must not widen it, and must not turn the pending change into a different one.
- **A hand edit moves the pin but not the ceiling, or the ceiling but not the pin.** Both directions
  must fail the guards; a ceiling silently one minor behind its pin is the state this feature exists
  to make impossible.
- **A dependency has no prebuilt artefact for the new interpreter.** One service already compiles
  such a dependency from source and provisions a compiler for it. The image build is the check; it
  must not be bypassed.
- **The manifest floor's upstream source is unreachable.** It was unreachable in this environment.
  An unreachable source must not be reported as "no update available" — the requirement is that the
  floor is *excluded by rule*, not that it happens to be quiet.
- **A future container image, in any file, references the interpreter.** It must be covered by the
  same grouping rather than falling back into the routine base-image sweep.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The interpreter pin and every container image reference to the interpreter MUST resolve
  into one shared, interpreter-specific update group, on every update track that carries a version
  change (patch, minor and major alike).
- **FR-002**: That group MUST take the interpreter out of the routine base-image group, so an
  interpreter change is never proposed alongside unrelated infrastructure images.
- **FR-003**: The patch-level refresh of the running image MUST remain separated from the
  interpreter version change, so neither can discard the other.
- **FR-004**: The version ceiling that constrains interpreter proposals MUST admit exactly the minor
  named by the interpreter pin, and no later one.
- **FR-005**: A repository guard MUST fail when the interpreter pin and the ceiling disagree, in
  either direction.
- **FR-006**: A repository guard MUST read the interpreter minor from every container image
  reference and fail when any of them differs from the interpreter pin.
- **FR-007**: The language-version floor declared in the service manifests MUST be excluded from the
  interpreter group and from the ceiling, by an explicit rule rather than by coincidence, and a guard
  MUST assert that exclusion so a later widening of either cannot capture it silently.
- **FR-008**: The reason for that exclusion MUST be recorded in the configuration itself, as a
  deliberate divergence, in the same form the repository already uses for its other recorded
  divergences.
- **FR-009**: No dependency other than the interpreter MAY acquire the interpreter's group or its
  ceiling; a guard MUST assert this with named controls.
- **FR-010**: The interpreter pin, all eight container image references, and the ceiling MUST be
  moved together to the interpreter minor the operator chose, and MUST agree afterwards.
- **FR-011**: All eight container image references MUST name the same immutable image identity, not
  merely the same tag.
- **FR-012**: The four resolved lockfiles MUST NOT be regenerated by this change, and each service
  image MUST install from its existing lockfile without relaxing it.
- **FR-013**: The operating documentation MUST record the interpreter as a grouped toolchain, list
  every site at which its version appears, and state explicitly which check fails if the interpreter
  and the locked dependencies ever disagree — naming an existing check rather than introducing a new
  one.
- **FR-014**: Any guard that this change causes to fail because it asserted a premise the change
  deliberately reverses MUST be updated to assert the new premise, never removed.

### Key Entities

- **Interpreter pin**: the single declared interpreter minor for development and lockfile
  resolution. One site. The source of truth every other site is measured against.
- **Container image references**: the interpreter the four deployed services actually run. Eight
  sites across four service images, each naming both a version and an immutable identity.
- **Language-version floor**: the minimum interpreter each service manifest declares it supports.
  Four sites. A floor, not a pin — deliberately outside this feature's grouping.
- **Resolved lockfiles**: the exact dependency set each service installs, resolved across the whole
  range its floor permits. Four sites. Not regenerated by an interpreter move.
- **Version ceiling**: the configured bound on which interpreter minors the update bot may propose.
  Must track the interpreter pin.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reviewer can determine, from the title and contents of a proposed interpreter change
  alone, that it changes the interpreter for the four services and changes nothing else — no
  unrelated image appears in it.
- **SC-002**: Every one of the thirteen **rule-covered** interpreter-bearing sites (one pin, eight
  image references, four floors) is accounted for by a rule that either includes it in the
  interpreter group or excludes it for a recorded reason; none is left to coincidence. The four
  resolved lockfiles also record a version but are covered by FR-012 rather than by a rule, which is
  why they are outside this count.
- **SC-003**: After the change, the interpreter pin, all eight image references and the ceiling name
  one and the same interpreter minor.
- **SC-004**: A deliberate one-site disagreement introduced into any of those sites is caught by the
  repository's own guards before it can merge, and the failure message names the disagreeing sites.
- **SC-005**: All four service images build on the new interpreter, each installing from its existing
  lockfile without regenerating it.
- **SC-006**: The patch-level refresh of the running image is still proposed separately after the
  change, so the count of update proposals discarded by collision remains zero.
- **SC-007**: The operating documentation answers the re-lock question in one place, naming the
  existing check that fails if the interpreter and the locked dependencies disagree, so the next
  operator does not have to re-derive it.

## Assumptions

- **The operator's two decisions, taken 2026-09-07, are inputs to this specification, not open
  questions.** First: the interpreter moves to the next minor (3.14) in this change rather than
  later. It is mature — seven patch releases published — PR #362 already demonstrated that the images
  build and the end-to-end suite passes on it, and the following minor is at release-candidate stage,
  so the current minor drops to security-only maintenance within roughly a month; holding would only
  mean moving twice. Second: the language-version floor stays where it is and is deliberately
  excluded, because a floor of "at least the current minor" already admits the next one and is not
  a pin.
- A resolved lockfile is valid across the entire range its manifest floor permits, so an interpreter
  move that does not change the floor requires no regeneration. This is why the third acceptance
  criterion of item #366 is answered by naming an existing check rather than by adding a re-lock
  step.
- The update bot regenerates a lockfile only for a manifest it has itself edited, so an interpreter
  move that touches no manifest would produce no lockfile change even if one were wanted. This is
  inference from the bot's documented behaviour, not a measurement taken here.
- The interpreter pin remains a two-part `major.minor` value, since every guard in this feature
  derives the ceiling from it by incrementing the minor.
- The four service images continue to be built by the existing local stack bring-up that the
  integration workflow already runs; that is what makes the image build a real check rather than a
  claimed one.

## Out of Scope

- The routine Python **package** update group, the weekly lockfile-refresh channel, and that
  channel's own liveness. Those are separate concerns tracked elsewhere (item #218).
- Any container image other than the interpreter.
- Widening or narrowing the language-version floor in the service manifests.
- Introducing any new continuous-integration job or gate. This feature reuses the checks that exist.
