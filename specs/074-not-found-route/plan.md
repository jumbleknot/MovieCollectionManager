# Feature 074 — plan

**Spec:** `specs/074-not-found-route/spec.md`
**Branch:** `074-not-found-route`

## Scope of the artifact set

Deliberately a minimal three-artifact set (spec → plan → tasks), not the full Spec Kit output.
There is no research question, no data model, no API contract and no multi-step operator
procedure in a one-screen presentational change; a `research.md`, `data-model.md`, `contracts/`
and `quickstart.md` would each be empty ceremony. The SDD gate asks for spec → plan → tasks before
implementation code under `frontend/`, and that is what this set is. Operator decision, taken at
the start of this session.

## Tech stack

Unchanged from the rest of `frontend/mcm-app`:

- **Expo Router** for the route files (`+not-found.tsx` is its reserved unmatched-route filename).
- **React Native** `View` for the host node that carries the `testID`.
- **`@mcm/design-system`** (`Card`, `CardHeader`, `CardContent`, `Button`) for everything visible.
- **`@tamagui/core`** `Text` and `useTheme` for body copy and theme-role colour lookup.
- **jest / jest-expo** via `pnpm nx test mcm-app` for the unit test.
- **Playwright** via the web E2E suite for `settings.spec.ts`.

## Design

### Two route files, one screen

```
frontend/mcm-app/src/app/
  +not-found.tsx              → NotFoundScreen   (the ONLY route; catches everything)
frontend/mcm-app/src/screens/
  not-found-screen.tsx        the screen — renders NavigationBar itself when authenticated
  not-found-screen.test.tsx   its unit test
```

*(As built. The design below was written around a second route inside the `(app)` group; it was
measured unreachable and removed — see §"The (app)-group route, and why it was removed".)*

The root `+not-found.tsx` is the catch-all. An address outside the `(app)` group has no
authenticated session to draw chrome from, so it renders the screen bare — still branded, still
offering the way back.

The `(app)/+not-found.tsx` is what makes FR-002 worth having: `/(app)/profile` and
`/(app)/admin/settings` resolve inside the group, so Expo Router prefers the group's `+not-found`
over the root one and the screen renders inside `(app)/_layout.tsx` — with the navigation bar the
backlog item's problem statement asks for. It inherits `AuthGuard` unchanged; a signed-out visitor
to one of those addresses is bounced to login exactly as they are for any other `(app)` address,
which is existing behaviour and not something this feature alters.

The screen itself is placed at `src/screens/not-found-screen.tsx` rather than under a subdirectory.
The existing subdirectories (`home/`, `settings/`, `collections/`, `movies/`, `admin/`, `auth/`)
each group a feature area; not-found belongs to no area.

### Where the testID goes (FR-003)

`testID="not-found-screen"` sits on a plain `react-native` `View`, not on a Tamagui component.
`packages/design-system/components/navigation/Tabs.tsx` documents that a Tamagui component can
fail to forward `testID` → `data-testid` on React Native Web. The same host-node placement is
already used by `src/screens/settings/backups-settings-screen.tsx`.

The affordance's own `testID` (`not-found-home-link`) goes on the design system's `Button`,
following `src/components/profile-display.tsx`'s `btn-logout` — which is located in a real
Playwright run as `[data-testid="btn-logout"]`
(`frontend/mcm-app/tests/e2e/web/bff-prod-lifecycle.spec.ts`), so that placement is measured to
work rather than assumed. T004's E2E is what re-proves it for this screen.

### Navigation back (FR-004)

`useRouter().replace('/(app)/home')` — `replace`, not `push`, so the dead address does not stay in
the history stack behind the home screen. This matches
`src/screens/movies/new-movie-screen.tsx`'s redirect-after-create.

### Theming (FR-005, FR-006)

Every colour is read at the JSX site from a theme role (`theme.background?.val`,
`theme.onSurfaceVariant?.val`), never written as a literal in the `StyleSheet`. `StyleSheet` carries
`flex` and `padding` only, on the base-8 grid. This is the feature-017 D6 rule that a declared
style cannot drift from the rendered colour, and it is what makes FR-006 true by construction
rather than by a second visual test.

## Testing approach

| Tier | What it covers | Command |
|---|---|---|
| Unit (jest) | The screen renders, states not-found, offers the affordance, and the affordance calls `router.replace('/(app)/home')` | `pnpm nx test mcm-app` |
| Lint | ESLint over the changed files | `pnpm nx lint mcm-app` |
| Typecheck | TS over the app | `pnpm nx typecheck mcm-app` |
| Web E2E | SC-002 and SC-003 — the unmatched address renders the screen and the affordance returns home | the web E2E suite, `settings.spec.ts` |

The tiers are derived from what the diff touches (`frontend/mcm-app` TS/TSX only), per the
"run the test tiers your DIFF touches" rule. Nothing under `backend/`, `agents/`,
`mcp-servers/` or `packages/design-system/` changes, so their tiers are not implicated.

**RED is observed by absence, not by mutation.** The screen does not exist when T001 is written, so
the unit test fails on an unresolved import — a genuine RED, and the test-only-feature trap
(`openwiki/process/spec-driven-development.md`: "when the behavior under test already exists, a
compile error is not an acceptable RED") does not apply here, because the behaviour under test does
not already exist.

## The (app)-group route, and why it was removed

**The risk this plan named came true, and the detector worked.** The plan above was written around
two route files, the second inside the `(app)` group so that an unmatched authenticated address
would inherit `AuthGuard` and `NavigationBar` from `(app)/_layout.tsx`. It named the assertion that
would detect the design being wrong, and pre-committed to a fallback rather than to weakening it.

**Measured, web E2E against the dev-container BFF:** `/(app)/profile` and `/(app)/admin/settings`
rendered the branded screen with **no navigation bar**. The group's `+not-found` never rendered at
all. The cause is not a bug: **Expo Router groups are URL-transparent**, so `/(app)/profile`
normalizes to `/profile`, and an unmatched path carries nothing that could attribute it back to a
group. The root `+not-found` takes every unmatched address, always, and a group-scoped one is dead
code.

**The instrument was checked before the result was believed.** `getByTestId('navigation-bar')` sits
on a Tamagui `XStack`, which is exactly the node type that can drop `testID` → `data-testid` on
React Native Web — so the failure could have been the selector rather than the routing. It is not:
`auth.spec.ts`'s "shows navigation bar and profile display" uses the same selector and passes
(re-run in isolation: 1 passed, 2.5 s). Only then was the routing conclusion drawn.

**Resolution, taken by the operator rather than the pre-committed fallback.** The fallback was
root-only *without* chrome, which would have half-fixed item #237 — the missing navigation bar was
half of what it reported. Instead: `src/app/(app)/+not-found.tsx` is deleted, and `NotFoundScreen`
renders `NavigationBar` itself when `useAuth()` reports the visitor authenticated. The root layout
already supplies `AuthProvider` and `ThemeProvider`, and `NavigationBar` needs nothing else — it
does not use `useAuth`. The E2E assertion was **kept exactly as written** and now passes on merit.

This is also why the unit test gained an AsyncStorage mock and a `ThemeProvider` wrapper: rendering
`NavigationBar` reaches `use-theme` → `@react-native-async-storage/async-storage`. Same mock and
wrapper as `src/components/navigation-bar.test.tsx`.

## Risks

- **Resolved:** the group-route risk above. Recorded rather than deleted, because the reasoning is
  the reusable part.
- **A shared-hook-style regression is not a risk here.** Nothing in this change is loaded by other
  specs; it adds one leaf route and one leaf screen.
