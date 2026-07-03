/**
 * UI-action client dispatch (T059, US3).
 *
 * The agent's navigate / prefill tool call renders a UiActionEffect that MUST authorize at the
 * BFF before navigating: a 204 → perform the navigation; a 403 (or network error) → discard it
 * and show a refusal, never navigate. This is the client half of the FR-011/FR-012 guarantee
 * that the agent can't drive the UI somewhere the user couldn't go. The live round-trip is
 * covered by the web E2E (T0xx).
 */
import React from 'react';
import { waitFor } from '@testing-library/react-native';
// UiActionEffect/DownloadExportEffect now call useTheme() for their status-line colour, so they
// must render inside a TamaguiProvider — use the test-support render that wraps it.
import { render } from '@/test-support/render';

import {
  UiActionEffect,
  uiActionKey,
  NAVIGATE_TO_COLLECTION_TOOL,
  NAVIGATE_TO_MOVIE_TOOL,
  PREFILL_ADD_MOVIE_TOOL,
} from '@/components/agent/ui-action-tools';

describe('uiActionKey (per-emission dedup key)', () => {
  // 013 Inc5 nav bug: keying only on the target swallowed a SECOND genuine navigation to a
  // collection already visited this session. Including the agent's per-emission `nonce` makes a
  // new turn a new key (re-navigates) while a dock re-mount of the same message stays deduped.
  it('keys a collection navigation by collectionId + nonce', () => {
    expect(uiActionKey(NAVIGATE_TO_COLLECTION_TOOL, { collectionId: 'c1', nonce: '5' })).toBe(
      'navcol:c1:5',
    );
  });

  it('gives two navigations to the SAME collection in different turns DIFFERENT keys', () => {
    const turnA = uiActionKey(NAVIGATE_TO_COLLECTION_TOOL, { collectionId: 'c1', nonce: '5' });
    const turnB = uiActionKey(NAVIGATE_TO_COLLECTION_TOOL, { collectionId: 'c1', nonce: '9' });
    expect(turnA).not.toBe(turnB);
  });

  it('gives the SAME message (same nonce) the SAME key (dock re-mount stays deduped)', () => {
    const first = uiActionKey(NAVIGATE_TO_MOVIE_TOOL, { collectionId: 'c1', movieId: 'm1', nonce: '7' });
    const remount = uiActionKey(NAVIGATE_TO_MOVIE_TOOL, { collectionId: 'c1', movieId: 'm1', nonce: '7' });
    expect(first).toBe(remount);
    expect(first).toBe('navmov:c1:m1:7');
  });

  it('keys a prefill by collection + nonce', () => {
    expect(uiActionKey(PREFILL_ADD_MOVIE_TOOL, { collectionId: 'c1', nonce: '3' })).toBe(
      'prefill:c1:3',
    );
  });
});

describe('UiActionEffect', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  function mockAuthorize(status: number): jest.Mock {
    const fetchMock = jest.fn().mockResolvedValue({ status });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('navigates only after the BFF authorizes (204)', async () => {
    const fetchMock = mockAuthorize(204);
    const perform = jest.fn();
    const { getByTestId } = render(
      <UiActionEffect
        actionKey="navcol:authorized-1"
        type="navigate"
        target="collection"
        label="Opening that collection…"
        perform={perform}
      />,
    );

    await waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
    // The authorize call carries only the structural target — no ids/values/PII.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ type: 'navigate', target: 'collection' });
    expect(getByTestId('assistant-ui-action-navigate')).toHaveTextContent('Opening that collection…');
  });

  it('does NOT navigate when the BFF denies (403) and shows a refusal', async () => {
    mockAuthorize(403);
    const perform = jest.fn();
    const { getByTestId } = render(
      <UiActionEffect
        actionKey="navcol:denied-1"
        type="navigate"
        target="collection"
        label="Opening that collection…"
        perform={perform}
      />,
    );

    await waitFor(() =>
      expect(getByTestId('assistant-ui-action-navigate')).toHaveTextContent("I can't open that for you."),
    );
    expect(perform).not.toHaveBeenCalled();
  });

  it('does NOT navigate on a persistent network error (discard after retries)', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('offline'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const perform = jest.fn();
    const { getByTestId } = render(
      <UiActionEffect
        actionKey="prefill:neterr-1"
        type="prefill"
        target="add-movie"
        label="Opening the add-movie form…"
        perform={perform}
      />,
    );

    // Transient failures are retried; a PERSISTENT one is exhausted then discarded (default-deny).
    await waitFor(() =>
      expect(getByTestId('assistant-ui-action-prefill')).toHaveTextContent("I can't open that for you."),
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // retried, not single-shot
    expect(perform).not.toHaveBeenCalled();
  });

  it('retries a transient delivery failure and navigates once it succeeds', async () => {
    // The BFF authorizes (logs allowed=true) but the 204 response stream is intermittently cut on
    // the emulator's adb-reverse tunnel ("Cannot pipe to a closed or destroyed stream") — the
    // client fetch sees a transient error/5xx. A single-shot authorize discarded the navigate
    // ("I can't open that for you.") even though the action WAS authorized — feature 023 mobile flake.
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('stream cut')) // 1st: response not delivered
      .mockResolvedValueOnce({ status: 503 }) // 2nd: transient upstream blip
      .mockResolvedValue({ status: 204 }); // 3rd: succeeds
    global.fetch = fetchMock as unknown as typeof fetch;
    const perform = jest.fn();
    render(
      <UiActionEffect
        actionKey="navmov:retry-1"
        type="navigate"
        target="movie-detail"
        label="Opening that movie…"
        perform={perform}
      />,
    );

    await waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a genuine authorization denial (403 is not transient)', async () => {
    const fetchMock = mockAuthorize(403);
    const perform = jest.fn();
    const { getByTestId } = render(
      <UiActionEffect
        actionKey="navmov:deny-noretry-1"
        type="navigate"
        target="movie-detail"
        label="Opening that movie…"
        perform={perform}
      />,
    );

    await waitFor(() =>
      expect(getByTestId('assistant-ui-action-navigate')).toHaveTextContent("I can't open that for you."),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // a real deny is final — no retries
    expect(perform).not.toHaveBeenCalled();
  });

  it('dispatches a given action key at most once (re-mount does not re-navigate)', async () => {
    mockAuthorize(204);
    const perform = jest.fn();
    const props = {
      actionKey: 'navcol:once-1',
      type: 'navigate' as const,
      target: 'collection',
      label: 'Opening…',
      perform,
    };
    const first = render(<UiActionEffect {...props} />);
    await waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<UiActionEffect {...props} />); // dock re-opened → same key
    await waitFor(() => expect(perform).toHaveBeenCalledTimes(1)); // still once
  });
});
