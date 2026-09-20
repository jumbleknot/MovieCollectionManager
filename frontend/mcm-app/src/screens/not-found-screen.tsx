/**
 * NotFoundScreen — what an address matching no route renders (feature 074, backlog item #237).
 *
 * FR-003…FR-006. Before this existed, an unmatched address fell through to Expo Router's built-in
 * unmatched screen: unstyled, no chrome, and no way back but the browser's Back button. Feature 062
 * made that reachable from an old bookmark by removing /(app)/profile and /(app)/admin/settings
 * outright rather than redirecting them (062 research.md §R1).
 *
 * Rendered by ONE route — src/app/+not-found.tsx — which carries its own chrome.
 *
 * A second route at src/app/(app)/+not-found.tsx was built and MEASURED not to work, and the
 * finding is worth keeping: Expo Router groups are URL-transparent, so /(app)/profile normalizes
 * to /profile, which cannot be attributed back to the group. The ROOT +not-found takes every
 * unmatched address and the group's copy is dead code. Web E2E showed the branded screen rendering
 * with no navigation bar — and the selector was verified sound BEFORE that was believed
 * (getByTestId('navigation-bar') passes in auth.spec.ts, so the failure was the routing, not the
 * instrument). The chrome is therefore rendered here instead, which is what item #237 reported
 * missing. The root layout already supplies AuthProvider and ThemeProvider; NavigationBar needs
 * nothing else.
 *
 * The screen lives directly in src/screens/ rather than in a subdirectory: every existing
 * subdirectory groups one feature area, and not-found belongs to no area.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { useRouter } from 'expo-router';
import { Button, Card, CardHeader, CardContent } from '@mcm/design-system';
import { NavigationBar } from '@/components/navigation-bar';
import { useAuth } from '@/hooks/use-auth';

export function NotFoundScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  return (
    <View style={[styles.outer, { backgroundColor: theme.background?.val }]}>
      {/* Signed-in visitors only: every nav link points at an authenticated destination, so
          offering them to an anonymous visitor would send them straight into AuthGuard. A
          signed-in user who followed a dead bookmark keeps the app's chrome. */}
      {isAuthenticated && <NavigationBar />}

      <View
        style={[styles.container, { backgroundColor: theme.background?.val }]}
        /* STABLE EXTERNAL-CONTRACT SELECTOR — on the plain react-native View, never on a Tamagui
           component: a Tamagui component can drop testID → data-testid on React Native Web. See
           the note in packages/design-system/components/navigation/Tabs.tsx. This host node maps
           testID → data-testid on web and id on native, so jest and Playwright locate the same
           element. */
        testID="not-found-screen"
      >
        <Card>
          <CardHeader title="Page not found" subtitle="This address does not exist" />
          <CardContent>
            <Text
              fontFamily="$body"
              fontSize={14}
              lineHeight={20}
              letterSpacing={0.25}
              color={theme.onSurfaceVariant?.val}
            >
              The address you followed was not found. It may have been removed, or the link may be
              out of date.
            </Text>
          </CardContent>
          <CardContent>
            <Button
              variant="filled"
              label="Go to My Collections"
              accessibilityLabel="Go to My Collections"
              /* Same placement as profile-display.tsx's btn-logout, which a real Playwright run
                 locates as [data-testid="btn-logout"] (tests/e2e/web/bff-prod-lifecycle.spec.ts) —
                 measured, not assumed. */
              testID="not-found-home-link"
              /* replace, not push: the address that matched nothing must not sit in the back stack
                 behind home, or Back returns the user to the dead address they just escaped. */
              onPress={() => router.replace('/(app)/home')}
            />
          </CardContent>
        </Card>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The nav bar sizes itself; the content below takes the remaining height.
  outer: { flex: 1 },
  // Layout only — every colour is read from a theme role at the JSX site, so a declared style
  // cannot drift from the rendered colour (feature 017 D6) and both themes are correct by
  // construction rather than by a second visual test. Padding is on the base-8 grid.
  container: { flex: 1, padding: 16 },
});
