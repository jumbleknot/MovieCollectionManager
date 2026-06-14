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
import {
  ActivityIndicator,
  Platform,
  type GestureResponderEvent,
} from 'react-native'
import {
  Stack,
  Text,
  styled,
  useTheme,
  type StackProps,
} from 'tamagui'
import { typeScale } from '../../tokens/typography'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ButtonVariant = 'filled' | 'filledTonal' | 'elevated' | 'outlined' | 'text'
export type ButtonSize    = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<StackProps, 'onPress'> {
  variant?:      ButtonVariant
  size?:         ButtonSize
  label:         string
  icon?:         React.ReactNode
  trailingIcon?: React.ReactNode
  loading?:      boolean
  disabled?:     boolean
  onPress?:      (e: GestureResponderEvent) => void
}

// ─── Size config ──────────────────────────────────────────────────────────────

const sizeConfig = {
  sm: { height: 32, paddingH: 12, fontSize: 13, iconSize: 16 },
  md: { height: 40, paddingH: 24, fontSize: 14, iconSize: 18 },
  lg: { height: 48, paddingH: 28, fontSize: 16, iconSize: 20 },
} as const

// ─── Styled container ────────────────────────────────────────────────────────

const ButtonBase = styled(Stack, {
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
  animation:       'quick',

  pressStyle: {
    opacity: 0.88,
  },
  hoverStyle: {
    opacity: 0.92,
  },
  focusStyle: {
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

const StateLayer = styled(Stack, {
  name:            'MCMButtonStateLayer',
  position:        'absolute',
  top: 0, right: 0, bottom: 0, left: 0,
  borderRadius:    '$9',
  pointerEvents:   'none',
  opacity:         0,
  hoverStyle:      { opacity: 0.08 },
  pressStyle:      { opacity: 0.12 },
  focusStyle:      { opacity: 0.12 },
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

  const vs = variantStyles[variant]

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

  return (
    <ButtonBase
      ref={ref}
      backgroundColor={vs.bg}
      borderWidth={vs.border ? 1 : 0}
      borderColor={vs.border}
      height={cfg.height}
      paddingHorizontal={paddingH}
      opacity={disabled ? 0.38 : 1}
      pointerEvents={disabled || loading ? 'none' : 'auto'}
      onPress={disabled || loading ? undefined : onPress}
      {...shadowProps}
      {...rest}
    >
      {/* MD3 state layer */}
      <StateLayer backgroundColor={vs.stateLayer} />

      {/* Leading icon */}
      {icon && !loading && (
        <Stack marginRight={8} width={cfg.iconSize} height={cfg.iconSize} alignItems="center" justifyContent="center">
          {icon}
        </Stack>
      )}

      {/* Loading spinner */}
      {loading && (
        <Stack marginRight={8}>
          <ActivityIndicator
            size="small"
            color={vs.fg}
          />
        </Stack>
      )}

      {/* Label — MD3 labelLarge */}
      <Text
        fontFamily="$body"
        fontSize={cfg.fontSize}
        fontWeight="500"
        letterSpacing={0.1}
        color={vs.fg}
        numberOfLines={1}
      >
        {label}
      </Text>

      {/* Trailing icon */}
      {trailingIcon && !loading && (
        <Stack marginLeft={8} width={cfg.iconSize} height={cfg.iconSize} alignItems="center" justifyContent="center">
          {trailingIcon}
        </Stack>
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
