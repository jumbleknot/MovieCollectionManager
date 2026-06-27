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
  // paddingBottom gives scroll room BELOW the assistant-config actions row so the Save button (the
  // last control, bottom-left — same spot as the floating dock toggle overlay) can be scrolled UP
  // off the bottom and clear of that overlay. The mobile E2E scrolls Save with centerElement, which
  // needs this room; without it Save stops flush at the bottom under the dock toggle and the tap is
  // swallowed by the overlay (no save, no banner).
  content: { flexGrow: 1, paddingBottom: 180 },
});
