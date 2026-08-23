# Implementation Plan: Settings destination with sub-navigation

**Branch**: `062-settings-split` | **Date**: 2026-08-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/062-settings-split/spec.md`

## Summary

Replace the single scrolling `Profile` route with a `settings` route group whose `_layout.tsx`
renders a shared sub-navigation above a nested `Stack`. Four child routes — `index` (profile),
`assistant`, `backups`, `admin` — each return a screen component, so each becomes independently
addressable and deep-linkable. Nothing is authored from scratch: the three cards on today's
`profile-screen.tsx` become three screen bodies, and the existing feature-040 admin settings route
is re-parented under the group with its `ProtectedRoute` guard intact.

Three consequences drive most of the work and are in scope, not follow-up:

1. **The Tamagui `testID` trap.** The design system's `Tabs` renders each tab as a Tamagui `View`,
   which does not forward `testID` to `data-testid` on React Native Web — the same limitation that
   forced `admin-settings-card.tsx` to wrap its `Card` in a plain RN `Pressable`. `Tabs` has no
   consumer in the app today, so this feature is its first; it gains an optional per-tab `testID`
   rendered on an RN host node, fixing the gap in the design system rather than around it.
2. **The screen-label vocabulary is owned by the BFF, not the gateway.** `ALLOWED_SCREENS` in
   `bff-server/ui-state-sanitizer.ts` is the enforcement point. Measured: the gateway reads only
   `collection` and `movie-detail` (`nodes/organizer.py`), and never reads `profile` — so the four
   new labels are additive vocabulary with no gateway behaviour change.
3. **20 E2E spec files touch the old route or its testIDs** (5 web, 15 mobile). Most only need
   their navigation step rewritten; `admin-card.spec.ts` / `admin-card.yaml` need reworking around
   the sub-navigation entry that replaces the deleted card.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24.14.1 LTS; Python 3.12 for the agent gateway's
verification tier only (no gateway source change expected)

**Primary Dependencies**: Expo SDK 56 / Expo Router (file-based routing, nested `Stack`),
React Native 0.85, React 19.2, Tamagui via `@mcm/design-system`

**Storage**: None. No new persisted state, no new BFF route, no mc-service change.

**Testing**: Jest + Expo Testing Library (frontend unit), Playwright (web E2E), Maestro (mobile
E2E), pytest (agent gateway unit). All invoked through Nx targets.

**Target Platform**: Universal — web (Expo Router server output) and Android

**Project Type**: Universal frontend app with an embedded BFF; one shared design-system package

**Performance Goals**: No regression against the existing budget — sub-navigation is a static row
of four entries and must not add a network round-trip on switch.

**Constraints**: WCAG 2.2 AA for the sub-navigation (`accessibilityRole="tab"`, visible focus,
usable when four entries do not fit one line). Stable `data-testid` on every element automation
locates. `AssistantConfigProvider` must stay above the settings group so the assistant dock gate
still refreshes in-session on save.

**Scale/Scope**: 4 routes, 3 new screen components, 1 new app component, 1 design-system
enhancement, 2 route deletions, 1 component + 1 unit test deletion, ~20 E2E spec files updated.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — see the second column.*

| Principle | Requirement | How this plan satisfies it | Post-design |
| --- | --- | --- | --- |
| Frontend Separation of Concerns — App-Layer | Routes never define screen components; every route returns a screen from the Screens-Layer | Each of the four routes is a thin file returning a screen from `src/screens/settings/` (or the existing `src/screens/admin/`). `_layout.tsx` composes navigation only. This *improves* on today's `admin/settings.tsx`, which inlines `ProtectedRoute` + the UI-state call in the route file. | PASS |
| Frontend Separation of Concerns — Components-Layer | One named export; kebab-case filename; styles at file bottom | `components/settings/settings-nav.tsx` exports `SettingsNav` only | PASS |
| Design System | All UI composed from `@mcm/design-system`; new components extend it, never bypass it | The sub-navigation composes the design system's `Tabs`. The `testID` gap is closed **inside** `Tabs`, not routed around it in app code — a bypass would have been an ad-hoc `StyleSheet` tab row. | PASS **(re-audited post-implementation — this row was initially optimistic; see below)** |
| Behavior-Descriptive Identifiers | No `FR-###`/`US#` in identifiers; requirement IDs live in a JSDoc comment | Every new symbol is named for behaviour (`SettingsNav`, `AssistantSettingsScreen`). Requirement provenance goes in the file JSDoc. | PASS |
| Behavior-Descriptive Identifiers — exemption | Stable E2E selectors are an exempt external contract, annotated with a justifying comment | The testID renames in [contracts/ui-contract.md](./contracts/ui-contract.md) carry that annotation | PASS |
| Accessibility First | WCAG 2.2 AA; ARIA labels on non-text elements; visible focus | Sub-navigation entries are text labels with `accessibilityRole="tab"` and `accessibilityState={{selected}}`; the design system already applies both | PASS |
| Responsive & Adaptive Design | Mobile-first, adapts across breakpoints | `Tabs` supports `scrollable` for narrow viewports — used, since four entries plus an admin entry will not fit a phone width comfortably | PASS |
| Centralized Access Control / Deny By Default | Role checks are a layer, not a per-handler `if` | The admin route keeps `ProtectedRoute requiredRole="mc-admin"`, which delegates to `AuthGuard`. Hiding the sub-navigation entry is presentation only and is explicitly *not* the enforcement (`openwiki/gotchas/role-enforcement-is-a-layer.md`). Both are tested separately. | PASS |
| Input Validation / Agent Security | Allowlist-based, server-side, at the single sanitization point | New screen labels are added to `ALLOWED_SCREENS` in the BFF sanitizer — the sole sanitization point — and anything unrecognised still collapses to `unknown` | PASS |
| Test-Driven Development (NON-NEGOTIABLE) | Test → user approval → RED → implement → GREEN; every task carries Verify RED / Verify GREEN | `tasks.md` will follow `docs/templates/feature-test-tasks-template.md`. Note the measured trap: `node --test <file> --test-name-pattern` silently runs everything — node flags go **before** the path. | Deferred to `/speckit-tasks` |
| Test Type Integrity | A test's classification matches what it exercises | Sub-navigation rendering and role-gating are unit tests; route addressability and refusal are E2E. No E2E assertion is demoted to a unit test to avoid updating a spec. | PASS |
| Platform Parity Table | Every scenario listed with web + mobile status; any N/A justified in writing | Required in `tasks.md`. Deep-link-by-URL has no direct Maestro equivalent — that justification is pre-drafted in [quickstart.md](./quickstart.md). | Deferred to `/speckit-tasks` |
| Stable Selectors | `data-testid` or ARIA roles, never CSS classes | Full testID inventory in [contracts/ui-contract.md](./contracts/ui-contract.md) | PASS |
| Nx as universal task runner | All test/lint/build through Nx targets | Verification commands in `quickstart.md` are all `pnpm nx …` | PASS |
| Run the tiers your diff touches | Derive checks from the diff, not from memory | The diff touches `mcm-app` (unit + web E2E + mobile E2E) and `design-system` (unit). It touches the gateway's *contract* but not its source — the Python unit tier still runs, as a check that the claim holds. | PASS |
| Code Coverage ≥ 70% for new features | Measured via coverage tooling | Three new screens and one new component all get unit tests | PASS |

**No violations. The Complexity Tracking table is therefore omitted.**

### Post-implementation design-system re-audit (2026-08-23)

The Design System row above was marked PASS at planning time and was optimistic. A re-audit after
implementation found four deviations, all in `backups-settings-screen.tsx` — the only screen
authored from scratch rather than moved — plus one defaulted decision. All are fixed:

| Finding | Resolution |
| --- | --- |
| `<Card onPress={undefined}>` — copied from `admin-settings-card.tsx`, where it suppressed `Card`'s press handling under a wrapping `Pressable`. No `Pressable` here, and `onPress` is already optional. | Removed |
| Body copy sat loose in the screen `View` with a hand-rolled `marginTop={12}`, bypassing `CardContent` — which the design system exports for exactly this | Moved into `CardContent` |
| `marginTop={12}` is off the base-8 grid the constitution's Consistency rule requires | Gone with the above |
| The `CardHeader` subtitle and the body copy both said "not yet available" | Deduplicated |
| `Tabs` `type` was left to default (`primary`). Primary tabs are the row directly beneath the app bar; this is sub-navigation WITHIN one destination, one level below the app bar `NavigationBar` already owns. | Switched to `type="secondary"` |

**The `secondary` switch exposed a third latent defect in `Tabs`**, alongside the `testID` and
`flex-basis` ones already recorded — `Tabs` had no consumer before this feature, so neither the
`scrollable` nor the `secondary` path had ever been rendered. Secondary drew a 32dp pill in
`theme.primary` at `zIndex: 1` — **in front of** the label — and coloured the active label
`theme.primary` too, so the active tab's text was invisible inside its own indicator. The pill was
also fixed at 64dp, sized for the icon it borrowed the geometry from, while a text tab
("Movie Assistant") measures 154dp.

Fixed inside `Tabs` against this package's OWN precedent rather than by inventing a treatment:
`NavigationBar` already documents a "64x32dp pill behind the active icon" using
`secondaryContainer` / `onSecondaryContainer` with the content carrying `zIndex`. `Tabs` secondary
now matches — pill behind (`zIndex: 0`), content above, `secondaryContainer` fill, active label
`onSecondaryContainer`, and the pill hugs the tab instead of a fixed 64dp.

**Measured in Chromium at 390×844 after the fix**, rather than reasoned about: pill
`rgb(61,71,89)` = `secondaryContainer`, `zIndex 0`, 90×32 hugging the 90dp active tab; active label
`rgb(215,227,248)` = `onSecondaryContainer` at weight 700; inactive label `rgb(197,198,207)` =
`onSurfaceVariant` at weight 500. **Contrast 7.23:1 (dark) and 13.27:1 (light)** — AA everywhere,
AAA in dark. A regression guard for the two colours converging again lives in
`navigation.test.tsx` and was proved able to fail.

**One repo-wide deviation is NOT fixed here and is filed instead as item #238**: the app uses zero
design-system spacing tokens — 222 hard-coded spacing values across 41 files, including
`admin-settings-screen.tsx` (`padding: 24, gap: 16`) and `login-screen.tsx` (`padding: 32`). This
feature's code matches the house style, so it neither introduced nor worsened the gap. The item
also records that the constitution says "base-8" while `tokens/spacing.ts` says 4dp — a
contradiction that must be settled before any migration.

## Project Structure

### Documentation (this feature)

```text
specs/062-settings-split/
├── plan.md                    # This file
├── spec.md                    # Feature specification
├── research.md                # Phase 0 — decisions and rejected alternatives
├── data-model.md              # Phase 1 — settings-area registry, screen-label vocabulary
├── quickstart.md              # Phase 1 — how to verify this feature end to end
├── contracts/
│   └── ui-contract.md         # Phase 1 — routes, testIDs, screen labels, visibility rules
├── checklists/
│   └── requirements.md        # Spec quality checklist
└── tasks.md                   # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
frontend/mcm-app/
├── src/
│   ├── app/(app)/
│   │   ├── _layout.tsx                       # UNCHANGED — AssistantConfigProvider stays here
│   │   ├── profile.tsx                       # DELETED
│   │   ├── admin/settings.tsx                # DELETED (directory removed)
│   │   └── settings/
│   │       ├── _layout.tsx                   # NEW — SettingsNav above a nested Stack
│   │       ├── index.tsx                     # NEW — returns ProfileSettingsScreen
│   │       ├── assistant.tsx                 # NEW — returns AssistantSettingsScreen
│   │       ├── backups.tsx                   # NEW — returns BackupsSettingsScreen
│   │       └── admin.tsx                     # NEW — ProtectedRoute + AdminSettingsScreen
│   ├── components/
│   │   ├── admin-settings-card.tsx           # DELETED
│   │   ├── navigation-bar.tsx                # EDIT — Profile → Settings, nav-profile → nav-settings
│   │   ├── navigation-bar.test.tsx           # EDIT
│   │   ├── settings/
│   │   │   ├── settings-nav.tsx              # NEW — sub-navigation, composes DS Tabs
│   │   │   └── settings-nav.test.tsx         # NEW
│   │   └── unit-tests/admin-settings-card.test.tsx   # DELETED
│   ├── screens/
│   │   ├── auth/profile-screen.tsx           # DELETED — split into the three below
│   │   ├── admin/admin-settings-screen.tsx   # UNCHANGED
│   │   └── settings/
│   │       ├── profile-settings-screen.tsx   # NEW — ProfileDisplay + logout
│   │       ├── assistant-settings-screen.tsx # NEW — hosts MovieAssistantConfig
│   │       └── backups-settings-screen.tsx   # NEW — placeholder
│   ├── hooks/use-ui-state.tsx                # EDIT — widen the current_screen union
│   └── bff-server/ui-state-sanitizer.ts      # EDIT — ALLOWED_SCREENS gains the four labels
└── tests/
    ├── e2e/web/*.spec.ts                     # EDIT — 5 files
    └── e2e/mobile/*.yaml                     # EDIT — 15 files

packages/design-system/components/navigation/
├── Tabs.tsx                                  # EDIT — optional per-tab testID on an RN host node
└── navigation.test.tsx                       # EDIT — covers the new testID

agents/movie-assistant/                       # NO SOURCE CHANGE EXPECTED — verified, not assumed
```

**Structure Decision**: The universal-frontend structure already in use. Every path above is
mandated by the constitution's Frontend App directory rules — App-Layer under `src/app/`,
Components-Layer under `src/components/`, Screens-Layer under `src/screens/`, web E2E under
`tests/e2e/web/`, mobile E2E under `tests/e2e/mobile/`. The one cross-project edit is
`packages/design-system`, which is the sanctioned way to extend the shared UI library.

## Phase 0 — Research

See [research.md](./research.md). Seven decisions, each with the alternative that was rejected and
why. The two operator decisions (old-address removal, four distinct screen labels) are recorded
there against their measured context.

## Phase 1 — Design & Contracts

- [data-model.md](./data-model.md) — the settings-area registry and the screen-label vocabulary as
  data, so adding the Backups body in item #236 is a one-row change.
- [contracts/ui-contract.md](./contracts/ui-contract.md) — the addressable surface: routes, every
  testID before and after, screen labels, and the visibility-versus-enforcement split.
- [quickstart.md](./quickstart.md) — the exact Nx commands that verify this feature, including
  which flags turn a silent skip into a failure.

## Phase 2 — Tasks

Not produced by this command. Run `/speckit-tasks`.

## Risks

| Risk | Mitigation |
| --- | --- |
| Renaming `profile-screen` breaks E2E files not caught by grep (a computed selector, a comment-only match) | The contract lists every occurrence found by search; the E2E update task greps again *after* the rename and asserts zero remaining hits before declaring GREEN |
| The design-system `Tabs` change regresses its own snapshot/unit test | `Tabs` has no app consumer today; its unit test is updated in the same task, and the change is additive (an optional prop) |
| A mobile E2E spec navigates via visible text `"Profile"` rather than a testID | Handled by the same post-rename grep — search covers both the label and the testIDs |
| `nx affected` misses the gateway because no Python file changed | The gateway unit tier is run explicitly, not left to `affected`, precisely to prove the "no gateway change needed" claim rather than assume it |
| A settings sub-page renders before `AssistantConfigProvider` resolves, flashing an empty assistant form | Unchanged behaviour — the provider stays where it is and the config screen already handles its own loading state (`assistant-config-loading`) |
