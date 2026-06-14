/**
 * MCM Design System — Material Design 3 Color Roles
 *
 * Maps tonal palette tones → semantic MD3 color roles for light and dark themes.
 * These are imported by theme/light.ts and theme/dark.ts.
 *
 * Naming follows the MD3 spec exactly so component code is portable
 * to any MD3-compatible system.
 */

import { palette } from './palette'

const p  = palette.primary
const s  = palette.secondary
const t  = palette.tertiary
const e  = palette.error
const n  = palette.neutral
const nv = palette.neutralVariant

// ─── Light Theme Color Roles ────────────────────────────────────────────────

export const lightColors = {
  // Primary
  primary:                p[40],   // #1565C0
  onPrimary:              p[100],  // #FFFFFF
  primaryContainer:       p[90],   // #D2E4FF
  onPrimaryContainer:     p[10],   // #001848

  // Secondary
  secondary:              s[40],   // #545F71
  onSecondary:            s[100],  // #FFFFFF
  secondaryContainer:     s[90],   // #D7E3F8
  onSecondaryContainer:   s[10],   // #101C2B

  // Tertiary (Orange accent — use sparingly)
  tertiary:               t[40],   // #BC3F00
  onTertiary:             t[100],  // #FFFFFF
  tertiaryContainer:      t[90],   // #FFDCC8
  onTertiaryContainer:    t[10],   // #3A0D00

  // Error
  error:                  e[40],   // #B3261E
  onError:                e[100],  // #FFFFFF
  errorContainer:         e[90],   // #F9DEDC
  onErrorContainer:       e[10],   // #410E0B

  // Background / Surface
  background:             n[99],   // #FDFBFF
  onBackground:           n[10],   // #1A1C1E
  surface:                n[99],   // #FDFBFF
  onSurface:              n[10],   // #1A1C1E
  surfaceVariant:         nv[90],  // #E1E2EC
  onSurfaceVariant:       nv[30],  // #44474B

  // Outline
  outline:                nv[50],  // #75777C
  outlineVariant:         nv[80],  // #C5C6CF

  // Special
  shadow:                 n[0],    // #000000
  scrim:                  n[0],    // #000000
  inverseSurface:         n[20],   // #2F3033
  inverseOnSurface:       n[95],   // #F1F0F4
  inversePrimary:         p[80],   // #A0C2FF
  surfaceTint:            p[40],   // #1565C0 (same as primary)

  // Surface tones (surface + primary tint at increasing opacities, pre-computed)
  surface1: '#EEF4FF',  // surface + 5%  primary tint
  surface2: '#E5EDFF',  // surface + 8%  primary tint
  surface3: '#DAEAFF',  // surface + 11% primary tint
  surface4: '#D6E7FF',  // surface + 12% primary tint
  surface5: '#CEEAFF',  // surface + 14% primary tint
} as const

// ─── Dark Theme Color Roles (Cinema Mode) ───────────────────────────────────
// Background is shifted to a deep blue-black (#0F1117) for a cinematic feel,
// slightly more saturated than MD3's pure neutral dark surface.

export const darkColors = {
  // Primary
  primary:                p[80],   // #A0C2FF
  onPrimary:              p[20],   // #002E78
  primaryContainer:       p[30],   // #0043AA
  onPrimaryContainer:     p[90],   // #D2E4FF

  // Secondary
  secondary:              s[80],   // #BBC7DB
  onSecondary:            s[20],   // #263141
  secondaryContainer:     s[30],   // #3D4759
  onSecondaryContainer:   s[90],   // #D7E3F8

  // Tertiary (lighter orange glows on dark)
  tertiary:               t[80],   // #FFB59A
  onTertiary:             t[20],   // #621C00
  tertiaryContainer:      t[30],   // #8E2D00
  onTertiaryContainer:    t[90],   // #FFDCC8

  // Error
  error:                  e[80],   // #F2B8B5
  onError:                e[20],   // #601410
  errorContainer:         e[30],   // #8C1D18
  onErrorContainer:       e[90],   // #F9DEDC

  // Background / Surface — Cinema Dark
  background:             '#0F1117',  // Deep blue-black (cinematic, beyond MD3 N10)
  onBackground:           n[90],      // #E3E2E6
  surface:                '#0F1117',  // Same as background in dark
  onSurface:              n[90],      // #E3E2E6
  surfaceVariant:         nv[30],     // #44474B
  onSurfaceVariant:       nv[80],     // #C5C6CF

  // Outline
  outline:                nv[60],     // #8E9099
  outlineVariant:         nv[30],     // #44474B

  // Special
  shadow:                 n[0],       // #000000
  scrim:                  n[0],       // #000000
  inverseSurface:         n[90],      // #E3E2E6
  inverseOnSurface:       n[20],      // #2F3033
  inversePrimary:         p[40],      // #1565C0
  surfaceTint:            p[80],      // #A0C2FF

  // Surface tones (dark surface + primary tint)
  surface1: '#141A26',  // #0F1117 + 5%  primary tint
  surface2: '#172030',  // #0F1117 + 8%  primary tint
  surface3: '#1A2538',  // #0F1117 + 11% primary tint
  surface4: '#1B263A',  // #0F1117 + 12% primary tint
  surface5: '#1D2A3E',  // #0F1117 + 14% primary tint
} as const

export type LightColors = typeof lightColors
export type DarkColors  = typeof darkColors
export type ColorToken  = keyof LightColors
