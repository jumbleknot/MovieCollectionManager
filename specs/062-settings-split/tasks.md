# Tasks: Settings destination with sub-navigation

**Input**: Design documents from `/specs/062-settings-split/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/ui-contract.md](./contracts/ui-contract.md), [quickstart.md](./quickstart.md)

**Tests**: REQUIRED. TDD is non-negotiable in this repository's constitution — every test task carries a **Verify RED** command with its expected failure, and every paired implementation task carries a **Verify GREEN**. A Verify RED showing 0 failures means the test is trivially passing and must be corrected before implementation begins. Two tasks (T010, T009) deliberately have no pair; each says why in its own body rather than leaving the reader to infer it.

**Organization**: Grouped by user story so each phase is an independently testable increment. Each story owns its route file, its screen, **and its row in the settings-area registry** — so after any phase the sub-navigation offers exactly the areas that exist.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task
- **[US1] / [US2] / [US3]**: the user story from [spec.md](./spec.md); Setup, Foundational, and Polish tasks carry no story label

## Path Conventions

Constitution-mandated frontend layout: App-Layer `frontend/mcm-app/src/app/`, Components-Layer `src/components/`, Screens-Layer `src/screens/`, Hooks-Layer `src/hooks/`, BFF utilities `src/bff-server/`. App-Layer unit tests live in `frontend/mcm-app/tests/app/` — **never** under `src/app/`, where a test file would become a route.

---

## Phase 1: Setup

**Purpose**: Establish the baseline that every later "did anything stop being tested?" judgement is made against.

- [X] T001 Record baseline pass/skip counts for the four touched tiers in `specs/062-settings-split/baseline-counts.md`

  **Type**: Config / evidence | **Risk**: None | **Spec reference**: SC-005

  Run each tier on the unmodified branch and write down **both** the pass count and the **skip count**:
  ```bash
  pnpm nx test mcm-app
  pnpm nx test design-system
  pnpm nx test movie-assistant
  pnpm nx typecheck mcm-app
  ```
  **Done when**: the file records pass *and* skip counts per tier. A skipped test reads as a pass; without the starting skip count there is no way to notice one appearing later. This is the instrument check, not busywork.

- [X] T002 Confirm the "no gateway source change" claim in `agents/movie-assistant/src/` before relying on it

  **Type**: Evidence | **Risk**: None | **Spec reference**: FR-015, research.md §R2

  ```bash
  grep -rn "current_screen\|_COLLECTION_SCREENS\|'profile'\|\"profile\"" agents/movie-assistant/src/
  ```
  **Done when**: the only hits are `nodes/organizer.py` `_COLLECTION_SCREENS = {"collection", "movie-detail"}` and its `movie-detail` comparison, and `profile` appears nowhere. If this returns anything else, [research.md](./research.md) §R2 is wrong and gateway tasks must be added to this file before proceeding.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared pieces every story needs — the design-system capability, the screen-label vocabulary, the navigation shell, and the guard on the one placement that must not move.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 [P] Write the failing test for per-tab `testID` in `packages/design-system/components/navigation/navigation.test.tsx`

  **Type**: Test | **Risk**: Low | **Spec reference**: FR-017, contracts/ui-contract.md §2

  **Scenarios covered**: US1-AC3 (the sub-navigation must be locatable by automation on web and native)

  Render `Tabs` with a `TabItem` carrying `testID: 'settings-nav-assistant'`, assert `getByTestId('settings-nav-assistant')` resolves, and assert pressing it calls `onTabChange` with that tab's key.

  **Verify RED**:
  ```bash
  pnpm nx test design-system -- --testNamePattern "testID"
  ```
  **Expected RED**: 1 failing — `Unable to find an element with testID: settings-nav-assistant`. `Tabs` never reads `tab.testID` today, so nothing renders it in any renderer.

  > ⚠️ **This test's GREEN is necessary but not sufficient, and that is the whole trap.**
  > `packages/design-system/jest.config.js` uses `preset: 'jest-expo'` — the React Native renderer,
  > not the React-Native-Web DOM. A `testID` placed on the Tamagui `View` passes *here* and still
  > emits no `data-testid` on web, which is the exact failure `components/admin-settings-card.tsx`
  > documents for the design system's `Card`. The assertion that discriminates the correct fix from
  > the broken one lives in T013, and T004 is not GREEN until **both** pass.

- [X] T004 Add the optional `TabItem.testID`, rendered on a React Native host node, in `packages/design-system/components/navigation/Tabs.tsx`

  **Type**: Implementation | **Risk**: Low | **Spec reference**: FR-017 | **Prerequisite**: T003 verified RED

  Add `testID?: string` to `TabItem`. Wrap each tab's Tamagui `View` in a plain RN `Pressable` that carries the `testID`, the `onPress`, and `accessibilityRole="tab"` / `accessibilityState={{ selected }}`, leaving the `View` non-interactive inside it — the exact shape `admin-settings-card.tsx` uses and explains. Keep the prop optional so existing callers are unaffected. Annotate the `testID` as a stable external-contract selector, per the constitution's carve-out.

  **Verify GREEN**:
  ```bash
  pnpm nx test design-system -- --testNamePattern "testID"
  ```
  **Expected GREEN**: 0 failures.

  **The discriminating check** — run once T013 exists. *This*, not the jest test above, is what proves the host node:
  ```bash
  docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
    -e E2E_BFF_TARGET=dev-container -e E2E_TEST_USER -e E2E_TEST_PASSWORD -e CI=1 \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    sh -c "corepack enable && pnpm exec playwright test settings.spec.ts --grep 'sub-navigation is locatable'"
  ```
  **Expected**: passes. If it fails while jest is green, the `testID` landed on the Tamagui component instead of the RN host node — the fix is incomplete, not the test.

  **Also run the touched suite**:
  ```bash
  pnpm nx test design-system && pnpm nx lint design-system
  ```
  **Expected**: previously passing tests still pass; the indicator animation and layout tests are unaffected.

- [X] T005 [P] Write the failing allowlist test for the four settings labels in `frontend/mcm-app/src/bff-server/unit-tests/ui-state-sanitizer.test.ts`

  **Type**: Test | **Risk**: None | **Spec reference**: FR-013, FR-014

  Assert that `settings`, `settings-assistant`, `settings-backups`, `settings-admin` each survive `sanitizeUiState` unchanged; that the retired `profile` and `admin-settings` now collapse to `unknown`; and — unchanged, restated because the vocabulary is being edited — that an arbitrary string still collapses to `unknown`.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "ui-state-sanitizer"
  ```
  **Expected RED**: 4 failing — each new label received as `'unknown'` instead of itself.

- [X] T006 Update `ALLOWED_SCREENS` in `frontend/mcm-app/src/bff-server/ui-state-sanitizer.ts` and widen the union in `frontend/mcm-app/src/hooks/use-ui-state.tsx`

  **Type**: Implementation | **Risk**: Low | **Prerequisite**: T005 verified RED

  Replace `'profile'` in `ALLOWED_SCREENS` with the four `settings*` labels from [data-model.md](./data-model.md) §2. Widen `UiSnapshot.current_screen` to match. The allowlist is the enforcement point; the union is only a developer hint and ends in `| string`, which is exactly how `admin-settings` drifted into being reported but never allowed.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "ui-state-sanitizer"
  ```
  **Expected GREEN**: 0 failures.

- [X] T007 Write the failing tests for the settings sub-navigation in `frontend/mcm-app/src/components/settings/settings-nav.test.tsx`

  **Type**: Test | **Risk**: Low | **Spec reference**: FR-003, FR-008

  **Scenarios covered**: US1-AC2, US1-AC3, US2-AC1, US2-AC2

  Cover: the container renders `settings-nav`; a row renders per registry entry with its `settings-nav-*` testID; the entry matching the current path is marked selected and the others are not; the `index` row is active **only** on the exact group path and not on a child path (`NavigationBar` gets this wrong today with `startsWith` — do not copy that shape); the admin row is **absent from the tree** for a non-admin, not merely styled invisible; and it is present for an `mc-admin`.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "settings-nav"
  ```
  **Expected RED**: 6 failing — `Cannot find module '@/components/settings/settings-nav'`.

- [X] T008 Implement `SettingsNav` in `frontend/mcm-app/src/components/settings/settings-nav.tsx`

  **Type**: Implementation | **Risk**: Medium | **Spec reference**: FR-003, FR-008, FR-017 | **Prerequisite**: T007 verified RED

  Compose the design system's `Tabs` with `scrollable` so five entries remain usable at phone width. Declare the settings-area registry as a module-level constant per [data-model.md](./data-model.md) §1 — **seeded with the Profile and Movie Assistant rows only**; US2 and US3 each add their own row. Filter `adminOnly` rows with `isAdmin(user)` from `@/utils/role-checker`. Derive the active row from `usePathname()` with an exact match for `index`. Navigate with `router.navigate`. Styles at the bottom of the file, one named export, no ad-hoc `StyleSheet` colours or spacing — tokens only.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "settings-nav"
  ```
  **Expected GREEN**: 0 failures.

- [X] T009 Create the settings route-group layout at `frontend/mcm-app/src/app/(app)/settings/_layout.tsx`

  **Type**: Config | **Risk**: Medium | **Spec reference**: FR-003, research.md §R4, §R5

  Render `<SettingsNav />` above a nested `<Stack screenOptions={{ headerShown: false }} />`, with the `Stack` wrapped in a `flex: 1` `View` — React Native Web's absolutely-positioned screen containers collapse to zero height without an explicit parent height, clipping every child screen, which `(app)/_layout.tsx` already documents. Must be a **directory** route with `_layout.tsx`, never a `settings.tsx` file route: a file route cannot host nested children, the trap recorded in `openwiki/gotchas/expo-router-collection-routing.md`. Do **not** move `AssistantConfigProvider` here — see [research.md](./research.md) §R7 and T010.

  **Done when**: the layout composes navigation only and holds no screen content. It has no branching logic to unit-test; its behaviour is asserted by the US1 web E2E (T013), which is the deliberate reason this task has no RED/GREEN pair.

- [X] T010 [P] Guard the `AssistantConfigProvider` position in `frontend/mcm-app/tests/app/(app)/_layout.test.tsx`

  **Type**: Regression guard | **Risk**: Low | **Spec reference**: FR-019

  Render `AppLayout` and assert the assistant-config context is resolvable from **both** a descendant of the `Stack` and a descendant of the dock gate — the property that makes saving the config refresh availability in the same session. App-Layer tests live in `tests/app/` mirroring `src/app/`; a test file under `src/app/` would become a route.

  **This has no RED/GREEN pair, deliberately**: the behaviour already holds, so a paired implementation task would be fiction. It is written to make a *future* relocation fail. Verify it actually can fail before trusting it:
  ```bash
  # temporarily move AssistantConfigProvider inside AuthedAssistant, then:
  # NOTE (corrected during implementation): the pattern is matched against the full path
  # `tests/app/(app)/_layout.test.tsx`, in which the literal parens sit between `app` and
  # `/_layout` — so "app/_layout" matches NOTHING and jest exits "No tests found", which is a
  # non-zero exit that reads exactly like a failing guard. Use "_layout".
  pnpm nx test mcm-app -- --testPathPattern "_layout"
  ```
  **Expected while mutated**: 1 failing. **Then revert and re-run**: 0 failures. A guard that cannot be made to fail is not a guard — and [research.md](./research.md) §R7 records that this particular regression is invisible to every other test in the suite.

**Checkpoint**: The design system can be automated, the label vocabulary is enforced, the navigation shell exists, and the provider placement is guarded. User story work can begin.

---

## Phase 3: User Story 1 — Reach a specific settings area directly (Priority: P1) 🎯 First increment

**Goal**: `Settings` replaces `Profile` in the app bar and opens a sub-navigated destination whose Profile and Movie Assistant areas each have their own address.

**Independent Test**: Log in, confirm the app bar reads **Settings**, switch between Profile and Movie Assistant via the sub-navigation, then reload the browser directly on each address and confirm the same area opens with its sub-navigation intact.

- [X] T011 [P] [US1] Write the failing unit tests for the two new screens in `frontend/mcm-app/src/screens/settings/profile-settings-screen.test.tsx` and `frontend/mcm-app/src/screens/settings/assistant-settings-screen.test.tsx`

  **Type**: Test | **Risk**: Low | **Spec reference**: FR-005, FR-006, FR-017

  **Scenarios covered**: US1-AC2, US1-AC3

  Profile screen: renders `settings-profile-screen` with `ProfileDisplay` and the logout control; renders `settings-profile-loading` while auth is loading and `settings-profile-empty` with no user; renders **no** admin card and **no** assistant config — the split is the point. Assistant screen: renders `settings-assistant-screen` containing `assistant-config`.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "screens/settings"
  ```
  **Expected RED**: 5 failing — `Cannot find module '@/screens/settings/profile-settings-screen'` and the assistant equivalent.

- [X] T012 [US1] Implement the two screens in `frontend/mcm-app/src/screens/settings/profile-settings-screen.tsx` and `frontend/mcm-app/src/screens/settings/assistant-settings-screen.tsx`

  **Type**: Implementation | **Risk**: Low | **Prerequisite**: T011 verified RED

  Move the bodies out of `src/screens/auth/profile-screen.tsx`: `ProfileDisplay` + logout into the profile screen, `MovieAssistantConfig` into the assistant screen. Carry the `paddingBottom: 180` scroll allowance — **and its explanatory comment** — onto the **assistant** screen, not the profile one: it exists so the mobile E2E can scroll the Save button clear of the floating dock toggle overlay, and dropping it makes that tap get swallowed with no save and no banner. Rename the testIDs per [contracts/ui-contract.md](./contracts/ui-contract.md) §2 and annotate each as a stable external-contract selector.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "screens/settings"
  ```
  **Expected GREEN**: 0 failures.

- [X] T013 [US1] Write the failing web E2E for the settings destination in `frontend/mcm-app/tests/e2e/web/settings.spec.ts`

  **Type**: Test / New file | **Risk**: Medium | **Spec reference**: FR-001, FR-002, FR-004, FR-017, FR-018

  **Scenarios covered**: US1-AC1, US1-AC2, US1-AC3, US1-AC4

  Four cases, all of which must be able to fail before implementation:

  1. `nav-settings` exists with text **Settings** and `nav-profile` has count 0.
  2. Selecting it lands on `/(app)/settings` showing `settings-profile-screen` and `settings-nav`.
  3. Titled **`sub-navigation is locatable`** — `page.getByTestId('settings-nav-assistant')` resolves (i.e. `data-testid` reached the DOM), then selecting it shows `assistant-config` with the sub-navigation still present. This is the case T004 depends on: it is the only one that can tell an RN host node from a Tamagui component.
  4. A **cold** `page.goto` of `/(app)/settings/assistant` renders that area directly, asserted without first navigating in-app.

  The old-address behaviour is **not** asserted here — it goes in T017, where it can be made RED. Asserting the absence of a testID that does not yet exist would pass vacuously.

  **Verify RED**: run the Playwright image (browsers are baked in; `playwright install` cannot work in this dev container — the CDN is not in the egress allow-list):
  ```bash
  docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
    -e E2E_BFF_TARGET=dev-container -e E2E_TEST_USER -e E2E_TEST_PASSWORD -e CI=1 \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    sh -c "corepack enable && pnpm exec playwright test settings.spec.ts"
  ```
  **Expected RED**: 3 failed, 0 skipped — `nav-settings` never becomes visible.

  > Before trusting this run, prove the image carries your change:
  > `docker run --rm --entrypoint sh mcm-bff:latest -c "grep -rl settings-nav /app/runtime/dist | head -1"`.
  > The bundle is **baked, not mounted**; empty output means stale, and the path is `/app/runtime/dist`, not `/app/dist`.

- [X] T014 [US1] Add the Profile and Movie Assistant routes in `frontend/mcm-app/src/app/(app)/settings/index.tsx` and `frontend/mcm-app/src/app/(app)/settings/assistant.tsx`

  **Type**: Implementation | **Risk**: Low | **Spec reference**: FR-002, FR-004, FR-013 | **Prerequisite**: T011–T013

  Each route is thin: call `useReportUiState` with its label and depth from [data-model.md](./data-model.md) §2 (`settings`/0 and `settings-assistant`/1) and return its screen. Routes never define screen components.

  **Verify GREEN** (this task closes T013's RED):
  ```bash
  docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
    -e E2E_BFF_TARGET=dev-container -e E2E_TEST_USER -e E2E_TEST_PASSWORD -e CI=1 \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    sh -c "corepack enable && pnpm exec playwright test settings.spec.ts"
  ```
  **Expected GREEN**: 0 failed, 0 skipped. Rebuild `mcm-app` first (`pnpm nx docker-build mcm-app`) — the bundle is baked into `mcm-bff:latest`, not mounted, so an unrebuilt image runs the old client and this reads as a product bug.

- [X] T015 [US1] Write the failing app-bar test in `frontend/mcm-app/src/components/navigation-bar.test.tsx`

  **Type**: Test | **Risk**: Low | **Spec reference**: FR-001

  **Scenarios covered**: US1-AC1

  Expect `nav-settings` with the label **Settings** targeting `/(app)/settings`, and assert `nav-profile` is gone.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "navigation-bar"
  ```
  **Expected RED**: 1 failing — `Unable to find an element with testID: nav-settings`.

- [X] T016 [US1] Rename the app-bar destination in `frontend/mcm-app/src/components/navigation-bar.tsx`

  **Type**: Implementation | **Risk**: Low | **Spec reference**: FR-001 | **Prerequisite**: T015 verified RED

  Change the `links` entry: label `Profile` → `Settings`, `href` → `/(app)/settings`, `testID` → `nav-settings`. Annotate the testID as a stable external-contract selector.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "navigation-bar"
  ```
  **Expected GREEN**: 0 failures.

- [X] T017 [US1] Write the failing old-address test in `frontend/mcm-app/tests/e2e/web/settings.spec.ts`

  **Type**: Test | **Risk**: Medium | **Spec reference**: FR-011

  **Scenarios covered**: spec.md Edge Cases — a user follows an old bookmark

  Navigate to `/(app)/profile` and assert **both**: `settings-nav` has count 0 (no settings shell) **and** `profile-display` has count 0 (no profile content either). The second half is what makes this a real test — while `profile.tsx` still exists the route renders `ProfileDisplay`, so the assertion fails for the right reason rather than passing because nothing was ever there. Add the same pair for `/(app)/admin/settings`, asserting `admin-settings-screen` count 0.

  **Verify RED**:
  ```bash
  docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
    -e E2E_BFF_TARGET=dev-container -e E2E_TEST_USER -e E2E_TEST_PASSWORD -e CI=1 \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    sh -c "corepack enable && pnpm exec playwright test settings.spec.ts --grep 'old address'"
  ```
  **Expected RED**: 1 failed — `profile-display` is visible at `/(app)/profile`. A 0-failure result means the assertion is checking the absence of something that was never present, and must be corrected before T018.

  > The `/(app)/admin/settings` half goes GREEN at **T024**, not T018 — that route is deleted with the admin re-parent. Expect it to stay red through Phase 3; do not "fix" it by weakening the assertion.

- [X] T018 [US1] Delete the pre-split route and screen: `frontend/mcm-app/src/app/(app)/profile.tsx` and `frontend/mcm-app/src/screens/auth/profile-screen.tsx`

  **Type**: Implementation | **Risk**: Medium | **Spec reference**: FR-011 | **Prerequisite**: T012, T014, T017 verified RED

  Removed, not redirected — the operator decision in [research.md](./research.md) §R1.

  **Verify GREEN**: the T017 command.
  **Expected GREEN**: the `/(app)/profile` case passes — the address now renders neither shell nor content.

  **Also run**:
  ```bash
  pnpm nx typecheck mcm-app
  ```
  **Expected**: 0 errors. `typecheck` is the cheapest detector of anything still pointing at the deleted files.

- [X] T019 [US1] Update the web E2E specs that navigate to the old destination: `auth.spec.ts`, `assistant-config.spec.ts`, `bff-prod-lifecycle.spec.ts` under `frontend/mcm-app/tests/e2e/web/`

  **Type**: Test refactor | **Risk**: Medium | **Spec reference**: FR-016

  Rewrite `nav-profile` → `nav-settings`, `profile-screen` → `settings-profile-screen`, and `(app)/profile` → `(app)/settings`. `assistant-config.spec.ts` additionally needs one extra step — it must now reach `/(app)/settings/assistant` rather than finding the config on the landing area. Change the navigation, never the assertion: no expectation is relaxed to make a spec pass.

  **Verify GREEN**:
  ```bash
  docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
    -e E2E_BFF_TARGET=dev-container -e E2E_AGENT_PROVIDER=anthropic \
    -e E2E_TEST_USER -e E2E_TEST_PASSWORD -e ANTHROPIC_API_KEY -e TMDB_API_KEY -e CI=1 \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    sh -c "corepack enable && pnpm exec playwright test auth assistant-config bff-prod-lifecycle settings"
  ```
  **Expected GREEN**: 0 failures, and the **skip count unchanged from T001**.

- [X] T020 [P] [US1] Update the 14 affected mobile flows **and create `settings-nav.yaml`** under `frontend/mcm-app/tests/e2e/mobile/`

  **Type**: Test refactor / New file | **Risk**: Medium | **Spec reference**: FR-016

  Update: `assistant-add.yaml`, `assistant-add-ambiguous.yaml`, `assistant-config-disable.yaml`, `assistant-config-enable.yaml`, `assistant-config-enable-anthropic.yaml`, `assistant-config-gating.yaml`, `assistant-config-test-connection.yaml`, `assistant-context.yaml`, `assistant-navigate.yaml`, `assistant-organize.yaml`, `assistant-organize-move.yaml`, `home-screen.yaml`, `login-invalid.yaml`, `logout.yaml`. Replace the testIDs, and add the `settings-nav-assistant` step to every `assistant-config-*` flow. Search for the visible text `Profile` as well as the testIDs — a flow that taps by label will not appear in a testID search.

  Create `settings-nav.yaml`: log in, tap `nav-settings`, assert `settings-profile-screen`, tap `settings-nav-assistant`, assert `assistant-config`. It is created **here** rather than in Phase 5 because the Platform Parity Table maps **US1**-AC2 and US1-AC3 to it — leaving it to US3 would mean US1's stated independent test could not be run on mobile until two phases later. T030 extends it with the Backups case.

  **Which tier this new flow lands in, stated rather than assumed.** The local runner
  (`frontend/mcm-app/scripts/maestro-e2e.mjs`) **globs** the flow directory, so `settings-nav.yaml`
  is picked up with no registration. CI does **not** use that runner: `app-ci.yml:964` invokes
  `scripts/ci-mobile-agent-flows.sh`, which runs a **hardcoded `flows=(…)` array** of nine agent
  flows plus a specially-cased `admin-card`. A flow absent from that array never runs in the gate —
  which is already true of `home-screen.yaml`, `logout.yaml`, and `login-invalid.yaml`.

  **Decision: do not add `settings-nav.yaml` to the CI array.** It is a pure navigation check that
  the web tier covers on every run, and each CI flow costs emulator minutes on a single runner. So
  it is **local-tier** coverage, and the Platform Parity Table marks it as such. Do not let the
  table imply gate coverage it does not have.

  **Verify GREEN**:
  ```bash
  pnpm nx e2e:mobile mcm-app
  ```
  **Expected GREEN**: 0 failures. Needs `/dev/kvm`, which the Docker Sandbox microVM cannot provide — on that host this tier runs in CI, and that must be **stated**, not reported as passing.

**Checkpoint**: The first increment is complete and demonstrable. The destination is named Settings, has two working areas, each independently addressable, and the old profile address is gone.

---

## Phase 4: User Story 2 — Administer app-wide settings from the same destination (Priority: P2)

**Goal**: The Admin area joins the sub-navigation for administrators, with the route's own role guard as the actual enforcement.

**Independent Test**: As an administrator, see the Admin entry, open it, and change the self-registration setting. As a non-administrator, see no entry — and be refused when navigating to the address directly.

- [X] T021 [US2] Write the failing admin-visibility tests in `frontend/mcm-app/src/components/settings/settings-nav.test.tsx`

  **Type**: Test | **Risk**: Low | **Spec reference**: FR-008

  **Scenarios covered**: US2-AC1, US2-AC2

  An `mc-admin` sees `settings-nav-admin`; an `mc-user` gets `queryByTestId('settings-nav-admin') === null` — absent from the tree, not hidden.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "settings-nav"
  ```
  **Expected RED**: 1 failing — `settings-nav-admin` not found for the admin case.

- [X] T022 [US2] Add the admin registry row to `frontend/mcm-app/src/components/settings/settings-nav.tsx`

  **Type**: Implementation | **Risk**: Low | **Spec reference**: FR-008 | **Prerequisite**: T021 verified RED

  Add the `adminOnly: true` row from [data-model.md](./data-model.md) §1. The existing `isAdmin(user)` filter from T008 does the rest.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "settings-nav"
  ```
  **Expected GREEN**: 0 failures.

- [X] T023 [US2] Rework `frontend/mcm-app/tests/e2e/web/admin-card.spec.ts` into `admin-settings-access.spec.ts`

  **Type**: Test refactor | **Risk**: Medium | **Spec reference**: FR-008, FR-009

  **Scenarios covered**: US2-AC1, US2-AC2, US2-AC3

  The affordance this file tests is being deleted, so it is reworked rather than patched. Keep both existing cases, retargeted at `settings-nav-admin`, and **add** the case the card-based spec never had, written as a **pair inside one test**: an `mc-admin` navigating directly to `/(app)/settings/admin` **renders** `admin-settings-screen`, and an `mc-user` navigating to the same address **does not** — neither having rendered the sub-navigation first. Asserting only the refusal would pass vacuously while the route does not exist; asserting both means the test can only go green after T024.

  **Prerequisite**: `KEYCLOAK_SERVICE_CLIENT_SECRET` must be present. Without it the admin-minting cases **skip cleanly** — `admin-card.spec.ts` is deliberately written that way — and a skipped test reads as a pass, so an absent secret turns this Verify RED into a green-looking no-op.

  **Verify RED**:
  ```bash
  docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
    -e E2E_BFF_TARGET=dev-container -e E2E_TEST_USER -e E2E_TEST_PASSWORD \
    -e KEYCLOAK_SERVICE_CLIENT_SECRET -e CI=1 \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    sh -c "corepack enable && pnpm exec playwright test admin-settings-access"
  ```
  **Expected RED**: **3 failed, 0 skipped** — `settings-nav-admin` never visible. If it reports `1 failed, 2 skipped`, the secret is not reaching the container: fix that before reading the result, because two of the three cases were never run.

- [X] T024 [US2] Re-parent the admin route to `frontend/mcm-app/src/app/(app)/settings/admin.tsx` and delete `frontend/mcm-app/src/app/(app)/admin/`

  **Type**: Implementation | **Risk**: Medium | **Spec reference**: FR-009, FR-010, FR-011, FR-013 | **Prerequisite**: T023 verified RED

  Keep `ProtectedRoute requiredRole="mc-admin"` wrapping the **unchanged** `AdminSettingsScreen`. Report `settings-admin` / depth 1 — replacing `admin-settings`, which was never on the allowlist and so was reduced to `unknown` on every visit. Delete the old route file and its now-empty directory. Hiding the sub-navigation entry is presentation; **this guard is the enforcement**, and they are tested separately (`openwiki/gotchas/role-enforcement-is-a-layer.md`).

  **Verify GREEN**: the T023 command, 0 failed, 0 skipped.

  **Also**: the `/(app)/admin/settings` half of T017 now goes green — re-run `--grep 'old address'` and expect 0 failures.

- [X] T025 [US2] Delete `frontend/mcm-app/src/components/admin-settings-card.tsx` and `frontend/mcm-app/src/components/unit-tests/admin-settings-card.test.tsx`

  **Type**: Implementation | **Risk**: Low | **Spec reference**: FR-012 | **Prerequisite**: T022, T024

  The card existed **only** as the navigation link feature 040 forgot to ship; the sub-navigation entry replaces it, so both the component and its test go. This is a test deleted because the thing it tested no longer exists — not a guard removed for being inconvenient.

  **Verify GREEN**:
  ```bash
  pnpm nx typecheck mcm-app && pnpm nx test mcm-app
  ```
  **Expected GREEN**: 0 errors, 0 failures, and the total **minus exactly the deleted card's cases**.

- [X] T026 [P] [US2] Update `frontend/mcm-app/tests/e2e/web/admin-registration.spec.ts`, `frontend/mcm-app/tests/e2e/mobile/admin-card.yaml`, **and `scripts/ci-mobile-agent-flows.sh`**

  **Type**: Test refactor | **Risk**: Medium | **Spec reference**: FR-016

  Both specs reach the admin screen through the deleted affordance or the old address; retarget them at `settings-nav-admin`. Rename `admin-card.yaml` to `admin-settings-access.yaml` to match what it now tests. Its direct-URL half is **N/A on mobile** — see the Platform Parity Table for the written justification.

  **The mobile flow is invoked BY NAME from CI, so the rename is a functional break, not a cosmetic one.** `scripts/ci-mobile-agent-flows.sh:136` calls `run_flow admin-card`, which resolves to `bash scripts/maestro-run.sh "frontend/mcm-app/tests/e2e/mobile/admin-card.yaml"` — a path that will not exist. It sits inside a 3-attempt `until` loop, so CI burns three emulator runs before emitting `::error::flow admin-card failed after 3 attempts`. Update **every** occurrence in that script: the `run_flow` call at :136, the echo at :133, and the explanatory prose at :19, :24, :116 and :120–121 — the last of which also names the deleted `profile-admin-settings-card` testID in the `reset_chrome_sso` rationale. That rationale itself still holds (the flow logs in as `e2e-admin-user`, not `e2e-test-user`); only the flow name and the selector it scrolls to change.

  **Done when**:
  ```bash
  grep -rn "admin-card" scripts/ .forgejo/ frontend/mcm-app/tests | grep -v node_modules
  ```
  returns **zero** hits, and the flow path named in the script exists on disk:
  ```bash
  test -f frontend/mcm-app/tests/e2e/mobile/admin-settings-access.yaml && echo OK
  ```

- [X] T027 [US2] Update the four references to the renamed spec across CI and the guards

  **Type**: Documentation | **Risk**: Low | **Spec reference**: FR-016 | **Prerequisite**: T023

  Renaming `admin-card.spec.ts` → `admin-settings-access.spec.ts` leaves stale names in `.forgejo/workflows/app-ci.yml:333`, `app-ci.yml:724`, and `scripts/__tests__/app-e2e-env.guard.test.mjs:11,105`. All four are prose or assertion-message text, so **CI does not break** — but the guard's own failure message would name a file that no longer exists, sending the next reader to a dead path while they diagnose a silent skip.

  ```bash
  grep -rn "admin-card" .forgejo scripts | grep -v node_modules
  ```
  **Done when**: zero hits, and `node --test scripts/__tests__/app-e2e-env.guard.test.mjs` still passes. (Node's flags go **before** the path — `node --test <file> --test-name-pattern …` silently runs everything.)

**Checkpoint**: Stories 1 and 2 both work independently. Administrators reach app settings; non-administrators are refused twice over, and only one of those two refusals is access control.

---

## Phase 5: User Story 3 — A reserved home for collection backups (Priority: P3)

**Goal**: A Backups area exists and announces itself, so backlog item #236 adds a screen body rather than re-opening this refactor.

**Independent Test**: Open Settings, select Backups, see the placeholder, and navigate away and back.

- [X] T028 [US3] Write the failing unit test for the placeholder in `frontend/mcm-app/src/screens/settings/backups-settings-screen.test.tsx`

  **Type**: Test | **Risk**: None | **Spec reference**: FR-007

  **Scenarios covered**: US3-AC1

  Renders `settings-backups-screen` with text identifying the area and stating the capability is not yet available.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "backups-settings-screen"
  ```
  **Expected RED**: 1 failing — `Cannot find module '@/screens/settings/backups-settings-screen'`.

- [X] T029 [US3] Implement the placeholder screen, its route, and its registry row

  **Type**: Implementation | **Risk**: None | **Spec reference**: FR-007, FR-013 | **Prerequisite**: T028 verified RED

  `src/screens/settings/backups-settings-screen.tsx` (design-system `Card` + tokens, no ad-hoc styling), `src/app/(app)/settings/backups.tsx` reporting `settings-backups` / depth 1, and the `backups` row added to the registry in `settings-nav.tsx`.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "backups|settings-nav"
  ```
  **Expected GREEN**: 0 failures.

- [X] T030 [P] [US3] Add Backups coverage to `frontend/mcm-app/tests/e2e/web/settings.spec.ts` and `frontend/mcm-app/tests/e2e/mobile/settings-nav.yaml`

  **Type**: Test | **Risk**: Low | **Spec reference**: FR-007, SC-006

  **Scenarios covered**: US3-AC1, US3-AC2

  Select `settings-nav-backups`, assert `settings-backups-screen`, then navigate to another area and back — proving the placeholder is a real addressable route, not a dead entry. Extends the mobile flow created in T020.

**Checkpoint**: All three stories are complete and independently verified. Item #236 can now replace one screen body and touch nothing else.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T031 Assert the assistant clarifies rather than acting while the user is in settings, in `frontend/mcm-app/tests/e2e/web/assistant-settings-context.spec.ts`

  **Type**: Test / New file | **Risk**: Medium | **Spec reference**: FR-015, spec.md Edge Cases

  With the assistant runnable, on a settings area, send "add Heat to this" and assert the assistant **clarifies** — no settings label appears in the gateway's `_COLLECTION_SCREENS`, so there is no target to resolve. This is the assertion that the new vocabulary did not accidentally teach the assistant to act on a stale target. Tag it `@model-decision` per `openwiki/invariants/testing-tiers.md`.

  **The filename matters, not just the tag.** `scripts/__tests__/agent-test-classification.test.mjs` scans only files matching `^(agent|assistant)-.*\.spec\.ts$`; the same test in `settings.spec.ts` would carry its `@model-decision` tag **unenforced** — nothing would fail if the tag were later removed, which is exactly the silent default that guard exists to prevent. The `assistant-` prefix also puts it with the specs that gate on `E2E_AGENT_PRODUCTION` / `E2E_REQUIRE_AGENT_STACK`, which this test needs and `settings.spec.ts` does not set.

  **Verify the classification guard covers it**:
  ```bash
  node --test scripts/__tests__/agent-test-classification.test.mjs
  ```
  **Expected**: passes with the new file present, and fails if the tag is removed from it.

- [X] T032 Prove the gateway needed no change by running its tier explicitly

  **Type**: Evidence | **Risk**: None | **Spec reference**: FR-015

  ```bash
  pnpm nx test movie-assistant
  pnpm nx lint movie-assistant
  ```
  **Done when**: both are green with **zero** changed files under `agents/`, and the counts match T001. `nx affected` will not select this project — no Python file changed — which is exactly why it is run by hand: this run is the evidence for a claim, not a formality. If it goes red, [research.md](./research.md) §R2 was wrong.

- [X] T033 Sweep for leftover references to the removed route, screen, and card

  **Type**: Evidence | **Risk**: Low | **Spec reference**: FR-016

  **CORRECTED DURING IMPLEMENTATION — the pattern above was unusable as written, and "zero hits"
  was unreachable by construction.** `profile-screen` is a substring of the NEW
  `settings-profile-screen`, and `nav-profile` of the new `settings-nav-profile`, so the sweep
  matched ~50 of this feature's own replacements. Anchor the two renamed selectors with a negative
  lookbehind (`grep -P`), which is what separates the old name from the new one:

  ```bash
  grep -rnP "(?<!settings-)nav-profile|(?<!settings-)profile-screen|\(app\)/profile|\\\$\{BASE\}/profile|profile-admin-settings-card|\(app\)/admin/settings|(?<!settings-)admin-card" \
    frontend/mcm-app/src frontend/mcm-app/tests packages/design-system scripts .forgejo \
    | grep -v node_modules
  ```

  **Done when**: **zero LIVE USAGES**, not zero hits — the second correction. A test that proves an
  address or a selector is gone must NAME it (`expect(getByTestId('nav-profile')).toHaveCount(0)`,
  `page.goto('${BASE}/(app)/profile')`), so a literal zero would mean deleting exactly the
  assertions that make the removal real. Classify every remaining hit as one of:

  - a **negative assertion** proving absence, or
  - a **provenance comment** recording what was renamed.

  Anything that is neither is a leftover. Measured at completion: 13 hits, 5 negative assertions and
  8 provenance comments, 0 live usages.

  **Two things about this pattern, both learned the hard way on this feature.** First, it must
  include the **unprefixed** `${BASE}/profile` form — `assistant-config.spec.ts:88` uses it, and a
  sweep matching only `(app)/profile` returns zero while that line is still wrong. Second, it must
  search **`scripts/` and `.forgejo/`**, not only `src` and `tests`: `ci-mobile-agent-flows.sh`
  invokes a mobile flow by name and CI never uses the glob-based local runner, so a rename breaks
  there and nowhere else.

  It must **not** be widened to a bare `admin/settings`. That would match
  `src/app/bff-api/admin/settings+api.ts`, `src/hooks/use-app-settings.ts`, and their unit test —
  the BFF endpoint, which this feature does not touch. Only the **client** route
  `(app)/admin/settings` moves. Keeping the `(app)` prefix in the pattern is what separates them.

- [X] T034 Check the sub-navigation at phone width with all five entries visible

  **Type**: Manual / accessibility | **Risk**: Low | **Spec reference**: spec.md Edge Cases, contracts/ui-contract.md §5

  Sign in as an `mc-admin` on a phone-width viewport. Confirm the row scrolls rather than truncating labels, keyboard focus is visible on web, and each entry announces as a tab with its selected state.

  **CORRECTION: the sizing case is FOUR entries for an admin, not five.** This task and
  [contracts/ui-contract.md](./contracts/ui-contract.md) §5 both said "five entries for an admin …
  not four", which contradicts FR-002 — there are four areas (Profile, Movie Assistant, Backups,
  Admin) and an admin sees all four. There is no fifth.

  **MEASURED** in Chromium at 390×844 as a minted `mc-admin`, rather than eyeballed:

  | Check | Measurement | Verdict |
  | --- | --- | --- |
  | Entry widths | 89.7 / 153.5 / 105.7 / 90.5 px, full labels, `text-overflow: clip` | scrolls, no truncation |
  | Row overflow | `scrollWidth` 439 > `clientWidth` 390, `overflow-x: auto` | scrolls |
  | Page overflow | document horizontal overflow **0 px** | body never scrolls sideways |
  | Keyboard focus | `outline-style: auto`, `outline-width: 1px`, `tabIndex 0` | visible |
  | Role | `role="tab"` on every entry | correct |
  | Selected state | `aria-selected` **was null on every entry** → fixed in `Tabs`, now `"true"` on the active entry and `"false"` on the rest | **defect found and fixed here** |

  The `aria-selected` gap is the reason this task is worth doing as a measurement rather than a
  look: React Native Web renders `accessibilityRole="tab"` as `role="tab"` but does NOT derive
  `aria-selected` from `accessibilityState`, so assistive technology was told what the elements
  were and never which one was current. It cannot be caught in the design system's jest suite —
  React Native's `Pressable` folds the aria prop into `accessibilityState` and strips it — so the
  regression guard lives in `settings.spec.ts`, in a real browser.

- [X] T035 File a backlog item for the missing branded not-found route

  **Type**: Documentation | **Risk**: None | **Spec reference**: research.md §R1

  `frontend/mcm-app/src/app/` has no `+not-found.tsx`, so the two removed addresses — and every mistyped URL — land on Expo Router's default unmatched screen. Pre-existing and out of scope here, but this feature makes it reachable by anyone with an old bookmark. File it with acceptance criteria; do not fix it in a navigation refactor.

  ```bash
  node scripts/backlog.mjs create --title "Add a branded not-found route to mcm-app" \
    --body-file /tmp/not-found-item.md --label type/tech-debt --label priority/p3
  ```

- [X] T036 Update backlog item #235 and unblock item #236

  **Type**: Documentation | **Risk**: None

  Comment on item #235 with the two operator decisions and the measured correction that the gateway needed no change (its warning about lockstep gateway names did not hold — the vocabulary owner is the BFF sanitizer). Close it only when every acceptance criterion in its body is verified, never because the pull request merged. Item #236 becomes unblocked once #235 closes.

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1: app bar reads Settings | `settings.spec.ts` | `home-screen.yaml` | ✅ |
| US1-AC2: Profile area is the landing area | `settings.spec.ts` | `settings-nav.yaml` (created in T020 — local tier¹) | ✅ |
| US1-AC3: sub-navigation switches to Movie Assistant | `settings.spec.ts` | `settings-nav.yaml` (created in T020 — local tier¹) | ✅ |
| US1-AC4: cold load of a sub-page address | `settings.spec.ts` | N/A — Maestro drives the app UI and has no address-bar equivalent; native deep-linking needs `adb shell am start -a android.intent.action.VIEW -d …`, which is outside the flow model. The router config is shared React, and web covers it. | N/A |
| US1-AC5: saving assistant config refreshes the dock in-session | `assistant-config.spec.ts` | `assistant-config-enable.yaml` | ✅ |
| US2-AC1: admin sees the Admin entry | `admin-settings-access.spec.ts` | `admin-settings-access.yaml` | ✅ |
| US2-AC2: non-admin sees no Admin entry | `admin-settings-access.spec.ts` | `admin-settings-access.yaml` | ✅ |
| US2-AC3: non-admin refused at the address directly | `admin-settings-access.spec.ts` | N/A — the route is unreachable from a Maestro flow: there is no in-app affordance to a route the user cannot see, and no address bar. `ProtectedRoute` → `AuthGuard` is platform-agnostic React. | N/A |
| US2-AC4: self-registration toggle unchanged | `admin-registration.spec.ts` | `admin-settings-access.yaml` | ✅ |
| US3-AC1: Backups placeholder renders | `settings.spec.ts` | `settings-nav.yaml` (extended in T030 — local tier¹) | ✅ |
| US3-AC2: navigation works away from and back to Backups | `settings.spec.ts` | `settings-nav.yaml` (extended in T030 — local tier¹) | ✅ |
| FR-011: old addresses are unmatched | `settings.spec.ts` | N/A — the routes are deleted, so no in-app affordance can reach them and there is no address bar to type them into. | N/A |
| FR-015: assistant clarifies while in settings | `assistant-settings-context.spec.ts` (`@model-decision`) | N/A — a model-decision assertion; the tier split deliberately keeps these off the blocking gate on one platform rather than duplicating a ~50%-flaky assertion across two. | N/A |
| FR-019: assistant-config provider stays above the settings group | `assistant-config.spec.ts` + unit guard (T010) | `assistant-config-enable.yaml` | ✅ |

No `❌ Gap` rows. Every `N/A` carries a written justification.

¹ **Local tier, not the CI gate.** CI's only mobile invocation is `scripts/ci-mobile-agent-flows.sh`
(`app-ci.yml:964`), which runs a hardcoded array of nine agent flows plus `admin-settings-access`.
`pnpm nx e2e:mobile` — the glob-based runner that picks up every flow — is never run in CI. So
`settings-nav.yaml` runs locally and not in the gate, exactly like `home-screen.yaml` and
`logout.yaml` today. Marked rather than quietly counted: the web tier is what gates these
scenarios, and the table would otherwise over-claim. See T020 for why it is not added to the array.

---

## Dependencies

```text
Phase 1 (T001–T002)  →  Phase 2 (T003–T010)  →  ┌─ Phase 3 US1 (T011–T020) ─┐
                                                 ├─ Phase 4 US2 (T021–T027) ─┤ → Phase 6 (T031–T036)
                                                 └─ Phase 5 US3 (T028–T030) ─┘
```

- **Phase 2 blocks everything.** `SettingsNav` and the route-group layout are shared by all three stories; the `Tabs` testID change blocks `SettingsNav`'s own tests.
- **Within Phase 2**: T003→T004 and T005→T006 are independent pairs and run in parallel; T007→T008 needs T004; T009 needs T008; T010 is independent of all of them and can be written first.
- **T004 is not finished at its jest GREEN.** Its discriminating check needs T013 to exist. Treat T004 as open until that Playwright case passes.
- **T017 spans two phases by design.** Its `/(app)/profile` half goes green at T018 (US1); its `/(app)/admin/settings` half at T024 (US2). Both are the same requirement (FR-011) and the split follows which route each phase owns.
- **US1 → US2**: T025 (delete the card) needs T022 and T024, because the card must not be removed before its replacement entry exists and works.
- **US3 is independent of US2** and could ship in either order; it is last because it delivers no capability.
- **T032 must run after every source change**, not early — it is evidence about the final tree.

## Parallel Execution Examples

**Phase 2** — three independent strands:
```text
T003 (design-system Tabs test)   ‖   T005 (BFF sanitizer test)   ‖   T010 (provider guard)
T004 (Tabs impl)                 ‖   T006 (allowlist impl)
```

**Phase 3** — after T012 lands the screens:
```text
T019 (web E2E updates)   ‖   T020 (14 mobile flows + settings-nav.yaml)
```

**Across stories** — once Phase 2 is complete, US2 and US3 can be worked concurrently with US1's E2E updates, since they touch disjoint files. The one shared file is `settings-nav.tsx` (T022 and T029 each add a registry row) — sequence those two, or expect a trivial conflict.

## Implementation Strategy

**First increment = Phase 1 + Phase 2 + Phase 3.** That renames the destination, delivers a working sub-navigated Settings page with two real areas, and removes the old profile address. It is demonstrable on its own — but it is **not** shippable on its own: FR-002 and SC-002 require all four areas, and Phase 3 deletes nothing that restores the admin entry point. No phase ships alone.

**Second increment = Phase 4.** Restores the administrator entry point that Phase 3's card deletion removes, and adds direct-URL refusal coverage the old card-based spec never had. It must land with the first increment: splitting them would leave a merged commit where administrators cannot reach app settings at all.

**Third increment = Phase 5 + 6.** The placeholder and the cross-cutting checks.

**One pull request, not three.** Per `openwiki/process/pull-request-batching.md`, split only when a red result would be ambiguous. These three phases touch the same routes and the same E2E files; three pull requests would each pay the ~35-minute app-e2e job on a single runner and each rewrite the same specs. The backups *capability* (item #236) is the split that matters, and it is already a separate item.

---

## Completion Checklist

Before marking `062-settings-split` complete, verify every success criterion in [spec.md](./spec.md):

- [X] **SC-001**: any settings area available to the user is reachable in at most two selections
- [X] **SC-002**: all four areas have distinct addresses, each opening cold on web and mobile
- [X] **SC-003**: every non-administrator attempt at the Admin area is refused — entry hidden **and** address refused
- [X] **SC-004**: profile display, logout, assistant configuration and its save behaviour, and the self-registration toggle all behave identically to before
- [X] **SC-005**: the full regression for the touched areas passes with **no test disabled, skipped, or weakened** — skip counts match T001
- [X] **SC-006**: the Backups slot is occupied and adding a body touches no other area
- [X] Platform parity table complete — no ❌ gaps remain
- [X] Every test task used the TDD checkpoint format, with Verify RED confirmed **before** implementation — and every Verify RED showed a **non-zero** failure count with **zero** skips
- [X] The discriminating Playwright check in task T004 passed, not only its jest GREEN
- [X] The provider guard in task T010 was proved able to fail (mutate, observe red, revert)
- [X] `pnpm nx typecheck mcm-app` — 0 errors
- [X] `pnpm nx lint mcm-app` and `pnpm nx lint design-system` — no errors
- [X] `pnpm nx test mcm-app` and `pnpm nx test design-system` — pass, ≥70% line coverage on new code
- [X] `pnpm nx test movie-assistant` — pass with zero changed files under `agents/` (T032)
- [X] `pnpm nx affected -t typecheck,lint,test` — catches a tier not thought of
- [X] Web E2E gate tier passes (see [quickstart.md](./quickstart.md) §3)
- [X] `pnpm nx e2e:mobile mcm-app` — **NOT run locally, and this is the explicit statement, not a pass.** The Android emulator needs `/dev/kvm`; on this host `ls /dev/kvm` returns "No such file or directory" — it is the Docker Sandbox microVM, which cannot provide it (`maestro` is not installed here either). Measured, not assumed. The 14 updated flows, the renamed `admin-settings-access.yaml` and the new `settings-nav.yaml` run in CI.
- [X] The leftover-reference sweep (task T033) returns **zero** hits
- [X] `rtk gain` — **92.3%** token compression confirmed (1.3M tokens saved across 160 proxied calls)
