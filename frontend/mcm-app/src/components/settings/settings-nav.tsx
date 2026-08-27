/**
 * SettingsNav — the sub-navigation rendered above every settings area (feature 062).
 *
 * Requirements: FR-003 (a shared sub-navigation listing the areas available to the current
 * user, indicating which is active), FR-008 (the Admin entry appears only for an mc-admin),
 * FR-017 (stable, addressable identifiers for the container and each entry).
 *
 * Composes the design system's `NavList` rather than hand-rolling a row — the constitution
 * requires new UI to extend the design system, not bypass it.
 *
 * It was a horizontal `Tabs` row until the shape was measured on a device: 449px of tabs in a
 * 320px viewport put the Admin entry off-screen behind an unindicated horizontal scroll (backlog
 * item #240), and `Tabs` draws selection as a sliding pill separate from the hover background,
 * so the two shapes disagree by construction. A vertical `NavList` has room for full labels and
 * uses ONE rounded row for both states.
 *
 * ROLE VISIBILITY IS PRESENTATION, NEVER ENFORCEMENT. Filtering the admin row out for a
 * non-admin hides a link; it does not control access. `(app)/settings/admin.tsx` carries
 * `ProtectedRoute requiredRole="mc-admin"` independently, and THAT refuses a direct visit.
 * See openwiki/gotchas/role-enforcement-is-a-layer.md — the deleted admin-settings-card is
 * the standing proof that a link's absence is not access control.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { NavList, type NavListItem } from '@mcm/design-system';
import { useRouter, usePathname } from 'expo-router';
import { useAuth } from '@/hooks/use-auth';
import { isAdmin } from '@/utils/role-checker';

const SETTINGS_GROUP = '/(app)/settings';

interface SettingsArea {
  /** Matches the route file name under `settings/`. */
  key: string;
  label: string;
  href: string;
  /**
   * STABLE EXTERNAL-CONTRACT SELECTOR — exempt from the constitution's
   * behaviour-descriptive-identifier rule under its carve-out for E2E selectors.
   * See specs/062-settings-split/contracts/ui-contract.md §2.
   */
  testID: string;
  /** Presentation filter only. The route's own guard is the access control. */
  adminOnly?: boolean;
}

/**
 * The settings-area registry — the single source of truth for the sub-navigation.
 * Adding an area is one row plus a route and a screen; no other area changes (SC-006).
 */
const SETTINGS_AREAS: SettingsArea[] = [
  { key: 'index',     label: 'Profile',         href: SETTINGS_GROUP,                testID: 'settings-nav-profile' },
  { key: 'assistant', label: 'Movie Assistant', href: `${SETTINGS_GROUP}/assistant`, testID: 'settings-nav-assistant' },
  { key: 'backups',   label: 'Backups',         href: `${SETTINGS_GROUP}/backups`,   testID: 'settings-nav-backups' },
  { key: 'admin',     label: 'Admin',           href: `${SETTINGS_GROUP}/admin`,     testID: 'settings-nav-admin', adminOnly: true },
];

interface SettingsNavProps {
  /** Compact rows for the narrow layout, where the list stacks above the content. */
  compact?: boolean;
}

export function SettingsNav({ compact = false }: SettingsNavProps = {}): React.JSX.Element {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const areas = SETTINGS_AREAS.filter((area) => !area.adminOnly || isAdmin(user));

  // Exact match for the group path, suffix match for a child. NavigationBar uses a bare
  // `startsWith` here, which would light Profile up on every child path — do not copy it.
  // A path naming no known area selects NOTHING; defaulting to `index` would light Profile
  // up on a child area that has no row yet, which is the same bug one step removed.
  const activeKey =
    areas.find((area) =>
      area.key === 'index'
        ? pathname === SETTINGS_GROUP || pathname === '/settings'
        : pathname.endsWith(`/settings/${area.key}`),
    )?.key ?? '';

  const items: NavListItem[] = areas.map((area) => ({
    key: area.key,
    label: area.label,
    testID: area.testID,
  }));

  return (
    <View testID="settings-nav" style={styles.container}>
      <NavList
        items={items}
        activeKey={activeKey}
        compact={compact}
        accessibilityLabel="Settings sections"
        onSelect={(key) => {
          const target = areas.find((area) => area.key === key);
          // REPLACE, not navigate/push — and this was measured, not assumed. research.md §R4
          // specifies `router.navigate`; on expo-router 56 it PUSHES a sibling settings area
          // instead of popping back to it, so profile → backups → assistant → backups left TWO
          // `settings-backups-screen` nodes mounted at once. On web that is a strict-mode
          // violation for every settings testID (two elements, same id) and on both platforms it
          // builds a back-stack of areas the user has to walk out of one at a time. This list has
          // no history of its own: exactly one area is mounted, and Back leaves settings.
          if (target) router.replace(target.href as never);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Layout only — every colour, spacing and type decision lives inside the design system's
  // NavList, which is the point of composing it rather than hand-rolling a list here.
  container: { width: '100%' },
});
