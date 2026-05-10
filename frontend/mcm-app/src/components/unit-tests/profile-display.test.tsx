/**
 * Unit tests for ProfileDisplay component (T-093)
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { ProfileDisplay } from '@/components/profile-display';
import type { UserProfile } from '@/types/auth';

const mockUser: UserProfile = {
  id: 'user-1',
  username: 'testuser',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  roles: ['mc-user'],
  emailVerified: true,
  accountStatus: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ProfileDisplay', () => {
  it('renders all user fields', () => {
    const { getByText } = render(
      <ProfileDisplay user={mockUser} onLogout={jest.fn()} />,
    );

    expect(getByText('testuser')).toBeTruthy();
    expect(getByText('test@example.com')).toBeTruthy();
    expect(getByText('Test')).toBeTruthy();
    expect(getByText('User')).toBeTruthy();
    expect(getByText('mc-user')).toBeTruthy();
  });

  it('shows email verification status', () => {
    const { getByTestId } = render(
      <ProfileDisplay user={mockUser} onLogout={jest.fn()} />,
    );
    const emailVerified = getByTestId('profile-email-verified');
    expect(emailVerified).toBeTruthy();
  });

  it('shows logout button', () => {
    const { getByTestId } = render(
      <ProfileDisplay user={mockUser} onLogout={jest.fn()} />,
    );
    expect(getByTestId('btn-logout')).toBeTruthy();
  });

  it('opens logout confirmation dialog on logout press', () => {
    const { getByTestId } = render(
      <ProfileDisplay user={mockUser} onLogout={jest.fn()} />,
    );

    fireEvent.press(getByTestId('btn-logout'));
    expect(getByTestId('logout-dialog')).toBeTruthy();
  });

  it('calls onLogout when dialog confirmed', async () => {
    const onLogout = jest.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(
      <ProfileDisplay user={mockUser} onLogout={onLogout} />,
    );

    fireEvent.press(getByTestId('btn-logout'));
    fireEvent.press(getByTestId('btn-logout-confirm'));

    await new Promise((r) => setTimeout(r, 0));
    expect(onLogout).toHaveBeenCalled();
  });
});
