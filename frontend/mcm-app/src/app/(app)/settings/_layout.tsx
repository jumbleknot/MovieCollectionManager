/**
 * Settings route-group layout (feature 062) — FR-003.
 *
 * Renders the shared sub-navigation above the routed settings area. Composes navigation only:
 * it holds no screen content, because routes never define screen components
 * (constitution §Frontend App-Layer).
 *
 * This MUST be a directory route with a _layout.tsx, never a settings.tsx file route: a file
 * route cannot host nested children, so the children beneath it would not inherit this layout
 * and the sub-navigation could not render above them. Same trap recorded for
 * collections/[collectionId]/ in openwiki/gotchas/expo-router-collection-routing.md.
 *
 * AssistantConfigProvider deliberately does NOT move here — it stays in (app)/_layout.tsx, so
 * it wraps BOTH this Stack (which renders the assistant config form) and the dock gate. Moving
 * it here would put the form inside the provider and the dock outside it, silently breaking the
 * in-session availability refresh on save (research.md §R7; guarded by the test in T010).
 */

import React from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { Slot } from 'expo-router';
import { SettingsNav } from '@/components/settings/settings-nav';

/**
 * Above this width the navigation sits BESIDE the content; below it, stacked above.
 * 768 is the conventional tablet break and the point at which a 240px rail still leaves a
 * comfortable content column.
 */
const SIDE_BY_SIDE_MIN_WIDTH = 768;

export default function SettingsLayout(): React.JSX.Element {
  const { width } = useWindowDimensions();
  const sideBySide = width >= SIDE_BY_SIDE_MIN_WIDTH;

  return (
    /* No background of its own: the navigator container behind it is painted with the app theme
       by the root layout's React Navigation ThemeProvider (item #243). Before that existed it was
       React Navigation's light default, and this layout painted over it. */
    <View style={sideBySide ? styles.containerRow : styles.container}>
      <View style={sideBySide ? styles.navRail : styles.navStacked}>
        <SettingsNav compact={!sideBySide} />
      </View>
      {/* `Slot`, NOT a nested `Stack`. research.md §R4 specified a nested Stack; on native that
          made this the first nested navigator in the app (collections/[collectionId]/ has no
          _layout.tsx) and the settings areas never became visible — CI run 2040 failed
          `settings-profile-screen is visible` 3/3 while the tap on `nav-settings` succeeded, a
          failure the web tier cannot see.

          A Slot is also the RIGHT primitive here rather than merely a workaround: the settings
          areas are a tab row navigated with `router.replace`, so they deliberately keep no
          history of their own. A stack navigator exists to provide push/pop history and native
          screen transitions, both of which this row explicitly does not want.

          Still wrapped in a flex:1 View: React Native Web needs an explicit height on the parent
          or the routed content collapses to 0 px, the same reason (app)/_layout.tsx documents. */}
      <View style={styles.stack}>
        <Slot />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  containerRow: { flex: 1, flexDirection: 'row' },
  // Fixed rail: the list must not shrink to its content or the rows lose their shared width,
  // and must not grow with the longest label or the content column jumps between areas.
  navRail: { width: 240, paddingVertical: 12, paddingHorizontal: 12 },
  navStacked: { width: '100%', paddingVertical: 8, paddingHorizontal: 8 },
  stack: { flex: 1 },
});
