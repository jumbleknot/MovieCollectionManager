/**
 * Unit tests for useAuth hook (T-075)
 */

import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { apiClient } from '@/bff-server/api-client';
import { AuthProvider, useAuth } from '@/hooks/use-auth';

jest.mock('@/bff-server/api-client', () => ({
  apiClient: { post: jest.fn(), get: jest.fn() },
}));

jest.mock('@/utils/session-storage', () => ({
  hasStoredSession: jest.fn().mockResolvedValue(false),
  clearTokens: jest.fn().mockResolvedValue(undefined),
}));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

const mockedGet = jest.mocked(apiClient.get);
const mockedPost = jest.mocked(apiClient.post);

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

  it('refreshAuth fetches profile and sets authenticated state', async () => {
    const mockUser = {
      id: 'user-1', username: 'tuser', email: 'test@example.com',
      firstName: 'Test', lastName: 'User', emailVerified: true,
      roles: ['mc-user'], accountStatus: 'active' as const, createdAt: '2026-01-01T00:00:00.000Z',
    };
    mockedGet.mockResolvedValueOnce({ data: mockUser } as never);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {});

    await act(async () => {
      await result.current.refreshAuth();
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toEqual(mockUser);
  });

  it('logout clears state and redirects to login', async () => {
    mockedPost.mockResolvedValueOnce({ data: {} } as never);

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
    mockedPost.mockResolvedValueOnce({ data: {} } as never);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {});

    await act(async () => {
      result.current.onTimeout();
    });

    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
  });
});
