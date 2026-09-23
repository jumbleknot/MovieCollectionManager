/**
 * MCM Design System — MD3 Switch
 *
 * Faithful to MD3 spec:
 *   - 52x32dp track, 20dp thumb (off) / 24dp thumb (on)
 *   - Animated thumb slide + colour change
 *   - icons on thumb (on/off state)
 *   - 48x48 minimum touch target via hitSlop
 *
 * Remaining view props (notably `testID`) are forwarded to the Pressable — the element that
 * actually receives the press — so `[data-testid="..."]` resolves on web. They are spread FIRST
 * rather than last, which is the opposite of the house idiom used by Chip and SearchBar. That is
 * deliberate: `accessibilityRole="switch"` and `accessibilityState` are what make this control a
 * switch to assistive technology and to `getByRole` locators, so they are pinned after the spread
 * and cannot be clobbered by a caller. `accessibilityLabel` and `style` are merged rather than
 * pinned, because a caller overriding either is a legitimate thing to want.
 */

import React, { useState, useEffect } from 'react'
import { Animated, Pressable } from 'react-native'
import { View, useTheme, type ViewProps } from '@tamagui/core'

export interface SwitchProps extends Omit<ViewProps, 'onPress' | 'children'> {
  value:          boolean
  onValueChange:  (value: boolean) => void
  disabled?:      boolean
  iconOn?:        React.ReactNode
  iconOff?:       React.ReactNode
  label?:         string  // accessibilityLabel
}

// Track: 52 wide, 32 tall
// Thumb: 20 (off) → 24 (on)
// Thumb travel: 16dp (52 - 32 = 20, minus thumb margins)

const TRACK_W   = 52
const TRACK_H   = 32
const THUMB_OFF = 20
const THUMB_ON  = 24
const THUMB_OFF_X = 6
const THUMB_ON_X  = TRACK_W - THUMB_ON - 6

export const Switch = React.forwardRef<any, SwitchProps>(function Switch(
  {
    value,
    onValueChange,
    disabled = false,
    iconOn,
    iconOff,
    label,
    accessibilityLabel,
    style,
    ...rest
  },
  ref,
) {
  const theme = useTheme()

  const thumbX    = useState(() => new Animated.Value(value ? 1 : 0))[0]
  const thumbSize = useState(() => new Animated.Value(value ? 1 : 0))[0]

  useEffect(() => {
    Animated.parallel([
      Animated.spring(thumbX, {
        toValue:         value ? 1 : 0,
        useNativeDriver: false,
        bounciness:      4,
      }),
      Animated.spring(thumbSize, {
        toValue:         value ? 1 : 0,
        useNativeDriver: false,
        bounciness:      0,
      }),
    ]).start()
  }, [value, thumbSize, thumbX])

  const translateX = thumbX.interpolate({
    inputRange:  [0, 1],
    outputRange: [THUMB_OFF_X, THUMB_ON_X],
  })
  const thumbDim = thumbSize.interpolate({
    inputRange:  [0, 1],
    outputRange: [THUMB_OFF, THUMB_ON],
  })

  const trackBg = disabled
    ? theme.onSurface?.val + '1F'     // 12% opacity
    : value
    ? theme.primary?.val
    : theme.surfaceVariant?.val

  const thumbBg = disabled
    ? theme.onSurface?.val + '61'     // 38% opacity
    : value
    ? theme.onPrimary?.val
    : theme.outline?.val

  return (
    <Pressable
      {...(rest as object)}
      ref={ref}
      onPress={() => !disabled && onValueChange(!value)}
      accessible
      accessibilityLabel={label ?? accessibilityLabel ?? (value ? 'On' : 'Off')}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      disabled={disabled}
      style={[{ opacity: disabled ? 0.38 : 1 }, style as object]}
    >
      {/* Track */}
      <View
        width={TRACK_W}
        height={TRACK_H}
        borderRadius={TRACK_H / 2}
        backgroundColor={trackBg}
        borderWidth={value ? 0 : 2}
        borderColor={theme.outline?.val}
        overflow="hidden"
        justifyContent="center"
      >
        {/* State layer on track */}
        <View
          position="absolute"
          top={0} right={0} bottom={0} left={0}
          backgroundColor={value ? theme.onPrimary?.val : theme.onSurface?.val}
          opacity={0}
          pointerEvents="none"
        />

        {/* Thumb */}
        <Animated.View
          style={{
            position:       'absolute',
            width:          thumbDim,
            height:         thumbDim,
            borderRadius:   12,
            backgroundColor: thumbBg,
            left:           translateX,
            alignItems:     'center',
            justifyContent: 'center',
            // Thumb shadow (MD3 elevation 1)
            shadowColor:    '#000000',
            shadowOffset:   { width: 0, height: 1 },
            shadowOpacity:  0.12,
            shadowRadius:   2,
            elevation:      1,
          }}
        >
          {value ? iconOn : iconOff}
        </Animated.View>
      </View>
    </Pressable>
  )
})

Switch.displayName = 'MCM.Switch'
