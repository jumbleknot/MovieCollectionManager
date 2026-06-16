# Contract — `success` colour role (design-system)

The design system exposes a new semantic colour role. This is the contract consumers and the contrast test rely on.

## Token names (stable)

`success`, `onSuccess`, `successContainer`, `onSuccessContainer` — present in BOTH `lightColors` and `darkColors`, in `lightTheme`/`darkTheme`, and in the Tamagui colour-token map (so `$success` resolves).

## Values (anchor — tune only to satisfy AA)

| Role | Light | Dark |
|------|-------|------|
| `success` | `#1B6E2E` | `#7FD98C` |
| `onSuccess` | `#FFFFFF` | `#06270D` |
| `successContainer` | `#B7F0BE` | `#1B5E20` |
| `onSuccessContainer` | `#06270D` | `#B7F0BE` |

## Contract assertions (DS unit test)

1. All four roles exist and are non-empty in `lightColors` and `darkColors`.
2. `theme.success?.val` resolves under both `lightTheme` and `darkTheme` via `TamaguiProvider`.
3. Contrast: `success` on `surface` ≥ 4.5:1, `onSuccess` on `success` ≥ 4.5:1, `onSuccessContainer` on `successContainer` ≥ 4.5:1 — in **both** themes.

## Usage contract (consumers)

- Positive/verified TEXT on a surface → `theme.success?.val`.
- Verified BANNER (filled) → background `successContainer`, text `onSuccessContainer`.
- No consumer may use a green colour literal; all positive/verified colour flows through these roles (SC-004).
