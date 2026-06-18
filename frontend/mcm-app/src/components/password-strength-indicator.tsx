/**
 * Password strength indicator component (T-043)
 * Displays real-time password policy feedback as user types.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { evaluatePassword } from '@/utils/validators';

interface PasswordStrengthIndicatorProps {
  password: string;
}

export function PasswordStrengthIndicator({ password }: PasswordStrengthIndicatorProps): React.JSX.Element | null {
  const theme = useTheme();
  if (!password) return null;

  const { checks, score, label } = evaluatePassword(password);

  // Strength feedback maps to semantic theme roles: weak → error, medium → tertiary (the
  // sanctioned amber/orange accent), strong → the new success role (feature 017 SC-004).
  const strengthColor = score <= 2 ? theme.error?.val : score <= 3 ? theme.tertiary?.val : theme.success?.val;

  return (
    <View style={styles.container} testID="password-strength-indicator">
      <View style={styles.barContainer}>
        {[1, 2, 3, 4, 5].map((i) => (
          <View
            key={i}
            style={[
              styles.bar,
              { backgroundColor: i <= score ? strengthColor : theme.outlineVariant?.val },
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
  const theme = useTheme();
  return (
    <View style={styles.checkItem}>
      <Text style={[styles.checkIcon, { color: passed ? theme.success?.val : theme.onSurfaceVariant?.val }]}>
        {passed ? '✓' : '○'}
      </Text>
      <Text style={[styles.checkLabel, { color: passed ? theme.onSurface?.val : theme.onSurfaceVariant?.val }]}>
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
    fontFamily: 'Inter',
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
    fontFamily: 'Inter',
    fontSize: 12,
    width: 16,
  },
  checkLabel: {
    fontFamily: 'Inter',
    fontSize: 12,
  },
});
