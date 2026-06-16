/**
 * MCM Design System — Chat Bubble
 *
 * Renders a single message in the assistant conversation.
 *
 * Sender:
 *   user      — right-aligned, primaryContainer bg
 *   assistant — left-aligned, surface2 bg + robot avatar
 *   system    — centered, surfaceVariant bg, smaller text
 *
 * Special states:
 *   thinking  — shows animated typing dots in the assistant bubble
 *   error     — errorContainer bg with error icon
 *   approval  — HITL approval card (approve/reject buttons)
 *
 * Generative UI:
 *   Pass `children` to render any generative UI component inline
 *   (MovieCard, CollectionCard, etc.) inside the bubble.
 */

import React, { useRef, useEffect } from 'react'
import { Animated } from 'react-native'
import { Stack, Text, useTheme } from '@tamagui/core'
import { XStack, YStack } from '@tamagui/stacks'
import { AssistantAvatar } from './AssistantAvatar'

export type BubbleSender = 'user' | 'assistant' | 'system'

export interface ChatBubbleProps {
  sender:      BubbleSender
  message?:    string
  timestamp?:  Date
  thinking?:   boolean    // assistant is "typing"
  error?:      boolean
  children?:   React.ReactNode  // generative UI content
}

function TypingDots({ color }: { color: string }) {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ]

  useEffect(() => {
    const anims = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 200),
          Animated.timing(d, { toValue: -6, duration: 300, useNativeDriver: true }),
          Animated.timing(d, { toValue: 0,  duration: 300, useNativeDriver: true }),
          Animated.delay(300),
        ])
      )
    )
    anims.forEach(a => a.start())
    return () => anims.forEach(a => a.stop())
  }, [])

  return (
    <XStack gap={4} alignItems="center" height={20} paddingVertical={4}>
      {dots.map((d, i) => (
        <Animated.View
          key={i}
          style={{
            width:           6,
            height:          6,
            borderRadius:    3,
            backgroundColor: color,
            transform:       [{ translateY: d }],
          }}
        />
      ))}
    </XStack>
  )
}

// ─── Timestamp ────────────────────────────────────────────────────────────────

function Timestamp({ date }: { date: Date }) {
  const theme = useTheme()
  const h = date.getHours().toString().padStart(2, '0')
  const m = date.getMinutes().toString().padStart(2, '0')
  return (
    <Text
      fontFamily="$body"
      fontSize={11}
      letterSpacing={0.5}
      color={theme.onSurfaceVariant?.val}
      marginTop={4}
    >
      {h}:{m}
    </Text>
  )
}

// ─── Main ChatBubble ──────────────────────────────────────────────────────────

export const ChatBubble = React.memo<ChatBubbleProps>(function ChatBubble({
  sender,
  message,
  timestamp,
  thinking = false,
  error    = false,
  children,
}) {
  const theme = useTheme()

  // System message — centered pill
  if (sender === 'system') {
    return (
      <Stack alignItems="center" marginVertical={8} paddingHorizontal={32}>
        <Stack
          backgroundColor={theme.surfaceVariant?.val}
          borderRadius={16}
          paddingHorizontal={16}
          paddingVertical={8}
        >
          <Text
            fontFamily="$body"
            fontSize={12}
            letterSpacing={0.4}
            color={theme.onSurfaceVariant?.val}
            textAlign="center"
          >
            {message}
          </Text>
        </Stack>
      </Stack>
    )
  }

  const isUser      = sender === 'user'
  const isAssistant = sender === 'assistant'

  // Bubble colours
  // Assistant bubbles use surface3 (a step lighter than the dock panel's surface1) plus a
  // hairline outline so they read clearly against the panel in both light and dark without
  // washing out the text inside (feature 015 polish).
  const bubbleBg = error
    ? theme.errorContainer?.val
    : isUser
    ? theme.primaryContainer?.val
    : theme.surface3?.val

  const textColor = error
    ? theme.onErrorContainer?.val
    : isUser
    ? theme.onPrimaryContainer?.val
    : theme.onSurface?.val

  const dotColor = error ? theme.onErrorContainer?.val : theme.onSurfaceVariant?.val

  return (
    <XStack
      flexDirection={isUser ? 'row-reverse' : 'row'}
      alignItems="flex-end"
      gap={8}
      marginVertical={4}
      paddingHorizontal={16}
    >
      {/* Assistant avatar */}
      {isAssistant && (
        <Stack flexShrink={0} marginBottom={2}>
          <AssistantAvatar size="sm" thinking={thinking} />
        </Stack>
      )}

      {/* Bubble */}
      <YStack maxWidth="72%" alignItems={isUser ? 'flex-end' : 'flex-start'}>
        <Stack
          backgroundColor={bubbleBg}
          borderWidth={isAssistant && !error ? 1 : 0}
          borderColor={theme.outlineVariant?.val}
          borderRadius={20}
          borderBottomRightRadius={isUser ? 4 : 20}
          borderBottomLeftRadius={isAssistant ? 4 : 20}
          paddingHorizontal={16}
          paddingVertical={12}
          // MD3 elevation 1 on assistant bubble
          shadowColor={isAssistant ? theme.shadow?.val : undefined}
          shadowOffset={isAssistant ? { width: 0, height: 1 } : undefined}
          shadowOpacity={isAssistant ? 0.08 : 0}
          shadowRadius={isAssistant ? 2 : 0}
          style={{ elevation: isAssistant ? 1 : 0 }}
        >
          {/* Typing indicator (replaces content) */}
          {thinking && !message && !children ? (
            <TypingDots color={dotColor} />
          ) : (
            <>
              {/* Text message */}
              {message && (
                <Text
                  fontFamily="$body"
                  fontSize={15}
                  lineHeight={22}
                  letterSpacing={0.25}
                  color={textColor}
                >
                  {message}
                </Text>
              )}

              {/* Generative UI content (MovieCard, CollectionCard, etc.) */}
              {children && (
                <Stack marginTop={message ? 12 : 0}>
                  {children}
                </Stack>
              )}
            </>
          )}
        </Stack>

        {/* Timestamp */}
        {timestamp && !thinking && (
          <Stack paddingHorizontal={4}>
            <Timestamp date={timestamp} />
          </Stack>
        )}
      </YStack>
    </XStack>
  )
})

ChatBubble.displayName = 'MCM.ChatBubble'

// ─── HITL Approval Bubble ─────────────────────────────────────────────────────

export interface ApprovalBubbleProps {
  title:       string
  description: string
  onApprove:   () => void
  onReject:    () => void
  loading?:    boolean
  approved?:   boolean
  rejected?:   boolean
}

export const ApprovalBubble = React.memo<ApprovalBubbleProps>(function ApprovalBubble({
  title,
  description,
  onApprove,
  onReject,
  loading   = false,
  approved  = false,
  rejected  = false,
}) {
  const theme = useTheme()
  const done  = approved || rejected

  return (
    <XStack alignItems="flex-end" gap={8} marginVertical={4} paddingHorizontal={16}>
      <Stack flexShrink={0} marginBottom={2}>
        <AssistantAvatar size="sm" />
      </Stack>

      <YStack
        maxWidth="85%"
        backgroundColor={theme.surface3?.val}
        borderRadius={20}
        borderBottomLeftRadius={4}
        overflow="hidden"
        shadowColor={theme.shadow?.val}
        shadowOffset={{ width: 0, height: 1 }}
        shadowOpacity={0.12}
        shadowRadius={4}
        elevation={2}
      >
        {/* Header */}
        <XStack
          backgroundColor={theme.primaryContainer?.val}
          paddingHorizontal={16}
          paddingVertical={12}
          alignItems="center"
          gap={8}
        >
          <Text fontSize={16} lineHeight={16}>⚡</Text>
          <Text
            fontFamily="$heading"
            fontSize={15}
            fontWeight="500"
            color={theme.onPrimaryContainer?.val}
            flex={1}
          >
            {title}
          </Text>
        </XStack>

        {/* Description */}
        <Stack paddingHorizontal={16} paddingVertical={12}>
          <Text
            fontFamily="$body"
            fontSize={14}
            lineHeight={20}
            letterSpacing={0.25}
            color={theme.onSurface?.val}
          >
            {description}
          </Text>
        </Stack>

        {/* Actions */}
        {!done ? (
          <XStack
            paddingHorizontal={12}
            paddingBottom={12}
            gap={8}
            justifyContent="flex-end"
          >
            <Stack
              paddingHorizontal={16}
              paddingVertical={10}
              borderRadius={20}
              borderWidth={1}
              borderColor={theme.outline?.val}
              cursor={loading ? 'not-allowed' : 'pointer'}
              opacity={loading ? 0.5 : 1}
              onPress={loading ? undefined : onReject}
              animation="quick"
              pressStyle={{ opacity: 0.8 }}
            >
              <Text fontFamily="$body" fontSize={14} fontWeight="500" letterSpacing={0.1} color={theme.onSurface?.val}>
                Reject
              </Text>
            </Stack>
            <Stack
              paddingHorizontal={16}
              paddingVertical={10}
              borderRadius={20}
              backgroundColor={theme.primary?.val}
              cursor={loading ? 'not-allowed' : 'pointer'}
              opacity={loading ? 0.7 : 1}
              onPress={loading ? undefined : onApprove}
              animation="quick"
              pressStyle={{ opacity: 0.8 }}
            >
              <Text fontFamily="$body" fontSize={14} fontWeight="500" letterSpacing={0.1} color={theme.onPrimary?.val}>
                {loading ? 'Applying…' : 'Approve'}
              </Text>
            </Stack>
          </XStack>
        ) : (
          <Stack paddingHorizontal={16} paddingBottom={12}>
            <Text
              fontFamily="$body"
              fontSize={13}
              color={approved ? theme.primary?.val : theme.onSurfaceVariant?.val}
            >
              {approved ? '✓ Approved and applied' : '✕ Rejected'}
            </Text>
          </Stack>
        )}
      </YStack>
    </XStack>
  )
})

ApprovalBubble.displayName = 'MCM.ApprovalBubble'
