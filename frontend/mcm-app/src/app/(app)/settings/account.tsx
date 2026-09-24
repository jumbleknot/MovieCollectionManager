/**
 * Settings → Account route (feature 076).
 *
 * FR-001. Thin by construction: routes never define screen components (constitution §Frontend
 * App-Layer). Reports `settings.account` / depth 0 from the screen-label vocabulary, matching
 * the sibling areas.
 */

import React from 'react';
import { AccountSettingsScreen } from '@/screens/settings/account-settings-screen';
import { useReportUiState } from '@/hooks/use-ui-state';

export default function SettingsAccountRoute(): React.JSX.Element {
  useReportUiState({ current_screen: 'settings.account', nav_depth: 0 });
  return <AccountSettingsScreen />;
}
