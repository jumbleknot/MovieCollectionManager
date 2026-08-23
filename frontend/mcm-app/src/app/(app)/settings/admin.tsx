/**
 * Settings → Admin route (feature 062; re-parented from (app)/admin/settings.tsx).
 *
 * FR-009, FR-010, FR-013. The (app) layout guards at mc-user; ProtectedRoute here restricts to
 * mc-admin specifically, and THAT is the access control. Filtering the Admin entry out of the
 * sub-navigation for a non-admin is presentation only — the two are tested separately
 * (openwiki/gotchas/role-enforcement-is-a-layer.md), because a link's absence has never been a
 * guard: this very screen was reachable by URL for a whole feature cycle before a card existed.
 *
 * Reports `settings-admin` / depth 1. It replaces `admin-settings`, which the BFF's
 * ALLOWED_SCREENS never contained and which was therefore silently reduced to `unknown` on every
 * visit — drift this feature closes rather than merely renames.
 */

import React from 'react';
import { ProtectedRoute } from '@/components/protected-route';
import { AdminSettingsScreen } from '@/screens/admin/admin-settings-screen';
import { useReportUiState } from '@/hooks/use-ui-state';

export default function SettingsAdminRoute(): React.JSX.Element {
  useReportUiState({ current_screen: 'settings-admin', nav_depth: 1 });
  return (
    <ProtectedRoute requiredRole="mc-admin">
      <AdminSettingsScreen />
    </ProtectedRoute>
  );
}
