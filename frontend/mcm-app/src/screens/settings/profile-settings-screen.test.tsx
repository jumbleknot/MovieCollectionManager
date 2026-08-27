/**
 * Unit tests for ProfileSettingsScreen (feature 062, T011).
 *
 * FR-005 — the Profile area presents the user's profile details and the logout control, with
 * behaviour unchanged from before the split. The negative assertions are the point of the
 * split: the admin card and the assistant config used to live on this same scrolling page and
 * must not follow it here.
 */

import React from 'react';
import { render } from '@/test-support/render';
import { ProfileSettingsScreen } from '@/screens/settings/profile-settings-screen';
import type { UserProfile } from '@/types/auth';

const mockUseAuth = jest.fn();
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/(app)/settings',
}));

const BASE_USER: UserProfile = {
  id: 'user-1',
  username: 'someone',
  email: 'someone@test.invalid',
  firstName: 'Some',
  lastName: 'One',
  roles: ['mc-user'],
  emailVerified: true,
  accountStatus: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function setAuth(state: { user: UserProfile | null; isLoading?: boolean }): void {
  mockUseAuth.mockReturnValue({
    user: state.user,
    isAuthenticated: !!state.user,
    isLoading: state.isLoading ?? false,
    logout: jest.fn(),
    refreshAuth: jest.fn(),
  });
}

beforeEach(() => jest.clearAllMocks());

describe('ProfileSettingsScreen', () => {
  it('renders the profile area with the profile details and the logout control', () => {
    setAuth({ user: BASE_USER });
    const { getByTestId } = render(<ProfileSettingsScreen />);
    expect(getByTestId('settings-profile-screen')).toBeTruthy();
    expect(getByTestId('profile-display')).toBeTruthy();
    expect(getByTestId('btn-logout')).toBeTruthy();
  });

  it('renders the loading state while auth is resolving', () => {
    setAuth({ user: null, isLoading: true });
    const { getByTestId } = render(<ProfileSettingsScreen />);
    expect(getByTestId('settings-profile-loading')).toBeTruthy();
  });

  it('renders the empty state when there is no user', () => {
    setAuth({ user: null });
    const { getByTestId } = render(<ProfileSettingsScreen />);
    expect(getByTestId('settings-profile-empty')).toBeTruthy();
  });

  it('does NOT render the assistant configuration — it has its own area now', () => {
    setAuth({ user: BASE_USER });
    const { queryByTestId } = render(<ProfileSettingsScreen />);
    expect(queryByTestId('assistant-config')).toBeNull();
  });

  it('does NOT render an admin-settings card — the sub-navigation replaced it', () => {
    setAuth({ user: { ...BASE_USER, roles: ['mc-user', 'mc-admin'] } });
    const { queryByTestId } = render(<ProfileSettingsScreen />);
    expect(queryByTestId('profile-admin-settings-card')).toBeNull();
  });
});
