/**
 * App entry point / index route (T-085)
 * Redirects to login or home depending on auth state.
 */

import React from 'react';
import { Redirect } from 'expo-router';
import { useAuth } from '@/hooks/use-auth';
import { LoadingIndicator } from '@/components/loading-indicator';

export default function Index(): React.JSX.Element {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingIndicator message="Loading..." />;
  }

  return <Redirect href={isAuthenticated ? '/(app)/home' : '/(auth)/login'} />;
}
