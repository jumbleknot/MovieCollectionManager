# Feature 074 — A branded not-found route for mcm-app

**Backlog item:** #237 (`type/tech-debt`, `priority/p3`)
**Status:** spec
**Scope:** `frontend/mcm-app` only. No backend, no agent, no infrastructure change.

## Why

`frontend/mcm-app/src/app/` defines no `+not-found` route. Any address matching no route falls
through to Expo Router's built-in unmatched screen: an unstyled default carrying none of the app's
chrome, no navigation bar, and no way back other than the browser's Back button.

This is pre-existing and applies to every mistyped address. Feature 062 (`062-settings-split`) made
it reachable by anyone holding an old bookmark: it removed `/(app)/profile` and
`/(app)/admin/settings` outright rather than redirecting them — an operator decision recorded in
`specs/062-settings-split/research.md` §R1, taken on the measured basis that the admin address had
no in-app affordance at all until shortly before it was removed. Both addresses now land on the
default unmatched screen.

062 deliberately did not fix this: adding an app-wide concern to a navigation refactor would make a
red CI result ambiguous about which change caused it.

## User story

**US1 — a user who follows a dead address is told so, and is offered a way back.**

As a user who has followed an old bookmark or mistyped an address, I want the app to tell me the
address does not exist and offer me a single way back to the app, so that I am not stranded on an
unstyled default screen whose only escape is the browser's Back button.

- **US1-AC1** — Visiting an address that matches no route renders a screen identifying itself as
  `not-found-screen`.
- **US1-AC2** — That screen states, in words, that the address was not found.
- **US1-AC3** — That screen offers exactly one affordance back into the app, and activating it
  places the user on `/(app)/home`.
- **US1-AC4** — Visiting `/(app)/profile` or `/(app)/admin/settings` — the two addresses feature 062
  removed — renders that screen, with the app's navigation bar present.

## Functional requirements

- **FR-001** — `frontend/mcm-app/src/app/+not-found.tsx` exists and renders a screen component
  imported from `frontend/mcm-app/src/screens/`. The route file holds no screen content of its own,
  per the Screens-Layer rule (routes never define screen components).
- **FR-002** *(REVISED after measurement — see plan.md §"The (app)-group route, and why it was
  removed")* — the screen renders the app's `NavigationBar` itself when the visitor is
  authenticated, so an unmatched *authenticated* address — including the two that feature 062
  removed — keeps the app's chrome. An anonymous visitor sees the branded screen without it,
  because every nav link points at an authenticated destination.

  **Superseded wording:** "a second route at `src/app/(app)/+not-found.tsx` inherits `AuthGuard`
  and `NavigationBar` from `(app)/_layout.tsx`." That route was built and measured **unreachable**:
  Expo Router groups are URL-transparent, so `/(app)/profile` normalizes to `/profile`, which
  cannot be attributed back to the group, and the root route of FR-001 takes every unmatched
  address. The file was deleted rather than shipped as dead code.
- **FR-003** — The screen carries the `testID` `not-found-screen` on a **React Native host node**
  (a `View` imported from `react-native`), so it resolves as `data-testid` on web and `id` on
  native. A `testID` placed on a Tamagui component can be dropped on React Native Web — see the
  note in `packages/design-system/components/navigation/Tabs.tsx`.
- **FR-004** — The screen states that the address was not found and offers exactly one affordance
  back to `/(app)/home`.
- **FR-005** — The screen is composed from `@mcm/design-system` primitives and theme tokens. No
  ad-hoc `StyleSheet` colours and no ad-hoc spacing values; `StyleSheet` carries layout only, on
  the base-8 grid, matching the pattern established by
  `frontend/mcm-app/src/screens/settings/backups-settings-screen.tsx`.
- **FR-006** — The screen renders correctly in both the light and the dark theme, because every
  colour is read from a theme role rather than written literally.

## Success criteria

- **SC-001** — A unit test for the screen passes, having first been observed RED against absent
  implementation (the repository's TDD checkpoint format).
- **SC-002** — Web E2E: navigating to an address matching no route renders `not-found-screen`, and
  the affordance returns the user to the home route.
- **SC-003** — The two existing "old addresses" cases in
  `frontend/mcm-app/tests/e2e/web/settings.spec.ts` gain their positive half. They currently assert
  only what is ABSENT; they keep those assertions and add that `not-found-screen` is present.
- **SC-004** — No test is disabled, skipped, or weakened to accommodate this change.

## Out of scope

- **Redirecting the two removed addresses.** That decision was taken and recorded in feature 062
  §R1. This feature is about what an unmatched address renders, not about resurrecting routes.
- **Any change to authenticated routing or to `AuthGuard`.** FR-002 places a route inside the
  existing `(app)` group and inherits its behaviour unchanged; it does not modify the guard.
- **A native (Maestro) flow.** The two E2E surfaces named in SC-002/SC-003 are web.
