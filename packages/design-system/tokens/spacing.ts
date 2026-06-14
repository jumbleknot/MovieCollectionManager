/**
 * MCM Design System — Spacing & Sizing Tokens
 *
 * Based on an 4dp base grid (MD3 recommendation).
 * Tamagui expects numeric size/space tokens on keys 0–20 (plus fractional).
 *
 * space tokens = internal padding / gap
 * size  tokens = component dimensions (height, icon sizes, etc.)
 */

// ─── Space (padding / gap / margin) ─────────────────────────────────────────
export const spaceTokens = {
  0:     0,
  0.25:  1,   // hairline
  0.5:   2,
  1:     4,
  1.5:   6,
  2:     8,
  2.5:   10,
  3:     12,
  3.5:   14,
  4:     16,
  4.5:   18,
  5:     20,
  5.5:   22,
  6:     24,
  7:     28,
  8:     32,
  9:     36,
  10:    40,
  11:    44,
  12:    48,
  14:    56,
  16:    64,
  18:    72,
  20:    80,
  true:  16, // default
} as const

// ─── Size (component dimensions) ─────────────────────────────────────────────
export const sizeTokens = {
  0:    0,
  0.25: 2,
  0.5:  4,
  1:    8,
  1.5:  12,
  2:    16,
  2.5:  20,
  3:    24,   // small icon
  3.5:  28,
  4:    32,   // compact component height
  4.5:  36,
  5:    40,   // standard button/input height (MD3)
  5.5:  44,
  6:    48,   // navigation bar item height
  6.5:  52,
  7:    56,   // FAB size, AppBar height
  7.5:  60,
  8:    64,   // large FAB
  9:    72,
  10:   80,
  11:   88,
  12:   96,   // large avatar
  14:   112,
  16:   128,
  18:   144,
  20:   160,
  true: 40,  // default
} as const

// ─── Border Radius ────────────────────────────────────────────────────────────
// MD3 Shape system: Extra Small → Extra Large → Full
export const radiusTokens = {
  0:    0,
  1:    2,    // extraSmall (top)
  2:    4,    // extraSmall
  3:    8,    // small
  4:    12,   // medium — Card default
  5:    16,   // large (top)
  6:    16,   // large — Chip, Dialog
  7:    28,   // extraLarge — FAB
  8:    32,   // extraLarge (top)
  9:    40,   // full (for pill shapes)
  10:   100,  // fully circular
  true: 12,   // default (medium)
} as const

// ─── Named shape shortcuts (MD3 shape roles) ─────────────────────────────────
export const shapeScale = {
  none:        0,
  extraSmall:  4,
  extraSmallTop: 4,  // top-only corners
  small:       8,
  medium:      12,
  large:       16,
  largeTop:    16,   // top-only corners
  extraLarge:  28,
  extraLargeTop: 28,
  full:        9999, // pill / circle
} as const

// ─── Z-Index ──────────────────────────────────────────────────────────────────
export const zIndexTokens = {
  0:  0,
  1:  100,   // card elevation
  2:  200,   // dropdown, tooltip
  3:  300,   // modal backdrop
  4:  400,   // modal content
  5:  500,   // snackbar
  6:  600,   // FAB
  7:  700,   // navigation bar
  8:  800,   // app bar
  9:  900,   // dialog
  10: 1000,  // system toast / overlay
} as const

export type SpaceToken  = keyof typeof spaceTokens
export type SizeToken   = keyof typeof sizeTokens
export type RadiusToken = keyof typeof radiusTokens
