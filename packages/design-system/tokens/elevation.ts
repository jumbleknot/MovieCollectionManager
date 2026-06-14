/**
 * MCM Design System — Material Design 3 Elevation Tokens
 *
 * MD3 uses 5 tonal elevation levels expressed as dp values.
 * On Android, elevation is rendered as a shadow + surface tint overlay.
 * On iOS/web, shadows are used directly.
 *
 * Surface tint percentages are pre-applied in colors.ts (surface1–surface5).
 * The shadow values below are used for the actual drop shadow.
 *
 * React Native shadow format (ios + android via elevation prop):
 *   shadowColor, shadowOffset, shadowOpacity, shadowRadius (iOS)
 *   elevation (Android — maps to dp, auto-calculates shadow)
 */

export type ElevationShadow = {
  /** Android elevation (dp) */
  elevation: number
  /** iOS & web shadow properties */
  shadowColor:    string
  shadowOffset:   { width: number; height: number }
  shadowOpacity:  number
  shadowRadius:   number
  /** Surface tint overlay (see colors.ts surface1–surface5) */
  surfaceToneKey: 'surface' | 'surface1' | 'surface2' | 'surface3' | 'surface4' | 'surface5'
}

export const elevation: Record<0 | 1 | 2 | 3 | 4 | 5, ElevationShadow> = {
  /** Level 0 — flat, no shadow */
  0: {
    elevation:       0,
    shadowColor:     '#000000',
    shadowOffset:    { width: 0, height: 0 },
    shadowOpacity:   0,
    shadowRadius:    0,
    surfaceToneKey:  'surface',
  },
  /** Level 1 — Card resting, Switch track */
  1: {
    elevation:       1,
    shadowColor:     '#000000',
    shadowOffset:    { width: 0, height: 1 },
    shadowOpacity:   0.12,
    shadowRadius:    2,
    surfaceToneKey:  'surface1',
  },
  /** Level 2 — Card hover, Chip elevated */
  2: {
    elevation:       3,
    shadowColor:     '#000000',
    shadowOffset:    { width: 0, height: 1 },
    shadowOpacity:   0.16,
    shadowRadius:    4,
    surfaceToneKey:  'surface2',
  },
  /** Level 3 — FAB resting, NavigationDrawer */
  3: {
    elevation:       6,
    shadowColor:     '#000000',
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.2,
    shadowRadius:    6,
    surfaceToneKey:  'surface3',
  },
  /** Level 4 — FAB pressed, AppBar scrolled */
  4: {
    elevation:       8,
    shadowColor:     '#000000',
    shadowOffset:    { width: 0, height: 3 },
    shadowOpacity:   0.22,
    shadowRadius:    8,
    surfaceToneKey:  'surface4',
  },
  /** Level 5 — Dialog, NavigationBar */
  5: {
    elevation:       12,
    shadowColor:     '#000000',
    shadowOffset:    { width: 0, height: 4 },
    shadowOpacity:   0.25,
    shadowRadius:    12,
    surfaceToneKey:  'surface5',
  },
}

/**
 * Component elevation map — which MD3 level each component sits at by default.
 * Reference: https://m3.material.io/styles/elevation/tokens
 */
export const componentElevation = {
  // Surfaces
  card:                  1,
  cardHovered:           2,
  dialog:                3,
  drawerModal:           1,
  drawerStandard:        0,

  // Controls
  chipElevated:          1,
  chipElevatedHovered:   2,
  fabResting:            3,
  fabLowered:            3,
  fabHovered:            4,
  fabPressed:            3,
  extendedFab:           3,

  // Navigation
  appBarFlat:            0,
  appBarScrolled:        2,
  navigationBar:         2,
  navigationDrawer:      1,

  // Menus / overlays
  menu:                  2,
  tooltip:               2,
  snackbar:              3,
  autocomplete:          3,
  select:                3,
} as const
