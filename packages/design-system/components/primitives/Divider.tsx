/**
 * MCM Design System — MD3 Divider
 *
 * Variants:
 *   full    — spans full width/height
 *   inset   — indented from the leading edge (default 16dp)
 *   middle  — indented from both edges (default 16dp each)
 *
 * Direction: 'horizontal' (default) | 'vertical'
 */

import React from 'react'
import { View, useTheme, type ViewProps } from '@tamagui/core'

export type DividerVariant   = 'full' | 'inset' | 'middle'
export type DividerDirection = 'horizontal' | 'vertical'

export interface DividerProps extends Omit<ViewProps, 'children' | 'direction'> {
  variant?:     DividerVariant
  direction?:   DividerDirection
  inset?:       number  // leading inset for 'inset'; both edges for 'middle'
  thickness?:   number  // default 1
}

export const Divider = React.forwardRef<any, DividerProps>(function Divider(
  {
    variant   = 'full',
    direction = 'horizontal',
    inset     = 16,
    thickness = 1,
    ...rest
  },
  ref,
) {
  const theme = useTheme()

  const isH = direction === 'horizontal'

  const insetProps = variant === 'inset'
    ? (isH ? { marginLeft: inset } : { marginTop: inset })
    : variant === 'middle'
    ? (isH ? { marginHorizontal: inset } : { marginVertical: inset })
    : {}

  return (
    <View
      ref={ref}
      backgroundColor={theme.outlineVariant?.val}
      height={isH ? thickness : undefined}
      width={!isH ? thickness : undefined}
      alignSelf="stretch"
      flexShrink={0}
      {...insetProps}
      {...rest}
    />
  )
})

Divider.displayName = 'MCM.Divider'
