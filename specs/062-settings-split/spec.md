# Feature Specification: Settings destination with sub-navigation

**Feature Branch**: `062-settings-split`

**Created**: 2026-08-23

**Status**: Draft

**Input**: Backlog item #235 (`type/feature`, `priority/p2`, `status/needs-spec`) — "Rename Profile to Settings and split it into profile / assistant / backups / admin sub-pages". Blocks item #236 (per-user collection backups), which lands its UI into the `backups` slot.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reach a specific settings area directly (Priority: P1)

An authenticated user opens the app's settings destination and finds it organised into named areas rather than one long scrolling page. They move between areas from a persistent sub-navigation, and each area has its own address they can bookmark, share, or land on directly.

**Why this priority**: This is the whole point of the change and the only slice that must ship for the feature to have value. Today the destination is a single stack of unrelated cards with no way to link to any part of it. Delivered alone — with just the Profile and Movie Assistant areas — it already removes the dumping-ground problem and gives every later area a place to land.

**Independent Test**: Log in, confirm the navigation bar offers "Settings" (not "Profile"), open it, and switch between the Profile and Movie Assistant areas using the sub-navigation. Then reload the browser directly on each area's address and confirm the same area opens with its sub-navigation intact.

**Acceptance Scenarios**:

1. **Given** an authenticated user on any app screen, **When** they read the navigation bar, **Then** the destination is labelled "Settings" and no destination is labelled "Profile".
2. **Given** an authenticated user, **When** they select "Settings", **Then** they land on the Profile area, which shows their profile details and the logout control, with sub-navigation listing the available settings areas above it.
3. **Given** a user viewing the Profile area, **When** they select "Movie Assistant" in the sub-navigation, **Then** the movie-assistant configuration replaces the profile content, the sub-navigation stays visible, and "Movie Assistant" is indicated as the active area.
4. **Given** a user with the address of a specific settings area, **When** they open that address directly (cold start, no prior navigation), **Then** that area renders with its sub-navigation, without first flashing another area.
5. **Given** a user editing and saving movie-assistant configuration inside its own area, **When** the save succeeds, **Then** the assistant's availability updates in the same session exactly as it did before the split — no reload and no re-login.

---

### User Story 2 - Administer app-wide settings from the same destination (Priority: P2)

An administrator finds an Admin area alongside the other settings areas and manages app-wide settings there. Users without the administrator role never see the area, and are refused if they try to reach its address directly.

**Why this priority**: The administrator screen already exists and already works; what is missing is a durable way to reach it. Until this ships, the only route to it is a card that this change deletes — so it must land in the same change, but it does not block the P1 slice from being demonstrable.

**Independent Test**: Sign in as an administrator, confirm an Admin area appears in the settings sub-navigation, open it, and change the self-registration setting. Then sign in as a non-administrator, confirm the Admin area is absent, and navigate to its address directly to confirm refusal.

**Acceptance Scenarios**:

1. **Given** a signed-in administrator, **When** they open Settings, **Then** the sub-navigation includes an Admin area in addition to the areas every user sees.
2. **Given** a signed-in non-administrator, **When** they open Settings, **Then** no Admin area appears anywhere in the sub-navigation.
3. **Given** a signed-in non-administrator, **When** they navigate directly to the Admin area's address, **Then** access is refused by the route's own role check — the absence of the sub-navigation entry is not what stops them.
4. **Given** an administrator in the Admin area, **When** they read and change the user self-registration setting, **Then** it behaves exactly as it did before this change, including the effect on the registration screen.

---

### User Story 3 - A reserved home for collection backups (Priority: P3)

A user finds a Backups area in settings that announces itself and states that the capability is not yet available.

**Why this priority**: It delivers no capability on its own — it exists so the follow-on backups feature (item #236) adds a screen body rather than re-opening this navigation refactor. Deliberately last: the P1 and P2 slices are complete and shippable without it.

**Independent Test**: Open Settings, select Backups, and confirm a placeholder renders and the sub-navigation continues to work from there.

**Acceptance Scenarios**:

1. **Given** any authenticated user, **When** they select Backups in the settings sub-navigation, **Then** a placeholder renders identifying the area and indicating the capability is not yet available.
2. **Given** a user on the Backups area, **When** they select another settings area, **Then** navigation works normally in both directions.

---

### Edge Cases

- **A user follows an old bookmark** to the pre-split profile address, or to the pre-split administrator-settings address. Both addresses are removed, so the app's not-found handling applies. This is a deliberate decision (see Assumptions), not an oversight.
- **A user's administrator role is not present when they land directly** on the Admin area's address — refusal comes from the route guard, and is identical whether they arrived by sub-navigation, by URL, or by an in-session role change.
- **A user opens an address under the settings destination that names no known area** — the app's not-found handling applies, with no partially-rendered settings shell.
- **A user navigates between settings areas while the assistant overlay is open** — the overlay's availability and its knowledge of which screen the user is on both continue to track correctly.
- **A user on a narrow screen** — the sub-navigation must remain usable when all visible areas cannot fit on one line, on both web and mobile.
- **The assistant is asked to resolve "this"** while the user sits on a settings area — the assistant has no collection or movie in view, so it must ask rather than act on a stale target.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The app's primary navigation MUST present the per-user settings destination as "Settings", and MUST NOT present any destination labelled "Profile".
- **FR-002**: The settings destination MUST be organised into four named areas — Profile, Movie Assistant, Backups, and Admin — each with its own distinct, directly-addressable address.
- **FR-003**: Every settings area MUST render a shared sub-navigation listing the areas available to the current user, indicating which area is active.
- **FR-004**: Selecting the settings destination without naming an area MUST open the Profile area.
- **FR-005**: The Profile area MUST present the user's profile details and the logout control, with behaviour unchanged from before the split.
- **FR-006**: The Movie Assistant area MUST present the per-user movie-assistant configuration with behaviour unchanged from before the split, including that saving a configuration updates the assistant's availability within the same session.
- **FR-007**: The Backups area MUST render a placeholder stating the capability is not yet available. No backup capability is delivered by this feature.
- **FR-008**: The Admin area MUST appear in the sub-navigation only for users holding the administrator role.
- **FR-009**: The Admin area MUST enforce the administrator role at the route itself, independently of whether its sub-navigation entry was shown. Hiding the entry is presentation only.
- **FR-010**: The Admin area MUST read and write the app-wide user self-registration setting with behaviour unchanged from before the split.
- **FR-011**: The pre-split profile address and the pre-split administrator-settings address MUST be removed; requests for them resolve to the application's not-found handling.
- **FR-012**: The card that existed solely as a navigation link to the administrator settings screen MUST be removed, together with its unit test, because the sub-navigation replaces it.
- **FR-013**: Each settings area MUST report its own distinct screen label to the assistant's readable UI state, so the assistant can distinguish which settings area the user is on.
- **FR-014**: The server-side allowlist that governs which screen labels may reach the assistant MUST accept the new labels and MUST continue to reduce any unrecognised label to the existing unknown fallback. No user-entered value may ride this channel.
- **FR-015**: Renaming or adding screen labels MUST leave the assistant's existing reference resolution ("this collection", "this movie") behaving exactly as before.
- **FR-016**: Every automated end-to-end flow that reaches the settings destination or its areas MUST be updated to the new labels, addresses, and element identifiers, and MUST pass.
- **FR-017**: Stable, addressable element identifiers MUST exist for the navigation entry, the sub-navigation, each sub-navigation entry, and each area's content, so web and mobile automation can locate the same elements.
- **FR-018**: Deep-linking directly to any settings area MUST work on both web and native.
- **FR-019**: The provider that supplies assistant configuration to both the configuration form and the assistant overlay MUST remain mounted above the settings destination, so the split does not change when the overlay appears.

### Key Entities

- **Settings area**: One named, independently addressable section of the settings destination. Has a display label, an address, a visibility rule (everyone, or administrators only), and a body. Four exist at the end of this feature; adding a fifth is intended to be additive.
- **Screen label**: The structural name for the screen the user is currently viewing, reported to the assistant so it can resolve references. Drawn from a fixed, server-enforced vocabulary; carries no user-entered content.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From any authenticated screen, a user reaches any settings area available to them in at most two selections.
- **SC-002**: All four settings areas have distinct addresses, and opening each address directly — cold, with no prior in-app navigation — lands on that area on both web and mobile.
- **SC-003**: Every attempt by a non-administrator to reach the Admin area is refused, whether the entry was visible or the address was entered directly.
- **SC-004**: Every user-facing capability present on the pre-split page — profile display, logout, movie-assistant configuration and its save behaviour, and the administrator self-registration toggle — remains available and behaves identically after the split.
- **SC-005**: The full automated regression for the touched areas passes, with no test disabled, skipped, or weakened to accommodate the change.
- **SC-006**: A new settings area can be added by supplying a body and one sub-navigation entry, with no change to the other areas — demonstrated by the Backups placeholder occupying the slot the follow-on backups feature will fill.

## Assumptions

- **Old addresses are removed rather than redirected** (operator decision, 2026-08-23). Both the pre-split profile address and the pre-split administrator-settings address 404. Accepted consequence: an existing bookmark to either breaks with no forwarding. Rationale: the app is not publicly linked, the administrator address was unreachable by design until the deleted card was added, and two permanent redirect stubs would outlive their usefulness.
- **Each area reports a distinct screen label** (operator decision, 2026-08-23), rather than all four sharing one. This adds vocabulary the assistant may later use to tailor help per settings area. It changes no current assistant behaviour: reference resolution reads only the collection and movie-detail labels.
- **The pre-split page reported no screen label at all**, and the administrator screen reported a label that the server-side allowlist already reduced to unknown. Bringing all four areas onto the allowlist therefore also closes existing drift, not just the drift this change introduces.
- **The sub-navigation is a vertical list of area entries, in one interaction model across web and
  mobile** — beside the area body on wide viewports, stacked above it on narrow ones. It was a
  horizontal row of entries until that shape was measured on a device (2026-08-25): the entries
  totalled 449px against a 320px viewport, putting the last one off-screen behind a horizontal
  scroll with no affordance announcing it (backlog item #240). A vertical list has room for the
  full labels, so no area is hidden at any supported width. A drill-down — where selecting
  Settings shows a menu rather than an area — was rejected because it contradicts FR-004.
- **No new server capability is required.** Every area's content already exists, or is a placeholder; the settings destination composes existing screens and adds navigation.
- **No change to who may do what.** The administrator role requirement, and the server-side enforcement behind the administrator settings endpoint, are unchanged by this feature.
- **Both the touched frontend and the assistant gateway are in scope for verification**, because the screen-label vocabulary spans them.

## Out of Scope

- Any backup capability — scheduling, storage, export, restore. The Backups area is a placeholder; the capability is backlog item #236.
- Redesigning the content of any area. Each existing area's body moves as-is.
- Adding settings that do not exist today.
- Changing the assistant's behaviour, tools, or reference resolution beyond accepting the new screen labels.

## Dependencies

- **Blocks backlog item #236** (per-user collection backups), which replaces the Backups placeholder with real content. Kept as a separate change deliberately: a navigation refactor and a scheduled-job subsystem in one CI run makes a red result ambiguous.
