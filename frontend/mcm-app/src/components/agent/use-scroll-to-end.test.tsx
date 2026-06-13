/**
 * useScrollToEndOnChange (013 Inc5 enhancement 1).
 *
 * After a card (movie card / selection / collection summary) renders in the dock, the chat must
 * auto-scroll to the bottom. The FlatList's onContentSizeChange doesn't reliably fire once a
 * card's async content (poster image) lays out, so this hook nudges scrollToEnd a tick after the
 * item revision changes (a new message/card appended).
 */
import { renderHook, act } from '@testing-library/react-native';

import { useScrollToEndOnChange } from '@/components/agent/assistant-dock';

describe('useScrollToEndOnChange', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('scrolls to end (deferred) on mount and again when the revision changes', () => {
    const scroll = jest.fn();
    const { rerender } = renderHook(({ rev }: { rev: number }) => useScrollToEndOnChange(rev, scroll), {
      initialProps: { rev: 1 },
    });
    act(() => jest.advanceTimersByTime(200));
    expect(scroll).toHaveBeenCalledTimes(1);

    // A new card/message item appended → revision changes → scroll again.
    rerender({ rev: 2 });
    act(() => jest.advanceTimersByTime(200));
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it('does not re-scroll when the revision is unchanged (a plain re-render)', () => {
    const scroll = jest.fn();
    const { rerender } = renderHook(({ rev }: { rev: number }) => useScrollToEndOnChange(rev, scroll), {
      initialProps: { rev: 5 },
    });
    act(() => jest.advanceTimersByTime(200));
    rerender({ rev: 5 });
    act(() => jest.advanceTimersByTime(200));
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});
