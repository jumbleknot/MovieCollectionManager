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
import axios from 'axios';
import { clearTokens, hasStoredSession } from '@/utils/session-storage';
import { getErrorMessage } from '@/utils/errors';
import type { UserProfile } from '@/types/auth';

export interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UserProfile | null;
  /** Fetch profile and mark user as authenticated — call after a successful login */
  refreshAuth: () => Promise<void>;
  /** Refresh user profile from BFF /user without changing auth state */
  refreshProfile: () => Promise<void>;
  logout: () => Promise<void>;
  /** Called by useSessionTimeout when idle/absolute timeout fires */
  onTimeout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);

  // Determine initial auth state
  useEffect(() => {
    (async () => {
      const hasSession = await hasStoredSession();
      if (hasSession) {
        try {
          const res = await axios.get<UserProfile>('/bff-api/auth/user', {
            withCredentials: true,
          });
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
    const res = await axios.get<UserProfile>('/bff-api/auth/user', {
      withCredentials: true,
    });
    setUser(res.data);
    setIsAuthenticated(true);
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const res = await axios.get<UserProfile>('/bff-api/auth/user', {
        withCredentials: true,
      });
      setUser(res.data);
    } catch (err) {
      console.error('Failed to refresh profile:', getErrorMessage(err));
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await axios.post('/bff-api/auth/logout', {}, { withCredentials: true });
    } catch {
      // Best-effort logout
    }
    await clearTokens();
    setIsAuthenticated(false);
    setUser(null);
    router.replace('/(auth)/login');
  }, [router]);

  const onTimeout = useCallback(() => {
    logout();
  }, [logout]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, user, refreshAuth, refreshProfile, logout, onTimeout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
