/**
 * MCM Design System — Assistant Panel
 *
 * The full conversational UI shell for the movie assistant.
 * This wraps the CopilotKit (<CopilotPopup> / <CopilotSidebar>) conversation
 * with MCM-branded styling.
 *
 * Architecture note (from MCM constitution):
 *   - The actual AG-UI / CopilotKit runtime is managed by the BFF.
 *   - This component provides the VISUAL SHELL only.
 *   - Wire it up to @copilotkit/react-native in mcm-app.
 *
 * Anatomy:
 *   - Header  — Grumpy Robot avatar + "Movie Assistant" title + close button
 *   - Message list — scrollable, with ChatBubble components
 *   - Input area — TextField + send button + attachment affordance
 *
 * Usage with CopilotKit:
 *   // In mcm-app, replace CopilotPopup's renderInput/renderMessage with these
 *   // styled components from the design system.
 *
 *   import { AssistantPanel } from '@mcm/design-system'
 *   <CopilotPopup
 *     labels={{ title: 'Movie Assistant', placeholder: 'Ask about your movies…' }}
 *     // Custom render props from CopilotKit
 *   />
 */

import React, { useRef, useState, useCallback } from 'react'
import {
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TextInput,
} from 'react-native'
import { Stack, XStack, YStack, Text, useTheme } from 'tamagui'
import { AssistantAvatar }               from './AssistantAvatar'
import { ChatBubble, ApprovalBubble }    from './ChatBubble'
import type { ChatBubbleProps }          from './ChatBubble'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Message {
  id:         string
  sender:     'user' | 'assistant' | 'system'
  text?:      string
  timestamp:  Date
  thinking?:  boolean
  error?:     boolean
  children?:  React.ReactNode  // generative UI
}

export interface AssistantPanelProps {
  messages:        Message[]
  onSend:          (text: string) => void
  onClose?:        () => void
  isThinking?:     boolean   // global thinking state (typing indicator)
  placeholder?:    string
  headerSubtitle?: string
  style?:          object
}

// ─── Panel Header ─────────────────────────────────────────────────────────────

function PanelHeader({
  onClose,
  isThinking,
  subtitle,
}: {
  onClose?:   () => void
  isThinking?: boolean
  subtitle?:  string
}) {
  const theme = useTheme()

  return (
    <XStack
      height={64}
      alignItems="center"
      paddingHorizontal={16}
      gap={12}
      backgroundColor={theme.surface3?.val}
      // Subtle bottom border
      borderBottomWidth={1}
      borderBottomColor={theme.outlineVariant?.val}
    >
      {/* Grumpy Robot Avatar */}
      <AssistantAvatar size="md" thinking={isThinking} />

      {/* Title / subtitle */}
      <YStack flex={1}>
        <Text
          fontFamily="$heading"
          fontSize={18}
          fontWeight="500"
          color={theme.onSurface?.val}
        >
          Movie Assistant
        </Text>
        {subtitle || isThinking ? (
          <Text
            fontFamily="$body"
            fontSize={12}
            letterSpacing={0.4}
            color={isThinking ? theme.primary?.val : theme.onSurfaceVariant?.val}
          >
            {isThinking ? 'Thinking…' : (subtitle ?? 'Ask me anything about your movies')}
          </Text>
        ) : null}
      </YStack>

      {/* Close button */}
      {onClose && (
        <Stack
          width={40}
          height={40}
          borderRadius={20}
          alignItems="center"
          justifyContent="center"
          cursor="pointer"
          onPress={onClose}
          animation="quick"
          pressStyle={{ backgroundColor: theme.surfaceVariant?.val }}
          hoverStyle={{ backgroundColor: theme.surface1?.val }}
          accessible
          accessibilityLabel="Close assistant"
          accessibilityRole="button"
        >
          <Text fontSize={20} color={theme.onSurfaceVariant?.val} lineHeight={20}>✕</Text>
        </Stack>
      )}
    </XStack>
  )
}

// ─── Suggested prompts ────────────────────────────────────────────────────────

const SUGGESTED_PROMPTS = [
  'What movies do I have?',
  'Add a movie to my collection',
  'Show my wishlist',
  'Find movies by a director',
]

function SuggestedPrompts({ onSelect }: { onSelect: (prompt: string) => void }) {
  const theme = useTheme()
  return (
    <YStack padding={16} gap={8} alignItems="center">
      <AssistantAvatar size="xl" />
      <Text
        fontFamily="$heading"
        fontSize={20}
        fontWeight="400"
        color={theme.onSurface?.val}
        textAlign="center"
        marginTop={16}
      >
        How can I help with{'\n'}your movie collection?
      </Text>
      <YStack gap={8} width="100%" marginTop={8}>
        {SUGGESTED_PROMPTS.map((prompt) => (
          <Stack
            key={prompt}
            backgroundColor={theme.surface2?.val}
            borderRadius={12}
            borderWidth={1}
            borderColor={theme.outlineVariant?.val}
            paddingHorizontal={16}
            paddingVertical={12}
            cursor="pointer"
            animation="quick"
            onPress={() => onSelect(prompt)}
            pressStyle={{ backgroundColor: theme.surface3?.val }}
            hoverStyle={{ borderColor: theme.outline?.val }}
          >
            <Text
              fontFamily="$body"
              fontSize={14}
              letterSpacing={0.25}
              color={theme.onSurface?.val}
            >
              {prompt}
            </Text>
          </Stack>
        ))}
      </YStack>
    </YStack>
  )
}

// ─── Input bar ────────────────────────────────────────────────────────────────

function InputBar({
  onSend,
  placeholder = 'Ask about your movies…',
  disabled    = false,
}: {
  onSend:       (text: string) => void
  placeholder?: string
  disabled?:    boolean
}) {
  const theme   = useTheme()
  const [text, setText] = useState('')

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
  }, [text, disabled, onSend])

  const canSend = text.trim().length > 0 && !disabled

  return (
    <XStack
      paddingHorizontal={16}
      paddingVertical={12}
      gap={8}
      alignItems="flex-end"
      backgroundColor={theme.surface?.val}
      borderTopWidth={1}
      borderTopColor={theme.outlineVariant?.val}
    >
      {/* Text input */}
      <Stack
        flex={1}
        backgroundColor={theme.surfaceVariant?.val}
        borderRadius={24}
        paddingHorizontal={16}
        paddingVertical={10}
        minHeight={44}
        maxHeight={120}
        justifyContent="center"
      >
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={theme.onSurfaceVariant?.val}
          multiline
          returnKeyType="send"
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          editable={!disabled}
          style={{
            fontFamily:    'Inter, system-ui',
            fontSize:      15,
            lineHeight:    22,
            color:         theme.onSurface?.val,
            padding:       0,
            margin:        0,
            outlineStyle:  'none',
          } as any}
        />
      </Stack>

      {/* Send button */}
      <Stack
        width={44}
        height={44}
        borderRadius={22}
        backgroundColor={canSend ? theme.primary?.val : theme.surfaceVariant?.val}
        alignItems="center"
        justifyContent="center"
        cursor={canSend ? 'pointer' : 'default'}
        onPress={handleSend}
        animation="quick"
        pressStyle={canSend ? { opacity: 0.8, scale: 0.96 } : undefined}
        accessible
        accessibilityLabel="Send message"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSend }}
      >
        <Text
          fontSize={18}
          lineHeight={18}
          color={canSend ? theme.onPrimary?.val : theme.onSurfaceVariant?.val}
        >
          ↑
        </Text>
      </Stack>
    </XStack>
  )
}

// ─── Main AssistantPanel ──────────────────────────────────────────────────────

export const AssistantPanel = React.memo<AssistantPanelProps>(function AssistantPanel({
  messages,
  onSend,
  onClose,
  isThinking    = false,
  placeholder,
  headerSubtitle,
  style,
}) {
  const theme       = useTheme()
  const scrollRef   = useRef<ScrollView>(null)
  const isEmpty     = messages.length === 0 && !isThinking

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}
    >
      <YStack
        flex={1}
        backgroundColor={theme.background?.val}
        style={style}
      >
        {/* Header */}
        <PanelHeader
          onClose={onClose}
          isThinking={isThinking}
          subtitle={headerSubtitle}
        />

        {/* Message area */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: true })
          }
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingVertical: 8 }}
        >
          {isEmpty ? (
            <SuggestedPrompts onSelect={onSend} />
          ) : (
            <>
              {messages.map((msg) => (
                <ChatBubble
                  key={msg.id}
                  sender={msg.sender}
                  message={msg.text}
                  timestamp={msg.timestamp}
                  thinking={msg.thinking}
                  error={msg.error}
                >
                  {msg.children}
                </ChatBubble>
              ))}

              {/* Typing indicator (shows while agent is processing) */}
              {isThinking && (
                <ChatBubble
                  sender="assistant"
                  thinking={true}
                  timestamp={new Date()}
                />
              )}
            </>
          )}
        </ScrollView>

        {/* Input */}
        <InputBar
          onSend={onSend}
          placeholder={placeholder}
          disabled={isThinking}
        />
      </YStack>
    </KeyboardAvoidingView>
  )
})

AssistantPanel.displayName = 'MCM.AssistantPanel'
