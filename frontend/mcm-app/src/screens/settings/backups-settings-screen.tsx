/**
 * BackupsSettingsScreen — the Backups area of the settings destination.
 *
 * Feature 062 shipped this as a placeholder specifically so that backlog item #236 would
 * replace its BODY and touch nothing else. That is what this is: the route, its registry row,
 * its label and its reported `current_screen` (`settings-backups`) are all UNCHANGED. The
 * agent gateway's current_screen vocabulary is a contract covered by
 * test_current_screen_contract.py, and altering it here would break the assistant's context
 * resolution for a screen the assistant does not otherwise care about.
 *
 * Feature 073, US1: configure destinations. Jobs, runs and restore land on top of this in the
 * user stories that follow, in the same screen.
 */

import React, { useState } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { Card, CardHeader, CardContent, CardActions, FilledButton, Banner } from '@mcm/design-system';

import { DestinationForm } from '@/components/backups/destination-form';
import { DestinationList } from '@/components/backups/destination-list';
import { useBackupDestinations, type DestinationDraft } from '@/hooks/use-backup-destinations';
import type { BackupDestinationView, BackupTestResult } from '@/types/backups';

export function BackupsSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { destinations, loading, busy, error, create, update, remove, test } = useBackupDestinations();

  const [editing, setEditing] = useState<BackupDestinationView | null>(null);
  const [adding, setAdding] = useState(false);
  const [testResult, setTestResult] = useState<BackupTestResult | null>(null);

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
    setTestResult(null);
  };

  const submit = async (draft: DestinationDraft) => {
    const saved = editing ? await update(editing.id, draft) : await create(draft);
    if (saved) closeForm();
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background?.val }]}
      contentContainerStyle={styles.content}
      /* STABLE EXTERNAL-CONTRACT SELECTOR — the Backups area container. Unchanged from 062. */
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
            Back up your collections to storage you control. MCM writes the backup and keeps no
            copy of it, so you can read or restore it without depending on this system.
          </Text>
        </CardContent>
      </Card>

      {error ? (
        <View style={styles.section}>
          <Banner tone="error" testID="backup-error-banner">
            {error}
          </Banner>
        </View>
      ) : null}

      <View style={styles.section}>
        {adding || editing ? (
          <DestinationForm
            existing={editing}
            busy={busy}
            testResult={testResult}
            onSubmit={submit}
            onTest={async (draft) => setTestResult(await test(draft))}
            onCancel={closeForm}
          />
        ) : (
          <Card>
            <CardHeader title="Destinations" subtitle="Where your backups are written" />
            <CardContent>
              {loading ? (
                <Text fontFamily="$body" fontSize={14} color={theme.onSurfaceVariant?.val}>
                  Loading your destinations…
                </Text>
              ) : (
                <DestinationList
                  destinations={destinations}
                  busy={busy}
                  onEdit={(d) => {
                    setTestResult(null);
                    setEditing(d);
                  }}
                  onDelete={(d) => remove(d.id)}
                  onTest={async (d) => setTestResult(await test({ destinationId: d.id }))}
                />
              )}
            </CardContent>
            <CardActions>
              <FilledButton
                label="Add a destination"
                onPress={() => setAdding(true)}
                disabled={busy}
                testID="backup-destination-add"
              />
            </CardActions>
          </Card>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Layout only, on the base-8 grid. Every colour and type decision is made at the JSX site
  // from theme roles, so a declared style cannot drift from the rendered colour.
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 96 },
  section: { marginTop: 16 },
});
