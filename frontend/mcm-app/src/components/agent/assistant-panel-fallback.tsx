/**
 * What the dock shows while its panel chunk is arriving, or after it failed (feature 077).
 *
 * These two states exist only because the panel is no longer in the entry chunk. They are small on
 * purpose: they live in the EAGER graph, so anything imported here is paid for by every user on
 * every route — which is the cost this feature exists to remove. Design-system primitives only, no
 * agent code, nothing from `@copilotkit/*`.
 *
 * The error state is a real state, not a courtesy. A chunk fetch can fail on a flaky connection or
 * after a deploy replaces the hashed filename mid-session, and the assistant must stay openable
 * afterwards (FR-006) — hence an explicit Retry rather than asking the user to reload the page.
 */
import React from 'react';
import { View, Text } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button } from '@mcm/design-system';

type Theme = ReturnType<typeof useTheme>;

export function AssistantPanelLoading(): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View testID="assistant-dock-panel-loading" style={styles.panel} accessibilityRole="progressbar">
      <Text style={styles.text}>Starting the assistant…</Text>
    </View>
  );
}

export function AssistantPanelError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View testID="assistant-dock-panel-error" style={styles.panel}>
      <Text style={styles.text}>The assistant could not be loaded.</Text>
      <View style={styles.actions}>
        <Button testID="assistant-dock-panel-retry" label="Try again" onPress={onRetry} />
      </View>
    </View>
  );
}

// Style objects at the bottom of the file (constitution, Components-Layer). The panel box matches
// `assistant-panel.tsx`'s so the dock does not resize as it moves between these states and the
// real panel.
const makeStyles = (theme: Theme) => ({
  panel: {
    width: 320,
    marginTop: 8,
    backgroundColor: theme.surface1?.val,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.outlineVariant?.val,
    padding: 16,
    gap: 12,
  },
  text: { color: theme.onSurface?.val, fontFamily: 'Inter' },
  actions: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const },
});
