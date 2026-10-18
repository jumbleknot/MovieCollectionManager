/**
 * MCM Design System — Text
 *
 * The design system's base text: Tamagui's core `Text` with the body font and the theme's
 * `onBackground` colour as its OWN defaults. Every `Text` in the design system and the app is this
 * one, never `@tamagui/core`'s directly.
 *
 * Why it exists (feature 081 US10, research R12 B4). Tamagui 2 supplied these two defaults from the
 * config — `createTamagui({ defaultProps: { Text: { fontFamily: '$body', color: '$onBackground' } } })`
 * — to every core `Text`. Tamagui 3 removes config `defaultProps` with no replacement for a core
 * component and no type error at any call site, so a bare core `Text` would silently fall back to the
 * platform font and, on native, BLACK text on the dark theme. Tamagui's guide (§17) puts "a
 * component's default look" in the component itself, which is this file. Explicit props still win.
 * Pinned by components/text-defaults.test.tsx; the no-core-Text rule is enforced there too.
 */
import { styled, Text as CoreText, type GetProps } from '@tamagui/core'

export const Text = styled(CoreText, {
  fontFamily: 'body',
  color:      'onBackground',
})

export type TextProps = GetProps<typeof Text>
