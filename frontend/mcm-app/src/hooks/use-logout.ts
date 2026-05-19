/**
 * useLogout hook (T-104)
 * Calls BFF /logout, then invokes useAuth logout action to clear state.
 */

import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { getErrorMessage } from '@/utils/errors';
import { apiClient } from '@/bff-server/api-client';

export interface UseLogoutReturn {
  isLoading: boolean;
  error: string | null;
  logout: () => Promise<void>;
}

export function useLogout(): UseLogoutReturn {
  const { logout: authLogout } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout(): Promise<void> {
    setIsLoading(true);
    setError(null);

    try {
      await apiClient.post('/bff-api/auth/logout');
    } catch (err) {
      // Best-effort: even if BFF call fails, clear client-side state
      console.warn('[useLogout] BFF logout failed:', getErrorMessage(err));
    }

    try {
      await authLogout();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }

  return { isLoading, error, logout };
}
