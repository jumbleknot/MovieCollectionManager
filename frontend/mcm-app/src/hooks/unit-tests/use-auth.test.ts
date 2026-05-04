/**
 * Unit tests for useAuth hook (T-075)
 */

import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import axios from 'axios';
import { AuthProvider, useAuth } from '@/hooks/use-auth';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('@/utils/session-storage', () => ({
  hasStoredSession: jest.fn().mockResolvedValue(false),
  clearTokens: jest.fn().mockResolvedValue(undefined),
}));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(AuthProvider, null, children);
}

describe('useAuth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('starts unauthenticated', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it('logout clears state and redirects to login', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {});

    await act(async () => {
      await result.current.logout();
    });

    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('onTimeout calls logout', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {});

    await act(async () => {
      result.current.onTimeout();
    });

    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
  });
});
