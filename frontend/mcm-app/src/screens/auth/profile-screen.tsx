/**
 * Profile screen component (T-084)
 * Calls useAuth hook, displays profile, includes logout button.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { LoadingIndicator } from '@/components/loading-indicator';
import { ProfileDisplay } from '@/components/profile-display';
import { useAuth } from '@/hooks/use-auth';

export function ProfileScreen(): React.JSX.Element {
  const { user, isLoading, logout } = useAuth();

  if (isLoading) {
    return <LoadingIndicator message="Loading profile..." testID="profile-loading" />;
  }

  if (!user) return <View style={styles.container} testID="profile-screen-empty" />;

  return (
    <View style={styles.container} testID="profile-screen">
      <ProfileDisplay user={user} onLogout={logout} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
});
