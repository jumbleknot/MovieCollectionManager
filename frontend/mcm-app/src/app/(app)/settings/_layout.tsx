/**
 * Settings route-group layout (feature 062) — FR-003.
 *
 * Renders the shared sub-navigation above a nested Stack, mirroring the shape of
 * (app)/_layout.tsx one level down. Composes navigation only: it holds no screen content,
 * because routes never define screen components (constitution §Frontend App-Layer).
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
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { SettingsNav } from '@/components/settings/settings-nav';

export default function SettingsLayout(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <SettingsNav />
      {/* Wrap Stack in a flex:1 View so screens fill the remaining height on web.
          React Native Web's absolutely-positioned screen containers require an explicit
          height on their parent; without it the Stack collapses to 0 px and every settings
          area's content is clipped (overflow:hidden). Same reason (app)/_layout.tsx does it. */}
      <View style={styles.stack}>
        <Stack screenOptions={{ headerShown: false }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  stack: { flex: 1 },
});
