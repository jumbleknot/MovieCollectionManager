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
import { AuthProvider } from '@/hooks/use-auth';
import { UiStateProvider } from '@/hooks/use-ui-state';
import { AssistantDataSyncProvider } from '@/hooks/use-assistant-data-sync';

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
        {/* US3: screens report their structural snapshot here; the dock flushes it before a
            turn so "add this" resolves the on-screen target. Wraps both the routes and the
            dock so each can read the shared context. Harmless when logged out (pushes 401 → */}
        <UiStateProvider>
          {/* T072: a shared data-revision the dock bumps on an approved assistant write so the
              on-screen lists (collection/movie/home) re-fetch. Wraps both the routes (consumers)
              and the dock (bumper). Inert until the assistant writes — additive (SC-005). */}
          <AssistantDataSyncProvider>
            {/* The assistant dock is mounted INSIDE the (app) protected group
                (app/(app)/_layout.tsx), NOT here — so it can never be composed with the (auth)
                routes (login/register). Mounting it at the root made it an overlay sibling of every
                route group: whenever `isAuthenticated` was briefly true on an (auth) route (e.g. the
                pre-redirect frame on login, or a hydration race during the test harness's rapid
                relaunches) the dock + a still-valid agent session showed over the login screen.
                The UiState/DataSync/Auth providers stay here so both the routes and the (app)-mounted
                dock can read them. */}
            <Stack screenOptions={{ headerShown: false }} />
          </AssistantDataSyncProvider>
        </UiStateProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
