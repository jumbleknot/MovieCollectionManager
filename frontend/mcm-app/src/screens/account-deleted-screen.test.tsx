/**
 * Account deleted confirmation (feature 076, T025 — FR-030).
 *
 * LIVES OUTSIDE `src/app/`, and that is not a style choice. `expo-router/entry` pulls every
 * matching file under the routes directory into the application's module graph, so a test file
 * placed there drags `@testing-library/react-native` into the RELEASE bundle. The web export
 * tolerated it; the Android build failed outright with `Unable to resolve module console from
 * @testing-library/react-native/build/helpers/logger.js`. No other test in this repository sits
 * under `src/app/` for exactly this reason.
 *
 * The property worth pinning is that this page makes NO claim the user cannot verify, and does
 * repeat the one promise they can no longer check for themselves: their files are still theirs.
 */

import React from 'react';
import { render, screen } from '@/test-support/render';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));

import { AccountDeletedScreen } from '@/screens/account-deleted-screen';

beforeEach(() => jest.clearAllMocks());

describe('AccountDeletedScreen', () => {
  it('confirms the deletion', () => {
    render(<AccountDeletedScreen />);

    expect(screen.getByTestId('account-deleted-confirmation')).toBeTruthy();
    expect(screen.getByText(/account has been deleted/i)).toBeTruthy();
  });

  it('repeats that the files at the user own storage were left alone', () => {
    render(<AccountDeletedScreen />);

    expect(screen.getByText(/left untouched/i)).toBeTruthy();
    expect(screen.getByText(/still have the credentials/i)).toBeTruthy();
  });

  it('says the standing permission was withdrawn', () => {
    render(<AccountDeletedScreen />);

    expect(screen.getByText(/permission .* withdrawn/i)).toBeTruthy();
  });

  it('offers a way out that does not assume a session', () => {
    render(<AccountDeletedScreen />);

    expect(screen.getByTestId('account-deleted-home')).toBeTruthy();
  });
});
