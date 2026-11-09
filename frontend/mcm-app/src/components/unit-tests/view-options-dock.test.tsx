/**
 * ViewOptionsDock + ViewOptionsPanel (098 T007, contracts/ui-contract.md).
 *
 * The collection screen's column, sort and filter controls live behind a compact docked bar
 * (`view-options-toggle`) that drops a panel (`view-options-panel`) down over the list. The bar is in
 * normal layout flow; the panel is mounted by the screen inside the list container and renders only
 * while open. Open/closed state comes from the shared OpenPanel context, so opening the assistant
 * re-docks the view options (FR-015).
 */
import React, { useEffect as mockUseEffect } from 'react';
import { BackHandler, Platform, Text } from 'react-native';
import { render, fireEvent, act } from '@/test-support/render';

import { ViewOptionsDock, ViewOptionsPanel } from '@/components/view-options-dock';
import { OpenPanelProvider, useOpenPanel } from '@/hooks/use-open-panel';
import { moveFocus } from '@/utils/move-focus';

jest.mock('expo-router', () => ({
  // Fires on mount, and its cleanup on unmount — i.e. "focus" and "blur" of the screen.
  useFocusEffect: (cb: () => void | (() => void)) => mockUseEffect(() => cb(), [cb]),
}));

jest.mock('@/utils/move-focus', () => ({ moveFocus: jest.fn() }));
const mockMoveFocus = moveFocus as jest.Mock;

type BackCb = () => boolean;
let backHandlers: BackCb[] = [];
const mockRemove = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, cb) => {
    backHandlers.push(cb as BackCb);
    return { remove: mockRemove };
  });
});

afterEach(() => jest.restoreAllMocks());

// Exposes the context so a test can open the assistant, as the assistant dock would.
const ctxRef: { current: ReturnType<typeof useOpenPanel> | null } = { current: null };
function CtxProbe(): null {
  ctxRef.current = useOpenPanel();
  return null;
}

function Harness({
  count = 0,
  screenMounted = true,
}: {
  count?: number;
  screenMounted?: boolean;
}): React.JSX.Element {
  // The provider lives in the (app) layout and outlives the screen; `screenMounted=false` models
  // leaving the collection screen while the layout (and the context) stays.
  return (
    <OpenPanelProvider>
      <CtxProbe />
      {screenMounted ? (
        <>
          <ViewOptionsDock activeFilterCount={count} />
          <ViewOptionsPanel>
            <Text testID="panel-child">controls</Text>
          </ViewOptionsPanel>
        </>
      ) : null}
    </OpenPanelProvider>
  );
}

async function openPanel(utils: Awaited<ReturnType<typeof render>>): Promise<void> {
  await fireEvent.press(utils.getByTestId('view-options-toggle'));
}

describe('ViewOptionsDock', () => {
  it('renders the docked bar with the panel closed at first (US1-AC1, FR-004)', async () => {
    const utils = await render(<Harness />);
    const toggle = utils.getByTestId('view-options-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.props.accessibilityRole).toBe('button');
    expect(toggle.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    expect(utils.queryByTestId('view-options-panel')).toBeNull();
    expect(utils.queryByTestId('panel-child')).toBeNull();
  });

  it('pressing the bar shows the panel and its children and sets expanded (US1-AC2)', async () => {
    const utils = await render(<Harness />);
    await openPanel(utils);
    expect(utils.getByTestId('view-options-panel')).toBeTruthy();
    expect(utils.getByTestId('panel-child')).toBeTruthy();
    expect(utils.getByTestId('view-options-toggle').props.accessibilityState).toEqual(
      expect.objectContaining({ expanded: true }),
    );
  });

  it('the close button re-docks it (US1-AC4)', async () => {
    const utils = await render(<Harness />);
    await openPanel(utils);
    await fireEvent.press(utils.getByTestId('view-options-close'));
    expect(utils.queryByTestId('view-options-panel')).toBeNull();
  });

  it('pressing the bar again re-docks it (US1-AC4)', async () => {
    const utils = await render(<Harness />);
    await openPanel(utils);
    await openPanel(utils);
    expect(utils.queryByTestId('view-options-panel')).toBeNull();
  });

  it('Android Back closes it, returns true, and only listens while open (FR-007)', async () => {
    const utils = await render(<Harness />);
    expect(backHandlers).toHaveLength(0);
    await openPanel(utils);
    expect(backHandlers).toHaveLength(1);
    let handled = false;
    await act(async () => {
      handled = backHandlers[0]();
    });
    expect(handled).toBe(true);
    expect(utils.queryByTestId('view-options-panel')).toBeNull();
    expect(mockRemove).toHaveBeenCalled();
  });

  it('Escape closes it on web (FR-007)', async () => {
    const listeners: Record<string, (e: { key: string }) => void> = {};
    const fakeDoc = {
      addEventListener: jest.fn((t: string, cb: (e: { key: string }) => void) => {
        listeners[t] = cb;
      }),
      removeEventListener: jest.fn(),
    };
    const g = globalThis as { document?: unknown };
    const prevDoc = g.document;
    g.document = fakeDoc;
    jest.replaceProperty(Platform, 'OS', 'web');
    try {
      const utils = await render(<Harness />);
      await openPanel(utils);
      expect(backHandlers).toHaveLength(0); // no BackHandler on web
      await act(async () => listeners['keydown']?.({ key: 'Enter' }));
      expect(utils.getByTestId('view-options-panel')).toBeTruthy();
      await act(async () => listeners['keydown']?.({ key: 'Escape' }));
      expect(utils.queryByTestId('view-options-panel')).toBeNull();
      expect(fakeDoc.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    } finally {
      g.document = prevDoc;
    }
  });

  it('shows the active-filter count in a badge and in the label (US1-AC5, FR-008, FR-016)', async () => {
    const utils = await render(<Harness count={2} />);
    expect(utils.getByTestId('view-options-active-count')).toHaveTextContent('2');
    expect(utils.getByTestId('view-options-toggle').props.accessibilityLabel).toBe(
      'View options, 2 filters active',
    );
  });

  it('shows no badge and the plain label when no filter is active', async () => {
    const utils = await render(<Harness count={0} />);
    expect(utils.queryByTestId('view-options-active-count')).toBeNull();
    expect(utils.getByTestId('view-options-toggle').props.accessibilityLabel).toBe('View options');
  });

  it('uses the singular for one active filter', async () => {
    const utils = await render(<Harness count={1} />);
    expect(utils.getByTestId('view-options-toggle').props.accessibilityLabel).toBe(
      'View options, 1 filter active',
    );
  });

  it('opening the assistant re-docks the view options (FR-015)', async () => {
    const utils = await render(<Harness />);
    await openPanel(utils);
    await act(async () => ctxRef.current?.open('assistant'));
    expect(utils.queryByTestId('view-options-panel')).toBeNull();
  });

  it('the bar meets the 44pt touch target (FR-016)', async () => {
    const utils = await render(<Harness />);
    const style = [utils.getByTestId('view-options-toggle').props.style].flat(Infinity);
    const minHeight = Math.max(
      ...style.map((s: { minHeight?: number } | undefined) => s?.minHeight ?? 0),
    );
    expect(minHeight).toBeGreaterThanOrEqual(44);
  });

  describe('focus (FR-016)', () => {
    // Targets are compared as LABELS: a failing matcher on a raw ref would pretty-print the host
    // instance's whole fiber graph and exhaust the worker's memory.
    // The bar is mounted once, so its ref is stable; the panel remounts on every open, so its
    // heading ref is a new object each time. "bar" = the bar's ref; anything else is the panel.
    function targets(): string[] {
      const calls = mockMoveFocus.mock.calls.map((c) => c[0]);
      const bar = calls[1];
      return calls.map((c) => (c === bar ? 'bar' : 'panel'));
    }

    it('moves into the panel on open and back to the bar on every close path', async () => {
      const utils = await render(<Harness />);
      expect(mockMoveFocus).not.toHaveBeenCalled(); // no focus theft on first render

      await openPanel(utils); // open
      await fireEvent.press(utils.getByTestId('view-options-close')); // close button
      await openPanel(utils); // open
      await openPanel(utils); // toggle closes
      await openPanel(utils); // open
      await act(async () => {
        backHandlers[backHandlers.length - 1]();
      }); // Back

      expect(targets()).toEqual(['panel', 'bar', 'panel', 'bar', 'panel', 'bar']);
    });

    it('does not pull focus back to the bar when the assistant takes over', async () => {
      const utils = await render(<Harness />);
      await openPanel(utils);
      mockMoveFocus.mockClear();
      await act(async () => ctxRef.current?.open('assistant'));
      expect(mockMoveFocus).not.toHaveBeenCalled();
    });
  });

  it('re-docks when the screen loses focus, so the next visit starts docked (FR-004)', async () => {
    const utils = await render(<Harness />);
    await openPanel(utils);
    expect(ctxRef.current?.openPanel).toBe('view-options');
    await utils.rerender(<Harness screenMounted={false} />);
    expect(ctxRef.current?.openPanel).toBe(null);
  });
});
