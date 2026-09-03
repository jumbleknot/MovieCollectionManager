/**
 * RenderMovieCard unit tests (T040).
 *
 * The curator emits a `render_movie_card` AG-UI tool call whose args are the contract props
 * (generative-ui-and-actions.md). CopilotKit's `useRenderTool` maps those args to this
 * presentational component, rendered inline in the assistant dock. These tests pin the
 * presentational contract deterministically (no agent/gateway); the live tool-call → render
 * round-trip is covered by the web E2E (T037).
 */
import { fireEvent, render } from '@/test-support/render';
import { Platform } from 'react-native';
import * as copilot from '@copilotkit/react-native';

import { RenderMovieCard } from '@/components/agent/render-movie-card';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@copilotkit/react-native', () => ({
  useAgent: jest.fn(),
  useCopilotKit: jest.fn(),
  useRenderTool: jest.fn(),
}));

const addMessage = jest.fn();
const runAgent = jest.fn();

// ⚠️ STABLE DOUBLES — see use-assistant.test.tsx. The card's actions now go through
// `useAssistantRun`, whose flush effect is keyed on the agent object's identity plus its mutable
// `isRunning`; a fresh object per render would repair the queued-send bug for free (feature 053).
const agentState = { isRunning: false, addMessage };
const copilotkitState = { runAgent, getAgent: () => agentState };

beforeEach(() => {
  mockPush.mockClear();
  addMessage.mockClear();
  runAgent.mockClear();
  agentState.isRunning = false;
  (copilot.useAgent as unknown as jest.Mock).mockReturnValue({ agent: agentState });
  (copilot.useCopilotKit as unknown as jest.Mock).mockReturnValue({ copilotkit: copilotkitState });
});

const FULL_PROPS = {
  movieId: null,
  collectionId: null,
  title: 'Blade Runner',
  year: 1982,
  posterUrl: 'https://image.tmdb.org/t/p/w185/poster.jpg',
  genres: ['Science Fiction', 'Thriller'],
  overview: 'A blade runner must pursue and terminate four replicants.',
  source: 'tmdb' as const,
  proposalItemId: 'item-1',
};

describe('RenderMovieCard', () => {
  it('renders the title and year', () => {
    const { getByTestId, getByText } = render(<RenderMovieCard {...FULL_PROPS} />);
    expect(getByTestId('render-movie-card')).toBeTruthy();
    expect(getByText('Blade Runner')).toBeTruthy();
    expect(getByTestId('render-movie-card-year')).toHaveTextContent('1982');
  });

  it('renders the genres joined and the overview', () => {
    const { getByTestId } = render(<RenderMovieCard {...FULL_PROPS} />);
    expect(getByTestId('render-movie-card-genres')).toHaveTextContent(
      'Science Fiction, Thriller',
    );
    expect(getByTestId('render-movie-card-overview')).toHaveTextContent(
      'A blade runner must pursue and terminate four replicants.',
    );
  });

  it('renders the poster image with the posterUrl as its source uri', () => {
    const { getByTestId } = render(<RenderMovieCard {...FULL_PROPS} />);
    const poster = getByTestId('render-movie-card-poster');
    expect(poster.props.source).toEqual({ uri: FULL_PROPS.posterUrl });
  });

  it('omits the poster image when posterUrl is null', () => {
    const { queryByTestId } = render(<RenderMovieCard {...FULL_PROPS} posterUrl={null} />);
    expect(queryByTestId('render-movie-card-poster')).toBeNull();
  });

  it('omits the year cell when year is null (no "null" leaks to the UI)', () => {
    const { queryByTestId, queryByText } = render(
      <RenderMovieCard {...FULL_PROPS} year={null} />,
    );
    expect(queryByTestId('render-movie-card-year')).toBeNull();
    expect(queryByText('null')).toBeNull();
  });

  it('shows the source provenance badge', () => {
    const { getByTestId } = render(<RenderMovieCard {...FULL_PROPS} />);
    expect(getByTestId('render-movie-card-source')).toHaveTextContent('TMDB');
  });

  // ─── 013 US3: clickable in-collection card ─────────────────────────────────
  it('navigates to the movie detail when both ids are present (US3-AC1)', () => {
    const { getByTestId } = render(
      <RenderMovieCard {...FULL_PROPS} movieId="mov-1" collectionId="col-1" source="mc-service" />,
    );
    fireEvent.press(getByTestId('render-movie-card'));
    expect(mockPush).toHaveBeenCalledWith('/collections/col-1/movies/mov-1');
  });

  it('is non-interactive when the ids are absent (look-up-only) (US3-AC2)', () => {
    const { getByTestId } = render(<RenderMovieCard {...FULL_PROPS} />);
    fireEvent.press(getByTestId('render-movie-card'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  // ─── 013 US10: web preview card — clickable TMDB url + add affordance ───────
  it('renders a tappable TMDB url link that opens the source (US10-AC1)', () => {
    const originalOS = Platform.OS;
    (Platform as { OS: string }).OS = 'web';
    const openSpy = jest.fn();
    (globalThis as unknown as { window: { open: jest.Mock } }).window = { open: openSpy };
    const { getByTestId } = render(
      <RenderMovieCard
        {...FULL_PROPS}
        url="https://www.themoviedb.org/movie/78"
        addable
      />,
    );
    const link = getByTestId('render-movie-card-url');
    expect(link).toHaveTextContent('View on TMDB');
    fireEvent.press(link);
    expect(openSpy).toHaveBeenCalledWith(
      'https://www.themoviedb.org/movie/78',
      '_blank',
      'noopener,noreferrer',
    );
    (Platform as { OS: string }).OS = originalOS;
  });

  it('omits the url link and add button on a plain card (US10-AC1 negative)', () => {
    const { queryByTestId } = render(<RenderMovieCard {...FULL_PROPS} />);
    expect(queryByTestId('render-movie-card-url')).toBeNull();
    expect(queryByTestId('render-movie-card-add')).toBeNull();
  });

  it('posts an add message into the approval-gated flow when "Add to collection" is tapped (US10)', () => {
    const { getByTestId } = render(
      <RenderMovieCard {...FULL_PROPS} url="https://www.themoviedb.org/movie/78" addable />,
    );
    fireEvent.press(getByTestId('render-movie-card-add'));
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'add Blade Runner (1982)' }),
    );
    expect(runAgent).toHaveBeenCalled();
  });

  // ─── 013 Inc5 Bug 1: web-card add targets the searched collection, not the default ──────────
  it('targets the searched collection when addCollectionName is present (Inc5 Bug 1)', () => {
    const { getByTestId } = render(
      <RenderMovieCard
        {...FULL_PROPS}
        url="https://www.themoviedb.org/movie/78"
        addable
        addCollectionId="c2"
        addCollectionName="Wish List"
      />,
    );
    fireEvent.press(getByTestId('render-movie-card-add'));
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'add Blade Runner (1982) to Wish List' }),
    );
  });

  // ─── 047 US5: cancel on the terminal web search card ───────────────────────────────────────

  it('renders no cancel action unless the card is cancelable (FR-032)', () => {
    const { queryByTestId } = render(
      <RenderMovieCard {...FULL_PROPS} url="https://www.themoviedb.org/movie/78" addable />,
    );
    expect(queryByTestId('render-movie-card-cancel')).toBeNull();
  });

  it('renders a cancel action beside Add when cancelable (US5-AC2)', () => {
    const { getByTestId } = render(
      <RenderMovieCard {...FULL_PROPS} url="https://www.themoviedb.org/movie/78" addable cancelable />,
    );
    expect(getByTestId('render-movie-card-add')).toBeTruthy();
    expect(getByTestId('render-movie-card-cancel')).toBeTruthy();
  });

  it('posts the canonical exit value through the same send path as Add (US5-AC2)', () => {
    const { getByTestId } = render(
      <RenderMovieCard {...FULL_PROPS} url="https://www.themoviedb.org/movie/78" addable cancelable />,
    );
    fireEvent.press(getByTestId('render-movie-card-cancel'));
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'exit search' }),
    );
    expect(runAgent).toHaveBeenCalled();
  });

  it('adds nothing when cancelled — no add message is ever posted (US5-AC3)', () => {
    const { getByTestId } = render(
      <RenderMovieCard {...FULL_PROPS} url="https://www.themoviedb.org/movie/78" addable cancelable />,
    );
    fireEvent.press(getByTestId('render-movie-card-cancel'));
    const posted = addMessage.mock.calls.map((c) => String(c[0].content));
    expect(posted).toEqual(['exit search']);
    expect(posted.some((m) => m.startsWith('add '))).toBe(false);
  });

  it('disables both actions after cancelling, so the card no longer invites an add (FR-033)', () => {
    const { getByTestId } = render(
      <RenderMovieCard {...FULL_PROPS} url="https://www.themoviedb.org/movie/78" addable cancelable />,
    );
    fireEvent.press(getByTestId('render-movie-card-cancel'));

    expect(getByTestId('render-movie-card-cancel').props.accessibilityState.disabled).toBe(true);
    expect(getByTestId('render-movie-card-add').props.accessibilityState.disabled).toBe(true);

    // A follow-up tap on either action posts nothing further.
    fireEvent.press(getByTestId('render-movie-card-add'));
    fireEvent.press(getByTestId('render-movie-card-cancel'));
    expect(addMessage).toHaveBeenCalledTimes(1);
  });

  it('disables both actions after adding too, so a card cannot be actioned twice', () => {
    const { getByTestId } = render(
      <RenderMovieCard {...FULL_PROPS} url="https://www.themoviedb.org/movie/78" addable cancelable />,
    );
    fireEvent.press(getByTestId('render-movie-card-add'));
    fireEvent.press(getByTestId('render-movie-card-cancel'));
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(String(addMessage.mock.calls[0][0].content)).toContain('add Blade Runner');
  });

  // Item #337 / 064 US1 — the third component that held its own agent handle and returned on
  // `isRunning`, dropping the action silently.
  it('delivers a card action taken mid-answer, once the run finishes', () => {
    agentState.isRunning = true;
    const props = { ...FULL_PROPS, url: 'https://www.themoviedb.org/movie/78', addable: true };
    const { getByTestId, rerender } = render(<RenderMovieCard {...props} />);

    fireEvent.press(getByTestId('render-movie-card-add'));
    expect(addMessage).not.toHaveBeenCalled(); // queued, not sent

    agentState.isRunning = false;
    rerender(<RenderMovieCard {...props} />);

    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(String(addMessage.mock.calls[0][0].content)).toContain('add Blade Runner');
  });

  // FR-004. The `actioned` latch must close at ENQUEUE, not at send: with a queue between the tap
  // and the request, a latch that waited for delivery would leave a window in which a second tap
  // enqueues a second action — turning one card into two writes.
  it('latches at enqueue, so a second tap during the queued window adds nothing', () => {
    agentState.isRunning = true;
    const props = {
      ...FULL_PROPS, url: 'https://www.themoviedb.org/movie/78', addable: true, cancelable: true,
    };
    const { getByTestId, rerender } = render(<RenderMovieCard {...props} />);

    fireEvent.press(getByTestId('render-movie-card-add'));
    fireEvent.press(getByTestId('render-movie-card-add'));
    fireEvent.press(getByTestId('render-movie-card-cancel'));

    agentState.isRunning = false;
    rerender(<RenderMovieCard {...props} />);

    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(String(addMessage.mock.calls[0][0].content)).toContain('add Blade Runner');
  });

  it('keeps the card itself in the transcript after cancelling (it is a record, not a mistake)', () => {
    const { getByTestId } = render(
      <RenderMovieCard {...FULL_PROPS} url="https://www.themoviedb.org/movie/78" addable cancelable />,
    );
    fireEvent.press(getByTestId('render-movie-card-cancel'));
    expect(getByTestId('render-movie-card')).toBeTruthy();
    expect(getByTestId('render-movie-card-title')).toHaveTextContent('Blade Runner');
  });
});
