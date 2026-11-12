# Feature Specification: "View & filter options" — rename, and give the open pane the screen's height

**Feature Branch**: `099-view-filter-options-height`

**Created**: 2026-11-11

**Status**: Approved

**Input**: User description: "some great work was done in feature 098-docked-filters-keyboard, but now we
need to refine it — 'View options' should be 'View & filter options'. When the view options pane is open,
it does not give enough vertical space to select filters. This is true on both web and mobile, but
especially mobile where there is almost no space to even see the filters. And on the screens where I
tested there was plenty of vertical screen space available to expand the pane."

## Context (what the user sees today)

Feature 098 moved the column selector, sort control and filter panel behind a docked bar. The open pane
may already grow to the full height of the area below the bar, but the filter panel inside it still
carries its pre-098 inline sizing: a fixed `maxHeight: 220` and its own nested vertical `ScrollView`.
After the column and sort rows, the filters get a ~220px window whatever the screen height, scrolled
by a scroller nested inside the pane's scroller (awkward on touch). Each category is also a single
horizontally scrolling row of chips, so most genres/languages sit off-screen to the right.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pick filters in a pane that uses the space available (Priority: P1)

A user opens a collection on a phone, presses "View & filter options", and sees as many filter
categories and chips as the screen can hold, without the filters being confined to a small window.

**Independent Test**: At 360×640 (web) with the BROWSE fixture, open the pane: the filter panel has no
internal vertical scroll, no chip lies outside the pane horizontally, and the pane extends past the
old 220px filter window.

**Acceptance Scenarios**:

1. **Given** the pane is open, **When** its content is taller than the space below the bar, **Then** the
   pane fills that space and scrolls as ONE scroller (no nested vertical scroller).
2. **Given** the pane is open, **When** a filter category has more chips than fit across, **Then** the
   chips wrap onto further lines instead of scrolling sideways.
3. **Given** filters are active and the pane is scrolled to any position, **When** the user looks at the
   pane header, **Then** "Clear Filters" and "Close" are both visible there.

### User Story 2 - The control says it holds filters (Priority: P2)

**Acceptance Scenarios**:

1. **Given** the collection screen, **Then** the docked bar reads "View & filter options" and its
   accessible name is "View & filter options" or "View & filter options, N filter(s) active".
2. **Given** the pane is open, **Then** its heading reads "View & filter options" and its close button's
   accessible name is "Close view & filter options".

## Requirements *(mandatory)*

- **FR-001**: The bar label, the pane heading and the accessible names use "View & filter options".
- **FR-002**: The filter panel has no fixed height cap and no vertical scroller of its own; the pane's
  single body scroller is the only vertical scroller, and the pane may grow to the full height of the
  area below the bar (098 FR-005a overlay behaviour unchanged).
- **FR-003**: Filter chips in each category wrap onto multiple lines.
- **FR-004**: "Clear Filters" (`filter-clear-button`, shown only while a filter is active) sits in the
  pane's fixed header beside "Close", outside the scroller, as the same DS `Button variant="text"
  size="sm"` as Close so the two header actions match.
- **FR-005**: Every existing testID is unchanged, so Maestro flows and E2E selectors keep working.

## Success Criteria *(mandatory)*

- **SC-001**: At 360×640 with the BROWSE fixture and the pane open, `movie-filter-panel` has
  `scrollHeight <= clientHeight` (no internal scroll) and every `filter-chip-*` lies horizontally within
  `view-options-panel`.
- **SC-002**: At 360×640 the open pane is taller than 400px when its content exceeds that (it was capped
  by the 220px filter window before).

## Out of scope

Column selector and sort control layout (already a single row each); the assistant dock; any backend.
