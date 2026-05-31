/**
 * Unit tests for MovieDetailScreen (T103 + T148)
 *
 * Tests cover:
 * - Renders MovieDetail when movie is loaded
 * - Shows loading indicator while movie is loading (getMovie in flight)
 * - Pressing Edit on MovieDetail switches to MovieForm (edit mode)
 * - Submitting MovieForm calls updateMovie and returns to detail view
 * - Delete button on MovieDetail opens DeleteConfirmationDialog (T148)
 * - Confirming delete calls deleteMovie + navigates back (T148)
 * - Cancelling delete closes dialog without deleting (T148)
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { MovieDetailScreen } from '@/screens/movies/movie-detail-screen';
import type { Movie } from '@/types/collection';

// ─── Re-import after mocks ─────────────────────────────────────────────────────

import { useMovies } from '@/hooks/use-movies';

// ─── Mock dependencies ─────────────────────────────────────────────────────────

const mockGetMovie = jest.fn();
const mockUpdateMovie = jest.fn();
const mockDeleteMovie = jest.fn();

jest.mock('@/hooks/use-movies', () => ({
  // Default mock — makeMoviesMock fills in list/filter/column fields after import
  useMovies: jest.fn(),
}));

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
  useLocalSearchParams: () => ({ collectionId: 'col-1', movieId: 'mov-1' }),
}));

jest.mock('@/bff-server/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));
const mockUseMovies = jest.mocked(useMovies);

// ─── Mock factory ──────────────────────────────────────────────────────────────
// useMovies now returns a large interface (single-movie + list + filters + columns).
// Provide sensible defaults for fields the detail-screen tests don't care about.

function makeMoviesMock(
  overrides: Partial<ReturnType<typeof useMovies>> = {},
): ReturnType<typeof useMovies> {
  return {
    // Single-movie state
    movie: null,
    isLoading: false,
    error: null,
    getMovie: mockGetMovie,
    createMovie: jest.fn(),
    updateMovie: mockUpdateMovie,
    deleteMovie: mockDeleteMovie,
    // Movie list state
    movies: [],
    isLoadingList: false,
    listError: null,
    hasMore: false,
    listMovies: jest.fn().mockResolvedValue(undefined),
    loadMore: jest.fn().mockResolvedValue(undefined),
    // Search
    search: '',
    setSearch: jest.fn(),
    // Filters
    filters: {},
    setFilter: jest.fn().mockResolvedValue(undefined),
    clearFilters: jest.fn().mockResolvedValue(undefined),
    // Filter options
    filterOptions: null,
    isLoadingFilterOptions: false,
    fetchFilterOptions: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_MOVIE: Movie = {
  movieId: 'mov-1',
  collectionId: 'col-1',
  title: 'The Matrix',
  year: 1999,
  contentType: 'Movie',
  language: 'English',
  owned: false,
  ripped: false,
  childrens: false,
  ownedMedia: [],
  ripQuality: [],
  genres: [],
  rated: null,
  directors: [],
  actors: [],
  tags: [],
  movieSet: null,
  originalTitle: null,
  releaseDate: null,
  outline: null,
  plot: null,
  runtime: null,
  externalIds: [],
  createdAt: '2026-05-23T00:00:00.000Z',
  updatedAt: '2026-05-23T00:00:00.000Z',
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MovieDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMovie.mockResolvedValue(undefined);
    mockUpdateMovie.mockResolvedValue(undefined);
    mockDeleteMovie.mockResolvedValue(undefined);
    // Set the default mock return value for tests that don't override it
    mockUseMovies.mockReturnValue(makeMoviesMock());
  });

  describe('loading state', () => {
    it('shows loading indicator when isLoading is true', () => {
      mockUseMovies.mockReturnValueOnce(makeMoviesMock({ isLoading: true }));

      const { getByTestId } = render(<MovieDetailScreen />);
      expect(getByTestId('movie-detail-screen-loading')).toBeTruthy();
    });
  });

  describe('detail view', () => {
    it('renders MovieDetail when movie is loaded', () => {
      mockUseMovies.mockReturnValueOnce(makeMoviesMock({ movie: MOCK_MOVIE }));

      const { getByTestId } = render(<MovieDetailScreen />);
      expect(getByTestId('movie-detail-title')).toBeTruthy();
    });

    it('shows the movie title in detail view', () => {
      mockUseMovies.mockReturnValueOnce(makeMoviesMock({ movie: MOCK_MOVIE }));

      const { getByTestId } = render(<MovieDetailScreen />);
      expect(getByTestId('movie-detail-title').props.children).toBe('The Matrix');
    });
  });

  describe('edit flow', () => {
    it('switches to MovieForm when Edit is pressed', () => {
      mockUseMovies.mockReturnValue(makeMoviesMock({ movie: MOCK_MOVIE }));

      const { getByTestId } = render(<MovieDetailScreen />);
      fireEvent.press(getByTestId('movie-detail-edit-button'));
      expect(getByTestId('movie-form-title-input')).toBeTruthy();
    });

    it('calls updateMovie on MovieForm submit', async () => {
      mockUseMovies.mockReturnValue(makeMoviesMock({ movie: MOCK_MOVIE }));

      const { getByTestId } = render(<MovieDetailScreen />);

      // Switch to edit mode
      fireEvent.press(getByTestId('movie-detail-edit-button'));

      // Submit the form (title is pre-filled, year and content type also)
      fireEvent.press(getByTestId('movie-form-submit-button'));

      await waitFor(() => {
        expect(mockUpdateMovie).toHaveBeenCalledWith(
          'mov-1',
          expect.objectContaining({ title: 'The Matrix', year: 1999 }),
        );
      });
    });

    it('returns to detail view after successful update', async () => {
      mockUseMovies.mockReturnValue(makeMoviesMock({ movie: MOCK_MOVIE }));

      const { getByTestId, queryByTestId } = render(<MovieDetailScreen />);

      fireEvent.press(getByTestId('movie-detail-edit-button'));
      expect(getByTestId('movie-form-title-input')).toBeTruthy();

      fireEvent.press(getByTestId('movie-form-submit-button'));

      await waitFor(
        () => {
          expect(queryByTestId('movie-form-title-input')).toBeNull();
          expect(getByTestId('movie-detail-title')).toBeTruthy();
        },
        { timeout: 3000 },
      );
    });

    it('returns to detail view when Cancel is pressed in edit mode', () => {
      mockUseMovies.mockReturnValue(makeMoviesMock({ movie: MOCK_MOVIE }));

      const { getByTestId, queryByTestId } = render(<MovieDetailScreen />);

      fireEvent.press(getByTestId('movie-detail-edit-button'));
      expect(getByTestId('movie-form-cancel-button')).toBeTruthy();

      fireEvent.press(getByTestId('movie-form-cancel-button'));
      expect(queryByTestId('movie-form-title-input')).toBeNull();
      expect(getByTestId('movie-detail-title')).toBeTruthy();
    });
  });

  // ─── T148: delete flow ─────────────────────────────────────────────────────

  describe('delete flow (T148)', () => {
    beforeEach(() => {
      mockUseMovies.mockReturnValue(makeMoviesMock({ movie: MOCK_MOVIE }));
    });

    it('pressing delete button opens DeleteConfirmationDialog', () => {
      const { getByTestId } = render(<MovieDetailScreen />);
      fireEvent.press(getByTestId('movie-detail-delete-button'));
      expect(getByTestId('delete-dialog')).toBeTruthy();
    });

    it('confirming delete calls deleteMovie with the movie id', async () => {
      const { getByTestId } = render(<MovieDetailScreen />);
      fireEvent.press(getByTestId('movie-detail-delete-button'));
      fireEvent.press(getByTestId('delete-dialog-confirm-button'));

      await waitFor(() => {
        expect(mockDeleteMovie).toHaveBeenCalledWith('mov-1');
      });
    });

    it('navigates back after successful delete', async () => {
      mockDeleteMovie.mockResolvedValue(undefined);
      const { getByTestId } = render(<MovieDetailScreen />);
      fireEvent.press(getByTestId('movie-detail-delete-button'));
      fireEvent.press(getByTestId('delete-dialog-confirm-button'));

      await waitFor(() => {
        expect(mockBack).toHaveBeenCalled();
      });
    });

    it('cancelling delete closes dialog without calling deleteMovie', () => {
      const { getByTestId, queryByTestId } = render(<MovieDetailScreen />);
      fireEvent.press(getByTestId('movie-detail-delete-button'));
      expect(getByTestId('delete-dialog')).toBeTruthy();

      fireEvent.press(getByTestId('delete-dialog-cancel-button'));

      expect(queryByTestId('delete-dialog')).toBeNull();
      expect(mockDeleteMovie).not.toHaveBeenCalled();
    });

    it('movie detail remains visible after cancel', () => {
      const { getByTestId } = render(<MovieDetailScreen />);
      fireEvent.press(getByTestId('movie-detail-delete-button'));
      fireEvent.press(getByTestId('delete-dialog-cancel-button'));
      expect(getByTestId('movie-detail-title')).toBeTruthy();
    });
  });
});
