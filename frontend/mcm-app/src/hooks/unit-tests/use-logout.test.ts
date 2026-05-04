/**
 * Unit tests for useLogout hook (T-108)
 */

import { renderHook, act } from '@testing-library/react-native';
import axios from 'axios';
import { useLogout } from '@/hooks/use-logout';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockAuthLogout = jest.fn().mockResolvedValue(undefined);
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ logout: mockAuthLogout }),
}));

describe('useLogout', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls BFF /logout and then auth logout on success', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { success: true } });

    const { result } = renderHook(() => useLogout());

    await act(async () => {
      await result.current.logout();
    });

    expect(mockedAxios.post).toHaveBeenCalledWith('/bff-api/auth/logout', {}, expect.any(Object));
    expect(mockAuthLogout).toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('still calls auth logout when BFF call fails (best-effort)', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useLogout());

    await act(async () => {
      await result.current.logout();
    });

    // Auth logout should still be called despite BFF failure
    expect(mockAuthLogout).toHaveBeenCalled();
  });
});
