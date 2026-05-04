/**
 * AuthGuard component (T-081)
 * Protects routes by checking JWT + role via useAuth.
 * Redirects unauthenticated users to login.
 */

import React from 'react';
import { useRouter } from 'expo-router';
import { LoadingIndicator } from '@/components/loading-indicator';
import { useAuth } from '@/hooks/use-auth';
import { ClientRole } from '@/types/auth';

interface AuthGuardProps {
  children: React.ReactNode;
  /** Required role — defaults to mc-user */
  requiredRole?: ClientRole | 'mc-user' | 'mc-admin';
}

export function AuthGuard({ children, requiredRole = 'mc-user' }: AuthGuardProps): React.JSX.Element | null {
  const { isAuthenticated, isLoading, user } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/(auth)/login');
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return <LoadingIndicator message="Checking authentication..." testID="auth-guard-loading" />;
  }

  if (!isAuthenticated || !user) return null;

  const hasRole =
    user.roles.includes('mc-admin') ||
    (requiredRole === 'mc-user' && user.roles.includes('mc-user'));

  if (!hasRole) {
    router.replace('/(auth)/login');
    return null;
  }

  return <>{children}</>;
}
