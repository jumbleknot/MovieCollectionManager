/**
 * Settings → Profile route (feature 062) — the landing area of the settings destination.
 *
 * FR-002, FR-004, FR-013. Thin by construction: routes never define screen components
 * (constitution §Frontend App-Layer). Reports `settings` / depth 0 from the screen-label
 * vocabulary in specs/062-settings-split/data-model.md §2 — the pre-split profile route
 * reported nothing at all, so this also closes existing drift.
 */

import React from 'react';
import { ProfileSettingsScreen } from '@/screens/settings/profile-settings-screen';
import { useReportUiState } from '@/hooks/use-ui-state';

export default function SettingsProfileRoute(): React.JSX.Element {
  useReportUiState({ current_screen: 'settings', nav_depth: 0 });
  return <ProfileSettingsScreen />;
}
