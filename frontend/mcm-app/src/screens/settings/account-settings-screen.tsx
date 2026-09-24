/**
 * AccountSettingsScreen — the Account area of the settings destination (feature 076).
 *
 * FR-001, FR-003, FR-004, FR-029, FR-030. One purpose: permanently deleting your own account.
 *
 * THE DIALOG SAYS WHAT IS *NOT* DESTROYED, and that is not a courtesy. The backup files at the
 * user's own destination stay where they are — they are the user's property, at storage they own
 * and pay for. Saying so plainly is what a user is entitled to before an irreversible act, and
 * it is also what stops a later reader deciding the cleanup was left unfinished.
 *
 * NOTHING IS DELETED FROM HERE. Confirming only asks the BFF for an authorization URL and sends
 * the user to the identity provider. The deletion happens on the callback, after they have
 * proved who they are — there is no path from this screen to a destroyed account that does not
 * pass through a fresh authentication.
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet, View, Text } from 'react-native';
import { useTheme } from '@tamagui/core';
import { useLocalSearchParams } from 'expo-router';
import {
  Card,
  CardHeader,
  CardContent,
  CardActions,
  FilledButton,
  TextButton,
  Banner,
  Dialog,
} from '@mcm/design-system';
import { apiClient } from '@/bff-server/api-client';

/**
 * What the callback reports back through the query string.
 *
 * EVERY MESSAGE SAYS THE ACCOUNT STILL EXISTS. FR-028 forbids reporting partial success, and a
 * user left unsure whether they still have an account is the outcome to avoid above all others.
 */
const ERROR_MESSAGES: Record<string, string> = {
  reauth: 'We could not confirm it was you. Your account has not been deleted.',
  expired: 'That request timed out and your account has not been deleted. Start again below.',
  failed: 'Something went wrong and your account was not deleted. Please try again.',
  challenge: 'We could not start the deletion, so your account has not been deleted. Please try again.',
};

export function AccountSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const params = useLocalSearchParams<{ error?: string }>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  const error = challengeError ?? (params.error ? ERROR_MESSAGES[params.error] : undefined);

  async function startDeletion(): Promise<void> {
    setBusy(true);
    setChallengeError(null);
    try {
      const res = await apiClient.post<{ authorizationUrl: string }>(
        '/bff-api/account/delete-challenge',
      );
      setConfirming(false);
      // A full page navigation, not a fetch. This is an interactive sign-in at the identity
      // provider and it must happen in the user's own browser — the same mechanism the
      // backup-consent grant uses.
      if (typeof window !== 'undefined') window.location.assign(res.data.authorizationUrl);
    } catch {
      setConfirming(false);
      setChallengeError(ERROR_MESSAGES['challenge']!);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background?.val }]}
      contentContainerStyle={styles.content}
      /* STABLE EXTERNAL-CONTRACT SELECTOR — the Account area container. */
      testID="settings-account-screen"
    >
      {error ? (
        <View style={styles.banner}>
          <Banner testID="account-delete-error" tone="error">{error}</Banner>
        </View>
      ) : null}

      <Card testID="account-danger-zone">
        <CardHeader title="Delete account" />
        <CardContent>
          <Text style={[styles.body, { color: theme.color?.val }]}>
            Deleting your account is permanent. You will be asked to sign in again first, so that
            nobody else can do this on your behalf.
          </Text>
        </CardContent>
        <CardActions>
          <FilledButton
            testID="account-delete-button"
            label="Delete account"
            danger
            onPress={() => setConfirming(true)}
          />
        </CardActions>
      </Card>

      <Dialog
        visible={confirming}
        testID="account-delete-dialog"
        title="Delete your account?"
        onDismiss={() => setConfirming(false)}
        actions={[
          // Cancel first, so the safe choice is the one nearest to hand.
          <TextButton
            key="cancel"
            testID="account-delete-cancel"
            label="Cancel"
            onPress={() => setConfirming(false)}
          />,
          <FilledButton
            key="confirm"
            testID="account-delete-confirm"
            label="Delete my account"
            danger
            disabled={busy}
            onPress={startDeletion}
          />,
        ]}
      >
        <Text style={[styles.body, { color: theme.color?.val }]}>
          This will permanently delete your collections and the movies in them, your backup
          destinations and their saved credentials, your backup schedules and run history, your
          assistant settings, and your account.
        </Text>
        <Text style={[styles.body, styles.preserved, { color: theme.color?.val }]}>
          This will not touch the backup files at your own storage. They belong to you and stay
          where they are. You keep your storage credentials — what you lose is this app&apos;s
          ability to reach them.
        </Text>
      </Dialog>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1, padding: 16, gap: 16 },
  banner: { marginBottom: 8 },
  body: { fontFamily: 'Inter', fontSize: 14, lineHeight: 20 },
  // The preservation promise is given the same weight as the destruction list, not a footnote.
  preserved: { fontFamily: 'Inter', marginTop: 12, fontWeight: '600' },
});
