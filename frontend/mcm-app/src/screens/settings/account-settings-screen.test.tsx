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

// The screen delegates the platform branch to the hook; this asserts the SCREEN's contract —
// two deliberate acts, both lists shown, and every failure saying the account still exists.
// The hook's own web/native behaviour is covered by use-account-deletion.test.ts.
const mockStart = jest.fn();
jest.mock('@/hooks/use-account-deletion', () => ({
  useAccountDeletion: () => ({ busy: false, start: mockStart }),
}));

let mockSearchParams: Record<string, string> = {};
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

import { AccountSettingsScreen } from '@/screens/settings/account-settings-screen';

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = {};
  mockStart.mockResolvedValue({ deleted: false });
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
    expect(mockStart).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('account-delete-confirm'));
    await waitFor(() => expect(mockStart).toHaveBeenCalled());
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
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('hands off to the identity provider round trip once confirmed', async () => {
    render(<AccountSettingsScreen />);
    fireEvent.press(screen.getByTestId('account-delete-button'));
    fireEvent.press(screen.getByTestId('account-delete-confirm'));

    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));
  });

  it('shows the confirmation page when native reports the account was deleted', async () => {
    // Web never reaches this — it navigates away and the BFF redirects. Native completes
    // in-process, so the screen owns the final navigation.
    mockStart.mockResolvedValue({ deleted: true });

    render(<AccountSettingsScreen />);
    fireEvent.press(screen.getByTestId('account-delete-button'));
    fireEvent.press(screen.getByTestId('account-delete-confirm'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/account-deleted'));
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
    mockStart.mockRejectedValue(new Error('network'));

    render(<AccountSettingsScreen />);
    fireEvent.press(screen.getByTestId('account-delete-button'));
    fireEvent.press(screen.getByTestId('account-delete-confirm'));

    await waitFor(() => expect(screen.getByTestId('account-delete-error')).toBeTruthy());
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
