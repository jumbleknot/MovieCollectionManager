/**
 * Login route — Expo Router (T-062)
 * Displays the LoginScreen with Keycloak PKCE auth flow wired up.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LoginScreen } from '@/screens/auth/login-screen';
import { useKeycloakAuth } from '@/hooks/use-keycloak-auth';
import { useLogin } from '@/hooks/use-login';
import { useAuth } from '@/hooks/use-auth';
import type { LoginRequest } from '@/types/auth';

export default function LoginRoute(): React.JSX.Element {
  const { login, isLoading: isExchanging, error: loginError } = useLogin();
  const { isAuthenticated, refreshAuth, timeoutReason, clearTimeoutReason } = useAuth();
  const router = useRouter();
  const [keycloakError, setKeycloakError] = useState<string | null>(null);
  const { verified } = useLocalSearchParams<{ verified?: string }>();

  const timeoutMessage =
    timeoutReason === 'idle'
      ? 'Your session has expired due to inactivity. Please log in again.'
      : timeoutReason === 'absolute'
        ? 'Your session has expired. Please log in again.'
        : null;

  // Navigate once the auth context confirms the session is established
  useEffect(() => {
    if (isAuthenticated) {
      router.replace('/(app)/home');
    }
  }, [isAuthenticated, router]);

  // Call BFF login then refresh auth context; errors surface via loginError or onError
  const handleCode = useCallback(async (request: LoginRequest): Promise<void> => {
    clearTimeoutReason();
    const success = await login(request);
    if (success) {
      await refreshAuth();
    }
  }, [login, refreshAuth, clearTimeoutReason]);

  const { promptAsync, isLoading: isDiscovering } = useKeycloakAuth({
    onCode: handleCode,
    onCancel: () => {},
    onError: (msg) => setKeycloakError(msg),
  });

  const isLoading = isDiscovering || isExchanging;
  const error = loginError ?? keycloakError ?? timeoutMessage;
  const isVerified = verified === 'true';

  return (
    <View style={styles.container}>
      <LoginScreen
        onLogin={promptAsync}
        isLoading={isLoading}
        error={error}
        verifiedSuccess={isVerified}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
});
