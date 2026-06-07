/**
 * AssistantDock generative-UI rendering (T040).
 *
 * The curator emits a `render_movie_card` AG-UI tool call; the dock must map it to the
 * RenderMovieCard component via the CopilotKit render-tool registry and show it inline in the
 * message list. Only the agent data source (useAgent/useCopilotKit) is mocked — the render
 * registry, the `useRenderTool` registration, and the dock's tool-call mapping are real code
 * under test. The live tool-call round-trip against the gateway is covered by the web E2E (T037).
 */
import { fireEvent, render } from '@testing-library/react-native';
import * as copilot from '@copilotkit/react-native';

import { AssistantDock } from '@/components/agent/assistant-dock';
import { AssistantProvider } from '@/hooks/use-assistant';

jest.mock('@copilotkit/react-native', () => {
  const actual = jest.requireActual('@copilotkit/react-native');
  return { ...actual, useAgent: jest.fn(), useCopilotKit: jest.fn() };
});

const mockedUseAgent = copilot.useAgent as unknown as jest.Mock;
const mockedUseCopilotKit = copilot.useCopilotKit as unknown as jest.Mock;

const CARD_ARGS = {
  movieId: null,
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
});
