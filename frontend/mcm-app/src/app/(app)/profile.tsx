/**
 * Profile route — authenticated app group (T-086)
 * Navigation bar is provided by (app)/_layout.tsx.
 */

import React from 'react';
import { ProfileScreen } from '@/screens/auth/profile-screen';

export default function ProfileRoute(): React.JSX.Element {
  return <ProfileScreen />;
}
