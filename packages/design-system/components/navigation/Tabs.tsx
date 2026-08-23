/**
 * MCM Design System — MD3 Tabs
 *
 * Types:
 *   primary   — sits just below the AppBar; full-width indicator line
 *   secondary — sits within content (e.g. a sub-navigation one level below the AppBar);
 *               filled `secondaryContainer` pill behind the label
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

import React, { useEffect, useState } from 'react'
import { Animated, Pressable, ScrollView, StyleSheet, type LayoutRectangle } from 'react-native'
import { View, Text, useTheme } from '@tamagui/core'
import { XStack } from '@tamagui/stacks'

export type TabsType = 'primary' | 'secondary'

export interface TabItem {
  key:    string
  label:  string
  icon?:  React.ReactNode
  badge?: boolean | number
  /**
   * STABLE EXTERNAL-CONTRACT SELECTOR — exempt from the constitution's
   * behaviour-descriptive-identifier rule under its carve-out for E2E selectors.
   *
   * Rendered on the plain RN `Pressable` host node below, never on the Tamagui `View`: a
   * Tamagui component does NOT forward testID → data-testid on React-Native-Web, the same
   * limitation `mcm-app`'s admin-settings-card documents for the design system's `Card`.
   * The host node maps testID → data-testid on web and id on native, so jest, Playwright and
   * Maestro all locate and press the same element. Optional — existing callers are unaffected.
   */
  testID?: string
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
  const indicatorX    = useState(() => new Animated.Value(0))[0]
  const indicatorW    = useState(() => new Animated.Value(0))[0]

  // Animate indicator to active tab's position
  useEffect(() => {
    const layout = layouts[activeKey]
    if (!layout) return

    // The secondary pill hugs the TAB, rather than the fixed 64dp NavigationBar uses — that
    // width is sized for an icon, and a text tab ("Movie Assistant" measures ~153dp) would
    // overflow it on both sides. Same role, different content.
    const targetX = layout.x
    const targetW = layout.width

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
  }, [activeKey, layouts, type, indicatorW, indicatorX])

  const TabRow = (
    <XStack
      position="relative"
      borderBottomWidth={type === 'primary' ? 1 : 0}
      borderBottomColor={theme.surfaceVariant?.val}
    >
      {tabs.map((tab, i) => {
        const isActive = tab.key === activeKey

        return (
          <Pressable
            key={tab.key}
            testID={tab.testID}
            onPress={() => onTabChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            // BOTH, and the second is not redundant — it was measured missing. React Native Web
            // renders `accessibilityRole="tab"` as role="tab" but does NOT emit `aria-selected`
            // from `accessibilityState`, so a screen reader on web was told which elements were
            // tabs and never which one was current. jest-expo renders React Native, not the DOM,
            // so the accessibilityState assertion passes there either way — the same shape of
            // trap as the testID this component already documents.
            aria-selected={isActive}
            onLayout={(e) => {
              setLayouts(prev => ({ ...prev, [tab.key]: e.nativeEvent.layout }))
            }}
            style={({ pressed }) => [
              scrollable ? styles.tabScrollable : styles.tabFlex,
              type === 'secondary' ? styles.tabAboveIndicator : null,
              pressed ? styles.tabPressed : null,
            ]}
          >
          <View
            flex={scrollable ? undefined : 1}
            alignItems="center"
            justifyContent="center"
            paddingVertical={type === 'primary' ? 16 : 10}
            paddingHorizontal={scrollable ? 24 : 0}
            minWidth={scrollable ? undefined : 0}
            cursor="pointer"
            hoverStyle={{ backgroundColor: theme.onSurface?.val + '14' }}
          >
            {/* Icon */}
            {tab.icon && (
              <View marginBottom={type === 'primary' ? 4 : 0} position="relative">
                {tab.icon}
                {/* Badge dot */}
                {tab.badge !== undefined && tab.badge !== false && (
                  <View
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
                  </View>
                )}
              </View>
            )}

            {/* Label */}
            <Text
              fontFamily="$body"
              fontSize={14}
              fontWeight={isActive ? '700' : '500'}
              letterSpacing={0.1}
              color={
                isActive
                  ? type === 'secondary'
                    ? theme.onSecondaryContainer?.val
                    : theme.primary?.val
                  : theme.onSurfaceVariant?.val
              }
              numberOfLines={1}
            >
              {tab.label}
            </Text>
          </View>
          </Pressable>
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
          // MD3 container role, matching this package's own NavigationBar active indicator
          // ("64x32dp pill behind the active icon", secondaryContainer / onSecondaryContainer).
          // It was `theme.primary` — an opaque saturated fill drawn IN FRONT of the label, in the
          // same colour as the active label, so the active tab's text was invisible inside it.
          backgroundColor: type === 'primary' ? theme.primary?.val : theme.secondaryContainer?.val,
          // Primary's 3dp bar draws OVER the bottom border by design; the secondary pill draws
          // BEHIND the tab content, which carries zIndex 1 (see styles.tabAboveIndicator).
          zIndex:          type === 'primary' ? 1 : 0,
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

// ─── Styles ───────────────────────────────────────────────────────────────────
// On the RN host node only. The tab's visual treatment stays on the Tamagui View inside,
// which is where the design tokens live; these three carry layout and press feedback that
// have to sit on the host node so the testID and the press target are the same element.
const styles = StyleSheet.create({
  tabFlex:       { flex: 1 },
  // NOT `flex: 0` — in React Native that is flexGrow:0 + flexShrink:0 + flexBasis:0, and a
  // zero basis collapses the tab to zero WIDTH inside the horizontal ScrollView. On web the
  // element then has a testID, a role and its label text, and is still `hidden` to Playwright.
  // Measured on feature 062's first web run; `Tabs` had no app consumer before, so nothing had
  // ever laid `scrollable` out in a browser. Grow/shrink off, basis auto = size to content.
  tabScrollable: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  // Secondary only: the filled pill is drawn behind the label rather than over it.
  tabAboveIndicator: { zIndex: 1 },
  tabPressed:    { opacity: 0.8 },
})
