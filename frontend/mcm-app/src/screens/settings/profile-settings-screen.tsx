/**
 * ProfileSettingsScreen — the Profile area of the settings destination (feature 062).
 *
 * FR-005. Split out of the pre-split screens/auth/profile-screen.tsx, which stacked three
 * unrelated cards on one scrolling page. This carries the profile details and the logout
 * control and nothing else; the assistant configuration moved to AssistantSettingsScreen and
 * the admin-settings card was deleted outright — the sub-navigation entry replaces it.
 *
 * The paddingBottom scroll allowance deliberately did NOT come with this screen; it exists for
 * the assistant config's Save button and lives there. See assistant-settings-screen.tsx.
 */

import React from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { LoadingIndicator } from '@/components/loading-indicator';
import { ProfileDisplay } from '@/components/profile-display';
import { useAuth } from '@/hooks/use-auth';

export function ProfileSettingsScreen(): React.JSX.Element {
  const { user, isLoading, logout } = useAuth();
  const theme = useTheme();

  if (isLoading) {
    // STABLE EXTERNAL-CONTRACT SELECTOR (renamed from `profile-loading`) — exempt from the
    // behaviour-descriptive-identifier rule under the constitution's E2E-selector carve-out.
    return <LoadingIndicator message="Loading profile..." testID="settings-profile-loading" />;
  }

  if (!user) {
    return (
      <View
        style={[styles.container, { backgroundColor: theme.background?.val }]}
        /* STABLE EXTERNAL-CONTRACT SELECTOR (renamed from `profile-screen-empty`). */
        testID="settings-profile-empty"
      />
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background?.val }]}
      contentContainerStyle={styles.content}
      /* STABLE EXTERNAL-CONTRACT SELECTOR (renamed from `profile-screen`). */
      testID="settings-profile-screen"
    >
      <ProfileDisplay user={user} onLogout={logout} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1 },
});
