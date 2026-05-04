/**
 * useAuthGuard hook (T-087)
 * Checks JWT + role, provides redirect logic and loading state.
 */

import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from '@/hooks/use-auth';
import { hasRole } from '@/utils/role-checker';
import type { AppRole } from '@/utils/role-checker';

interface UseAuthGuardOptions {
  requiredRole?: AppRole;
  redirectTo?: string;
}

interface UseAuthGuardReturn {
  isLoading: boolean;
  isAuthorized: boolean;
}

export function useAuthGuard({
  requiredRole = 'mc-user',
  redirectTo = '/(auth)/login',
}: UseAuthGuardOptions = {}): UseAuthGuardReturn {
  const { isAuthenticated, isLoading, user } = useAuth();
  const router = useRouter();

  const isAuthorized = isAuthenticated && hasRole(user, requiredRole);

  useEffect(() => {
    if (!isLoading && !isAuthorized) {
      router.replace(redirectTo as never);
    }
  }, [isLoading, isAuthorized, redirectTo, router]);

  return { isLoading, isAuthorized };
}
