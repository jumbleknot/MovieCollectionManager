/**
 * Unit tests for useLogout hook (T-108)
 */

import { renderHook, act } from '@testing-library/react-native';
import { apiClient } from '@/bff-server/api-client';
import { useLogout } from '@/hooks/use-logout';

jest.mock('@/bff-server/api-client', () => ({
  apiClient: { post: jest.fn(), get: jest.fn() },
}));

const mockAuthLogout = jest.fn().mockResolvedValue(undefined);
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ logout: mockAuthLogout }),
}));

const mockedPost = jest.mocked(apiClient.post);

describe('useLogout', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls BFF /logout and then auth logout on success', async () => {
    mockedPost.mockResolvedValueOnce({ data: { success: true } } as never);

    const { result } = renderHook(() => useLogout());

    await act(async () => {
      await result.current.logout();
    });

    expect(mockedPost).toHaveBeenCalledWith('/bff-api/auth/logout');
    expect(mockAuthLogout).toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('still calls auth logout when BFF call fails (best-effort)', async () => {
    mockedPost.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useLogout());

    await act(async () => {
      await result.current.logout();
    });

    expect(mockAuthLogout).toHaveBeenCalled();
  });
});
