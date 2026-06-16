/**
 * Native OAuth callback screen — /native-auth-callback
 *
 * On native, Expo Router intercepts the mcm-app://native-auth-callback deep link
 * before expo-auth-session can capture it.  This screen receives the OAuth code
 * from the URL params, retrieves the codeVerifier stored by useKeycloakAuth before
 * the browser was opened, exchanges them via the BFF, then navigates to the app.
 *
 * Web uses /auth-callback instead (handled by auth-callback.tsx).
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, StyleSheet, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/hooks/use-auth';
import { apiClient } from '@/bff-server/api-client';
import { storeSession } from '@/utils/session-storage';
import { consumePkce } from '@/utils/pkce-store';

export default function NativeAuthCallback(): React.JSX.Element {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router = useRouter();
  const { refreshAuth, isAuthenticated } = useAuth();
  const hasRun = useRef(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    // Prevent React Strict Mode double-invocation from consuming PKCE twice
    if (hasRun.current) return;
    hasRun.current = true;

    // Run the exchange logic in an async continuation so setState calls are never
    // synchronous within the effect body (react-hooks/set-state-in-effect). The
    // observable behavior is unchanged — these branches previously returned
    // synchronously, but no other code depends on that synchronicity.
    void (async () => {
      // Already authenticated (e.g. expo-auth-session handled the code first)
      if (isAuthenticated) {
        router.replace('/(app)/home');
        return;
      }

      if (!code) {
        setHasError(true);
        return;
      }

      const { codeVerifier, redirectUri } = consumePkce();

      if (!codeVerifier || !redirectUri) {
        setHasError(true);
        return;
      }

      try {
        const res = await apiClient.post('/bff-api/auth/login', {
          code,
          codeVerifier,
          redirectUri,
        });
        const sessionId = res.headers['x-session-id'] as string | undefined;
        if (sessionId) await storeSession(sessionId);
        await refreshAuth();
        router.replace('/(app)/home');
      } catch (err: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const axErr = err as any;
        const errorCode: string | undefined = axErr?.response?.data?.code;

        if (errorCode === 'AUTH_CODE_INVALID' || errorCode === 'AUTH_CODE_EXPIRED') {
          // The code was already exchanged (race with expo-auth-session internals or
          // a second mount). If the exchange established a valid BFF session, refresh
          // auth state and navigate home instead of showing an error.
          try {
            await refreshAuth();
            router.replace('/(app)/home');
            return;
          } catch {
            // No valid session — fall through to show error
          }
        }

        setHasError(true);
      }
    })();
  }, [code, isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" />
      {hasError && (
        <Text style={styles.error}>Authentication failed. Please go back and try again.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  error: { marginTop: 16, textAlign: 'center', color: '#c00', fontSize: 14 },
});
