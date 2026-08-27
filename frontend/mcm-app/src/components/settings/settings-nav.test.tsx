/**
 * Unit tests for SettingsNav (feature 062, T007 / T021).
 *
 * The sub-navigation above every settings area. Two properties are asserted here that no
 * E2E test can cheaply cover:
 *
 *  - The `index` row is active ONLY on the exact group path. NavigationBar gets the
 *    equivalent wrong today (`pathname.startsWith(href)`), which would light Profile up on
 *    every child path; this must not copy that shape.
 *  - The admin row is ABSENT FROM THE TREE for a non-admin, not merely styled invisible.
 *    That is presentation only — the enforcement is ProtectedRoute on the route itself, and
 *    the two are tested separately (openwiki/gotchas/role-enforcement-is-a-layer.md).
 */

import React from 'react';
import { render, fireEvent } from '@/test-support/render';
import { SettingsNav } from '@/components/settings/settings-nav';
import type { UserProfile } from '@/types/auth';

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockNavigate = jest.fn();
let mockPathname = '/(app)/settings';

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush, navigate: mockNavigate }),
  usePathname: () => mockPathname,
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

function setUser(roles: string[]): void {
  mockUseAuth.mockReturnValue({
    user: { ...BASE_USER, roles },
    isAuthenticated: true,
    isLoading: false,
    refreshAuth: jest.fn(),
    logout: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/(app)/settings';
  setUser(['mc-user']);
});

describe('SettingsNav', () => {
  it('renders the sub-navigation container', () => {
    const { getByTestId } = render(<SettingsNav />);
    expect(getByTestId('settings-nav')).toBeTruthy();
  });

  it('renders one locatable entry per settings area available to the user', () => {
    const { getByTestId } = render(<SettingsNav />);
    expect(getByTestId('settings-nav-profile')).toBeTruthy();
    expect(getByTestId('settings-nav-assistant')).toBeTruthy();
  });

  it('marks the entry matching the current path as selected and the others as not', () => {
    mockPathname = '/(app)/settings/assistant';
    const { getByTestId } = render(<SettingsNav />);
    expect(getByTestId('settings-nav-assistant').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(getByTestId('settings-nav-profile').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('activates the Profile entry only on the exact group path, never on a child path', () => {
    mockPathname = '/(app)/settings';
    const onGroup = render(<SettingsNav />);
    expect(onGroup.getByTestId('settings-nav-profile').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    onGroup.unmount();

    // A `startsWith` match — the shape NavigationBar uses — would wrongly light this up.
    mockPathname = '/(app)/settings/backups';
    const onChild = render(<SettingsNav />);
    expect(onChild.getByTestId('settings-nav-profile').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('replaces rather than pushes when an entry is pressed, so tabs build no back-stack', () => {
    const { getByTestId } = render(<SettingsNav />);
    fireEvent.press(getByTestId('settings-nav-assistant'));
    expect(mockReplace).toHaveBeenCalledWith('/(app)/settings/assistant');
    // Measured on expo-router 56: navigate/push mounts a SECOND copy of an area revisited, so two
    // nodes end up sharing one settings testID. Asserting the absence of a push is what keeps a
    // later "simplification" back to navigate from silently reintroducing that.
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('omits the Admin entry from the tree entirely for a non-admin', () => {
    setUser(['mc-user']);
    const { queryByTestId } = render(<SettingsNav />);
    // Absent, not hidden. Presentation only — ProtectedRoute is the enforcement.
    expect(queryByTestId('settings-nav-admin')).toBeNull();
  });

  // ── Feature 062 (T021) — FR-008, US2-AC1/AC2 ──
  // Two assertions, and BOTH are needed: showing the entry to an admin proves the row exists,
  // and its absence for a non-admin proves the filter runs. Neither is access control — that is
  // ProtectedRoute on settings/admin.tsx, asserted separately in admin-settings-access.spec.ts.

  it('shows the Admin entry to an mc-admin', () => {
    setUser(['mc-user', 'mc-admin']);
    const { getByTestId } = render(<SettingsNav />);
    expect(getByTestId('settings-nav-admin')).toBeTruthy();
  });

  it('marks the Admin entry selected on the admin area path', () => {
    setUser(['mc-user', 'mc-admin']);
    mockPathname = '/(app)/settings/admin';
    const { getByTestId } = render(<SettingsNav />);
    expect(getByTestId('settings-nav-admin').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(getByTestId('settings-nav-profile').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('navigates to the admin area when the Admin entry is pressed', () => {
    setUser(['mc-user', 'mc-admin']);
    const { getByTestId } = render(<SettingsNav />);
    fireEvent.press(getByTestId('settings-nav-admin'));
    expect(mockReplace).toHaveBeenCalledWith('/(app)/settings/admin');
  });
});
