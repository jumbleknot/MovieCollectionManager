/**
 * MCM Design System — MD3 Dialog
 *
 * Types:
 *   basic     — title + content + actions
 *   fullscreen— occupies the whole screen (mobile pattern)
 *
 * MD3 spec: max-width 560dp, centered on screen.
 * Uses a scrim (semi-transparent overlay) behind the dialog.
 *
 * Usage:
 *   <Dialog
 *     visible={showDialog}
 *     title="Delete collection?"
 *     supportingText="This will permanently remove all movies in this collection."
 *     actions={[
 *       <TextButton label="Cancel" onPress={() => setShowDialog(false)} />,
 *       <FilledButton label="Delete" onPress={handleDelete} />,
 *     ]}
 *     onDismiss={() => setShowDialog(false)}
 *   />
 */

import React from 'react'
import { Modal } from 'react-native'
import { View, Text, useTheme } from '@tamagui/core'
import { YStack, XStack } from '@tamagui/stacks'

export interface DialogProps {
  visible:        boolean
  title:          string
  supportingText?: string
  icon?:          React.ReactNode
  children?:      React.ReactNode  // custom content below title
  actions:        React.ReactNode[] | React.ReactNode
  onDismiss?:     () => void       // called on scrim press
  dismissible?:   boolean          // allow scrim dismiss (default true)
  testID?:        string           // forwarded to the dialog container (for E2E selectors)
}

export const Dialog = React.memo<DialogProps>(function Dialog({
  visible,
  title,
  supportingText,
  icon,
  children,
  actions,
  onDismiss,
  dismissible = true,
  testID,
}) {
  const theme = useTheme()

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={dismissible ? onDismiss : undefined}
    >
      {/* Centering overlay. The scrim is a sibling BEHIND the dialog (lower in the stack); the
          dialog container carries zIndex so its actions stay clickable on web — a flat structure
          (no KeyboardAvoidingView, which collapses to 0 height on react-native-web and makes the
          dialog buttons unhittable; feature 017 fix). */}
      <View flex={1} alignItems="center" justifyContent="center" padding={24}>
        {/* Scrim */}
        <View
          backgroundColor={theme.scrim?.val}
          opacity={0.32}
          position="absolute"
          top={0} right={0} bottom={0} left={0}
          onPress={dismissible ? onDismiss : undefined}
        />

        {/* Dialog container */}
        <YStack
          testID={testID}
          zIndex={1}
          backgroundColor={theme.surface3?.val}
          borderRadius={28}  // MD3 extraLarge
          maxWidth={560}
          width="100%"
          overflow="hidden"
          // MD3 elevation 3
          shadowColor={theme.shadow?.val}
          shadowOffset={{ width: 0, height: 6 }}
          shadowOpacity={0.2}
          shadowRadius={6}
          elevation={6}
        >
            {/* Icon (optional, centered) */}
            {icon && (
              <View alignItems="center" paddingTop={24} paddingBottom={16}>
                {icon}
              </View>
            )}

            {/* Title */}
            <View
              paddingHorizontal={24}
              paddingTop={icon ? 0 : 24}
              paddingBottom={16}
            >
              <Text
                fontFamily="$heading"
                fontSize={24}
                fontWeight="400"
                lineHeight={32}
                color={theme.onSurface?.val}
                textAlign={icon ? 'center' : 'left'}
              >
                {title}
              </Text>
            </View>

            {/* Supporting text */}
            {supportingText && (
              <View paddingHorizontal={24} paddingBottom={16}>
                <Text
                  fontFamily="$body"
                  fontSize={14}
                  letterSpacing={0.25}
                  lineHeight={20}
                  color={theme.onSurfaceVariant?.val}
                >
                  {supportingText}
                </Text>
              </View>
            )}

            {/* Custom content */}
            {children && (
              <View paddingHorizontal={24} paddingBottom={16}>
                {children}
              </View>
            )}

            {/* Divider */}
            <View height={1} backgroundColor={theme.outlineVariant?.val} />

            {/* Actions */}
            <XStack
              paddingHorizontal={16}
              paddingVertical={16}
              justifyContent="flex-end"
              gap={8}
              flexWrap="wrap"
            >
              {Array.isArray(actions) ? actions : [actions]}
            </XStack>
        </YStack>
      </View>
    </Modal>
  )
})

Dialog.displayName = 'MCM.Dialog'
