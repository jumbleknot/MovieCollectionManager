# Feature Specification: Design-System Consistency Remediation

**Feature Branch**: `017-design-system-consistency`

**Created**: 2026-06-16

**Status**: Draft

**Input**: Follow-up to the feature-015 design-system audit. Bring mcm-app to full, intentional compliance with `@mcm/design-system` — every colour a theme token, every font on the MD3 type scale in Outfit/Inter, every action a design-system component — while codifying the deviations that are deliberate. Adds a semantic `success` colour role to the design system.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Correct, theme-faithful colour everywhere (Priority: P1)

Every screen renders with colours drawn from the active theme, in both dark and light mode. A user who switches to dark mode (or back) sees the whole app — including the sign-in/registration screens, loading states, and the new-movie screen — adopt the theme; nothing flashes white or shows an off-palette colour. "Positive/verified" states (e.g. an email-verified confirmation, an "owned/ripped: Yes" flag) use a single, intentional success colour that is legible in both themes.

**Why this priority**: These are the only findings that are *visible bugs today* — several surfaces escape the theme and render with the wrong colour in dark mode, and the "success green" is an off-palette literal that fails contrast on a light surface unless hand-patched. Fixing colour first delivers the most user-visible value and removes the contrast risk.

**Independent Test**: Toggle dark↔light on every screen (auth, home, collections, movie list, movie detail, forms, loading/redirect states) and confirm no white/wrong-colour flashes; confirm verified/"Yes" states render a consistent success colour; run an automated contrast scan in both themes with zero violations.

**Acceptance Scenarios**:

1. **Given** the app is in dark mode, **When** the user opens the sign-in or registration screen, **Then** the screen background and text are the dark theme's colours (no white background).
2. **Given** any authenticated screen in either theme, **When** a loading/redirect indicator appears, **Then** its spinner and message use theme colours, not fixed blue/grey.
3. **Given** a verified-email confirmation or an "owned/ripped: Yes" flag, **When** it is shown in either theme, **Then** it uses the design system's success colour and meets AA contrast against its surface.
4. **Given** the entire mcm-app application source, **When** it is scanned for raw colour literals, **Then** no hardcoded hex/`rgb`/`rgba` colours remain except a small set of explicitly sanctioned utilities (e.g. `transparent`).

---

### User Story 2 — Consistent typography on the type scale (Priority: P2)

All text uses the design system's two typefaces (Outfit for titles/headings, Inter for body/labels) at sizes drawn from the Material-3 type scale. The same kind of text — a screen title, a card title, a button label, a body line — is the same size and family wherever it appears; no element silently falls back to the system font or sits between scale steps.

**Why this priority**: Typography drift is visible (same-looking elements rendering at slightly different sizes/fonts) but not a functional bug, so it ranks below colour. It is high-value for a polished, coherent feel.

**Independent Test**: Inspect every screen's text styles; confirm every font size is a valid scale step and every text element declares Outfit or Inter (no system-font fallback); confirm equivalent elements across screens share size/family/weight.

**Acceptance Scenarios**:

1. **Given** any text in mcm-app, **When** its font size is checked, **Then** it is one of the design system's scale steps (no in-between values).
2. **Given** a screen title (or card title, or button label) on one screen, **When** compared to the same kind of element on another screen, **Then** they share the same font family, size, and weight.
3. **Given** any text style, **When** its font family is checked, **Then** it is Outfit or Inter (no implicit system-font fallback).

---

### User Story 3 — Every action is a consistent design-system control (Priority: P3)

Every button, primary call-to-action, destructive action, selectable option, and chip is a design-system component. The same semantic action looks and behaves identically everywhere: a "primary action" is the same button on the sign-in screen, the home screen, and inside the assistant; a "destructive action" (logout, delete) is the same danger-styled button on every screen; selectable filters/options are the same chip/option control. No screen hand-rolls its own button.

**Why this priority**: This is the largest source of *random* differentiation (the same action implemented several different ways, including a button style copy-pasted three times in the assistant layer). It is the most code to change and the lowest user-visible risk, so it ranks last among the fixes — but it is what makes the app feel like one product.

**Independent Test**: Enumerate every interactive control; confirm each is a design-system component (Button/IconButton/Chip) or a documented sanctioned exception; confirm the primary, destructive, and option controls are visually identical across screens; confirm all existing automation selectors still resolve.

**Acceptance Scenarios**:

1. **Given** a primary action on any screen, **When** compared across screens, **Then** all primary actions are the same design-system button style.
2. **Given** a destructive action (logout, delete), **When** it is shown, **Then** it is the design system's danger-styled button on every screen.
3. **Given** the assistant's approval, import, and result actions, **When** they are shown, **Then** they use design-system buttons (not bespoke hand-rolled pill buttons) and the same style is not duplicated per component.
4. **Given** every interactive control, **When** the app's automated test selectors run, **Then** every previously existing selector still resolves (no regression).

---

### User Story 4 — Intentional deviations are codified, not accidental (Priority: P4)

The differences that are *deliberate* are written down and preserved, so that "compliance" never erases a decision made for a real reason. A maintainer can tell at a glance which non-standard choices are sanctioned (and why) versus which are drift to be fixed.

**Why this priority**: Without this, a future "make it consistent" pass would wrongly "fix" the deliberate deviations. Low urgency, high long-term value; it is documentation, not code.

**Independent Test**: A reviewer reads the sanctioned-deviations list and can map each preserved non-standard choice to a documented rationale; the deviations remain unchanged by this feature.

**Acceptance Scenarios**:

1. **Given** the sanctioned-deviations list, **When** a reviewer inspects each preserved deviation, **Then** each has a clear documented rationale.
2. **Given** this feature's changes, **When** the sanctioned deviations are checked, **Then** they are unchanged (password-manager-safe inputs, radio selectors, the single orange mismatch accent, the assistant dock placement, the web-table-vs-card density split, whole-row press wrappers).

### Edge Cases

- **No success-colour regression on legacy data**: a movie with no recorded owned/ripped state must not render a stray success colour.
- **Theme switch mid-session**: switching themes while any screen (including a modal, a loading state, or an open assistant panel) is visible must not leave any element on the previous theme's colour.
- **Removable list chips**: the design system has no removable-chip variant yet; the existing removable chips (directors/actors/genres/tags) are out of scope for migration this feature and remain as-is (noted for the design-system backlog).
- **Contrast of the new success colour**: the success colour must meet AA against every surface it is placed on, in both themes (it cannot be a single hue that fails on one theme).

## Requirements *(mandatory)*

### Functional Requirements

**Design-system token**

- **FR-001**: The design system MUST gain a semantic success colour role (`success`/`onSuccess`, plus container variants as needed) defined for both light and dark themes, each meeting WCAG 2.2 AA contrast against the surfaces it is used on.
- **FR-002**: All "positive/verified/yes" states in mcm-app MUST consume the new success role instead of any colour literal (the email-verified confirmation, the sign-in verified banner, and the movie-detail owned/ripped "Yes" flags).

**Colour compliance**

- **FR-003**: Every colour in mcm-app application source MUST resolve from the active theme; no hardcoded hex/`rgb`/`rgba` colour literals may remain, except an explicitly enumerated set of sanctioned utilities (e.g. fully transparent).
- **FR-004**: All screens that currently escape the theme (sign-in, registration, the new-movie screen, the shared loading indicator, the auth-callback/redirect screens) MUST render theme colours in both dark and light mode.
- **FR-005**: Dead/duplicate colour literals left in style sheets (shadowed by inline theme overrides) MUST be removed so the declared style and the rendered colour agree.

**Typography compliance**

- **FR-006**: Every font size in mcm-app MUST be a valid Material-3 type-scale step; off-scale sizes MUST be snapped to the nearest appropriate step.
- **FR-007**: Every text element MUST declare an Outfit or Inter family (titles → Outfit, body/labels → Inter); elements that currently fall back to the system font MUST be given the correct family.
- **FR-008**: Font weights MUST map to a loaded font face (no synthesized weight that has no loaded face).

**Control compliance**

- **FR-009**: Every action control (button, primary CTA, destructive action, selectable option, filter chip, icon action) MUST be a design-system component, except documented sanctioned exceptions.
- **FR-010**: Equivalent semantic controls MUST be visually and behaviourally identical across screens (one primary-action style, one destructive-action style, one option/chip style).
- **FR-011**: Duplicated bespoke control styling MUST be eliminated (no per-component copy of the same hand-rolled button).
- **FR-012**: Section/column-header treatment MUST be unified (a single accent + weight for "header"-role labels across the web table and the native list).

**Guards**

- **FR-013**: Every automation selector that exists today MUST continue to resolve unchanged (the established selector baseline).
- **FR-014**: An automated contrast scan MUST report zero violations on every restyled screen in both dark and light themes.
- **FR-015**: The sanctioned-deviation set MUST be preserved unchanged and documented: password-manager-safe inputs (all forms except registration), radio selectors in place of the native picker, the single orange mismatch accent, the assistant-dock placement and its custom toggle, the web data-table vs native card-list density split, whole-card/row press wrappers, and the not-yet-migratable removable list chips.

**Scope guards (non-goals)**

- **FR-016**: This feature MUST NOT change any behaviour, routing, data, or copy; it is presentation-only.

### Key Entities *(include if data involved)*

- **Success colour role**: a new semantic colour in the design system representing a positive/verified/affirmative state; has a light value and a dark value (and on-colour/container pairs as needed), each AA-contrast-safe on its surfaces.
- **Type-scale step**: the finite set of sanctioned font sizes (11, 12, 14, 16, 18, 22, 24, 28, 32, 36, 45, 57) every text element must use.
- **Sanctioned deviation**: a catalogued, intentional departure from the default design-system pattern, each with a recorded rationale.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero hardcoded colour literals (hex/`rgb`/`rgba`) remain in mcm-app application source outside the enumerated sanctioned-utility allowlist.
- **SC-002**: Zero off-scale font sizes remain; 100% of text elements declare an Outfit or Inter family.
- **SC-003**: 100% of action controls are design-system components or a documented sanctioned exception; the same bespoke control style is not duplicated anywhere.
- **SC-004**: The new success colour role is the sole source of every positive/verified/"Yes" colour in the app, and meets AA contrast in both themes.
- **SC-005**: An automated contrast scan reports zero violations on every restyled screen in both dark and light themes.
- **SC-006**: Every previously existing automation selector still resolves (the selector baseline shows zero removed selectors).
- **SC-007**: The full existing web end-to-end regression and the design-system unit suite pass unchanged (zero functional regression).
- **SC-008**: The sanctioned-deviation list is published and every listed deviation is verifiably unchanged.

## Assumptions

- The work is web-and-mobile UI surface only; the existing web end-to-end run (against the containerized dev BFF) plus the design-system unit suite and the automated accessibility/contrast scans are the regression gates. (Mobile-emulator CI is tracked separately and is not a gate here.)
- The design system is on its current major version (Tamagui v2.3.0, post-016); the success role is added the same way the existing semantic roles are defined.
- The success colour is a green tonal family by convention; exact tones are chosen to satisfy AA on each theme's surfaces.
- "Sanctioned utilities" for SC-001 means at minimum `transparent`; any additional unavoidable literal must be justified and added to the allowlist explicitly.
- Removable list chips (directors/actors/genres/tags) are excluded from control migration this feature because the design system has no removable-chip variant yet; this is recorded for the design-system backlog rather than fixed here.
- The home/collection/movie-detail screens already render correct colours at runtime (via inline theme overrides); removing their dead literals is a correctness/maintainability cleanup, not a visible change.
