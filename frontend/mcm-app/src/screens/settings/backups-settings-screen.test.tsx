/**
 * Unit test for BackupsSettingsScreen (feature 062, T028).
 *
 * FR-007 / US3-AC1. The area announces itself and states the capability is not yet available.
 * It exists so backlog item #236 adds a screen BODY rather than re-opening this navigation
 * refactor — the property SC-006 asks this feature to demonstrate.
 */

import React from 'react';
import { render } from '@/test-support/render';
import { BackupsSettingsScreen } from '@/screens/settings/backups-settings-screen';

describe('BackupsSettingsScreen', () => {
  it('renders the backups area placeholder', () => {
    const { getByTestId } = render(<BackupsSettingsScreen />);
    expect(getByTestId('settings-backups-screen')).toBeTruthy();
  });

  it('identifies the area and states the capability is not yet available', () => {
    const { getByText, getByTestId } = render(<BackupsSettingsScreen />);
    // Exact, not /backups/i — the area names itself in the heading AND the body copy, and a
    // loose match would resolve both and fail on ambiguity rather than on the requirement.
    expect(getByText('Backups')).toBeTruthy();
    expect(getByTestId('settings-backups-screen')).toHaveTextContent(/not yet available/i);
  });
});
