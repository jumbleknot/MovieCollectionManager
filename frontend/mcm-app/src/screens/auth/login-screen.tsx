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
            <ActivityIndicator color="#fff" testID="login-loading" />
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 32,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 48,
  },
  appName: {
    fontSize: 28,
    fontWeight: '800',
    color: '#1a202c',
    textAlign: 'center',
    marginBottom: 8,
  },
  tagline: {
    fontSize: 16,
    color: '#718096',
    textAlign: 'center',
  },
  successBanner: {
    backgroundColor: '#c6f6d5',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  successText: {
    color: '#276749',
    fontSize: 14,
    textAlign: 'center',
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: '#fed7d7',
    borderRadius: 8,
    padding: 12,
    marginBottom: 24,
  },
  errorText: {
    color: '#c53030',
    fontSize: 14,
    textAlign: 'center',
  },
  actions: {
    gap: 16,
  },
  loginButton: {
    backgroundColor: '#3182ce',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  loginButtonText: {
    color: '#fff',
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
    backgroundColor: '#e2e8f0',
  },
  dividerText: {
    color: '#a0aec0',
    fontSize: 14,
  },
  createAccountButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e0',
    padding: 16,
    alignItems: 'center',
  },
  createAccountText: {
    color: '#2d3748',
    fontSize: 17,
    fontWeight: '600',
  },
});
