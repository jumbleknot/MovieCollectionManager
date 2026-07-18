/**
 * Unit tests for AdminSettingsCard (feature 040 follow-on — admin-settings entry point).
 *
 * The card is the missing affordance that lets an mc-admin reach the admin settings screen
 * (previously reachable only by typing /(app)/admin/settings). It self-gates on isAdmin(user):
 *   - mc-admin  → card renders; tapping it navigates to /(app)/admin/settings
 *   - mc-user   → card is absent (null render)
 */

import React from 'react';
import { render, fireEvent } from '@/test-support/render';
import { AdminSettingsCard } from '@/components/admin-settings-card';
import type { UserProfile } from '@/types/auth';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockUseAuth = jest.fn();
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => mockUseAuth(),
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

function setUser(user: UserProfile | null): void {
  mockUseAuth.mockReturnValue({
    user,
    isAuthenticated: !!user,
    isLoading: false,
    refreshAuth: jest.fn(),
    logout: jest.fn(),
  });
}

describe('AdminSettingsCard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the card for an mc-admin user', () => {
    setUser({ ...BASE_USER, roles: ['mc-user', 'mc-admin'] });
    const { getByTestId } = render(<AdminSettingsCard />);
    expect(getByTestId('profile-admin-settings-card')).toBeTruthy();
  });

  it('does not render for an mc-user (non-admin)', () => {
    setUser({ ...BASE_USER, roles: ['mc-user'] });
    const { queryByTestId } = render(<AdminSettingsCard />);
    expect(queryByTestId('profile-admin-settings-card')).toBeNull();
  });

  it('does not render when there is no user', () => {
    setUser(null);
    const { queryByTestId } = render(<AdminSettingsCard />);
    expect(queryByTestId('profile-admin-settings-card')).toBeNull();
  });

  it('navigates to the admin settings screen when tapped', () => {
    setUser({ ...BASE_USER, roles: ['mc-user', 'mc-admin'] });
    const { getByTestId } = render(<AdminSettingsCard />);
    fireEvent.press(getByTestId('profile-admin-settings-card'));
    expect(mockPush).toHaveBeenCalledWith('/(app)/admin/settings');
  });
});
