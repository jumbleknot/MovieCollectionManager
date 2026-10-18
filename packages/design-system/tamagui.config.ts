/**
 * MCM Design System — Tamagui Configuration
 *
 * mcm-app re-exports this from its own tamagui.config.ts, which the Tamagui Metro plugin
 * (metro.config.js) and <TamaguiProvider> both read.
 *
 * Packages: @tamagui/core, @tamagui/shorthands, @tamagui/stacks — one exact version, kept in
 * lockstep by scripts/__tests__/tamagui-version-lockstep.guard.test.mjs.
 *
 * Tamagui version: 3.x (exact pin; feature 081 US10)
 */

import { createTamagui, createTokens } from '@tamagui/core'
import { shorthands } from '@tamagui/shorthands'

import { lightTheme, darkTheme } from './theme'
import { fonts }                 from './fonts'
import {
  spaceTokens,
  sizeTokens,
  radiusTokens,
  zIndexTokens,
} from './tokens/spacing'
import { palette }                 from './tokens/palette'

// ─── Flatten all palette colours into a single colour token map ──────────────
// This makes every tonal palette colour available as `primaryP40` etc. (Tamagui 3 token names carry no `$`).
// The semantic roles (primary, onPrimary …) come from the theme, not here.

const colorTokens = {
  // Raw palette tones — available as `primaryP40` etc.
  primaryP0:   palette.primary[0],
  primaryP10:  palette.primary[10],
  primaryP20:  palette.primary[20],
  primaryP30:  palette.primary[30],
  primaryP40:  palette.primary[40],
  primaryP50:  palette.primary[50],
  primaryP60:  palette.primary[60],
  primaryP70:  palette.primary[70],
  primaryP80:  palette.primary[80],
  primaryP90:  palette.primary[90],
  primaryP95:  palette.primary[95],
  primaryP99:  palette.primary[99],
  primaryP100: palette.primary[100],

  secondaryP0:   palette.secondary[0],
  secondaryP10:  palette.secondary[10],
  secondaryP20:  palette.secondary[20],
  secondaryP30:  palette.secondary[30],
  secondaryP40:  palette.secondary[40],
  secondaryP50:  palette.secondary[50],
  secondaryP60:  palette.secondary[60],
  secondaryP70:  palette.secondary[70],
  secondaryP80:  palette.secondary[80],
  secondaryP90:  palette.secondary[90],
  secondaryP95:  palette.secondary[95],
  secondaryP99:  palette.secondary[99],
  secondaryP100: palette.secondary[100],

  tertiaryP0:   palette.tertiary[0],
  tertiaryP10:  palette.tertiary[10],
  tertiaryP20:  palette.tertiary[20],
  tertiaryP30:  palette.tertiary[30],
  tertiaryP40:  palette.tertiary[40],
  tertiaryP50:  palette.tertiary[50],
  tertiaryP60:  palette.tertiary[60],
  tertiaryP70:  palette.tertiary[70],
  tertiaryP80:  palette.tertiary[80],
  tertiaryP90:  palette.tertiary[90],
  tertiaryP95:  palette.tertiary[95],
  tertiaryP99:  palette.tertiary[99],
  tertiaryP100: palette.tertiary[100],

  successP0:   palette.success[0],
  successP10:  palette.success[10],
  successP20:  palette.success[20],
  successP30:  palette.success[30],
  successP40:  palette.success[40],
  successP50:  palette.success[50],
  successP60:  palette.success[60],
  successP70:  palette.success[70],
  successP80:  palette.success[80],
  successP90:  palette.success[90],
  successP95:  palette.success[95],
  successP99:  palette.success[99],
  successP100: palette.success[100],

  errorP0:   palette.error[0],
  errorP10:  palette.error[10],
  errorP20:  palette.error[20],
  errorP30:  palette.error[30],
  errorP40:  palette.error[40],
  errorP50:  palette.error[50],
  errorP60:  palette.error[60],
  errorP70:  palette.error[70],
  errorP80:  palette.error[80],
  errorP90:  palette.error[90],
  errorP95:  palette.error[95],
  errorP99:  palette.error[99],
  errorP100: palette.error[100],

  // NO semantic aliases here (they were `...lightColors`). Tamagui 3 resolves a bare name on a colour
  // property TOKEN-FIRST, theme second (getSplitStyles), where v2's `$name` was theme-first. With
  // the light values duplicated as tokens, `color: 'onBackground'` / `outlineColor: 'primary'`
  // resolved to the LIGHT colour inside the dark theme (measured: #1a1c1e instead of #e3e2e6,
  // components/text-defaults.test.tsx). Nothing reads them as tokens, and every theme defines all
  // 39 roles, so the theme is now their only source — as it already was in practice (feature 081 US10).

  // `transparent` is not a token: Tamagui 3 rejects a token named after a CSS keyword, which
  // always resolves as the literal CSS value anyway (feature 081 US10).
  white:       '#FFFFFF',
  black:       '#000000',
} as const

// ─── Tokens ───────────────────────────────────────────────────────────────────

const tokens = createTokens({
  color:   colorTokens,
  size:    sizeTokens,
  space:   spaceTokens,
  radius:  radiusTokens,
  zIndex:  zIndexTokens,
})

// ─── Media queries ────────────────────────────────────────────────────────────

const media = {
  xs:   { maxWidth: 480 },
  sm:   { maxWidth: 640 },
  md:   { maxWidth: 768 },
  lg:   { maxWidth: 1024 },
  xl:   { maxWidth: 1280 },
  xxl:  { maxWidth: 1536 },
  gtXs: { minWidth: 481 },
  gtSm: { minWidth: 641 },
  gtMd: { minWidth: 769 },
  gtLg: { minWidth: 1025 },
  // Device-class breakpoints (useful for adaptive layouts)
  compact:  { maxWidth: 599 },   // phone portrait
  medium:   { minWidth: 600, maxWidth: 839 },  // phone landscape / small tablet
  expanded: { minWidth: 840 },   // tablet / desktop
} as const

// ─── Assemble config ─────────────────────────────────────────────────────────

const config = createTamagui({
  tokens,
  themes: {
    light: lightTheme,
    dark:  darkTheme,
  },
  fonts,
  media,
  shorthands,

  // No `defaultProps`: Tamagui 3 removed config-level default props (guide §17). The body-font /
  // onBackground defaults every Text used to get from here now live on the design system's own
  // `Text` (components/primitives/Text.tsx) — feature 081 US10.

  // Settings
  settings: {
    // Enables the Tamagui CSS media-query shorthand optimisations on web
    mediaQueryDefaultActive: { compact: true },
    // Ensure styled() variants are included in bundles when tree-shaking
    allowedStyleValues: 'somewhat-strict',
  },
})

export type AppConfig = typeof config
export default config

// NOTE: the `declare module 'tamagui'` augmentation lives in `tamagui-types.d.ts`,
// NOT here. Keeping it in this file makes `createTamagui`'s inferred return type
// reference the augmented `TamaguiCustomConfig`, which references `typeof config`
// — a self-reference TS reports as TS7022/TS2456/TS2310. Splitting it into an
// ambient declaration file defers that resolution and breaks the cycle.
