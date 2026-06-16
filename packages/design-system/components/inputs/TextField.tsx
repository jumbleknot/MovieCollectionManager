/**
 * MCM Design System — MD3 TextField
 *
 * Variants:
 *   filled   — surfaceVariant bg + bottom underline (default)
 *   outlined — transparent bg + full border
 *
 * Features:
 *   - Animated floating label (moves up on focus/fill)
 *   - Leading & trailing icons
 *   - Supporting text (helper / error)
 *   - Character counter
 *   - Error state
 *   - MD3 state layers on focus/hover
 *
 * Usage:
 *   <TextField
 *     variant="outlined"
 *     label="Movie title"
 *     value={value}
 *     onChangeText={setValue}
 *     leadingIcon={<SearchIcon />}
 *   />
 */

import React, { useState, useCallback } from 'react'
import { TextInput, Animated, type TextInputProps } from 'react-native'
import { Stack, Text, useTheme } from '@tamagui/core'
import { XStack, YStack } from '@tamagui/stacks'

export type TextFieldVariant = 'filled' | 'outlined'

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  variant?:        TextFieldVariant
  label:           string
  value?:          string
  error?:          boolean
  errorText?:      string
  supportingText?: string
  leadingIcon?:    React.ReactNode
  trailingIcon?:   React.ReactNode
  maxCount?:       number          // enables character counter
  disabled?:       boolean
  required?:       boolean
  containerProps?: object
}

export const TextField = React.forwardRef<TextInput, TextFieldProps>(function TextField(
  {
    variant        = 'filled',
    label,
    value          = '',
    error          = false,
    errorText,
    supportingText,
    leadingIcon,
    trailingIcon,
    maxCount,
    disabled       = false,
    required       = false,
    containerProps,
    onFocus,
    onBlur,
    ...textInputProps
  },
  ref,
) {
  const theme = useTheme()
  const [focused, setFocused] = useState(false)

  const labelAnim = useState(() => new Animated.Value(value ? 1 : 0))[0]

  const floatLabel = useCallback((toValue: number) => {
    Animated.timing(labelAnim, {
      toValue,
      duration:       150,
      useNativeDriver: false,
    }).start()
  }, [labelAnim])

  // Derive the handler param type from TextInputProps so it tracks the installed
  // React Native version (RN 0.85 changed onFocus/onBlur from NativeSyntheticEvent<…>
  // to FocusEvent/BlurEvent). `e` and the passthrough onFocus/onBlur stay in sync.
  const handleFocus: NonNullable<TextInputProps['onFocus']> = (e) => {
    setFocused(true)
    floatLabel(1)
    onFocus?.(e)
  }

  const handleBlur: NonNullable<TextInputProps['onBlur']> = (e) => {
    setFocused(false)
    if (!value) floatLabel(0)
    onBlur?.(e)
  }

  // ── Colours ───────────────────────────────────────────────────────────────
  const activeColor  = error ? theme.error?.val    : theme.primary?.val
  const borderColor  = error
    ? theme.error?.val
    : focused
    ? theme.primary?.val
    : theme.outline?.val
  const labelColor   = error
    ? theme.error?.val
    : focused
    ? theme.primary?.val
    : theme.onSurfaceVariant?.val
  const bgColor      = disabled
    ? theme.onSurface?.val + '0F'   // 6% opacity on disabled
    : variant === 'filled'
    ? theme.surfaceVariant?.val
    : 'transparent'

  // ── Animated label ────────────────────────────────────────────────────────
  const hasLeading = !!leadingIcon

  const labelStyle = {
    position:   'absolute' as const,
    left:       hasLeading ? 48 : 16,
    top:        Animated.multiply(labelAnim, -1).interpolate({
      inputRange:  [0, -1],
      outputRange: ['50%', '0%'],
    }),
    // Actually let's just use translateY
    transform: [{
      translateY: labelAnim.interpolate({
        inputRange:  [0, 1],
        outputRange: [0, -24],
      }),
    }],
    fontSize: labelAnim.interpolate({
      inputRange:  [0, 1],
      outputRange: [16, 12],
    }),
    color:     labelColor,
  }

  const isFilled   = variant === 'filled'

  return (
    <YStack gap={4} opacity={disabled ? 0.38 : 1} {...containerProps}>
      {/* ── Input container ─────────────────────────────────────────────── */}
      <XStack
        position="relative"
        height={56}
        backgroundColor={bgColor}
        borderRadius={isFilled ? 4 : 4}  // top corners rounded for filled, all for outlined
        borderTopLeftRadius={isFilled ? 4 : 4}
        borderTopRightRadius={isFilled ? 4 : 4}
        borderBottomLeftRadius={isFilled ? 0 : 4}
        borderBottomRightRadius={isFilled ? 0 : 4}
        borderWidth={isFilled ? 0 : 1}
        borderColor={isFilled ? undefined : borderColor}
        overflow="hidden"
        alignItems="center"
      >
        {/* Bottom border for filled variant */}
        {isFilled && (
          <>
            <Stack
              position="absolute"
              bottom={0}
              left={0}
              right={0}
              height={1}
              backgroundColor={focused ? undefined : theme.onSurfaceVariant?.val}
            />
            <Stack
              position="absolute"
              bottom={0}
              left={0}
              right={0}
              height={focused ? 2 : 0}
              backgroundColor={activeColor}
            />
          </>
        )}

        {/* State layer */}
        <Stack
          position="absolute"
          top={0} right={0} bottom={0} left={0}
          backgroundColor={theme.onSurface?.val}
          opacity={focused ? 0.08 : 0}
          pointerEvents="none"
        />

        {/* Leading icon */}
        {leadingIcon && (
          <Stack
            width={48}
            height={48}
            alignItems="center"
            justifyContent="center"
            flexShrink={0}
          >
            {leadingIcon}
          </Stack>
        )}

        {/* Label + input stacked */}
        <Stack flex={1} position="relative" height="100%" justifyContent="flex-end" paddingBottom={8}>
          {/* Floating label */}
          <Animated.Text
            style={[labelStyle, {
              position:       'absolute',
              pointerEvents:  'none',
              fontFamily:     'Inter, system-ui',
              zIndex:         1,
            }]}
            numberOfLines={1}
          >
            {label}{required ? ' *' : ''}
          </Animated.Text>

          {/* Actual TextInput */}
          <TextInput
            ref={ref}
            value={value}
            onFocus={handleFocus}
            onBlur={handleBlur}
            editable={!disabled}
            style={{
              fontFamily:    'Inter, system-ui, sans-serif',
              fontSize:      16,
              color:         theme.onSurface?.val,
              paddingLeft:   hasLeading ? 0 : 0,
              paddingTop:    20,
              paddingBottom: 4,
              margin:        0,
              height:        48,
              outlineStyle:  'none',  // web: remove native input ring (we style it)
            } as any}
            placeholderTextColor={theme.onSurfaceVariant?.val as string}
            {...textInputProps}
          />
        </Stack>

        {/* Trailing icon */}
        {trailingIcon && (
          <Stack
            width={48}
            height={48}
            alignItems="center"
            justifyContent="center"
            flexShrink={0}
          >
            {trailingIcon}
          </Stack>
        )}
      </XStack>

      {/* ── Supporting line ──────────────────────────────────────────────── */}
      <XStack paddingHorizontal={16} justifyContent="space-between">
        {(errorText && error) || supportingText ? (
          <Text
            fontFamily="$body"
            fontSize={12}
            letterSpacing={0.4}
            color={error ? theme.error?.val : theme.onSurfaceVariant?.val}
            flex={1}
          >
            {error && errorText ? errorText : supportingText}
          </Text>
        ) : (
          <Stack flex={1} />
        )}

        {maxCount !== undefined && (
          <Text
            fontFamily="$body"
            fontSize={12}
            letterSpacing={0.4}
            color={theme.onSurfaceVariant?.val}
            marginLeft={8}
          >
            {value.length}/{maxCount}
          </Text>
        )}
      </XStack>
    </YStack>
  )
})

TextField.displayName = 'MCM.TextField'
