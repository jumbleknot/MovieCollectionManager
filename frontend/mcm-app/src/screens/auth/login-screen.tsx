/**
 * Login screen component (T-041)
 * Landing page with "Login with Keycloak" primary button and "Create Account" link.
 * Navigation to registration is via Expo Router link (app-side form — Option A).
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '@tamagui/core';
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
        <View style={styles.successBanner} testID="login-verified-banner">
          <Text style={styles.successText}>Email verified! You can now log in.</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBanner} testID="login-error-banner">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.loginButton, isLoading && styles.buttonDisabled]}
          onPress={onLogin}
          disabled={isLoading}
          testID="btn-login-with-keycloak"
          accessibilityRole="button"
          accessibilityLabel="Login with Keycloak"
        >
          {isLoading ? (
            <ActivityIndicator color={theme.onPrimary?.val} testID="login-loading" />
          ) : (
            <Text style={styles.loginButtonText}>Login with Keycloak</Text>
          )}
        </TouchableOpacity>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <Link href="/(auth)/register" asChild>
          <TouchableOpacity
            style={styles.createAccountButton}
            testID="link-create-account"
            accessibilityRole="button"
            accessibilityLabel="Create Account"
          >
            <Text style={styles.createAccountText}>Create Account</Text>
          </TouchableOpacity>
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
    fontFamily: 'Outfit',
    fontSize: 28,
    fontWeight: '800',
    color: theme.onSurface?.val,
    textAlign: 'center',
    marginBottom: 8,
  },
  tagline: {
    fontFamily: 'Inter',
    fontSize: 16,
    color: theme.onSurfaceVariant?.val,
    textAlign: 'center',
  },
  // Verified notice → the filled `success` container role (AA both themes; feature 017 SC-004).
  successBanner: {
    backgroundColor: theme.successContainer?.val,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  successText: {
    color: theme.onSuccessContainer?.val,
    fontFamily: 'Inter',
    fontSize: 14,
    textAlign: 'center',
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: theme.errorContainer?.val,
    borderRadius: 8,
    padding: 12,
    marginBottom: 24,
  },
  errorText: {
    color: theme.onErrorContainer?.val,
    fontFamily: 'Inter',
    fontSize: 14,
    textAlign: 'center',
  },
  actions: {
    gap: 16,
  },
  loginButton: {
    backgroundColor: theme.primary?.val,
    borderRadius: 24,
    padding: 16,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  loginButtonText: {
    color: theme.onPrimary?.val,
    fontFamily: 'Inter',
    fontSize: 17,
    fontWeight: '700',
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
  createAccountButton: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.outline?.val,
    padding: 16,
    alignItems: 'center',
  },
  createAccountText: {
    color: theme.primary?.val,
    fontFamily: 'Inter',
    fontSize: 17,
    fontWeight: '600',
  },
});
