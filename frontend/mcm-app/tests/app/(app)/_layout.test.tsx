/**
 * Regression guard — AssistantConfigProvider's position in the (app) layout (feature 062, T010).
 *
 * FR-019. The provider must wrap BOTH the Stack (which now renders the assistant config form
 * two levels down, under settings/) AND the dock gate. That shared state is what makes saving
 * the form refresh the dock's availability in the same session, with no reload and no re-login.
 *
 * This guard has no RED/GREEN pair, deliberately: the behaviour already holds, so a paired
 * implementation task would be fiction. It is written to make a FUTURE relocation fail —
 * research.md §R7 records that moving the provider into settings/_layout.tsx would put the form
 * inside it and the dock outside it, a regression invisible to every other test in the suite.
 *
 * Both probes call the real `useAssistantConfig`, which THROWS outside a provider. The Stack is
 * mocked to render the first probe (in a jest tree the router supplies no children), and the
 * dock is mocked to render the second — behind the real, unmocked runnable gate.
 */

import React from 'react';
import { render, waitFor } from '@/test-support/render';
import { ThemeProvider } from '@/hooks/use-theme';
import type { AgentConfigView } from '@/types/agent-config';

// A runnable config, so the REAL AuthedAssistant gate opens and the dock probe mounts.
// `mock`-prefixed so jest's module-factory hoisting allows the reference below.
const mockRunnableConfig: AgentConfigView = {
  enabled: true,
  provider: 'anthropic',
  ollamaBaseUrl: null,
  hasAnthropicKey: true,
  hasTmdbKey: true,
  costLimitUsd: null,
  escalationAvailable: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// The app bar's theme toggle reads AsyncStorage; without its jest mock the native module
// is missing and the whole layout fails to import.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/bff-server/api-client', () => ({
  apiClient: {
    get: jest.fn(async () => ({ data: mockRunnableConfig })),
    put: jest.fn(),
    post: jest.fn(),
  },
}));

/**
 * Resolves the assistant-config context, or throws if it is not an ancestor. Built inside a
 * factory-safe helper because jest hoists module factories above every file-scope binding.
 */
function mockConfigProbe(testID: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ReactLocal = require('react');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Text: TextLocal } = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useAssistantConfig: useConfig } = require('@/hooks/use-assistant-config');
  const { runnable } = useConfig();
  return ReactLocal.createElement(TextLocal, { testID }, String(runnable));
}

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), navigate: jest.fn() }),
  usePathname: () => '/(app)/settings',
  Link: ({ children }: { children: React.ReactNode }) => children,
  // The router supplies no children in a jest tree, so stand a probe at the Stack's position.
  Stack: () => mockConfigProbe('probe-under-stack'),
}));

jest.mock('@/components/agent/assistant-dock', () => ({
  AssistantDock: () => mockConfigProbe('probe-under-dock'),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      username: 'someone',
      email: 'someone@test.invalid',
      firstName: 'Some',
      lastName: 'One',
      roles: ['mc-user'],
      emailVerified: true,
      accountStatus: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    isAuthenticated: true,
    isLoading: false,
    logout: jest.fn(),
    logoutWithTimeout: jest.fn(),
    refreshAuth: jest.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AppLayout = require('@/app/(app)/_layout').default;

describe('(app) layout — AssistantConfigProvider placement', () => {
  it('resolves the assistant config from a descendant of the Stack AND of the dock gate', async () => {
    // ThemeProvider is supplied by the ROOT layout above (app); this test mounts (app) alone.
    const { getByTestId } = render(
      <ThemeProvider>
        <AppLayout />
      </ThemeProvider>,
    );

    // Inside the Stack — where settings/assistant renders the config form.
    await waitFor(() => expect(getByTestId('probe-under-stack')).toBeTruthy());
    // Inside the dock gate — where availability is decided.
    await waitFor(() => expect(getByTestId('probe-under-dock')).toBeTruthy());

    // Same provider, therefore the same state: this is what makes a save in the form
    // refresh the dock in-session. Two providers would give two independent fetches.
    expect(getByTestId('probe-under-stack').props.children).toBe('true');
    expect(getByTestId('probe-under-dock').props.children).toBe('true');
  });
});
