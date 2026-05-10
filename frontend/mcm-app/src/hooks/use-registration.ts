/**
 * useRegistration hook (T-046)
 * Orchestrates registration form state, API call to BFF /register, and error handling.
 */

import { useState } from 'react';
import axios from 'axios';
import { getErrorMessage } from '@/utils/errors';
import type { RegisterRequest, RegisterResponse } from '@/types/auth';

export interface RegistrationState {
  isLoading: boolean;
  error: string | null;
  isSuccess: boolean;
  registeredEmail: string | null;
}

export interface UseRegistrationReturn extends RegistrationState {
  register: (data: Omit<RegisterRequest, never>) => Promise<void>;
  reset: () => void;
}

export function useRegistration(): UseRegistrationReturn {
  const [state, setState] = useState<RegistrationState>({
    isLoading: false,
    error: null,
    isSuccess: false,
    registeredEmail: null,
  });

  async function register(data: RegisterRequest): Promise<void> {
    setState({ isLoading: true, error: null, isSuccess: false, registeredEmail: null });

    try {
      const res = await axios.post<RegisterResponse>('/bff-api/auth/register', data, {
        withCredentials: true,
      });

      if (res.data.success) {
        setState({
          isLoading: false,
          error: null,
          isSuccess: true,
          registeredEmail: data.email,
        });
      } else {
        setState({
          isLoading: false,
          error: 'Registration failed. Please try again.',
          isSuccess: false,
          registeredEmail: null,
        });
      }
    } catch (err) {
      setState({
        isLoading: false,
        error: getErrorMessage(err),
        isSuccess: false,
        registeredEmail: null,
      });
    }
  }

  function reset() {
    setState({ isLoading: false, error: null, isSuccess: false, registeredEmail: null });
  }

  return { ...state, register, reset };
}
