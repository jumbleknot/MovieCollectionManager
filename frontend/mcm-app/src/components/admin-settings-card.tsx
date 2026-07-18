/**
 * AdminSettingsCard (feature 040 follow-on — admin-settings entry point).
 *
 * The affordance that lets an mc-admin reach the admin settings screen. Feature 040 US3 built the
 * screen (/(app)/admin/settings) but wired no way to reach it — this card is that missing link.
 *
 * Self-gates on isAdmin(user): it renders only for an mc-admin and is null for everyone else, so the
 * ProfileScreen can drop it in unconditionally. Rendered on the Profile screen below ProfileDisplay.
 *
 * WEB-SELECTOR NOTE: the design-system Card is a Tamagui component and does NOT forward testID →
 * data-testid on React-Native-Web (the same limitation the DS Switch has). So the tappable element is
 * a plain RN Pressable that carries the testID + onPress, with the Card rendered non-interactively
 * inside it. The RN host node maps testID → data-testid on web and id: on native, so jest, Playwright,
 * and Maestro all locate and press the same element.
 */

import React from 'react';
import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Card, CardHeader } from '@mcm/design-system';
import { useAuth } from '@/hooks/use-auth';
import { isAdmin } from '@/utils/role-checker';

export function AdminSettingsCard(): React.JSX.Element | null {
  const { user } = useAuth();
  const router = useRouter();

  if (!isAdmin(user)) return null;

  return (
    <Pressable
      testID="profile-admin-settings-card"
      accessibilityRole="button"
      onPress={() => router.push('/(app)/admin/settings')}
    >
      <Card onPress={undefined}>
        <CardHeader
          title="Admin Settings"
          subtitle="Manage app-wide settings, including user self-registration"
        />
      </Card>
    </Pressable>
  );
}
