# Phase 1 Data Model — Design-System Consistency Remediation

This feature is presentation-only; the "entities" are design-system constructs, not persisted data.

## Entity: Success colour role

A new semantic colour added to `@mcm/design-system`, defined per theme.

| Field | Type | Light | Dark | Constraint |
|-------|------|-------|------|------------|
| `success` | colour | `#1B6E2E` | `#7FD98C` | AA ≥4.5:1 as text on `surface`/`surface1`..`surface3` |
| `onSuccess` | colour | `#FFFFFF` | `#06270D` | AA ≥4.5:1 on a `success`-filled element |
| `successContainer` | colour | `#B7F0BE` | `#1B5E20` | container/banner background |
| `onSuccessContainer` | colour | `#06270D` | `#B7F0BE` | AA ≥4.5:1 on `successContainer` |

- **Source**: a green tonal ramp `palette.success[0..100]`; roles map by tone (light: 40/100/90/10; dark: 80/20/30/90) — identical pattern to `primary`/`tertiary`/`error`.
- **Exposure**: available as `theme.success?.val` (component code) and `$success` (Tamagui token).
- **Validation rule**: every tone pair used together MUST pass the DS contrast test in both themes.

## Entity: Type-scale step

The finite set of sanctioned font sizes every text element must use.

- **Allowed values**: `{11, 12, 14, 16, 18, 22, 24, 28, 32, 36, 45, 57}`.
- **Family rule**: titles/headings → Outfit (`$heading`); body/labels → Inter (`$body`). Each text style MUST declare one.
- **Weight rule**: a declared weight MUST map to a loaded face — Outfit ∈ {400,500,600,700}, Inter ∈ {400,500,600,700} (after the Inter 600/700 faces are added, D2). No synthesized weight.

## Entity: Sanctioned deviation

A catalogued, intentional departure from the default DS pattern, each with a rationale. The compliance scan's allowlist is derived from this catalogue (see `contracts/sanctioned-deviations.md`).

| Deviation | Rationale | Allowlist effect |
|-----------|-----------|------------------|
| `NoAutoFillInput` (not DS `TextField`) | password-manager autofill suppression on all forms except registration | input pressables exempt |
| Radio selectors (not native picker) | `@react-native-picker` crashes on Android new arch | radio `TouchableOpacity` exempt |
| Mismatch orange = `tertiary` | FR-010 media↔quality signal | the one sanctioned orange accent |
| Assistant dock bottom-LEFT + custom toggle | bottom-right intercepts form Save buttons | dock toggle pressable exempt |
| Web data-table vs native card density/sizing | R7 platform-appropriate layout | per-platform size split allowed |
| Whole-card / whole-row press wrapper | navigation affordance, not a "button" | card/row press wrappers exempt |
| Removable list chips (directors/actors/genres/tags) | DS has no removable-chip variant yet | exempt this feature; DS backlog item |
| `transparent` / `outlineStyle:'none'` | utility, not a colour | colour-literal allowlist |

## Relationships

- `Success colour role` is consumed by: email-verification + sign-in verified states, movie-detail Owned/Ripped "Yes".
- `Type-scale step` constrains every text style in `frontend/mcm-app/src` and `packages/design-system`.
- `Sanctioned deviation` defines the allowlist for the static compliance scan — anything not catalogued must comply.
