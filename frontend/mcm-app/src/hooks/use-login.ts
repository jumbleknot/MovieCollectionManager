/**
 * useLogin hook (T-063)
 * Receives the auth code result from useKeycloakAuth and calls BFF /login.
 * Returns true on success so the caller can trigger auth state refresh and navigation.
 */

import { useState } from 'react';
import axios from 'axios';
import { getErrorMessage } from '@/utils/errors';
import { storeTokens } from '@/utils/session-storage';
import type { LoginRequest, LoginResponse } from '@/types/auth';

export interface LoginState {
  isLoading: boolean;
  error: string | null;
}

export interface UseLoginReturn extends LoginState {
  login: (request: LoginRequest) => Promise<boolean>;
  clearError: () => void;
}

export function useLogin(): UseLoginReturn {
  const [state, setState] = useState<LoginState>({ isLoading: false, error: null });

  async function login(request: LoginRequest): Promise<boolean> {
    setState({ isLoading: true, error: null });

    try {
      const res = await axios.post<LoginResponse>('/bff-api/auth/login', request, {
        withCredentials: true,
      });

      const sessionId = res.headers['x-session-id'] as string | undefined;

      if (sessionId) {
        await storeTokens('', '', sessionId);
      }

      setState({ isLoading: false, error: null });
      return true;
    } catch (err) {
      setState({ isLoading: false, error: getErrorMessage(err) });
      return false;
    }
  }

  function clearError() {
    setState((prev) => ({ ...prev, error: null }));
  }

  return { ...state, login, clearError };
}
