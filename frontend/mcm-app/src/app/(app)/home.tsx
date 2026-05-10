/**
 * Home route — authenticated users' landing page.
 * Protected by AuthGuard; displays navigation and profile summary.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { AuthGuard } from '@/components/auth-guard';
import { NavigationBar } from '@/components/navigation-bar';
import { ProfileDisplay } from '@/components/profile-display';
import { useAuth } from '@/hooks/use-auth';

export default function HomeRoute(): React.JSX.Element {
  const { user, logout } = useAuth();

  return (
    <AuthGuard>
      <View style={styles.container} testID="home-route">
        <NavigationBar />
        {user && (
          <View style={styles.content}>
            <ProfileDisplay user={user} onLogout={logout} />
          </View>
        )}
      </View>
    </AuthGuard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { flex: 1, padding: 16 },
});
