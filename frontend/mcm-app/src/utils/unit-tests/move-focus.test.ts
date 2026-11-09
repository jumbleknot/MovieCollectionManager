/**
 * moveFocus (098 T007, FR-016, research R5): move keyboard / screen-reader focus to an element.
 * Web → the DOM node's `focus()`; native → `AccessibilityInfo.sendAccessibilityEvent(node, 'focus')`.
 * A null ref (not mounted yet) is a safe no-op on both.
 */
import { AccessibilityInfo, Platform } from 'react-native';

import { moveFocus } from '@/utils/move-focus';

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

describe('moveFocus', () => {
  it('calls focus() on the element on web', () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const focus = jest.fn();
    moveFocus({ current: { focus } });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('sends an accessibility focus event to the host view on native', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const spy = jest
      .spyOn(AccessibilityInfo, 'sendAccessibilityEvent')
      .mockImplementation(() => {});
    const node = { id: 'host' };
    moveFocus({ current: node });
    expect(spy).toHaveBeenCalledWith(node, 'focus');
  });

  it('is a no-op for an unmounted ref', () => {
    const spy = jest
      .spyOn(AccessibilityInfo, 'sendAccessibilityEvent')
      .mockImplementation(() => {});
    expect(() => moveFocus({ current: null })).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
