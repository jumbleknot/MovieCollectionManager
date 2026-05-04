/**
 * Registration route (T-045)
 * Expo Router screen for the registration flow (US1 — Option A).
 * Renders the app-side registration form → BFF /register → email verification screen.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { RegisterForm } from '@/components/register-form';
import { EmailVerificationScreen } from '@/screens/auth/email-verification-screen';
import { useRegistration } from '@/hooks/use-registration';
import type { RegisterFormValues } from '@/components/register-form';

export default function RegisterScreen(): React.JSX.Element {
  const router = useRouter();
  const { isLoading, error, isSuccess, registeredEmail, register } = useRegistration();

  if (isSuccess && registeredEmail) {
    return (
      <View style={styles.container}>
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
    <View style={styles.container}>
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
    backgroundColor: '#fff',
  },
});
