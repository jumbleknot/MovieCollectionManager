/**
 * MCM Design System — Material Design 3 Motion Tokens
 *
 * Durations are in milliseconds.
 * Easing strings are CSS cubic-bezier() values (also accepted by
 * React Native's Animated.timing via Easing.bezier()).
 *
 * MD3 defines two families:
 *   Emphasized — for elements that cross large areas of the screen
 *   Standard   — for simple enter/exit transitions within a component
 *
 * Usage with React Native Animated:
 *   import { Easing } from 'react-native'
 *   Animated.timing(value, {
 *     duration: motion.duration.medium2,
 *     easing:   Easing.bezier(...motion.easing.standardDecelerate),
 *   })
 *
 * Usage with Reanimated / react-native-reanimated:
 *   withTiming(value, { duration, easing: Easing.bezier(...) })
 */

// ─── Duration ─────────────────────────────────────────────────────────────────
export const duration = {
  // Short — small components, quick state changes
  short1:  50,
  short2:  100,
  short3:  150,
  short4:  200,

  // Medium — most common enter/exit
  medium1: 250,
  medium2: 300,
  medium3: 350,
  medium4: 400,

  // Long — complex transitions, large areas
  long1:   450,
  long2:   500,
  long3:   550,
  long4:   600,

  // Extra Long — full-screen transitions
  extraLong1: 700,
  extraLong2: 800,
  extraLong3: 900,
  extraLong4: 1000,
} as const

// ─── Easing (cubic-bezier coefficients as [x1, y1, x2, y2]) ─────────────────
// Suitable for Easing.bezier(x1, y1, x2, y2) in React Native
export const easingCoords = {
  // Emphasized — for persistent / hero transitions
  emphasized:           [0.2,  0,    0,    1.0 ] as [number,number,number,number],
  emphasizedDecelerate: [0.05, 0.7,  0.1,  1.0 ] as [number,number,number,number],
  emphasizedAccelerate: [0.3,  0.0,  0.8,  0.15] as [number,number,number,number],

  // Standard — for simple component-level transitions
  standard:             [0.2,  0,    0,    1.0 ] as [number,number,number,number],
  standardDecelerate:   [0,    0,    0,    1   ] as [number,number,number,number],
  standardAccelerate:   [0.3,  0,    1,    1   ] as [number,number,number,number],

  // Linear — progress indicators, continuous animation
  linear:               [0,    0,    1,    1   ] as [number,number,number,number],
} as const

/** CSS cubic-bezier strings — for web (Tamagui animations on web) */
export const easingCSS = {
  emphasized:           'cubic-bezier(0.2, 0, 0, 1)',
  emphasizedDecelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  emphasizedAccelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
  standard:             'cubic-bezier(0.2, 0, 0, 1)',
  standardDecelerate:   'cubic-bezier(0, 0, 0, 1)',
  standardAccelerate:   'cubic-bezier(0.3, 0, 1, 1)',
  linear:               'linear',
} as const

// ─── Pre-composed transition presets ─────────────────────────────────────────
export const transitions = {
  /** Button press ripple / state layer */
  stateLayer: {
    duration: duration.short3,
    easing:   easingCSS.standardDecelerate,
  },
  /** Chip / Badge enter */
  chipEnter: {
    duration: duration.medium2,
    easing:   easingCSS.emphasizedDecelerate,
  },
  /** Dialog open */
  dialogOpen: {
    duration: duration.medium4,
    easing:   easingCSS.emphasizedDecelerate,
  },
  /** Dialog close */
  dialogClose: {
    duration: duration.medium2,
    easing:   easingCSS.emphasizedAccelerate,
  },
  /** FAB expand to extended FAB */
  fabExpand: {
    duration: duration.medium3,
    easing:   easingCSS.emphasized,
  },
  /** Screen / page forward transition */
  pageForward: {
    duration: duration.medium3,
    easing:   easingCSS.emphasizedDecelerate,
  },
  /** Screen / page backward transition */
  pageBack: {
    duration: duration.medium2,
    easing:   easingCSS.emphasizedAccelerate,
  },
  /** Shared-axis element enter */
  sharedAxisEnter: {
    duration: duration.long1,
    easing:   easingCSS.emphasizedDecelerate,
  },
  /** Snackbar slide-up */
  snackbarEnter: {
    duration: duration.medium3,
    easing:   easingCSS.emphasizedDecelerate,
  },
  /** Snackbar slide-down */
  snackbarExit: {
    duration: duration.medium2,
    easing:   easingCSS.emphasizedAccelerate,
  },
  /** Bottom sheet open */
  bottomSheetOpen: {
    duration: duration.long2,
    easing:   easingCSS.emphasizedDecelerate,
  },
  /** Movie card poster reveal */
  posterReveal: {
    duration: duration.medium4,
    easing:   easingCSS.emphasizedDecelerate,
  },
  /** Assistant panel slide up */
  assistantOpen: {
    duration: duration.long1,
    easing:   easingCSS.emphasizedDecelerate,
  },
} as const

export const motion = {
  duration,
  easingCoords,
  easingCSS,
  transitions,
} as const

export type Motion = typeof motion
