/**
 * Registration route (T-045)
 * Expo Router screen for the registration flow (US1 — Option A).
 * Renders the app-side registration form → BFF /register → email verification screen.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { RegisterForm } from '@/components/register-form';
import { EmailVerificationScreen } from '@/screens/auth/email-verification-screen';
import { useRegistration } from '@/hooks/use-registration';
import type { RegisterFormValues } from '@/components/register-form';

export default function RegisterScreen(): React.JSX.Element {
  const { isLoading, error, isSuccess, registeredEmail, register } = useRegistration();
  const theme = useTheme();
  const container = [styles.container, { backgroundColor: theme.background?.val }];

  if (isSuccess && registeredEmail) {
    return (
      <View style={container}>
        <EmailVerificationScreen
          email={registeredEmail}
          onResent={() => {
            // Email re-sent — stay on verification screen
          }}
        />
      </View>
    );
  }

  async function handleSubmit(values: Omit<RegisterFormValues, 'confirmPassword'>): Promise<void> {
    await register(values);
  }

  return (
    <View style={container}>
      <RegisterForm
        onSubmit={handleSubmit}
        isLoading={isLoading}
        error={error}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
