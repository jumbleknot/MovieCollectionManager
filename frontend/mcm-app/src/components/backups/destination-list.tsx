/**
 * DestinationList — the caller's configured backup destinations (feature 073, US1).
 *
 * Shows what each destination IS and when it was last verified, and nothing that could be a
 * credential. The last test result is surfaced because a destination that stopped accepting
 * writes is the failure a user needs to see BEFORE the next scheduled run, not after it.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { Card, CardHeader, CardContent, CardActions, TextButton, OutlinedButton, Badge } from '@mcm/design-system';

import type { BackupDestinationView } from '@/types/backups';

export interface DestinationListProps {
  destinations: BackupDestinationView[];
  busy?: boolean;
  onEdit: (destination: BackupDestinationView) => void;
  onDelete: (destination: BackupDestinationView) => void;
  onTest: (destination: BackupDestinationView) => void;
}

function describe(destination: BackupDestinationView): string {
  if (destination.type === 's3') {
    const d = destination as BackupDestinationView & { bucket?: string };
    return `S3 · ${d.bucket ?? ''} · ${destination.endpoint}`;
  }
  return `WebDAV · ${destination.endpoint}`;
}

export function DestinationList({
  destinations,
  busy = false,
  onEdit,
  onDelete,
  onTest,
}: DestinationListProps): React.JSX.Element {
  const theme = useTheme();

  if (destinations.length === 0) {
    return (
      <Card testID="backup-destination-list-empty">
        <CardContent>
          <Text fontFamily="$body" fontSize={14} lineHeight={20} color={theme.onSurfaceVariant?.val}>
            No destinations yet. Add storage you control — an S3-compatible bucket or a WebDAV
            server — and MCM will write your backups there.
          </Text>
        </CardContent>
      </Card>
    );
  }

  return (
    <View testID="backup-destination-list">
      {destinations.map((destination) => (
        <View key={destination.id} style={styles.item}>
          <Card testID={`backup-destination-${destination.id}`}>
            <CardHeader title={destination.label} subtitle={describe(destination)} />
            <CardContent>
              {destination.lastTestResult ? (
                <View style={styles.statusRow}>
                  <Badge
                    inline
                    count={destination.lastTestResult.ok ? 'Verified' : 'Not reachable'}
                    colorScheme={destination.lastTestResult.ok ? 'primary' : 'error'}
                    testID={`backup-destination-status-${destination.id}`}
                  />
                  <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val}>
                    {destination.lastTestResult.ok
                      ? `Last checked ${destination.lastTestedAt ?? ''}`
                      : destination.lastTestResult.reason}
                  </Text>
                </View>
              ) : (
                <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val}>
                  Not tested yet.
                </Text>
              )}
            </CardContent>
            <CardActions>
              <OutlinedButton
                label="Test"
                onPress={() => onTest(destination)}
                disabled={busy}
                testID={`backup-destination-test-${destination.id}`}
              />
              <TextButton
                label="Edit"
                onPress={() => onEdit(destination)}
                disabled={busy}
                testID={`backup-destination-edit-${destination.id}`}
              />
              <TextButton
                label="Delete"
                danger
                onPress={() => onDelete(destination)}
                disabled={busy}
                testID={`backup-destination-delete-${destination.id}`}
              />
            </CardActions>
          </Card>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { marginBottom: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
