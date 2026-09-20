/**
 * Root unmatched-address route (feature 074, backlog item #237).
 *
 * FR-001. The catch-all: any address that matches no route ANYWHERE, including outside the (app)
 * group, renders here instead of Expo Router's unstyled built-in unmatched screen.
 *
 * Route only — the screen component lives in src/screens/, per the Screens-Layer rule that routes
 * never define screen content.
 *
 * There is deliberately no sibling inside the (app) group. One was built and measured unreachable:
 * Expo Router groups are URL-transparent, so /(app)/profile normalizes to /profile and cannot be
 * attributed back to the group — this root route takes every unmatched address. The navigation bar
 * item #237 asked for is therefore rendered by the screen itself, for signed-in visitors.
 *
 * No useReportUiState here: that hook reports into authenticated app state, and this route is
 * outside the (app) group, where an anonymous visitor may also land.
 */

import React from 'react';
import { NotFoundScreen } from '@/screens/not-found-screen';

export default function NotFoundRoute(): React.JSX.Element {
  return <NotFoundScreen />;
}
