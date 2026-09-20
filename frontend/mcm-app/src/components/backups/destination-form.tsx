/**
 * DestinationForm — add or edit a backup destination (feature 073, US1 / FR-001..FR-005).
 *
 * THE SECRET FIELD IS THE DESIGN DECISION HERE. On edit it renders EMPTY, with supporting text
 * saying the stored credential is kept. It is deliberately NOT a row of dots: a masked
 * stand-in tells the user a value was fetched and is sitting in the page, and nothing was —
 * the server never returns it. Showing dots would be a small lie about where their credential
 * is, in the one screen where that matters most.
 *
 * Every colour, space and type decision comes from the design system. No raw values.
 */
import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import {
  Card,
  CardHeader,
  CardContent,
  CardActions,
  TextField,
  FilledButton,
  OutlinedButton,
  TextButton,
  Chip,
  Banner,
} from '@mcm/design-system';

import type { DestinationDraft } from '@/hooks/use-backup-destinations';
import type { BackupDestinationView, BackupTestResult } from '@/types/backups';

export interface DestinationFormProps {
  /** Present when editing; absent when adding. */
  existing?: BackupDestinationView | null;
  busy?: boolean;
  onSubmit: (draft: DestinationDraft) => void | Promise<void>;
  onTest: (draft: DestinationDraft) => void | Promise<void>;
  onCancel: () => void;
  testResult?: BackupTestResult | null;
}

export function DestinationForm({
  existing = null,
  busy = false,
  onSubmit,
  onTest,
  onCancel,
  testResult = null,
}: DestinationFormProps): React.JSX.Element {
  const theme = useTheme();
  const editing = Boolean(existing);

  const [type, setType] = useState<'s3' | 'webdav'>(existing?.type ?? 's3');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [endpoint, setEndpoint] = useState(existing?.endpoint ?? '');
  const [basePath, setBasePath] = useState(existing?.basePath ?? 'mcm-backups');
  const [bucket, setBucket] = useState((existing as { bucket?: string })?.bucket ?? '');
  const [region, setRegion] = useState((existing as { region?: string })?.region ?? 'us-east-1');
  const [accessKeyId, setAccessKeyId] = useState((existing as { accessKeyId?: string })?.accessKeyId ?? '');
  const [username, setUsername] = useState((existing as { username?: string })?.username ?? '');
  // Always starts empty, including on edit. See the note at the top of this file.
  const [secret, setSecret] = useState('');

  function draft(): DestinationDraft {
    const common = { type, label, endpoint, basePath };
    // The secret is included ONLY when the user typed one. Sending an empty string is rejected
    // by the server rather than treated as a clear, and omitting it preserves what is stored.
    const withSecret = secret ? { secret } : {};
    return type === 's3'
      ? { ...common, bucket, region, pathStyle: true, accessKeyId, ...withSecret }
      : { ...common, username, ...withSecret };
  }

  const canSubmit =
    label.trim() !== '' &&
    endpoint.trim() !== '' &&
    (type === 's3' ? bucket.trim() !== '' && accessKeyId.trim() !== '' : username.trim() !== '') &&
    // A NEW destination must carry a secret; an edit may omit it to keep the stored one.
    (editing || secret !== '');

  return (
    <Card testID="backup-destination-form">
      <CardHeader
        title={editing ? 'Edit destination' : 'Add a destination'}
        subtitle="Storage you control. MCM writes backups here and never keeps a copy."
      />
      <CardContent>
        <View style={styles.typeRow}>
          <Chip
            label="S3-compatible"
            selected={type === 's3'}
            onPress={() => setType('s3')}
            disabled={editing}
            testID="backup-destination-type-s3"
          />
          <Chip
            label="WebDAV"
            selected={type === 'webdav'}
            onPress={() => setType('webdav')}
            disabled={editing}
            testID="backup-destination-type-webdav"
          />
        </View>

        <TextField
          label="Name"
          value={label}
          onChangeText={setLabel}
          supportingText="How this destination appears when you choose one"
          maxCount={64}
          required
          testID="backup-destination-label"
        />
        <TextField
          label="Address"
          value={endpoint}
          onChangeText={setEndpoint}
          autoCapitalize="none"
          supportingText="An https:// address. A device on your own network must be allow-listed by an administrator."
          required
          testID="backup-destination-endpoint"
        />
        <TextField
          label="Folder"
          value={basePath}
          onChangeText={setBasePath}
          autoCapitalize="none"
          supportingText="Backups are written beneath this path"
          testID="backup-destination-base-path"
        />

        {type === 's3' ? (
          <>
            <TextField
              label="Bucket"
              value={bucket}
              onChangeText={setBucket}
              autoCapitalize="none"
              required
              testID="backup-destination-bucket"
            />
            <TextField
              label="Region"
              value={region}
              onChangeText={setRegion}
              autoCapitalize="none"
              supportingText="Self-hosted stores usually ignore this, but a value is required"
              testID="backup-destination-region"
            />
            <TextField
              label="Access key ID"
              value={accessKeyId}
              onChangeText={setAccessKeyId}
              autoCapitalize="none"
              required
              testID="backup-destination-access-key-id"
            />
          </>
        ) : (
          <TextField
            label="Username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            required
            testID="backup-destination-username"
          />
        )}

        <TextField
          label={type === 's3' ? 'Secret access key' : 'Password'}
          value={secret}
          onChangeText={setSecret}
          secureTextEntry
          autoCapitalize="none"
          required={!editing}
          supportingText={
            editing
              ? 'Leave blank to keep the credential already stored. It is never sent back to this page.'
              : 'Stored encrypted. It is never shown again after you save.'
          }
          testID="backup-destination-secret"
        />

        {testResult ? (
          <View style={styles.result}>
            <Banner tone={testResult.ok ? 'success' : 'error'} testID="backup-destination-test-result">
              {testResult.ok
                ? 'Reached that destination and confirmed it can be written to.'
                : testResult.reason}
            </Banner>
          </View>
        ) : null}
      </CardContent>
      <CardActions>
        <TextButton label="Cancel" onPress={onCancel} disabled={busy} testID="backup-destination-cancel" />
        <OutlinedButton
          label="Test"
          onPress={() => onTest(draft())}
          disabled={busy || !canSubmit}
          testID="backup-destination-test"
        />
        <FilledButton
          label="Save"
          onPress={() => onSubmit(draft())}
          disabled={busy || !canSubmit}
          testID="backup-destination-save"
        />
      </CardActions>
      {!canSubmit && !editing ? (
        <CardContent>
          <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val}>
            Fill in every required field to save or test this destination.
          </Text>
        </CardContent>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  // Layout only — base-8 grid. Colour and type are decided at the JSX site from theme roles so
  // a declared style cannot drift from the rendered colour.
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  result: { marginTop: 16 },
});
