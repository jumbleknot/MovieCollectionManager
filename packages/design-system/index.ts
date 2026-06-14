/**
 * MCM Design System — Public API
 *
 * Import from this barrel in mcm-app:
 *   import { Button, Card, MovieCard, AssistantAvatar, … } from '@mcm/design-system'
 *   import tamaguiConfig from '@mcm/design-system/tamagui.config'
 */

// ─── Tamagui config (re-exported for convenience) ─────────────────────────────
export { default as tamaguiConfig } from './tamagui.config'

// ─── Tokens ───────────────────────────────────────────────────────────────────
export { palette }                                from './tokens/palette'
export { lightColors, darkColors }                from './tokens/colors'
export { typeScale, fontFamilies, fontWeights,
         fontSizeTokens, lineHeightTokens }       from './tokens/typography'
export { spaceTokens, sizeTokens, radiusTokens,
         zIndexTokens, shapeScale }               from './tokens/spacing'
export { elevation, componentElevation }          from './tokens/elevation'
export { motion, duration, easingCSS,
         easingCoords, transitions }              from './tokens/motion'

// ─── Themes ───────────────────────────────────────────────────────────────────
export { lightTheme, darkTheme }                  from './theme'

// ─── Fonts ────────────────────────────────────────────────────────────────────
export { fonts, outfitFont, interFont }           from './fonts'

// ─── All components ───────────────────────────────────────────────────────────
export * from './components'
