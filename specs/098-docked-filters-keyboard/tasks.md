# Tasks: Docked view options and keyboard-safe assistant

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/ui-contract.md](./contracts/ui-contract.md),
[quickstart.md](./quickstart.md)

**Tests**: required. The constitution's TDD principle applies, and every test task follows the
[Verify RED → Verify GREEN](../../docs/templates/feature-test-tasks-template.md) checkpoint format. A test that
was never RED is not a TDD test.

**Paths**: relative to the repo root. `APP` = `frontend/mcm-app`. Run commands from the **worktree**
`/home/coder/worktrees/098-docked-filters-keyboard`, never from `/workspaces/mcm`.

**Commands used below**:

- `UNIT <path…>` = `pnpm nx test mcm-app --skip-nx-cache -- <path…>` (positional path filter; it works on
  Jest 29 and 30 alike, unlike `--testPathPattern(s)`)
- `WEB <spec> [--grep …]` = `pnpm nx e2e mcm-app -- <spec> …` (Playwright in its official image, per
  [e2e-testing](../../docs/runbooks/e2e-testing.md))
- `MOBILE <flow>` = `scripts/maestro-run.sh <flow>` on the devcontainer KVM emulator (start each run logged out)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[US1] / [US2] / [US3]**: the user story in spec.md

---

## Phase 1: Setup

- [ ] T001 Reproduce the keyboard defect on `main` (Verify RED for US2, research R1). Done in this order,
  because the flow must exist before it can fail:
  1. Create `APP/tests/e2e/mobile/assistant-keyboard.yaml`, modelled on `assistant-query.yaml`'s login
     and open steps. It should tap `assistant-dock-toggle`, tap `assistant-dock-input`, `inputText:
     "show me my sci-fi movies please"`, `assertVisible: id: assistant-dock-input` and
     `assertVisible: id: assistant-dock-send` **without** `hideKeyboard`, then `takeScreenshot`.
  2. Run `MOBILE APP/tests/e2e/mobile/assistant-keyboard.yaml` against a `main` build.
  **Expected RED**: an `assertVisible` failure on `assistant-dock-send` or `assistant-dock-input`, and a
  screenshot showing the keyboard over the panel. Record the result in the Evidence table.
  **If it passes on `main`**: R1's root cause is wrong. Stop and re-plan US2 before writing code.
- [X] T002 Install real dependencies in the worktree (`CI=true pnpm install --frozen-lockfile`, about
  4 minutes), so `pnpm nx` targets run instead of failing with `ERR_PNPM_UNSAFE_MODULES_DIR`.
  **Done when**: `pnpm nx test mcm-app --skip-nx-cache -- APP/src/components/agent/assistant-dock.test.tsx`
  runs green.

---

## Phase 2: Foundational (blocks US1 and US3)

- [X] T003 [P] Write `APP/src/utils/active-filters.test.ts` for `countActiveFilters(filters: MovieListFilters):
  number`. Cases: `{}` → 0; `{ genre: 'Drama' }` → 1; `{ owned: false }` → 1 (false is an active filter);
  `{ genre: '' , rated: undefined }` → 0; all nine keys set → 9.
  **Verify RED**: `UNIT APP/src/utils/active-filters.test.ts`. **Expected RED**: the suite fails with
  `Cannot find module '@/utils/active-filters'`.
- [X] T004 Implement `APP/src/utils/active-filters.ts`, using the same predicate as `hasActiveFilters` in
  `APP/src/components/movie-filter-panel.tsx`. Then change the filter panel to use
  `countActiveFilters(...) > 0`, so the two cannot drift (data-model ActiveFilterCount).
  **Verify GREEN**: the T003 command reports 0 failures. **Also run**
  `UNIT APP/src/components/unit-tests/movie-filter-panel.test.tsx` and confirm it is still green.
- [X] T005 [P] Write `APP/src/hooks/use-open-panel.test.tsx` for `OpenPanelProvider`/`useOpenPanel()` →
  `{ openPanel, open(name), close(name), toggle(name) }` (data-model OpenPanel transitions). Cases: the
  initial state is null; `open('view-options')` then `open('assistant')` gives `'assistant'`;
  `close('assistant')` while `'view-options'` is open is a no-op; `toggle` flips; using the hook with no
  provider throws a clear error. Also add a guard test asserting the module's import list contains no
  `@copilotkit/`, `@ag-ui/` or `use-assistant` (feature 077, research R2).
  **Verify RED**: `UNIT APP/src/hooks/use-open-panel.test.tsx`. **Expected RED**: the module is not found.
- [X] T006 Implement `APP/src/hooks/use-open-panel.tsx`, and mount `<OpenPanelProvider>` in
  `APP/src/app/(app)/_layout.tsx` so it wraps both the stack and `<AuthedAssistant />`.
  **Verify GREEN**: the T005 command reports 0 failures. **Also run** `UNIT APP/src/app` and confirm
  the layout tests are still green.

**Checkpoint**: shared state and the filter count exist, and no screen has changed yet.

---

## Phase 3: User Story 1 — See the movie list without the view controls in the way (P1) 🎯 MVP

**Goal**: replace the inline column, sort and filter controls with a docked bar that drops a panel
down over the list.

**Independent test**: at 360×640, at least 3 list rows are visible on load, and open → choose a filter
→ close gives a filtered list with a badge reading 1 (SC-001, SC-003).

- [X] T007 [P] [US1] Write `APP/src/components/unit-tests/view-options-dock.test.tsx` for `ViewOptionsDock`
  (props: `activeFilterCount`, `children`; it reads `useOpenPanel`), against the
  [UI contract](./contracts/ui-contract.md). Cases:
  - `view-options-toggle` is rendered, and `view-options-panel` is absent at first (US1-AC1, FR-004).
  - A press shows the panel and its children and sets `accessibilityState.expanded` (US1-AC2).
  - A press on `view-options-close` hides it, and so does pressing the toggle again (US1-AC4).
  - The native `BackHandler` callback closes it and returns `true`; on web, `Escape` closes it (FR-007).
  - `activeFilterCount=2` renders `view-options-active-count` with the text `2` and the label
    `View options, 2 filters active`, while 0 renders no badge (US1-AC5, FR-008, FR-016).
  - Calling `open('assistant')` on the context closes the panel (FR-015).
  - Focus (FR-016): on open, focus is set on the panel's first heading (`AccessibilityInfo.setAccessibilityFocus`
    on native, `focus()` on the web ref, both spied). On every close path (close button, toggle, Back,
    Escape), focus returns to `view-options-toggle`.
  **Verify RED**: `UNIT APP/src/components/unit-tests/view-options-dock.test.tsx`. **Expected RED**: the
  module is not found.
- [X] T008 [US1] Implement `APP/src/components/view-options-dock.tsx` per research R3–R5:
  - The bar sits in normal layout flow. It is at least 44 pt tall and built from DS `Button`/`IconButton`
    and `Badge`, with tokens only.
  - The panel is `position: absolute; top: 0; left: 0; right: 0` with a DS surface and elevation, and
    a `ScrollView` capped to its container's height. It includes `view-options-close`.
  - Register `BackHandler` only while open, and only on native. Register an Escape key listener on web.
  - Move focus into the panel on open and back to the bar on close.
  - Close on screen blur (`useFocusEffect` cleanup), so the panel is docked on the next visit (FR-004).
  **Verify GREEN**: the T007 command reports 0 failures.
- [ ] T009 [US1] Update `APP/src/screens/collections/collection-screen.test.tsx`:
  - On first render, `column-toggle-*`, `movie-sort-control` and `movie-filter-panel` are **absent**, and
    `view-options-toggle` is present between the search bar and the count row.
  - After pressing the toggle, the three controls are present. Toggling a column, changing the sort and
    pressing a filter chip each call the same hooks as before, and none of them closes the panel
    (US1-AC3, FR-006, FR-009).
  - After closing, the badge shows the active-filter count, and "Clear" removes it (US1-AC6).
  **Verify RED**: `UNIT APP/src/screens/collections/collection-screen.test.tsx`. **Expected RED**: the new
  assertions fail with the controls found inline and `view-options-toggle` not found.
- [ ] T010 [US1] Write `APP/tests/e2e/web/collection-view-options.spec.ts` against the E2E Browse fixture
  (resolve the id the way `movies.spec.ts` does). Tests:
  - At viewport 360×640, `view-options-toggle` is visible, `movie-filter-panel` is not in the DOM, and
    at least 3 `movie-list-item-row` elements are inside the viewport (SC-001, US1-AC1).
  - Open the panel, click a `filter-chip-contentType-<value>` derived from the fixture, and confirm the
    panel stays open. Click `view-options-close`, then confirm the row count matches the fixture-derived
    count and `view-options-active-count` reads `1`. That is three presses in total (SC-003, US1-AC3/4/5).
  - Escape closes the panel, and the URL is unchanged (FR-007).
  - At 1280×800 the same bar is shown with no inline controls (FR-010).
  - Scroll position (FR-005a): scroll the list until a known row is first in view, open and close the panel,
    and assert the same row is still first in view.
  - Focus (FR-016): after Escape, `document.activeElement` is `view-options-toggle`.
  - **Also add to `APP/tests/e2e/web/a11y.spec.ts`** (constitution: WCAG 2.2 AA) one axe scan of the
    collection screen **with the panel open**, in both dark and light themes, using that file's existing
    per-theme loop. Expect zero violations, `color-contrast` included.
  **Verify RED**: `WEB APP/tests/e2e/web/collection-view-options.spec.ts APP/tests/e2e/web/a11y.spec.ts`. **Expected RED**: every test
  fails, waiting on `[data-testid="view-options-toggle"]`, and so does the new a11y scan; the existing
  a11y tests stay green. This runs before T011 changes the screen, so it is naturally RED.
- [ ] T011 [US1] Edit `APP/src/screens/collections/collection-screen.tsx`:
  - Replace the inline `ColumnSelector`, `MovieSortControl` and `MovieFilterPanel` with
    `<ViewOptionsDock activeFilterCount={countActiveFilters(filters)}>` wrapping those three, unchanged.
  - Wrap the count row and `listContainer` in one `flex: 1` container that the panel overlays.
  - Update the file header comment.
  **Verify GREEN**: the T009 command reports 0 failures, and `WEB APP/tests/e2e/web/collection-view-options.spec.ts`
  plus `APP/tests/e2e/web/a11y.spec.ts` (T010) report 0 failed and 0 skipped. **Also run** `UNIT APP/src/screens APP/src/components` and confirm it
  is still green.
- [ ] T012 [US1] Add a `openViewOptions(page)` helper to `APP/tests/e2e/web/movies.spec.ts`. It clicks
  `view-options-toggle` and waits for `view-options-panel`, but only if the panel is not already open.
  Call it before each of the 26 column, sort and filter interactions, and assert nothing else differently
  (FR-017). Also check `APP/tests/e2e/web/a11y.spec.ts` and `responsive.spec.ts`, which visit the
  collection screen, and adjust them only if they reference the moved controls. The panel-open axe scan
  was already added in T010.
  **Verify RED**: before this edit, with T011 in place, `WEB APP/tests/e2e/web/movies.spec.ts` fails in
  the browse, column-persistence and exact-count describes. **Verify GREEN**: after the edit,
  `WEB APP/tests/e2e/web/movies.spec.ts APP/tests/e2e/web/collection-view-options.spec.ts
  APP/tests/e2e/web/a11y.spec.ts APP/tests/e2e/web/responsive.spec.ts` reports 0 failed and 0 skipped.
- [ ] T013 [US1] Add a `tapOn: id: "view-options-toggle"` step before the first column, sort or filter
  interaction in `APP/tests/e2e/mobile/movie-sort.yaml`, `movie-browse.yaml`, `movie-count.yaml` and
  `movie-search-filter.yaml`, and an explicit close where a later step needs the list. This proves that
  taps inside the absolutely positioned panel reach the chips on Android (plan Risks). If they do not,
  switch the panel to in-flow overlap in `view-options-dock.tsx` and record why in research.md R3.
  **Verify RED**: `MOBILE APP/tests/e2e/mobile/movie-sort.yaml` fails on `sort-field-*` not found (T011 in
  place, flow not yet edited). **Verify GREEN**: all four flows pass.

**Checkpoint**: US1 works alone and is shippable as the MVP.

---

## Phase 4: User Story 2 — See what I am typing to the assistant on a phone (P1)

**Goal**: the input, the typed text, the send button and the newest message stay above the on-screen
keyboard.

**Independent test**: `assistant-keyboard.yaml` (T001) passes on Android.

- [ ] T014 [P] [US2] Write `APP/src/hooks/use-keyboard-inset.test.ts`. Mock the `Keyboard.addListener`
  emitters and `Platform.OS`. Cases:
  - Android: `keyboardDidShow` with `endCoordinates.height: 300` gives 300, and `keyboardDidHide` gives 0.
  - iOS: the same with `keyboardWillShow` and `keyboardWillHide`.
  - Web: always 0, with no listeners registered.
  - Unmounting removes the listeners.
  **Verify RED**: `UNIT APP/src/hooks/use-keyboard-inset.test.ts`. **Expected RED**: the module is not found.
- [ ] T015 [US2] Implement `APP/src/hooks/use-keyboard-inset.ts` (research R1). **Verify GREEN**: the T014
  command reports 0 failures.
- [ ] T016 [US2] Extend `APP/src/components/agent/assistant-dock.test.tsx`. With the inset mocked to 300:
  - The `assistant-dock` style has `bottom: 316` (FR-011).
  - The panel's height is `min(420, windowHeight − 300 − topInset − toggle − margins)`. With a 640-high
    window the panel never extends above the top inset (FR-013, US2-AC4).
  - With the inset back at 0, `bottom: 16` and height 420 (FR-014, US2-AC3).
  - Open and closed come from `useOpenPanel('assistant')`, and opening the assistant closes the
    view options (FR-015).
  - FR-016 for the assistant toggle: `assistant-dock-toggle` has `accessibilityState.expanded` matching
    open/closed, and its style has `minHeight >= 44`. Today it has neither.
  **Verify RED**: `UNIT APP/src/components/agent/assistant-dock.test.tsx`. **Expected RED**: the
  bottom/height assertions fail at a fixed `bottom: 16` and height 420.
- [ ] T017 [US2] Edit the following files:
  - `APP/src/components/agent/assistant-dock.tsx`: replace the local `open` with `useOpenPanel`, keeping
    `Panel`, `failed` and `loading` local, and add the inset to `bottom`. Give the toggle
    `accessibilityState={{ expanded: open }}` and `minHeight: 44`.
  - `APP/src/components/agent/assistant-panel.tsx`: compute the capped height from
    `useWindowDimensions`, `useSafeAreaInsets` and the inset, and re-run `scrollToLatest` when the inset
    changes (FR-012, US2-AC2).
  - Pass the inset from the dock into the panel as a prop. Do **not** import the hook into the panel's
    deferred chunk in a way that pulls the dock into it.
  **Verify GREEN**: the T016 command reports 0 failures. **Also run** `UNIT APP/src/components/agent` and
  confirm it is still green.
- [ ] T018 [US2] Verify GREEN on device: `MOBILE APP/tests/e2e/mobile/assistant-keyboard.yaml` passes, and
  the screenshot shows the typed text above the keyboard (SC-004). Then re-run
  `MOBILE APP/tests/e2e/mobile/assistant-query.yaml` and `assistant-navigate.yaml` as the regression check.

**Checkpoint**: US2 works alone. It shares only `use-open-panel` with US1.

---

## Phase 5: User Story 3 — Docked controls and the assistant do not collide (P2)

**Goal**: there is never any overlap, and at most one of the two panels is open.

**Independent test**: on the collection screen at phone and desktop widths, opening either panel closes
the other, and both toggles and "+ Add movie" can be clicked.

- [ ] T019 [US3] Add to `APP/tests/e2e/web/collection-view-options.spec.ts`. These tests are untagged,
  so they stay out of the agent tier. Each is conditional on the E2E user's assistant config being
  runnable, as seeded:
  - At 360×640 and 1280×800, the bounding boxes of `view-options-toggle`, `assistant-dock-toggle` and
    `collection-screen-add-movie` do not intersect (US3-AC1).
  - Opening `view-options-toggle` while `assistant-dock-panel` is visible hides the assistant panel,
    and the reverse also holds (US3-AC2, FR-015).
  The skip must be **loud**: with `E2E_REQUIRE_AGENT_STACK=1` a missing dock fails instead of skipping.
  **Verify RED** (the test runs after T017, so RED comes from temporarily reverting the change): replace
  the `useOpenPanel` call in `assistant-dock.tsx` with a local `useState`. Run the two tests. **Expected RED**:
  both mutual-exclusion directions fail with both panels visible, while the overlap test may still pass.
  Restore the file and confirm `git diff --stat` shows no change to it. **Verify GREEN**: `WEB APP/tests/e2e/web/collection-view-options.spec.ts` reports
  0 failed and 0 skipped with `E2E_REQUIRE_AGENT_STACK=1`.

---

## Phase 6: Polish and cross-cutting

- [ ] T020 [P] Measure SC-001's baseline on `main`, then on the branch: the number of visible rows at
  360×640, read from the T010 test's evidence or a one-off Playwright run. Record both numbers in the
  Evidence table.
- [ ] T021 Run the tiers the diff touches, one at a time with `--skip-nx-cache`:
  `pnpm nx lint mcm-app`, `pnpm nx typecheck mcm-app`, `pnpm nx test mcm-app` (watch the **skip count**),
  `pnpm nx export-server mcm-app`, then `pnpm nx bundle-budget mcm-app`.
  **Done when**: all exit 0, `bundle-budget` is under 2,000,000 bytes with no `@copilotkit/*` in the entry
  chunk, and the counts are recorded.
- [ ] T022 Run the full web regression `pnpm nx e2e mcm-app` with `E2E_TIER=gate`, then
  `pnpm nx e2e:mobile mcm-app`. **Done when**: 0 failed, and any skip is a pre-existing, named one.
- [ ] T023 [P] iOS check (quickstart §5). If a simulator or device is available, record the result.
  Otherwise write "iOS unverified — no runner" in the PR body. Do not claim it works.
- [ ] T024 [P] Documentation: in `docs/` (the source cited by the Expo app's openwiki concept, not the
  concept itself), note that the collection controls live in the view-options dock and that the
  assistant dock follows the keyboard inset. **Done when**: `pnpm nx okf-lint infrastructure-as-code` and
  `pnpm nx okf-governance infrastructure-as-code` pass.
- [ ] T025 Open the PR. Push a real branch head (`git push origin HEAD:098-docked-filters-keyboard`), then
  `POST …/pulls` with the `git credential fill` credential
  ([ci-diagnostics](../../docs/runbooks/ci-diagnostics.md)). **Done when**: the PR is open, CI is green, and
  the run numbers are quoted in the Evidence table.

---

## Dependencies and execution order

```text
T001 (RED on main) ─────────────────────────────┐
T002 ─┬─ T003→T004 ─┐                            │
      └─ T005→T006 ─┴─ US1: T007→T008→T009→T010→T011→T012→T013
                    └─ US2: T014→T015→T016→T017→T018 ◀┘
                                  US1 + US2 ─▶ US3: T019 ─▶ Polish T020–T025
```

- US1 and US2 are independent after Phase 2. Their only shared file is `use-open-panel.tsx`.
- US3 needs both stories, because it asserts their interaction.
- Within each story, the tests come before the implementation, and each task's RED is recorded first.

## Parallel opportunities

- T003 and T005 are different new files.
- T007 (US1) and T014 (US2) can be written in parallel once Phase 2 is done.
- T010 (web spec) can be written in parallel with T007–T009, and its RED must be run before T011 lands.
- T020, T023 and T024 can run in parallel in Polish.
- Keep at most one background agent: the sandbox has 15 GB of RAM, shared between sessions.

## Implementation strategy

1. **MVP = Phase 1, Phase 2 and US1.** That fixes the reported space problem on every platform.
2. **Then US2**, which is independent and fixes the keyboard defect.
3. **Then US3 and Polish.** Ship it as one PR (plan: PR shape).

## Platform parity table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1: docked on load, list visible | `collection-view-options.spec.ts` | `movie-browse.yaml` (edited) | ✅ |
| US1-AC2/3: open, choose, stays open | `collection-view-options.spec.ts`, `movies.spec.ts` | `movie-search-filter.yaml`, `movie-sort.yaml` | ✅ |
| US1-AC4: re-dock (close, toggle, Back/Escape) | `collection-view-options.spec.ts` (Escape) | `movie-search-filter.yaml` (close) + unit test for Back | ✅ |
| US1-AC5/6: badge count, Clear | `collection-view-options.spec.ts` | `movie-count.yaml` | ✅ |
| US2-AC1–4: keyboard-safe assistant | N/A — native-only scope (clarify Q5); mobile browsers resize their own viewport | `assistant-keyboard.yaml` (new) | N/A web |
| US3-AC1/2: no overlap, one panel open | `collection-view-options.spec.ts` | N/A — geometry and exclusivity are platform-independent and covered by unit tests T007/T016 | N/A mobile |

## Completion checklist

- [ ] **SC-001**: at least 3 rows visible at 360×640 on load (T010, baseline from T020)
- [ ] **SC-002**: a single compact bar replaces the three inline controls (T009, T010)
- [ ] **SC-003**: filter and return in 3 presses or fewer (T010)
- [ ] **SC-004**: Android input stays visible with the keyboard up (T001 RED → T018 GREEN)
- [ ] **SC-005**: existing web and mobile flows pass with only "open first" changes (T012, T013, T022)
- [ ] Platform parity table has no ❌ gaps
- [ ] Every test task recorded a Verify RED before its implementation
- [ ] `pnpm nx test mcm-app`, `lint`, `typecheck` and `bundle-budget` pass (T021)
- [ ] `pnpm nx e2e mcm-app` and `pnpm nx e2e:mobile mcm-app` pass (T022)
- [ ] `rtk gain` shows more than 80% compression (run last)

## Evidence

| Task | Result | Where |
|---|---|---|
| T001 | **NOT RUN — environment cannot host the emulator.** Proof (2026-11-09, Docker Sandbox microVM): `ls /dev/kvm` → `No such file or directory`; `grep -c -E 'vmx\|svm' /proc/cpuinfo` → `0`; `emulator -accel-check` → `KVM requires a CPU that supports vmx or svm`; `scripts/devcontainer-android.sh boot` → `/dev/kvm is NOT PRESENT … feature 060, gate R2 … documented SCOPED EXCEPTION`. Step 1 done: `assistant-keyboard.yaml` written, with a behavioural send check because Maestro `assertVisible` cannot see IME occlusion. Step 2 (the RED) still owed: CI `kvm` runner or the Docker Desktop dev container. | `APP/tests/e2e/mobile/assistant-keyboard.yaml` |
| T002 | `CI=true pnpm install --frozen-lockfile` exit 0 (7m 26s); `node_modules` is a real dir; Jest **30.5.2**. `assistant-dock.test.tsx`: 1 suite, **9 passed, 0 skipped** | worktree |
| T003 RED | 1 suite failed to run: `Could not locate module @/utils/active-filters`. Test lives in `src/utils/unit-tests/` (repo convention); the "all keys" case asserts 10 (the type has 10 keys incl. `childrens`), not 9 | `src/utils/unit-tests/active-filters.test.ts` |
| T005 RED | 1 suite failed to run: `Could not locate module @/hooks/use-open-panel` | `src/hooks/use-open-panel.test.tsx` |
| T004/T006 GREEN | active-filters + use-open-panel + movie-filter-panel: **3 suites, 29 passed, 0 skipped**. (First GREEN attempt failed in the TEST: RNTL 14.1 `renderHook` is async; fixed by awaiting it.) `UNIT APP/src/app` matches **no** test files (only `+api.ts` routes), so the layout has no unit coverage to re-run | Jest |
| T007 RED | 2 suites failed to run, `Could not locate module @/utils/move-focus` (mocked by the dock test, so it is hit before `@/components/view-options-dock` — both unwritten). Also adds `src/utils/unit-tests/move-focus.test.ts` (the web/native focus call the dock test mocks out) | `src/components/unit-tests/view-options-dock.test.tsx` |
| T008 GREEN | view-options-dock + move-focus: **2 suites, 17 passed, 0 skipped**. Implemented as two exports, `ViewOptionsDock` (bar, in flow) + `ViewOptionsPanel` (overlay, mounted by the screen in the list container), because the overlay sits in a later layout container than the bar. Harness fixes on the way, none in product code: (a) a failing matcher on a raw React ref pretty-printed the fiber graph and OOM'd the Jest worker after 188 s → targets compared as labels; (b) `jest.spyOn(RN,'findNodeHandle')` does not reach the import binding → native focus uses `AccessibilityInfo.sendAccessibilityEvent(host,'focus')`; (c) Jest 30 `restoreAllMocks` does not clear calls → `clearAllMocks` per test | Jest |
| T009 RED | `collection-screen.test.tsx`: **8 failed, 6 passed**. 7 × `Unable to find an element with testID: view-options-toggle` (or `-active-count`), 1 × bar-order index −1 | Jest |
| T010 RED (partial) | Run against Metro on this worktree, pre-T011. **1 genuine RED**: `a11y … collection view options (open) … (dark)` → `locator.click: Test timeout … waiting for getByTestId('view-options-toggle')`. The other 15 failures are **instrument, not RED**: Metro (6 GB heap) hung, then was SIGKILLed by the kernel OOM killer (exit 137) mid-run → `apiRequestContext.get: Test timeout` / `ERR_ABORTED`. Two earlier attempts ran zero tests (V8 heap OOM at 2 GB; then `login: session creation failed — AGENT_CONFIG_ENC_KEY is not …`, because the main checkout's `.env.local` lacks the BFF-only keys that `gen-dev-env.mjs` writes only to `.env.docker`). **Still owed**: a clean T010 RED. | `scratchpad/t010-red.log` |
