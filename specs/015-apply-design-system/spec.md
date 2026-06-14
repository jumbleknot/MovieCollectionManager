# Feature Specification: Apply MCM Cinema Design System

**Feature Branch**: `015-apply-design-system`

**Created**: 2026-06-14

**Status**: Draft

**Input**: User description: "this is a UI/UX only feature to apply a new design system to the mcm-app (web and mobile). the mock-up of the new web look can be found at `docs\MCM-Redesign-Mockup.html` and the new design system is explained in `packages\DESIGN-SYSTEM.md` and lives in `packages\design-system\`"

## Overview

This is a **UI/UX-only** redesign. It re-skins every existing screen and component of the Movie Collection Manager app (web and Android) to adopt the new **MCM Cinema** visual identity: a dark-first, cinema-inspired look with a Cinematic Blue primary colour, restrained Grumpy Robot orange accents, Outfit/Inter typography, rounded "pill" controls, elevation/depth, and a consistent set of reusable components. **No functional behaviour changes** — every flow that works today must continue to work identically; only the appearance changes.

The reference look is `docs/MCM-Redesign-Mockup.html` (web), the rules and tokens are in `packages/DESIGN-SYSTEM.md`, and the component library lives in `packages/design-system/`.

## Clarifications

### Session 2026-06-14

- Q: Where should the user's dark/light theme choice be stored? → A: Device-local only (no backend changes — the UI-only boundary holds).
- Q: Is the existing `packages/design-system/` library treated as production-ready, or can this feature also fix/complete it? → A: Harden the package too — completing/polishing the design-system components (states, accessibility, tests) is in scope for this feature, not just wiring them in.
- Q: How should the new visual identity be verified for acceptance? → A: Existing web/mobile E2E proves behaviour is unchanged; the *visual* look is verified by manual review/screenshots at story checkpoints — no new visual-regression (pixel-snapshot) infrastructure is introduced.
- Q: Should theming offer a "follow system" option, or just an explicit dark/light toggle? → A: Dark/light only (two explicit states, dark default) — no system-follow mode.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cinematic browsing experience on the primary screens (Priority: P1)

As a movie collector, when I open the app I want the home (collections) screen and a collection's movie list to present the new dark, cinematic look — consistent colours, typography, spacing, and elevated cards/tables — so the app feels like a premium home-theatre experience on both my browser and my phone.

**Why this priority**: These are the most-visited screens and the first impression of the app. Applying the design foundation (theme, fonts, colour roles, spacing, elevation) plus restyling the two core browse surfaces delivers the bulk of the visible value and establishes the shared look every other screen inherits. It is a viable standalone MVP.

**Independent Test**: Log in and view the collections grid and a collection's movie list on web and on Android. Verify the new dark theme, Outfit/Inter typography, Cinematic Blue primary, elevated surfaces, pill-shaped controls, and the web movie data table (count + orange "Add movie" toolbar, Outfit headers with a primary bottom border) render as in the mock-up — while every existing browse/sort/filter/navigate action still works.

**Acceptance Scenarios**:

1. **Given** I am logged in, **When** the home screen loads, **Then** collections render with the new visual identity (dark surface, Cinematic Blue accents, Outfit titles, Inter body, elevated collection cards) and I can still open a collection.
2. **Given** I open a collection on web, **When** the movie list renders, **Then** it appears as the new MD3 surface data table — toolbar with movie count and the orange "Add movie" action, Outfit uppercase column headers with a primary bottom border, hover row highlight — and sorting/filtering/column visibility still behave as before.
3. **Given** I open a collection on Android, **When** the movie list renders, **Then** it uses the new design-system styling in a native-appropriate layout (cards/rows, not a wide web table) while showing the same data and supporting the same interactions.
4. **Given** any movie whose media format and rip quality disagree, **When** it is displayed, **Then** the discrepancy is highlighted with the orange accent while matching values stay neutral.

---

### User Story 2 - Restyled forms, inputs, and controls (Priority: P2)

As a user creating or editing content, I want all forms and input controls — add/edit movie, create/edit collection, login, register, search bar, filter chips, sort controls, switches, and dialogs — to use the new design-system components so data entry feels consistent and polished across the whole app.

**Why this priority**: Forms and inputs are where users do the most deliberate work. After the browse foundation is in place, restyling these surfaces completes the everyday experience. It is independently testable and shippable on top of US1.

**Independent Test**: Walk through the create-collection, add-movie, edit-movie, login, and register flows on web and Android. Verify text fields (floating label, validation, supporting/error text), search bar, filter/sort chips, switches, buttons (filled/tonal/outlined/text), and confirmation dialogs match the design system — while validation rules and submit behaviour are unchanged.

**Acceptance Scenarios**:

1. **Given** I am on the add-movie or create-collection form, **When** I view and fill fields, **Then** inputs use the new MD3 text fields (floating label, supporting text, error state) and the submit/cancel actions use the new buttons, with identical validation and outcomes.
2. **Given** I am on the login or register screen, **When** it loads, **Then** it presents the new visual identity while preserving all existing fields, validation, password-manager handling, and submit behaviour.
3. **Given** I am browsing a collection, **When** I use the search bar, filter chips, and sort control, **Then** they render as the new pill/chip/search components and continue to filter and sort exactly as before.
4. **Given** I trigger a destructive action (delete movie/collection, logout), **When** the confirmation dialog appears, **Then** it uses the new dialog component with scrim, and confirm/cancel still work as before.

---

### User Story 3 - The Grumpy Robot assistant, redesigned (Priority: P3)

As a user of the conversational assistant, I want the assistant dock — avatar, chat bubbles, approval/HITL cards, snackbars, and the message composer — to adopt the Grumpy Robot identity and the new chat styling so the assistant feels like a first-class, branded part of the app.

**Why this priority**: The assistant is an additive, optional surface; it should look consistent but the app is fully usable without restyling it. Sequencing it last lets the core browse and form experiences ship first.

**Independent Test**: Open the assistant dock on web and Android and run an assistant interaction (e.g. a query and an approval flow). Verify the Grumpy Robot avatar (with thinking animation), user/assistant chat bubbles, approval cards, snackbar result line, and composer match the design system — while the agent conversation, approvals, and generative UI continue to function.

**Acceptance Scenarios**:

1. **Given** the assistant dock is open, **When** the assistant responds, **Then** messages render as the new chat bubbles with the Grumpy Robot avatar, and the typing/thinking indicator animates while the agent is processing.
2. **Given** the assistant requests human approval (HITL), **When** the approval card appears, **Then** it renders as the new approval bubble with approve/reject actions and the approval still drives the same backend behaviour.
3. **Given** an assistant action completes, **When** the result is shown, **Then** a snackbar/result line presents the outcome in the new styling without changing the underlying action.

---

### User Story 4 - Dark-first theming with a light option (Priority: P4)

As a user, I want the app to default to the cinematic dark theme and let me switch to a light theme, with my choice remembered, so I can use the app comfortably in any environment.

**Why this priority**: Dark is the default and is delivered as part of the US1 foundation; the user-facing light/dark **toggle** with a remembered preference is a smaller, separable enhancement that can ship independently after the rest of the redesign.

**Independent Test**: On first launch verify the app is in dark theme. Toggle to light, confirm all restyled screens render correctly in light, restart the app/session, and confirm the chosen theme persists.

**Acceptance Scenarios**:

1. **Given** a first-time launch, **When** the app opens, **Then** the dark (Cinema Dark) theme is active by default.
2. **Given** I switch to the light theme, **When** I navigate across screens, **Then** every screen renders correctly using the light colour roles with no unreadable or unstyled elements.
3. **Given** I have selected a theme, **When** I reload (web) or relaunch (mobile), **Then** my theme choice is preserved.

---

### Edge Cases

- **Font load failure / slow load**: if the Outfit/Inter web fonts fail or are slow to load, screens must fall back to a legible system font with no blank or unstyled flash, and no layout breakage.
- **Platform layout divergence**: the wide multi-column movie data table is a web layout; on Android the same data is presented in a native-appropriate card/row layout. Both must reflect the same design language and the same underlying data.
- **Orange-accent overuse**: the design rule limits the orange (tertiary) accent to at most 3–4 sanctioned elements per screen (rating, robot avatar, the single "Add movie" CTA, and media↔quality mismatch highlights). Screens must not introduce orange elsewhere (links, backgrounds, generic tags).
- **Small / large viewports**: the layout must remain usable from small phone widths to wide desktop widths, including the assistant dock collapsing to a full-width sheet on narrow screens.
- **Long content**: long movie/collection titles, long genre lists, and long assistant messages must wrap/truncate gracefully without breaking the new layouts.
- **Existing automated selectors**: stable test selectors (test IDs / accessibility labels) used by the current E2E suites must be preserved so behaviour tests keep passing through the re-skin.
- **Accessibility**: colour contrast in both themes and the 48×48dp minimum touch target must be honoured; focus rings/hover states must be present for pointer/keyboard use on web.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The app MUST apply the MCM Cinema design system's visual identity (colour roles, typography, spacing, shape/radius, elevation, and motion) consistently across every existing screen and component on both web and Android.
- **FR-002**: The redesign MUST be UI/UX-only — all existing functionality, navigation, validation rules, data shown, and user-flow outcomes MUST remain unchanged.
- **FR-003**: Titles (screen titles, collection names, movie titles) MUST use the Outfit typeface and body/label text MUST use the Inter typeface, per the design system type scale.
- **FR-004**: The Cinema Dark theme MUST be the default appearance on first use.
- **FR-005**: Users MUST be able to switch between exactly two explicit themes — dark and light (no "follow system" mode) — with dark as default; the selected theme MUST persist **device-locally** across reloads (web) and relaunches (mobile), with no backend/profile storage.
- **FR-006**: The Cinematic Blue primary colour MUST be used for primary actions, app bar, and active states; the orange (tertiary) accent MUST be limited to the sanctioned uses only (rating stars, the Grumpy Robot avatar, the single "Add movie" call-to-action, and attention/discrepancy highlights such as a media↔quality mismatch) and MUST NOT exceed 3–4 elements per screen.
- **FR-007**: The home (collections) screen MUST present collections using the new collection card styling and layout.
- **FR-008**: On web, a collection's movie list MUST be presented as the new MD3 data-table surface, including a toolbar showing the result count and the orange "Add movie" action, Outfit uppercase column headers separated from rows by a primary bottom border, and row hover highlighting.
- **FR-009**: On Android, a collection's movie list MUST present the same data and interactions using a native-appropriate card/row layout styled with the design system (not a wide web table).
- **FR-010**: A movie whose media format and rip quality disagree MUST be visually highlighted with the orange accent, while matching values remain neutral.
- **FR-011**: All forms (add/edit movie, create/edit collection, login, register) MUST use the new design-system input components, including floating labels, supporting text, validation/error states, and the new button variants, without altering validation logic or submit behaviour.
- **FR-012**: The search bar, filter chips, sort controls, switches, badges, and confirmation dialogs MUST be restyled to the design-system components while preserving their existing behaviour.
- **FR-013**: The movie assistant dock MUST adopt the Grumpy Robot identity, including the avatar with a thinking/processing animation, user/assistant chat bubbles, HITL approval cards, result snackbars, and the message composer, without changing the assistant's conversational or approval behaviour.
- **FR-014**: All interactive elements MUST meet **WCAG 2.2 Level AA** — including the 48×48dp minimum touch target, accessibility/ARIA labels on non-text interactive elements (the existing labels are preserved), and on web visible hover and focus states for pointer/keyboard use.
- **FR-015**: Hover, press, and focus feedback MUST use the design system's state-layer approach rather than ad-hoc opacity changes, to avoid transparency bleed.
- **FR-016**: The UI MUST remain usable and visually correct across supported viewport sizes, with the assistant dock collapsing to a full-width sheet on narrow screens.
- **FR-017**: On font-load failure or delay, screens MUST fall back to a legible system font with no blank/unstyled flash and no layout breakage.
- **FR-018**: Stable automated-test selectors (test IDs / accessibility labels) relied upon by the existing E2E suites MUST be preserved so existing behaviour tests continue to pass after the re-skin.
- **FR-019**: The design language (colour, typography, spacing, components) MUST be visually consistent between web and Android for shared components, within each platform's appropriate layout conventions.
- **FR-020**: Both themes MUST satisfy readable colour-contrast for text and interactive elements.
- **FR-021**: This feature's scope INCLUDES hardening the `packages/design-system/` library itself — completing component states, accessibility (roles/labels/touch targets), and component-level tests — so the components consumed by the app are production-ready, not just wired in.
- **FR-022**: Visual acceptance MUST be verified by manual review/screenshots at each user-story checkpoint; behavioural correctness MUST be verified by the existing web and mobile E2E suites passing unchanged. No pixel-snapshot/visual-regression infrastructure is introduced by this feature.

### Key Entities

- **Theme Preference**: the user's chosen appearance (dark or light), defaulting to dark, stored device-locally and remembered across reloads/relaunches. This is a UI preference only; it is not synced to the backend and does not affect collection or movie data.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the app's existing screens (home/collections, collection movie list, movie detail, add/edit movie, create/edit collection, login, register, profile, and the assistant dock) render with the new design-system visual identity on both web and Android.
- **SC-002**: All existing web and mobile E2E flows pass unchanged after the redesign — zero functional regressions attributable to the re-skin.
- **SC-003**: The app launches in dark theme by default; a user can switch to light (dark/light are the only two modes) and the device-local choice persists across a reload (web) and a relaunch (mobile) in 100% of attempts.
- **SC-004**: 100% of interactive elements meet WCAG 2.2 AA on the redesigned screens — the 48×48dp minimum touch target, accessibility labels on non-text controls, and visible focus on web.
- **SC-005**: On every screen, the orange (tertiary) accent appears on no more than 3–4 elements and only for sanctioned uses.
- **SC-006**: Titles render in Outfit and body/labels in Inter on every screen; when fonts fail to load, a legible fallback is shown with no blank screen and no broken layout.
- **SC-007**: For movies with a media↔quality mismatch, the discrepancy is highlighted distinctly (orange) while matching values stay neutral, in 100% of such rows.
- **SC-008**: Shared components present visually consistent colour, typography, and spacing between web and Android, within each platform's layout conventions.
- **SC-009**: Text and interactive elements meet readable colour-contrast in both dark and light themes.
- **SC-010**: The design-system components consumed by the app are production-ready — each has its interactive states, accessibility attributes (role/label/48×48dp target), and component-level tests in place.

## Assumptions

- **No backend or data-model changes**: this feature touches only the frontend presentation layer (`mcm-app`) and consumes the existing `packages/design-system/` library; mc-service, the BFF, agent layer, and data contracts are untouched.
- **The design-system package is the source of truth, and hardening it is in scope**: the components, tokens, themes, and fonts in `packages/design-system/` (described in `packages/DESIGN-SYSTEM.md`) define the design language; this feature wires them into the app **and** completes/hardens them (states, accessibility, component tests) to production quality — it does not redefine the design language (see FR-021).
- **Dark default with a light toggle is in scope**: the design system specifies dark as default and light as a first-class secondary option, and the reference mock-up includes a working theme toggle, so a user-facing dark/light toggle with a remembered preference is included (US4).
- **Platform-appropriate layouts**: the wide multi-column movie data table from the mock-up is the **web** presentation; Android keeps a native card/row layout (consistent with existing platform-parity exceptions such as web-only column visibility) re-skinned with the design system.
- **Functional parity is mandatory**: every current behaviour (auth, browse, sort/filter, column visibility, CRUD, import/export, assistant flows) must work identically; only appearance changes.
- **Existing test selectors are preserved**: re-skinning keeps the test IDs and accessibility labels the current E2E suites depend on; where a component is replaced, equivalent stable selectors are carried over.
- **The mock-up is a visual reference, not a literal spec**: `docs/MCM-Redesign-Mockup.html` illustrates the intended web look (using the "Test Import" collection as an example) and is followed for style, not for exact data or copy.
- **iOS is out of scope**: consistent with the project, the targets are web and Android.
