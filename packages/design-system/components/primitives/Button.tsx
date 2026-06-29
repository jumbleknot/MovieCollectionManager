/**
 * MCM Design System — MD3 Button
 *
 * Variants (MD3 spec):
 *   filled     — high emphasis, primary action (filled with primary colour)
 *   filledTonal— medium-high, secondary action (filled with secondaryContainer)
 *   elevated   — medium emphasis (surface + shadow, no fill colour)
 *   outlined   — medium emphasis (border only)
 *   text       — low emphasis, tertiary action
 *
 * Props:
 *   variant      — one of the five above (default: 'filled')
 *   size         — 'sm' | 'md' | 'lg'  (default: 'md')
 *   icon         — optional leading icon element
 *   trailingIcon — optional trailing icon element
 *   loading      — shows ActivityIndicator and disables interaction
 *   disabled
 *
 * All variants include the MD3 state-layer press/hover/focus ripple.
 */

import React from 'react'
import { ActivityIndicator, type GestureResponderEvent, } from 'react-native'
import {
  View, Text, styled, useTheme, type ViewProps } from '@tamagui/core'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ButtonVariant = 'filled' | 'filledTonal' | 'elevated' | 'outlined' | 'text'
export type ButtonSize    = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ViewProps, 'onPress'> {
  variant?:      ButtonVariant
  size?:         ButtonSize
  label:         string
  icon?:         React.ReactNode
  trailingIcon?: React.ReactNode
  loading?:      boolean
  disabled?:     boolean
  /** Destructive action — recolours the chosen variant onto the error palette (delete, logout…). */
  danger?:       boolean
  /** Allow the label to wrap (up to 3 lines) instead of truncating — for full-width list/option
   *  buttons with long text (e.g. the assistant's selectable result buttons). */
  multiline?:    boolean
  onPress?:      (e: GestureResponderEvent) => void
}

// ─── Size config ──────────────────────────────────────────────────────────────

const sizeConfig = {
  sm: { height: 32, paddingH: 12, fontSize: 13, iconSize: 16 },
  md: { height: 40, paddingH: 24, fontSize: 14, iconSize: 18 },
  lg: { height: 48, paddingH: 28, fontSize: 16, iconSize: 20 },
} as const

// ─── Styled container ────────────────────────────────────────────────────────

const ButtonBase = styled(View, {
  name:            'MCMButton',
  flexDirection:   'row',
  alignItems:      'center',
  justifyContent:  'center',
  borderRadius:    '$9',     // MD3 extraLarge = full pill for buttons
  overflow:        'hidden',
  cursor:          'pointer',
  userSelect:      'none',
  // MD3 min touch target 48x48 — enforced via minHeight even for sm
  minHeight:       48,
  // No default outline; the ring is added on KEYBOARD focus only (focusVisibleStyle) so a mouse
  // click doesn't leave a persistent :focus outline until blur (feature 015 bug fix).
  outlineStyle:    'none',

  pressStyle: {
    opacity: 0.88,
  },
  hoverStyle: {
    opacity: 0.92,
  },
  focusVisibleStyle: {
    outlineStyle: 'solid',
    outlineWidth: 3,
    outlineColor: '$primary',
    outlineOffset: 2,
  },
  disabledStyle: {
    opacity: 0.38,
    cursor: 'not-allowed',
  },
})

// ─── State-layer overlay (MD3 ripple equivalent) ─────────────────────────────

const StateLayer = styled(View, {
  name:            'MCMButtonStateLayer',
  position:        'absolute',
  top: 0, right: 0, bottom: 0, left: 0,
  borderRadius:    '$9',
  pointerEvents:   'none',
  opacity:         0,
  hoverStyle:      { opacity: 0.08 },
  pressStyle:      { opacity: 0.12 },
  focusVisibleStyle: { opacity: 0.12 },
})

// ─── Button component ─────────────────────────────────────────────────────────

export const Button = React.forwardRef<any, ButtonProps>(function Button(
  {
    variant  = 'filled',
    size     = 'md',
    label,
    icon,
    trailingIcon,
    loading  = false,
    disabled = false,
    danger   = false,
    multiline = false,
    onPress,
    ...rest
  },
  ref,
) {
  const theme = useTheme()
  const cfg   = sizeConfig[size]

  // ── Variant → colour mapping ───────────────────────────────────────────
  type VariantStyle = {
    bg:           string
    fg:           string
    border?:      string
    stateLayer:   string
    shadowLevel?: number
  }

  const variantStyles: Record<ButtonVariant, VariantStyle> = {
    filled: {
      bg:         theme.primary?.val,
      fg:         theme.onPrimary?.val,
      stateLayer: theme.onPrimary?.val,
    },
    filledTonal: {
      bg:         theme.secondaryContainer?.val,
      fg:         theme.onSecondaryContainer?.val,
      stateLayer: theme.onSecondaryContainer?.val,
    },
    elevated: {
      bg:          theme.surface1?.val,
      fg:          theme.primary?.val,
      stateLayer:  theme.primary?.val,
      shadowLevel: 1,
    },
    outlined: {
      bg:         'transparent',
      fg:         theme.primary?.val,
      border:     theme.outline?.val,
      stateLayer: theme.primary?.val,
    },
    text: {
      bg:         'transparent',
      fg:         theme.primary?.val,
      stateLayer: theme.primary?.val,
    },
  }

  // Destructive recolour: map the chosen variant onto the error palette.
  const dangerStyles: Record<ButtonVariant, VariantStyle> = {
    filled:      { bg: theme.error?.val,          fg: theme.onError?.val,          stateLayer: theme.onError?.val },
    filledTonal: { bg: theme.errorContainer?.val, fg: theme.onErrorContainer?.val, stateLayer: theme.onErrorContainer?.val },
    elevated:    { bg: theme.surface1?.val,        fg: theme.error?.val,            stateLayer: theme.error?.val, shadowLevel: 1 },
    outlined:    { bg: 'transparent',              fg: theme.error?.val,            border: theme.error?.val, stateLayer: theme.error?.val },
    text:        { bg: 'transparent',              fg: theme.error?.val,            stateLayer: theme.error?.val },
  }

  const vs = danger ? dangerStyles[variant] : variantStyles[variant]

  // ── Shadow (elevated only) ─────────────────────────────────────────────
  const shadowProps = vs.shadowLevel
    ? {
        shadowColor:    theme.shadow?.val,
        shadowOffset:   { width: 0, height: 1 },
        shadowOpacity:  0.12,
        shadowRadius:   2,
        elevation:      1,
      }
    : {}

  const hasIcon = !!icon || !!trailingIcon
  const paddingH = hasIcon ? cfg.paddingH - 8 : cfg.paddingH

  const isInactive = disabled || loading

  return (
    <ButtonBase
      ref={ref}
      // The div is the button — expose role + disabled to the DOM/AT on web.
      // Tamagui translates accessibilityLabel→aria-label but NOT accessibilityRole
      // /accessibilityState, so set role="button" + aria-disabled explicitly. The
      // role is also required for Playwright's toBeDisabled() to honour
      // aria-disabled (a bare div with aria-disabled is not a recognised control).
      role="button"
      backgroundColor={vs.bg}
      borderWidth={vs.border ? 1 : 0}
      borderColor={vs.border}
      // Multiline: let the button grow to fit a wrapped label (minHeight 48 keeps the touch target).
      height={multiline ? undefined : cfg.height}
      paddingVertical={multiline ? 10 : undefined}
      paddingHorizontal={paddingH}
      opacity={disabled ? 0.38 : 1}
      pointerEvents={isInactive ? 'none' : 'auto'}
      onPress={isInactive ? undefined : onPress}
      aria-disabled={isInactive ? true : undefined}
      {...shadowProps}
      {...rest}
    >
      {/* MD3 state layer */}
      <StateLayer backgroundColor={vs.stateLayer} />

      {/* Leading icon */}
      {icon && !loading && (
        <View marginRight={8} width={cfg.iconSize} height={cfg.iconSize} alignItems="center" justifyContent="center">
          {icon}
        </View>
      )}

      {/* Loading spinner */}
      {loading && (
        <View marginRight={8}>
          <ActivityIndicator
            size="small"
            color={vs.fg}
          />
        </View>
      )}

      {/* Label — MD3 labelLarge.
          - flexShrink 0 on single-line: the button hugs its content, so the label's available width ≈
            its content width. With flexShrink:1 the slightest extra (padding, or Inter's glyph ink
            exceeding its advance) tips numberOfLines:1 into ellipsizing → "Login with Keycl…". Single-
            line labels must keep full width and let the button grow; only the `multiline` option-button
            variant wraps (flexShrink:1 + flex:1).
          - paddingHorizontal: a few px so Android doesn't clip the trailing glyph's side-bearing (the
            'k' in "Keycloak"); harmless now that the label no longer shrinks. */}
      <Text
        fontFamily="$body"
        fontSize={cfg.fontSize}
        fontWeight="500"
        letterSpacing={0.1}
        color={vs.fg}
        numberOfLines={multiline ? 3 : 1}
        flexShrink={multiline ? 1 : 0}
        flex={multiline ? 1 : undefined}
        paddingHorizontal={3}
      >
        {label}
      </Text>

      {/* Trailing icon */}
      {trailingIcon && !loading && (
        <View marginLeft={8} width={cfg.iconSize} height={cfg.iconSize} alignItems="center" justifyContent="center">
          {trailingIcon}
        </View>
      )}
    </ButtonBase>
  )
})

Button.displayName = 'MCM.Button'

// ─── Convenience exports ──────────────────────────────────────────────────────

export const FilledButton      = (p: Omit<ButtonProps, 'variant'>) => <Button variant="filled"      {...p} />
export const FilledTonalButton = (p: Omit<ButtonProps, 'variant'>) => <Button variant="filledTonal" {...p} />
export const ElevatedButton    = (p: Omit<ButtonProps, 'variant'>) => <Button variant="elevated"    {...p} />
export const OutlinedButton    = (p: Omit<ButtonProps, 'variant'>) => <Button variant="outlined"    {...p} />
export const TextButton        = (p: Omit<ButtonProps, 'variant'>) => <Button variant="text"        {...p} />
