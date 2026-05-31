/**
 * Unit tests for useAuthGuard hook (T-095)
 */

import { renderHook } from '@testing-library/react-native';
import { useAuthGuard } from '@/hooks/use-auth-guard';

import { useAuth } from '@/hooks/use-auth';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));
const mockedUseAuth = useAuth as jest.Mock;

describe('useAuthGuard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('isLoading=true while auth is loading', () => {
    mockedUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: true, user: null });
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isAuthorized).toBe(false);
  });

  it('isAuthorized=true for authenticated mc-user', () => {
    mockedUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { roles: ['mc-user'] },
    });
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.isAuthorized).toBe(true);
  });

  it('redirects unauthenticated users to login', async () => {
    mockedUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false, user: null });
    renderHook(() => useAuthGuard());
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
  });

  it('redirects to custom path if provided', async () => {
    mockedUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false, user: null });
    renderHook(() => useAuthGuard({ redirectTo: '/custom-login' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReplace).toHaveBeenCalledWith('/custom-login');
  });
});
