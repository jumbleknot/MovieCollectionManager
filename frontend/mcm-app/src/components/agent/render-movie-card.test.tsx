/**
 * RenderMovieCard unit tests (T040).
 *
 * The curator emits a `render_movie_card` AG-UI tool call whose args are the contract props
 * (generative-ui-and-actions.md). CopilotKit's `useRenderTool` maps those args to this
 * presentational component, rendered inline in the assistant dock. These tests pin the
 * presentational contract deterministically (no agent/gateway); the live tool-call → render
 * round-trip is covered by the web E2E (T037).
 */
import { fireEvent, render } from '@testing-library/react-native';

import { RenderMovieCard } from '@/components/agent/render-movie-card';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

beforeEach(() => mockPush.mockClear());

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
});
