/**
 * Authenticated app layout (T-085)
 * Wraps all (app) routes with AuthGuard + NavigationBar.
 * Child routes render screen content only — no nav bar needed per-screen.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { AuthGuard } from '@/components/auth-guard';
import { NavigationBar } from '@/components/navigation-bar';

export default function AppLayout(): React.JSX.Element {
  return (
    <AuthGuard>
      <View style={styles.container}>
        <NavigationBar />
        <Stack screenOptions={{ headerShown: false }} />
      </View>
    </AuthGuard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
});
