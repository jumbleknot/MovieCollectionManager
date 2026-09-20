/**
 * VersionList — the backups actually present at the destination (feature 073, US3 / FR-028).
 *
 * A version that is present but UNUSABLE is shown, greyed, with Restore disabled and a reason.
 * Hiding it would misdescribe the user's own storage — the object is really there, taking
 * space — and offering it would send them to a failure at the moment they are already in
 * trouble. Download stays available for an unusable version: the bytes are theirs, and a
 * corrupt file is sometimes still worth recovering by hand.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { Card, CardHeader, CardContent, CardActions, FilledButton, TextButton, Badge } from '@mcm/design-system';

import type { BackupVersion } from '@/types/backups';

export interface VersionListProps {
  versions: BackupVersion[];
  busy?: boolean;
  onRestore: (version: BackupVersion) => void;
  downloadUrl: (key: string) => string;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VersionList({ versions, busy = false, onRestore, downloadUrl }: VersionListProps): React.JSX.Element {
  const theme = useTheme();

  if (versions.length === 0) {
    return (
      <Card testID="backup-version-list-empty">
        <CardContent>
          <Text fontFamily="$body" fontSize={14} lineHeight={20} color={theme.onSurfaceVariant?.val}>
            No backups at this destination yet. Run this job once and its versions appear here.
          </Text>
        </CardContent>
      </Card>
    );
  }

  return (
    <View testID="backup-version-list">
      {versions.map((version) => (
        <View key={version.key} style={styles.item}>
          <Card testID={`backup-version-${version.key}`}>
            <CardHeader
              title={version.createdAt}
              subtitle={`${sizeLabel(version.sizeBytes)} · ${version.key.split('/').pop() ?? ''}`}
            />
            {!version.usable ? (
              <CardContent>
                <View style={styles.statusRow}>
                  <Badge inline count="Unreadable" colorScheme="error" testID={`backup-version-unusable-${version.key}`} />
                  <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val}>
                    This file is at your destination but cannot be read, so it cannot be restored.
                    You can still download it.
                  </Text>
                </View>
              </CardContent>
            ) : null}
            <CardActions>
              <FilledButton
                label="Restore"
                onPress={() => onRestore(version)}
                // Disabled rather than absent: the user can see the option exists and why it
                // is not available, instead of wondering where it went for this one row.
                disabled={busy || !version.usable}
                testID={`backup-version-restore-${version.key}`}
              />
              <TextButton
                label="Download"
                onPress={() => {
                  // A plain navigation so the browser's own download handling takes over.
                  if (typeof window !== 'undefined') window.location.assign(downloadUrl(version.key));
                }}
                disabled={busy}
                testID={`backup-version-download-${version.key}`}
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
