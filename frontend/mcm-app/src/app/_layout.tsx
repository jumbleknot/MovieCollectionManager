/**
 * Root layout — wraps the entire app in global providers.
 * Expo Router renders this as the outermost layout for all routes.
 */

// CopilotKit (feature 012) RN polyfills — crypto.getRandomValues / streaming fetch / TextEncoder.
// Loaded via a dedicated module that suppresses the polyfill's import-time warning first; MUST be
// the first import so it runs before any CopilotKit code. See src/assistant-polyfills.ts.
import '@/assistant-polyfills';

import React, { useEffect } from 'react';
import { LogBox } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { AssistantProvider } from '@/hooks/use-assistant';
import { AssistantDock } from '@/components/agent/assistant-dock';

// Suppress known dev-mode-only warnings that trigger the Expo warning banner and
// obscure E2E test tappable areas at the bottom of the screen.
//   • "Cannot connect to Expo CLI" — always fires in CI / headless Metro mode
//   • "SafeAreaView has been deprecated" — triggered by any remaining react-native
//     SafeAreaView imports (home-screen uses them inside modals; they are benign)
//   • "[CopilotKit] Installing non-cryptographic crypto.getRandomValues polyfill" — the
//     feature-012 RN crypto polyfill warns on every launch; its LogBox banner overlaps the
//     bottom-left assistant-dock toggle and intercepts the tap (breaks the mobile E2E).
LogBox.ignoreLogs([
  'Cannot connect to Expo CLI',
  'SafeAreaView has been deprecated',
  '[CopilotKit] Installing non-cryptographic',
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
        <AuthedAssistant />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

// The conversational assistant overlay (feature 012) — mounted ONLY for authenticated
// users, so unauthenticated flows (login/register) are unaffected (additive-only, SC-005).
function AuthedAssistant(): React.JSX.Element | null {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return null;
  return (
    <AssistantProvider>
      <AssistantDock />
    </AssistantProvider>
  );
}
