/**
 * Root layout — wraps the entire app in global providers.
 * Expo Router renders this as the outermost layout for all routes.
 */

import React, { useEffect } from 'react';
import { LogBox } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '@/hooks/use-auth';

// Suppress known dev-mode-only warnings that trigger the Expo warning banner and
// obscure E2E test tappable areas at the bottom of the screen.
//   • "Cannot connect to Expo CLI" — always fires in CI / headless Metro mode
//   • "SafeAreaView has been deprecated" — triggered by any remaining react-native
//     SafeAreaView imports (home-screen uses them inside modals; they are benign)
LogBox.ignoreLogs([
  'Cannot connect to Expo CLI',
  'SafeAreaView has been deprecated',
]);

export default function RootLayout(): React.JSX.Element {
  // Ensure Keycloak is configured for the current environment (web redirect URIs, etc.).
  // Best-effort — failures are non-fatal.
  useEffect(() => {
    fetch('/bff-api/auth/init').catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
