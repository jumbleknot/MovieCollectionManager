/**
 * Registration form component (T-042)
 * Collects new user details with real-time validation feedback.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { PasswordStrengthIndicator } from '@/components/password-strength-indicator';
import {
  emailError,
  usernameError,
  passwordError,
  confirmPasswordError,
  firstNameError,
  lastNameError,
} from '@/utils/validators';

export interface RegisterFormValues {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  confirmPassword: string;
}

interface RegisterFormProps {
  onSubmit: (values: Omit<RegisterFormValues, 'confirmPassword'>) => Promise<void>;
  isLoading?: boolean;
  error?: string | null;
}

export function RegisterForm({ onSubmit, isLoading = false, error }: RegisterFormProps): React.JSX.Element {
  const [values, setValues] = useState<RegisterFormValues>({
    username: '',
    email: '',
    firstName: '',
    lastName: '',
    password: '',
    confirmPassword: '',
  });

  const [touched, setTouched] = useState<Partial<Record<keyof RegisterFormValues, boolean>>>({});

  const errors: Partial<Record<keyof RegisterFormValues, string | null>> = {
    username: usernameError(values.username),
    email: emailError(values.email),
    firstName: firstNameError(values.firstName),
    lastName: lastNameError(values.lastName),
    password: passwordError(values.password),
    confirmPassword: confirmPasswordError(values.password, values.confirmPassword),
  };

  const hasErrors = Object.values(errors).some(Boolean);

  function update(field: keyof RegisterFormValues, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function markTouched(field: keyof RegisterFormValues) {
    setTouched((prev) => ({ ...prev, [field]: true }));
  }

  async function handleSubmit() {
    // Mark all fields touched to show validation errors
    const allTouched = Object.fromEntries(
      Object.keys(values).map((k) => [k, true]),
    ) as typeof touched;
    setTouched(allTouched);

    if (hasErrors) return;

    const { confirmPassword: _, ...submitValues } = values;
    await onSubmit(submitValues);
  }

  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Create Account</Text>

      {error ? (
        <View style={styles.errorBanner} testID="register-form-error">
          <Text style={styles.errorBannerText}>{error}</Text>
        </View>
      ) : null}

      <Field
        label="First Name"
        value={values.firstName}
        onChangeText={(v) => update('firstName', v)}
        onBlur={() => markTouched('firstName')}
        error={touched.firstName ? errors.firstName : null}
        autoCapitalize="words"
        testID="input-firstName"
      />

      <Field
        label="Last Name"
        value={values.lastName}
        onChangeText={(v) => update('lastName', v)}
        onBlur={() => markTouched('lastName')}
        error={touched.lastName ? errors.lastName : null}
        autoCapitalize="words"
        testID="input-lastName"
      />

      <Field
        label="Username"
        value={values.username}
        onChangeText={(v) => update('username', v)}
        onBlur={() => markTouched('username')}
        error={touched.username ? errors.username : null}
        autoCapitalize="none"
        autoCorrect={false}
        testID="input-username"
      />

      <Field
        label="Email Address"
        value={values.email}
        onChangeText={(v) => update('email', v)}
        onBlur={() => markTouched('email')}
        error={touched.email ? errors.email : null}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        testID="input-email"
      />

      <Field
        label="Password"
        value={values.password}
        onChangeText={(v) => update('password', v)}
        onBlur={() => markTouched('password')}
        error={touched.password ? errors.password : null}
        secureTextEntry
        testID="input-password"
      />

      {values.password.length > 0 && (
        <PasswordStrengthIndicator password={values.password} />
      )}

      <Field
        label="Confirm Password"
        value={values.confirmPassword}
        onChangeText={(v) => update('confirmPassword', v)}
        onBlur={() => markTouched('confirmPassword')}
        error={touched.confirmPassword ? errors.confirmPassword : null}
        secureTextEntry
        testID="input-confirmPassword"
      />

      <TouchableOpacity
        style={[styles.submitButton, isLoading && styles.submitButtonDisabled]}
        onPress={handleSubmit}
        disabled={isLoading}
        testID="btn-create-account"
        accessibilityRole="button"
        accessibilityLabel="Create Account"
      >
        {isLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitButtonText}>Create Account</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─── Field sub-component ───────────────────────────────────────────────────────

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  onBlur: () => void;
  error?: string | null;
  secureTextEntry?: boolean;
  keyboardType?: React.ComponentProps<typeof TextInput>['keyboardType'];
  autoCapitalize?: React.ComponentProps<typeof TextInput>['autoCapitalize'];
  autoCorrect?: boolean;
  testID?: string;
}

function Field({
  label,
  value,
  onChangeText,
  onBlur,
  error,
  secureTextEntry,
  keyboardType = 'default',
  autoCapitalize = 'sentences',
  autoCorrect = true,
  testID,
}: FieldProps): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, error ? styles.inputError : null]}
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        testID={testID}
        accessibilityLabel={label}
      />
      {error ? <Text style={styles.fieldError} testID={`${testID}-error`}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 24,
  },
  errorBanner: {
    backgroundColor: '#fed7d7',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorBannerText: {
    color: '#c53030',
    fontSize: 14,
  },
  field: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2d3748',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e0',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#1a202c',
    backgroundColor: '#fff',
  },
  inputError: {
    borderColor: '#e53e3e',
  },
  fieldError: {
    color: '#e53e3e',
    fontSize: 12,
    marginTop: 4,
  },
  submitButton: {
    backgroundColor: '#3182ce',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 32,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
