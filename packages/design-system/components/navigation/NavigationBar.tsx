/**
 * MCM Design System — MD3 Navigation Bar
 *
 * Bottom navigation for 3–5 destinations.
 * Each destination: icon + optional label + optional badge.
 *
 * Active indicator: 64x32dp pill behind the active icon.
 * Animation: indicator slides between items on tab change.
 *
 * MD3 height: 80dp + safe area inset (iOS)
 *
 * Usage with Expo Router (recommended):
 *   Use this in _layout.tsx as a custom tabBar.
 *   <Tabs tabBar={(props) => <NavigationBar {...props} destinations={destinations} />} />
 */

import React, { useState, useEffect } from 'react'
import { Animated, Platform, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle, } from 'react-native'
import { Stack, Text, useTheme } from '@tamagui/core'
import { XStack, YStack } from '@tamagui/stacks'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export interface NavDestination {
  key:         string
  label:       string
  icon:        React.ReactNode        // inactive icon
  activeIcon?: React.ReactNode        // active icon (filled variant)
  badge?:      number | boolean       // number = count badge; true = dot badge
  onPress:     () => void
}

export interface NavigationBarProps {
  destinations: NavDestination[]
  activeKey:    string
  style?:       StyleProp<ViewStyle>
}

const BAR_HEIGHT = 80

export const NavigationBar = React.memo<NavigationBarProps>(function NavigationBar({
  destinations,
  activeKey,
  style,
}) {
  const theme   = useTheme()
  const insets  = useSafeAreaInsets()
  const { width } = useWindowDimensions()

  const activeIndex  = Math.max(0, destinations.findIndex(d => d.key === activeKey))
  const itemWidth    = width / destinations.length
  const indicatorX   = useState(() => new Animated.Value(activeIndex * itemWidth))[0]

  useEffect(() => {
    const toX = activeIndex * itemWidth + (itemWidth - 64) / 2
    Animated.spring(indicatorX, {
      toValue:         toX,
      useNativeDriver: true,
      bounciness:      6,
      speed:           20,
    }).start()
  }, [activeIndex, itemWidth])

  const totalHeight = BAR_HEIGHT + insets.bottom

  return (
    <Stack
      height={totalHeight}
      backgroundColor={theme.surface2?.val}
      // MD3 elevation 2
      shadowColor={theme.shadow?.val}
      shadowOffset={{ width: 0, height: -1 }}
      shadowOpacity={0.12}
      shadowRadius={4}
      position="relative"
      overflow="hidden"
      style={[{ elevation: 3 }, style]}
    >
      {/* Active indicator (slides behind active item's icon) */}
      <Animated.View
        style={{
          position:        'absolute',
          top:             12,
          width:           64,
          height:          32,
          borderRadius:    16,
          backgroundColor: theme.secondaryContainer?.val,
          transform:       [{ translateX: indicatorX }],
        }}
        pointerEvents="none"
      />

      {/* Destination items */}
      <XStack flex={1} alignItems="flex-start" paddingTop={12}>
        {destinations.map((dest, i) => {
          const isActive = dest.key === activeKey

          return (
            <Stack
              key={dest.key}
              flex={1}
              alignItems="center"
              onPress={dest.onPress}
              cursor="pointer"
              // Min touch target
              paddingVertical={8}
              accessible
              accessibilityRole="tab"
              accessibilityLabel={dest.label}
              accessibilityState={{ selected: isActive }}
              animation="quick"
              pressStyle={{ opacity: 0.8 }}
            >
              {/* Icon area (48dp tall, icon centered in 64dp wide indicator zone) */}
              <Stack
                width={64}
                height={32}
                alignItems="center"
                justifyContent="center"
                position="relative"
              >
                {/* Badge */}
                {dest.badge !== undefined && dest.badge !== false && (
                  <Stack
                    position="absolute"
                    top={0}
                    right={8}
                    backgroundColor={theme.error?.val}
                    borderRadius={dest.badge === true ? 3 : 8}
                    width={dest.badge === true ? 6 : undefined}
                    height={dest.badge === true ? 6 : 16}
                    minWidth={dest.badge === true ? 6 : 16}
                    paddingHorizontal={dest.badge !== true && String(dest.badge).length > 1 ? 4 : 0}
                    alignItems="center"
                    justifyContent="center"
                    borderWidth={2}
                    borderColor={theme.surface2?.val}
                    zIndex={1}
                  >
                    {dest.badge !== true && (
                      <Text fontSize={11} fontWeight="500" color={theme.onError?.val} lineHeight={12}>
                        {Number(dest.badge) > 99 ? '99+' : String(dest.badge)}
                      </Text>
                    )}
                  </Stack>
                )}

                {/* Icon */}
                {isActive && dest.activeIcon ? dest.activeIcon : dest.icon}
              </Stack>

              {/* Label — MD3 labelMedium */}
              <Text
                fontFamily="$body"
                fontSize={12}
                fontWeight={isActive ? '700' : '400'}
                letterSpacing={0.5}
                color={isActive ? theme.onSecondaryContainer?.val : theme.onSurfaceVariant?.val}
                marginTop={4}
                numberOfLines={1}
              >
                {dest.label}
              </Text>
            </Stack>
          )
        })}
      </XStack>

      {/* Safe area spacer */}
      {insets.bottom > 0 && (
        <Stack height={insets.bottom} />
      )}
    </Stack>
  )
})

NavigationBar.displayName = 'MCM.NavigationBar'
