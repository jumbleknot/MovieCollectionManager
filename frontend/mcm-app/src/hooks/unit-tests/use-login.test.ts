/**
 * Unit tests for useLogin hook (T-071)
 */

import { renderHook, act } from '@testing-library/react-native';
import axios from 'axios';
import { useLogin } from '@/hooks/use-login';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('@/utils/session-storage', () => ({
  storeTokens: jest.fn().mockResolvedValue(undefined),
}));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

const request = { code: 'auth-code', codeVerifier: 'verifier', redirectUri: 'mcm-app://callback' };

describe('useLogin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('starts with default state', () => {
    const { result } = renderHook(() => useLogin());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('navigates to home on successful login', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, user: { id: 'user-1' } },
      headers: { 'x-session-id': 'session-abc' },
    });

    const { result } = renderHook(() => useLogin());

    await act(async () => {
      await result.current.login(request);
    });

    expect(mockReplace).toHaveBeenCalledWith('/(app)/home');
    expect(result.current.error).toBeNull();
  });

  it('sets error on login failure', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: {
        data: { code: 'INVALID_CODE', error: 'Invalid authorization code.' },
        status: 400,
      },
    });

    const { result } = renderHook(() => useLogin());

    await act(async () => {
      await result.current.login(request);
    });

    expect(result.current.error).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('clears error via clearError', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('fail'));

    const { result } = renderHook(() => useLogin());

    await act(async () => {
      await result.current.login(request);
    });

    act(() => { result.current.clearError(); });

    expect(result.current.error).toBeNull();
  });
});
