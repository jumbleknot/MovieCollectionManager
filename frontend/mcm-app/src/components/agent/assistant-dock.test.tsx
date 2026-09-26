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
import { render, fireEvent, waitFor } from '@/test-support/render';
import React from 'react';
import { Text } from 'react-native';

import { AssistantDock } from '@/components/agent/assistant-dock';
import * as loader from '@/utils/assistant-runtime-loader';

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

const PanelStub = () => <Text testID="assistant-dock-panel">panel</Text>;

describe('AssistantDock', () => {
  let load: jest.SpyInstance;

  beforeEach(() => {
    mockPrefetch.mockClear();
    loader.resetAssistantRuntimeForTest();
    load = jest.spyOn(loader, 'loadAssistantRuntime').mockResolvedValue({ default: PanelStub } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows the dock toggle without any CopilotKit provider around it', () => {
    // Deliberately NOT wrapped in AssistantProvider: the provider moved into the deferred chunk
    // (feature 077). A dock that still needed it would put @copilotkit/react-native — and the 659 KB
    // of React Native polyfills its entry imports as a side effect — back in the entry chunk.
    const { getByTestId } = render(<AssistantDock />);
    expect(getByTestId('assistant-dock-toggle')).toBeTruthy();
  });

  it('schedules the idle prefetch — the deferral must not cost the user a wait', () => {
    // If this stops happening, the feature still "works" and every other test here still passes;
    // the first press just pays for 2.4 MB on the spot.
    render(<AssistantDock />);
    expect(mockPrefetch).toHaveBeenCalled();
  });

  it('does not render the panel before it is opened', () => {
    const { queryByTestId } = render(<AssistantDock />);
    expect(queryByTestId('assistant-dock-panel')).toBeNull();
    expect(queryByTestId('assistant-dock-panel-loading')).toBeNull();
  });

  it('shows a loading state while the panel chunk is in flight, then the panel', async () => {
    let release: (m: unknown) => void = () => {};
    load.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const { getByTestId, queryByTestId } = render(<AssistantDock />);
    fireEvent.press(getByTestId('assistant-dock-toggle'));

    // In flight: a loading state, not a blank panel.
    expect(getByTestId('assistant-dock-panel-loading')).toBeTruthy();
    expect(queryByTestId('assistant-dock-panel')).toBeNull();

    release({ default: PanelStub });
    await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());
    expect(queryByTestId('assistant-dock-panel-loading')).toBeNull();
  });

  it('loads the runtime only once across open/close/open', async () => {
    const { getByTestId } = render(<AssistantDock />);
    const toggle = getByTestId('assistant-dock-toggle');

    fireEvent.press(toggle);
    await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());
    fireEvent.press(toggle); // close
    fireEvent.press(toggle); // open again
    await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not fire a second load when pressed repeatedly while in flight', async () => {
    let release: (m: unknown) => void = () => {};
    load.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const { getByTestId } = render(<AssistantDock />);
    const toggle = getByTestId('assistant-dock-toggle');
    fireEvent.press(toggle);
    fireEvent.press(toggle);
    fireEvent.press(toggle);

    release({ default: PanelStub });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  describe('when the chunk fails to load (FR-006)', () => {
    it('shows a recoverable error rather than a blank panel', async () => {
      load.mockRejectedValue(new Error('chunk load failed'));

      const { getByTestId, queryByTestId } = render(<AssistantDock />);
      fireEvent.press(getByTestId('assistant-dock-toggle'));

      await waitFor(() => expect(getByTestId('assistant-dock-panel-error')).toBeTruthy());
      expect(queryByTestId('assistant-dock-panel')).toBeNull();
      // The toggle must stay usable — the dock has to be closable after a failure.
      expect(getByTestId('assistant-dock-toggle')).toBeTruthy();
    });

    it('retries on demand and succeeds', async () => {
      load.mockRejectedValueOnce(new Error('chunk load failed'));
      load.mockResolvedValue({ default: PanelStub } as never);

      const { getByTestId } = render(<AssistantDock />);
      fireEvent.press(getByTestId('assistant-dock-toggle'));
      await waitFor(() => expect(getByTestId('assistant-dock-panel-error')).toBeTruthy());

      fireEvent.press(getByTestId('assistant-dock-panel-retry'));
      await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('closing and reopening after a failure also retries', async () => {
      load.mockRejectedValueOnce(new Error('chunk load failed'));
      load.mockResolvedValue({ default: PanelStub } as never);

      const { getByTestId } = render(<AssistantDock />);
      const toggle = getByTestId('assistant-dock-toggle');
      fireEvent.press(toggle);
      await waitFor(() => expect(getByTestId('assistant-dock-panel-error')).toBeTruthy());

      fireEvent.press(toggle); // close
      fireEvent.press(toggle); // open again
      await waitFor(() => expect(getByTestId('assistant-dock-panel')).toBeTruthy());
    });
  });
});
