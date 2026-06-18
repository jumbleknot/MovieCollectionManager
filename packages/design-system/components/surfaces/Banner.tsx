/**
 * MCM Design System — inline Banner (feature 017 — code-review finding #9)
 *
 * A static, in-flow status notice (success / error) — distinct from the transient `Snackbar`.
 * Owns the container + text colour roles, radius, padding and font so the five hand-rolled banner
 * blocks across the app (login / email-verification / home / movie-form / register-form) share one
 * source of truth. Layout spacing (margin / width) is legitimately context-specific and is passed
 * through as Tamagui props (`...rest`), not baked in.
 *
 * a11y: error → role="alert" (assertive; the only valid RN accessibilityRole for a notice).
 * Success notices are not announced as alerts (matching the prior hand-rolled banners).
 *
 * Usage:
 *   <Banner tone="error" testID="login-error-banner" marginBottom={24} align="center">{error}</Banner>
 */

import React from 'react'
import { View, Text, useTheme, type ViewProps } from '@tamagui/core'

export interface BannerProps extends ViewProps {
  tone:      'success' | 'error'
  children:  React.ReactNode      // message text
  align?:    'left' | 'center'    // text alignment (default 'left')
  emphasis?: boolean              // SemiBold (600) message text (default false)
  testID?:   string
}

export const Banner = React.forwardRef<any, BannerProps>(function Banner(
  { tone, children, align = 'left', emphasis = false, testID, ...rest },
  ref,
) {
  const theme = useTheme()
  const bg = tone === 'success' ? theme.successContainer?.val : theme.errorContainer?.val
  const fg = tone === 'success' ? theme.onSuccessContainer?.val : theme.onErrorContainer?.val

  return (
    <View
      ref={ref}
      testID={testID}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      backgroundColor={bg}
      borderRadius={8}
      padding={12}
      {...rest}
    >
      <Text
        fontFamily="$body"
        fontSize={14}
        fontWeight={emphasis ? '600' : '400'}
        textAlign={align}
        color={fg}
      >
        {children}
      </Text>
    </View>
  )
})

Banner.displayName = 'MCM.Banner'
