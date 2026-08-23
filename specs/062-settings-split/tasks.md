# Tasks: Settings destination with sub-navigation

**Input**: Design documents from `/specs/062-settings-split/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/ui-contract.md](./contracts/ui-contract.md), [quickstart.md](./quickstart.md)

**Tests**: REQUIRED. TDD is non-negotiable in this repository's constitution — every test task carries a **Verify RED** command with its expected failure, and every paired implementation task carries a **Verify GREEN**. A Verify RED showing 0 failures means the test is trivially passing and must be corrected before implementation begins.

**Organization**: Grouped by user story so each phase is an independently testable increment. Each story owns its route file, its screen, **and its row in the settings-area registry** — so after any phase the sub-navigation offers exactly the areas that exist.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task
- **[US1] / [US2] / [US3]**: the user story from [spec.md](./spec.md); Setup, Foundational, and Polish tasks carry no story label

## Path Conventions

Constitution-mandated frontend layout: App-Layer `frontend/mcm-app/src/app/`, Components-Layer `src/components/`, Screens-Layer `src/screens/`, Hooks-Layer `src/hooks/`, BFF utilities `src/bff-server/`. App-Layer unit tests live in `frontend/mcm-app/tests/app/` — **never** under `src/app/`, where a test file would become a route.

---

## Phase 1: Setup

**Purpose**: Establish the baseline that every later "did anything stop being tested?" judgement is made against.

- [ ] T001 Record baseline pass/skip counts for the four touched tiers in `specs/062-settings-split/baseline-counts.md`

  **Type**: Config / evidence | **Risk**: None | **Spec reference**: SC-005

  Run each tier on the unmodified branch and write down **both** the pass count and the **skip count**:
  ```bash
  pnpm nx test mcm-app
  pnpm nx test design-system
  pnpm nx test movie-assistant
  pnpm nx typecheck mcm-app
  ```
  **Done when**: the file records pass *and* skip counts per tier. A skipped test reads as a pass; without the starting skip count there is no way to notice one appearing later. This is the instrument check, not busywork.

- [ ] T002 Confirm the "no gateway source change" claim in `agents/movie-assistant/src/` before relying on it

  **Type**: Evidence | **Risk**: None | **Spec reference**: FR-015, research.md §R2

  ```bash
  grep -rn "current_screen\|_COLLECTION_SCREENS\|'profile'\|\"profile\"" agents/movie-assistant/src/
  ```
  **Done when**: the only hits are `nodes/organizer.py` `_COLLECTION_SCREENS = {"collection", "movie-detail"}` and its `movie-detail` comparison, and `profile` appears nowhere. If this returns anything else, [research.md](./research.md) §R2 is wrong and gateway tasks must be added to this file before proceeding.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared pieces every story needs — the design-system capability, the screen-label vocabulary, and the navigation shell.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 [P] Write the failing test for per-tab `testID` reaching a host node in `packages/design-system/components/navigation/navigation.test.tsx`

  **Type**: Test | **Risk**: Low | **Spec reference**: contracts/ui-contract.md §2

  **Scenarios covered**: US1-AC3 (the sub-navigation must be locatable by automation on web and native)

  Render `Tabs` with a `TabItem` carrying `testID: 'settings-nav-assistant'` and assert `getByTestId('settings-nav-assistant')` resolves and that pressing it calls `onTabChange` with that tab's key. Today `Tabs` maps each tab to a Tamagui `View`, which drops `testID` on React Native Web — the same limitation `components/admin-settings-card.tsx` documents for the design system's `Card`.

  **Verify RED**:
  ```bash
  pnpm nx test design-system -- --testNamePattern "testID"
  ```
  **Expected RED**: 1 failing — `Unable to find an element with testID: settings-nav-assistant`.

- [ ] T004 Add the optional `TabItem.testID`, rendered on a React Native host node, in `packages/design-system/components/navigation/Tabs.tsx`

  **Type**: Implementation | **Risk**: Low | **Prerequisite**: T003 verified RED

  Add `testID?: string` to `TabItem`. Wrap each tab's Tamagui `View` in a plain RN `Pressable` that carries the `testID`, the `onPress`, and `accessibilityRole="tab"` / `accessibilityState={{ selected }}`, leaving the `View` non-interactive inside it — the exact shape `admin-settings-card.tsx` uses and explains. Keep the prop optional so existing callers are unaffected. Annotate the `testID` as a stable external-contract selector, per the constitution's carve-out.

  **Verify GREEN**:
  ```bash
  pnpm nx test design-system -- --testNamePattern "testID"
  ```
  **Expected GREEN**: 0 failures.

  **Also run the touched suite**:
  ```bash
  pnpm nx test design-system && pnpm nx lint design-system
  ```
  **Expected**: previously passing tests still pass; the indicator animation and layout tests are unaffected.

- [ ] T005 [P] Write the failing allowlist test for the four settings labels in `frontend/mcm-app/src/bff-server/unit-tests/ui-state-sanitizer.test.ts`

  **Type**: Test | **Risk**: None | **Spec reference**: FR-013, FR-014

  Assert that `settings`, `settings-assistant`, `settings-backups`, `settings-admin` each survive `sanitizeUiState` unchanged; that the retired `profile` and `admin-settings` now collapse to `unknown`; and — unchanged, restated because the vocabulary is being edited — that an arbitrary string still collapses to `unknown`.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "ui-state-sanitizer"
  ```
  **Expected RED**: 4 failing — each new label received as `'unknown'` instead of itself.

- [ ] T006 Update `ALLOWED_SCREENS` in `frontend/mcm-app/src/bff-server/ui-state-sanitizer.ts` and widen the union in `frontend/mcm-app/src/hooks/use-ui-state.tsx`

  **Type**: Implementation | **Risk**: Low | **Prerequisite**: T005 verified RED

  Replace `'profile'` in `ALLOWED_SCREENS` with the four `settings*` labels from [data-model.md](./data-model.md) §2. Widen `UiSnapshot.current_screen` to match. The allowlist is the enforcement point; the union is only a developer hint and ends in `| string`, which is exactly how `admin-settings` drifted into being reported but never allowed.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "ui-state-sanitizer"
  ```
  **Expected GREEN**: 0 failures.

- [ ] T007 Write the failing tests for the settings sub-navigation in `frontend/mcm-app/src/components/settings/settings-nav.test.tsx`

  **Type**: Test | **Risk**: Low | **Spec reference**: FR-003, FR-008

  **Scenarios covered**: US1-AC2, US1-AC3, US2-AC1, US2-AC2

  Cover: the container renders `settings-nav`; a row renders per registry entry with its `settings-nav-*` testID; the entry matching the current path is marked selected and the others are not; the `index` row is active **only** on the exact group path and not on a child path (`NavigationBar` gets this wrong today with `startsWith` — do not copy that shape); the admin row is **absent from the tree** for a non-admin, not merely styled invisible; and it is present for an `mc-admin`.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "settings-nav"
  ```
  **Expected RED**: 6 failing — `Cannot find module '@/components/settings/settings-nav'`.

- [ ] T008 Implement `SettingsNav` in `frontend/mcm-app/src/components/settings/settings-nav.tsx`

  **Type**: Implementation | **Risk**: Medium | **Prerequisite**: T007 verified RED

  Compose the design system's `Tabs` with `scrollable` so five entries remain usable at phone width. Declare the settings-area registry as a module-level constant per [data-model.md](./data-model.md) §1 — **seeded with the Profile and Movie Assistant rows only**; US2 and US3 each add their own row. Filter `adminOnly` rows with `isAdmin(user)` from `@/utils/role-checker`. Derive the active row from `usePathname()` with an exact match for `index`. Navigate with `router.navigate`. Styles at the bottom of the file, one named export, no ad-hoc `StyleSheet` colours or spacing — tokens only.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "settings-nav"
  ```
  **Expected GREEN**: 0 failures.

- [ ] T009 Create the settings route-group layout at `frontend/mcm-app/src/app/(app)/settings/_layout.tsx`

  **Type**: Config | **Risk**: Medium | **Spec reference**: FR-003, research.md §R4, §R5

  Render `<SettingsNav />` above a nested `<Stack screenOptions={{ headerShown: false }} />`, with the `Stack` wrapped in a `flex: 1` `View` — React Native Web's absolutely-positioned screen containers collapse to zero height without an explicit parent height, clipping every child screen, which `(app)/_layout.tsx` already documents. Must be a **directory** route with `_layout.tsx`, never a `settings.tsx` file route: a file route cannot host nested children, the trap recorded in `openwiki/gotchas/expo-router-collection-routing.md`. Do **not** move `AssistantConfigProvider` here — see [research.md](./research.md) §R7.

  **Done when**: the layout composes navigation only and holds no screen content. It has no branching logic to unit-test; its behaviour is asserted by the US1 web E2E (T012), which is the deliberate reason this task has no RED/GREEN pair.

**Checkpoint**: The design system can be automated, the label vocabulary is enforced, and the navigation shell exists. User story work can begin.

---

## Phase 3: User Story 1 — Reach a specific settings area directly (Priority: P1) 🎯 MVP

**Goal**: `Settings` replaces `Profile` in the app bar and opens a sub-navigated destination whose Profile and Movie Assistant areas each have their own address.

**Independent Test**: Log in, confirm the app bar reads **Settings**, switch between Profile and Movie Assistant via the sub-navigation, then reload the browser directly on each address and confirm the same area opens with its sub-navigation intact.

- [ ] T010 [P] [US1] Write the failing unit tests for the two new screens in `frontend/mcm-app/src/screens/settings/profile-settings-screen.test.tsx` and `frontend/mcm-app/src/screens/settings/assistant-settings-screen.test.tsx`

  **Type**: Test | **Risk**: Low | **Spec reference**: FR-005, FR-006

  **Scenarios covered**: US1-AC2, US1-AC3

  Profile screen: renders `settings-profile-screen` with `ProfileDisplay` and the logout control; renders `settings-profile-loading` while auth is loading and `settings-profile-empty` with no user; renders **no** admin card and **no** assistant config — the split is the point. Assistant screen: renders `settings-assistant-screen` containing `assistant-config`.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "screens/settings"
  ```
  **Expected RED**: 5 failing — `Cannot find module '@/screens/settings/profile-settings-screen'` and the assistant equivalent.

- [ ] T011 [US1] Implement the two screens in `frontend/mcm-app/src/screens/settings/profile-settings-screen.tsx` and `frontend/mcm-app/src/screens/settings/assistant-settings-screen.tsx`

  **Type**: Implementation | **Risk**: Low | **Prerequisite**: T010 verified RED

  Move the bodies out of `src/screens/auth/profile-screen.tsx`: `ProfileDisplay` + logout into the profile screen, `MovieAssistantConfig` into the assistant screen. Carry the `paddingBottom: 180` scroll allowance — **and its explanatory comment** — onto the **assistant** screen, not the profile one: it exists so the mobile E2E can scroll the Save button clear of the floating dock toggle overlay, and dropping it makes that tap get swallowed with no save and no banner. Rename the testIDs per [contracts/ui-contract.md](./contracts/ui-contract.md) §2 and annotate each as a stable external-contract selector.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "screens/settings"
  ```
  **Expected GREEN**: 0 failures.

- [ ] T012 [US1] Write the failing web E2E for the settings destination in `frontend/mcm-app/tests/e2e/web/settings.spec.ts`

  **Type**: Test / New file | **Risk**: Medium | **Spec reference**: FR-001, FR-002, FR-004, FR-011, FR-018

  **Scenarios covered**: US1-AC1, US1-AC2, US1-AC3, US1-AC4

  Assert: `nav-settings` exists with text **Settings** and `nav-profile` has count 0; selecting it lands on `/(app)/settings` showing `settings-profile-screen` and `settings-nav`; selecting `settings-nav-assistant` shows `assistant-config` with the sub-navigation still present; a **cold** `page.goto` of `/(app)/settings/assistant` renders that area directly, asserted without first navigating in-app; and `page.goto('/(app)/profile')` leaves `settings-profile-screen` at count 0 — the removal is real, not a silent alias.

  **Verify RED**: run the Playwright image (browsers are baked in; `playwright install` cannot work in this dev container — the CDN is not in the egress allow-list):
  ```bash
  docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
    -e E2E_BFF_TARGET=dev-container -e E2E_TEST_USER -e E2E_TEST_PASSWORD -e CI=1 \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    sh -c "corepack enable && pnpm exec playwright test settings.spec.ts"
  ```
  **Expected RED**: 4 failing — `nav-settings` never becomes visible.

  > Before trusting this run, prove the image carries your change:
  > `docker run --rm --entrypoint sh mcm-bff:latest -c "grep -rl settings-nav /app/runtime/dist | head -1"`.
  > The bundle is **baked, not mounted**; empty output means stale, and the path is `/app/runtime/dist`, not `/app/dist`.

- [ ] T013 [US1] Add the Profile and Movie Assistant routes in `frontend/mcm-app/src/app/(app)/settings/index.tsx` and `frontend/mcm-app/src/app/(app)/settings/assistant.tsx`

  **Type**: Implementation | **Risk**: Low | **Prerequisite**: T010–T012

  Each route is thin: call `useReportUiState` with its label and depth from [data-model.md](./data-model.md) §2 (`settings`/0 and `settings-assistant`/1) and return its screen. Routes never define screen components.

- [ ] T014 [US1] Rename the app-bar destination in `frontend/mcm-app/src/components/navigation-bar.tsx` and its test in `frontend/mcm-app/src/components/navigation-bar.test.tsx`

  **Type**: Test + Implementation | **Risk**: Low | **Spec reference**: FR-001

  Update the test first to expect `nav-settings` with label **Settings** targeting `/(app)/settings`.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "navigation-bar"
  ```
  **Expected RED**: 1 failing — `Unable to find an element with testID: nav-settings`.

  Then change the `links` entry. **Verify GREEN**: the same command, 0 failures.

- [ ] T015 [US1] Delete the pre-split route and screen: `frontend/mcm-app/src/app/(app)/profile.tsx` and `frontend/mcm-app/src/screens/auth/profile-screen.tsx`

  **Type**: Implementation | **Risk**: Medium | **Spec reference**: FR-011 | **Prerequisite**: T011, T013

  Removed, not redirected — the operator decision in [research.md](./research.md) §R1. `typecheck` is the cheapest detector of anything still pointing at them.

  **Verify GREEN**:
  ```bash
  pnpm nx typecheck mcm-app
  ```
  **Expected GREEN**: 0 errors.

- [ ] T016 [US1] Update the web E2E specs that navigate to the old destination: `auth.spec.ts`, `assistant-config.spec.ts`, `bff-prod-lifecycle.spec.ts` under `frontend/mcm-app/tests/e2e/web/`

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

- [ ] T017 [P] [US1] Update the mobile flows that navigate to the old destination — 14 files under `frontend/mcm-app/tests/e2e/mobile/`

  **Type**: Test refactor | **Risk**: Medium | **Spec reference**: FR-016

  `assistant-add.yaml`, `assistant-add-ambiguous.yaml`, `assistant-config-disable.yaml`, `assistant-config-enable.yaml`, `assistant-config-enable-anthropic.yaml`, `assistant-config-gating.yaml`, `assistant-config-test-connection.yaml`, `assistant-context.yaml`, `assistant-navigate.yaml`, `assistant-organize.yaml`, `assistant-organize-move.yaml`, `home-screen.yaml`, `login-invalid.yaml`, `logout.yaml`. Replace the testIDs, and add the `settings-nav-assistant` step to every `assistant-config-*` flow. Search for the visible text `Profile` as well as the testIDs — a flow that taps by label will not appear in a testID search.

  **Verify GREEN**:
  ```bash
  pnpm nx e2e:mobile mcm-app
  ```
  **Expected GREEN**: 0 failures. Needs `/dev/kvm`, which the Docker Sandbox microVM cannot provide — on that host this tier runs in CI, and that must be **stated**, not reported as passing.

**Checkpoint**: The MVP is complete and demonstrable. The destination is named Settings, has two working areas, each independently addressable, and the old address is gone.

---

## Phase 4: User Story 2 — Administer app-wide settings from the same destination (Priority: P2)

**Goal**: The Admin area joins the sub-navigation for administrators, with the route's own role guard as the actual enforcement.

**Independent Test**: As an administrator, see the Admin entry, open it, and change the self-registration setting. As a non-administrator, see no entry — and be refused when navigating to the address directly.

- [ ] T018 [US2] Add the admin registry row and its visibility tests to `frontend/mcm-app/src/components/settings/settings-nav.tsx` and `settings-nav.test.tsx`

  **Type**: Test + Implementation | **Risk**: Low | **Spec reference**: FR-008

  **Scenarios covered**: US2-AC1, US2-AC2

  Extend the test first: an `mc-admin` sees `settings-nav-admin`; an `mc-user` gets `queryByTestId(...) === null` — absent from the tree, not hidden.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "settings-nav"
  ```
  **Expected RED**: 1 failing — `settings-nav-admin` not found for the admin case.

  Then add the `adminOnly: true` row. **Verify GREEN**: the same command, 0 failures.

- [ ] T019 [US2] Write the failing web E2E for admin visibility **and** direct-URL refusal in `frontend/mcm-app/tests/e2e/web/admin-card.spec.ts`, renamed to `admin-settings-access.spec.ts`

  **Type**: Test refactor | **Risk**: Medium | **Spec reference**: FR-008, FR-009

  **Scenarios covered**: US2-AC1, US2-AC2, US2-AC3

  The affordance this file tests is being deleted, so it is reworked rather than patched. Keep both existing cases, retargeted at the sub-navigation entry, and **add** the case the card-based spec never had: a signed-in `mc-user` navigates straight to `/(app)/settings/admin` **without ever rendering the sub-navigation**, and `admin-settings-screen` has count 0. That last case is the only one that tests access control; the other two test presentation.

  **Verify RED**:
  ```bash
  docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
    -e E2E_BFF_TARGET=dev-container -e E2E_TEST_USER -e E2E_TEST_PASSWORD -e CI=1 \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    sh -c "corepack enable && pnpm exec playwright test admin-settings-access"
  ```
  **Expected RED**: 3 failing — `settings-nav-admin` never visible.

- [ ] T020 [US2] Re-parent the admin route to `frontend/mcm-app/src/app/(app)/settings/admin.tsx` and delete `frontend/mcm-app/src/app/(app)/admin/`

  **Type**: Implementation | **Risk**: Medium | **Spec reference**: FR-009, FR-010, FR-011 | **Prerequisite**: T019 verified RED

  Keep `ProtectedRoute requiredRole="mc-admin"` wrapping the **unchanged** `AdminSettingsScreen`. Report `settings-admin` / depth 1 — replacing `admin-settings`, which was never on the allowlist and so was reduced to `unknown` on every visit. Delete the old route file and its now-empty directory. Hiding the sub-navigation entry is presentation; **this guard is the enforcement**, and they are tested separately (`openwiki/gotchas/role-enforcement-is-a-layer.md`).

  **Verify GREEN**: the T019 command, 0 failures.

- [ ] T021 [US2] Delete `frontend/mcm-app/src/components/admin-settings-card.tsx` and `frontend/mcm-app/src/components/unit-tests/admin-settings-card.test.tsx`

  **Type**: Implementation | **Risk**: Low | **Spec reference**: FR-012 | **Prerequisite**: T018, T020

  The card existed **only** as the navigation link feature 040 forgot to ship; the sub-navigation entry replaces it, so both the component and its test go. This is a test deleted because the thing it tested no longer exists — not a guard removed for being inconvenient.

  **Verify GREEN**:
  ```bash
  pnpm nx typecheck mcm-app && pnpm nx test mcm-app
  ```
  **Expected GREEN**: 0 errors, 0 failures, and the total **minus exactly the deleted card's cases**.

- [ ] T022 [P] [US2] Update `frontend/mcm-app/tests/e2e/web/admin-registration.spec.ts` and `frontend/mcm-app/tests/e2e/mobile/admin-card.yaml`

  **Type**: Test refactor | **Risk**: Low | **Spec reference**: FR-016

  Both reach the admin screen through the deleted affordance or the old address; retarget them at `settings-nav-admin`. Rename `admin-card.yaml` to `admin-settings-access.yaml` to match what it now tests. Its direct-URL half is **N/A on mobile** — see the Platform Parity Table for the written justification.

**Checkpoint**: Stories 1 and 2 both work independently. Administrators reach app settings; non-administrators are refused twice over.

---

## Phase 5: User Story 3 — A reserved home for collection backups (Priority: P3)

**Goal**: A Backups area exists and announces itself, so backlog item #236 adds a screen body rather than re-opening this refactor.

**Independent Test**: Open Settings, select Backups, see the placeholder, and navigate away and back.

- [ ] T023 [US3] Write the failing unit test for the placeholder in `frontend/mcm-app/src/screens/settings/backups-settings-screen.test.tsx`

  **Type**: Test | **Risk**: None | **Spec reference**: FR-007

  **Scenarios covered**: US3-AC1

  Renders `settings-backups-screen` with text identifying the area and stating the capability is not yet available.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "backups-settings-screen"
  ```
  **Expected RED**: 1 failing — `Cannot find module '@/screens/settings/backups-settings-screen'`.

- [ ] T024 [US3] Implement the placeholder screen, its route, and its registry row

  **Type**: Implementation | **Risk**: None | **Prerequisite**: T023 verified RED

  `src/screens/settings/backups-settings-screen.tsx` (design-system `Card` + tokens, no ad-hoc styling), `src/app/(app)/settings/backups.tsx` reporting `settings-backups` / depth 1, and the `backups` row added to the registry in `settings-nav.tsx`.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern "backups|settings-nav"
  ```
  **Expected GREEN**: 0 failures.

- [ ] T025 [P] [US3] Add Backups coverage to `frontend/mcm-app/tests/e2e/web/settings.spec.ts` and `frontend/mcm-app/tests/e2e/mobile/settings-nav.yaml`

  **Type**: Test | **Risk**: Low | **Spec reference**: FR-007, SC-006

  **Scenarios covered**: US3-AC1, US3-AC2

  Select `settings-nav-backups`, assert `settings-backups-screen`, then navigate to another area and back — proving the placeholder is a real addressable route, not a dead entry.

**Checkpoint**: All three stories are complete and independently verified. Item #236 can now replace one screen body and touch nothing else.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T026 Assert the assistant clarifies rather than acting while the user is in settings, in `frontend/mcm-app/tests/e2e/web/settings.spec.ts`

  **Type**: Test | **Risk**: Medium | **Spec reference**: FR-015, spec.md Edge Cases

  With the assistant runnable, on a settings area, send "add Heat to this" and assert the assistant **clarifies** — no settings label appears in the gateway's `_COLLECTION_SCREENS`, so there is no target to resolve. This is the assertion that the new vocabulary did not accidentally teach the assistant to act on a stale target. Tag it per `openwiki/invariants/testing-tiers.md`: it depends on a model decision, so it belongs in the `@model-decision` tier — **an unclassified agent test fails the gate rather than defaulting into a tier**.

- [ ] T027 Prove the gateway needed no change by running its tier explicitly

  **Type**: Evidence | **Risk**: None | **Spec reference**: FR-015

  ```bash
  pnpm nx test movie-assistant
  pnpm nx lint movie-assistant
  ```
  **Done when**: both are green with **zero** changed files under `agents/`, and the counts match T001. `nx affected` will not select this project — no Python file changed — which is exactly why it is run by hand: this run is the evidence for a claim, not a formality. If it goes red, [research.md](./research.md) §R2 was wrong.

- [ ] T028 Sweep for leftover references to the removed route, screen, and card

  **Type**: Evidence | **Risk**: Low | **Spec reference**: FR-016

  ```bash
  grep -rn "nav-profile\|profile-screen\|(app)/profile\|profile-admin-settings-card\|(app)/admin/settings" \
    frontend/mcm-app/src frontend/mcm-app/tests packages/design-system | grep -v node_modules
  ```
  **Done when**: **zero** hits. The starting point was 64 hits across 20 files; a non-zero result here means a spec still navigates somewhere that no longer exists — and on a mobile flow that reads as a timeout, not a 404.

- [ ] T029 Check the sub-navigation at phone width with all five entries visible

  **Type**: Manual / accessibility | **Risk**: Low | **Spec reference**: spec.md Edge Cases, contracts/ui-contract.md §5

  Sign in as an `mc-admin` on a phone-width viewport. Five entries is the sizing case, not four. Confirm the row scrolls rather than truncating labels, keyboard focus is visible on web, and each entry announces as a tab with its selected state.

- [ ] T030 File a backlog item for the missing branded not-found route

  **Type**: Documentation | **Risk**: None | **Spec reference**: research.md §R1

  `frontend/mcm-app/src/app/` has no `+not-found.tsx`, so the two removed addresses — and every mistyped URL — land on Expo Router's default unmatched screen. Pre-existing and out of scope here, but this feature makes it reachable by anyone with an old bookmark. File it with acceptance criteria; do not fix it in a navigation refactor.

  ```bash
  node scripts/backlog.mjs create --title "Add a branded not-found route to mcm-app" \
    --body-file /tmp/not-found-item.md --label type/tech-debt --label priority/p3
  ```

- [ ] T031 Update backlog item #235 and unblock item #236

  **Type**: Documentation | **Risk**: None

  Comment on item #235 with the two operator decisions and the measured correction that the gateway needed no change (its warning about lockstep gateway names did not hold — the vocabulary owner is the BFF sanitizer). Close it only when every acceptance criterion in its body is verified, never because the pull request merged. Item #236 becomes unblocked once #235 closes.

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1: app bar reads Settings | `settings.spec.ts` | `home-screen.yaml` | ✅ |
| US1-AC2: Profile area is the landing area | `settings.spec.ts` | `[create: settings-nav.yaml]` | ✅ |
| US1-AC3: sub-navigation switches to Movie Assistant | `settings.spec.ts` | `assistant-config-enable.yaml` | ✅ |
| US1-AC4: cold load of a sub-page address | `settings.spec.ts` | N/A — Maestro drives the app UI and has no address-bar equivalent; native deep-linking needs `adb shell am start -a android.intent.action.VIEW -d …`, which is outside the flow model. The router config is shared React, and web covers it. | N/A |
| US1-AC5: saving assistant config refreshes the dock in-session | `assistant-config.spec.ts` | `assistant-config-enable.yaml` | ✅ |
| US2-AC1: admin sees the Admin entry | `admin-settings-access.spec.ts` | `admin-settings-access.yaml` | ✅ |
| US2-AC2: non-admin sees no Admin entry | `admin-settings-access.spec.ts` | `admin-settings-access.yaml` | ✅ |
| US2-AC3: non-admin refused at the address directly | `admin-settings-access.spec.ts` | N/A — the route is unreachable from a Maestro flow: there is no in-app affordance to a route the user cannot see, and no address bar. `ProtectedRoute` → `AuthGuard` is platform-agnostic React. | N/A |
| US2-AC4: self-registration toggle unchanged | `admin-registration.spec.ts` | `admin-settings-access.yaml` | ✅ |
| US3-AC1: Backups placeholder renders | `settings.spec.ts` | `[create: settings-nav.yaml]` | ✅ |
| US3-AC2: navigation works away from and back to Backups | `settings.spec.ts` | `[create: settings-nav.yaml]` | ✅ |
| FR-011: old addresses are unmatched | `settings.spec.ts` | N/A — the routes are deleted, so no in-app affordance can reach them and there is no address bar to type them into. | N/A |
| FR-015: assistant clarifies while in settings | `settings.spec.ts` (`@model-decision`) | N/A — a model-decision assertion; the tier split deliberately keeps these off the blocking gate on one platform rather than duplicating a ~50%-flaky assertion across two. | N/A |

No `❌ Gap` rows. Every `N/A` carries a written justification.

---

## Dependencies

```text
Phase 1 (T001–T002)  →  Phase 2 (T003–T009)  →  ┌─ Phase 3 US1 (T010–T017) ─┐
                                                 ├─ Phase 4 US2 (T018–T022) ─┤ → Phase 6 (T026–T031)
                                                 └─ Phase 5 US3 (T023–T025) ─┘
```

- **Phase 2 blocks everything.** `SettingsNav` and the route-group layout are shared by all three stories; the `Tabs` testID change blocks `SettingsNav`'s own tests.
- **Within Phase 2**: T003→T004 and T005→T006 are independent pairs and run in parallel; T007→T008 needs T004; T009 needs T008.
- **US1 → US2**: T021 (delete the card) needs T018 and T020, because the card must not be removed before its replacement entry exists and works.
- **US3 is independent of US2** and could ship in either order; it is last because it delivers no capability.
- **T027 must run after every source change**, not early — it is evidence about the final tree.

## Parallel Execution Examples

**Phase 2** — two independent test/impl pairs:
```text
T003 (design-system Tabs test)   ‖   T005 (BFF sanitizer test)
T004 (Tabs impl)                 ‖   T006 (allowlist impl)
```

**Phase 3** — after T011 lands the screens:
```text
T016 (web E2E updates)   ‖   T017 (13 mobile flows)
```

**Across stories** — once Phase 2 is complete, US2 and US3 can be worked concurrently with US1's E2E updates, since they touch disjoint files. The one shared file is `settings-nav.tsx` (T018 and T024 each add a registry row) — sequence those two, or expect a trivial conflict.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3.** That alone renames the destination, delivers a working sub-navigated Settings page with two real areas, and removes the old address. It is demonstrable and shippable on its own.

**Increment 2 = Phase 4.** Restores the administrator entry point that Phase 3 removes with the card, and adds direct-URL refusal coverage the old card-based spec never had. Ship together with the MVP in one pull request — splitting them would leave a merged commit where administrators cannot reach app settings.

**Increment 3 = Phase 5 + 6.** The placeholder and the cross-cutting checks.

**One pull request, not three.** Per `openwiki/process/pull-request-batching.md`, split only when a red result would be ambiguous. These three phases touch the same routes and the same E2E files; three pull requests would each pay the ~35-minute app-e2e job on a single runner and each rewrite the same specs. The backups *capability* (item #236) is the split that matters, and it is already a separate item.

---

## Completion Checklist

Before marking `062-settings-split` complete, verify every success criterion in [spec.md](./spec.md):

- [ ] **SC-001**: any settings area available to the user is reachable in at most two selections
- [ ] **SC-002**: all four areas have distinct addresses, each opening cold on web and mobile
- [ ] **SC-003**: every non-administrator attempt at the Admin area is refused — entry hidden **and** address refused
- [ ] **SC-004**: profile display, logout, assistant configuration and its save behaviour, and the self-registration toggle all behave identically to before
- [ ] **SC-005**: the full regression for the touched areas passes with **no test disabled, skipped, or weakened** — skip counts match T001
- [ ] **SC-006**: the Backups slot is occupied and adding a body touches no other area
- [ ] Platform parity table complete — no ❌ gaps remain
- [ ] Every test task used the TDD checkpoint format, with Verify RED confirmed **before** implementation
- [ ] `pnpm nx typecheck mcm-app` — 0 errors
- [ ] `pnpm nx lint mcm-app` and `pnpm nx lint design-system` — no errors
- [ ] `pnpm nx test mcm-app` and `pnpm nx test design-system` — pass, ≥70% line coverage on new code
- [ ] `pnpm nx test movie-assistant` — pass with zero changed files under `agents/` (T027)
- [ ] `pnpm nx affected -t typecheck,lint,test` — catches a tier not thought of
- [ ] Web E2E gate tier passes (see [quickstart.md](./quickstart.md) §3)
- [ ] `pnpm nx e2e:mobile mcm-app` passes — or it is stated explicitly that it ran in CI, and why not locally
- [ ] The leftover-reference sweep (task T028) returns **zero** hits
- [ ] `rtk gain` — >80% token compression confirmed (run last; it measures the runs above)
