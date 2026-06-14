/**
 * MCM Design System — MD3 Tabs
 *
 * Types:
 *   primary   — sits just below the AppBar; full-width indicator line
 *   secondary — sits within content; shorter pill indicator
 *
 * Usage:
 *   <Tabs
 *     tabs={[
 *       { key: 'collection', label: 'Collection' },
 *       { key: 'wishlist',   label: 'Wishlist'   },
 *     ]}
 *     activeKey="collection"
 *     onTabChange={(key) => setActive(key)}
 *   />
 */

import React, { useRef, useEffect, useState } from 'react'
import { Animated, ScrollView, type LayoutRectangle } from 'react-native'
import { Stack, Text, useTheme } from '@tamagui/core'
import { XStack } from '@tamagui/stacks'

export type TabsType = 'primary' | 'secondary'

export interface TabItem {
  key:    string
  label:  string
  icon?:  React.ReactNode
  badge?: boolean | number
}

export interface TabsProps {
  tabs:         TabItem[]
  activeKey:    string
  onTabChange:  (key: string) => void
  type?:        TabsType
  scrollable?:  boolean  // allow horizontal scroll for many tabs
}

export const Tabs = React.memo<TabsProps>(function Tabs({
  tabs,
  activeKey,
  onTabChange,
  type       = 'primary',
  scrollable = false,
}) {
  const theme = useTheme()
  const [layouts, setLayouts] = useState<Record<string, LayoutRectangle>>({})
  const indicatorX    = useRef(new Animated.Value(0)).current
  const indicatorW    = useRef(new Animated.Value(0)).current

  const activeIndex = tabs.findIndex(t => t.key === activeKey)

  // Animate indicator to active tab's position
  useEffect(() => {
    const layout = layouts[activeKey]
    if (!layout) return

    const isPrimary = type === 'primary'
    const targetX   = isPrimary ? layout.x : layout.x + (layout.width - 64) / 2
    const targetW   = isPrimary ? layout.width : 64

    Animated.parallel([
      Animated.spring(indicatorX, {
        toValue:         targetX,
        useNativeDriver: false,
        bounciness:      4,
      }),
      Animated.spring(indicatorW, {
        toValue:         targetW,
        useNativeDriver: false,
        bounciness:      2,
      }),
    ]).start()
  }, [activeKey, layouts, type])

  const TabRow = (
    <XStack
      position="relative"
      borderBottomWidth={type === 'primary' ? 1 : 0}
      borderBottomColor={theme.surfaceVariant?.val}
    >
      {tabs.map((tab, i) => {
        const isActive = tab.key === activeKey

        return (
          <Stack
            key={tab.key}
            flex={scrollable ? 0 : 1}
            alignItems="center"
            justifyContent="center"
            paddingVertical={type === 'primary' ? 16 : 10}
            paddingHorizontal={scrollable ? 24 : 0}
            minWidth={scrollable ? undefined : 0}
            onPress={() => onTabChange(tab.key)}
            cursor="pointer"
            onLayout={(e) => {
              setLayouts(prev => ({ ...prev, [tab.key]: e.nativeEvent.layout }))
            }}
            accessible
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            animation="quick"
            pressStyle={{ opacity: 0.8 }}
            hoverStyle={{ backgroundColor: theme.onSurface?.val + '14' }}
          >
            {/* Icon */}
            {tab.icon && (
              <Stack marginBottom={type === 'primary' ? 4 : 0} position="relative">
                {tab.icon}
                {/* Badge dot */}
                {tab.badge !== undefined && tab.badge !== false && (
                  <Stack
                    position="absolute"
                    top={-2}
                    right={-8}
                    backgroundColor={theme.error?.val}
                    borderRadius={tab.badge === true ? 3 : 8}
                    width={tab.badge === true ? 6 : undefined}
                    height={tab.badge === true ? 6 : 16}
                    minWidth={tab.badge === true ? 6 : 16}
                    paddingHorizontal={tab.badge !== true && String(tab.badge).length > 1 ? 4 : 0}
                    alignItems="center"
                    justifyContent="center"
                  >
                    {tab.badge !== true && (
                      <Text fontSize={11} fontWeight="500" color={theme.onError?.val}>
                        {Number(tab.badge) > 99 ? '99+' : String(tab.badge)}
                      </Text>
                    )}
                  </Stack>
                )}
              </Stack>
            )}

            {/* Label */}
            <Text
              fontFamily="$body"
              fontSize={14}
              fontWeight={isActive ? '700' : '500'}
              letterSpacing={0.1}
              color={isActive ? theme.primary?.val : theme.onSurfaceVariant?.val}
              numberOfLines={1}
            >
              {tab.label}
            </Text>
          </Stack>
        )
      })}

      {/* Sliding indicator */}
      <Animated.View
        style={{
          position:        'absolute',
          bottom:          0,
          left:            indicatorX,
          width:           indicatorW,
          height:          type === 'primary' ? 3 : 32,
          borderRadius:    type === 'primary' ? 2 : 16,
          backgroundColor: theme.primary?.val,
          zIndex:          1,
          // For secondary: center vertically
          ...(type === 'secondary' ? { bottom: undefined, top: undefined, alignSelf: 'center' } : {}),
        }}
        pointerEvents="none"
      />
    </XStack>
  )

  if (scrollable) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        bounces={false}
      >
        {TabRow}
      </ScrollView>
    )
  }

  return TabRow
})

Tabs.displayName = 'MCM.Tabs'
