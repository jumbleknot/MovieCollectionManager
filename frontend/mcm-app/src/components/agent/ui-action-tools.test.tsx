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
import { render, waitFor } from '@testing-library/react-native';

import { UiActionEffect } from '@/components/agent/ui-action-tools';

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

  it('does NOT navigate on a network error (discard, never navigate unconfirmed)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const perform = jest.fn();
    render(
      <UiActionEffect
        actionKey="prefill:neterr-1"
        type="prefill"
        target="add-movie"
        label="Opening the add-movie form…"
        perform={perform}
      />,
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
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
