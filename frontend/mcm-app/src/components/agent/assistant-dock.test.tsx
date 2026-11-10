/**
 * Assistant dock — the deferral boundary (T029, extended by feature 077 T010).
 *
 * The dock is now TWO things in one file's worth of responsibility: an always-mounted toggle that
 * lives in the entry chunk, and a panel that lives in a separate chunk fetched on demand. These
 * tests pin the seam, because the seam is the feature:
 *
 *   - the toggle renders with NO assistant runtime loaded, and needs no CopilotKit provider —
 *     if it needed one, the provider would be in the entry chunk and nothing would be deferred;
 *   - opening loads the panel, showing a loading state in between;
 *   - a FAILED load is recoverable. This is the case a `React.lazy` implementation cannot pass:
 *     measured, `lazy` calls its factory exactly once and caches the rejection on the lazy object
 *     for the life of the page, so a retry can never re-attempt. Hence the explicit state machine.
 *
 * The live AG-UI round-trip is covered by the web E2E (Playwright) against a running gateway + BFF.
 */
import { render, fireEvent, waitFor, act } from '@/test-support/render';
import React, { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AssistantDock, assistantPanelHeight } from '@/components/agent/assistant-dock';
import { OpenPanelProvider, useOpenPanel } from '@/hooks/use-open-panel';
import * as loader from '@/utils/assistant-runtime-loader';

// 098 US2: the dock lifts above the on-screen keyboard. The inset comes from useKeyboardInset
// (unit-tested on its own); here it is a value the test sets.
let mockInset = 0;
jest.mock('@/hooks/use-keyboard-inset', () => ({ useKeyboardInset: () => mockInset }));
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);

// A 360×640 phone with a 24 pt status bar (FR-013 / US2-AC4).
const METRICS = {
  frame: { x: 0, y: 0, width: 360, height: 640 },
  insets: { top: 24, left: 0, right: 0, bottom: 0 },
};

// Exposes the shared OpenPanel context, as the view-options bar would use it (FR-015).
const ctxRef: { current: ReturnType<typeof useOpenPanel> | null } = { current: null };
function CtxProbe(): null {
  const ctx = useOpenPanel();
  // Written in an effect, not during render (react-hooks/immutability).
  useEffect(() => {
    ctxRef.current = ctx;
  });
  return null;
}

function Dock(): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <OpenPanelProvider>
        <CtxProbe />
        <AssistantDock />
      </OpenPanelProvider>
    </SafeAreaProvider>
  );
}

// The idle prefetch is stubbed out for this suite, and that is a deliberate isolation rather than a
// convenience. The dock composes two things that both call `loadAssistantRuntime`: the user's press,
// and the prefetch hook. With the loader spied on, the prefetch's call is indistinguishable from the
// press's — it inflates call counts and consumes `mockRejectedValueOnce`, so "opened once" reads as
// two loads and the error path never arrives. Real dedupe lives INSIDE the loader (proved in
// `assistant-runtime-loader.test.ts`) and the scheduling contract in `use-assistant-runtime.test.tsx`.
// What is left here is exactly the dock's own behaviour. The composition — that the dock does call
// the prefetch at all — is asserted below.
// `mock`-prefixed because jest hoists the factory above this declaration and only permits
// out-of-scope names matching /^mock/i.
const mockPrefetch = jest.fn();
jest.mock('@/hooks/use-assistant-runtime', () => ({
  useAssistantRuntimePrefetch: () => mockPrefetch(),
}));

// Records the layout props the dock passes to the deferred panel (098 FR-011..FR-013).
const lastPanelProps: { current: { height?: number; keyboardInset?: number } } = { current: {} };
const PanelStub = (props: { height?: number; keyboardInset?: number }) => {
  useEffect(() => {
    lastPanelProps.current = props;
  });
  return <Text testID="assistant-dock-panel">panel</Text>;
};

describe('AssistantDock', () => {
  let load: jest.SpyInstance;

  beforeEach(() => {
    mockPrefetch.mockClear();
    mockInset = 0;
    lastPanelProps.current = {};
    loader.resetAssistantRuntimeForTest();
    load = jest
      .spyOn(loader, 'loadAssistantRuntime')
      .mockResolvedValue({ default: PanelStub } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows the dock toggle without any CopilotKit provider around it', async () => {
    // Deliberately NOT wrapped in AssistantProvider: the provider moved into the deferred chunk
    // (feature 077). A dock that still needed it would put @copilotkit/react-native — and the 659 KB
    // of React Native polyfills its entry imports as a side effect — back in the entry chunk.
    const { getByTestId } = await render(<Dock />);
    expect(getByTestId('assistant-dock-toggle')).toBeTruthy();
  });

  it('schedules the idle prefetch — the deferral must not cost the user a wait', async () => {
    // If this stops happening, the feature still "works" and every other test here still passes;
    // the first press just pays for 2.4 MB on the spot.
    await render(<Dock />);
    expect(mockPrefetch).toHaveBeenCalled();
  });

  it('does not render the panel before it is opened', async () => {
    const { queryByTestId } = await render(<Dock />);
    expect(queryByTestId('assistant-dock-panel')).toBeNull();
    expect(queryByTestId('assistant-dock-panel-loading')).toBeNull();
  });

  it('shows a loading state while the panel chunk is in flight, then the panel', async () => {
    let release: (m: unknown) => void = () => {};
    load.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const { getByTestId, queryByTestId } = await render(<Dock />);
    await fireEvent.press(getByTestId('assistant-dock-toggle'));

    // In flight: a loading state, not a blank panel.
    expect(getByTestId('assistant-dock-panel-loading')).toBeTruthy();
    expect(queryByTestId('assistant-dock-panel')).toBeNull();

    release({ default: PanelStub });
    await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());
    expect(queryByTestId('assistant-dock-panel-loading')).toBeNull();
  });

  it('loads the runtime only once across open/close/open', async () => {
    const { getByTestId } = await render(<Dock />);
    const toggle = getByTestId('assistant-dock-toggle');

    await fireEvent.press(toggle);
    await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());
    await fireEvent.press(toggle); // close
    await fireEvent.press(toggle); // open again
    await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not fire a second load when pressed repeatedly while in flight', async () => {
    let release: (m: unknown) => void = () => {};
    load.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const { getByTestId } = await render(<Dock />);
    const toggle = getByTestId('assistant-dock-toggle');
    await fireEvent.press(toggle);
    await fireEvent.press(toggle);
    await fireEvent.press(toggle);

    release({ default: PanelStub });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  describe('when the chunk fails to load (FR-006)', () => {
    it('shows a recoverable error rather than a blank panel', async () => {
      load.mockRejectedValue(new Error('chunk load failed'));

      const { getByTestId, queryByTestId } = await render(<Dock />);
      await fireEvent.press(getByTestId('assistant-dock-toggle'));

      await waitFor(() => expect(getByTestId('assistant-dock-panel-error')).toBeTruthy());
      expect(queryByTestId('assistant-dock-panel')).toBeNull();
      // The toggle must stay usable — the dock has to be closable after a failure.
      expect(getByTestId('assistant-dock-toggle')).toBeTruthy();
    });

    it('retries on demand and succeeds', async () => {
      load.mockRejectedValueOnce(new Error('chunk load failed'));
      load.mockResolvedValue({ default: PanelStub } as never);

      const { getByTestId } = await render(<Dock />);
      await fireEvent.press(getByTestId('assistant-dock-toggle'));
      await waitFor(() => expect(getByTestId('assistant-dock-panel-error')).toBeTruthy());

      await fireEvent.press(getByTestId('assistant-dock-panel-retry'));
      await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('closing and reopening after a failure also retries', async () => {
      load.mockRejectedValueOnce(new Error('chunk load failed'));
      load.mockResolvedValue({ default: PanelStub } as never);

      const { getByTestId } = await render(<Dock />);
      const toggle = getByTestId('assistant-dock-toggle');
      await fireEvent.press(toggle);
      await waitFor(() => expect(getByTestId('assistant-dock-panel-error')).toBeTruthy());

      await fireEvent.press(toggle); // close
      await fireEvent.press(toggle); // open again
      await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());
    });
  });

  describe('above the on-screen keyboard (098 US2)', () => {
    const dockStyle = (u: Awaited<ReturnType<typeof render>>) =>
      StyleSheet.flatten(u.getByTestId('assistant-dock').props.style);

    it('lifts the dock by the keyboard height (FR-011)', async () => {
      mockInset = 300;
      const u = await render(<Dock />);
      expect(dockStyle(u).bottom).toBe(316);
    });

    it('caps the panel so it never runs above the top inset on a 640-high window (FR-013, US2-AC4)', async () => {
      mockInset = 300;
      const u = await render(<Dock />);
      await fireEvent.press(u.getByTestId('assistant-dock-toggle'));
      await waitFor(() => expect(u.getByTestId('assistant-dock-panel')).toBeTruthy());
      // 640 − 300 keyboard − 24 top inset − 16 dock margin − 44 toggle − 8 gap − 16 top margin = 232
      expect(lastPanelProps.current.height).toBe(232);
      expect(lastPanelProps.current.keyboardInset).toBe(300);
      // The panel's top edge stays below the top inset.
      const panelTop = 640 - 316 - 44 - 8 - lastPanelProps.current.height!;
      expect(panelTop).toBeGreaterThanOrEqual(24);
    });

    it('returns to bottom 16 and the full 420 height when the keyboard hides (FR-014, US2-AC3)', async () => {
      mockInset = 300;
      const u = await render(<Dock />);
      await fireEvent.press(u.getByTestId('assistant-dock-toggle'));
      await waitFor(() => expect(u.getByTestId('assistant-dock-panel')).toBeTruthy());
      mockInset = 0;
      await u.rerender(<Dock />);
      expect(dockStyle(u).bottom).toBe(16);
      expect(lastPanelProps.current.height).toBe(420);
      expect(lastPanelProps.current.keyboardInset).toBe(0);
    });

    it('assistantPanelHeight never goes negative on a tiny window', () => {
      expect(
        assistantPanelHeight({
          frameHeight: 300,
          keyboardInset: 280,
          topInset: 24,
          toggleHeight: 44,
        }),
      ).toBe(0);
    });
  });

  describe('one panel open at a time (098 FR-015)', () => {
    it('opening the dock sets the shared panel to the assistant', async () => {
      const u = await render(<Dock />);
      await fireEvent.press(u.getByTestId('assistant-dock-toggle'));
      expect(ctxRef.current?.openPanel).toBe('assistant');
    });

    it('opening the assistant closes the view options', async () => {
      const u = await render(<Dock />);
      await act(async () => ctxRef.current?.open('view-options'));
      await fireEvent.press(u.getByTestId('assistant-dock-toggle'));
      expect(ctxRef.current?.openPanel).toBe('assistant');
    });

    it('opening the view options closes the assistant panel', async () => {
      const u = await render(<Dock />);
      await fireEvent.press(u.getByTestId('assistant-dock-toggle'));
      await waitFor(() => expect(u.getByTestId('assistant-dock-panel')).toBeTruthy());
      await act(async () => ctxRef.current?.open('view-options'));
      expect(u.queryByTestId('assistant-dock-panel')).toBeNull();
    });
  });

  describe('toggle accessibility (098 FR-016)', () => {
    it('reports expanded state and meets the 44 pt target', async () => {
      const u = await render(<Dock />);
      const toggle = () => u.getByTestId('assistant-dock-toggle');
      expect(toggle().props.accessibilityState).toEqual(
        expect.objectContaining({ expanded: false }),
      );
      expect(StyleSheet.flatten(toggle().props.style).minHeight).toBeGreaterThanOrEqual(44);
      await fireEvent.press(toggle());
      expect(toggle().props.accessibilityState).toEqual(
        expect.objectContaining({ expanded: true }),
      );
    });
  });
});
