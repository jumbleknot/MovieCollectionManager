/**
 * Navigation bar component (T-082; feature 015 re-skin)
 * Displays Home and Profile links with the app wordmark — the web top app bar.
 *
 * Re-skinned onto the MCM Cinema design system (Tamagui): cinematic dark app-bar
 * surface, Cinematic-Blue primary wordmark + active link, neutral inactive links.
 * Structure, links, behaviour, and every testID are unchanged (FR-002 / FR-018).
 */

import React from 'react';
import { TouchableOpacity } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { XStack } from '@tamagui/stacks';
import { Link, usePathname } from 'expo-router';
import { useTheme as useThemePref } from '@/hooks/use-theme';

export function NavigationBar(): React.JSX.Element {
  const pathname = usePathname();
  const theme = useTheme();
  // Device-local dark/light preference (US4). The toggle lives in the app bar so it is
  // reachable on every authenticated screen on both web and native (FR-005 / SC-003).
  const { theme: themeName, toggle } = useThemePref();
  const isDark = themeName === 'dark';

  const links: { label: string; href: string; testID: string }[] = [
    { label: 'My Collections', href: '/(app)/home', testID: 'nav-home' },
    { label: 'Profile', href: '/(app)/profile', testID: 'nav-profile' },
  ];

  return (
    <XStack
      testID="navigation-bar"
      alignItems="center"
      justifyContent="space-between"
      paddingHorizontal={20}
      paddingVertical={12}
      backgroundColor={theme.surface2?.val}
    >
      <Text fontFamily="$heading" fontSize={22} fontWeight="700" letterSpacing={2} color={theme.primary?.val}>
        MCM
      </Text>
      <XStack gap={24} alignItems="center">
        {links.map((link) => {
          const active =
            pathname === link.href || pathname.startsWith(link.href.replace('/(', '('));
          return (
            <Link key={link.href} href={link.href as never} asChild>
              <TouchableOpacity
                testID={link.testID}
                accessibilityRole="button"
                accessibilityLabel={`Navigate to ${link.label}`}
              >
                <Text
                  fontFamily="$body"
                  fontSize={16}
                  fontWeight={active ? '700' : '500'}
                  color={active ? theme.primary?.val : theme.onSurfaceVariant?.val}
                >
                  {link.label}
                </Text>
              </TouchableOpacity>
            </Link>
          );
        })}
        <TouchableOpacity
          testID="theme-toggle"
          accessibilityRole="button"
          accessibilityLabel={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          onPress={toggle}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text fontSize={18} color={theme.onSurfaceVariant?.val}>
            {isDark ? '☀' : '☾'}
          </Text>
        </TouchableOpacity>
      </XStack>
    </XStack>
  );
}
