/**
 * Email verification screen (T-044)
 * Shown after successful registration to prompt email verification.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { getErrorMessage } from '@/utils/errors';
import { apiClient } from '@/bff-server/api-client';

interface EmailVerificationScreenProps {
  email: string;
  onResent?: () => void;
}

export function EmailVerificationScreen({
  email,
  onResent,
}: EmailVerificationScreenProps): React.JSX.Element {
  const [isResending, setIsResending] = useState(false);
  const [resentMessage, setResentMessage] = useState<string | null>(null);
  const [resentError, setResentError] = useState<string | null>(null);

  async function handleResend() {
    setIsResending(true);
    setResentMessage(null);
    setResentError(null);

    try {
      await apiClient.post('/bff-api/auth/resend-verification', { email });
      setResentMessage('Verification email sent. Please check your inbox.');
      onResent?.();
    } catch (err) {
      setResentError(getErrorMessage(err));
    } finally {
      setIsResending(false);
    }
  }

  return (
    <View style={styles.container} testID="email-verification-screen">
      <View style={styles.iconContainer}>
        <Text style={styles.icon}>✉️</Text>
      </View>

      <Text style={styles.title}>Check Your Email</Text>

      <Text style={styles.body}>
        We've sent a verification link to{' '}
        <Text style={styles.email}>{email}</Text>.{'\n\n'}
        Please click the link in the email to verify your account.
        The link expires in 24 hours.
      </Text>

      {resentMessage ? (
        <View style={styles.successBanner} testID="resent-success">
          <Text style={styles.successText}>{resentMessage}</Text>
        </View>
      ) : null}

      {resentError ? (
        <View style={styles.errorBanner} testID="resent-error">
          <Text style={styles.errorText}>{resentError}</Text>
        </View>
      ) : null}

      <Text style={styles.resendPrompt}>Didn't receive the email?</Text>

      <TouchableOpacity
        style={[styles.resendButton, isResending && styles.buttonDisabled]}
        onPress={handleResend}
        disabled={isResending}
        testID="btn-resend-verification"
        accessibilityRole="button"
        accessibilityLabel="Resend verification email"
      >
        {isResending ? (
          <ActivityIndicator color="#3182ce" />
        ) : (
          <Text style={styles.resendButtonText}>Resend Verification Email</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  iconContainer: {
    marginBottom: 24,
  },
  icon: {
    fontSize: 64,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 16,
    textAlign: 'center',
  },
  body: {
    fontSize: 16,
    color: '#4a5568',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
  },
  email: {
    fontWeight: '600',
    color: '#2d3748',
  },
  resendPrompt: {
    fontSize: 14,
    color: '#718096',
    marginTop: 8,
    marginBottom: 12,
  },
  resendButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderWidth: 1,
    borderColor: '#3182ce',
    borderRadius: 8,
    alignItems: 'center',
    minWidth: 220,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  resendButtonText: {
    color: '#3182ce',
    fontSize: 15,
    fontWeight: '600',
  },
  successBanner: {
    backgroundColor: '#c6f6d5',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    width: '100%',
  },
  successText: {
    color: '#276749',
    fontSize: 14,
    textAlign: 'center',
  },
  errorBanner: {
    backgroundColor: '#fed7d7',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    width: '100%',
  },
  errorText: {
    color: '#c53030',
    fontSize: 14,
    textAlign: 'center',
  },
});
