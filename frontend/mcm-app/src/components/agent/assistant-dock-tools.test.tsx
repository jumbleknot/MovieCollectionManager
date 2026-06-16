/**
 * AssistantDock generative-UI rendering (T040).
 *
 * The curator emits a `render_movie_card` AG-UI tool call; the dock must map it to the
 * RenderMovieCard component via the CopilotKit render-tool registry and show it inline in the
 * message list. Only the agent data source (useAgent/useCopilotKit) is mocked — the render
 * registry, the `useRenderTool` registration, and the dock's tool-call mapping are real code
 * under test. The live tool-call round-trip against the gateway is covered by the web E2E (T037).
 */
import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render } from '@/test-support/render';
import * as copilot from '@copilotkit/react-native';

import { AssistantDock, buildDockItems } from '@/components/agent/assistant-dock';
import { AssistantProvider } from '@/hooks/use-assistant';

jest.mock('@copilotkit/react-native', () => {
  const actual = jest.requireActual('@copilotkit/react-native');
  return { ...actual, useAgent: jest.fn(), useCopilotKit: jest.fn() };
});

const mockedUseAgent = copilot.useAgent as unknown as jest.Mock;
const mockedUseCopilotKit = copilot.useCopilotKit as unknown as jest.Mock;

const CARD_ARGS = {
  movieId: null,
  collectionId: null,
  title: 'Blade Runner',
  year: 1982,
  posterUrl: null,
  genres: ['Science Fiction'],
  overview: 'A blade runner must pursue and terminate four replicants.',
  source: 'tmdb',
  proposalItemId: 'item-1',
};

function mockAgentWithToolCall() {
  mockedUseAgent.mockReturnValue({
    agent: {
      isRunning: false,
      addMessage: jest.fn(),
      // useApprovalInterrupt (useInterrupt) subscribes to agent events.
      subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          toolCalls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'render_movie_card', arguments: JSON.stringify(CARD_ARGS) },
            },
          ],
        },
      ],
    },
  });
  mockedUseCopilotKit.mockReturnValue({ copilotkit: { runAgent: jest.fn() } });
}

describe('AssistantDock generative UI', () => {
  it('renders a movie card inline when the agent emits a render_movie_card tool call', () => {
    mockAgentWithToolCall();
    const { getByTestId } = render(
      <AssistantProvider>
        <AssistantDock />
      </AssistantProvider>,
    );
    fireEvent.press(getByTestId('assistant-dock-toggle')); // open the panel

    expect(getByTestId('render-movie-card')).toBeTruthy();
    expect(getByTestId('render-movie-card-title')).toHaveTextContent('Blade Runner');
  });

  // 014 UX fix: the dock must NOT show always-on import/export buttons — those surfaced before the
  // user asked for anything. Import is started by typing; export by typing. (The old
  // spreadsheet-import-button / spreadsheet-export-button are removed.)
  it('shows no always-on import/export buttons when the panel opens', () => {
    mockAgentWithToolCall();
    const { getByTestId, queryByTestId } = render(
      <AssistantProvider>
        <AssistantDock />
      </AssistantProvider>,
    );
    fireEvent.press(getByTestId('assistant-dock-toggle'));
    expect(queryByTestId('spreadsheet-import-button')).toBeNull();
    expect(queryByTestId('spreadsheet-export-button')).toBeNull();
  });

  // Regression (T056 mobile): after an approve→resume continuation the agent message list can
  // contain the SAME render_movie_card tool-call id twice. buildDockItems must still produce
  // UNIQUE item ids (FlatList keys) — a duplicate key throws a React error that, on Android,
  // raises a LogBox RedBox overlaying the dock and hiding the post-approval "Done".
  it('produces unique item keys when a tool-call id repeats across messages', () => {
    const registry = new Map([
      ['render_movie_card', () => <Text>card</Text>],
    ]) as unknown as Parameters<typeof buildDockItems>[1];
    const tc = {
      id: 'rmc-tmdb:220289',
      type: 'function',
      function: { name: 'render_movie_card', arguments: '{}' },
    };
    const messages = [
      { id: 'a1', role: 'assistant', content: 'preview', toolCalls: [tc] },
      { id: 'a1', role: 'assistant', content: 'preview', toolCalls: [tc] }, // duplicate after resume
    ];
    const ids = buildDockItems(messages, registry).map((it) => it.id);
    expect(ids.length).toBe(4); // 2 text + 2 tool
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });
});
