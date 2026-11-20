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
  it('renders the danger zone', async () => {
    await render(<AccountSettingsScreen />);

    expect(screen.getByTestId('account-danger-zone')).toBeTruthy();
    expect(screen.getByTestId('account-delete-button')).toBeTruthy();
  });

  it('does not show the confirmation until the user asks for it', async () => {
    await render(<AccountSettingsScreen />);

    expect(screen.queryByTestId('account-delete-confirm')).toBeNull();
  });

  it('takes two deliberate acts to start a deletion', async () => {
    await render(<AccountSettingsScreen />);

    await fireEvent.press(screen.getByTestId('account-delete-button'));
    expect(mockStart).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('account-delete-confirm'));
    await waitFor(() => expect(mockStart).toHaveBeenCalled());
  });

  it('states what will be destroyed AND what will not', async () => {
    await render(<AccountSettingsScreen />);
    await fireEvent.press(screen.getByTestId('account-delete-button'));

    expect(screen.getByTestId('account-delete-dialog')).toBeTruthy();
    expect(screen.getByText(/permanently delete/i)).toBeTruthy();
    expect(screen.getByText(/will not touch/i)).toBeTruthy();
    expect(screen.getByText(/stay\s+where they are/i)).toBeTruthy();
  });

  it('cancelling destroys nothing and closes the dialog', async () => {
    await render(<AccountSettingsScreen />);
    await fireEvent.press(screen.getByTestId('account-delete-button'));
    await fireEvent.press(screen.getByTestId('account-delete-cancel'));

    await waitFor(() => expect(screen.queryByTestId('account-delete-confirm')).toBeNull());
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('hands off to the identity provider round trip once confirmed', async () => {
    await render(<AccountSettingsScreen />);
    await fireEvent.press(screen.getByTestId('account-delete-button'));
    await fireEvent.press(screen.getByTestId('account-delete-confirm'));

    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));
  });

  it('shows the confirmation page when native reports the account was deleted', async () => {
    // Web never reaches this — it navigates away and the BFF redirects. Native completes
    // in-process, so the screen owns the final navigation.
    mockStart.mockResolvedValue({ deleted: true });

    await render(<AccountSettingsScreen />);
    await fireEvent.press(screen.getByTestId('account-delete-button'));
    await fireEvent.press(screen.getByTestId('account-delete-confirm'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/account-deleted'));
  });

  it.each([
    ['reauth', /could not confirm it was you/i],
    ['expired', /timed out/i],
    ['failed', /not.*deleted/i],
  ])('renders the %s error', async (error, pattern) => {
    mockSearchParams = { error };

    await render(<AccountSettingsScreen />);

    expect(screen.getByTestId('account-delete-error')).toBeTruthy();
    expect(screen.getByText(pattern)).toBeTruthy();
  });

  it('every error message makes clear the account still exists', async () => {
    for (const error of ['reauth', 'expired', 'failed']) {
      mockSearchParams = { error };
      const { unmount } = await render(<AccountSettingsScreen />);

      // The banner must not read as a completed deletion.
      expect(screen.queryByText(/deleted successfully|account is gone/i)).toBeNull();
      // and must positively say the account survives.
      expect(screen.getByText(/has not been deleted|was not deleted/i)).toBeTruthy();

      await unmount();
    }
  });

  it('shows no error banner when there is no error', async () => {
    await render(<AccountSettingsScreen />);

    expect(screen.queryByTestId('account-delete-error')).toBeNull();
  });

  it('reports a failed challenge without claiming anything was deleted', async () => {
    mockStart.mockRejectedValue(new Error('network'));

    await render(<AccountSettingsScreen />);
    await fireEvent.press(screen.getByTestId('account-delete-button'));
    await fireEvent.press(screen.getByTestId('account-delete-confirm'));

    await waitFor(() => expect(screen.getByTestId('account-delete-error')).toBeTruthy());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // Item #955: the route's deliberate 409 says what to do; "Please try again" never works there.
  function axiosLikeError(status: number, data: unknown): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      response: { status, data },
    });
  }

  async function confirmDeletion(): Promise<void> {
    await render(<AccountSettingsScreen />);
    await fireEvent.press(screen.getByTestId('account-delete-button'));
    await fireEvent.press(screen.getByTestId('account-delete-confirm'));
    await waitFor(() => expect(screen.getByTestId('account-delete-error')).toBeTruthy());
  }

  it('explains the only-administrator refusal (409) instead of asking the user to retry', async () => {
    mockStart.mockRejectedValue(
      axiosLikeError(409, {
        type: 'about:blank',
        title: 'You are the only administrator',
        status: 409,
        detail: 'Give another account the administrator role before deleting this one.',
      }),
    );

    await confirmDeletion();

    expect(screen.getByText(/only administrator/i)).toBeTruthy();
    expect(screen.getByText(/another account the administrator role/i)).toBeTruthy();
    expect(screen.getByText(/has not been deleted/i)).toBeTruthy();
    expect(screen.queryByText(/please try again/i)).toBeNull();
  });

  it('keeps every other failure generic and reveals none of its detail', async () => {
    mockStart.mockRejectedValue(
      axiosLikeError(503, {
        type: 'about:blank',
        title: 'Could not start account deletion',
        status: 503,
        detail: 'keycloak-service:8080 refused the connection',
      }),
    );

    await confirmDeletion();

    expect(screen.getByText(/could not start the deletion/i)).toBeTruthy();
    expect(screen.queryByText(/keycloak-service/i)).toBeNull();
    expect(screen.queryByText(/only administrator/i)).toBeNull();
  });
});
