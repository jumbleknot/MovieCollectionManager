/**
 * AssistantSettingsScreen — the Movie Assistant area of the settings destination (feature 062).
 *
 * FR-006. Hosts the existing MovieAssistantConfig unchanged, so saving a configuration still
 * refreshes the assistant's availability in the same session — AssistantConfigProvider stays
 * in (app)/_layout.tsx, above this Stack and above the dock gate (research.md §R7).
 */

import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { MovieAssistantConfig } from '@/components/agent/movie-assistant-config';

export function AssistantSettingsScreen(): React.JSX.Element {
  const theme = useTheme();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background?.val }]}
      contentContainerStyle={styles.content}
      /* STABLE EXTERNAL-CONTRACT SELECTOR — the Movie Assistant area container. */
      testID="settings-assistant-screen"
    >
      <MovieAssistantConfig />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // paddingBottom gives scroll room BELOW the assistant-config actions row so the Save button (the
  // last control, bottom-left — same spot as the floating dock toggle overlay) can be scrolled UP
  // off the bottom and clear of that overlay. The mobile E2E scrolls Save with centerElement, which
  // needs this room; without it Save stops flush at the bottom under the dock toggle and the tap is
  // swallowed by the overlay (no save, no banner). It travelled here with the config, not onto the
  // profile area, because it is the config's Save button it exists for.
  content: { flexGrow: 1, paddingBottom: 180 },
});
