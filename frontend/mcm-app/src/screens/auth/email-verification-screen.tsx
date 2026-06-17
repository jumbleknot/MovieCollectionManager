/**
 * Email verification screen (T-044)
 * Shown after successful registration to prompt email verification.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
} from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button } from '@mcm/design-system';
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
  const theme = useTheme();
  const styles = makeStyles(theme);
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

      <Button
        variant="outlined"
        label="Resend Verification Email"
        onPress={handleResend}
        loading={isResending}
        disabled={isResending}
        testID="btn-resend-verification"
        accessibilityLabel="Resend verification email"
      />
    </View>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  container: {
    flex: 1,
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.background?.val,
  },
  iconContainer: {
    marginBottom: 24,
  },
  icon: {
    fontFamily: 'Inter',
    fontSize: 57,
  },
  title: {
    fontFamily: 'Outfit',
    fontSize: 28,
    fontWeight: '700',
    color: theme.onSurface?.val,
    marginBottom: 16,
    textAlign: 'center',
  },
  body: {
    fontFamily: 'Inter',
    fontSize: 16,
    color: theme.onSurfaceVariant?.val,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
  },
  email: {
    fontFamily: 'Inter',
    fontWeight: '600',
    color: theme.onSurface?.val,
  },
  resendPrompt: {
    fontFamily: 'Inter',
    fontSize: 14,
    color: theme.onSurfaceVariant?.val,
    marginTop: 8,
    marginBottom: 12,
  },
  // Verified notice → the filled `success` container role (AA both themes; feature 017 SC-004).
  successBanner: {
    backgroundColor: theme.successContainer?.val,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    width: '100%',
  },
  successText: {
    color: theme.onSuccessContainer?.val,
    fontFamily: 'Inter',
    fontSize: 14,
    textAlign: 'center',
  },
  errorBanner: {
    backgroundColor: theme.errorContainer?.val,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    width: '100%',
  },
  errorText: {
    color: theme.onErrorContainer?.val,
    fontFamily: 'Inter',
    fontSize: 14,
    textAlign: 'center',
  },
});
