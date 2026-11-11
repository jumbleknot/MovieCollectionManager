/**
 * Move keyboard / screen-reader focus to an element (098 FR-016, research R5).
 *
 * Web: the element is a DOM node, so `focus()` it. Native: there is no programmatic keyboard focus
 * for a plain view, so move the SCREEN-READER focus with a `focus` accessibility event on the host view.
 * A ref that is not mounted is a no-op on both, so a caller can fire this from an effect safely.
 */
import { AccessibilityInfo, Platform } from 'react-native';
import type { RefObject } from 'react';

export function moveFocus(ref: RefObject<unknown>): void {
  const el = ref.current as { focus?: () => void } | null;
  if (!el) return;
  if (Platform.OS === 'web') {
    el.focus?.();
    return;
  }
  AccessibilityInfo.sendAccessibilityEvent(
    el as Parameters<typeof AccessibilityInfo.sendAccessibilityEvent>[0],
    'focus',
  );
}
