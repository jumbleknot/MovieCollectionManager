/**
 * Unmatched-address route INSIDE the authenticated group (feature 074, backlog item #237).
 *
 * FR-002. Not redundant with the root +not-found.tsx: this one sits inside the (app) group, so an
 * unmatched authenticated address — /(app)/profile and /(app)/admin/settings, the two feature 062
 * removed (062 research.md §R1) — renders inside (app)/_layout.tsx and keeps the NavigationBar and
 * AuthGuard. The missing navigation bar is half of what item #237 reported; the root route alone
 * cannot supply it, because there is no authenticated chrome outside the group.
 *
 * It inherits AuthGuard unchanged. A signed-out visitor to one of these addresses is bounced to
 * login exactly as for any other (app) address — existing behaviour, not altered here.
 */

import React from 'react';
import { NotFoundScreen } from '@/screens/not-found-screen';
import { useReportUiState } from '@/hooks/use-ui-state';

export default function AppNotFoundRoute(): React.JSX.Element {
  useReportUiState({ current_screen: 'not-found', nav_depth: 0 });
  return <NotFoundScreen />;
}
