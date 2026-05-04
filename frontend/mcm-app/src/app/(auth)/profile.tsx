/**
 * Profile route (T-086)
 * Protected route — renders ProfileScreen wrapped in AuthGuard.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { AuthGuard } from '@/components/auth-guard';
import { ProfileScreen } from '@/screens/auth/profile-screen';

export default function ProfileRoute(): React.JSX.Element {
  return (
    <AuthGuard>
      <View style={styles.container} testID="profile-route">
        <ProfileScreen />
      </View>
    </AuthGuard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
});
