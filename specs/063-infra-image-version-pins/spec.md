# Feature Specification: Infra-image version pins

**Feature Branch**: `063-infra-image-version-pins`

**Created**: 2026-08-30

**Status**: Draft

**Input**: Backlog item #297 — "Eight infra images are pinned to floating tags, so Renovate cannot classify a major from a security patch"

## User Scenarios & Testing *(mandatory)*

The "user" here is the operator or coding agent triaging a dependency update, and the automation
(Renovate, the infra-image CVE gate) that serves them.

### User Story 1 - A reviewer can tell a major from a security patch (Priority: P1)

An infra-image update arrives as a pull request. The reviewer needs to know whether it is a routine
patch or an upgrade that can change behaviour. Today every one of the eight floating-tag images
arrives as an opaque digest change: the bot reports `updateType: digest` because there is no version
to compare, so a rebuild that crosses a major release is presented identically to a security patch.

**Why this priority**: This is the whole point of the item. Every risk-separating rule the repository
already relies on — the update-type groups, the 0.x-crate rule, the rule for a dependency that ships
breaking changes in a minor — is inert against a tag that carries no version. It is the same defect
class the repository has paid for four times, in its most extreme form: not a misleading version
number, but no version number at all.

**Independent Test**: Change one formerly-floating image's pin to an older version, run the update
bot's rule resolution, and confirm the proposed change is classified as major/minor/patch rather than
as a digest change. Delivers value on its own: even one image moved off a floating tag is one image
whose updates can be triaged.

**Acceptance Scenarios**:

1. **Given** an image pinned to a version tag, **When** upstream publishes a new major, **Then** the
   proposed update is classified as a major and is separated from routine updates.
2. **Given** an image pinned to a version tag, **When** upstream publishes a patch, **Then** the
   proposed update is classified as a patch and rides the routine group.
3. **Given** the migration is applied, **When** the running image digests are compared before and
   after, **Then** they are identical — the change is notational, not a content change.

---

### User Story 2 - A suppression can be discharged by an upgrade (Priority: P2)

A CVE against an infra image is accepted into the allowlist with a justification. Later the upstream
project fixes it. The operator needs the suppression to stop applying once the fixed version is
running, so the acceptance is retired rather than silently outliving its reason.

**Why this priority**: An allowlist entry keyed to a floating reference can never be discharged,
because there is no version for it to stop matching. The bundle records this outcome already for one
image: the entry states that the floating tag "already floats to newest so no pin/bump clears it."
The contrast is instructive — a precise, versioned allowlist key ceasing to match a newer reference is
exactly what surfaced a real security regression during this work.

**Independent Test**: Point an allowlist entry at a version-keyed reference, move the image to a newer
version, and confirm the entry stops suppressing and the finding becomes visible again.

**Acceptance Scenarios**:

1. **Given** an allowlist entry keyed to a specific version, **When** the image moves to a newer
   version, **Then** the entry no longer suppresses and the finding is reported.
2. **Given** an allowlist entry that must remain broad, **When** it is reviewed, **Then** it carries a
   recorded reason why it cannot be version-keyed.

---

### User Story 3 - The release-age cooldown can actually be satisfied (Priority: P3)

An operator merging an infra-image update needs the supply-chain cooldown to be a check that passes in
the ordinary course, not one that is routinely overridden.

**Why this priority**: Frequently-rebuilt floating tags keep resetting the cooldown clock, so the
check sits pending and gets merged past. That happened during this work. The cost is not the single
override but the erosion: a control that is always in the way stops being read. Lower priority than
the two above because it is a consequence of the same cause and is resolved by fixing it.

**Independent Test**: Observe the cooldown check on a pull request for a version-pinned image and
confirm it reaches a settled state without an override.

**Acceptance Scenarios**:

1. **Given** all eight images are version-pinned, **When** an update pull request is raised for one,
   **Then** the release-age check resolves on its own once the release is old enough, rather than
   being reset by an unrelated rebuild.

---

### Edge Cases

- **An image whose upstream publishes no version tags at all.** The migration cannot invent one. Such
  an image must remain floating **and** carry a recorded reason, so a later reader can tell a
  deliberate exception from an oversight.
- **An image whose versions are not semantic.** One image family releases on date-stamped tags. These
  are orderable but are not major/minor/patch, so User Story 1's benefit is partial for them: updates
  become identifiable and orderable, but not risk-classified. This must be stated rather than implied.
- **A variant pair that must move together.** One image is referenced twice, in a plain and a
  debug-suffixed form. If only one moves, the two run different builds of the same component. The
  repository has been bitten by exactly this half-bump shape four times.
- **A tag namespace containing pre-release and variant tags.** The update bot must not drift onto a
  development, release-candidate or unrelated-variant tag when following a version series.
- **The same image referenced from both local and production compose files.** All references must move
  together, or the two environments run different versions.
- **An upstream that has stopped publishing.** One image family's newest release is the one already
  running. Pinning it loses no currency, and that fact must be recorded so the pin is not later
  mistaken for neglect.
- **The floating-tag report itself.** The report that verifies this work classifies a tag as floating
  when it does not begin with an optional `v` followed by a digit. A date-stamped tag does not. The
  outcome must be decided deliberately — either the classifier accounts for the form, or the
  acceptance criterion records the exception. Widening the classifier merely to make the output look
  clean would defeat the check.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every third-party infra image reference MUST resolve to either a version tag, or a
  floating tag accompanied by a recorded reason it must remain floating.
- **FR-002**: The migration MUST be content-neutral: each new reference MUST resolve to the same image
  content that the corresponding floating reference resolves to at the time of the change.
- **FR-003**: An update to a formerly-floating image MUST be classified by its update type (major,
  minor, patch) wherever the upstream versioning scheme supports that distinction.
- **FR-004**: For an image family whose tags are ordered but not semantic, the system MUST still
  identify and order updates, and MUST record that risk classification is not available for it.
- **FR-005**: References to the same image that must move together — variant pairs, and local versus
  production files — MUST be proposed in a single change, never independently.
- **FR-006**: The update bot MUST NOT propose a pre-release, development, or unrelated-variant tag for
  any of these images.
- **FR-007**: Suppression entries for these images MUST be keyed so that they stop applying when the
  image moves to a version that no longer matches, or MUST record why they cannot be.
- **FR-008**: The verification report MUST report zero floating references, except those declared
  under FR-001 as deliberate exceptions.
- **FR-009**: Guard coverage MUST assert the RESOLVED behaviour — the update type a change is actually
  classified as, and the group it actually lands in — not merely that a rule mentioning the image
  exists. A rule that is present but overridden by a later rule passes the weaker check while
  changing nothing.
- **FR-010**: The reasoning behind each pin — including which upstream has stopped publishing, and
  which image family cannot be risk-classified — MUST be recorded where a future reader will meet it.

### Key Entities

- **Image reference**: A pointer to a third-party container image used by the infrastructure
  definitions. Has a name, an optional tag, and an optional content digest. Its tag is either a
  version (orderable, and possibly risk-classifiable) or floating (neither).
- **Update classification**: What an update to an image reference is understood to be — major, minor,
  patch, or an opaque content change. Derived from comparing versions; unavailable without them.
- **Suppression entry**: A recorded acceptance of a known vulnerability for a given image, matched by
  image pattern and advisory identifier. Dischargeable only if its image pattern can stop matching.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero of the eight image references remain floating without a recorded reason; any that
  do are individually justified and countable.
- **SC-002**: The image content running before and after the change is byte-identical for all eight
  images, demonstrated by comparing resolved digests.
- **SC-003**: For every image whose upstream uses a semantic versioning scheme, a simulated major
  update is classified as a major and separated from routine updates; a simulated patch is classified
  as a patch.
- **SC-004**: The one image family referenced under two different tags in two files moves both
  references in a single proposal. Families referenced under an identical tag in more than one file
  are structurally incapable of splitting — one dependency, several locations — and are verified once
  as a control rather than counted as separate risks.
- **SC-005**: Every suppression entry for these images is either version-keyed, or carries a recorded
  reason it cannot be.
- **SC-006**: The verification report's floating count matches the number of declared exceptions
  exactly — not merely "fewer than before".

## Assumptions

- The eight images are the complete set of floating third-party infra references, as reported by the
  verification tool after its classifier defect was corrected. The count is trusted only because that
  defect was found and fixed first; before the fix, the same report under-counted by half.
- Each floating reference has an equivalent version tag resolving to the identical content today. This
  was verified per image against the upstream registries before this specification was written, so the
  migration is known to be achievable rather than assumed to be.
- Upstream registries remain reachable from the build environment for version discovery. One registry
  metadata host is not reachable from the development container; a different, reachable endpoint
  provides the same information.
- Correcting the floating-tag classifier is a prerequisite and is handled separately; this feature
  depends on it but does not include it.
- The policy question of whether an update may be merged before its release-age cooldown has elapsed
  is explicitly out of scope, tracked as its own backlog item. This feature changes the conditions that
  made the question urgent; it does not answer it.

## Out of Scope

- The merge policy for the release-age cooldown (separate backlog item).
- Images already pinned to versions, and the first-party built images, which are governed elsewhere.
- Changing which images are used, or their configuration — this feature changes only how their
  versions are expressed.
