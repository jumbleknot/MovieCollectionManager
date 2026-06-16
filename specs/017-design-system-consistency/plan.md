# Implementation Plan: Design-System Consistency Remediation

**Branch**: `017-design-system-consistency` | **Date**: 2026-06-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/017-design-system-consistency/spec.md`

## Summary

Bring `mcm-app` to full, intentional compliance with `@mcm/design-system`: every colour resolves from a theme role, every font size is an MD3 scale step in Outfit/Inter, and every action is a design-system component — preserving the catalogued deviations that are deliberate. The design system gains a new semantic **`success`** colour role (light + dark, AA-contrast, with container variants) so positive/verified states stop using off-palette green literals.

Technical approach: drive the work from a **static design-system-compliance scan** (a Jest test that fails RED on every hardcoded hex, off-scale font, and bespoke-button import, and goes GREEN as the app is migrated) plus the existing DS unit suite, the Playwright a11y/contrast/responsive/font-fallback audits, the 194-testID selector baseline, and the dev-container web-E2E regression. No behaviour, routing, data, or copy changes.

## Technical Context

**Language/Version**: TypeScript 6.0; React 19.2 / React Native 0.85 / Expo SDK 56; Tamagui **v2.3.0** (post-016).

**Primary Dependencies**: `@mcm/design-system` (Tamagui MD3 components + tokens + Outfit/Inter fonts); `@axe-core/playwright` (contrast audit); Jest + @testing-library/react-native; Playwright (web E2E).

**Storage**: N/A (presentation-only; no data/contract changes).

**Testing**: Jest — DS unit suite, app unit suite, and a new static **DS-compliance scan**; Playwright — web E2E + the `a11y`/`responsive`/`font-fallback`/`perf` audit specs (dev-container target). Maestro mobile is **not** a gate for this feature (mobile-CI provisioning tracked separately, issue #16).

**Target Platform**: Web (React Native Web) + Android, from one universal codebase.

**Project Type**: Universal frontend app (`frontend/mcm-app`) + shared design-system package (`packages/design-system`).

**Performance Goals**: No TTI/bundle regression. The ≤2 s-on-3G budget (currently exceeded by the RN-Web+Tamagui bundle) is a **separate** code-splitting follow-up, out of scope here.

**Constraints**: UI-only (FR-016). The Metro web bundler OOMs with Tamagui on this machine → **web E2E runs only via the dev-container** (rebuild the image after every app-source change). Every existing `testID` preserved (194-selector baseline). Zero hardcoded colour literals (SC-001). MD3 type scale only (SC-002). New `success` colour AA in both themes (SC-004/SC-005).

**Scale/Scope**: 1 design-system package + ~30 app components/screens. From the 015 audit: ~5 surfaces with live colour theme-escapes, ~12 dead shadowed literals, ~8 off-scale font sites, ~6 missing-fontFamily sites, ~15 bespoke-button sites (incl. a pill style duplicated 3× in the agent layer).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle (constitution) | Status | Notes |
|---|---|---|
| **Design System** (Frontend UI & UX) — all UI composed from the DS, no ad-hoc StyleSheet/hardcoded colours/fonts | ✅ **Enforces** | This feature *is* the remediation that brings the app into compliance with this principle. |
| **Accessibility First** — WCAG 2.2 AA, ARIA labels, visible focus | ✅ | New `success` token is AA-validated; the Playwright a11y/contrast audits (dark+light) gate it; existing aria/focus coverage retained. |
| **Consistency & Feedback** — consistent spacing (base-8) + colour palette | ✅ | The whole point: one token set, one type scale, one control per semantic action. |
| **TDD (NON-NEGOTIABLE)** — RED → implement → GREEN; TDD checkpoint format; Platform Parity Table | ✅ | Driven by the static DS-compliance scan (verifiable RED) + DS unit token test + Playwright audits. tasks.md will carry the checkpoint format + Platform Parity Table. |
| **Behavior-Descriptive Identifiers** — no FR-### in identifiers | ✅ | `success`/`onSuccess`/`successContainer` are behaviour-descriptive; requirement IDs stay in comments. |
| **Frontend Separation of Concerns** — Components/Screens layers, style objects at file bottom | ✅ | Edits stay within existing layers; style objects remain at file bottom. |
| **No Domain Logic in Frontend** | ✅ | Presentation-only; no BFF/service/data change. |
| **Stable Selectors** | ✅ | 194-testID baseline guard enforces zero removed selectors (FR-013/SC-006). |
| **Linting — ESLint no warnings; Coverage ≥70%** | ✅ | App + DS lint stay at zero; DS unit coverage maintained. |
| **Performance Budgeting** — ≤2 s-on-3G | ⚠️ Pre-existing, not regressed | Already exceeded by the base bundle; this feature does not worsen it. Code-splitting is a separate tracked follow-up (recorded in 015 T040). Not a new violation. |

**Gate result: PASS** — no unjustified violations. Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/017-design-system-consistency/
├── plan.md              # This file
├── research.md          # Phase 0 — success-token tones, migration approach, test strategy
├── data-model.md        # Phase 1 — success role, type-scale, sanctioned-deviation catalogue
├── quickstart.md        # Phase 1 — how to run the gates (dev-container loop)
├── contracts/
│   ├── success-token.md         # the new colour role contract (names + tones + AA)
│   ├── compliance-rules.md      # the machine-checkable rules (hex/font/button)
│   └── sanctioned-deviations.md # the preserved, documented deviations
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/design-system/
├── tokens/
│   ├── palette.ts          # ADD: a green tonal ramp for success
│   └── colors.ts           # ADD: success/onSuccess(+container) in lightColors & darkColors
├── theme.ts                # ADD: success roles into lightTheme/darkTheme
├── tamagui.config.ts       # ADD: success tokens into the colorTokens map ($success)
└── components/…            # (unchanged API; consumed by the app)

frontend/mcm-app/src/
├── app/
│   ├── _layout.tsx
│   ├── (app)/_layout.tsx               # strip dead hex
│   └── (auth)/{login,register,native-auth-callback}.tsx + auth-callback.tsx  # theme the bg/tints
├── components/
│   ├── loading-indicator.tsx           # theme spinner + message
│   ├── navigation-bar.tsx              # wordmark weight 800→700
│   ├── collection-card.tsx             # title 17→16/18
│   ├── collection-list(.native).tsx    # empty-heading 20→22
│   ├── movie-list(.native).tsx, movie-list-item.tsx  # unify header label role
│   ├── collection-form.tsx             # add Inter to label/errorText
│   ├── movie-form.tsx                  # Add buttons→Button; media/quality chips→Chip; …
│   ├── movie-detail.tsx                # Edit/Delete→Button(danger); "Yes"→$success
│   ├── movie-sort-control.tsx          # dir toggle→IconButton
│   ├── movie-filter-panel.tsx          # Clear→Button
│   └── agent/{assistant-dock,approval-request,import-preview,request-import-file,
│             render-movie-card,render-collection-summary,render-import-report}.tsx
│                                        # bespoke pill buttons → DS Button (+ loading); de-dupe
├── screens/
│   ├── auth/{login-screen,register-form,email-verification-screen,profile-display}.tsx
│   │                                    # buttons→DS Button (logout=danger); success banners→$success
│   ├── home/home-screen.tsx            # strip dead hex; modal title 20→18/22
│   ├── collections/collection-screen.tsx  # strip dead hex; name 20→22 + Outfit
│   └── movies/{new-movie-screen,movie-detail-screen}.tsx  # theme bg; backText Inter
└── tests/
    ├── unit/design-system-compliance.test.ts   # NEW static scan (hex/font/button)  ← RED driver
    └── e2e/web/{a11y,…}.spec.ts                 # existing audits stay green (+ success-state checks)

packages/design-system/components/__tests__ (colocated)
└── tokens.test.ts (or theme.test.ts)           # NEW: success roles present + AA contrast both themes
```

**Structure Decision**: Two real trees — the shared **`packages/design-system`** (where the `success` role is added once) and the universal **`frontend/mcm-app`** (where every consumer is migrated). No new projects, layers, or services. The static compliance scan lives in the app's unit tests; the token/contrast assertions live colocated in the DS package.

## Complexity Tracking

> No Constitution Check violations — section intentionally empty.
