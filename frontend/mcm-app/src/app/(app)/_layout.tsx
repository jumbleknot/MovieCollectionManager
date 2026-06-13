/**
 * Authenticated app layout (T-085)
 * Wraps all (app) routes with AuthGuard + NavigationBar.
 * Child routes render screen content only — no nav bar needed per-screen.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AuthGuard } from '@/components/auth-guard';
import { NavigationBar } from '@/components/navigation-bar';
import { useAuth } from '@/hooks/use-auth';
import { useSessionTimeout } from '@/hooks/use-session-timeout';
import { AssistantProvider } from '@/hooks/use-assistant';
import { AssistantDock } from '@/components/agent/assistant-dock';

const DEV_IDLE_OVERRIDE_MS = parseInt(process.env['EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS'] ?? '', 10);
const DEV_IDLE_TIMEOUT_MS = Number.isNaN(DEV_IDLE_OVERRIDE_MS) ? undefined : DEV_IDLE_OVERRIDE_MS;

const DEV_ABSOLUTE_OVERRIDE_MS = parseInt(process.env['EXPO_PUBLIC_DEV_ABSOLUTE_TIMEOUT_OVERRIDE_MS'] ?? '', 10);
const DEV_ABSOLUTE_TIMEOUT_MS = Number.isNaN(DEV_ABSOLUTE_OVERRIDE_MS) ? undefined : DEV_ABSOLUTE_OVERRIDE_MS;

function SessionTimeoutHandler(): null {
  const { isAuthenticated, logoutWithTimeout } = useAuth();
  useSessionTimeout({
    onTimeout: logoutWithTimeout,
    enabled: isAuthenticated,
    idleTimeoutMs: DEV_IDLE_TIMEOUT_MS,
    absoluteTimeoutMs: DEV_ABSOLUTE_TIMEOUT_MS,
  });
  return null;
}

// The conversational assistant overlay (feature 012). Mounted here, inside the (app) AuthGuard,
// so it exists ONLY on authenticated app routes — structurally impossible on the (auth) login/
// register screens (it used to be a root-layout overlay, which let it appear over login during an
// auth-state timing window). The `isAuthenticated` check is belt-and-suspenders alongside AuthGuard.
function AuthedAssistant(): React.JSX.Element | null {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return null;
  return (
    <AssistantProvider>
      <AssistantDock />
    </AssistantProvider>
  );
}

export default function AppLayout(): React.JSX.Element {
  return (
    <AuthGuard>
      {/* edges={['top']} so the nav bar background fills behind the status bar */}
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.container}>
          <SessionTimeoutHandler />
          <NavigationBar />
          {/* Wrap Stack in a flex:1 View so screens fill the remaining height on web.
              React Native Web's absolutely-positioned screen containers require an
              explicit height on their parent; without it the Stack collapses to 0 px
              and all screen content is clipped (overflow:hidden). */}
          <View style={styles.stack}>
            <Stack screenOptions={{ headerShown: false }} />
          </View>
          <AuthedAssistant />
        </View>
      </SafeAreaView>
    </AuthGuard>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#1a202c' },
  container: { flex: 1, backgroundColor: '#fff' },
  stack: { flex: 1 },
});
