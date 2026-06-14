/**
 * MCM Design System — Assistant Avatar (Grumpy Robot)
 *
 * Renders the Grumpy Robot logo (without text) as the movie assistant's avatar.
 * Used in chat bubbles, the assistant panel header, and assistant-initiated
 * notifications.
 *
 * The robot's orange colour (#E65100) is the tertiary accent of the design
 * system — this is the primary place where orange is used prominently and
 * intentionally, giving the assistant a distinctive, playful identity.
 *
 * The component renders as an SVG recreation of the logo (scalable, no image
 * asset dependency) with an optional animated "thinking" state.
 *
 * Asset usage:
 *   For the highest fidelity (the real logo image), pass useImage={true} and
 *   ensure `grumpy-robot-logo.jpg` is available as an Expo asset in your
 *   app's assets/images/ directory.
 */

import React, { useRef, useEffect } from 'react'
import { Animated } from 'react-native'
import { Stack, useTheme } from 'tamagui'
import Svg, {
  Circle,
  Ellipse,
  Path,
  Rect,
  G,
  ClipPath,
  Defs,
} from 'react-native-svg'

export type AssistantAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export interface AssistantAvatarProps {
  size?:      AssistantAvatarSize
  thinking?:  boolean   // animated pulse while agent is processing
  mood?:      'grumpy' | 'neutral' | 'pleased'  // future: swap expressions
  style?:     object
  onPress?:   () => void
}

const sizeMap: Record<AssistantAvatarSize, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 56,
  xl: 80,
}

/**
 * SVG Grumpy Robot — faithful recreation of the logo head (without text).
 * Drawn on a 100x100 viewBox.
 *
 * Key elements:
 *  - Orange dome head (rounded rect / circle)
 *  - Antenna (top-right diagonal)
 *  - Two side bolts
 *  - Angry V-brow eyebrows
 *  - Squinting eyes (white with dark iris)
 *  - Rectangular grille mouth showing teeth
 *  - Neck connector
 *  - Shoulder base / ears
 */
function GrumpyRobotSVG({ size, color }: { size: number; color: string }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      accessibilityLabel="Movie Assistant"
    >
      {/* ── Side bolts (behind head) ──────────────────────────── */}
      {/* Left bolt */}
      <Circle cx="12" cy="50" r="4" fill={color} />
      <Circle cx="12" cy="50" r="2" fill="#1A1A1A" />
      {/* Right bolt */}
      <Circle cx="88" cy="50" r="4" fill={color} />
      <Circle cx="88" cy="50" r="2" fill="#1A1A1A" />

      {/* Bolt connectors / ear pieces */}
      <Rect x="14" y="48" width="8" height="4" rx="2" fill={color} />
      <Rect x="78" y="48" width="8" height="4" rx="2" fill={color} />

      {/* ── Main dome head ──────────────────────────────────────── */}
      {/* Bottom of head (rectangular section) */}
      <Rect x="20" y="45" width="60" height="28" rx="4" fill={color} />
      {/* Top dome (large circle clipped to upper half) */}
      <Circle cx="50" cy="42" r="30" fill={color} />

      {/* ── Antenna ─────────────────────────────────────────────── */}
      {/* Antenna rod (diagonal, top-right) */}
      <Path
        d="M54 16 L68 5"
        stroke="#1A1A1A"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* Antenna ball */}
      <Circle cx="69" cy="4" r="3" fill="#1A1A1A" />

      {/* ── Angry eyebrows ──────────────────────────────────────── */}
      {/* Left brow — angles down toward center (angry) */}
      <Path
        d="M27 34 L43 39"
        stroke="#1A1A1A"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* Right brow — angles down toward center */}
      <Path
        d="M57 39 L73 34"
        stroke="#1A1A1A"
        strokeWidth="3"
        strokeLinecap="round"
      />

      {/* ── Eyes ────────────────────────────────────────────────── */}
      {/* Left eye socket */}
      <Ellipse cx="36" cy="46" rx="9" ry="7" fill="white" />
      {/* Left iris / pupil — squinted (half covered by lid) */}
      <Ellipse cx="36" cy="49" rx="5" ry="4" fill="#1A1A1A" />
      {/* Left eyelid (squint) */}
      <Rect x="27" y="40" width="18" height="6" rx="0" fill={color} />

      {/* Right eye socket */}
      <Ellipse cx="64" cy="46" rx="9" ry="7" fill="white" />
      {/* Right iris / pupil */}
      <Ellipse cx="64" cy="49" rx="5" ry="4" fill="#1A1A1A" />
      {/* Right eyelid (squint) */}
      <Rect x="55" y="40" width="18" height="6" rx="0" fill={color} />

      {/* ── Mouth / grille ─────────────────────────────────────── */}
      {/* Mouth outer (dark frame) */}
      <Rect x="30" y="58" width="40" height="14" rx="3" fill="#1A1A1A" />
      {/* Teeth area (white) */}
      <Rect x="32" y="60" width="36" height="10" rx="2" fill="white" />
      {/* Tooth gap line */}
      <Rect x="48" y="60" width="2" height="10" fill="#1A1A1A" opacity="0.4" />
      {/* Crooked tooth detail (wavy line) */}
      <Path
        d="M36 65 L40 62 L44 65 L48 62 L52 65"
        stroke="#1A1A1A"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Bottom lip line */}
      <Path
        d="M30 68 Q50 72 70 68"
        stroke="#1A1A1A"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        opacity="0.5"
      />

      {/* ── Neck & base ─────────────────────────────────────────── */}
      <Rect x="43" y="73" width="14" height="8" rx="2" fill={color} />
      {/* Shoulder / base plate */}
      <Path
        d="M25 81 Q20 85 30 86 L70 86 Q80 85 75 81 Z"
        fill={color}
      />
    </Svg>
  )
}

// ─── Thinking dots animation ──────────────────────────────────────────────────

function ThinkingIndicator({ color }: { color: string }) {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ]

  useEffect(() => {
    const animations = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(dot, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 400, useNativeDriver: true }),
        ])
      )
    )
    animations.forEach(a => a.start())
    return () => animations.forEach(a => a.stop())
  }, [])

  return (
    <Stack
      flexDirection="row"
      gap={3}
      alignItems="center"
      position="absolute"
      bottom={-6}
      right={-2}
      backgroundColor={color}
      borderRadius={8}
      paddingHorizontal={5}
      paddingVertical={3}
    >
      {dots.map((dot, i) => (
        <Animated.View
          key={i}
          style={{
            width:           4,
            height:          4,
            borderRadius:    2,
            backgroundColor: 'white',
            opacity:         dot,
          }}
        />
      ))}
    </Stack>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export const AssistantAvatar = React.memo<AssistantAvatarProps>(function AssistantAvatar({
  size     = 'md',
  thinking = false,
  onPress,
  style,
}) {
  const theme    = useTheme()
  const px       = sizeMap[size]

  // The robot's own orange — this is one of the intentional accent uses
  const robotColor = theme.tertiary.val   // maps to tertiaryP50 = #E65100 in light, tertiaryP80 in dark

  return (
    <Stack
      width={px}
      height={px}
      position="relative"
      style={style}
      onPress={onPress}
      cursor={onPress ? 'pointer' : 'default'}
    >
      <GrumpyRobotSVG size={px} color={robotColor} />
      {thinking && <ThinkingIndicator color={theme.primary.val} />}
    </Stack>
  )
})

AssistantAvatar.displayName = 'MCM.AssistantAvatar'
