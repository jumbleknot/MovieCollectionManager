/**
 * The on-screen keyboard's height in points, or 0 when it is hidden (098 US2, research R1).
 *
 * WHY: on SDK 58 / RN 0.88 Android runs edge-to-edge, so the window is NOT resized for the IME and a
 * view pinned to the window's bottom edge — the assistant dock — sits behind the keyboard. The dock adds
 * this inset to its `bottom` offset instead. No native dependency (no prebuild change); see R1 for the
 * rejected alternatives (KeyboardAvoidingView, react-native-keyboard-controller, adjustResize).
 *
 * Android only emits the `Did` events; iOS emits `Will` events, which let the dock move WITH the
 * keyboard. Web has no IME inset, so it is always 0 and nothing is registered.
 */
import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) =>
      setInset(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setInset(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return inset;
}
