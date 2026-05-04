/**
 * useLogin hook (T-063)
 * Receives the auth code result from useKeycloakAuth and calls BFF /login.
 * Handles session storage and navigation to home on success.
 */

import { useState } from 'react';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { getErrorMessage } from '@/utils/errors';
import { storeTokens } from '@/utils/session-storage';
import type { LoginRequest, LoginResponse } from '@/types/auth';

export interface LoginState {
  isLoading: boolean;
  error: string | null;
}

export interface UseLoginReturn extends LoginState {
  login: (request: LoginRequest) => Promise<void>;
  clearError: () => void;
}

export function useLogin(): UseLoginReturn {
  const router = useRouter();
  const [state, setState] = useState<LoginState>({ isLoading: false, error: null });

  async function login(request: LoginRequest): Promise<void> {
    setState({ isLoading: true, error: null });

    try {
      const res = await axios.post<LoginResponse>('/bff-api/auth/login', request, {
        withCredentials: true,
      });

      const sessionId = res.headers['x-session-id'] as string | undefined;

      if (sessionId) {
        await storeTokens({ accessToken: '', sessionId });
      }

      setState({ isLoading: false, error: null });
      router.replace('/(app)/home');
    } catch (err) {
      setState({ isLoading: false, error: getErrorMessage(err) });
    }
  }

  function clearError() {
    setState((prev) => ({ ...prev, error: null }));
  }

  return { ...state, login, clearError };
}
