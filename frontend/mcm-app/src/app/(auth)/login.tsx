/**
 * Login route — Expo Router (T-062)
 * Displays the LoginScreen with Keycloak PKCE auth flow wired up.
 */

import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { LoginScreen } from '@/screens/auth/login-screen';
import { useKeycloakAuth } from '@/hooks/use-keycloak-auth';
import { useLogin } from '@/hooks/use-login';

export default function LoginRoute(): React.JSX.Element {
  const { login, isLoading: isExchanging } = useLogin();
  const [authError, setAuthError] = useState<string | null>(null);
  const { verified } = useLocalSearchParams<{ verified?: string }>();

  const { promptAsync, isLoading: isDiscovering } = useKeycloakAuth({
    onCode: login,
    onCancel: () => setAuthError(null),
    onError: (msg) => setAuthError(msg),
  });

  const isLoading = isDiscovering || isExchanging;
  const isVerified = verified === 'true';

  return (
    <View style={styles.container}>
      <LoginScreen
        onLogin={promptAsync}
        isLoading={isLoading}
        error={authError}
        verifiedSuccess={isVerified}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
});
