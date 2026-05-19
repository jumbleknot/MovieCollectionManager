/**
 * Home route — authenticated users' landing page.
 * AuthGuard and NavigationBar are provided by (app)/_layout.tsx.
 */

import React from 'react';
import { View } from 'react-native';

export default function HomeRoute(): React.JSX.Element {
  return <View style={{ flex: 1 }} testID="home-route" />;
}
