/**
 * MCM Design System — MD3 Search Bar
 *
 * Variants:
 *   docked   — embedded in layout; pill-shaped, elevation 0 (surfaceVariant bg)
 *   full     — full-screen modal search with back button
 *
 * Based on MD3 Search spec (M3.material.io/components/search).
 *
 * Usage:
 *   <SearchBar
 *     placeholder="Search movies…"
 *     value={query}
 *     onChangeText={setQuery}
 *     onClear={() => setQuery('')}
 *     leadingIcon={<MenuIcon />}
 *   />
 */

import React, { useState, useRef } from 'react'
import { TextInput, type TextInputProps } from 'react-native'
import { Stack, XStack, Text, useTheme } from 'tamagui'

export type SearchBarVariant = 'docked' | 'full'

export interface SearchBarProps extends Omit<TextInputProps, 'style'> {
  variant?:       SearchBarVariant
  value?:         string
  placeholder?:   string
  leadingIcon?:   React.ReactNode   // default: search magnifier; 'back' for full variant
  trailingIcon?:  React.ReactNode   // avatar, overflow menu
  onClear?:       () => void
  focused?:       boolean
  onFocusChange?: (focused: boolean) => void
  disabled?:      boolean
}

export const SearchBar = React.forwardRef<TextInput, SearchBarProps>(function SearchBar(
  {
    variant       = 'docked',
    value         = '',
    placeholder   = 'Search',
    leadingIcon,
    trailingIcon,
    onClear,
    focused: controlledFocused,
    onFocusChange,
    disabled      = false,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const theme = useTheme()
  const [internalFocused, setInternalFocused] = useState(false)
  const focused = controlledFocused ?? internalFocused

  const handleFocus = (e: any) => {
    setInternalFocused(true)
    onFocusChange?.(true)
    onFocus?.(e)
  }

  const handleBlur = (e: any) => {
    setInternalFocused(false)
    onFocusChange?.(false)
    onBlur?.(e)
  }

  // MD3 search bar height: 56dp
  const height = 56

  return (
    <XStack
      height={height}
      borderRadius={height / 2}   // full pill shape
      backgroundColor={focused ? theme.surface3.val : theme.surfaceVariant.val}
      alignItems="center"
      overflow="hidden"
      opacity={disabled ? 0.38 : 1}
      animation="quick"
      // Elevation 0 when idle → 3 when focused (MD3 spec)
      shadowColor={focused ? theme.shadow.val : 'transparent'}
      shadowOffset={{ width: 0, height: focused ? 2 : 0 }}
      shadowOpacity={focused ? 0.2 : 0}
      shadowRadius={focused ? 6 : 0}
      elevation={focused ? 3 : 0}
    >
      {/* Leading icon / button */}
      <Stack
        width={56}
        height={56}
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
      >
        {leadingIcon ?? (
          // Default search icon (Unicode placeholder; replace with icon library)
          <Text
            fontSize={20}
            color={theme.onSurface.val}
            lineHeight={20}
          >
            🔍
          </Text>
        )}
      </Stack>

      {/* Input field */}
      <TextInput
        ref={ref}
        value={value}
        placeholder={placeholder}
        placeholderTextColor={theme.onSurfaceVariant.val}
        onFocus={handleFocus}
        onBlur={handleBlur}
        editable={!disabled}
        style={{
          flex:          1,
          fontFamily:    'Inter, system-ui, sans-serif',
          fontSize:      16,
          letterSpacing: 0.5,
          color:         theme.onSurface.val,
          height:        '100%',
          paddingVertical: 0,
          outlineStyle:  'none',
        } as any}
        {...rest}
      />

      {/* Clear button — appears when there is a value */}
      {value.length > 0 && onClear && (
        <Stack
          width={48}
          height={48}
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
          onPress={onClear}
          cursor="pointer"
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <Text fontSize={18} color={theme.onSurfaceVariant.val} lineHeight={18}>×</Text>
        </Stack>
      )}

      {/* Trailing icon */}
      {trailingIcon && (
        <Stack
          width={48}
          height={48}
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
          marginRight={4}
        >
          {trailingIcon}
        </Stack>
      )}
    </XStack>
  )
})

SearchBar.displayName = 'MCM.SearchBar'
