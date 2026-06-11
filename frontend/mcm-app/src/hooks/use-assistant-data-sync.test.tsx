/**
 * Unit tests for the assistant data-sync (T072).
 *
 * `useAssistantDataRefresh` must re-run its refetch ONLY when an assistant write bumps the shared
 * revision — never on the initial mount (the screen does its own first load), and never for a
 * read/query turn (which never bumps). This is the mechanism that refreshes an on-screen list
 * after the assistant adds/organizes while the screen stays focused.
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';

import {
  AssistantDataSyncProvider,
  useAssistantDataRefresh,
  useBumpAssistantData,
} from '@/hooks/use-assistant-data-sync';

function wrapper({ children }: { children: React.ReactNode }) {
  return <AssistantDataSyncProvider>{children}</AssistantDataSyncProvider>;
}

describe('useAssistantDataRefresh (T072)', () => {
  it('does NOT call refetch on the initial mount', () => {
    const refetch = jest.fn();
    renderHook(() => useAssistantDataRefresh(refetch), { wrapper });
    expect(refetch).not.toHaveBeenCalled();
  });

  it('calls refetch once each time an assistant write bumps the revision', () => {
    const refetch = jest.fn();
    const { result } = renderHook(
      () => {
        const bump = useBumpAssistantData();
        useAssistantDataRefresh(refetch);
        return bump;
      },
      { wrapper },
    );

    expect(refetch).not.toHaveBeenCalled(); // mount

    act(() => result.current()); // an approved write completed
    expect(refetch).toHaveBeenCalledTimes(1);

    act(() => result.current()); // a second batch / write completed
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('uses the LATEST refetch closure (no stale capture) without re-bumping', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender, result } = renderHook(
      ({ cb }: { cb: () => void }) => {
        const bump = useBumpAssistantData();
        useAssistantDataRefresh(cb);
        return bump;
      },
      { wrapper, initialProps: { cb: first } },
    );

    rerender({ cb: second }); // a re-render must NOT trigger a refetch on its own
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    act(() => result.current());
    expect(first).not.toHaveBeenCalled(); // the stale closure is not used
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a turn that never bumps (a read/query) triggers no refetch', () => {
    const refetch = jest.fn();
    const { rerender } = renderHook(() => useAssistantDataRefresh(refetch), { wrapper });
    rerender({});
    rerender({});
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe('useBumpAssistantData default (no provider)', () => {
  it('is a safe no-op outside the provider', () => {
    const { result } = renderHook(() => useBumpAssistantData());
    expect(() => result.current()).not.toThrow();
  });
});
