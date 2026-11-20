# Feature Specification: Four small backlog fixes (items #941, #955, #530, #243)

**Feature Branch**: `fix/backlog-small-fixes`

**Created**: 2026-11-20

**Status**: Approved

**Input**: Operator, 2026-11-19: "do the combined small-fixes PR, watch to green, merge" — after a backlog
sweep found these four items small, still open on `main`, and independently attributable in CI.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The assistant re-asks when a year does not pick one film (Priority: P1) — item #941

A member asked "which Avatar?" replies "Avatar (2022)". Live TMDB lists three 2022 "Avatar" films, so
the reply does not say which. Today `resolve_option` falls through to the bare-title step and adds the
2009 "Avatar" — a film from a different year — with no question asked (contrary to FR-014, "re-ask,
never guess").

**Acceptance Scenarios**:

1. **Given** several offered options share the named year, **When** the reply carries no full title
   that separates them, **Then** `resolve_option` returns `None` (re-ask).
2. **Given** the reply carries a full title and its year ("Avatar: The Way of Water (2022)",
   "Avatar: Fire and Ash (2025)"), **Then** that option resolves.
3. **Given** a full title paired with a year it does not have, **Then** `None` (re-ask).

### User Story 2 - The last administrator is told why deletion is refused (Priority: P2) — item #955

`/bff-api/account/delete-challenge` answers `409 You are the only administrator` deliberately. The
screen shows "Please try again", which can never work.

**Acceptance Scenarios**:

1. **Given** the route answers 409, **Then** the banner says the account was not deleted, that this
   is the only administrator, and that another account needs the administrator role first.
2. **Given** any other failure, **Then** the banner stays generic and shows no server-supplied text.

### User Story 3 - Maestro flows wait for a card's children, not just the card (Priority: P3) — item #530

`agent-search.yaml` and `assistant-disambiguate.yaml` assert a movie card's children with a bare
`assertVisible` the instant the container appears; the async poster moves them, so the single sample
races layout.

**Acceptance Scenarios**:

1. Each such child assertion (and the text assertions that follow) is a bounded `extendedWaitUntil`
   (15 s) with a comment saying why.

### User Story 4 - The navigator container follows the app theme (Priority: P2) — item #243

React Navigation paints each screen container with its LIGHT default (rgb(242,242,242)) because the app
passes it no theme; the settings layout paints over it as a workaround.

**Acceptance Scenarios**:

1. **Given** dark mode, **Then** no painted ancestor of a routed screen computes rgb(242,242,242).
2. **Given** a runtime switch to light, **Then** the container repaints with the design-system light
   background, with no reload.
3. The feature-062 settings-layout background workaround is removed.

## Requirements *(mandatory)*

- **FR-001**: A year shared by more than one option narrows the pick to those options; only a full title
  among them resolves it; otherwise `resolve_option` returns `None`. Unique-year and no-year paths are
  unchanged.
- **FR-002**: A 409 from the delete challenge shows a client-authored last-administrator message; every
  other failure keeps the generic message. No response text is rendered.
- **FR-003**: The listed Maestro child/text assertions wait (bounded 15 s) instead of sampling once.
- **FR-004**: The root layout supplies React Navigation a theme derived from the design-system colour
  roles for the active app theme; the settings-layout background workaround is removed.

## Success Criteria *(mandatory)*

- **SC-001**: New `resolve_option` unit tests fail on `main` and pass after the change; the live-TMDB
  integration test asserts the year-bearing pick either way instead of skipping it.
- **SC-002**: The 409 screen test fails on `main` and passes after; the generic-failure test passes.
- **SC-003**: `agent-search` (CI agent flows) passes in this PR's `app-e2e`.
- **SC-004**: The new `theme.spec.ts` regression test passes in this PR's `app-e2e` gate tier.

## Out of scope

Android-side colour verification of FR-004 (no emulator in this sandbox; the CI mobile flows prove only
that screens still render). Item #806 (handshake billing) — separate PR by decision.
