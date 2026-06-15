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

// Strength colours are semantic feedback (weak/medium/strong), kept distinct from
// the DS palette so the meter reads at a glance. Neutral chrome uses theme tokens.
const STRONG_GREEN = '#38a169';

export function PasswordStrengthIndicator({ password }: PasswordStrengthIndicatorProps): React.JSX.Element | null {
  const theme = useTheme();
  if (!password) return null;

  const { checks, score, label } = evaluatePassword(password);

  const strengthColor = score <= 2 ? '#e53e3e' : score <= 3 ? '#d69e2e' : STRONG_GREEN;

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
      <Text style={[styles.checkIcon, { color: passed ? STRONG_GREEN : theme.onSurfaceVariant?.val }]}>
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
