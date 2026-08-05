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
import { fireEvent, render, screen } from '@/test-support/render';
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

function mockAgentWithToolCall(
  fn: { name: string; arguments: string } = {
    name: 'render_movie_card',
    arguments: JSON.stringify(CARD_ARGS),
  },
) {
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
              function: fn,
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

  // 047 US4 (T082): the ownership toggle lists must be registered in the dock, or the organizer's
  // render_multi_select tool call arrives with nothing to render it and the member sees only the
  // question text with no way to answer by tapping.
  it('renders a multi-select inline when the agent emits a render_multi_select tool call', () => {
    mockAgentWithToolCall({
      name: 'render_multi_select',
      arguments: JSON.stringify({
        prompt: 'Which formats do you own it on?',
        options: [
          { label: 'DVD', value: 'DVD', selected: false },
          { label: 'Blu-Ray', value: 'Blu-Ray', selected: false },
        ],
        confirmLabel: 'Done',
      }),
    });
    const { getByTestId } = render(
      <AssistantProvider>
        <AssistantDock />
      </AssistantProvider>,
    );
    fireEvent.press(getByTestId('assistant-dock-toggle'));

    expect(getByTestId('multi-select-options')).toBeTruthy();
    expect(getByTestId('multi-select-option-0')).toBeTruthy();
    expect(getByTestId('multi-select-option-1')).toBeTruthy();
    expect(getByTestId('multi-select-confirm')).toBeTruthy();
  });
});

describe('AssistantDock import progress (047 US3 / FR-014a)', () => {
  function mockAgentWithState(state: Record<string, unknown>) {
    mockedUseAgent.mockReturnValue({
      agent: {
        isRunning: true,
        addMessage: jest.fn(),
        subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
        messages: [],
        state,
      },
    });
    mockedUseCopilotKit.mockReturnValue({ copilotkit: { runAgent: jest.fn() } });
  }

  it('SUBSCRIBES to agent state, not just messages', () => {
    // The dock has to ask for state updates explicitly — without OnStateChanged it re-renders on
    // messages only, `agent.state` goes stale, and the progress line sits at its first value
    // while the import runs. That failure is invisible in a screenshot, so it is pinned here.
    mockAgentWithState({});
    render(
      <AssistantProvider>
        <AssistantDock />
      </AssistantProvider>,
    );
    fireEvent.press(screen.getByTestId('assistant-dock-toggle'));

    const requested = mockedUseAgent.mock.calls.map(([args]) => args?.updates ?? []).flat();
    expect(requested).toContain('OnStateChanged');
  });

  it('renders the in-place progress line from agent state while an import applies', () => {
    mockAgentWithState({ import_applied: 1300, import_total: 2300, import_run_id: 't-1' });
    render(
      <AssistantProvider>
        <AssistantDock />
      </AssistantProvider>,
    );
    fireEvent.press(screen.getByTestId('assistant-dock-toggle'));

    expect(screen.getByTestId('import-progress-label')).toHaveTextContent(
      'Importing 1,300 of 2,300…',
    );
  });

  it('shows no progress surface once the run has finished (FR-014b)', () => {
    // The gateway clears the counters at the end of the run, so the report is what remains.
    mockAgentWithState({ import_applied: 0, import_total: 0, import_run_id: '' });
    render(
      <AssistantProvider>
        <AssistantDock />
      </AssistantProvider>,
    );
    fireEvent.press(screen.getByTestId('assistant-dock-toggle'));

    expect(screen.queryByTestId('import-progress')).toBeNull();
  });
});
