/**
 * Native OAuth callback screen — /bff-api/auth/callback
 *
 * On native, Expo Router intercepts the mcm-app://bff-api/auth/callback deep link
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
import { storeTokens } from '@/utils/session-storage';
import { consumePkce } from '@/utils/pkce-store';

let _mountCount = 0;

export default function NativeAuthCallback(): React.JSX.Element {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router = useRouter();
  const { refreshAuth, isAuthenticated } = useAuth();
  const hasRun = useRef(false);
  const mountId = useRef(++_mountCount);
  const [debugMsg, setDebugMsg] = useState('');
  console.log('[callback] render mountId=' + mountId.current + ' isAuth=' + isAuthenticated + ' code=' + (typeof code === 'string' ? code.slice(0,8) : code));

  useEffect(() => {
    // Prevent React Strict Mode double-invocation from consuming PKCE twice
    if (hasRun.current) return;
    hasRun.current = true;

    // Already authenticated (e.g. expo-auth-session handled the code first)
    if (isAuthenticated) {
      router.replace('/(app)/home');
      return;
    }

    if (!code) {
      setDebugMsg('ERROR: no code in URL params');
      return;
    }

    const { codeVerifier, redirectUri } = consumePkce();

    if (!codeVerifier || !redirectUri) {
      setDebugMsg(`ERROR: PKCE missing — codeVerifier:${!!codeVerifier} redirectUri:${!!redirectUri}`);
      return;
    }

    const truncCode = typeof code === 'string' ? code.slice(0, 12) : String(code).slice(0, 12);
    setDebugMsg(`code=${truncCode} cv=${codeVerifier.slice(0,8)} ru=${redirectUri}`);
    console.log('[callback] BFF call START mount=' + mountId.current, truncCode, codeVerifier.slice(0,8));

    apiClient
      .post('/bff-api/auth/login', { code, codeVerifier, redirectUri })
      .then(async (res) => {
        console.log('[callback] BFF call SUCCESS mount=' + mountId.current);
        const sessionId = res.headers['x-session-id'] as string | undefined;
        if (sessionId) await storeTokens('', '', sessionId);
        await refreshAuth();
        router.replace('/(app)/home');
      })
      .catch(async (err: unknown) => {
        console.log('[callback] BFF call FAIL mount=' + mountId.current, (err as any)?.response?.data);
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

        const status = axErr?.response?.status ?? '?';
        const body = JSON.stringify(axErr?.response?.data ?? {});
        setDebugMsg(`status=${status} body=${body}\ncode=${truncCode} cv=${codeVerifier.slice(0,8)} ru=${redirectUri}`);
      });
    return () => { console.log('[callback] useEffect cleanup mount=' + mountId.current); };
  }, [code, isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" />
      {!!debugMsg && <Text style={styles.debug}>{debugMsg}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  debug: { marginTop: 16, textAlign: 'center', color: '#c00', fontSize: 13 },
});
