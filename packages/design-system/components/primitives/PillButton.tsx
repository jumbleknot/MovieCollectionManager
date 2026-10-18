/**
 * MCM Design System — PillButton
 *
 * The single sanctioned ORANGE (tertiary) call-to-action per screen (constitution §SC-005 —
 * restrained orange). Used for the primary "create/add" action: "+ Add movie", "+ Create".
 *
 * It is deliberately NOT a `Button` variant: its look (h38 · Inter 16 · tertiary fill · leading
 * "+") sits between the MD3 Button sizes (sm 32/13, md 40/14, lg 48/16) and is semantically
 * singular, so it gets its own tiny primitive rather than bending the Button size matrix.
 *
 * Stays in normal layout flow (not absolutely positioned) so RN-Fabric dispatches
 * performAction(ACTION_CLICK) to it on Android.
 *
 * Use a DS `Button` (filled/outlined/etc.) for every OTHER action — PillButton is only the
 * one orange CTA.
 */

import React from 'react'
import { View, useTheme, type ViewProps } from '@tamagui/core'
import { Text } from './Text'

export interface PillButtonProps extends Omit<ViewProps, 'onPress'> {
  label:               string
  /** Tamagui's press handler type (RN 0.87 event shape under Tamagui 3) — see Button. */
  onPress?:            ViewProps['onPress']
  disabled?:           boolean
  accessibilityLabel?: string
  testID?:             string
}

export const PillButton = React.forwardRef<any, PillButtonProps>(function PillButton(
  { label, onPress, disabled = false, accessibilityLabel, testID, ...rest },
  ref,
) {
  const theme = useTheme()
  return (
    <View
      ref={ref}
      testID={testID}
      role="button"
      accessibilityLabel={accessibilityLabel ?? label}
      aria-disabled={disabled ? true : undefined}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      height={38}
      borderRadius={19}
      paddingHorizontal={16}
      backgroundColor={theme.tertiary?.val}
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={`${disabled ? 0.38 : 1} hover:0.92 press:0.88`}
      pointerEvents={disabled ? 'none' : 'auto'}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      // MD3 elevation 1 (the CTA lifts slightly off the surface).
      shadowColor={theme.shadow?.val}
      shadowOffset={{ width: 0, height: 2 }}
      shadowOpacity={0.25}
      shadowRadius={3}
      style={{ elevation: 3 }}
      // Ring on KEYBOARD focus only (`focus-visible`, never `focus`).
      outlineStyle="none focus-visible:solid"
      outlineWidth="focus-visible:3px"
      outlineColor="focus-visible:primary"
      outlineOffset="focus-visible:2px"
      onPress={(e) => { if (disabled) return; onPress?.(e) }}
      {...rest}
    >
      <Text
        fontFamily="body"
        fontSize={16}
        fontWeight="600"
        color={theme.onTertiary?.val}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  )
})

PillButton.displayName = 'MCM.PillButton'
