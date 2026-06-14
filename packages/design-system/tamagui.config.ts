/**
 * MCM Design System — Tamagui Configuration
 *
 * Drop this file into the root of `mcm-app/` and reference it in tamagui.config.js
 * (or tamagui.config.ts if your bundler supports it).
 *
 * Prerequisite packages:
 *   npx expo install tamagui @tamagui/core @tamagui/config
 *   npx expo install expo-font @expo-google-fonts/outfit @expo-google-fonts/inter
 *
 * Tamagui version: ^1.x  (tested with 1.102+)
 */

import { createTamagui, createTokens } from 'tamagui'
import { shorthands } from '@tamagui/shorthands'

import { lightTheme, darkTheme } from './theme'
import { fonts }                 from './fonts'
import {
  spaceTokens,
  sizeTokens,
  radiusTokens,
  zIndexTokens,
} from './tokens/spacing'
import { lightColors, darkColors } from './tokens/colors'
import { palette }                 from './tokens/palette'

// ─── Flatten all palette colours into a single colour token map ──────────────
// This makes every tonal palette colour available as $primaryP40 etc.
// The semantic roles (primary, onPrimary …) come from the theme, not here.

const colorTokens = {
  // Raw palette tones — available as $color.primaryP40 etc.
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

  // Semantic aliases duplicated here so they survive outside of a theme context
  ...lightColors,

  // Transparent utility
  transparent: 'rgba(0,0,0,0)',
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

  // Default props applied to every Tamagui component
  defaultProps: {
    Text: {
      fontFamily: '$body',
      color:      '$onBackground',
    },
    // Stack / XStack / YStack — no opinion; keep flexible
  },

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
