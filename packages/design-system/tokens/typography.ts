/**
 * MCM Design System — Material Design 3 Type Scale
 *
 * Fonts:
 *   Display / Headline / Title → Outfit   (geometric sans; modern, cinematic feel)
 *   Body / Label               → Inter    (neutral, highly legible at small sizes)
 *
 * Scale follows MD3 spec (sp units = px on web; treated as logical pixels on RN).
 * Letter-spacing values are converted from tracking (sp) to em for RN/web parity.
 *
 * Install:
 *   expo install expo-font @expo-google-fonts/outfit @expo-google-fonts/inter
 */

export const fontFamilies = {
  display:  'Outfit',
  headline: 'Outfit',
  title:    'Outfit',
  body:     'Inter',
  label:    'Inter',
} as const

export const fontWeights = {
  regular: '400' as const,
  medium:  '500' as const,
  semibold:'600' as const,
  bold:    '700' as const,
} as const

/**
 * MD3 type roles mapped to style objects.
 * Use these directly in Tamagui Text / styled() definitions.
 */
export const typeScale = {
  displayLarge: {
    fontFamily:     fontFamilies.display,
    fontSize:       57,
    lineHeight:     64,
    fontWeight:     fontWeights.regular,
    letterSpacing:  -0.25,
  },
  displayMedium: {
    fontFamily:     fontFamilies.display,
    fontSize:       45,
    lineHeight:     52,
    fontWeight:     fontWeights.regular,
    letterSpacing:  0,
  },
  displaySmall: {
    fontFamily:     fontFamilies.display,
    fontSize:       36,
    lineHeight:     44,
    fontWeight:     fontWeights.regular,
    letterSpacing:  0,
  },

  headlineLarge: {
    fontFamily:     fontFamilies.headline,
    fontSize:       32,
    lineHeight:     40,
    fontWeight:     fontWeights.regular,
    letterSpacing:  0,
  },
  headlineMedium: {
    fontFamily:     fontFamilies.headline,
    fontSize:       28,
    lineHeight:     36,
    fontWeight:     fontWeights.regular,
    letterSpacing:  0,
  },
  headlineSmall: {
    fontFamily:     fontFamilies.headline,
    fontSize:       24,
    lineHeight:     32,
    fontWeight:     fontWeights.regular,
    letterSpacing:  0,
  },

  titleLarge: {
    fontFamily:     fontFamilies.title,
    fontSize:       22,
    lineHeight:     28,
    fontWeight:     fontWeights.regular,
    letterSpacing:  0,
  },
  titleMedium: {
    fontFamily:     fontFamilies.title,
    fontSize:       16,
    lineHeight:     24,
    fontWeight:     fontWeights.medium,
    letterSpacing:  0.15,
  },
  titleSmall: {
    fontFamily:     fontFamilies.title,
    fontSize:       14,
    lineHeight:     20,
    fontWeight:     fontWeights.medium,
    letterSpacing:  0.1,
  },

  bodyLarge: {
    fontFamily:     fontFamilies.body,
    fontSize:       16,
    lineHeight:     24,
    fontWeight:     fontWeights.regular,
    letterSpacing:  0.5,
  },
  bodyMedium: {
    fontFamily:     fontFamilies.body,
    fontSize:       14,
    lineHeight:     20,
    fontWeight:     fontWeights.regular,
    letterSpacing:  0.25,
  },
  bodySmall: {
    fontFamily:     fontFamilies.body,
    fontSize:       12,
    lineHeight:     16,
    fontWeight:     fontWeights.regular,
    letterSpacing:  0.4,
  },

  labelLarge: {
    fontFamily:     fontFamilies.label,
    fontSize:       14,
    lineHeight:     20,
    fontWeight:     fontWeights.medium,
    letterSpacing:  0.1,
  },
  labelMedium: {
    fontFamily:     fontFamilies.label,
    fontSize:       12,
    lineHeight:     16,
    fontWeight:     fontWeights.medium,
    letterSpacing:  0.5,
  },
  labelSmall: {
    fontFamily:     fontFamilies.label,
    fontSize:       11,
    lineHeight:     16,
    fontWeight:     fontWeights.medium,
    letterSpacing:  0.5,
  },
} as const

export type TypeRole = keyof typeof typeScale

/**
 * Tamagui font size token mapping.
 * Keys 1–10 map to increasing font sizes; MD3 labels align as below.
 */
export const fontSizeTokens = {
  1:  11,  // labelSmall
  2:  12,  // labelMedium / bodySmall
  3:  14,  // labelLarge / bodyMedium / titleSmall
  4:  16,  // bodyLarge / titleMedium
  5:  18,
  6:  22,  // titleLarge
  7:  24,  // headlineSmall
  8:  28,  // headlineMedium
  9:  32,  // headlineLarge
  10: 36,  // displaySmall
  11: 45,  // displayMedium
  12: 57,  // displayLarge
  true: 14, // default
} as const

export const lineHeightTokens = {
  1:  16,
  2:  16,
  3:  20,
  4:  24,
  5:  24,
  6:  28,
  7:  32,
  8:  36,
  9:  40,
  10: 44,
  11: 52,
  12: 64,
  true: 20,
} as const

export const letterSpacingTokens = {
  1:  0.5,   // labelSmall
  2:  0.5,   // labelMedium
  3:  0.1,   // labelLarge
  4:  0.5,   // bodyLarge
  5:  0,
  6:  0,
  7:  0,
  8:  0,
  9:  0,
  10: 0,
  11: 0,
  12: -0.25,
  true: 0,
} as const
