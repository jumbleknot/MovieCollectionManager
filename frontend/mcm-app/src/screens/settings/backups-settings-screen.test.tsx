/**
 * Unit test for BackupsSettingsScreen.
 *
 * UPDATED AT THE CAUSE, not deleted. Feature 062 asserted this area "is not yet available",
 * and feature 073 is precisely the change that makes that false — so the assertion is replaced
 * with the one that now expresses the requirement, rather than removed for being inconvenient.
 * What 062 was really protecting still holds and is still asserted here: the area announces
 * itself under the SAME testID, so the route, its registry row and the agent gateway's
 * `settings-backups` current_screen contract are untouched by this feature.
 */

import React from 'react';
import { render, waitFor } from '@/test-support/render';
import { BackupsSettingsScreen } from '@/screens/settings/backups-settings-screen';

jest.mock('@/bff-server/api-client', () => ({
  apiClient: {
    get: jest.fn(async () => ({ data: [] })),
    post: jest.fn(async () => ({ data: {} })),
    patch: jest.fn(async () => ({ data: {} })),
    delete: jest.fn(async () => ({ data: null })),
  },
}));

describe('BackupsSettingsScreen', () => {
  it('renders the backups area under its unchanged testID', async () => {
    const { getByTestId } = render(<BackupsSettingsScreen />);
    await waitFor(() => expect(getByTestId('settings-backups-screen')).toBeTruthy());
  });

  it('identifies the area and offers a destination to be added', async () => {
    const { getByText, getByTestId } = render(<BackupsSettingsScreen />);
    // Exact, not /backups/i — the area names itself in the heading AND the body copy, and a
    // loose match would resolve both and fail on ambiguity rather than on the requirement.
    // The jobs card below is titled "Backup jobs" precisely so this stays unambiguous: two
    // cards headed "Backups" on one screen was confusing to read before it was hard to locate.
    expect(getByText('Backups')).toBeTruthy();
    expect(getByText('Backup jobs')).toBeTruthy();
    await waitFor(() => expect(getByTestId('backup-destination-add')).toBeTruthy());
  });

  it('says there are no destinations yet rather than showing an empty area', async () => {
    const { getByTestId } = render(<BackupsSettingsScreen />);
    await waitFor(() => expect(getByTestId('backup-destination-list-empty')).toBeTruthy());
  });
});
