/**
 * MCM Design System — MD3 Floating Action Button
 *
 * Variants:
 *   fab          — standard 56x56dp (elevated, tertiaryContainer colour)
 *   fabSmall     — 40x40dp
 *   fabLarge     — 96x96dp
 *   fabExtended  — pill shape with label (min-width 80dp)
 *
 * Colour:
 *   By default FABs use the tertiaryContainer background (orange tint in MCM)
 *   with onTertiaryContainer foreground — the primary CTA surface where the
 *   orange accent is intentionally visible.
 *   Pass colorScheme="primary" or "secondary" to override.
 *
 * Position: consumers control placement (absolute / fixed) outside this component.
 */

import React from 'react'
import { View, Text, useTheme, type ViewProps } from '@tamagui/core'

export type FABVariant     = 'fab' | 'fabSmall' | 'fabLarge' | 'fabExtended'
export type FABColorScheme = 'primary' | 'secondary' | 'tertiary' | 'surface'

export interface FABProps extends Omit<ViewProps, 'children'> {
  variant?:     FABVariant
  colorScheme?: FABColorScheme
  icon:         React.ReactNode
  label?:       string           // required for fabExtended; aria label for others
  onPress?:     () => void
  disabled?:    boolean
  lowered?:     boolean          // MD3 "lowered" FAB (reduced elevation)
}

const variantSize: Record<FABVariant, { size: number; radius: number }> = {
  fab:         { size: 56,  radius: 16 },
  fabSmall:    { size: 40,  radius: 12 },
  fabLarge:    { size: 96,  radius: 28 },
  fabExtended: { size: 56,  radius: 16 }, // height; width is auto
}

export const FAB = React.forwardRef<any, FABProps>(function FAB(
  {
    variant     = 'fab',
    colorScheme = 'tertiary',
    icon,
    label,
    onPress,
    disabled = false,
    lowered  = false,
    ...rest
  },
  ref,
) {
  const theme = useTheme()

  const colors: Record<FABColorScheme, { bg: string; fg: string; stateLayer: string }> = {
    primary: {
      bg:         theme.primaryContainer?.val,
      fg:         theme.onPrimaryContainer?.val,
      stateLayer: theme.onPrimaryContainer?.val,
    },
    secondary: {
      bg:         theme.secondaryContainer?.val,
      fg:         theme.onSecondaryContainer?.val,
      stateLayer: theme.onSecondaryContainer?.val,
    },
    tertiary: {
      bg:         theme.tertiaryContainer?.val,   // warm orange tint
      fg:         theme.onTertiaryContainer?.val, // dark brown for contrast
      stateLayer: theme.onTertiaryContainer?.val,
    },
    surface: {
      bg:         theme.surface3?.val,
      fg:         theme.primary?.val,
      stateLayer: theme.primary?.val,
    },
  }

  const c   = colors[colorScheme]
  const cfg = variantSize[variant]

  // Shadow (MD3 elevation 3 for resting, 4 for hover)
  const shadowProps = {
    shadowColor:   theme.shadow?.val,
    shadowOffset:  { width: 0, height: 2 },
    shadowOpacity: lowered ? 0.12 : 0.2,
    shadowRadius:  lowered ? 4 : 6,
    elevation:     lowered ? 1 : 3,
  }

  const isExtended = variant === 'fabExtended'

  return (
    <View
      ref={ref}
      accessible
      accessibilityLabel={label ?? 'Action'}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      flexDirection={isExtended ? 'row' : 'column'}
      alignItems="center"
      justifyContent="center"
      backgroundColor={c.bg}
      borderRadius={cfg.radius}
      height={cfg.size}
      width={isExtended ? undefined : cfg.size}
      minWidth={isExtended ? 80 : undefined}
      paddingHorizontal={isExtended ? 20 : 0}
      gap={isExtended ? 12 : 0}
      overflow="hidden"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.38 : 1}
      pointerEvents={disabled ? 'none' : 'auto'}
      onPress={disabled ? undefined : onPress}
      pressStyle={{ opacity: 0.88 }}
      hoverStyle={{ opacity: 0.92 }}
      focusStyle={{
        outlineStyle:  'solid',
        outlineWidth:  3,
        outlineColor:  '$primary',
        outlineOffset: 2,
      }}
      {...shadowProps}
      {...rest}
    >
      {/* State layer */}
      <View
        position="absolute"
        top={0} right={0} bottom={0} left={0}
        backgroundColor={c.stateLayer}
        opacity={0}
        pointerEvents="none"
        hoverStyle={{ opacity: 0.08 }}
        pressStyle={{ opacity: 0.12 }}
      />

      {icon}

      {isExtended && label && (
        <Text
          fontFamily="$body"
          fontSize={14}
          fontWeight="500"
          letterSpacing={0.1}
          color={c.fg}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
    </View>
  )
})

FAB.displayName = 'MCM.FAB'
