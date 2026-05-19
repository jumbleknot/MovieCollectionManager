/**
 * Loading indicator component (T-060)
 * Generic spinner for auth operations (Keycloak redirect in progress, etc.)
 */

import React from 'react';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';

interface LoadingIndicatorProps {
  message?: string;
  size?: 'small' | 'large';
  color?: string;
  testID?: string;
}

export function LoadingIndicator({
  message,
  size = 'large',
  color = '#3182ce',
  testID = 'loading-indicator',
}: LoadingIndicatorProps): React.JSX.Element {
  return (
    <View style={styles.container} testID={testID} accessibilityRole="progressbar">
      <ActivityIndicator size={size} color={color} testID={`${testID}-spinner`} />
      {message ? (
        <Text style={styles.message} testID={`${testID}-message`}>
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
    fontSize: 16,
    color: '#4a5568',
    textAlign: 'center',
  },
});
