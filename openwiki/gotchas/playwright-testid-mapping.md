---
type: Gotcha
title: Playwright testID mapping — React Native Web renders testID as data-testid
description: React Native Web renders the RN testID prop as a data-testid DOM attribute, and playwright.config.ts sets testIdAttribute to data-testid so Playwright locators can target it — a mismatch here breaks every getByTestId-style selector across the web E2E suite.
resource: frontend/mcm-app/playwright.config.ts
tags: [playwright, react-native-web, e2e, frontend]
timestamp: 2026-07-30T11:50:53-04:00
---

# Playwright testID mapping — React Native Web renders testID as data-testid

React Native components take a `testID` prop, not a web `data-testid` attribute. When
[the Expo/React Native app](/openwiki/projects/expo-app.md) is compiled for web via React Native
Web, `testID` is rewritten to the DOM attribute `data-testid`. `playwright.config.ts` sets
`testIdAttribute: 'data-testid'` (see the inline comment "React Native Web renders testID as
data-testid") so that `page.getByTestId(...)` and `[data-testid="..."]` locators resolve against
components authored with `testID`, not a web-only attribute.

## Gotcha

- **Every `data-testid` selector in `tests/e2e/web/**` depends on this config line matching React
  Native Web's actual output attribute.** If a future Playwright default changes (its default test-id
  attribute is `data-testid` already, but do not rely on the default silently staying correct) or the
  RN Web version changes how `testID` is rewritten, every test using `[data-testid="..."]` or
  `getByTestId()` breaks at once, across the entire web E2E suite — not just one spec.
- Author components with `testID`, never a raw `data-testid` prop directly, so the same source works
  for both the Playwright web suite and Maestro's native mobile suite.
