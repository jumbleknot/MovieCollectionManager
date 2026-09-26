// The idle prefetch for the assistant runtime (feature 077, T008 — FR-004).
//
// THE ONE PROPERTY THAT MATTERS, and the reason this file exists: the fetch must NOT start
// synchronously with the render. Starting it eagerly puts ~2.4 MB back in parallel with the route's
// own bytes, which on a serialized slow link makes the route SLOWER than before the split while every
// byte-total assertion still looks improved. That is the exact mistake feature 077's research
// recorded, so it gets a test rather than a comment.
import React from 'react';
import { render, renderHook, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { useAssistantRuntimePrefetch } from '@/hooks/use-assistant-runtime';
import * as loader from '@/utils/assistant-runtime-loader';

type IdleCb = (deadline?: unknown) => void;

// A holder object rather than a reassigned `let`: TS narrows `let cb: IdleCb | null = null` to
// `null` (it cannot see the assignment inside the callback below), and the lint rule against
// reassigning variables declared outside a component applies to the capture case further down.
type Holder<T> = { current: T | null };
const holder = <T,>(): Holder<T> => ({ current: null });

function Probe(): React.JSX.Element {
  useAssistantRuntimePrefetch();
  return <Text>probe</Text>;
}

describe('useAssistantRuntimePrefetch', () => {
  let load: jest.SpyInstance;

  beforeEach(() => {
    load = jest.spyOn(loader, 'loadAssistantRuntime').mockResolvedValue({
      default: () => null,
    } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    jest.useRealTimers();
  });

  it('does NOT load synchronously during render', () => {
    const scheduled = holder<IdleCb>();
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: IdleCb) => {
      scheduled.current = cb;
      return 1;
    };
    (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback = () => {};

    render(<Probe />);

    // The work is scheduled, and nothing has been fetched yet.
    expect(scheduled.current).not.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('loads once the browser reports idle', async () => {
    const scheduled = holder<IdleCb>();
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: IdleCb) => {
      scheduled.current = cb;
      return 1;
    };
    (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback = () => {};

    render(<Probe />);
    scheduled.current?.();

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it('falls back to a timer where requestIdleCallback is absent', async () => {
    // Absent on native and in older Safari. The hook's contract must not depend on it.
    jest.useFakeTimers();
    expect((globalThis as { requestIdleCallback?: unknown }).requestIdleCallback).toBeUndefined();

    render(<Probe />);
    expect(load).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('cancels on unmount and never loads', () => {
    const cancelled = holder<number>();
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = () => 42;
    (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback = (id: number) => {
      cancelled.current = id;
    };

    const { unmount } = render(<Probe />);
    unmount();

    expect(cancelled.current).toBe(42);
    expect(load).not.toHaveBeenCalled();
  });

  it('cancels the timer fallback on unmount too', () => {
    jest.useFakeTimers();
    const { unmount } = render(<Probe />);
    unmount();
    jest.runOnlyPendingTimers();
    expect(load).not.toHaveBeenCalled();
  });

  it('swallows a prefetch rejection — a warm-up failure must not surface to the user', async () => {
    // The user has not asked for anything yet. An unhandled rejection here would become a console
    // error, or worse an error boundary, for a purely speculative fetch. The retry path that DOES
    // matter is the one behind the toggle.
    load.mockRejectedValue(new Error('offline'));
    const scheduled = holder<IdleCb>();
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: IdleCb) => {
      scheduled.current = cb;
      return 1;
    };
    (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback = () => {};

    render(<Probe />);
    await expect(Promise.resolve(scheduled.current?.())).resolves.not.toThrow();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it('returns nothing — a hook never returns UI', () => {
    // Constitution, Hooks-Layer: "No UI: custom hooks never return any UI components."
    // `renderHook` rather than a component that captures the value: assigning to anything during
    // render is itself a React rule violation, and the lint rule that catches it is right.
    const { result } = renderHook(() => useAssistantRuntimePrefetch());
    expect(result.current).toBeUndefined();
  });
});
