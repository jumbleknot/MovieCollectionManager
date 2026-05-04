/**
 * Unit tests for AuthGuard component (T-092)
 */

import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { AuthGuard } from '@/components/auth-guard';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

import { useAuth } from '@/hooks/use-auth';
const mockedUseAuth = useAuth as jest.Mock;

describe('AuthGuard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows loading indicator while auth is loading', () => {
    mockedUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: true, user: null });

    const { getByTestId } = render(
      <AuthGuard><Text testID="protected">Content</Text></AuthGuard>,
    );

    expect(getByTestId('auth-guard-loading')).toBeTruthy();
  });

  it('renders children for authenticated mc-user', () => {
    mockedUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { roles: ['mc-user'] },
    });

    const { getByTestId } = render(
      <AuthGuard><Text testID="protected">Content</Text></AuthGuard>,
    );

    expect(getByTestId('protected')).toBeTruthy();
  });

  it('renders children for mc-admin (implicit mc-user)', () => {
    mockedUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { roles: ['mc-admin'] },
    });

    const { getByTestId } = render(
      <AuthGuard><Text testID="protected">Admin Content</Text></AuthGuard>,
    );

    expect(getByTestId('protected')).toBeTruthy();
  });

  it('redirects unauthenticated users to login', async () => {
    mockedUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false, user: null });

    render(<AuthGuard><Text>Protected</Text></AuthGuard>);

    // useEffect fires after render — check that replace was called
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
  });
});
