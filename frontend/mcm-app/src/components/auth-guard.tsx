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

  const roles = user?.roles ?? [];
  const hasRole =
    roles.includes('mc-admin') ||
    (requiredRole === 'mc-user' && roles.includes('mc-user'));

  React.useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated || !hasRole) {
      router.replace('/(auth)/login');
    }
  }, [isAuthenticated, isLoading, hasRole, router]);

  if (isLoading) {
    return <LoadingIndicator message="Checking authentication..." testID="auth-guard-loading" />;
  }

  if (!isAuthenticated || !user || !hasRole) return null;

  return <>{children}</>;
}
