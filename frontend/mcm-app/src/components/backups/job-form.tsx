/**
 * JobForm — what to back up, where, and how many versions to keep (feature 073, US2 / FR-007).
 *
 * Leaving the collection selection EMPTY means "everything I own, at the time each backup
 * runs" — stated in the form, because the alternative reading ("everything I own today") is
 * the one a user would assume, and it is the wrong one.
 */
import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { Card, CardHeader, CardContent, CardActions, TextField, Chip, FilledButton, TextButton } from '@mcm/design-system';

import type { BackupDestinationView } from '@/types/backups';
import type { JobDraft, JobView } from '@/hooks/use-backup-jobs';

export interface JobFormProps {
  destinations: BackupDestinationView[];
  collections: { id: string; name: string }[];
  existing?: JobView | null;
  busy?: boolean;
  onSubmit: (draft: JobDraft) => void | Promise<void>;
  onCancel: () => void;
}

export function JobForm({
  destinations,
  collections,
  existing = null,
  busy = false,
  onSubmit,
  onCancel,
}: JobFormProps): React.JSX.Element {
  const theme = useTheme();
  const [label, setLabel] = useState(existing?.label ?? '');
  const [destinationId, setDestinationId] = useState(existing?.destinationId ?? destinations[0]?.id ?? '');
  const [selected, setSelected] = useState<string[]>(existing?.collectionIds ?? []);
  const [keepLast, setKeepLast] = useState(String(existing?.keepLast ?? 7));

  const keepLastNumber = Number.parseInt(keepLast, 10);
  const keepLastValid = Number.isInteger(keepLastNumber) && keepLastNumber >= 1 && keepLastNumber <= 365;
  const canSubmit = label.trim() !== '' && destinationId !== '' && keepLastValid;

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]));

  return (
    <Card testID="backup-job-form">
      <CardHeader title={existing ? 'Edit backup' : 'Set up a backup'} subtitle="What to back up, and where" />
      <CardContent>
        <TextField
          label="Name"
          value={label}
          onChangeText={setLabel}
          maxCount={64}
          required
          testID="backup-job-label"
        />

        <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val} marginTop={16}>
          Destination
        </Text>
        <View style={styles.chipRow}>
          {destinations.map((destination) => (
            <Chip
              key={destination.id}
              label={destination.label}
              selected={destinationId === destination.id}
              onPress={() => setDestinationId(destination.id)}
              testID={`backup-job-destination-${destination.id}`}
            />
          ))}
        </View>

        <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val} marginTop={16}>
          Collections
        </Text>
        <View style={styles.chipRow}>
          {collections.map((collection) => (
            <Chip
              key={collection.id}
              label={collection.name}
              selected={selected.includes(collection.id)}
              onPress={() => toggle(collection.id)}
              testID={`backup-job-collection-${collection.id}`}
            />
          ))}
        </View>
        <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val} marginTop={8}>
          {selected.length === 0
            ? 'Nothing selected — every collection you own will be backed up, including ones you add later.'
            : `${selected.length} selected.`}
        </Text>

        <TextField
          label="Versions to keep"
          value={keepLast}
          onChangeText={setKeepLast}
          keyboardType="number-pad"
          error={keepLast !== '' && !keepLastValid}
          errorText="Choose a whole number between 1 and 365"
          supportingText="Older backups beyond this are removed after a successful new one"
          testID="backup-job-keep-last"
        />
      </CardContent>
      <CardActions>
        <TextButton label="Cancel" onPress={onCancel} disabled={busy} testID="backup-job-cancel" />
        <FilledButton
          label="Save"
          onPress={() =>
            onSubmit({
              destinationId,
              label,
              collectionIds: selected,
              keepLast: keepLastNumber,
              enabled: existing?.enabled ?? true,
            })
          }
          disabled={busy || !canSubmit}
          testID="backup-job-save"
        />
      </CardActions>
    </Card>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
});
