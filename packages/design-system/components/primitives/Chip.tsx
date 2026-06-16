/**
 * MCM Design System — MD3 Chip
 *
 * Chip types (MD3):
 *   assist     — contextual actions (non-filtering)
 *   filter     — toggleable filter; shows check icon when selected
 *   input      — represents user input; has trailing remove button
 *   suggestion — dynamic suggestions (non-persistent)
 *
 * Variants within a type:
 *   elevated — chip has a tinted surface bg
 *   flat     — chip uses surfaceVariant bg (default)
 */

import React from 'react'
import { Stack, Text, useTheme, type StackProps } from '@tamagui/core'

export type ChipType    = 'assist' | 'filter' | 'input' | 'suggestion'
export type ChipVariant = 'flat' | 'elevated'

export interface ChipProps extends Omit<StackProps, 'onPress'> {
  type?:         ChipType
  variant?:      ChipVariant
  label:         string
  selected?:     boolean        // filter chips: selected state
  /**
   * Colour scheme for the selected (filter) state:
   *   'secondary' — MD3 default (secondaryContainer)
   *   'primary'   — bold primary fill; use to match an app that signals "active" with primary
   *                 elsewhere (e.g. the column-visibility toggle). Default 'secondary'.
   */
  selectedScheme?: 'secondary' | 'primary'
  leadingIcon?:  React.ReactNode
  trailingIcon?: React.ReactNode
  onPress?:      () => void
  onRemove?:     () => void     // input chips: remove handler
  disabled?:     boolean
}

export const Chip = React.forwardRef<any, ChipProps>(function Chip(
  {
    type     = 'assist',
    variant  = 'flat',
    label,
    selected = false,
    selectedScheme = 'secondary',
    leadingIcon,
    trailingIcon,
    onPress,
    onRemove,
    disabled = false,
    ...rest
  },
  ref,
) {
  const theme = useTheme()

  // ── Colour logic ─────────────────────────────────────────────────────────
  // Filter selected uses secondaryContainer; all others use surfaceVariant / surface1

  let bg:         string
  let fg:         string
  let border:     string | undefined
  let stateLayer: string

  if (type === 'filter' && selected) {
    if (selectedScheme === 'primary') {
      bg         = theme.primary?.val
      fg         = theme.onPrimary?.val
      stateLayer = theme.onPrimary?.val
    } else {
      bg         = theme.secondaryContainer?.val
      fg         = theme.onSecondaryContainer?.val
      stateLayer = theme.onSecondaryContainer?.val
    }
    border     = undefined
  } else if (variant === 'elevated') {
    bg         = theme.surface1?.val
    fg         = theme.onSurface?.val
    stateLayer = theme.onSurface?.val
    border     = undefined
  } else {
    bg         = 'transparent'
    fg         = theme.onSurfaceVariant?.val
    stateLayer = theme.onSurface?.val
    border     = theme.outline?.val
  }

  const showCheckmark = type === 'filter' && selected

  // Shadow for elevated
  const shadowProps = variant === 'elevated'
    ? {
        shadowColor:   theme.shadow?.val,
        shadowOffset:  { width: 0, height: 1 },
        shadowOpacity: 0.12,
        shadowRadius:  2,
        elevation:     1,
      }
    : {}

  return (
    <Stack
      ref={ref}
      accessible
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      flexDirection="row"
      alignItems="center"
      height={32}
      borderRadius={8}              // MD3 small shape
      borderWidth={border ? 1 : 0}
      borderColor={border}
      backgroundColor={bg}
      paddingHorizontal={type === 'filter' && selected ? 8 : 16}
      overflow="hidden"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.38 : 1}
      pointerEvents={disabled ? 'none' : 'auto'}
      animation="quick"
      onPress={disabled ? undefined : onPress}
      pressStyle={{ opacity: 0.88 }}
      hoverStyle={{ opacity: 0.92 }}
      // focusVisibleStyle (not focusStyle) so the ring shows for KEYBOARD focus only — a mouse
      // click otherwise leaves a persistent :focus outline until blur (feature 015 bug fix).
      outlineStyle="none"
      focusVisibleStyle={{
        outlineStyle:  'solid',
        outlineWidth:  2,
        outlineColor:  '$primary',
        outlineOffset: 2,
      }}
      {...shadowProps}
      {...rest}
    >
      {/* State layer */}
      <Stack
        position="absolute"
        top={0} right={0} bottom={0} left={0}
        backgroundColor={stateLayer}
        opacity={0}
        pointerEvents="none"
        hoverStyle={{ opacity: 0.08 }}
        pressStyle={{ opacity: 0.12 }}
      />

      {/* Leading: checkmark (filter selected) or icon */}
      {showCheckmark && (
        <Stack marginRight={8} width={18} height={18} alignItems="center" justifyContent="center">
          {/* Inline SVG check using Text; replace with icon library in app */}
          <Text color={fg} fontSize={14} fontWeight="600" lineHeight={18}>✓</Text>
        </Stack>
      )}

      {!showCheckmark && leadingIcon && (
        <Stack marginRight={8} width={18} height={18} alignItems="center" justifyContent="center">
          {leadingIcon}
        </Stack>
      )}

      {/* Label — MD3 labelLarge */}
      <Text
        fontFamily="$body"
        fontSize={14}
        fontWeight="500"
        letterSpacing={0.1}
        color={fg}
        numberOfLines={1}
      >
        {label}
      </Text>

      {/* Trailing: remove (input) or custom icon */}
      {type === 'input' && onRemove && (
        <Stack
          marginLeft={8}
          width={18}
          height={18}
          alignItems="center"
          justifyContent="center"
          onPress={(e) => { e.stopPropagation?.(); onRemove() }}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <Text color={fg} fontSize={14} lineHeight={18}>×</Text>
        </Stack>
      )}

      {trailingIcon && type !== 'input' && (
        <Stack marginLeft={8} width={18} height={18} alignItems="center" justifyContent="center">
          {trailingIcon}
        </Stack>
      )}
    </Stack>
  )
})

Chip.displayName = 'MCM.Chip'

// ─── Chip Group — horizontal scrolling row ────────────────────────────────────

export interface ChipGroupProps {
  children:   React.ReactNode
  gap?:       number
}

export function ChipGroup({ children, gap = 8 }: ChipGroupProps) {
  return (
    <Stack
      flexDirection="row"
      flexWrap="wrap"
      gap={gap}
      alignItems="center"
    >
      {children}
    </Stack>
  )
}

ChipGroup.displayName = 'MCM.ChipGroup'
