/**
 * Login screen component (T-041)
 * Landing page with "Login with Keycloak" primary button and "Create Account" link.
 * Navigation to registration is via Expo Router link (app-side form — Option A).
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '@tamagui/core';
import { Banner, Button } from '@mcm/design-system';
import { Link } from 'expo-router';

interface LoginScreenProps {
  onLogin: () => void;
  isLoading?: boolean;
  error?: string | null;
  verifiedSuccess?: boolean;
}

export function LoginScreen({
  onLogin,
  isLoading = false,
  error,
  verifiedSuccess = false,
}: LoginScreenProps): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.container} testID="login-screen">
      <View style={styles.header}>
        <Text style={styles.appName}>Movie Collection Manager</Text>
        <Text style={styles.tagline}>Your personal film library</Text>
      </View>

      {verifiedSuccess ? (
        <Banner tone="success" align="center" emphasis marginBottom={16} testID="login-verified-banner">
          Email verified! You can now log in.
        </Banner>
      ) : null}

      {error ? (
        <Banner tone="error" align="center" marginBottom={24} testID="login-error-banner">
          {error}
        </Banner>
      ) : null}

      <View style={styles.actions}>
        <Button
          variant="filled"
          label="Login with Keycloak"
          onPress={onLogin}
          disabled={isLoading}
          // Preserve the `login-loading` spinner testID (asserted by the auth E2E) as the
          // Button's leading icon while keeping the DS Button shell (FR-013 / SC-006).
          icon={isLoading ? <ActivityIndicator color={theme.onPrimary?.val} testID="login-loading" /> : undefined}
          testID="btn-login-with-keycloak"
          accessibilityLabel="Login with Keycloak"
        />

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <Link href="/(auth)/register" asChild>
          <Button
            variant="outlined"
            label="Create Account"
            testID="link-create-account"
            accessibilityLabel="Create Account"
          />
        </Link>
      </View>
    </View>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background?.val,
    padding: 32,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 48,
  },
  appName: {
    fontFamily: 'Outfit-Bold',
    fontSize: 28,
    fontWeight: '700',
    color: theme.onSurface?.val,
    textAlign: 'center',
    marginBottom: 8,
  },
  tagline: {
    fontFamily: 'Inter',
    fontSize: 16,
    color: theme.onSurfaceVariant?.val,
    textAlign: 'center',
    // Android clips the edge glyphs of centered Inter text ('Y'…'y' in "Your … library") when the
    // measured width is a hair under the ink width; horizontal room prevents the side-bearing clip.
    paddingHorizontal: 6,
  },
  actions: {
    gap: 16,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.outlineVariant?.val,
  },
  dividerText: {
    color: theme.onSurfaceVariant?.val,
    fontFamily: 'Inter',
    fontSize: 14,
  },
});
