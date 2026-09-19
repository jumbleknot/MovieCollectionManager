/**
 * Root unmatched-address route (feature 074, backlog item #237).
 *
 * FR-001. The catch-all: any address that matches no route ANYWHERE, including outside the (app)
 * group, renders here instead of Expo Router's unstyled built-in unmatched screen.
 *
 * Route only — the screen component lives in src/screens/, per the Screens-Layer rule that routes
 * never define screen content.
 *
 * No useReportUiState here, deliberately: that hook reports into authenticated app state, and this
 * route is outside the (app) group by design. Its sibling at (app)/+not-found.tsx does report,
 * because it runs inside AuthGuard.
 */

import React from 'react';
import { NotFoundScreen } from '@/screens/not-found-screen';

export default function NotFoundRoute(): React.JSX.Element {
  return <NotFoundScreen />;
}
