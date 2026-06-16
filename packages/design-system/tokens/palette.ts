/**
 * MCM Design System — Material Design 3 Tonal Palettes
 *
 * Seed colours:
 *   Primary   → #1565C0  (Cinematic Blue — deep, rich, premium)
 *   Secondary → auto-derived (Blue-Grey — supporting)
 *   Tertiary  → #E65100  (Grumpy Robot Orange — accent only)
 *   Error     → #B3261E  (MD3 standard error red)
 *   Neutral   → derived from primary hue
 *
 * Tones follow Material's 0-100 lightness scale.
 * Each palette is expressed as Record<tone, hex>.
 */

export const primaryPalette = {
  0:   '#000000',
  5:   '#000D2E',
  10:  '#001848',
  20:  '#002E78',
  25:  '#003894',
  30:  '#0043AA',
  35:  '#0C54B7',
  40:  '#1565C0',   // key colour — light theme primary
  50:  '#3579D0',
  60:  '#5590E0',
  70:  '#77A8EF',
  80:  '#A0C2FF',   // dark theme primary
  90:  '#D2E4FF',   // light theme primaryContainer
  95:  '#EBF1FF',
  98:  '#F7F8FF',
  99:  '#FDFCFF',
  100: '#FFFFFF',
} as const

export const secondaryPalette = {
  0:   '#000000',
  10:  '#101C2B',
  20:  '#263141',
  30:  '#3D4759',
  40:  '#545F71',   // light theme secondary
  50:  '#6D7889',
  60:  '#8792A4',
  70:  '#A1ACBF',
  80:  '#BBC7DB',   // dark theme secondary
  90:  '#D7E3F8',   // light theme secondaryContainer
  95:  '#EBF1FF',
  99:  '#FDFCFF',
  100: '#FFFFFF',
} as const

/** Orange — used as tertiary/accent only. Matches the Grumpy Robot logo colour. */
export const tertiaryPalette = {
  0:   '#000000',
  10:  '#3A0D00',
  20:  '#621C00',
  25:  '#782400',
  30:  '#8E2D00',
  35:  '#A33400',
  40:  '#BC3F00',   // light theme tertiary (slightly darker for contrast)
  50:  '#E65100',   // key colour — the robot's exact orange
  60:  '#FF7239',
  70:  '#FF9E7A',
  80:  '#FFB59A',   // dark theme tertiary
  90:  '#FFDCC8',   // light theme tertiaryContainer
  95:  '#FFEDE5',
  98:  '#FFF8F5',
  99:  '#FFFBFF',
  100: '#FFFFFF',
} as const

/**
 * Green — semantic `success` role only (feature 017). Theme-split like every other role:
 * a single hue cannot meet AA on both a near-white and a near-black surface, so light uses a
 * dark-green key (tone 40) and dark uses a light-green key (tone 80). Tones at the indices the
 * roles consume (10/20/30/40/80/90/100) are AA-verified by success-token.test.tsx.
 */
export const successPalette = {
  0:   '#000000',
  10:  '#06270D',   // light onSuccessContainer
  20:  '#0B3D17',   // dark onSuccess
  25:  '#16491F',
  30:  '#1B5E20',   // dark successContainer
  35:  '#1B6627',
  40:  '#1B6E2E',   // key colour — light theme success
  50:  '#2E9A3D',
  60:  '#43B254',
  70:  '#5FC972',
  80:  '#7FD98C',   // dark theme success
  90:  '#B7F0BE',   // light theme successContainer / dark onSuccessContainer
  95:  '#D7F8DC',
  98:  '#F0FEF1',
  99:  '#F7FFF6',
  100: '#FFFFFF',   // light onSuccess
} as const

export const errorPalette = {
  0:   '#000000',
  10:  '#410E0B',
  20:  '#601410',
  30:  '#8C1D18',
  40:  '#B3261E',   // light theme error
  50:  '#DC362E',
  60:  '#E46962',
  70:  '#EC928E',
  80:  '#F2B8B5',   // dark theme error
  90:  '#F9DEDC',   // light theme errorContainer
  95:  '#FCEEEE',
  99:  '#FFFBF9',
  100: '#FFFFFF',
} as const

/** Blue-biased neutral — surfaces, backgrounds, text */
export const neutralPalette = {
  0:   '#000000',
  4:   '#0C0E10',
  6:   '#111316',
  10:  '#1A1C1E',
  12:  '#1E2022',
  17:  '#262830',
  20:  '#2F3033',
  22:  '#32353A',
  24:  '#363940',
  30:  '#46474A',
  40:  '#5E5F62',
  50:  '#77787B',
  60:  '#909194',
  70:  '#ABABAE',
  80:  '#C7C6CA',
  87:  '#D8D7DC',
  90:  '#E3E2E6',
  92:  '#E9E8ED',
  94:  '#EEF0F5',
  95:  '#F1F0F4',
  96:  '#F4F3F8',
  98:  '#F9F8FD',
  99:  '#FDFBFF',
  100: '#FFFFFF',
} as const

/** Slightly more chromatic neutral — card surfaces, input fills */
export const neutralVariantPalette = {
  0:   '#000000',
  10:  '#191C20',
  20:  '#2E3135',
  30:  '#44474B',
  40:  '#5C5E63',
  50:  '#75777C',
  60:  '#8E9099',
  70:  '#AAABB1',
  80:  '#C5C6CF',
  90:  '#E1E2EC',
  95:  '#EFF0FA',
  99:  '#FDFBFF',
  100: '#FFFFFF',
} as const

// ─── Re-export for convenience ─────────────────────────────────────────────
export const palette = {
  primary:        primaryPalette,
  secondary:      secondaryPalette,
  tertiary:       tertiaryPalette,
  success:        successPalette,
  error:          errorPalette,
  neutral:        neutralPalette,
  neutralVariant: neutralVariantPalette,
} as const

export type Palette = typeof palette
