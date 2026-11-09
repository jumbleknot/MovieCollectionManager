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
 *
 * 098 (US1): the column selector, sort control and filter panel are DOCKED behind the
 * `view-options-toggle` bar. They are absent until the bar is pressed, and every choice made in the
 * open panel applies without closing it (US1-AC1/3/6, FR-001/006/008/009).
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@/test-support/render';
import type { ReactTestInstance } from 'react-test-renderer';
import { CollectionScreen } from '@/screens/collections/collection-screen';
import { OpenPanelProvider } from '@/hooks/use-open-panel';
import type {
  Movie,
  ColumnVisibility,
  FilterOptionsData,
  MovieListFilters,
} from '@/types/collection';

// ─── Mock dependencies ─────────────────────────────────────────────────────────

const mockListMovies = jest.fn().mockResolvedValue(undefined);
const mockLoadMore = jest.fn().mockResolvedValue(undefined);
const mockSetSearch = jest.fn();
const mockSetFilter = jest.fn().mockResolvedValue(undefined);
const mockClearFilters = jest.fn().mockResolvedValue(undefined);
const mockToggleColumn = jest.fn();
const mockFetchFilterOptions = jest.fn().mockResolvedValue(undefined);
const mockSetSort = jest.fn().mockResolvedValue(undefined);
// Mutable so a test can render with active filters (the badge) and model "Clear".
let mockFilters: MovieListFilters = {};

const VISIBLE_COLS: ColumnVisibility = {
  year: true,
  contentType: true,
  language: false,
  owned: true,
  ripped: true,
  childrens: false,
  genres: false,
  rated: false,
  ownedMedia: false,
  ripQuality: false,
  runtime: false,
  directors: false,
  actors: false,
};

const FILTER_OPTIONS: FilterOptionsData = {
  genres: ['Action'],
  contentTypes: ['Movie'],
  rated: ['R'],
  languages: ['English'],
  decades: [2000],
  ownedMedia: ['Blu-Ray'],
  ripQuality: ['1080p'],
};

const MOCK_MOVIES: Movie[] = [
  {
    movieId: 'mov-1',
    collectionId: 'col-1',
    title: 'The Matrix',
    year: 1999,
    contentType: 'Movie',
    language: 'English',
    owned: true,
    ripped: true,
    childrens: false,
    ownedMedia: ['Blu-Ray'],
    ripQuality: ['Blu-Ray'],
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
    runtime: 136,
    externalIds: [],
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
  },
];

jest.mock('@/hooks/use-movies', () => ({
  useMovies: jest.fn(() => ({
    // Single-movie (not used in this screen)
    movie: null,
    isLoading: false,
    error: null,
    getMovie: jest.fn(),
    createMovie: jest.fn(),
    updateMovie: jest.fn(),
    // List
    movies: MOCK_MOVIES,
    isLoadingList: false,
    listError: null,
    hasMore: false,
    listMovies: mockListMovies,
    loadMore: mockLoadMore,
    // Search
    search: '',
    setSearch: mockSetSearch,
    // Sort
    sortBy: 'title',
    sortDir: 'asc',
    setSort: mockSetSort,
    // Filters
    filters: mockFilters,
    setFilter: mockSetFilter,
    clearFilters: mockClearFilters,
    // Filter options
    filterOptions: FILTER_OPTIONS,
    isLoadingFilterOptions: false,
    fetchFilterOptions: mockFetchFilterOptions,
  })),
}));

jest.mock('@/hooks/use-column-visibility', () => ({
  useColumnVisibility: jest.fn(() => ({
    visibleColumns: VISIBLE_COLS,
    toggleColumn: mockToggleColumn,
    isLoaded: true,
  })),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(() => ({
    user: {
      id: 'test-user-id',
      username: 'testuser',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      roles: ['mc-user'],
      emailVerified: true,
      accountStatus: 'active',
      createdAt: '2026-01-01T00:00:00Z',
    },
    isAuthenticated: true,
    isLoading: false,
    refreshAuth: jest.fn(),
    logout: jest.fn(),
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
    useFocusEffect: (cb: React.EffectCallback) => {
      // The empty dep array is intentional: this mock fires the focus callback
      // exactly once on mount to simulate expo-router's focus behaviour. Adding
      // `cb` to the deps would re-run on every render (cb is a fresh closure each
      // render), diverging from real focus semantics — so exhaustive-deps is
      // disabled here. The inline wrapper returns cb()'s result so any cleanup
      // function the callback returns is still honored.
      // eslint-disable-next-line react-hooks/rules-of-hooks, react-hooks/exhaustive-deps
      useEffect(() => cb(), []);
    },
  };
});

jest.mock('@/utils/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));

// ─── Tests ─────────────────────────────────────────────────────────────────────

// The screen reads the OpenPanel context (provided by the (app) layout in the app).
async function renderScreen(): Promise<Awaited<ReturnType<typeof render>>> {
  return render(
    <OpenPanelProvider>
      <CollectionScreen collectionId="col-1" />
    </OpenPanelProvider>,
  );
}

async function openViewOptions(utils: Awaited<ReturnType<typeof render>>): Promise<void> {
  await fireEvent.press(utils.getByTestId('view-options-toggle'));
  expect(utils.getByTestId('view-options-panel')).toBeTruthy();
}

/** Host testIDs in render (document) order. */
function testIdOrder(root: ReactTestInstance): string[] {
  return root
    .findAll((n) => typeof n.type === 'string' && typeof n.props.testID === 'string')
    .map((n) => n.props.testID as string);
}

describe('CollectionScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFilters = {};
  });

  it('renders the movie list', async () => {
    const { getByTestId } = await renderScreen();
    expect(getByTestId('movie-list-container')).toBeTruthy();
  });

  it('renders the search bar', async () => {
    const { getByTestId } = await renderScreen();
    expect(getByTestId('movie-search-input')).toBeTruthy();
  });

  it('renders an "Add Movie" button', async () => {
    const { getByTestId } = await renderScreen();
    expect(getByTestId('collection-screen-add-movie')).toBeTruthy();
  });

  describe('docked view options (098 US1)', () => {
    it('docks the column selector, sort control and filter panel on first render (US1-AC1, FR-001/004)', async () => {
      const { queryByTestId, getByTestId } = await renderScreen();
      expect(getByTestId('view-options-toggle')).toBeTruthy();
      expect(queryByTestId('column-toggle-language')).toBeNull();
      expect(queryByTestId('movie-sort-control')).toBeNull();
      expect(queryByTestId('movie-filter-panel')).toBeNull();
      expect(queryByTestId('view-options-panel')).toBeNull();
    });

    it('places the bar between the search bar and the count row (FR-002)', async () => {
      const { UNSAFE_root } = await renderScreen();
      const order = testIdOrder(UNSAFE_root);
      const search = order.indexOf('movie-search-input');
      const toggle = order.indexOf('view-options-toggle');
      const count = order.indexOf('movie-count-line');
      expect(search).toBeGreaterThanOrEqual(0);
      expect(toggle).toBeGreaterThan(search);
      expect(count).toBeGreaterThan(toggle);
    });

    it('shows all three controls once opened (US1-AC2)', async () => {
      const utils = await renderScreen();
      await openViewOptions(utils);
      expect(utils.getByTestId('column-toggle-language')).toBeTruthy();
      expect(utils.getByTestId('movie-sort-control')).toBeTruthy();
      expect(utils.getByTestId('movie-filter-panel')).toBeTruthy();
    });

    it('a filter chip calls setFilter and leaves the panel open (US1-AC3, FR-006)', async () => {
      const utils = await renderScreen();
      await openViewOptions(utils);
      await fireEvent.press(utils.getByTestId('filter-chip-genre-Action'));
      expect(mockSetFilter).toHaveBeenCalledWith('genre', 'Action');
      expect(utils.getByTestId('view-options-panel')).toBeTruthy();
    });

    it('a column toggle calls toggleColumn and leaves the panel open (US1-AC3, FR-006)', async () => {
      const utils = await renderScreen();
      await openViewOptions(utils);
      await fireEvent.press(utils.getByTestId('column-toggle-language'));
      expect(mockToggleColumn).toHaveBeenCalledWith('language');
      expect(utils.getByTestId('view-options-panel')).toBeTruthy();
    });

    it('a sort choice calls setSort and leaves the panel open (US1-AC3, FR-006)', async () => {
      const utils = await renderScreen();
      await openViewOptions(utils);
      await fireEvent.press(utils.getByTestId('sort-field-year'));
      expect(mockSetSort).toHaveBeenCalledWith('year', 'asc');
      await fireEvent.press(utils.getByTestId('sort-dir-toggle'));
      expect(mockSetSort).toHaveBeenCalledWith('title', 'desc');
      expect(utils.getByTestId('view-options-panel')).toBeTruthy();
    });

    it('docking and undocking do not touch columns, sort or filters (FR-009)', async () => {
      const utils = await renderScreen();
      await openViewOptions(utils);
      await fireEvent.press(utils.getByTestId('view-options-close'));
      await openViewOptions(utils);
      expect(mockSetFilter).not.toHaveBeenCalled();
      expect(mockClearFilters).not.toHaveBeenCalled();
      expect(mockSetSort).not.toHaveBeenCalled();
      expect(mockToggleColumn).not.toHaveBeenCalled();
    });

    it('the docked bar shows the active-filter count, and Clear removes it (US1-AC5/6, FR-008)', async () => {
      mockFilters = { genre: 'Action', owned: false };
      mockClearFilters.mockImplementationOnce(async () => {
        mockFilters = {};
      });
      const utils = await renderScreen();
      expect(utils.getByTestId('view-options-active-count')).toHaveTextContent('2');

      await openViewOptions(utils);
      await fireEvent.press(utils.getByTestId('filter-clear-button'));
      expect(mockClearFilters).toHaveBeenCalledTimes(1);
      await fireEvent.press(utils.getByTestId('view-options-close'));
      await utils.rerender(
        <OpenPanelProvider>
          <CollectionScreen collectionId="col-1" />
        </OpenPanelProvider>,
      );
      expect(utils.queryByTestId('view-options-active-count')).toBeNull();
    });
  });

  it('calls listMovies and fetchFilterOptions on screen focus (initial mount)', async () => {
    await renderScreen();
    await waitFor(() => {
      expect(mockListMovies).toHaveBeenCalledTimes(1);
      expect(mockFetchFilterOptions).toHaveBeenCalledTimes(1);
    });
  });

  it('tapping a movie row navigates to movie detail screen', async () => {
    const { getAllByTestId } = await renderScreen();
    await fireEvent.press(getAllByTestId('movie-list-item-row')[0]);
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('mov-1'));
  });

  it('delegates setSearch to useMovies hook when search changes', async () => {
    const { getByTestId } = await renderScreen();
    await fireEvent.changeText(getByTestId('movie-search-input'), 'batman');
    expect(mockSetSearch).toHaveBeenCalledWith('batman');
  });
});
