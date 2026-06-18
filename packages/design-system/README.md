# @mcm/design-system

Material Design 3 token set + Tamagui component library for `mcm-app` (web + native).

Import from the barrel:

```ts
import { Button, Card, MovieCard, lightColors, darkColors } from '@mcm/design-system';
import tamaguiConfig from '@mcm/design-system/tamagui.config';
```

## Semantic colour roles

Every role is **theme-split** (a light-theme value and a dark-theme value) so it meets WCAG AA on
both the near-white light surface and the near-black "Cinema" dark surface. Roles resolve as theme
tokens (`$primary`, `$success`, …) and via `useTheme()` (`theme.success?.val`).

| Role group | Tokens |
|---|---|
| Primary | `primary` `onPrimary` `primaryContainer` `onPrimaryContainer` |
| Secondary | `secondary` `onSecondary` `secondaryContainer` `onSecondaryContainer` |
| Tertiary (sparing orange accent) | `tertiary` `onTertiary` `tertiaryContainer` `onTertiaryContainer` |
| **Success (positive / verified — feature 017)** | **`success` `onSuccess` `successContainer` `onSuccessContainer`** |
| Error | `error` `onError` `errorContainer` `onErrorContainer` |
| Surface / background | `background` `surface` `surface1`–`surface5` `surfaceVariant` `outline` … |

### `success` usage

- Positive/verified **text** on a surface → `theme.success?.val` (`$success`).
- Verified **banner** (filled) → background `successContainer`, text `onSuccessContainer`.
- Never use a green colour literal — all positive/verified colour flows through these roles
  (feature 017 SC-004). AA is guarded by `components/success-token.test.tsx`.

## Type scale & fonts

Sizes are the MD3 steps `{11,12,14,16,18,22,24,28,32,36,45,57}`. Outfit (display/headline/title)
loads weights 400/500/600/700; Inter (body/label) loads 400/500/600/700. Declare an explicit
`fontFamily` (`Outfit-*` / `Inter-*` or the `$heading` / `$body` tokens) on text styles.

See `frontend/mcm-app/README.md` → "Design-system compliance" for the app-side rules (R1–R5) and
the sanctioned-deviation catalogue.
