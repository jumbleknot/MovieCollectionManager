/**
 * Profile screen component (T-084)
 * Calls useAuth hook, displays profile, includes logout button.
 */

import React from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { LoadingIndicator } from '@/components/loading-indicator';
import { ProfileDisplay } from '@/components/profile-display';
import { MovieAssistantConfig } from '@/components/agent/movie-assistant-config';
import { useAuth } from '@/hooks/use-auth';

export function ProfileScreen(): React.JSX.Element {
  const { user, isLoading, logout } = useAuth();
  const theme = useTheme();

  if (isLoading) {
    return <LoadingIndicator message="Loading profile..." testID="profile-loading" />;
  }

  if (!user) return <View style={[styles.container, { backgroundColor: theme.background?.val }]} testID="profile-screen-empty" />;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background?.val }]}
      contentContainerStyle={styles.content}
      testID="profile-screen"
    >
      <ProfileDisplay user={user} onLogout={logout} />
      <MovieAssistantConfig />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // paddingBottom clears the floating assistant-dock toggle (a bottom overlay shown for a runnable
  // config). Without it the last form control — the assistant-config Save button — sits flush at the
  // bottom of the scroll, underneath the dock toggle, so it can't be fully scrolled into view/tapped.
  content: { flexGrow: 1, paddingBottom: 96 },
});
