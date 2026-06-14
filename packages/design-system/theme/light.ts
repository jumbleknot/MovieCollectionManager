/**
 * MCM Design System — Light Theme
 *
 * All semantic color roles follow MD3 naming exactly.
 * Tamagui's built-in `background` and `color` keys are mapped to MD3 roles
 * so Tamagui's default styling works out-of-the-box while MD3 roles are also
 * available as named theme tokens for component-level styling.
 */

import { lightColors } from '../tokens/colors'

export const lightTheme = {
  // ── Tamagui built-ins (required for default Tamagui behaviour) ──────────
  background:             lightColors.background,
  backgroundHover:        lightColors.surface1,
  backgroundPress:        lightColors.surface2,
  backgroundFocus:        lightColors.surface1,
  backgroundStrong:       lightColors.surface,
  backgroundTransparent:  'transparent',

  color:                  lightColors.onBackground,
  colorHover:             lightColors.onSurface,
  colorPress:             lightColors.onSurface,
  colorFocus:             lightColors.onSurface,
  colorTransparent:       'transparent',

  borderColor:            lightColors.outlineVariant,
  borderColorHover:       lightColors.outline,
  borderColorFocus:       lightColors.primary,
  borderColorPress:       lightColors.primary,

  shadowColor:            lightColors.shadow,
  shadowColorHover:       lightColors.shadow,

  placeholderColor:       lightColors.onSurfaceVariant,

  // ── MD3 Color Roles ─────────────────────────────────────────────────────
  ...lightColors,
} as const

export type LightTheme = typeof lightTheme
