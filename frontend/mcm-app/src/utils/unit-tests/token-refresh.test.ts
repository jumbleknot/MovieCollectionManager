/**
 * Unit tests for token refresh strategy (T-039)
 */

import axios from 'axios';
import { silentRefresh, isRefreshInProgress } from '@/utils/token-refresh';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('silentRefresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true on successful refresh', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200 });
    const result = await silentRefresh();
    expect(result).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledWith('/bff-api/auth/refresh', null, {
      withCredentials: true,
    });
  });

  it('returns false when refresh fails', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));
    const result = await silentRefresh();
    expect(result).toBe(false);
  });

  it('deduplicates concurrent refresh calls', async () => {
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>((res) => {
      resolveRefresh = res;
    });

    mockedAxios.post.mockReturnValueOnce(refreshPromise.then(() => ({ status: 200 })));

    // Start two concurrent refresh calls
    const p1 = silentRefresh();
    const p2 = silentRefresh();

    resolveRefresh();

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both should succeed, but axios.post should only be called once
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});

describe('isRefreshInProgress', () => {
  it('returns false when no refresh is in progress', () => {
    expect(isRefreshInProgress()).toBe(false);
  });
});
