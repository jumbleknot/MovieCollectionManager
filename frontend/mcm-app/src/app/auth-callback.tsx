/**
 * OAuth callback route for web — /auth-callback
 *
 * Keycloak redirects the popup here after authentication:
 *   http://localhost:8081/auth-callback?code=...&state=...
 *
 * maybeCompleteAuthSession() detects the code + state, posts them back to the
 * opener window via postMessage, then closes this popup tab. The opener's
 * useAuthRequest() resolves and the login flow continues there.
 *
 * This page is only ever seen in the popup for a fraction of a second.
 */

import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useTheme } from '@tamagui/core';
import * as WebBrowser from 'expo-web-browser';

// Complete the session immediately — posts the code back to opener and closes popup.
WebBrowser.maybeCompleteAuthSession();

export default function AuthCallback(): React.JSX.Element {
  // This renders briefly while the popup closes. Show a spinner so it doesn't
  // flash a blank screen (themed so it doesn't flash white on the dark theme).
  const theme = useTheme();
  return (
    <View
      style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.background?.val }}
    >
      <ActivityIndicator size="large" color={theme.primary?.val} />
    </View>
  );
}
