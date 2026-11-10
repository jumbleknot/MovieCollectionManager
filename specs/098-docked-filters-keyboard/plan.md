# Implementation Plan: Docked view options and keyboard-safe assistant

**Branch**: `098-docked-filters-keyboard` | **Date**: 2026-11-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/098-docked-filters-keyboard/spec.md` (clarified 2026-11-09)

## Summary

This is a frontend-only change to `mcm-app`, in one pull request (see PR shape below).

1. **Story 1 (view options).** On the collection screen, the inline column selector, sort control and
   filter panel are replaced by a `ViewOptionsDock`. It is a compact bar between the search row and the
   count row, with an active-filter badge. Pressing it drops a `ViewOptionsPanel` down over the list. The
   panel hosts the three existing components unchanged, so the props, testIDs and persistence stay the same.
2. **Story 2 (keyboard).** A `useKeyboardInset()` hook, built on React Native's `Keyboard` events, lifts the
   absolutely positioned assistant dock by the keyboard height. It also caps the panel's height to the
   space above the keyboard.
3. **Story 3 (no collisions).** An `OpenPanelProvider` context in the `(app)` layout lets at most one of the
   two overlays be open at a time.

Design decisions and rejected alternatives are in [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript (React 19.3, React Native 0.88.1) on Node 24.14.1

**Primary Dependencies**: Expo SDK ~58.0.23, Expo Router, Tamagui 3.0.18 with `@mcm/design-system`
(`Badge`, `Button`, `IconButton`, surface and elevation tokens), `react-native-safe-area-context`. **No new
dependencies.**

**Storage**: none new. Column, sort and filter persistence is reused unchanged.

**Testing**: Jest (`jest-expo`) unit tests, Playwright web E2E (`@gate` tier), Maestro Android flows

**Target Platform**: web, Android (verified on the KVM emulator), iOS (best effort, no runner here)

**Project Type**: universal mobile and web app (`frontend/mcm-app`)

**Performance Goals**: the panel opens and closes within one frame of the press, with no list re-layout.
The dock follows the keyboard within one keyboard-event tick.

**Constraints**: the web entry chunk stays under the 2,000,000-byte `bundle-budget`. Nothing new imports the
assistant runtime (feature 077). All styling uses design-system tokens. Touch targets are at least 44 pt
(WCAG 2.2 AA).

**Scale/Scope**: about 4 new source files, 3 edited source files, 1 new web spec, 1 new Maestro flow, and
5 edited E2E files

## Constitution Check

*GATE: checked before Phase 0, and re-checked after Phase 1.*

| Principle | Status | How |
|---|---|---|
| Universal Frontend Apps | ✅ | one shared component tree for web, Android and iOS; the only platform branches are `BackHandler` (native) and Escape (web) |
| No Domain Logic | ✅ | the active-filter count is a presentation count of already-held filter state; no domain rules move to the client |
| Accessibility First (WCAG 2.2 AA) | ✅ | role, expanded state and count in the label, focus moved on open and close, 44 pt targets (research R5) |
| Performance Budgeting / lazy-loading | ✅ | no assistant-runtime import in new entry-chunk code; `bundle-budget` in the quickstart |
| Responsive & Adaptive Design | ✅ | same behaviour at every width (clarify Q2); the panel caps itself to the visible area |
| Design System | ✅ | composed from DS `Badge`/`Button`/`IconButton` and tokens; no hard-coded colours or spacing |
| User-Centric Naming | ✅ | `ViewOptionsDock`, `ViewOptionsPanel`, `useKeyboardInset`, `OpenPanelProvider` |
| Test-Driven Development | ✅ | every task runs Verify RED then Verify GREEN; Story 2's RED is an emulator reproduction on `main` (T001) |
| Security / Logging | n/a | no data, auth, network or logging change |

**Post-design re-check**: no violations. Complexity Tracking is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/098-docked-filters-keyboard/
├── spec.md
├── plan.md                 # this file
├── research.md             # R1–R7
├── data-model.md           # OpenPanel, ActiveFilterCount, KeyboardInset (client state only)
├── quickstart.md           # validation guide
├── contracts/ui-contract.md
├── checklists/requirements.md
└── tasks.md                # produced by /speckit-tasks
```

### Source Code

```text
frontend/mcm-app/
├── src/
│   ├── app/(app)/_layout.tsx                       # EDIT: mount OpenPanelProvider
│   ├── hooks/
│   │   ├── use-open-panel.tsx                      # NEW: OpenPanel context (FR-015)
│   │   ├── use-open-panel.test.tsx                 # NEW
│   │   ├── use-keyboard-inset.ts                   # NEW: keyboard height (FR-011–014)
│   │   └── use-keyboard-inset.test.ts              # NEW
│   ├── components/
│   │   ├── view-options-dock.tsx                   # NEW: bar, badge, panel, Back/Escape, focus
│   │   ├── unit-tests/view-options-dock.test.tsx   # NEW
│   │   ├── movie-filter-panel.tsx                  # EDIT: use the shared countActiveFilters()
│   │   └── agent/
│   │       ├── assistant-dock.tsx                  # EDIT: open via context; bottom += inset
│   │       ├── assistant-dock.test.tsx             # EDIT
│   │       └── assistant-panel.tsx                 # EDIT: height cap; re-scroll on inset change
│   ├── utils/active-filters.ts                     # NEW: countActiveFilters()
│   └── screens/collections/
│       ├── collection-screen.tsx                   # EDIT: replace 3 inline controls with the dock
│       └── collection-screen.test.tsx              # EDIT
└── tests/e2e/
    ├── web/collection-view-options.spec.ts         # NEW (@gate): SC-001, SC-003, FR-007/008/015
    ├── web/movies.spec.ts                          # EDIT: openViewOptions(page) helper
    └── mobile/
        ├── assistant-keyboard.yaml                 # NEW: SC-004
        └── movie-{sort,browse,count,search-filter}.yaml   # EDIT: tap view-options-toggle
```

**Structure Decision**: everything stays inside `frontend/mcm-app`. Nothing new goes into
`packages/design-system`. The dock is screen-specific composition of existing DS parts, and promoting it
can wait for a second user.

## PR shape

One PR, under the [batching rule](../../openwiki/process/pull-request-batching.md). The two stories touch
disjoint files and disjoint test suites, so a red check identifies its story by the suite that failed:
`movies.spec.ts` or `collection-view-options.spec.ts` for Story 1, the assistant suites for Story 2.

## Risks

- **Story 2's root cause is inferred, not yet observed.** T001 reproduces it on the emulator before
  anything is written. If the window *is* resized (R1 wrong), the fix shrinks to the height cap alone.
- **The `movies.spec.ts` churn (26 references).** Using one helper keeps the diff mechanical. Each changed
  test must still assert what it asserted before (FR-017).
- **Android tap-through on absolutely positioned views.** The collection screen notes that RN Fabric does
  not dispatch Maestro's `ACTION_CLICK` to absolutely positioned views. That is why the **bar** is in
  normal layout flow. The panel's chips are absolutely positioned. The existing assistant flows already
  `tapOn` an `id` inside the absolutely positioned assistant panel, which suggests plain taps work, but the
  edited movie flows must prove it on the emulator. The fallback, if they fail, is to render the panel in
  flow with negative-margin overlap, decided at that task.

## Complexity Tracking

No constitution violations.
