/**
 * Root layout — wraps the entire app in global providers.
 * Expo Router renders this as the outermost layout for all routes.
 */

import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { AuthProvider } from '@/hooks/use-auth';

export default function RootLayout(): React.JSX.Element {
  // Ensure Keycloak is configured for the current environment (web redirect URIs, etc.).
  // Best-effort — failures are non-fatal.
  useEffect(() => {
    fetch('/bff-api/auth/init').catch(() => {});
  }, []);

  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}
