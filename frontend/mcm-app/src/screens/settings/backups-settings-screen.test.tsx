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
import { render, waitFor, fireEvent } from '@/test-support/render';
import { BackupsSettingsScreen } from '@/screens/settings/backups-settings-screen';
import { apiClient } from '@/utils/api-client';

jest.mock('@/utils/api-client', () => ({
  apiClient: {
    get: jest.fn(async () => ({ data: [] })),
    post: jest.fn(async () => ({ data: {} })),
    patch: jest.fn(async () => ({ data: {} })),
    delete: jest.fn(async () => ({ data: null })),
  },
}));

describe('BackupsSettingsScreen', () => {
  it('renders the backups area under its unchanged testID', async () => {
    const { getByTestId } = await render(<BackupsSettingsScreen />);
    await waitFor(() => expect(getByTestId('settings-backups-screen')).toBeTruthy());
  });

  it('identifies the area and offers a destination to be added', async () => {
    const { getByText, getByTestId } = await render(<BackupsSettingsScreen />);
    // Exact, not /backups/i — the area names itself in the heading AND the body copy, and a
    // loose match would resolve both and fail on ambiguity rather than on the requirement.
    // The jobs card below is titled "Backup jobs" precisely so this stays unambiguous: two
    // cards headed "Backups" on one screen was confusing to read before it was hard to locate.
    expect(getByText('Backups')).toBeTruthy();
    expect(getByText('Backup jobs')).toBeTruthy();
    await waitFor(() => expect(getByTestId('backup-destination-add')).toBeTruthy());
  });

  it('says there are no destinations yet rather than showing an empty area', async () => {
    const { getByTestId } = await render(<BackupsSettingsScreen />);
    await waitFor(() => expect(getByTestId('backup-destination-list-empty')).toBeTruthy());
  });

  // Spec 083 T011 (item #843). Measured in production: the switch stayed On. The screen sent
  // `{ schedule: undefined }`, which JSON drops, so the PATCH body was `{}` — and the route reads
  // an absent `schedule` as "leave it alone". Only an explicit `null` clears it.
  it('turning the schedule off sends an explicit null, which is what clears it', async () => {
    const job = {
      id: 'job-1', label: 'Nightly', destinationId: 'dest-1', collectionIds: ['c1'], keepLast: 7,
      enabled: true, schedule: { frequency: 'daily', hour: 3, minute: 0, timeZone: 'America/New_York' },
      nextRunAt: '2026-10-26T07:00:00.000Z',
    };
    (apiClient.get as jest.Mock).mockImplementation(async (url: string) => {
      if (url === '/bff-api/backups/jobs') return { data: [job] };
      if (url === '/bff-api/backups/consent') return { data: { granted: true, grantedAt: '2026-10-25T20:42:28Z' } };
      return { data: [] };
    });

    const { getByTestId } = await render(<BackupsSettingsScreen />);
    await waitFor(() => expect(getByTestId('backup-job-versions-job-1')).toBeTruthy());
    await fireEvent.press(getByTestId('backup-job-versions-job-1'));
    await waitFor(() => expect(getByTestId('backup-schedule-enabled')).toBeTruthy());
    await fireEvent(getByTestId('backup-schedule-enabled'), 'onValueChange', false);

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect(apiClient.patch).toHaveBeenCalledWith('/bff-api/backups/jobs/job-1', { schedule: null });
  });
});
