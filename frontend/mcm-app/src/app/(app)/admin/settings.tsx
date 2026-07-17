/**
 * Admin settings route (feature 040 US3 / Item 1) — mc-admin only.
 * The (app) layout guards at mc-user; ProtectedRoute here restricts to mc-admin specifically.
 */

import React from 'react';
import { ProtectedRoute } from '@/components/protected-route';
import { AdminSettingsScreen } from '@/screens/admin/admin-settings-screen';
import { useReportUiState } from '@/hooks/use-ui-state';

export default function AdminSettingsRoute(): React.JSX.Element {
  useReportUiState({ current_screen: 'admin-settings', nav_depth: 1 });
  return (
    <ProtectedRoute requiredRole="mc-admin">
      <AdminSettingsScreen />
    </ProtectedRoute>
  );
}
