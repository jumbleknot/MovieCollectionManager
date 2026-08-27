/**
 * BackupsSettingsScreen — the Backups area of the settings destination (feature 062).
 *
 * FR-007 / US3-AC1. A placeholder, deliberately: this feature delivers no backup capability.
 * It exists so backlog item #236 (per-user collection backups) replaces this screen's BODY and
 * touches no other area, no route, and no sub-navigation row — the extension property SC-006
 * asks this feature to demonstrate.
 *
 * Composed entirely from the design system's Card primitives: `CardHeader` names the area and
 * `CardContent` carries the body copy. Body text does NOT sit loose in the screen with hand-rolled
 * margin — `CardContent` is what the design system provides for it, and reaching past it would be
 * the kind of bypass the constitution's Design System principle prohibits.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { Card, CardHeader, CardContent } from '@mcm/design-system';

export function BackupsSettingsScreen(): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[styles.container, { backgroundColor: theme.background?.val }]}
      /* STABLE EXTERNAL-CONTRACT SELECTOR — the Backups area container. */
      testID="settings-backups-screen"
    >
      <Card>
        <CardHeader title="Backups" subtitle="Back up and restore your collections" />
        <CardContent>
          <Text
            fontFamily="$body"
            fontSize={14}
            lineHeight={20}
            letterSpacing={0.25}
            color={theme.onSurfaceVariant?.val}
          >
            Scheduled collection backups are not yet available. This area is reserved for them.
          </Text>
        </CardContent>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  // Layout only — every colour and type decision is made at the JSX site from theme roles, so a
  // declared style cannot drift from the rendered colour (feature 017 D6). Padding is on the
  // base-8 grid the constitution's Consistency rule requires.
  container: { flex: 1, padding: 16 },
});
