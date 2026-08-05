/**
 * ImportProgress (047 US3 / FR-014a) — the single in-place line shown while an import applies.
 *
 * ONE surface per run that UPDATES, never a message per batch. That distinction is the whole
 * requirement: a 2,000-row import that posts a line per chunk buries the conversation, which is
 * the defect FR-014a exists to remove. When the run ends the surface disappears and the assistant's
 * report takes its place (FR-014b) — this component renders nothing once the run is over.
 *
 * TRANSPORT-AGNOSTIC BY DESIGN. It takes numbers as props and knows nothing about AG-UI, agent
 * state, or tool calls. RQ-2 settled the transport as `STATE_SNAPSHOT` carrying
 * `import_applied` / `import_total` / `import_run_id`, and the dock does that subscription — but
 * that decision must not be baked in here, because it is the part most likely to change (the
 * gateway emits snapshots today and may emit deltas later) and re-testing a pure component is
 * free while re-testing a subscribed one is not.
 *
 * Universal Generative UI (constitution): one React Native component rendering identically on web
 * (react-native-web) and Android.
 */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';

export type ImportProgressProps = {
  /** Rows processed so far — applied, skipped and failed alike (see the note below). */
  applied: number;
  /** Rows in the run. Zero or absent means no run is in flight. */
  total: number;
};

/**
 * `applied` counts rows PROCESSED, not rows created. A run containing duplicates would otherwise
 * finish at "1,400 of 2,000" and read as stalled — the gateway counts processed for exactly this
 * reason, and the label here follows it rather than promising something narrower.
 */
export function ImportProgress({ applied, total }: ImportProgressProps) {
  const theme = useTheme();
  const styles = makeStyles(theme);

  // FR-014b: no run in flight → render nothing at all. The assistant's report is the surface now.
  if (!total || total <= 0) return null;

  const bounded = Math.max(0, Math.min(applied, total));
  const pct = Math.round((bounded / total) * 100);

  return (
    <View style={styles.row} testID="import-progress" accessibilityRole="progressbar">
      <ActivityIndicator size="small" color={String(theme.primary?.val ?? '#7c4dff')} />
      <View style={styles.body}>
        <Text style={styles.label} testID="import-progress-label">
          {`Importing ${bounded.toLocaleString()} of ${total.toLocaleString()}…`}
        </Text>
        <View style={styles.track} testID="import-progress-track">
          <View style={[styles.fill, { width: `${pct}%` }]} testID="import-progress-fill" />
        </View>
      </View>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
    body: { flex: 1, gap: 6 },
    label: { fontFamily: 'Inter', fontSize: 14, color: String(theme.color?.val ?? '#fff') },
    track: {
      height: 4,
      borderRadius: 2,
      overflow: 'hidden',
      backgroundColor: String(theme.borderColor?.val ?? 'rgba(255,255,255,0.16)'),
    },
    fill: { height: '100%', backgroundColor: String(theme.primary?.val ?? '#7c4dff') },
  });
}
