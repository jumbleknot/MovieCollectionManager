/**
 * Account deleted confirmation (feature 076, T025 — FR-030).
 *
 * The property worth pinning is that this page makes NO claim the user cannot verify, and does
 * repeat the one promise they can no longer check for themselves: their files are still theirs.
 */

import React from 'react';
import { render, screen } from '@/test-support/render';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));

import AccountDeletedRoute from '@/app/account-deleted';

beforeEach(() => jest.clearAllMocks());

describe('AccountDeletedRoute', () => {
  it('confirms the deletion', () => {
    render(<AccountDeletedRoute />);

    expect(screen.getByTestId('account-deleted-confirmation')).toBeTruthy();
    expect(screen.getByText(/account has been deleted/i)).toBeTruthy();
  });

  it('repeats that the files at the user own storage were left alone', () => {
    render(<AccountDeletedRoute />);

    expect(screen.getByText(/left untouched/i)).toBeTruthy();
    expect(screen.getByText(/still have the credentials/i)).toBeTruthy();
  });

  it('says the standing permission was withdrawn', () => {
    render(<AccountDeletedRoute />);

    expect(screen.getByText(/permission .* withdrawn/i)).toBeTruthy();
  });

  it('offers a way out that does not assume a session', () => {
    render(<AccountDeletedRoute />);

    expect(screen.getByTestId('account-deleted-home')).toBeTruthy();
  });
});
