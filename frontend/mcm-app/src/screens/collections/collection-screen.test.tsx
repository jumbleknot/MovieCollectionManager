/**
 * Unit tests for CollectionScreen (T134)
 *
 * Tests cover:
 * - Renders MovieList component
 * - Renders MovieSearchBar component
 * - Renders MovieFilterPanel component
 * - Renders ColumnSelector component
 * - Renders "Add Movie" button
 * - Tapping a movie row navigates to movie detail screen
 * - Delegates search, filter, column, and load-more to useMovies hook
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { CollectionScreen } from '@/screens/collections/collection-screen';
import type { Movie, ColumnVisibility, FilterOptionsData, MovieListFilters } from '@/types/collection';

// ─── Mock dependencies ─────────────────────────────────────────────────────────

const mockListMovies = jest.fn().mockResolvedValue(undefined);
const mockLoadMore = jest.fn().mockResolvedValue(undefined);
const mockSetSearch = jest.fn();
const mockSetFilter = jest.fn().mockResolvedValue(undefined);
const mockClearFilters = jest.fn().mockResolvedValue(undefined);
const mockToggleColumn = jest.fn();
const mockFetchFilterOptions = jest.fn().mockResolvedValue(undefined);

const VISIBLE_COLS: ColumnVisibility = {
  year: true, contentType: true, language: false, owned: true, ripped: true,
  childrens: false, genres: false, rated: false, ownedMedia: false, ripQuality: false,
  runtime: false, directors: false, actors: false,
};

const FILTER_OPTIONS: FilterOptionsData = {
  genres: ['Action'], contentTypes: ['Movie'], rated: ['R'],
  languages: ['English'], decades: [2000], ownedMedia: ['Blu-Ray'], ripQuality: ['1080p'],
};

const MOCK_MOVIES: Movie[] = [
  {
    movieId: 'mov-1', collectionId: 'col-1', title: 'The Matrix', year: 1999,
    contentType: 'Movie', language: 'English', owned: true, ripped: true, childrens: false,
    ownedMedia: ['Blu-Ray'], ripQuality: ['1080p'], genres: [], rated: null,
    directors: [], actors: [], tags: [], movieSet: null, originalTitle: null,
    releaseDate: null, outline: null, plot: null, runtime: 136, externalIds: [],
    createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
  },
];

jest.mock('@/hooks/use-movies', () => ({
  useMovies: jest.fn(() => ({
    // Single-movie (not used in this screen)
    movie: null, isLoading: false, error: null,
    getMovie: jest.fn(), createMovie: jest.fn(), updateMovie: jest.fn(),
    // List
    movies: MOCK_MOVIES, isLoadingList: false, listError: null, hasMore: false,
    listMovies: mockListMovies, loadMore: mockLoadMore,
    // Search
    search: '', setSearch: mockSetSearch,
    // Filters
    filters: {} as MovieListFilters, setFilter: mockSetFilter, clearFilters: mockClearFilters,
    // Column visibility
    visibleColumns: VISIBLE_COLS, toggleColumn: mockToggleColumn,
    // Filter options
    filterOptions: FILTER_OPTIONS, isLoadingFilterOptions: false,
    fetchFilterOptions: mockFetchFilterOptions,
  })),
}));

const mockPush = jest.fn();
// jest.mock factories are hoisted before ES imports; use require() for module
// access inside the factory to avoid Babel transform errors.
jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useEffect } = require('react');
  return {
    useRouter: () => ({ push: mockPush }),
    useLocalSearchParams: () => ({ collectionId: 'col-1' }),
    // Simulate useFocusEffect by scheduling the callback with useEffect so it
    // fires after mount (mirrors actual expo-router focus behaviour in tests).
    useFocusEffect: (cb) => {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useEffect(cb, []);
    },
  };
});

jest.mock('@/bff-server/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('CollectionScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the movie list', () => {
    const { getByTestId } = render(<CollectionScreen collectionId="col-1" />);
    expect(getByTestId('movie-list-container')).toBeTruthy();
  });

  it('renders the search bar', () => {
    const { getByTestId } = render(<CollectionScreen collectionId="col-1" />);
    expect(getByTestId('movie-search-input')).toBeTruthy();
  });

  it('renders the filter panel', () => {
    const { getByTestId } = render(<CollectionScreen collectionId="col-1" />);
    expect(getByTestId('movie-filter-panel')).toBeTruthy();
  });

  it('renders the column selector', () => {
    const { getByTestId } = render(<CollectionScreen collectionId="col-1" />);
    expect(getByTestId('column-toggle-year')).toBeTruthy();
  });

  it('renders an "Add Movie" button', () => {
    const { getByTestId } = render(<CollectionScreen collectionId="col-1" />);
    expect(getByTestId('collection-screen-add-movie')).toBeTruthy();
  });

  it('calls listMovies and fetchFilterOptions on screen focus (initial mount)', async () => {
    render(<CollectionScreen collectionId="col-1" />);
    await waitFor(() => {
      expect(mockListMovies).toHaveBeenCalledTimes(1);
      expect(mockFetchFilterOptions).toHaveBeenCalledTimes(1);
    });
  });

  it('tapping a movie row navigates to movie detail screen', () => {
    const { getAllByTestId } = render(<CollectionScreen collectionId="col-1" />);
    fireEvent.press(getAllByTestId('movie-list-item-row')[0]);
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('mov-1'),
    );
  });

  it('delegates setSearch to useMovies hook when search changes', () => {
    const { getByTestId } = render(<CollectionScreen collectionId="col-1" />);
    fireEvent.changeText(getByTestId('movie-search-input'), 'batman');
    expect(mockSetSearch).toHaveBeenCalledWith('batman');
  });

  it('delegates setFilter to useMovies hook when filter chip is pressed', () => {
    const { getByTestId } = render(<CollectionScreen collectionId="col-1" />);
    fireEvent.press(getByTestId('filter-chip-genre-Action'));
    expect(mockSetFilter).toHaveBeenCalledWith('genre', 'Action');
  });

  it('delegates toggleColumn to useMovies hook when column toggle is pressed', () => {
    const { getByTestId } = render(<CollectionScreen collectionId="col-1" />);
    fireEvent.press(getByTestId('column-toggle-year'));
    expect(mockToggleColumn).toHaveBeenCalledWith('year');
  });
});
