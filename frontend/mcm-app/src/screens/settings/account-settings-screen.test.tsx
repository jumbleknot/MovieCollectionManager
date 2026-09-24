/**
 * AccountSettingsScreen (feature 076, T023 — FR-003, FR-004, FR-028, FR-029).
 *
 * Two properties matter more than the layout:
 *
 *   The dialog states what is NOT destroyed as prominently as what is. A user deleting their
 *   account is entitled to know their backup files stay where they are — and saying so is also
 *   what stops a later reader "completing" the cleanup.
 *
 *   Every error message says the account still exists. FR-028 forbids reporting partial success,
 *   and a user unsure whether they still have an account is the outcome to avoid.
 */

import React from 'react';
// The shared harness wraps in the Tamagui provider — a bare RTL render fails with
// "Missing theme" the moment a screen calls useTheme().
import { render, screen, fireEvent, waitFor } from '@/test-support/render';

const mockPost = jest.fn();
jest.mock('@/bff-server/api-client', () => ({
  apiClient: { post: (...a: unknown[]) => mockPost(...a) },
}));

let mockSearchParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

// A full page navigation, not a fetch: this is an interactive sign-in at the identity provider
// and it must happen in the user's own browser. Same mechanism the backup-consent flow uses.
const mockAssign = jest.fn();
Object.defineProperty(window, 'location', {
  value: { assign: mockAssign, href: 'http://localhost:8082/settings/account' },
  writable: true,
});

import { AccountSettingsScreen } from '@/screens/settings/account-settings-screen';

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = {};
  mockPost.mockResolvedValue({ data: { authorizationUrl: 'http://kc/auth?x=1' } });
});

describe('AccountSettingsScreen', () => {
  it('renders the danger zone', () => {
    render(<AccountSettingsScreen />);

    expect(screen.getByTestId('account-danger-zone')).toBeTruthy();
    expect(screen.getByTestId('account-delete-button')).toBeTruthy();
  });

  it('does not show the confirmation until the user asks for it', () => {
    render(<AccountSettingsScreen />);

    expect(screen.queryByTestId('account-delete-confirm')).toBeNull();
  });

  it('takes two deliberate acts to start a deletion', async () => {
    render(<AccountSettingsScreen />);

    fireEvent.press(screen.getByTestId('account-delete-button'));
    expect(mockPost).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('account-delete-confirm'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/bff-api/account/delete-challenge'));
  });

  it('states what will be destroyed AND what will not', () => {
    render(<AccountSettingsScreen />);
    fireEvent.press(screen.getByTestId('account-delete-button'));

    expect(screen.getByTestId('account-delete-dialog')).toBeTruthy();
    expect(screen.getByText(/permanently delete/i)).toBeTruthy();
    expect(screen.getByText(/will not touch/i)).toBeTruthy();
    expect(screen.getByText(/stay\s+where they are/i)).toBeTruthy();
  });

  it('cancelling destroys nothing and closes the dialog', async () => {
    render(<AccountSettingsScreen />);
    fireEvent.press(screen.getByTestId('account-delete-button'));
    fireEvent.press(screen.getByTestId('account-delete-cancel'));

    await waitFor(() => expect(screen.queryByTestId('account-delete-confirm')).toBeNull());
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('sends the browser to the identity provider once the challenge is issued', async () => {
    render(<AccountSettingsScreen />);
    fireEvent.press(screen.getByTestId('account-delete-button'));
    fireEvent.press(screen.getByTestId('account-delete-confirm'));

    await waitFor(() => expect(mockAssign).toHaveBeenCalledWith('http://kc/auth?x=1'));
  });

  it.each([
    ['reauth', /could not confirm it was you/i],
    ['expired', /timed out/i],
    ['failed', /not.*deleted/i],
  ])('renders the %s error', (error, pattern) => {
    mockSearchParams = { error };

    render(<AccountSettingsScreen />);

    expect(screen.getByTestId('account-delete-error')).toBeTruthy();
    expect(screen.getByText(pattern)).toBeTruthy();
  });

  it('every error message makes clear the account still exists', () => {
    for (const error of ['reauth', 'expired', 'failed']) {
      mockSearchParams = { error };
      const { unmount } = render(<AccountSettingsScreen />);

      // The banner must not read as a completed deletion.
      expect(screen.queryByText(/deleted successfully|account is gone/i)).toBeNull();
      // and must positively say the account survives.
      expect(screen.getByText(/has not been deleted|was not deleted/i)).toBeTruthy();

      unmount();
    }
  });

  it('shows no error banner when there is no error', () => {
    render(<AccountSettingsScreen />);

    expect(screen.queryByTestId('account-delete-error')).toBeNull();
  });

  it('reports a failed challenge without claiming anything was deleted', async () => {
    mockPost.mockRejectedValue(new Error('network'));

    render(<AccountSettingsScreen />);
    fireEvent.press(screen.getByTestId('account-delete-button'));
    fireEvent.press(screen.getByTestId('account-delete-confirm'));

    await waitFor(() => expect(screen.getByTestId('account-delete-error')).toBeTruthy());
    expect(mockAssign).not.toHaveBeenCalled();
  });
});
