/**
 * MCM Design System — Dark Theme (Cinema Mode)
 *
 * The dark theme uses a deeper blue-black background (#0F1117) beyond MD3's
 * standard N10 (#1A1C1E) to evoke a cinema/home-theatre atmosphere.
 * The orange tertiary accent glows warmly against this dark surface.
 *
 * This is the recommended default theme for MCM — movie collection
 * management is a context where dark mode feels natural and premium.
 */

import { darkColors } from '../tokens/colors'

export const darkTheme = {
  // ── MD3 Color Roles (spread first so the Tamagui built-ins below override) ──
  ...darkColors,

  // ── Tamagui built-ins ───────────────────────────────────────────────────
  background:             darkColors.background,      // #0F1117
  backgroundHover:        darkColors.surface1,        // slightly lighter
  backgroundPress:        darkColors.surface2,
  backgroundFocus:        darkColors.surface1,
  backgroundStrong:       darkColors.surface3,
  backgroundTransparent:  'transparent',

  color:                  darkColors.onBackground,    // #E3E2E6
  colorHover:             darkColors.onSurface,
  colorPress:             darkColors.onSurface,
  colorFocus:             darkColors.onSurface,
  colorTransparent:       'transparent',

  borderColor:            darkColors.outlineVariant,  // #44474B
  borderColorHover:       darkColors.outline,          // #8E9099
  borderColorFocus:       darkColors.primary,          // #A0C2FF
  borderColorPress:       darkColors.primary,

  shadowColor:            darkColors.shadow,           // #000000
  shadowColorHover:       darkColors.shadow,

  placeholderColor:       darkColors.onSurfaceVariant, // #C5C6CF
} as const

export type DarkTheme = typeof darkTheme
