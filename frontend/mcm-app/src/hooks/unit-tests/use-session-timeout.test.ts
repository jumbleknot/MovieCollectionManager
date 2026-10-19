/**
 * Unit tests for use-session-timeout hook (T-040b)
 */

import { renderHook, act } from '@testing-library/react-native';
import { useSessionTimeout } from '@/hooks/use-session-timeout';

// Use fake timers for all tests
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('useSessionTimeout', () => {
  it('calls onTimeout after idle timeout', async () => {
    const onTimeout = jest.fn();
    await renderHook(() =>
      useSessionTimeout({
        onTimeout,
        idleTimeoutMs: 5000,
        absoluteTimeoutMs: 86400000,
        enabled: true,
      }),
    );

    await act(() => {
      jest.advanceTimersByTime(5001);
    });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('calls onTimeout after absolute timeout', async () => {
    const onTimeout = jest.fn();
    await renderHook(() =>
      useSessionTimeout({
        onTimeout,
        idleTimeoutMs: 86400000,    // Long idle - won't trigger first
        absoluteTimeoutMs: 10000,   // Short absolute
        enabled: true,
      }),
    );

    await act(() => {
      jest.advanceTimersByTime(10001);
    });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not call onTimeout when disabled', async () => {
    const onTimeout = jest.fn();
    await renderHook(() =>
      useSessionTimeout({
        onTimeout,
        idleTimeoutMs: 5000,
        absoluteTimeoutMs: 10000,
        enabled: false,
      }),
    );

    await act(() => {
      jest.advanceTimersByTime(20000);
    });

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('cleans up timers on unmount', async () => {
    const onTimeout = jest.fn();
    const { unmount } = await renderHook(() =>
      useSessionTimeout({
        onTimeout,
        idleTimeoutMs: 5000,
        absoluteTimeoutMs: 86400000,
        enabled: true,
      }),
    );

    await unmount();

    await act(() => {
      jest.advanceTimersByTime(10000);
    });

    expect(onTimeout).not.toHaveBeenCalled();
  });
});
