/**
 * MCM Design System — MD3 Card
 *
 * Variants (MD3):
 *   elevated — white/surface bg + shadow (elevation 1 → 2 on hover)
 *   filled   — surfaceVariant bg, no shadow
 *   outlined — transparent bg + border + no shadow
 *
 * The Card is a pressable container by default. Pass onPress={undefined}
 * for a non-interactive card.
 *
 * Sub-components:
 *   Card.Header   — title + subtitle row with optional leading media/avatar
 *   Card.Media    — full-width image area (aspect ratio controlled by height)
 *   Card.Content  — padded content area
 *   Card.Actions  — trailing button row (right-aligned)
 */

import React from 'react'
import { View, useTheme, type ViewProps } from '@tamagui/core'
import { Text } from '../primitives/Text'
import { YStack, XStack } from '@tamagui/stacks'
import { Image, type ImageSourcePropType } from 'react-native'

export type CardVariant = 'elevated' | 'filled' | 'outlined'

export interface CardProps extends Omit<ViewProps, 'children'> {
  variant?:  CardVariant
  onPress?:  () => void
  disabled?: boolean
  children:  React.ReactNode
}

// ─── Root Card ───────────────────────────────────────────────────────────────

export const Card = React.forwardRef<any, CardProps>(function Card(
  { variant = 'elevated', onPress, disabled = false, children, ...rest },
  ref,
) {
  const theme = useTheme()

  let bg:      string
  let border:  string | undefined
  let shadowProps = {}

  switch (variant) {
    case 'elevated':
      bg = theme.surface1?.val
      shadowProps = {
        shadowColor:   theme.shadow?.val,
        shadowOffset:  { width: 0, height: 1 },
        shadowOpacity: 0.12,
        shadowRadius:  2,
        elevation:     1,
      }
      break
    case 'filled':
      bg     = theme.surfaceVariant?.val
      break
    case 'outlined':
      bg     = theme.surface?.val
      border = theme.outlineVariant?.val
      break
  }

  const interactive = !!onPress && !disabled

  return (
    <YStack
      ref={ref}
      accessible={interactive}
      accessibilityRole={interactive ? 'button' : undefined}
      accessibilityState={interactive ? { disabled } : undefined}
      // Tamagui 3: each state is a clause on the property it modifies (were pressStyle / hoverStyle /
      // focusVisibleStyle). The clauses exist only when the card is interactive, as before; an
      // elevated card also tints to surface2 on hover/press, the other variants keep their fill.
      backgroundColor={interactive && variant === 'elevated'
        ? { default: bg, hover: theme.surface2?.val, press: theme.surface2?.val }
        : bg}
      borderRadius={12}          // MD3 medium shape
      borderWidth={border ? 1 : 0}
      borderColor={border}
      overflow="hidden"
      cursor={interactive ? 'pointer' : 'default'}
      opacity={interactive
        ? { default: 1, hover: 0.98, press: 0.94 }
        : disabled ? 0.38 : 1}
      onPress={interactive ? onPress : undefined}
      // `focus-visible` (never `focus`) so an interactive card's ring shows for KEYBOARD focus
      // only — a mouse click otherwise leaves a persistent :focus outline (feature 015/017 fix).
      outlineStyle={interactive ? 'none focus-visible:solid' : undefined}
      outlineWidth={interactive ? 'focus-visible:3px' : undefined}
      outlineColor={interactive ? 'focus-visible:primary' : undefined}
      outlineOffset={interactive ? 'focus-visible:2px' : undefined}
      {...shadowProps}
      {...rest}
    >
      {children}
    </YStack>
  )
})

Card.displayName = 'MCM.Card'

// ─── Card.Header ─────────────────────────────────────────────────────────────

export interface CardHeaderProps {
  title:        string
  subtitle?:    string
  leading?:     React.ReactNode   // avatar, icon, thumbnail
  trailing?:    React.ReactNode   // overflow menu, action button
}

function CardHeader({ title, subtitle, leading, trailing }: CardHeaderProps) {
  const theme = useTheme()
  return (
    <XStack
      paddingHorizontal={16}
      paddingTop={16}
      paddingBottom={subtitle ? 8 : 16}
      alignItems="center"
      gap={16}
    >
      {leading && (
        <View width={40} height={40} borderRadius={20} overflow="hidden" flexShrink={0}>
          {leading}
        </View>
      )}
      <YStack flex={1}>
        <Text
          fontFamily="heading"
          fontSize={16}
          fontWeight="500"
          letterSpacing={0}
          color={theme.onSurface?.val}
          numberOfLines={2}
        >
          {title}
        </Text>
        {subtitle && (
          <Text
            fontFamily="body"
            fontSize={14}
            letterSpacing={0.25}
            color={theme.onSurfaceVariant?.val}
            numberOfLines={2}
            marginTop={2}
          >
            {subtitle}
          </Text>
        )}
      </YStack>
      {trailing && <View flexShrink={0}>{trailing}</View>}
    </XStack>
  )
}

CardHeader.displayName = 'MCM.Card.Header'

// ─── Card.Media ──────────────────────────────────────────────────────────────

export interface CardMediaProps {
  source:       ImageSourcePropType
  height?:      number      // default 194 (MD3 recommendation)
  alt?:         string
}

function CardMedia({ source, height = 194, alt }: CardMediaProps) {
  return (
    <View width="100%" height={height} overflow="hidden">
      <Image
        source={source}
        style={{ width: '100%', height: '100%' }}
        resizeMode="cover"
        accessibilityLabel={alt}
      />
    </View>
  )
}

CardMedia.displayName = 'MCM.Card.Media'

// ─── Card.Content ────────────────────────────────────────────────────────────

export interface CardContentProps {
  children: React.ReactNode
  padding?: number
}

function CardContent({ children, padding = 16 }: CardContentProps) {
  return (
    <YStack padding={padding} gap={8}>
      {children}
    </YStack>
  )
}

CardContent.displayName = 'MCM.Card.Content'

// ─── Card.Actions ────────────────────────────────────────────────────────────

export interface CardActionsProps {
  children:  React.ReactNode
  alignment?: 'start' | 'end' | 'center' | 'spread'
}

function CardActions({ children, alignment = 'end' }: CardActionsProps) {
  const justifyMap = {
    start:  'flex-start',
    end:    'flex-end',
    center: 'center',
    spread: 'space-between',
  } as const

  return (
    <XStack
      paddingHorizontal={8}
      paddingBottom={8}
      gap={8}
      justifyContent={justifyMap[alignment]}
      flexWrap="wrap"
    >
      {children}
    </XStack>
  )
}

CardActions.displayName = 'MCM.Card.Actions'

// ─── Attach sub-components ───────────────────────────────────────────────────

;(Card as any).Header  = CardHeader
;(Card as any).Media   = CardMedia
;(Card as any).Content = CardContent
;(Card as any).Actions = CardActions

// Re-export sub-types for consumers
export { CardHeader, CardMedia, CardContent, CardActions }
