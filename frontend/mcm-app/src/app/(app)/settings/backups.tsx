/**
 * Settings → Backups route (feature 062).
 *
 * FR-002, FR-007, FR-013. Reports `settings-backups` / depth 1. Backlog item #236 replaces the
 * screen body behind this route; the route, the registry row and the label all stay as they are.
 */

import React from 'react';
import { BackupsSettingsScreen } from '@/screens/settings/backups-settings-screen';
import { useReportUiState } from '@/hooks/use-ui-state';

export default function SettingsBackupsRoute(): React.JSX.Element {
  useReportUiState({ current_screen: 'settings-backups', nav_depth: 1 });
  return <BackupsSettingsScreen />;
}
