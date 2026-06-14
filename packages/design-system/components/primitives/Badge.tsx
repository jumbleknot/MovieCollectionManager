/**
 * MCM Design System — MD3 Badge
 *
 * Two forms:
 *   dot    — 6x6dp circle, no label (new/unread indicator)
 *   count  — pill/circle with a number or short string
 *
 * Colour: error by default (MD3 spec), configurable.
 * Typically anchored to an icon via absolute positioning inside a
 * relative-positioned Stack.
 *
 * Usage:
 *   <Stack position="relative">
 *     <MyIcon />
 *     <Badge count={3} />
 *   </Stack>
 */

import React from 'react'
import { Stack, Text, useTheme, type StackProps } from 'tamagui'

export type BadgeColorScheme = 'error' | 'primary' | 'tertiary'

export interface BadgeProps extends Omit<StackProps, 'children'> {
  count?:       number | string   // omit for dot badge
  max?:         number            // truncates count to "max+" (default 99)
  colorScheme?: BadgeColorScheme
  // Position offsets from top-right of parent (default: straddles top-right corner)
  top?:         number
  right?:       number
}

export const Badge = React.forwardRef<any, BadgeProps>(function Badge(
  {
    count,
    max         = 99,
    colorScheme = 'error',
    top         = -4,
    right       = -4,
    ...rest
  },
  ref,
) {
  const theme = useTheme()

  const colors: Record<BadgeColorScheme, { bg: string; fg: string }> = {
    error:   { bg: theme.error.val,   fg: theme.onError.val   },
    primary: { bg: theme.primary.val, fg: theme.onPrimary.val },
    tertiary:{ bg: theme.tertiary.val,fg: theme.onTertiary.val},
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
    <Stack
      ref={ref}
      position="absolute"
      top={top}
      right={right}
      zIndex={10}
      backgroundColor={c.bg}
      borderRadius={isDot ? 3 : 8}
      width={isDot ? 6 : typeof size === 'number' ? size : undefined}
      height={isDot ? 6 : 16}
      minWidth={isDot ? 6 : 16}
      paddingHorizontal={isLong ? 6 : 0}
      alignItems="center"
      justifyContent="center"
      // White ring per MD3 spec
      borderWidth={2}
      borderColor={theme.background.val}
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
    </Stack>
  )
})

Badge.displayName = 'MCM.Badge'
