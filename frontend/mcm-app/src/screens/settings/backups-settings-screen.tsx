/**
 * BackupsSettingsScreen — the Backups area of the settings destination (feature 062).
 *
 * FR-007 / US3-AC1. A placeholder, deliberately: this feature delivers no backup capability.
 * It exists so backlog item #236 (per-user collection backups) replaces this screen's BODY and
 * touches no other area, no route, and no sub-navigation row — the extension property SC-006
 * asks this feature to demonstrate.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { Card, CardHeader } from '@mcm/design-system';

export function BackupsSettingsScreen(): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[styles.container, { backgroundColor: theme.background?.val }]}
      /* STABLE EXTERNAL-CONTRACT SELECTOR — the Backups area container. */
      testID="settings-backups-screen"
    >
      <Card onPress={undefined}>
        <CardHeader
          title="Backups"
          subtitle="Back up and restore your collections — not yet available."
        />
      </Card>
      <Text
        fontFamily="$body"
        fontSize={14}
        color={theme.onSurfaceVariant?.val}
        marginTop={12}
      >
        Scheduled collection backups are not yet available. This area is reserved for them.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Layout only — colour and type come from theme tokens at the JSX site, never literals here,
  // so a declared style cannot drift from the rendered colour (feature 017 D6).
  container: { flex: 1, padding: 16 },
});
