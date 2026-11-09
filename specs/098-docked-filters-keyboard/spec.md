# Feature Specification: Docked view controls on the collection screen, and a keyboard-safe assistant on mobile

**Feature Branch**: `098-docked-filters-keyboard`

**Created**: 2026-11-09

**Status**: Draft

**Input**: User description: "On the collection view there is not enough space on the screen, especially on mobile, to see the column selectors and filters. This should be docked (like the assistant) so that it doesn't take up any space, but when you click it then it undocks and you can select any filters you want and then re-dock it to see the screen again. Also, the assistant has a UX issue on mobile where the keyboard covers what is being typed."

## Context (what the user sees today)

The collection screen stacks, top to bottom: the collection name, the search bar, the column selector,
the sort control, the full filter panel (up to nine sections of chips), the count line with "+ Add movie",
and only then the movie list. On a phone the controls above the list fill most of the first screen, so
the user scrolls past controls they are not using in order to see their movies.

The assistant is already "docked": a small toggle in the bottom-left corner that occupies no layout
space and opens a panel over the screen when pressed. On a phone, when the user taps the assistant's
message field, the on-screen keyboard rises over the bottom of the panel and hides the field and the
text being typed.

## Clarifications

### Session 2026-11-09

- Q: Should the sort control move into the docked view-options control? → A: Yes — columns, sort and filters all dock; search, count and "+ Add movie" stay inline.
- Q: Docked at every width, or only on phones? → A: Docked at every width, web and native.
- Q: Where does the docked toggle sit? → A: As a compact bar of its own between the search row and the count row.
- Q: How does the panel appear when opened? → A: It drops down from the bar as an overlay over the list; the list does not move.
- Q: Which platforms must the keyboard fix cover? → A: The native app (Android verified by an automated flow, and iOS); mobile web only if reproduced during implementation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the movie list without the view controls in the way (Priority: P1)

A user opens a collection on their phone. The column selector, sort control and filters are collapsed
into one compact, docked "View options" bar between the search bar and the count line, so the movie
list starts directly below the count line. When they want to change what they see, they open the control, pick columns, a sort and
filters, and close it again to see the updated list on the full screen.

**Why this priority**: This is the space problem the user reported, on the screen they use most. It is
viable alone: delivering only this story removes the cause of the complaint.

**Independent Test**: On a phone-sized screen, open a collection: the first movie row is visible
without scrolling and no filter chips or column toggles are shown. Open the control, apply a filter,
close it: the list shows only matching movies and the controls are gone again.

**Acceptance Scenarios**:

1. **Given** a user opens a collection, **When** the screen loads, **Then** the column selector, sort
   control and filter panel are not shown, a single compact docked view-options bar is shown between the
   search bar and the count/"+ Add movie" row, and the list begins directly below the count row.
2. **Given** the control is docked, **When** the user presses it, **Then** the column, sort and filter
   choices drop down from the bar as an overlay over the list (the list does not move), with every
   choice available today still available.
3. **Given** the control is open, **When** the user selects a filter, toggles a column or changes the
   sort, **Then** the list, the count line and the active-choice state update immediately, exactly as
   they do today, without the control closing.
4. **Given** the control is open, **When** the user presses its close action, presses the docked
   control again, or uses the system Back gesture/button (Android), **Then** it re-docks and the full
   list is visible, with every choice made still applied.
5. **Given** one or more filters are applied and the control is docked, **When** the user looks at the
   screen, **Then** the docked control shows how many filters are active, so filtered results are never
   mistaken for the whole collection.
6. **Given** filters are applied, **When** the user uses "Clear" inside the open control, **Then** all
   filters are removed and the active-filter count on the docked control disappears.

---

### User Story 2 - See what I am typing to the assistant on a phone (Priority: P1)

A user opens the assistant on their phone and taps the message field. The keyboard rises, and the panel
moves up with it so that the message field, the text being typed, the send button and the most recent
message remain visible above the keyboard. When the keyboard closes, the panel returns to its normal
position.

**Why this priority**: It is a defect that makes the assistant hard to use on the platform where typing
is hardest. It is independent of Story 1 and can ship alone.

**Independent Test**: On an Android phone or emulator, open the assistant, tap the message field, type
a multi-word message: every character is visible as it is typed and the send button can be pressed
without first dismissing the keyboard.

**Acceptance Scenarios**:

1. **Given** the assistant panel is open on a phone, **When** the user focuses the message field and the
   keyboard appears, **Then** the message field, the typed text and the send button are fully visible
   above the keyboard.
2. **Given** the keyboard is open, **When** the user sends a message, **Then** the newest message in the
   conversation is visible without dismissing the keyboard.
3. **Given** the keyboard is open, **When** it is dismissed (Back, tapping outside, or after sending if
   the platform closes it), **Then** the panel returns to its usual position and size with nothing cut
   off.
4. **Given** a small phone in portrait, **When** the keyboard is open, **Then** the panel shrinks rather
   than extending above the top of the visible area, and its header/close control stays reachable.

---

### User Story 3 - Docked controls and the assistant do not collide (Priority: P2)

On the collection screen both docked controls are present: the view-options bar below the search bar and
the assistant toggle in the bottom-left corner. Their open panels never cover each other, and opening one
does not leave the other open underneath it.

**Why this priority**: A quality bar for Story 1 rather than new capability; without it Story 1 can
introduce new obstructions.

**Independent Test**: On phone and desktop widths, both docked controls and "+ Add movie" are visible
and each can be pressed; opening the view options while the assistant is open closes the assistant (and
vice versa).

**Acceptance Scenarios**:

1. **Given** the collection screen, **When** both controls are docked, **Then** neither control overlaps
   the other or the "+ Add movie" action.
2. **Given** the assistant is open, **When** the user opens the view options, **Then** the assistant
   docks, and the reverse also holds.

---

### Edge Cases

- **Filter options still loading or failed to load**: the docked control is still usable; when opened
  it shows the same loading or empty state the filter panel shows today.
- **A collection with no movies**: the control is still present (columns and sort remain meaningful
  once movies are added); it does not hide the empty-state message.
- **Choices persist across docking**: docking or undocking never resets columns, sort or filters; the
  existing persistence of these choices (across navigation and reloads) is unchanged.
- **Many filter values** (long genre lists): the open control scrolls internally and never pushes the
  close action off-screen.
- **Rotation or window resize while open**: the control stays usable and closable.
- **Hardware keyboard / desktop web**: Story 2 changes nothing when no on-screen keyboard appears.
- **Keyboard opened while a long reply is streaming**: the newest content remains visible as it grows.
- **Screen reader**: the docked control announces its purpose, its open/closed state and the number of
  active filters; focus moves into the control when it opens and returns to the docked control when it
  closes.

## Requirements *(mandatory)*

### Functional Requirements

**Docked view options (collection screen)**

- **FR-001**: The collection screen MUST present the column selector, sort control and filter panel
  inside a single docked view-options control instead of inline above the movie list.
- **FR-002**: While docked, the view-options control MUST appear as a single compact bar, no taller
  than one standard control row, placed between the search bar and the count/"+ Add movie" row; the
  movie list MUST begin directly below the count row.
- **FR-003**: The search bar, collection name, count line and "+ Add movie" action MUST remain visible
  and behave as today; they are not moved into the control.
- **FR-004**: The control MUST be docked by default every time the collection screen is opened.
- **FR-005**: Opening the control MUST present every column, sort and filter choice available today,
  with the same single-select filter behaviour, the same "Clear" action and the same option sources.
- **FR-005a**: Opening the control MUST present its choices as a panel dropping down from the bar and
  overlaying the list; the list MUST NOT move or re-scroll when the panel opens or closes. The panel
  MUST stay within the visible area and scroll internally when its content is taller than the space.
- **FR-006**: Choices made in the open control MUST apply immediately to the list and count line and
  MUST NOT close the control.
- **FR-007**: The user MUST be able to re-dock the control by an explicit close action, by pressing the
  docked control again, and (Android) by the system Back action; re-docking MUST NOT navigate away from
  the collection.
- **FR-008**: While any filter is applied, the docked control MUST display the number of active filters.
- **FR-009**: Docking and undocking MUST NOT change, reset or re-persist the user's column, sort or
  filter choices.
- **FR-010**: The control MUST be docked, and behave the same, on web, Android and iOS at phone, tablet
  and desktop widths; there is no width at which the controls revert to the inline layout.

**Keyboard-safe assistant (mobile)**

- **FR-011**: When the on-screen keyboard is shown while the assistant panel is open, the message
  field, the text being typed and the send button MUST remain fully visible above the keyboard.
- **FR-011a**: FR-011–FR-014 apply to the native app on Android and iOS; Android MUST be verified by an
  automated mobile flow. Mobile web is in scope only if the defect is reproduced there during
  implementation.
- **FR-012**: While the keyboard is shown, the most recent conversation content MUST remain visible,
  including after a message is sent and while a reply is arriving.
- **FR-013**: When the keyboard is shown, the panel MUST stay within the visible area, shrinking if
  necessary, with its header/close control reachable.
- **FR-014**: When the keyboard is dismissed, the panel MUST return to its normal position and size.

**Shared**

- **FR-015**: The docked view-options bar and the assistant dock MUST NOT overlap each other or the
  "+ Add movie" action, and at most one of their panels MUST be open at a time: opening one docks the
  other.
- **FR-016**: Both controls MUST meet the project's accessibility rules: labelled, state announced
  (open/closed and active-filter count), visible focus, focus moved into the control on open and back to
  its toggle on close, and touch targets of at least 44×44 points.
- **FR-017**: Existing behaviour and automated tests that select columns, sort or filters MUST continue
  to work after opening the control first; no column, sort or filter capability is removed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a 360×640 phone screen, at least the first 3 movie rows are visible on opening a
  collection without scrolling, with filter options loaded (today the controls fill most of the first
  screen; the baseline is measured before implementation).
- **SC-002**: While docked, the view controls above the list take no more than one compact row (the
  docked bar), replacing today's column selector, sort control and filter panel.
- **SC-003**: A user can apply a filter and return to the full list in 3 presses or fewer (open, choose,
  close).
- **SC-004**: On an Android phone, the message field and typed text stay visible for 100% of keyboard
  open events in the assistant, verified by an automated mobile flow.
- **SC-005**: Every existing web and mobile end-to-end flow that exercises columns, sort, filters or the
  assistant passes, with changes limited to opening the control first.

## Assumptions

- **Sort, breakpoints, placement, open style and keyboard platforms** were settled in Clarifications
  (Session 2026-11-09). The search bar stays outside the dock because it is the primary way to find a
  movie. Mobile web browsers resize their own viewport for the keyboard, which is why it is excluded
  unless reproduced.
- **No backend change.** Filter options, counts and persisted view preferences keep their current
  sources; this is a frontend-only feature.
- Existing persistence of columns, sort and filters is reused as-is.
