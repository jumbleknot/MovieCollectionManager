/**
 * AccountDeletedScreen — the public confirmation shown after a deletion (feature 076 — FR-030).
 *
 * PUBLIC BY NECESSITY, not by oversight. It sits at the route root alongside `auth-callback`,
 * outside `(app)` and `(auth)`, because by the time a user arrives here their session is gone.
 * A guarded route would bounce them to a login screen — which, at the end of a deletion, reads
 * as "it failed".
 *
 * It closes the loop on the promise the confirmation dialog made: the files at the user's own
 * storage were left alone. That is the last chance to say so, and the user has no account left
 * from which to check.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { useRouter } from 'expo-router';
import { TextButton } from '@mcm/design-system';

export function AccountDeletedScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();

  return (
    <View
      style={[styles.container, { backgroundColor: theme.background?.val }]}
      /* STABLE EXTERNAL-CONTRACT SELECTOR — asserted by the web E2E. */
      testID="account-deleted-confirmation"
    >
      <Text style={[styles.title, { color: theme.color?.val }]}>Your account has been deleted</Text>

      <Text style={[styles.body, { color: theme.color?.val }]}>
        Your collections, backup settings and assistant configuration have been permanently
        removed, and the permission this app held to act on your behalf has been withdrawn.
      </Text>

      <Text style={[styles.body, { color: theme.color?.val }]}>
        The backup files at your own storage were left untouched. They are yours, and you still
        have the credentials to reach them.
      </Text>

      <TextButton
        testID="account-deleted-home"
        label="Back to the start"
        onPress={() => router.replace('/')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontFamily: 'Outfit-Bold', fontSize: 22, fontWeight: '700' },
  // 16, not 15: the MD3 scale is a closed set and the compliance scan enforces it.
  body: { fontFamily: 'Inter', fontSize: 16, lineHeight: 22 },
});
