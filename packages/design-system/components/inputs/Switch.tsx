/**
 * MCM Design System — MD3 Switch
 *
 * Faithful to MD3 spec:
 *   - 52x32dp track, 20dp thumb (off) / 24dp thumb (on)
 *   - Animated thumb slide + colour change
 *   - icons on thumb (on/off state)
 *   - 48x48 minimum touch target via hitSlop
 */

import React, { useRef, useEffect } from 'react'
import { Animated, Pressable } from 'react-native'
import { Stack, useTheme, type StackProps } from 'tamagui'

export interface SwitchProps extends Omit<StackProps, 'onPress' | 'children'> {
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
    ...rest
  },
  ref,
) {
  const theme = useTheme()

  const thumbX    = useRef(new Animated.Value(value ? 1 : 0)).current
  const thumbSize = useRef(new Animated.Value(value ? 1 : 0)).current

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
  }, [value])

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
      ref={ref}
      onPress={() => !disabled && onValueChange(!value)}
      accessible
      accessibilityLabel={label ?? (value ? 'On' : 'Off')}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      disabled={disabled}
      style={{ opacity: disabled ? 0.38 : 1 }}
    >
      {/* Track */}
      <Stack
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
        <Stack
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
      </Stack>
    </Pressable>
  )
})

Switch.displayName = 'MCM.Switch'
