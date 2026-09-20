/**
 * RunHistory — what happened, and when (feature 073, US6).
 *
 * A FAILED run is shown as prominently as a successful one. A backup that silently stopped
 * working is the failure mode this whole feature exists to prevent, and a failure the user
 * never sees is a failure twice — once when the backup did not happen, and again when they
 * find out at restore.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { Card, CardHeader, CardContent, Badge, Banner } from '@mcm/design-system';

import type { RunSummary } from '@/types/backups';

export interface RunHistoryProps {
  runs: RunSummary[];
  lastRun?: RunSummary;
}

const TONE: Record<string, 'primary' | 'error' | 'tertiary'> = {
  success: 'primary',
  failed: 'error',
  partial: 'tertiary',
  running: 'tertiary',
};

export function RunHistory({ runs, lastRun }: RunHistoryProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View testID="backup-run-history">
      {lastRun && lastRun.status === 'failed' ? (
        <View style={styles.banner}>
          {/* Surfaced at the top, not buried in a list — this is the thing the user must act on. */}
          <Banner tone="error" testID="backup-failure-banner">
            {`The last backup failed: ${lastRun.failureReason ?? 'reason unavailable'}`}
          </Banner>
        </View>
      ) : null}

      <Card>
        <CardHeader title="Recent runs" subtitle="The last few backups for this job" />
        <CardContent>
          {runs.length === 0 ? (
            <Text fontFamily="$body" fontSize={14} color={theme.onSurfaceVariant?.val}>
              This job has not run yet.
            </Text>
          ) : (
            runs.map((run) => (
              <View key={run.runId} style={styles.row} testID={`backup-run-${run.runId}`}>
                <Badge inline count={run.status} colorScheme={TONE[run.status] ?? 'tertiary'} />
                <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val}>
                  {`${run.startedAt} · ${run.movieCount} movies in ${run.collectionCount} collections`}
                  {run.failureReason ? ` · ${run.failureReason}` : ''}
                  {/* Prune failures are reported SEPARATELY from the run's status: a prune that
                      failed has not cost the user the backup that was just written. */}
                  {run.pruneFailureReason ? ` · older versions were not removed: ${run.pruneFailureReason}` : ''}
                </Text>
              </View>
            ))
          )}
        </CardContent>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { marginBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
});
