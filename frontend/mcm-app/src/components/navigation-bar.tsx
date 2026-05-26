/**
 * Navigation bar component (T-082)
 * Displays Home and Profile links with app logo.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Link, usePathname } from 'expo-router';

export function NavigationBar(): React.JSX.Element {
  const pathname = usePathname();

  const links: { label: string; href: string; testID: string }[] = [
    { label: 'My Collections', href: '/(app)/home', testID: 'nav-home' },
    { label: 'Profile', href: '/(app)/profile', testID: 'nav-profile' },
  ];

  return (
    <View style={styles.container} testID="navigation-bar">
      <Text style={styles.logo}>MCM</Text>
      <View style={styles.links}>
        {links.map((link) => (
          <Link key={link.href} href={link.href as never} asChild>
            <TouchableOpacity
              testID={link.testID}
              accessibilityRole="button"
              accessibilityLabel={`Navigate to ${link.label}`}
            >
              <Text
                style={[
                  styles.link,
                  pathname === link.href || pathname.startsWith(link.href.replace('/(', '('))
                    ? styles.linkActive
                    : null,
                ]}
              >
                {link.label}
              </Text>
            </TouchableOpacity>
          </Link>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: '#1a202c',
  },
  logo: {
    fontSize: 20,
    fontWeight: '800',
    color: '#63b3ed',
    letterSpacing: 2,
  },
  links: {
    flexDirection: 'row',
    gap: 24,
  },
  link: {
    fontSize: 15,
    color: '#a0aec0',
    fontWeight: '500',
  },
  linkActive: {
    color: '#fff',
    fontWeight: '700',
  },
});
