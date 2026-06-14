---
description: "Task list for feature 015 — Apply MCM Cinema Design System"
---

# Tasks: Apply MCM Cinema Design System

**Input**: Design documents from `specs/015-apply-design-system/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/ui-contracts.md](contracts/ui-contracts.md)

## Testing approach (read first)

This is a **UI-only re-skin**. Behaviour does not change, so the **existing web (Playwright) and
mobile (Maestro) E2E suites are the primary regression gate** — they must stay **green** through
every re-skin task (FR-018 / SC-002). A re-skin task is therefore a *refactor guarded by an already-green
test*, not a new RED→GREEN cycle.

Genuine RED→GREEN TDD applies to the **new** surface area:

- the `use-theme` hook + theme-toggle persistence (US4) — new behaviour,
- the **hardened** design-system component unit tests (FR-021) — the components ship without tests today.

Each test task below carries a **Verify RED** (must fail first) and its paired implementation a
**Verify GREEN**, per the constitution's TDD checkpoint format
([docs/templates/feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md)).
Visual identity is verified by **manual review/screenshots** at each story checkpoint (no
pixel-snapshot infra — clarified). **Stable `testID`s are a contract** —
[contracts/ui-contracts.md](contracts/ui-contracts.md) Contract 1 is the checklist; never rename one.

**Selector-preservation guard (run after any re-skin task):**
```bash
rg -o "testID=[\"']([a-z0-9-]+)[\"']" frontend/mcm-app/src | sort -u > /tmp/sel-after.txt
# diff against the baseline captured in T010 — zero REMOVED lines allowed
```

---

## Phase 1: Setup — workspace + dependency wiring (Shared Infrastructure)

**Purpose**: Bring the design-system package into the monorepo and install the UI stack. No screen changes yet.

- [ ] T001 Add `- 'packages/*'` to [pnpm-workspace.yaml](../../pnpm-workspace.yaml) so `@mcm/design-system` resolves as a workspace package.
- [ ] T002 Add UI deps to [frontend/mcm-app/package.json](../../frontend/mcm-app/package.json) (`@mcm/design-system": "workspace:*"`, `tamagui`, `@tamagui/core`, `@tamagui/config`, `expo-font`, `@expo-google-fonts/outfit`, `@expo-google-fonts/inter`, `react-native-svg`, `@react-native-async-storage/async-storage`) via `npx expo install`; then `pnpm install` from repo root. (depends on T001)
- [ ] T003 [P] Create [frontend/mcm-app/tamagui.config.ts](../../frontend/mcm-app/tamagui.config.ts) that re-exports `@mcm/design-system/tamagui.config` (default export). Do NOT add the Tamagui babel/metro plugins — runtime-only (research R1).
- [ ] T004 [P] Add `packages/design-system/project.json` with Nx `lint` (ESLint) + `test` (Jest/jest-expo) targets, a `jest.config.js`, and a `tsconfig.json`; verify `pnpm nx lint design-system` and `pnpm nx test design-system` are discoverable (may report "no tests" until T009).

**Checkpoint**: `pnpm install` succeeds; `import config from './tamagui.config'` resolves in mcm-app; Nx sees the `design-system` project.

---

## Phase 2: Foundational — theming + provider + DS harness + constitution (BLOCKING)

**Purpose**: Everything every screen depends on — the provider, dark default, theme state, the DS test harness, the selector baseline, and the governance amendment.

**⚠️ CRITICAL**: No user-story re-skin can begin until this phase is complete.

- [ ] T005 **Constitution amendment** — run `/speckit-constitution` (human-approved) to add **Tamagui + `@mcm/design-system`** to *Frontend App Technology Stack Requirements* and a **Design System principle** under *Frontend UI & UX* (new UI composes DS components/tokens; dark-first; restrained orange; 48dp targets). MINOR bump. **Done when**: `.specify/memory/constitution.md` version history shows the new entry and both additions are present. (plan.md §Constitution Check)
- [ ] T006 [P] Write `use-theme` hook unit test in [frontend/mcm-app/src/hooks/use-theme.test.tsx](../../frontend/mcm-app/src/hooks/use-theme.test.tsx): defaults to `'dark'` with no stored value; reads `mcm.theme` from AsyncStorage on mount; `toggle()` flips + persists; unknown/error value → `'dark'`. (data-model.md; Contract 2)
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern use-theme` → fails (`Cannot find module './use-theme'`).
- [ ] T007 [P] Implement `use-theme` hook in [frontend/mcm-app/src/hooks/use-theme.tsx](../../frontend/mcm-app/src/hooks/use-theme.tsx) — `AsyncStorage` key `mcm.theme` (annotate as a persisted external key), dark default, `theme`/`toggle`/`setTheme`, defensive fallback. (depends on T006)
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern use-theme` → passes.
- [ ] T008 Wire providers in [frontend/mcm-app/src/app/_layout.tsx](../../frontend/mcm-app/src/app/_layout.tsx): keep `@/assistant-polyfills` first; gate render on `useFonts({Outfit 400/500/700, Inter 400/500})`; wrap with `<TamaguiProvider config defaultTheme={theme}>` (driven by `use-theme`) as the outermost wrapper around the existing `SafeAreaProvider/AuthProvider/UiStateProvider/AssistantDataSyncProvider/Stack`. No flash-of-wrong-theme (dark initial render). (depends on T003, T007; research R1/R2)
- [ ] T009 [P] Seed the DS Jest harness with one smoke render test (e.g. `packages/design-system/components/primitives/Button.test.tsx` mounting `<Button>` inside a `TamaguiProvider`) so `pnpm nx test design-system` runs green and the transform/preset config is proven. (depends on T004)
- [ ] T010 [P] Capture the **stable-selector baseline**: run the regen command (Testing approach above) and commit `specs/015-apply-design-system/contracts/selectors-baseline.txt`; this is the diff target the per-surface guard checks against. **Done when**: the file lists every current `testID` (excludes `*/unit-tests/*`).

**Checkpoint**: App boots in **dark** on web + Android; fonts load; `pnpm nx test design-system` green; selector baseline committed; constitution amended.

---

## Phase 3: User Story 1 — Cinematic browse foundation (Priority: P1) 🎯 MVP

**Goal**: Home (collections) + collection movie list + app chrome render in the new dark cinematic identity on web + Android, behaviour unchanged.

**Independent Test**: Log in → home shows DS collection cards; open a collection → web shows the DS data table (count + orange "Add movie", Outfit headers w/ primary bottom-border, hover rows, mismatch badge), Android shows the DS card list; sort/filter/column-visibility/open still work.

### DS component hardening for US1 (FR-021 — RED→GREEN)

- [ ] T011 [P] [US1] Harden `CollectionCard` + add unit test in [packages/design-system/components/domain/CollectionCard.tsx](../../packages/design-system/components/domain/CollectionCard.tsx) (+ `.test.tsx`): forwards `testID`/`accessibilityLabel`/state to its pressable; role chip + default badge; states (resting/hover/press).
  - **Verify RED**: `pnpm nx test design-system -- --testPathPattern CollectionCard` → fails (no test/forwarding).
  - **Verify GREEN** (after impl): same command passes.
- [ ] T012 [P] [US1] Harden `MovieCard` (poster + compact) + `FormatBadge` + `StarRating` and add unit tests in [packages/design-system/components/domain/MovieCard.tsx](../../packages/design-system/components/domain/MovieCard.tsx): `FormatBadge highlight` renders orange only on media≠quality; `testID` forwarding; 48dp targets.
  - **Verify RED**: `pnpm nx test design-system -- --testPathPattern MovieCard` → fails.
  - **Verify GREEN**: passes.
- [ ] T013 [P] [US1] Harden `AppBar` + `IconButton` + `NavigationBar` + unit tests in [packages/design-system/components/navigation/](../../packages/design-system/components/navigation/): label/role forwarding, active state, scroll-collapse no-throw.
  - **Verify RED**: `pnpm nx test design-system -- --testPathPattern "AppBar|NavigationBar|IconButton"` → fails.
  - **Verify GREEN**: passes.

### Re-skin US1 surfaces (refactor — existing E2E is the gate)

- [ ] T014 [US1] Re-skin app chrome: render DS `AppBar` (web top app bar / native AppBar) + host the profile avatar + theme-toggle slot in [frontend/mcm-app/src/app/(app)/_layout.tsx](../../frontend/mcm-app/src/app/(app)/_layout.tsx) and [navigation-bar.tsx](../../frontend/mcm-app/src/components/navigation-bar.tsx); preserve `navigation-bar` testID. (depends on T013)
- [ ] T015 [P] [US1] Re-skin [collection-card.tsx](../../frontend/mcm-app/src/components/collection-card.tsx) to render DS `CollectionCard`, forwarding all `collection-card*` testIDs unchanged. (depends on T011)
- [ ] T016 [P] [US1] Re-skin home grid shell [screens/home/home-screen.tsx](../../frontend/mcm-app/src/screens/home/home-screen.tsx) + [collection-list.tsx](../../frontend/mcm-app/src/components/collection-list.tsx) + [collection-list.native.tsx](../../frontend/mcm-app/src/components/collection-list.native.tsx) to DS surfaces (grid web/tablet, list phone); preserve `home-*`/`collection-list*` testIDs.
- [ ] T017 [US1] Create web data-table variant [movie-list.web.tsx](../../frontend/mcm-app/src/components/movie-list.web.tsx): DS table surface — toolbar count (`movie-count-line`) + orange "Add movie", Outfit uppercase headers w/ 2dp primary bottom-border, hover rows, honours column visibility; identical props + all `movie-list*` testIDs. (depends on T012; research R7)
- [ ] T018 [US1] Create native list variant [movie-list.native.tsx](../../frontend/mcm-app/src/components/movie-list.native.tsx) (+ keep default [movie-list.tsx](../../frontend/mcm-app/src/components/movie-list.tsx) = web): DS `MovieCard` compact rows; identical props + testIDs. (depends on T012)
- [ ] T019 [P] [US1] Re-skin [movie-list-item.tsx](../../frontend/mcm-app/src/components/movie-list-item.tsx) row + mismatch FormatBadge (media≠quality → orange); preserve all `movie-list-item-*` testIDs. (depends on T012; FR-010/SC-007)
- [ ] T020 [US1] Re-skin collection screen shell [screens/collections/collection-screen.tsx](../../frontend/mcm-app/src/screens/collections/collection-screen.tsx) (name header + orange "Add movie" CTA); preserve `collection-screen-name`/`collection-screen-add-movie`.
- [ ] T021 [US1] Run selector guard for all US1 surfaces (zero removed testIDs) and the US1 E2E regression — **Verify GREEN**: `pnpm nx e2e mcm-app -- tests/e2e/web/collections.spec.ts tests/e2e/web/movies.spec.ts` passes unchanged; manual visual review of home + collection on web + Android (dark default, fonts, orange budget ≤3–4/screen).

**Checkpoint**: Browse foundation is live and cinematic on both platforms; all browse/sort/filter E2E green.

---

## Phase 4: User Story 2 — Forms, inputs, and controls (Priority: P2)

**Goal**: All forms/inputs/controls/dialogs use DS components; validation + submit behaviour unchanged.

**Independent Test**: create-collection, add/edit-movie, login, register flows show DS text fields (floating label, supporting/error), buttons, search/chips/switches, and DS dialogs — with identical validation outcomes.

### DS hardening for US2 (RED→GREEN)

- [ ] T022 [P] [US2] Harden `TextField` (filled/outlined, floating label, supporting/error/maxCount) + `Button` (5 variants, loading) + unit tests in [packages/design-system/components/inputs/](../../packages/design-system/components/inputs/) & [primitives/](../../packages/design-system/components/primitives/): error state, label forwarding, `testID` forwarding.
  - **Verify RED**: `pnpm nx test design-system -- --testPathPattern "TextField|Button"` → fails. **GREEN** after impl.
- [ ] T023 [P] [US2] Harden `SearchBar` + `Chip`/`ChipGroup` + `Switch` + `Dialog` + `Snackbar` + unit tests in [inputs/](../../packages/design-system/components/inputs/) & [surfaces/](../../packages/design-system/components/surfaces/): selected/clear/remove callbacks, dialog scrim + action passthrough, `testID` forwarding.
  - **Verify RED**: `pnpm nx test design-system -- --testPathPattern "SearchBar|Chip|Switch|Dialog|Snackbar"` → fails. **GREEN** after impl.

### Re-skin US2 surfaces (refactor — existing E2E is the gate)

- [ ] T024 [US2] Re-skin [movie-form.tsx](../../frontend/mcm-app/src/components/movie-form.tsx) to DS `TextField`/`Switch`/`Chip`/`Button`; keep content-type/media/quality/rated as the existing radio controls (Picker Fabric-crash history); preserve every `movie-form-*` testID. (depends on T022, T023)
- [ ] T025 [P] [US2] Re-skin [collection-form.tsx](../../frontend/mcm-app/src/components/collection-form.tsx) to DS `TextField`/`Button`; preserve `collection-form-*` testIDs. (depends on T022)
- [ ] T026 [P] [US2] Re-skin [register-form.tsx](../../frontend/mcm-app/src/components/register-form.tsx) + [password-strength-indicator.tsx](../../frontend/mcm-app/src/components/password-strength-indicator.tsx); keep password-manager autofill enabled on register (NOT `NoAutoFillInput`); preserve `input-*`/`btn-create-account`/`register-form-error` testIDs. (depends on T022)
- [ ] T027 [P] [US2] Re-skin login/profile/email-verification screens [screens/auth/](../../frontend/mcm-app/src/screens/auth/) + [profile-display.tsx](../../frontend/mcm-app/src/components/profile-display.tsx) to DS `Card`/`Button`/`Badge`; preserve `login-*`/`btn-login-with-keycloak`/`profile-*`/`btn-logout`/`email-verification*` testIDs. (depends on T022)
- [ ] T028 [P] [US2] Re-skin [movie-search-bar.tsx](../../frontend/mcm-app/src/components/movie-search-bar.tsx) → DS `SearchBar`; [movie-filter-panel.tsx](../../frontend/mcm-app/src/components/movie-filter-panel.tsx) → DS `Chip`/`Switch`; [movie-sort-control.tsx](../../frontend/mcm-app/src/components/movie-sort-control.tsx) → DS sort chips + dir `IconButton`; [column-selector.tsx](../../frontend/mcm-app/src/components/column-selector.tsx) → DS `Switch` grid (web-only). Preserve `movie-search-*`/`movie-filter-panel`/`filter-clear-button`/`movie-sort-control`/`sort-dir-toggle`. (depends on T023)
- [ ] T029 [P] [US2] Re-skin [delete-confirmation-dialog.tsx](../../frontend/mcm-app/src/components/delete-confirmation-dialog.tsx) + [logout-confirmation-dialog.tsx](../../frontend/mcm-app/src/components/logout-confirmation-dialog.tsx) → DS `Dialog` + `Button`; preserve `delete-dialog*`/`logout-dialog`/`btn-logout-*` testIDs. (depends on T023)
- [ ] T030 [P] [US2] Re-skin [movie-detail.tsx](../../frontend/mcm-app/src/components/movie-detail.tsx) → DS `Card`/`Chip`/`FormatBadge`/`Button`; keep external-id `openUrl` behaviour; preserve all `movie-detail-*` testIDs. (depends on T012, T022)
- [ ] T031 [US2] Run selector guard for US2 surfaces + US2 E2E regression — **Verify GREEN**: `pnpm nx e2e mcm-app -- tests/e2e/web/auth.spec.ts tests/e2e/web/movies.spec.ts tests/e2e/web/collections.spec.ts` passes unchanged; manual visual review of each form on web + Android.

**Checkpoint**: Forms/inputs/dialogs cinematic on both platforms; auth + CRUD E2E green.

---

## Phase 5: User Story 3 — Grumpy Robot assistant (Priority: P3)

**Goal**: Assistant dock adopts the Grumpy Robot identity + DS chat styling; agent conversation/approval behaviour unchanged.

**Independent Test**: Open the dock → Grumpy Robot avatar (thinking animation), DS chat bubbles, `ApprovalBubble` for HITL, `Snackbar` result, restyled composer; an agent run + approval still works.

### DS hardening for US3 (RED→GREEN)

- [ ] T032 [P] [US3] Harden `AssistantAvatar` (react-native-svg Grumpy Robot + thinking anim) + `ChatBubble` + `ApprovalBubble` + unit tests in [packages/design-system/components/assistant/](../../packages/design-system/components/assistant/): sender variants, thinking indicator, approve/reject callbacks, `testID` forwarding.
  - **Verify RED**: `pnpm nx test design-system -- --testPathPattern "AssistantAvatar|ChatBubble"` → fails. **GREEN** after impl.

### Re-skin US3 surfaces (refactor — existing agent E2E is the gate)

- [ ] T033 [US3] Re-skin [agent/assistant-dock.tsx](../../frontend/mcm-app/src/components/agent/assistant-dock.tsx) — DS panel/avatar/composer; preserve `assistant-dock*` testIDs + index-prefixed dock keys; keep CopilotKit wiring untouched. (depends on T032)
- [ ] T034 [P] [US3] Re-skin assistant rich-UI components in [agent/](../../frontend/mcm-app/src/components/agent/) (`approval-request`, `render-movie-card`, `render-collection-summary`, `import-preview`, `import-report`, `request-import-file`, `disambiguation-options`, `selection-options`) to DS bubbles/cards/chips; preserve every agent testID (Contract 1). (depends on T032)
- [ ] T035 [US3] Run selector guard for agent surfaces + agent web E2E regression — **Verify GREEN**: `pnpm nx e2e mcm-app -- tests/e2e/web/agent-search.spec.ts` (and the other `agent-*`/`assistant-*` web specs) passes unchanged. Mobile agent flows run via CI `android-e2e.yml` (Metro OOMs locally — see CLAUDE.md). Manual visual review of the dock on web + Android.

**Checkpoint**: Assistant is branded + cinematic; agent flows green (web local, mobile CI).

---

## Phase 6: User Story 4 — Dark/light theming with persistence (Priority: P4)

**Goal**: Dark default + a dark/light toggle whose choice persists device-locally across reload (web) / relaunch (mobile).

**Independent Test**: First launch = dark; toggle to light → all screens render in light; reload/relaunch → choice persists.

### New behaviour (RED→GREEN)

- [ ] T036 [P] [US4] Write web E2E [tests/e2e/web/theme.spec.ts](../../frontend/mcm-app/tests/e2e/web/theme.spec.ts): asserts dark default on load, toggles via the theme control, asserts light applied, reloads, asserts light persists (read `mcm.theme`/computed background). Opt out of inherited session only if needed.
  - **Verify RED**: `pnpm nx e2e mcm-app -- tests/e2e/web/theme.spec.ts` → fails (toggle control absent). (Contract 2; SC-003)
- [ ] T037 [US4] Implement the theme-toggle control (AppBar slot on web + profile screen on native) wired to `use-theme.toggle()`, with a stable `testID="theme-toggle"`; ensure the `TamaguiProvider` theme follows it across all screens. (depends on T008, T036)
  - **Verify GREEN**: `pnpm nx e2e mcm-app -- tests/e2e/web/theme.spec.ts` → passes.
- [ ] T038 [P] [US4] Create mobile flow [tests/e2e/mobile/theme-toggle.yaml](../../frontend/mcm-app/tests/e2e/mobile/theme-toggle.yaml): launch (dark), toggle to light via profile, relaunch (`am force-stop` + `am start`), assert light persists. Run: `maestro test tests/e2e/mobile/theme-toggle.yaml`. (depends on T037)
- [ ] T039 [US4] Verify light theme across every restyled screen (web + Android) — no unreadable/unstyled elements; contrast holds (SC-009). Manual review checklist over US1–US3 surfaces in light.

**Checkpoint**: All four stories complete; theming persists on both platforms.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T040 [P] Measure web bundle size + home-screen cold TTI before/after (research R3); confirm within the ≤2 s-on-3G budget. If over budget, open a follow-up to evaluate the Tamagui compiler plugins. **Done when**: numbers recorded in the PR description.
- [ ] T041 Rebuild the Android APK via CI (`gh workflow run android-apk.yml --ref 015-apply-design-system`) — required because `react-native-svg` + `async-storage` are native (research R4); install with `adb install -r` before any local mobile run.
- [ ] T042 [P] Orange-accent audit (FR-006 / SC-005): walk every screen on web + Android; confirm ≤3–4 orange elements, only sanctioned uses; fix any stray tertiary usage.
- [ ] T043 [P] Font-fallback check (FR-017 / SC-006): simulate font-load failure; confirm a legible system fallback with no blank/unstyled flash or layout break.
- [ ] T044 [P] Update [frontend/mcm-app/README](../../frontend/mcm-app) (and `docs/` design-system usage note) for the new theming + DS dependency; note runtime-only Tamagui.
- [ ] T045 Final full-stack E2E regression against the **dev BFF container** (rebuild image first): `pnpm nx docker-build mcm-app` → `docker compose --profile bff-dev up -d` → `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` (deterministic ~54 s baseline; SC-002). Then reset to Metro.
- [ ] T046 Run the Completion Checklist below (web + mobile suites, lint, unit, coverage, `rtk gain`).

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1/2: home grid + collection list/table restyled, browse works | collections.spec.ts, movies.spec.ts | collection-browse.yaml, movie-browse.yaml | ✅ |
| US1-AC3: native card list (no wide table) | N/A — web renders the data table; native layout differs by design (R7) | movie-browse.yaml | ✅ |
| US1-AC4: media↔quality mismatch orange badge | movies.spec.ts | movie-browse.yaml | ✅ |
| US2-AC1: add/edit movie + create collection forms restyled | movies.spec.ts, collections.spec.ts | movie-add.yaml, movie-edit.yaml, collection-create.yaml, collection-edit.yaml | ✅ |
| US2-AC2: login/register restyled | auth.spec.ts | login-keycloak.yaml, registration-full.yaml | ✅ |
| US2-AC3: search/filter/sort restyled, still filter/sort | movies.spec.ts | movie-search-filter.yaml | ✅ |
| US2 (column visibility) | movies.spec.ts | N/A — native layout has no column-visibility toggle | N/A |
| US2-AC4: delete/logout dialogs restyled | collections.spec.ts, auth.spec.ts | collection-delete.yaml, logout.yaml | ✅ |
| US3-AC1/2/3: assistant dock + bubbles + approval restyled | agent-search.spec.ts (+ other agent-*/assistant-* web specs) | run via CI android-e2e.yml — Metro OOMs locally (CLAUDE.md) | ✅ |
| US4-AC1/2/3: dark default + light toggle + persistence | [create: theme.spec.ts] (T036) | [create: theme-toggle.yaml] (T038) | ✅ (after T036/T038) |
| Foundation: provider/font/dark-default boots | covered transitively by every spec | covered transitively by every flow | ✅ |

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1: T001–T004)** → no deps; T002 depends on T001.
- **Foundational (P2: T005–T010)** → depends on Setup; **BLOCKS all user stories**. T007 depends on T006; T008 depends on T003+T007; T009 depends on T004.
- **US1 (P3)** → after Foundational. **MVP.**
- **US2 (P4)**, **US3 (P5)**, **US4 (P6)** → after Foundational; independently testable. US4's toggle UI slips into the AppBar created in T014 (US1) — if US1 isn't done, T037 adds the slot itself.
- **Polish (P7)** → after the desired stories; T041/T045 are pre-mobile/pre-final gates.

### Within each story

- DS-hardening test tasks (RED) → DS impl (GREEN) → re-skin the consuming app component → selector guard + E2E regression (GREEN).

### Parallel opportunities

- T003 ∥ T004 (Setup).
- T006/T007, T009, T010 are parallel-ish within Foundational (different files).
- DS-hardening tasks across stories (T011/T012/T013, T022/T023, T032) touch different DS files → [P].
- App re-skin tasks marked [P] touch different component files; the non-[P] ones (T014, T017, T020, T024 movie-form, and all E2E-gate tasks) serialize on shared files or the regression run.

---

## Parallel Example: User Story 1

```bash
# DS hardening (different files) in parallel:
Task: "T011 Harden CollectionCard + test"
Task: "T012 Harden MovieCard + FormatBadge + StarRating + tests"
Task: "T013 Harden AppBar + IconButton + NavigationBar + tests"

# Then app re-skin of independent components in parallel:
Task: "T015 Re-skin collection-card.tsx"
Task: "T016 Re-skin home grid + collection-list(.native)"
Task: "T019 Re-skin movie-list-item.tsx + mismatch badge"
```

---

## Implementation Strategy

### MVP first (US1)

1. Phase 1 Setup → 2. Phase 2 Foundational (provider + dark default + amendment) → 3. Phase 3 US1 → **STOP & VALIDATE** (browse cinematic on web + Android, E2E green) → demo.

### Incremental delivery

US1 (browse) → US2 (forms) → US3 (assistant) → US4 (theme toggle). Each ships with its E2E suite green and a manual visual pass; none breaks the prior.

---

## Completion Checklist

Before marking `015-apply-design-system` complete, verify the success criteria in [spec.md](spec.md):

- [ ] **SC-001**: every listed screen restyled on web + Android
- [ ] **SC-002**: existing web + mobile E2E pass unchanged (zero functional regression)
- [ ] **SC-003**: dark default; light toggle persists across reload (web) + relaunch (mobile)
- [ ] **SC-004**: interactive elements meet 48×48dp
- [ ] **SC-005**: ≤3–4 sanctioned orange elements per screen
- [ ] **SC-006**: Outfit titles / Inter body everywhere; legible fallback on font-load failure
- [ ] **SC-007**: media↔quality mismatch highlighted orange; matches stay neutral
- [ ] **SC-008**: web↔Android visual consistency for shared components
- [ ] **SC-009**: readable contrast in dark and light
- [ ] **SC-010**: hardened DS components have states + a11y + unit tests
- [ ] Constitution amended (T005) — Tamagui + design system principle present
- [ ] Stable-selector guard: zero `testID`s removed vs the T010 baseline
- [ ] Platform parity table complete — no ❌ gaps remain (theme.spec.ts + theme-toggle.yaml created)
- [ ] All new test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx lint design-system` + `pnpm nx test design-system` — DS package green
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm exec tsc --noEmit` (from frontend/mcm-app) — types clean
- [ ] `pnpm nx e2e mcm-app` — web E2E passes (and dev-container run T045)
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes (APK rebuilt T041; logged-out start between runs)
- [ ] `rtk gain` — >80% token compression confirmed (run last)
