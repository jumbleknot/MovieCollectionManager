# Implementation Plan: "View & filter options" — rename and full-height pane

**Branch**: `099-view-filter-options-height` | **Date**: 2026-11-11 | **Spec**: [spec.md](./spec.md)

## Summary

Frontend-only change to `mcm-app`, one PR. Refines feature 098 US1.

1. **Rename** (`view-options-dock.tsx`): bar label, panel heading, `dockLabel()`, close button
   accessibility label.
2. **Full height** (`movie-filter-panel.tsx`): drop `maxHeight: 220`/`minHeight` and the nested vertical
   `ScrollView`; the panel's existing body `ScrollView` (`view-options-dock.tsx`) is the only vertical
   scroller. The panel's `maxHeight: '100%'` of the list area already allows the full height.
3. **Wrap chips** (`movie-filter-panel.tsx`): replace each section's horizontal `ScrollView` with a
   `View` using `flexWrap: 'wrap'`.
4. **Header action** (`view-options-dock.tsx`, `movie-filter-panel.tsx`, `collection-screen.tsx`):
   `ViewOptionsPanel` gains an optional `headerAction` slot rendered beside Close; `MovieFilterPanel`
   stops rendering Clear and exports `ClearFiltersButton` (same testID, label and a11y label), which the
   screen passes as `headerAction` while a filter is active.

## Technical Context

TypeScript, React Native 0.88 / RN-Web, Expo Router, Tamagui `@mcm/design-system`. No new dependencies.
Testing: Jest (`jest-expo`), Playwright web E2E (`@gate`), Maestro (testIDs unchanged, flows unedited).

## Constitution Check

TDD: each test task has a Verify RED before its implementation. No backend, auth, logging or data
changes. Accessibility: touch targets unchanged; accessible names updated with the visible label.

## Risk

- Maestro taps chips by id; wrapping makes MORE chips visible, never fewer, so no flow edit is needed.
- `openwiki/projects/expo-app.md` cites app sources; refresh via wiki-refresh if V17 reports it stale.
