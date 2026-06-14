/**
 * MCM Design System — MD3 Icon Button
 *
 * Variants:
 *   standard  — no container, icon only
 *   filled    — filled with primary colour
 *   filledTonal — filled with secondaryContainer
 *   outlined  — outlined container
 *
 * Size: 40x40dp standard (MD3), 48x48 minimum touch target enforced.
 *
 * Usage:
 *   <IconButton icon={<MyIcon />} label="Close" variant="standard" />
 */

import React from 'react'
import { Stack, styled, useTheme, type StackProps } from '@tamagui/core'

export type IconButtonVariant = 'standard' | 'filled' | 'filledTonal' | 'outlined'

export interface IconButtonProps extends Omit<StackProps, 'children'> {
  icon:       React.ReactNode
  label:      string           // accessibilityLabel — required for a11y
  variant?:   IconButtonVariant
  size?:      number           // container size in dp (default 40)
  selected?:  boolean          // toggled state (MD3 toggle icon button)
  disabled?:  boolean
  onPress?:   () => void
}

export const IconButton = React.forwardRef<any, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    variant  = 'standard',
    size     = 40,
    selected = false,
    disabled = false,
    onPress,
    ...rest
  },
  ref,
) {
  const theme = useTheme()

  type VS = { bg: string; border?: string; iconColor: string; stateLayer: string }

  const variantStyles: Record<IconButtonVariant, VS> = {
    standard: {
      bg:         'transparent',
      iconColor:  selected ? theme.primary?.val : theme.onSurfaceVariant?.val,
      stateLayer: selected ? theme.primary?.val : theme.onSurfaceVariant?.val,
    },
    filled: {
      bg:         selected ? theme.primary?.val        : theme.surfaceVariant?.val,
      iconColor:  selected ? theme.onPrimary?.val      : theme.primary?.val,
      stateLayer: selected ? theme.onPrimary?.val      : theme.primary?.val,
    },
    filledTonal: {
      bg:         selected ? theme.secondaryContainer?.val : theme.surfaceVariant?.val,
      iconColor:  selected ? theme.onSecondaryContainer?.val : theme.onSurfaceVariant?.val,
      stateLayer: selected ? theme.onSecondaryContainer?.val : theme.onSurfaceVariant?.val,
    },
    outlined: {
      bg:         selected ? theme.inverseSurface?.val : 'transparent',
      border:     selected ? undefined : theme.outline?.val,
      iconColor:  selected ? theme.inverseOnSurface?.val : theme.onSurfaceVariant?.val,
      stateLayer: selected ? theme.inverseOnSurface?.val : theme.onSurfaceVariant?.val,
    },
  }

  const vs = variantStyles[variant]

  return (
    <Stack
      ref={ref}
      accessible
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      width={size}
      height={size}
      minWidth={48}
      minHeight={48}
      borderRadius={size / 2}
      borderWidth={vs.border ? 1 : 0}
      borderColor={vs.border}
      backgroundColor={vs.bg}
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.38 : 1}
      pointerEvents={disabled ? 'none' : 'auto'}
      onPress={disabled ? undefined : onPress}
      animation="quick"
      pressStyle={{ opacity: 0.88 }}
      hoverStyle={{ opacity: 0.92 }}
      focusStyle={{
        outlineStyle:  'solid',
        outlineWidth:  3,
        outlineColor:  '$primary',
        outlineOffset: 2,
      }}
      {...rest}
    >
      {/* State layer */}
      <Stack
        position="absolute"
        top={0} right={0} bottom={0} left={0}
        borderRadius={size / 2}
        backgroundColor={vs.stateLayer}
        opacity={0}
        pointerEvents="none"
        hoverStyle={{ opacity: 0.08 }}
        pressStyle={{ opacity: 0.12 }}
      />
      {icon}
    </Stack>
  )
})

IconButton.displayName = 'MCM.IconButton'
