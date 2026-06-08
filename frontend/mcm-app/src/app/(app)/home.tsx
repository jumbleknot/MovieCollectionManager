/**
 * Home route — authenticated users' landing page.
 * AuthGuard and NavigationBar are provided by (app)/_layout.tsx.
 *
 * FR-009: If the user has a default collection, replace the route with the
 * collection screen on login. This redirect is handled by HomeScreen once
 * collections are loaded (via the useCollections hook).
 */

import React from 'react';
import { HomeScreen } from '@/screens/home/home-screen';
import { useReportUiState } from '@/hooks/use-ui-state';

export default function HomeRoute(): React.JSX.Element {
  // US3: on home there is no on-screen collection — "add this" here asks the user to clarify.
  useReportUiState({ current_screen: 'home', nav_depth: 0 });

  return <HomeScreen />;
}
