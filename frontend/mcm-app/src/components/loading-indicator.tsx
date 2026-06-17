/**
 * Loading indicator component (T-060)
 * Generic spinner for auth operations (Keycloak redirect in progress, etc.)
 */

import React from 'react';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';

interface LoadingIndicatorProps {
  message?: string;
  size?: 'small' | 'large';
  color?: string;
  testID?: string;
}

export function LoadingIndicator({
  message,
  size = 'large',
  color,
  testID = 'loading-indicator',
}: LoadingIndicatorProps): React.JSX.Element {
  const theme = useTheme();
  // Spinner uses the caller's colour or the theme primary (was a hardcoded blue).
  const spinnerColor = color ?? theme.primary?.val;
  return (
    <View style={styles.container} testID={testID} accessibilityRole="progressbar">
      <ActivityIndicator size={size} color={spinnerColor} testID={`${testID}-spinner`} />
      {message ? (
        <Text style={[styles.message, { color: theme.onSurfaceVariant?.val }]} testID={`${testID}-message`}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  message: {
    fontFamily: 'Inter',
    fontSize: 16,
    textAlign: 'center',
  },
});
