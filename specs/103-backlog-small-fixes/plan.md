# Implementation Plan: Four small backlog fixes

**Branch**: `fix/backlog-small-fixes` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)

## Summary

One PR, four independent fixes. Batched per `openwiki/process/pull-request-batching.md`: a red build
names its cause — movie-assistant pytest (#941), the account-settings screen test (#955), a Maestro
flow (#530), or a web E2E background assertion (#243).

1. **#941** `agents/movie-assistant/src/nodes/supervisor.py`: factor step 3's longest-title-first match
   into `_full_title_in(low, options)`; when the year step finds more than one option, return
   `_full_title_in(low, matches)` instead of falling through.
2. **#955** `frontend/mcm-app/src/screens/settings/account-settings-screen.tsx`: map a caught error with
   `response.status === 409` to a fixed `lastAdmin` message; everything else stays `challenge`.
3. **#530** the two Maestro YAML flows: bare `assertVisible` on card children → `extendedWaitUntil`
   (15 s).
4. **#243** new `src/utils/navigation-theme.ts` (DarkTheme/DefaultTheme + DS colour roles), wrapped
   around the root `<Stack>` with expo-router's `ThemeProvider`, keyed on `useTheme().theme`; remove
   the settings layout's `backgroundColor`.

## Technical Context

Python 3.14 / pytest / ruff / mypy (movie-assistant). TypeScript, Expo Router 58 (re-exports React
Navigation's `ThemeProvider`, `DarkTheme`, `DefaultTheme`), Tamagui, Jest, Playwright, Maestro. No new
dependencies.

## Constitution Check

TDD: each test task has Verify RED before its implementation. FR-014 (re-ask, never guess) is
strengthened. No server text reaches the client in #955 (never-leak rule). No auth, logging or data
changes.

## Risk

- #941: a reply with a shared year that previously resolved via an ordinal or index ("the first 2022
  one") now re-asks. Accepted: the year narrows, and a re-ask is FR-014's safe outcome.
- #243: on Android the native stack also adopts the theme's background — the intended effect; colour
  is not asserted on the emulator (spec Out of scope).
