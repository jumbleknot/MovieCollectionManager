/**
 * useAuth hook (T-064)
 * Global auth state context: isAuthenticated, user profile, login/logout actions.
 * Also wires the session timeout callback.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useRouter } from 'expo-router';
import { clearSession, hasStoredSession } from '@/utils/session-storage';
import { clearAutoNav } from '@/utils/default-collection-auto-nav';
import { apiClient } from '@/bff-server/api-client';
import { getErrorMessage } from '@/utils/errors';
import type { UserProfile } from '@/types/auth';

export interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UserProfile | null;
  /** Reason the user was logged out by a timeout, cleared on next login */
  timeoutReason: 'idle' | 'absolute' | null;
  /** Fetch profile and mark user as authenticated — call after a successful login */
  refreshAuth: () => Promise<void>;
  /** Refresh user profile from BFF /user without changing auth state */
  refreshProfile: () => Promise<void>;
  logout: () => Promise<void>;
  /** Called by useSessionTimeout with the timeout reason */
  logoutWithTimeout: (reason: 'idle' | 'absolute') => Promise<void>;
  clearTimeoutReason: () => void;
  /** @deprecated use logoutWithTimeout from the authenticated layout */
  onTimeout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [timeoutReason, setTimeoutReason] = useState<'idle' | 'absolute' | null>(null);

  // Determine initial auth state
  useEffect(() => {
    (async () => {
      const hasSession = await hasStoredSession();
      if (hasSession) {
        try {
          const res = await apiClient.get<UserProfile>('/bff-api/auth/user');
          setUser(res.data);
          setIsAuthenticated(true);
        } catch {
          // Session invalid — stay unauthenticated
        }
      }
      setIsLoading(false);
    })();
  }, []);

  const refreshAuth = useCallback(async () => {
    const res = await apiClient.get<UserProfile>('/bff-api/auth/user');
    setUser(res.data);
    setIsAuthenticated(true);
    // Clear FR-009 flag on every explicit login so the redirect fires fresh.
    // This handles the case where the user previously had a stored session flag
    // that survived (e.g., same browser tab, or from a prior session).
    clearAutoNav();
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const res = await apiClient.get<UserProfile>('/bff-api/auth/user');
      setUser(res.data);
    } catch (err) {
      console.error('Failed to refresh profile:', getErrorMessage(err));
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiClient.post('/bff-api/auth/logout');
    } catch {
      // Best-effort logout
    }
    clearAutoNav(); // Reset FR-009 flag so the redirect fires again after re-login
    await clearSession();
    setIsAuthenticated(false);
    setUser(null);
    router.replace('/(auth)/login');
  }, [router]);

  const logoutWithTimeout = useCallback(async (reason: 'idle' | 'absolute') => {
    setTimeoutReason(reason);
    await logout();
  }, [logout]);

  const clearTimeoutReason = useCallback(() => {
    setTimeoutReason(null);
  }, []);

  const onTimeout = useCallback(() => {
    logout();
  }, [logout]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, user, timeoutReason, refreshAuth, refreshProfile, logout, logoutWithTimeout, clearTimeoutReason, onTimeout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
