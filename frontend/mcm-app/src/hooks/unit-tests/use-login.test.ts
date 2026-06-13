/**
 * Unit tests for useLogin hook (T-071)
 */

import { renderHook, act } from '@testing-library/react-native';
import { apiClient } from '@/bff-server/api-client';
import { useLogin } from '@/hooks/use-login';

jest.mock('@/bff-server/api-client', () => ({
  apiClient: { post: jest.fn(), get: jest.fn() },
}));

jest.mock('@/utils/session-storage', () => ({
  storeSession: jest.fn().mockResolvedValue(undefined),
}));

const mockedPost = jest.mocked(apiClient.post);
const request = { code: 'auth-code', codeVerifier: 'verifier', redirectUri: 'mcm-app://callback' };

describe('useLogin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('starts with default state', () => {
    const { result } = renderHook(() => useLogin());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns true and clears error on successful login', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { success: true, user: { id: 'user-1' } },
      headers: { 'x-session-id': 'session-abc' },
    } as never);

    const { result } = renderHook(() => useLogin());
    let loginResult!: boolean;

    await act(async () => {
      loginResult = await result.current.login(request);
    });

    expect(loginResult).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('returns false and sets error on login failure', async () => {
    mockedPost.mockRejectedValueOnce({
      response: {
        data: { code: 'INVALID_CODE', error: 'Invalid authorization code.' },
        status: 400,
      },
    });

    const { result } = renderHook(() => useLogin());
    let loginResult!: boolean;

    await act(async () => {
      loginResult = await result.current.login(request);
    });

    expect(loginResult).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  it('clears error via clearError', async () => {
    mockedPost.mockRejectedValueOnce(new Error('fail'));

    const { result } = renderHook(() => useLogin());

    await act(async () => {
      await result.current.login(request);
    });

    act(() => { result.current.clearError(); });

    expect(result.current.error).toBeNull();
  });
});
