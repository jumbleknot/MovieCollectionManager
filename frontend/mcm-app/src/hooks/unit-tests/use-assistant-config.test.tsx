/**
 * T116 (feature 018, FR-031 / SC-012) — in-session enable/disable reactivity.
 *
 * Regression test for the manual-test bug: the dock gate and the Profile form each held an
 * INDEPENDENT copy of the assistant config, so a save in the form did not refresh the gate
 * until the (app) layout remounted (full reload / re-login). The fix promotes the config to a
 * SINGLE shared context (AssistantConfigProvider). This test renders two independent consumers
 * under one provider and asserts that a save() driven by one consumer is observed by the OTHER
 * consumer (the gate) — proving shared state, with no remount.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { Text, Pressable } from 'react-native';

import { apiClient } from '@/bff-server/api-client';
import { AssistantConfigProvider, useAssistantConfig } from '@/hooks/use-assistant-config';
import type { AgentConfigView } from '@/types/agent-config';

jest.mock('@/bff-server/api-client', () => ({
  apiClient: { get: jest.fn(), put: jest.fn(), post: jest.fn() },
}));

const mockedGet = jest.mocked(apiClient.get);
const mockedPut = jest.mocked(apiClient.put);

const DISABLED_VIEW: AgentConfigView = {
  enabled: false,
  provider: 'ollama',
  ollamaBaseUrl: null,
  hasAnthropicKey: false,
  hasTmdbKey: false,
  costLimitUsd: null,
  escalationAvailable: false,
  updatedAt: null,
};

const RUNNABLE_VIEW: AgentConfigView = {
  enabled: true,
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  hasAnthropicKey: false,
  hasTmdbKey: true,
  costLimitUsd: null,
  escalationAvailable: false,
  updatedAt: '2026-06-19T00:00:00.000Z',
};

// Stands in for the dock gate ((app)/_layout.tsx AuthedAssistant): renders purely from `runnable`.
function Gate(): React.JSX.Element {
  const { runnable } = useAssistantConfig();
  return <Text testID="gate">{runnable ? 'dock-visible' : 'dock-hidden'}</Text>;
}

// Stands in for the Profile form (movie-assistant-config.tsx): a separate consumer that saves.
function Saver(): React.JSX.Element {
  const { save } = useAssistantConfig();
  return (
    <Pressable
      testID="saver"
      onPress={() => {
        void save({ enabled: true, ollamaBaseUrl: 'http://localhost:11434', tmdbKey: 'k' });
      }}
    >
      <Text>save</Text>
    </Pressable>
  );
}

describe('AssistantConfigProvider — in-session reactivity (FR-031)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a save in one consumer flips the gate in another consumer without a remount', async () => {
    // Initial mount fetch → disabled (no dock). The save's refresh re-fetches → runnable.
    mockedGet.mockResolvedValueOnce({ data: DISABLED_VIEW } as never);
    mockedPut.mockResolvedValueOnce({ data: {} } as never);
    mockedGet.mockResolvedValueOnce({ data: RUNNABLE_VIEW } as never);

    render(
      <AssistantConfigProvider>
        <Gate />
        <Saver />
      </AssistantConfigProvider>,
    );

    // Gate starts hidden (the unconfigured/disabled state).
    await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('dock-hidden'));

    // The OTHER consumer saves → the shared state refreshes → the gate must react in-session.
    fireEvent.press(screen.getByTestId('saver'));

    await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('dock-visible'));
  });
});
