/**
 * MCM Design System — Tamagui Font Definitions
 *
 * Uses @tamagui/font-inter for body/label text and a custom Outfit font
 * definition for display/headline/title text.
 *
 * Installation:
 *   expo install expo-font @expo-google-fonts/outfit @expo-google-fonts/inter
 *   npx expo install @tamagui/font-inter
 *
 * In your Expo app's _layout.tsx:
 *   import { useFonts } from 'expo-font'
 *   import {
 *     Outfit_400Regular, *     Outfit_500Medium, *     Outfit_600SemiBold, *     Outfit_700Bold, *   } from '@expo-google-fonts/outfit'
 *   import {
 *     Inter_400Regular, *     Inter_500Medium, *   } from '@expo-google-fonts/inter'
 *
 *   const [fontsLoaded] = useFonts({
 *     Outfit:           Outfit_400Regular, *     'Outfit-Medium':  Outfit_500Medium, *     'Outfit-SemiBold':Outfit_600SemiBold, *     'Outfit-Bold':    Outfit_700Bold, *     Inter:            Inter_400Regular, *     'Inter-Medium':   Inter_500Medium, *   })
 */

import { createFont } from '@tamagui/core'
import {
  fontSizeTokens,
  lineHeightTokens,
  letterSpacingTokens,
} from '../tokens/typography'

// ─── Outfit — Display, Headline, Title ───────────────────────────────────────

export const outfitFont = createFont({
  family: 'Outfit, system-ui, sans-serif',
  size:           fontSizeTokens,
  lineHeight:     lineHeightTokens,
  weight: {
    1:    '400',
    2:    '400',
    3:    '500',
    4:    '500',
    5:    '500',
    6:    '400',
    7:    '400',
    8:    '400',
    9:    '400',
    10:   '400',
    11:   '400',
    12:   '400',
    true: '400',
  },
  letterSpacing:  letterSpacingTokens,
  face: {
    400: { normal: 'Outfit',         italic: 'Outfit' },
    500: { normal: 'Outfit-Medium',  italic: 'Outfit-Medium' },
    600: { normal: 'Outfit-SemiBold',italic: 'Outfit-SemiBold' },
    700: { normal: 'Outfit-Bold',    italic: 'Outfit-Bold' },
  },
})

// ─── Inter — Body, Label ─────────────────────────────────────────────────────

export const interFont = createFont({
  family: 'Inter, system-ui, sans-serif',
  size:           fontSizeTokens,
  lineHeight:     lineHeightTokens,
  weight: {
    1:    '500',
    2:    '500',
    3:    '500',
    4:    '400',
    5:    '400',
    6:    '400',
    7:    '400',
    8:    '400',
    9:    '400',
    10:   '400',
    11:   '400',
    12:   '400',
    true: '400',
  },
  letterSpacing:  letterSpacingTokens,
  face: {
    400: { normal: 'Inter',        italic: 'Inter' },
    500: { normal: 'Inter-Medium', italic: 'Inter-Medium' },
  },
})

export const fonts = {
  heading: outfitFont,  // used for headings (Tamagui built-in key)
  body:    interFont,   // used for body text (Tamagui built-in key)
} as const
