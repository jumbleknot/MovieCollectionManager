# Tasks: "View & filter options" — rename and full-height pane

**Input**: [spec.md](./spec.md), [plan.md](./plan.md). `APP` = `frontend/mcm-app`. Run from the worktree
`/home/coder/worktrees/099-view-filter-options-height`.

`UNIT <path…>` = `pnpm nx test mcm-app --skip-nx-cache -- <path…>`;
`WEB <spec>` = `pnpm nx e2e mcm-app -- <spec>`.

## Phase 1: Tests first

- [X] T001 [US2] In `APP/src/components/unit-tests/view-options-dock.test.tsx`, change the expected labels
  to "View & filter options" (bar, count variants, heading, close a11y label) and add a test that
  `ViewOptionsPanel` renders its `headerAction`.
  **Verify RED**: `UNIT APP/src/components/unit-tests/view-options-dock.test.tsx` fails on the label and
  headerAction assertions.
- [X] T002 [US1] In `APP/src/components/unit-tests/movie-filter-panel.test.tsx`: the panel root has no
  `maxHeight`; each section's chip container has `flexWrap: 'wrap'`; the panel does not render
  `filter-clear-button`; `ClearFiltersButton` calls `onPress`.
  **Verify RED**: `UNIT APP/src/components/unit-tests/movie-filter-panel.test.tsx` fails on those cases.
- [X] T003 [US1] In `APP/tests/e2e/web/collection-view-options.spec.ts` add an `@gate` test for SC-001/SC-002
  and update the aria-label expectation.
  **Verify RED**: `WEB collection-view-options.spec.ts` fails the new test on `main` code.

## Phase 2: Implementation

- [X] T004 [US2] Rename in `APP/src/components/view-options-dock.tsx`; add `headerAction` prop.
  **Verify GREEN**: T001 command.
- [X] T005 [US1] `APP/src/components/movie-filter-panel.tsx`: remove the cap and nested vertical scroller,
  wrap chips, export `ClearFiltersButton`, stop rendering it inside the panel.
  **Verify GREEN**: T002 command.
- [X] T006 [US1] `APP/src/screens/collections/collection-screen.tsx`: pass `ClearFiltersButton` as
  `headerAction` while a filter is active. **Verify GREEN**:
  `UNIT APP/src/screens/collections/collection-screen.test.tsx` and T003 command.

## Phase 3: Polish

- [X] T007 Lint + typecheck (`pnpm nx lint mcm-app`, `pnpm nx typecheck mcm-app`), full `pnpm nx test mcm-app`.
- [ ] T008 Web preview shared with the user for visual sign-off before CI.
- [ ] T009 `node scripts/wiki-refresh.mjs --stale`; refresh any page it names.

## Evidence

| Check | Result |
| --- | --- |
| T001+T002 Verify RED (unit) | 9 failed / 28 passed — exactly the new/changed cases |
| T004–T006 Verify GREEN (unit) | view-options-dock, movie-filter-panel, collection-screen: 51/51 |
| T003 Verify RED (web E2E, `mcm-bff` image built from `origin/main`, :8082) | `099` test FAILS: `the filter panel must not scroll on its own (FR-002)` — Expected 0, Received 1 |
| T003 Verify GREEN (web E2E, image built from this branch, :8082) | `collection-view-options.spec.ts` 11 passed, 0 skipped, 0 flaky |
| T007 | `nx run-many -t lint typecheck test -p mcm-app`: 170 suites / 1811 tests passed; 0 lint errors (no warnings in changed files) |
| Design-system compliance scan (R1–R7) | passed after the Clear Filters → `variant="text"` change |

Review note (2026-11-11): on user feedback, "Clear Filters" moved from `filledTonal` to `variant="text"`, matching
the header's Close — the filled background painted the DS Button's full 48px touch-target minHeight and read as
an outsized pill beside a text button.

Local E2E note: Metro (`expo start --web`) OOM'd at a 4 GB heap ~90 s after login in this sandbox, both with
and without this change, so the E2E ran against the dev-container BFF path (`E2E_BFF_TARGET=dev-container`).
