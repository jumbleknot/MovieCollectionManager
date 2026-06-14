/**
 * MCM Design System — MD3 Snackbar
 *
 * Shows brief messages at the bottom of the screen.
 * Auto-dismisses after `duration` ms (default 4000).
 * Optional single action button.
 *
 * Position: bottom center, 8dp from bottom edge on mobile.
 *
 * Usage (hook):
 *   const { showSnackbar, SnackbarHost } = useSnackbar()
 *   // In JSX: <SnackbarHost />
 *   // Trigger: showSnackbar({ message: 'Movie added to collection', action: { label: 'Undo', onPress: ... } })
 */

import React, { useCallback, useRef, useState, useEffect } from 'react'
import { Animated, Platform } from 'react-native'
import { Stack, Text, useTheme } from '@tamagui/core'
import { XStack } from '@tamagui/stacks'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SnackbarConfig {
  message:   string
  action?:   { label: string; onPress: () => void }
  duration?: number   // ms; default 4000
}

export interface SnackbarProps extends SnackbarConfig {
  visible:   boolean
  onDismiss: () => void
}

// ─── Snackbar component ───────────────────────────────────────────────────────

export const Snackbar = React.memo<SnackbarProps>(function Snackbar({
  visible,
  message,
  action,
  duration = 4000,
  onDismiss,
}) {
  const theme   = useTheme()
  const slideY  = useRef(new Animated.Value(100)).current
  const opacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideY,  { toValue: 0,   duration: 300, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1,   duration: 300, useNativeDriver: true }),
      ]).start()
      const t = setTimeout(() => {
        Animated.parallel([
          Animated.timing(slideY,  { toValue: 100, duration: 200, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0,   duration: 200, useNativeDriver: true }),
        ]).start(() => onDismiss())
      }, duration)
      return () => clearTimeout(t)
    }
  }, [visible])

  if (!visible) return null

  return (
    <Animated.View
      style={{
        position:        'absolute',
        bottom:          Platform.OS === 'ios' ? 40 : 24,
        left:            16,
        right:           16,
        transform:       [{ translateY: slideY }],
        opacity,
        zIndex:          500,
        borderRadius:    4,
        overflow:        'hidden',
      }}
    >
      <XStack
        backgroundColor={theme.inverseSurface?.val}
        borderRadius={4}
        padding={16}
        alignItems="center"
        gap={8}
        // MD3 elevation 3
        shadowColor={theme.shadow?.val}
        shadowOffset={{ width: 0, height: 2 }}
        shadowOpacity={0.2}
        shadowRadius={6}
        elevation={6}
      >
        <Text
          flex={1}
          fontFamily="$body"
          fontSize={14}
          letterSpacing={0.25}
          color={theme.inverseOnSurface?.val}
          numberOfLines={2}
        >
          {message}
        </Text>

        {action && (
          <Stack
            paddingLeft={8}
            onPress={() => { action.onPress(); onDismiss() }}
            cursor="pointer"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text
              fontFamily="$body"
              fontSize={14}
              fontWeight="500"
              letterSpacing={0.1}
              color={theme.inversePrimary?.val}
            >
              {action.label}
            </Text>
          </Stack>
        )}
      </XStack>
    </Animated.View>
  )
})

Snackbar.displayName = 'MCM.Snackbar'

// ─── useSnackbar hook ─────────────────────────────────────────────────────────

export function useSnackbar() {
  const [config,  setConfig]  = useState<SnackbarConfig | null>(null)
  const [visible, setVisible] = useState(false)

  const showSnackbar = useCallback((c: SnackbarConfig) => {
    setConfig(c)
    setVisible(true)
  }, [])

  const dismiss = useCallback(() => {
    setVisible(false)
    setTimeout(() => setConfig(null), 300)
  }, [])

  const SnackbarHost = useCallback(() => (
    config
      ? <Snackbar {...config} visible={visible} onDismiss={dismiss} />
      : null
  ), [config, visible, dismiss])

  return { showSnackbar, dismiss, SnackbarHost }
}
