/**
 * Password strength indicator component (T-043)
 * Displays real-time password policy feedback as user types.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { evaluatePassword } from '@/utils/validators';

interface PasswordStrengthIndicatorProps {
  password: string;
}

export function PasswordStrengthIndicator({ password }: PasswordStrengthIndicatorProps): React.JSX.Element | null {
  if (!password) return null;

  const { checks, score, label } = evaluatePassword(password);

  const strengthColor = score <= 2 ? '#e53e3e' : score <= 3 ? '#d69e2e' : '#38a169';

  return (
    <View style={styles.container} testID="password-strength-indicator">
      <View style={styles.barContainer}>
        {[1, 2, 3, 4, 5].map((i) => (
          <View
            key={i}
            style={[
              styles.bar,
              { backgroundColor: i <= score ? strengthColor : '#e2e8f0' },
            ]}
          />
        ))}
      </View>

      <Text style={[styles.label, { color: strengthColor }]}>{label}</Text>

      <View style={styles.checks}>
        <CheckItem label="At least 12 characters" passed={checks.minLength} />
        <CheckItem label="Uppercase letter" passed={checks.hasUppercase} />
        <CheckItem label="Lowercase letter" passed={checks.hasLowercase} />
        <CheckItem label="Number" passed={checks.hasDigit} />
        <CheckItem label="Special character" passed={checks.hasSpecial} />
      </View>
    </View>
  );
}

interface CheckItemProps {
  label: string;
  passed: boolean;
}

function CheckItem({ label, passed }: CheckItemProps): React.JSX.Element {
  return (
    <View style={styles.checkItem}>
      <Text style={[styles.checkIcon, { color: passed ? '#38a169' : '#a0aec0' }]}>
        {passed ? '✓' : '○'}
      </Text>
      <Text style={[styles.checkLabel, { color: passed ? '#2d3748' : '#718096' }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
  },
  barContainer: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 4,
  },
  bar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
  },
  checks: {
    gap: 4,
  },
  checkItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  checkIcon: {
    fontSize: 12,
    width: 16,
  },
  checkLabel: {
    fontSize: 12,
  },
});
