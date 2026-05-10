/**
 * Root layout — wraps the entire app in global providers.
 * Expo Router renders this as the outermost layout for all routes.
 */

import React from 'react';
import { Stack } from 'expo-router';
import { AuthProvider } from '@/hooks/use-auth';

export default function RootLayout(): React.JSX.Element {
  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}
