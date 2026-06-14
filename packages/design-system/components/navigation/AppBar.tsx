/**
 * MCM Design System — MD3 Top App Bar
 *
 * Variants:
 *   centerAligned — title centered, leading nav icon, trailing actions
 *   small         — title left-aligned (default for most screens)
 *   medium        — larger title, collapses to small on scroll
 *   large         — very large title, collapses to small on scroll
 *
 * Scroll behavior:
 *   Pass `scrollY` (Animated.Value) to enable the collapsing/on-scroll elevation.
 *
 * MD3 heights:
 *   small / centerAligned: 64dp
 *   medium: 112dp (collapsed: 64dp)
 *   large:  152dp (collapsed: 64dp)
 */

import React, { useRef } from 'react'
import {
  Animated,
  StatusBar,
  Platform,
  type ViewStyle,
} from 'react-native'
import { Stack, XStack, YStack, Text, useTheme } from 'tamagui'

export type AppBarVariant = 'centerAligned' | 'small' | 'medium' | 'large'

export interface AppBarProps {
  variant?:        AppBarVariant
  title:           string
  subtitle?:       string
  leading?:        React.ReactNode  // nav icon (hamburger, back arrow)
  trailing?:       React.ReactNode  // action icons (max 3 per MD3)
  scrollY?:        Animated.Value   // for scroll-based collapse
  transparent?:    boolean          // fully transparent bg (hero screens)
  containerStyle?: ViewStyle
}

const HEIGHTS = {
  centerAligned: 64,
  small:         64,
  medium:        112,
  large:         152,
} as const

const COLLAPSED_H = 64

export const AppBar = React.memo<AppBarProps>(function AppBar({
  variant       = 'small',
  title,
  subtitle,
  leading,
  trailing,
  scrollY,
  transparent   = false,
  containerStyle,
}) {
  const theme     = useTheme()
  const expandedH = HEIGHTS[variant]
  const isLarge   = variant === 'medium' || variant === 'large'

  // ── Scroll-driven animations ─────────────────────────────────────────────
  // As user scrolls down:
  //   - height collapses from expandedH → COLLAPSED_H
  //   - elevation increases 0 → 2
  //   - large title fades out / small title fades in

  const heightAnim = scrollY
    ? scrollY.interpolate({
        inputRange:  [0, expandedH - COLLAPSED_H],
        outputRange: [expandedH, COLLAPSED_H],
        extrapolate: 'clamp',
      })
    : new Animated.Value(expandedH)

  const elevationAnim = scrollY
    ? scrollY.interpolate({
        inputRange:  [0, 40],
        outputRange: [0, 3],
        extrapolate: 'clamp',
      })
    : new Animated.Value(0)

  const largeTitleOpacity = scrollY
    ? scrollY.interpolate({
        inputRange:  [0, 40],
        outputRange: [1, 0],
        extrapolate: 'clamp',
      })
    : new Animated.Value(1)

  const smallTitleOpacity = scrollY
    ? scrollY.interpolate({
        inputRange:  [20, 60],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      })
    : new Animated.Value(isLarge ? 0 : 1)

  const bgColor = transparent ? 'transparent' : theme.surface?.val

  const statusBarHeight = Platform.OS === 'ios' ? 44 : StatusBar.currentHeight ?? 24

  return (
    <Animated.View
      style={[
        {
          backgroundColor: bgColor,
          paddingTop:      statusBarHeight,
          height:          isLarge
            ? Animated.add(heightAnim, statusBarHeight)
            : expandedH + statusBarHeight,
          zIndex:          800,
          width:           '100%',
        },
        // Shadow driven by scroll
        {
          shadowColor:   theme.shadow?.val,
          shadowOffset:  { width: 0, height: 1 },
          shadowOpacity: scrollY ? elevationAnim.interpolate({ inputRange: [0, 3], outputRange: [0, 0.16] }) as any : 0,
          shadowRadius:  4,
          elevation:     scrollY ? elevationAnim as any : 0,
        },
        containerStyle,
      ]}
    >
      {/* ── Top row — 64dp, always visible ────────────────────────────── */}
      <XStack
        height={64}
        alignItems="center"
        paddingHorizontal={4}
      >
        {/* Leading nav icon */}
        {leading ? (
          <Stack width={48} height={48} alignItems="center" justifyContent="center">
            {leading}
          </Stack>
        ) : (
          <Stack width={16} />
        )}

        {/* Title in top row — always shown for small/centerAligned;
            fades in on scroll for medium/large */}
        <Animated.Text
          style={{
            flex:          1,
            fontFamily:    'Outfit, system-ui',
            fontSize:      22,
            fontWeight:    '400',
            letterSpacing: 0,
            color:         theme.onSurface?.val,
            textAlign:     variant === 'centerAligned' ? 'center' : 'left',
            opacity:       isLarge ? smallTitleOpacity : 1,
            paddingHorizontal: 4,
          }}
          numberOfLines={1}
        >
          {title}
        </Animated.Text>

        {/* Trailing actions */}
        <XStack alignItems="center" gap={4}>
          {trailing}
        </XStack>
      </XStack>

      {/* ── Expanded title — medium / large only ──────────────────────── */}
      {isLarge && (
        <Animated.View
          style={{
            paddingHorizontal: 16,
            paddingBottom:     28,
            opacity:           largeTitleOpacity,
            justifyContent:    'flex-end',
            flex:              1,
          }}
        >
          <Text
            fontFamily="$heading"
            fontSize={variant === 'large' ? 32 : 28}
            fontWeight="400"
            lineHeight={variant === 'large' ? 40 : 36}
            color={theme.onSurface?.val}
            numberOfLines={2}
          >
            {title}
          </Text>
          {subtitle && (
            <Text
              fontFamily="$body"
              fontSize={14}
              letterSpacing={0.25}
              color={theme.onSurfaceVariant?.val}
              marginTop={4}
            >
              {subtitle}
            </Text>
          )}
        </Animated.View>
      )}
    </Animated.View>
  )
})

AppBar.displayName = 'MCM.AppBar'
