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

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the movie list without the view controls in the way (Priority: P1)

A user opens a collection on their phone. The column selector, sort control and filters are collapsed
into one compact, docked "View options" control, so the movie list starts directly below the search bar
and count line. When they want to change what they see, they open the control, pick columns, a sort and
filters, and close it again to see the updated list on the full screen.

**Why this priority**: This is the space problem the user reported, on the screen they use most. It is
viable alone: delivering only this story removes the cause of the complaint.

**Independent Test**: On a phone-sized screen, open a collection: the first movie row is visible
without scrolling and no filter chips or column toggles are shown. Open the control, apply a filter,
close it: the list shows only matching movies and the controls are gone again.

**Acceptance Scenarios**:

1. **Given** a user opens a collection, **When** the screen loads, **Then** the column selector, sort
   control and filter panel are not shown, a single docked view-options control is shown instead, and
   the list begins directly below the search bar and the count/"+ Add movie" row.
2. **Given** the control is docked, **When** the user presses it, **Then** the column, sort and filter
   choices open over the screen with every choice available today still available.
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

On the collection screen both docked controls are present. They never overlap each other, the "+ Add
movie" action or list rows a user needs to reach, and opening one does not leave the other open
underneath it.

**Why this priority**: A quality bar for Story 1 rather than new capability; without it Story 1 can
introduce new obstructions.

**Independent Test**: On phone and desktop widths, both docked controls and "+ Add movie" are visible
and each can be pressed; opening the view options while the assistant is open closes the assistant (and
vice versa).

**Acceptance Scenarios**:

1. **Given** the collection screen, **When** both controls are docked, **Then** neither control overlaps
   the other or the "+ Add movie" action, and the last row of the list can be scrolled into a position
   where it is not covered.
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
- **FR-002**: While docked, the view-options control MUST add no vertical space to the screen's
  content: the movie list MUST begin directly below the search bar and the count/"+ Add movie" row.
- **FR-003**: The search bar, collection name, count line and "+ Add movie" action MUST remain visible
  and behave as today; they are not moved into the control.
- **FR-004**: The control MUST be docked by default every time the collection screen is opened.
- **FR-005**: Opening the control MUST present every column, sort and filter choice available today,
  with the same single-select filter behaviour, the same "Clear" action and the same option sources.
- **FR-006**: Choices made in the open control MUST apply immediately to the list and count line and
  MUST NOT close the control.
- **FR-007**: The user MUST be able to re-dock the control by an explicit close action, by pressing the
  docked control again, and (Android) by the system Back action; re-docking MUST NOT navigate away from
  the collection.
- **FR-008**: While any filter is applied, the docked control MUST display the number of active filters.
- **FR-009**: Docking and undocking MUST NOT change, reset or re-persist the user's column, sort or
  filter choices.
- **FR-010**: The control MUST behave the same on web, Android and iOS, at phone, tablet and desktop
  widths.

**Keyboard-safe assistant (mobile)**

- **FR-011**: When the on-screen keyboard is shown while the assistant panel is open, the message
  field, the text being typed and the send button MUST remain fully visible above the keyboard.
- **FR-012**: While the keyboard is shown, the most recent conversation content MUST remain visible,
  including after a message is sent and while a reply is arriving.
- **FR-013**: When the keyboard is shown, the panel MUST stay within the visible area, shrinking if
  necessary, with its header/close control reachable.
- **FR-014**: When the keyboard is dismissed, the panel MUST return to its normal position and size.

**Shared**

- **FR-015**: The docked view-options control and the assistant dock MUST NOT overlap each other or the
  "+ Add movie" action, and at most one of them MUST be open at a time.
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
- **SC-002**: The vertical space taken by view controls above the list while docked is zero; only the
  existing search bar and count row remain.
- **SC-003**: A user can apply a filter and return to the full list in 3 presses or fewer (open, choose,
  close).
- **SC-004**: On an Android phone, the message field and typed text stay visible for 100% of keyboard
  open events in the assistant, verified by an automated mobile flow.
- **SC-005**: Every existing web and mobile end-to-end flow that exercises columns, sort, filters or the
  assistant passes, with changes limited to opening the control first.

## Assumptions

- **The sort control moves into the dock too.** The user named column selectors and filters; sort sits
  between them today and causes the same space problem, so it is grouped with them. The search bar
  stays outside because it is the primary way to find a movie.
- **Docked on all widths, not only mobile.** One behaviour everywhere is simpler to learn and test; on
  desktop the gain is smaller but the cost is a single press.
- **The open control overlays the screen** (like the assistant panel) rather than pushing the list
  down; the list is visible again as soon as it closes.
- **Placement is a design decision for the plan**, constrained by FR-002 and FR-015: the assistant
  toggle occupies the bottom-left and "+ Add movie" sits right-aligned in the count row.
- **Story 2 targets the native app (Android first, iOS where supported).** Mobile web browsers resize
  their own viewport for the keyboard; if a mobile-web reproduction is found it is handled under this
  story, otherwise it is out of scope.
- **No backend change.** Filter options, counts and persisted view preferences keep their current
  sources; this is a frontend-only feature.
- Existing persistence of columns, sort and filters is reused as-is.
