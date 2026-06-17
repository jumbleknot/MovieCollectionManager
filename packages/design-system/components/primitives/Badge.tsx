/**
 * MCM Design System — MD3 Badge
 *
 * Two forms:
 *   dot    — 6x6dp circle, no label (new/unread indicator)
 *   count  — pill/circle with a number or short string
 *
 * Colour: error by default (MD3 spec), configurable.
 * Typically anchored to an icon via absolute positioning inside a
 * relative-positioned View.
 *
 * Usage:
 *   <View position="relative">
 *     <MyIcon />
 *     <Badge count={3} />
 *   </View>
 */

import React from 'react'
import { View, Text, useTheme, type ViewProps } from '@tamagui/core'

export type BadgeColorScheme = 'error' | 'primary' | 'tertiary'

export interface BadgeProps extends Omit<ViewProps, 'children'> {
  count?:       number | string   // omit for dot badge
  max?:         number            // truncates count to "max+" (default 99)
  colorScheme?: BadgeColorScheme
  // Position offsets from top-right of parent (default: straddles top-right corner)
  top?:         number
  right?:       number
  /**
   * Inline mode: render as a static in-flow status pill (no absolute anchoring, no offsets,
   * no white ring) instead of a notification badge anchored to a parent's top-right corner.
   * Use for non-interactive status labels (e.g. a "Default" tag). Default false.
   */
  inline?:      boolean
}

export const Badge = React.forwardRef<any, BadgeProps>(function Badge(
  {
    count,
    max         = 99,
    colorScheme = 'error',
    top         = -4,
    right       = -4,
    inline      = false,
    ...rest
  },
  ref,
) {
  const theme = useTheme()

  const colors: Record<BadgeColorScheme, { bg: string; fg: string }> = {
    error:   { bg: theme.error?.val,   fg: theme.onError?.val   },
    primary: { bg: theme.primary?.val, fg: theme.onPrimary?.val },
    tertiary:{ bg: theme.tertiary?.val,fg: theme.onTertiary?.val},
  }
  const c = colors[colorScheme]

  const isDot   = count === undefined || count === null
  const label   = isDot ? '' : (
    typeof count === 'number' && count > max
      ? `${max}+`
      : String(count)
  )
  const isLong  = label.length > 2
  const size    = isDot ? 6 : isLong ? 'auto' : 16

  return (
    <View
      ref={ref}
      position={inline ? 'relative' : 'absolute'}
      top={inline ? undefined : top}
      right={inline ? undefined : right}
      zIndex={inline ? undefined : 10}
      backgroundColor={c.bg}
      borderRadius={isDot ? 3 : 8}
      width={isDot ? 6 : typeof size === 'number' ? size : undefined}
      height={isDot ? 6 : 16}
      minWidth={isDot ? 6 : 16}
      paddingHorizontal={isLong ? 6 : 0}
      alignItems="center"
      justifyContent="center"
      // White ring per MD3 spec — only when anchored over another element (not inline).
      borderWidth={inline ? 0 : 2}
      borderColor={inline ? undefined : theme.background?.val}
      {...rest}
    >
      {!isDot && (
        <Text
          fontFamily="$body"
          fontSize={11}
          fontWeight="500"
          letterSpacing={0.5}
          color={c.fg}
          lineHeight={12}
        >
          {label}
        </Text>
      )}
    </View>
  )
})

Badge.displayName = 'MCM.Badge'
