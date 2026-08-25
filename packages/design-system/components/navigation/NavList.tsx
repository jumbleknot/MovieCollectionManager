/**
 * NavList — a vertical navigation list, MD3 navigation-drawer item shape.
 *
 * Why this exists rather than reusing `Tabs`: a horizontal tab row cannot hold more than about
 * three full-length labels on a phone. Feature 062's settings sub-navigation measured 449px of
 * tabs against a 320px viewport, so the last entry (Admin) was off-screen behind a horizontal
 * scroll with no affordance indicating it (backlog item #240).
 *
 * The shape also removes a whole class of bug by construction. `Tabs` draws its selection as a
 * separate absolutely-positioned pill that slides between tabs, while hover is a background on
 * the tab cell — two elements with two geometries, so the selected shape and the hover shape
 * disagree and cannot be made to agree by tuning. A drawer item is ONE rounded row: selection
 * fills it, hover paints a state layer over the same row, and they cannot diverge.
 *
 * Selection colours are the MD3 container pair (`secondaryContainer` / `onSecondaryContainer`),
 * matching this package's NavigationBar active indicator.
 *
 * WEB-SELECTOR NOTE: each row's `testID` sits on a plain React Native `Pressable`, not on the
 * Tamagui `View` inside it. A Tamagui component does not forward `testID` to `data-testid` on
 * React Native Web, so a testID placed there is silently unreachable from Playwright — the same
 * limitation `Tabs` and `Card` document. The RN host node maps `testID` → `data-testid` on web
 * and `id:` on native, so Playwright, Maestro and jest all locate the same element.
 */

import React from 'react'
import { Pressable, StyleSheet } from 'react-native'
import { View, Text, useTheme } from '@tamagui/core'
import { withAlpha, stateLayer } from '../../tokens/with-alpha'

export interface NavListItem {
  key: string
  label: string
  icon?: React.ReactNode
  /** Stable external-contract selector; rendered on a React Native host node. */
  testID?: string
}

export interface NavListProps {
  items: NavListItem[]
  activeKey: string
  onSelect: (key: string) => void
  /** Compact rows (40dp rather than 56dp) for narrow viewports where vertical space is scarce. */
  compact?: boolean
  /** Accessible name for the list as a whole, announced by assistive technology. */
  accessibilityLabel?: string
}

export const NavList = React.memo<NavListProps>(function NavList({
  items,
  activeKey,
  onSelect,
  compact = false,
  accessibilityLabel = 'Sections',
}) {
  const theme = useTheme()

  // The state layer is drawn from `onSurface` at an MD3 hover opacity rather than a hardcoded
  // hex suffix. See tokens/with-alpha.ts for why the `hex + '14'` form fails silently.
  const hoverLayer = withAlpha(theme.onSurface?.val as string | undefined, stateLayer.hover)
  const pressLayer = withAlpha(theme.onSurface?.val as string | undefined, stateLayer.press)

  return (
    <View
      accessibilityRole="menu"
      aria-label={accessibilityLabel}
      gap={4}
      width="100%"
    >
      {items.map((item) => {
        const isActive = item.key === activeKey
        return (
          <Pressable
            key={item.key}
            testID={item.testID}
            accessibilityRole="menuitem"
            accessibilityState={{ selected: isActive }}
            aria-current={isActive ? 'page' : undefined}
            onPress={() => onSelect(item.key)}
            style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
          >
            <View
              flexDirection="row"
              alignItems="center"
              gap={12}
              height={compact ? 40 : 56}
              paddingHorizontal={compact ? 16 : 24}
              // ONE shape for both states — this is the property the component exists for.
              borderRadius={28}
              backgroundColor={isActive ? theme.secondaryContainer?.val : 'transparent'}
              hoverStyle={isActive ? undefined : { backgroundColor: hoverLayer }}
              pressStyle={isActive ? undefined : { backgroundColor: pressLayer }}
              cursor="pointer"
            >
              {item.icon}
              <Text
                fontFamily="$body"
                fontSize={14}
                fontWeight={isActive ? '700' : '500'}
                letterSpacing={0.1}
                color={isActive ? theme.onSecondaryContainer?.val : theme.onSurfaceVariant?.val}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </View>
          </Pressable>
        )
      })}
    </View>
  )
})

NavList.displayName = 'MCM.NavList'

const styles = StyleSheet.create({
  row: { width: '100%' },
  rowPressed: { opacity: 0.9 },
})
