/**
 * Settings → Movie Assistant route (feature 062).
 *
 * FR-002, FR-006, FR-013. Reports `settings-assistant` / depth 1. No settings label appears in
 * the gateway's `_COLLECTION_SCREENS`, so the assistant has no collection in view here and must
 * clarify rather than act on a stale target — asserted in assistant-settings-context.spec.ts.
 */

import React from 'react';
import { AssistantSettingsScreen } from '@/screens/settings/assistant-settings-screen';
import { useReportUiState } from '@/hooks/use-ui-state';

export default function SettingsAssistantRoute(): React.JSX.Element {
  useReportUiState({ current_screen: 'settings-assistant', nav_depth: 1 });
  return <AssistantSettingsScreen />;
}
