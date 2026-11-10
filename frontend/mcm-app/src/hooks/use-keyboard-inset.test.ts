/**
 * useKeyboardInset (098 T014, research R1): the on-screen keyboard's height, so the assistant dock can
 * sit above it. Android uses the `Did` events (no `Will` events there); iOS uses `Will` so the dock moves
 * with the keyboard rather than after it. Web has no IME inset → always 0, nothing registered.
 */
import { Keyboard, Platform } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

import { useKeyboardInset } from '@/hooks/use-keyboard-inset';

type Handler = (e: { endCoordinates: { height: number } }) => void;
let handlers: Record<string, Handler>;
let removes: jest.Mock[];

beforeEach(() => {
  jest.clearAllMocks();
  handlers = {};
  removes = [];
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: Handler) => {
    handlers[event] = cb;
    const remove = jest.fn();
    removes.push(remove);
    return { remove };
  }) as unknown as typeof Keyboard.addListener);
});

afterEach(() => jest.restoreAllMocks());

const kb = (height: number) => ({ endCoordinates: { height } });

describe('useKeyboardInset', () => {
  it('Android: keyboardDidShow gives its height, keyboardDidHide gives 0', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const { result } = await renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
    expect(Object.keys(handlers).sort()).toEqual(['keyboardDidHide', 'keyboardDidShow']);

    await act(async () => handlers['keyboardDidShow']!(kb(300)));
    expect(result.current).toBe(300);
    await act(async () => handlers['keyboardDidHide']!(kb(0)));
    expect(result.current).toBe(0);
  });

  it('iOS: keyboardWillShow gives its height, keyboardWillHide gives 0', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const { result } = await renderHook(() => useKeyboardInset());
    expect(Object.keys(handlers).sort()).toEqual(['keyboardWillHide', 'keyboardWillShow']);

    await act(async () => handlers['keyboardWillShow']!(kb(300)));
    expect(result.current).toBe(300);
    await act(async () => handlers['keyboardWillHide']!(kb(0)));
    expect(result.current).toBe(0);
  });

  it('web: always 0 and registers no listeners', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const { result } = await renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
    expect(Keyboard.addListener).not.toHaveBeenCalled();
  });

  it('unmounting removes both listeners', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const { unmount } = await renderHook(() => useKeyboardInset());
    expect(removes).toHaveLength(2);
    await unmount();
    for (const r of removes) expect(r).toHaveBeenCalledTimes(1);
  });
});
