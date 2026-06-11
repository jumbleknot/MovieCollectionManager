/**
 * Readable UI-state provider (T057, US3 / R15).
 *
 * Screens report a structural snapshot on focus; the provider pushes it to the BFF
 * `/bff-api/agent/ui-state` route (sanitized + cached there) so "add <movie> to this"
 * resolves the on-screen target. These tests assert the push on focus, the flush of the
 * latest snapshot before a turn, and that a failed push is swallowed (best-effort context).
 */
import React, { useEffect as mockUseEffect } from 'react';
import { Text } from 'react-native';
import { render, waitFor, act } from '@testing-library/react-native';

import { UiStateProvider, useReportUiState, useUiStateFlush } from '@/hooks/use-ui-state';

// useFocusEffect behaves like useEffect in tests (fires the effect on mount).
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
}));

// The provider pushes the snapshot with a plain credentialed fetch (NOT the axios apiClient,
// to avoid racing the agent run's token refresh — US3/R15).
const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
beforeAll(() => {
  (globalThis as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;
});
beforeEach(() => mockFetch.mockClear());

function ReportingScreen({ snapshot }: { snapshot: Record<string, unknown> }): React.JSX.Element {
  useReportUiState(snapshot as never);
  return <Text>screen</Text>;
}

const flushRef: { current: () => Promise<void> } = { current: async () => {} };

function FlushButton(): React.JSX.Element {
  const flush = useUiStateFlush();
  React.useEffect(() => {
    flushRef.current = flush; // expose flush so the test can invoke it
  }, [flush]);
  return <Text>flush</Text>;
}

function lastPushedSnapshot(): unknown {
  const call = mockFetch.mock.calls.at(-1)!;
  const url = String(call[0]);
  expect(url.endsWith('/bff-api/agent/ui-state')).toBe(true);
  const init = call[1] as { method: string; credentials: string; body: string };
  expect(init.method).toBe('POST');
  expect(init.credentials).toBe('include'); // cookie-auth, but NO refresh-interceptor path
  return JSON.parse(init.body);
}

describe('UiStateProvider', () => {
  it('pushes the screen snapshot to the BFF ui-state route on focus', async () => {
    const snapshot = { current_screen: 'collection', collection_id: 'abc', nav_depth: 1 };
    render(
      <UiStateProvider>
        <ReportingScreen snapshot={snapshot} />
      </UiStateProvider>,
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(lastPushedSnapshot()).toEqual(snapshot);
  });

  it('flush re-pushes the latest reported snapshot (no push/run race before a turn)', async () => {
    const snapshot = { current_screen: 'movie-detail', collection_id: 'c1', movie_id: 'm1' };
    render(
      <UiStateProvider>
        <ReportingScreen snapshot={snapshot} />
        <FlushButton />
      </UiStateProvider>,
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1)); // the focus push
    await act(async () => {
      await flushRef.current();
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(lastPushedSnapshot()).toEqual(snapshot);
  });

  it('swallows a failed push (best-effort context — never throws)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const snapshot = { current_screen: 'home', nav_depth: 0 };
    expect(() =>
      render(
        <UiStateProvider>
          <ReportingScreen snapshot={snapshot} />
        </UiStateProvider>,
      ),
    ).not.toThrow();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  });
});
