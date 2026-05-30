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

export default function HomeRoute(): React.JSX.Element {
  return <HomeScreen />;
}
