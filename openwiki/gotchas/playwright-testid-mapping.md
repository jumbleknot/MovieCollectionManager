---
type: Gotcha
title: Playwright testID mapping — React Native Web renders testID as data-testid
description: React Native Web renders the RN testID prop as a data-testid DOM attribute, and playwright.config.ts sets testIdAttribute to data-testid so Playwright locators can target it — a mismatch here breaks every getByTestId-style selector across the web E2E suite.
resource: frontend/mcm-app/playwright.config.ts
tags: [playwright, react-native-web, e2e, frontend]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-29T10:29:14.990Z
sources:
  - id: openwiki-source-d3d6462458271e37e692275f
    resource: repo://frontend/mcm-app/playwright.config.ts
  - id: openwiki-source-75c613635390ab18cc167ec1
    resource: repo://frontend/mcm-app/README.md
  - id: openwiki-source-86d9e16e8c227d41470126a4
    resource: repo://frontend/mcm-app/scripts/cleanup-e2e-data.ts
  - id: openwiki-source-5d50b9f7c460fe00f48c21b8
    resource: repo://frontend/mcm-app/src/components/loading-indicator.tsx
  - id: openwiki-source-75c19a7a987cb93703567f26
    resource: repo://frontend/mcm-app/src/screens/not-found-screen.tsx
  - id: openwiki-source-a080f70739805ca715a99c22
    resource: repo://frontend/mcm-app/tests/e2e/mobile/home-screen.yaml
  - id: openwiki-source-fb2c95e423345fb3da997889
    resource: repo://frontend/mcm-app/tests/e2e/web/a11y.spec.ts
  - id: openwiki-source-2d7a83a560ab6dec0daf8651
    resource: repo://frontend/mcm-app/tests/e2e/web/backups.spec.ts
  - id: openwiki-source-7ca6b85c219d4fdef050a7aa
    resource: repo://frontend/mcm-app/tests/e2e/web/setup/assistant-turn.ts
  - id: openwiki-source-bfd1dcd66339cb51fd41729c
    resource: repo://frontend/mcm-app/tests/e2e/web/setup/global-setup.ts
  - id: openwiki-source-a9f8640b2ea19387ecec6be5
    resource: repo://packages/design-system/components/navigation/NavList.tsx
  - id: openwiki-source-e3cf144619c81072e7ba6980
    resource: repo://packages/design-system/components/navigation/Tabs.tsx
generated: { by: "openwiki/0.6.0", at: "2026-09-29T10:29:14.990Z" }
---

# Playwright testID mapping — React Native Web renders testID as data-testid

React Native components take a `testID` prop, not a web `data-testid` attribute. When
[the Expo/React Native app](../projects/expo-app.md) is compiled for web via React Native
Web, `testID` is rewritten to the DOM attribute `data-testid`. `playwright.config.ts` sets
`testIdAttribute: 'data-testid'` (see the inline comment "React Native Web renders testID as
data-testid") so that `page.getByTestId(...)` and `[data-testid="..."]` locators resolve against
components authored with `testID`, not a web-only attribute.

As of this refresh the config still carries both halves at `frontend/mcm-app/playwright.config.ts`
— the comment on the line above and `testIdAttribute: 'data-testid'` in the `use` block — so no
part of the original claim has moved or changed.

## Gotcha

- **Every `data-testid` selector in `tests/e2e/web/**` depends on this config line matching React
  Native Web's actual output attribute.** If a future Playwright default changes (its default test-id
  attribute is `data-testid` already, but do not rely on the default silently staying correct) or the
  RN Web version changes how `testID` is rewritten, every test using `[data-testid="..."]` or
  `getByTestId()` breaks at once, across the entire web E2E suite — not just one spec.
- Author components with `testID`, never a raw `data-testid` prop directly, so the same source works
  for both the Playwright web suite and Maestro's native mobile suite.
- **The rewrite only happens on a React Native host node.** A `testID` placed on a Tamagui
  component (a Tamagui `View`, `Card`, `Tabs` internals) is *not* forwarded to `data-testid` on
  React Native Web, so that selector is silently unreachable from Playwright — no error, just a
  locator that never matches. This is why every stable external-contract selector lives on a plain
  RN `View` / `Pressable` host node, with the visual treatment staying on the Tamagui component
  nested inside it (`packages/design-system/components/navigation/Tabs.tsx` and `NavList.tsx`
  document the trap; `src/screens/not-found-screen.tsx` shows the same discipline applied
  directly to a screen node).

The rewrite is also why one authored prop serves three consumers: the RN host node maps `testID` →
`data-testid` on web and → `id` on native, so the Jest/RNTL unit tests, the Playwright web specs and
the Maestro YAML flows (`tests/e2e/mobile/*.yaml`, which assert `id: "home-route"` and friends) all
locate the same element. That is why `frontend/mcm-app/README.md` states "Preserve every `testID`"
and points at the recorded selectors baseline as a contract: renaming one silently splits the web
and mobile suites apart.

The coupling extends beyond the spec files. `tests/e2e/web/setup/global-setup.ts` and the helpers
under `tests/e2e/web/setup/` drive the shared login and fixture seeding through the same
`[data-testid="..."]` locators, and `scripts/cleanup-e2e-data.ts` uses them too — so a testID
mismatch fails before any spec body runs, in setup, and is easy to misread as an auth or boot
problem rather than a selector-mapping problem.

See [Testing tiers and what gates a merge](../invariants/testing-tiers.md) for which web/mobile E2E
tests block a merge, and the [E2E testing runbook](../runbooks/e2e-testing.md) for how to run the
suites and which BFF target each mode uses.
