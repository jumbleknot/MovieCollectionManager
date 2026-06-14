# Implementation Plan: Apply MCM Cinema Design System

**Branch**: `015-apply-design-system` | **Date**: 2026-06-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/015-apply-design-system/spec.md`

## Summary

Re-skin every existing screen and component of `frontend/mcm-app` (web + Android) onto the
pre-built **MCM Cinema** design system in `packages/design-system/` (Tamagui + Material Design 3,
dark-first, Outfit/Inter type, Cinematic-Blue primary, restrained orange accent). The change is
**presentation-only**: behaviour, navigation, validation, data, and BFF/backend contracts are
untouched. Three integration realities drive the approach: (1) the design-system package is **not
yet in the pnpm workspace** and `mcm-app` has **zero** Tamagui/font dependencies — this is a
from-scratch wiring; (2) the package itself is a draft and must be **hardened** (states, a11y,
tests, Nx project) as part of this feature; (3) the existing screens/components carry **extensive
`testID`/`accessibilityLabel` selectors that the web Playwright and mobile Maestro E2E suites
depend on — these MUST survive the re-skin unchanged**. Theme choice is persisted **device-local**
(AsyncStorage), with dark default and a dark/light toggle (no system-follow).

## Technical Context

**Language/Version**: TypeScript 5.x (strict); React 19.2 / React Native 0.85 (Hermes, JSI).

**Primary Dependencies**:
- Existing: Expo SDK 56, Expo Router (file-based + BFF API routes), Axios, react-native-safe-area-context, CopilotKit (assistant), react-native-reanimated 4 / react-native-worklets.
- **New (to wire in)**: `tamagui` (+ `@tamagui/core`, `@tamagui/config`), `@mcm/design-system` (workspace package), `expo-font`, `@expo-google-fonts/outfit`, `@expo-google-fonts/inter`, `react-native-svg` (Grumpy Robot avatar), `@react-native-async-storage/async-storage` (device-local theme preference).

**Storage**: Device-local only — `AsyncStorage` key `mcm.theme` (`'dark' | 'light'`, default `dark`). No backend/profile/Redis involvement. No new MongoDB or BFF persistence.

**Testing**: Jest + Expo Testing Library (unit, ≥70% line coverage), Playwright (web E2E), Maestro (mobile E2E) — all via Nx targets. Design-system package gets its own Jest unit project + Nx `test`/`lint` targets. Visual identity verified by manual review/screenshots at story checkpoints (no pixel-snapshot infra — clarified).

**Target Platform**: Web (React Native Web via Expo Router server output) + Android (Expo/Hermes). iOS out of scope.

**Project Type**: Universal frontend app (mcm-app) + shared UI library package (design-system) in an Nx/pnpm monorepo.

**Performance Goals**: Preserve the constitution's budget — ≤2 s time-to-interactive on simulated 3G; no regression in existing E2E wall-clock (web dev-container baseline ~54 s for the full suite). Tamagui is wired **runtime-only** (no compile-time extraction) to protect the fragile Windows Android build; bundle-size delta to be measured and kept within budget.

**Constraints**:
- **Zero behavioural change** — all existing flows pass unchanged (FR-002, SC-002).
- **Stable selectors preserved** — every `testID`/`accessibilityLabel` the current E2E suites assert on is carried over verbatim (FR-018).
- **Windows Android build fragility** — the RN 0.85 C++ build hits `CMAKE_OBJECT_PATH_MAX`; integration must not add a native module that forces a problematic rebuild beyond the already-documented recipe. Prefer Metro/JS-only wiring; APK rebuild only if a new native dep (e.g. async-storage, svg) requires it.
- **Existing Metro/Babel customizations** — segment-analytics metro shim + reanimated worklets babel plugin must keep working; Tamagui added without its babel/metro plugins to avoid disturbing them.

**Scale/Scope**: ~9 screen areas (home/collections, collection movie list, movie detail, add/edit movie, create/edit collection, login, register, profile, assistant dock) × 2 platforms; ~25 existing components in `src/components/` plus the assistant dock; ~30 design-system components to harden across primitives/inputs/surfaces/navigation/domain/assistant.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Frontend principles (constitution §Frontend App Development) evaluated:

| Principle | Status | Notes |
|---|---|---|
| **Accessibility First (WCAG 2.2 AA, ARIA, focus states)** | ✅ Aligns | DS targets 48×48dp + `accessibilityRole/Label/State`; re-skin preserves existing labels and adds DS states. FR-014/020, SC-004/009. |
| **Performance Budgeting (≤2 s TTI 3G, lazy bundles)** | ⚠️ Watch | Tamagui adds runtime weight; mitigated by runtime-only wiring + font preloading + measuring bundle delta (research R3). No new heavy images. |
| **Responsive & Adaptive (mobile-first fluid grids)** | ✅ Aligns | Tamagui media tokens (`compact/medium/expanded`) drive responsive layout; FR-016. |
| **Consistency & Feedback (base-8 spacing, clear feedback)** | ✅ Aligns | DS uses a **4dp** grid which is a superset of base-8 (every 8dp step is on it); snackbars/dialogs/loading states give feedback. Reconciliation noted in Complexity Tracking. |
| **User-Centric / Behavior-Descriptive Naming** | ✅ Aligns | Keep behavior-descriptive component names; **no `FR-###`/`US#` in identifiers** (traceability via JSDoc comment only). |
| **Frontend Separation of Concerns (6 layers)** | ✅ Aligns | Re-skin stays within App/Components/Screens/Hooks; theme logic → a `use-theme` Hook (Theming/Styling Logic belongs in a hook). No domain logic added. No BFF-Layer change. |
| **Component file conventions (kebab-case, platform extensions, default=web, styles at bottom)** | ✅ Aligns | New platform-split files use `.web`/`.native`; default file is web; identical props across platforms. |
| **Client Auth Model (BFF cookie)** | ✅ N/A-safe | No auth/token change; theme is non-sensitive device-local state (SecureStore not required/used). |
| **TDD (NON-NEGOTIABLE) + checkpoint format** | ✅ Plan complies | tasks.md will carry RED/GREEN checkpoints; behaviour covered by existing E2E (kept green), new unit tests for DS components + theme hook. |
| **Platform Parity Table** | ✅ Plan complies | tasks.md will include the parity table (web Playwright ↔ mobile Maestro) per story; visual-only scenarios justified. |
| **Stable Selectors / Seeded Fixtures / afterEach teardown / Session reuse** | ✅ Preserved | Re-skin keeps selectors; no change to fixture/teardown/globalSetup machinery. |
| **Nx-first invocation, pnpm only** | ✅ Plan complies | DS package registered as an Nx project; all test/lint/build via `pnpm nx`. |
| **Logging (no console in BFF)** | ✅ N/A | No BFF/server code touched. |

**New stack element — Tamagui (CONSTITUTION AMENDMENT REQUIRED)**: the constitution's Frontend stack
names the framework (Expo/RN), HTTP client (Axios), and test tools, but does **not** name a
styling/UI-component library or a design system. This feature establishes one (`@mcm/design-system`,
built on **Tamagui**) as the mandated standard for all frontend UI. Per the constitution's own rule
— *"Deviations from this stack require constitution amendment with documented justification"* — and
to make the design system binding on future features (not just this one), **this feature includes a
constitution amendment** that:
1. Adds **Tamagui** + the shared **`@mcm/design-system`** package to **Frontend App Technology Stack
   Requirements** (the mandated UI/styling layer; raw ad-hoc `StyleSheet` styling is superseded for
   new UI).
2. Adds a **Design System principle** under **Frontend UI & UX** — new screens/components MUST
   compose design-system components and tokens (MD3 roles, Outfit/Inter type, 48×48dp targets, the
   restrained orange-accent rule, dark-first theming) rather than hard-coding colours/spacing/fonts.

The amendment is run via `/speckit-constitution` and gated on human approval (constitution changes
require it). It is a **MINOR** version bump (additive principle + stack guidance; no existing
principle redefined). Captured as a task in `tasks.md` (US1/foundation scope) and tracked in
Complexity Tracking.

**Gate result: PASS, conditional on the constitution amendment landing** — Tamagui/design-system
adoption is brought into compliance by the amendment above rather than left as an unsanctioned
deviation. Re-checked post-design — still PASS (see end of Phase 1).

## Project Structure

### Documentation (this feature)

```text
specs/015-apply-design-system/
├── plan.md              # This file
├── research.md          # Phase 0 — integration/decision research
├── data-model.md        # Phase 1 — Theme Preference + UI state shapes
├── quickstart.md        # Phase 1 — how to run/verify the redesign
├── contracts/
│   └── ui-contracts.md   # Phase 1 — stable-selector contract, theme-persistence contract, screen→component map
├── checklists/
│   └── requirements.md   # Spec quality checklist (already created)
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root)

```text
packages/design-system/              # SHARED UI LIBRARY — hardened by this feature (FR-021)
├── package.json                     # add to pnpm workspace; add Nx project.json (test/lint targets)
├── tamagui.config.ts                # consumed by mcm-app
├── tokens/  theme/  fonts/          # tokens, light/dark themes, Outfit/Inter fonts
└── components/                       # primitives/ inputs/ surfaces/ navigation/ domain/ assistant/
                                      #   + NEW *.test.tsx unit tests, a11y/state completion

pnpm-workspace.yaml                  # CHANGE: add `- 'packages/*'`

frontend/mcm-app/
├── package.json                     # CHANGE: add tamagui, @mcm/design-system (workspace:*), expo-font,
│                                    #   @expo-google-fonts/{outfit,inter}, react-native-svg, async-storage
├── tamagui.config.ts                # NEW: re-export packages/design-system/tamagui.config
├── metro.config.js                  # KEEP segment shim; (no Tamagui metro plugin — runtime-only)
├── babel.config.js                  # KEEP worklets plugin; (no Tamagui babel plugin — runtime-only)
├── src/app/_layout.tsx              # CHANGE: TamaguiProvider + font gate + ThemeProvider wrap (outermost)
├── src/app/(app)/_layout.tsx        # minor: AppBar/theme-toggle host; dock stays in (app)
├── src/hooks/
│   ├── use-theme.tsx                # NEW: device-local theme state (AsyncStorage), dark default, toggle
│   └── …                            # existing hooks unchanged
├── src/components/                   # RE-SKIN internals to render DS components; PRESERVE testIDs
│   ├── collection-card.tsx          # → DS CollectionCard
│   ├── movie-list.tsx / .web / .native  # web = DS data table; native = DS card/row list
│   ├── movie-list-item.tsx, movie-form.tsx, collection-form.tsx,
│   ├── movie-search-bar.tsx, movie-filter-panel.tsx, movie-sort-control.tsx,
│   ├── column-selector.tsx, navigation-bar.tsx, *-confirmation-dialog.tsx,
│   ├── register-form.tsx, profile-display.tsx, password-strength-indicator.tsx, …
│   └── agent/assistant-dock.tsx     # → DS Grumpy-Robot avatar + chat bubbles + approval + composer
├── src/screens/                      # auth/ collections/ home/ movies/ — restyle layout shells
└── tests/e2e/{web,mobile}/           # UNCHANGED suites must stay green; selectors preserved
```

**Structure Decision**: Universal-app + shared-package layout. The design system stays a standalone
`packages/design-system/` library (added to the pnpm workspace and given an Nx project) so it is
reusable and independently testable; `mcm-app` consumes it via `@mcm/design-system`. Re-skinning
edits the **internals** of existing `src/components/` and `src/screens/` files (keeping their
behavior-descriptive names, public props, and test selectors) rather than relocating them, which
keeps the diff focused and the E2E suites green. Theme state lives in a new `use-theme` Hook
(constitution: Theming/Styling logic belongs in a hook). Web vs Android layout divergence (data
table vs card list) uses the constitution's platform-extension pattern (`.web.tsx` / `.native.tsx`,
default = web, identical props).

## Complexity Tracking

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Tamagui UI library (new stack element)** — sanctioned via **constitution amendment** (see Constitution Check) | The provided `packages/design-system/` is built on Tamagui; it delivers MD3 theming, cross-platform styling, and the component set the spec mandates. Rather than leave it an unsanctioned deviation, this feature amends the constitution to make Tamagui + `@mcm/design-system` the mandated frontend UI layer (MINOR bump, human-approved). | Hand-rolling MD3 with raw `StyleSheet` (current approach) would re-implement the entire design system the feature is meant to *adopt* — more code, no theming engine, inconsistent with the source-of-truth package. Leaving Tamagui undocumented in the constitution rejected because future features would have no binding standard and could drift back to ad-hoc styling. |
| **Runtime-only Tamagui (skip babel + metro plugins)** | The Windows Android build is fragile (CMAKE path wall) and Metro/Babel already carry a segment shim + worklets plugin; adding Tamagui's compiler plugins risks destabilizing a known-green build. | Full compiler extraction (the DS doc's suggested setup) gives smaller bundles but introduces build risk now; deferred as a later optimization once the re-skin is green. Measured bundle delta gates this (research R3). |
| **4dp grid vs constitution's base-8** | DS tokens use a 4dp base grid (MD3 standard). | A 4dp grid is a strict superset of base-8 — every 8dp value (8/16/24…) is expressible and used; spacing stays on an 8-aligned rhythm for layout. No conflict in practice; documented rather than forking the token scale. |

## Phase 0 — Research

See [research.md](research.md). Open questions resolved there:
- **R1** Tamagui integration mode on Expo SDK 56 / RN 0.85 (runtime-only vs compiler) and provider/font-gating order in the existing `_layout.tsx` stack.
- **R2** Device-local theme persistence on web + native via AsyncStorage; hydration without a flash-of-wrong-theme; dark default.
- **R3** Bundle-size / TTI impact of Tamagui runtime + Outfit/Inter fonts; measurement method and budget gate.
- **R4** Native-dependency check — do `react-native-svg` and `@react-native-async-storage/async-storage` require an APK rebuild (and is the last CI APK native-compatible)?
- **R5** Re-skin pattern that preserves every `testID`/`accessibilityLabel` while swapping internals to DS components (prop-passthrough strategy).
- **R6** Registering `packages/design-system` as an Nx project (test/lint targets) + adding `packages/*` to the workspace without breaking existing Nx graph.
- **R7** Web data-table component approach (DS domain table) vs native card list under the platform-extension convention.

## Phase 1 — Design & Contracts

- [data-model.md](data-model.md): the **Theme Preference** entity (values, default, storage key, lifecycle) and the small UI view-models the re-skin touches (no backend entities change).
- [contracts/ui-contracts.md](contracts/ui-contracts.md): (1) **Stable-selector contract** — the authoritative list of `testID`s/labels that MUST survive; (2) **Theme-persistence contract** — storage key, values, default, read/write timing; (3) **Screen → DS-component map** — which DS component each existing screen/component adopts, per platform.
- [quickstart.md](quickstart.md): how to install the new deps, wire the provider, run the app, and verify each user story on web + Android.
- **Constitution amendment** (`/speckit-constitution`, human-approved): add Tamagui + `@mcm/design-system` to the Frontend App Technology Stack Requirements and a Design System principle under Frontend UI & UX (see Constitution Check). MINOR bump; must land alongside the US1/foundation work so the design system is the binding standard going forward. tasks.md will carry it as an explicit task.
- Agent context: the `<!-- SPECKIT … -->` block in root `CLAUDE.md` is updated to point at this plan.

**Post-design Constitution re-check: PASS** — no new violations introduced by the design; Tamagui
remains an additive, documented stack element; selectors/auth/test machinery preserved.
