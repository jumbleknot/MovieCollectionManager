/**
 * Unit tests for AssistantSettingsScreen (feature 062, T011).
 *
 * FR-006 — the Movie Assistant area presents the per-user assistant configuration with
 * behaviour unchanged from before the split. The screen is a host: it renders the existing
 * MovieAssistantConfig, whose own selectors must keep resolving after the move.
 */

import React from 'react';
import { render } from '@/test-support/render';
import { AssistantSettingsScreen } from '@/screens/settings/assistant-settings-screen';

jest.mock('@/components/agent/movie-assistant-config', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ReactLocal = require('react');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { View: ViewLocal } = require('react-native');
  return {
    MovieAssistantConfig: () =>
      ReactLocal.createElement(ViewLocal, { testID: 'assistant-config' }),
  };
});

describe('AssistantSettingsScreen', () => {
  it('renders the assistant area containing the assistant configuration', () => {
    const { getByTestId } = render(<AssistantSettingsScreen />);
    expect(getByTestId('settings-assistant-screen')).toBeTruthy();
    expect(getByTestId('assistant-config')).toBeTruthy();
  });
});
