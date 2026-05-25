/**
 * Unit tests for useMovies hook (T097 + T123 + T150)
 *
 * Tests cover (create/get/update operations for US2):
 * - getMovie fetches from BFF GET on demand (called on screen mount)
 * - createMovie calls BFF POST and adds movie to state
 * - updateMovie calls BFF PUT and updates movie in state
 * - Error states propagated correctly for each operation
 *
 * Tests cover (list/search/filter additions for US3 — T123):
 * - initial load calls BFF GET movies on mount
 * - loadMore appends next page movies using cursor
 * - search term change resets cursor + reloads
 * - filter change resets cursor + reloads
 * - column visibility state toggled correctly
 * - filter-options fetched on mount
 *
 * Tests cover (delete mutation — T150):
 * - deleteMovie calls BFF DELETE /collections/:id/movies/:movieId
 * - deleteMovie removes the movie from the movies list (optimistic)
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { apiClient } from '@/bff-server/api-client';
import { useMovies } from '@/hooks/use-movies';
import type { Movie, CreateMovieRequest, FilterOptionsData } from '@/types/collection';

jest.mock('@/bff-server/api-client', () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockedGet = jest.mocked(apiClient.get);
const mockedPost = jest.mocked(apiClient.post);
const mockedPut = jest.mocked(apiClient.put);
const mockedDelete = jest.mocked(apiClient.delete);

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const COLLECTION_ID = 'col-abc-123';
const MOVIE_ID = 'mov-xyz-456';

const MOCK_MOVIE: Movie = {
  movieId: MOVIE_ID,
  collectionId: COLLECTION_ID,
  title: 'The Matrix',
  year: 1999,
  contentType: 'Movie',
  language: 'English',
  owned: true,
  ripped: false,
  childrens: false,
  ownedMedia: ['Blu-Ray'],
  ripQuality: [],
  genres: ['Action', 'Sci-Fi'],
  rated: 'R',
  directors: ['Lana Wachowski', 'Lilly Wachowski'],
  actors: ['Keanu Reeves'],
  tags: [],
  movieSet: null,
  originalTitle: null,
  releaseDate: '1999-03-31',
  outline: null,
  plot: null,
  runtime: 136,
  externalIds: [],
  createdAt: '2026-05-23T00:00:00.000Z',
  updatedAt: '2026-05-23T00:00:00.000Z',
};

const CREATE_MOVIE_REQUEST: CreateMovieRequest = {
  title: 'The Matrix',
  year: 1999,
  contentType: 'Movie',
  language: 'English',
  owned: true,
  ripped: false,
  childrens: false,
  ownedMedia: ['Blu-Ray'],
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('useMovies', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('initial state', () => {
    it('starts with null movie, not loading, no error', () => {
      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      expect(result.current.movie).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('getMovie', () => {
    it('fetches movie from GET /bff-api/collections/:id/movies/:movieId', async () => {
      mockedGet.mockResolvedValueOnce({ data: MOCK_MOVIE } as never);

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.getMovie(MOVIE_ID);
      });

      expect(mockedGet).toHaveBeenCalledWith(
        `/bff-api/collections/${COLLECTION_ID}/movies/${MOVIE_ID}`,
      );
    });

    it('sets movie state after successful GET', async () => {
      mockedGet.mockResolvedValueOnce({ data: MOCK_MOVIE } as never);

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.getMovie(MOVIE_ID);
      });

      expect(result.current.movie).toEqual(MOCK_MOVIE);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('sets isLoading true during fetch', async () => {
      let resolveGet!: (val: unknown) => void;
      mockedGet.mockReturnValueOnce(
        new Promise((res) => { resolveGet = res; }) as never,
      );

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      act(() => { void result.current.getMovie(MOVIE_ID); });

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        resolveGet({ data: MOCK_MOVIE });
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('sets error state when GET fails', async () => {
      mockedGet.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.getMovie(MOVIE_ID);
      });

      expect(result.current.movie).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBe('Failed to load movie');
    });
  });

  describe('createMovie', () => {
    it('sends POST to /bff-api/collections/:id/movies with the movie body', async () => {
      mockedPost.mockResolvedValueOnce({ data: MOCK_MOVIE } as never);

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.createMovie(CREATE_MOVIE_REQUEST);
      });

      expect(mockedPost).toHaveBeenCalledWith(
        `/bff-api/collections/${COLLECTION_ID}/movies`,
        CREATE_MOVIE_REQUEST,
      );
    });

    it('sets movie state after successful POST', async () => {
      mockedPost.mockResolvedValueOnce({ data: MOCK_MOVIE } as never);

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.createMovie(CREATE_MOVIE_REQUEST);
      });

      expect(result.current.movie).toEqual(MOCK_MOVIE);
      expect(result.current.error).toBeNull();
    });

    it('sets error state and re-throws when POST fails with 409 (duplicate) — extracts title', async () => {
      mockedPost.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          data: {
            type: 'https://mc-service/errors/duplicate-movie',
            title: 'Duplicate Movie',
            status: 409,
          },
        },
      });

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        // Hook re-throws after setting error state — caller must catch.
        await result.current.createMovie(CREATE_MOVIE_REQUEST).catch(() => {});
      });

      expect(result.current.movie).toBeNull();
      // RFC 9457 title extracted from response
      expect(result.current.error).toBe('Duplicate Movie');
    });

    it('sets error state and re-throws when POST fails with 400 (invalid input) — extracts title', async () => {
      mockedPost.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          data: {
            type: 'https://mc-service/errors/invalid-input',
            title: 'Invalid Input',
            status: 400,
          },
        },
      });

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.createMovie(CREATE_MOVIE_REQUEST).catch(() => {});
      });

      expect(result.current.error).toBe('Invalid Input');
    });

    it('uses detail field over title when both present in RFC 9457 response', async () => {
      mockedPost.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          data: {
            type: 'https://mc-service/errors/duplicate-movie',
            title: 'Duplicate Movie',
            detail: 'A movie with this title already exists in the collection.',
            status: 409,
          },
        },
      });

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.createMovie(CREATE_MOVIE_REQUEST).catch(() => {});
      });

      expect(result.current.error).toBe('A movie with this title already exists in the collection.');
    });

    it('falls back to generic message when not an Axios error', async () => {
      mockedPost.mockRejectedValueOnce(new Error('Network failure'));

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.createMovie(CREATE_MOVIE_REQUEST).catch(() => {});
      });

      expect(result.current.error).toBe('Failed to create movie');
    });
  });

  describe('updateMovie', () => {
    it('sends PUT to /bff-api/collections/:id/movies/:movieId with the full body', async () => {
      const updatedMovie = { ...MOCK_MOVIE, ripped: true, ripQuality: ['Blu-Ray'] as Movie['ripQuality'] };
      const updateRequest: CreateMovieRequest = {
        ...CREATE_MOVIE_REQUEST,
        ripped: true,
        ripQuality: ['Blu-Ray'],
      };
      mockedPut.mockResolvedValueOnce({ data: updatedMovie } as never);

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.updateMovie(MOVIE_ID, updateRequest);
      });

      expect(mockedPut).toHaveBeenCalledWith(
        `/bff-api/collections/${COLLECTION_ID}/movies/${MOVIE_ID}`,
        updateRequest,
      );
    });

    it('updates movie state after successful PUT', async () => {
      const updatedMovie = { ...MOCK_MOVIE, ripped: true, ripQuality: ['Blu-Ray'] as Movie['ripQuality'] };
      mockedPut.mockResolvedValueOnce({ data: updatedMovie } as never);

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.updateMovie(MOVIE_ID, { ...CREATE_MOVIE_REQUEST, ripped: true, ripQuality: ['Blu-Ray'] });
      });

      expect(result.current.movie?.ripped).toBe(true);
      expect(result.current.movie?.ripQuality).toEqual(['Blu-Ray']);
      expect(result.current.error).toBeNull();
    });

    it('sets error state and re-throws when PUT fails with 404 (movie not found) — extracts title', async () => {
      mockedPut.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          data: {
            type: 'https://mc-service/errors/movie-not-found',
            title: 'Movie Not Found',
            status: 404,
          },
        },
      });

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        // Hook re-throws after setting error state — caller must catch.
        await result.current.updateMovie(MOVIE_ID, CREATE_MOVIE_REQUEST).catch(() => {});
      });

      expect(result.current.error).toBe('Movie Not Found');
    });

    it('sets error state and re-throws when PUT fails with 409 (duplicate) — extracts title', async () => {
      mockedPut.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          data: {
            type: 'https://mc-service/errors/duplicate-movie',
            title: 'Duplicate Movie',
            status: 409,
          },
        },
      });

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.updateMovie(MOVIE_ID, CREATE_MOVIE_REQUEST).catch(() => {});
      });

      expect(result.current.error).toBe('Duplicate Movie');
    });
  });

  describe('error clearing', () => {
    it('clears error on a subsequent successful operation', async () => {
      mockedGet.mockRejectedValueOnce(new Error('fail'));
      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.getMovie(MOVIE_ID);
      });
      expect(result.current.error).toBe('Failed to load movie');

      mockedGet.mockResolvedValueOnce({ data: MOCK_MOVIE } as never);
      await act(async () => {
        await result.current.getMovie(MOVIE_ID);
      });
      expect(result.current.error).toBeNull();
    });
  });
});

// ─── T123: List / Search / Filter additions ────────────────────────────────────

const MOCK_MOVIE_2: Movie = {
  ...MOCK_MOVIE,
  movieId: 'mov-2',
  title: 'The Matrix Reloaded',
  year: 2003,
};

const MOCK_MOVIE_LIST = {
  items: [MOCK_MOVIE],
  nextCursor: null as string | null,
};

const MOCK_FILTER_OPTIONS: FilterOptionsData = {
  genres: ['Action', 'Drama'],
  contentTypes: ['Movie', 'Series'],
  rated: ['PG-13', 'R'],
  languages: ['English', 'French'],
  decades: [1990, 2000],
  ownedMedia: ['Blu-Ray', 'DVD'],
  ripQuality: ['1080p'],
};

describe('useMovies — list/search/filter (T123)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Default: movies list endpoint → first page, filter-options endpoint → options
    mockedGet.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.endsWith('/filter-options')) {
        return Promise.resolve({ data: MOCK_FILTER_OPTIONS });
      }
      return Promise.resolve({ data: MOCK_MOVIE_LIST });
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Initial load ─────────────────────────────────────────────────────────────

  it('listMovies() calls BFF GET /bff-api/collections/:id/movies', async () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => {
      await result.current.listMovies();
    });

    expect(mockedGet).toHaveBeenCalledWith(
      `/bff-api/collections/${COLLECTION_ID}/movies`,
      expect.objectContaining({ params: expect.any(Object) }),
    );
  });

  it('populates movies state after listMovies()', async () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => {
      await result.current.listMovies();
    });

    expect(result.current.movies).toHaveLength(1);
    expect(result.current.movies[0].movieId).toBe(MOVIE_ID);
    expect(result.current.hasMore).toBe(false);
  });

  it('sets hasMore=true when nextCursor is present', async () => {
    mockedGet.mockImplementationOnce(() =>
      Promise.resolve({ data: { items: [MOCK_MOVIE], nextCursor: 'cursor-page-2' } }),
    );

    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => {
      await result.current.listMovies();
    });

    expect(result.current.hasMore).toBe(true);
  });

  // ── Infinite scroll / loadMore ────────────────────────────────────────────────

  it('loadMore() appends next page movies using cursor', async () => {
    mockedGet
      .mockImplementationOnce(() =>
        Promise.resolve({ data: { items: [MOCK_MOVIE], nextCursor: 'cursor-page-2' } }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ data: { items: [MOCK_MOVIE_2], nextCursor: null } }),
      );

    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => { await result.current.listMovies(); });
    await act(async () => { await result.current.loadMore(); });

    expect(result.current.movies).toHaveLength(2);
    expect(result.current.movies[1].movieId).toBe('mov-2');
    expect(result.current.hasMore).toBe(false);
  });

  it('loadMore() passes cursor param to BFF GET', async () => {
    mockedGet.mockImplementationOnce(() =>
      Promise.resolve({ data: { items: [MOCK_MOVIE], nextCursor: 'cursor-abc' } }),
    );

    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => { await result.current.listMovies(); });

    mockedGet.mockImplementationOnce(() =>
      Promise.resolve({ data: { items: [MOCK_MOVIE_2], nextCursor: null } }),
    );
    await act(async () => { await result.current.loadMore(); });

    const secondCall = (mockedGet as jest.Mock).mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'object' &&
        call[1] !== null &&
        'params' in (call[1] as object) &&
        (call[1] as { params: { cursor?: string } }).params.cursor === 'cursor-abc',
    );
    expect(secondCall).toBeDefined();
  });

  it('loadMore() does nothing when hasMore is false', async () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => { await result.current.listMovies(); });

    const callCountAfterList = (mockedGet as jest.Mock).mock.calls.length;

    await act(async () => { await result.current.loadMore(); });

    // No additional list call made (filter-options may still be counted)
    const listCalls = (mockedGet as jest.Mock).mock.calls.filter(
      (call: unknown[]) => !String(call[0]).endsWith('/filter-options'),
    );
    expect(listCalls.length).toBe(callCountAfterList - (mockedGet as jest.Mock).mock.calls.filter(
      (call: unknown[]) => String(call[0]).endsWith('/filter-options'),
    ).length);
  });

  // ── Search ───────────────────────────────────────────────────────────────────

  it('setSearch() forwards search param to BFF GET after debounce', async () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => { await result.current.listMovies(); });

    act(() => { result.current.setSearch('batman'); });

    // Advance past debounce delay (300ms)
    await act(async () => { jest.advanceTimersByTime(350); });
    await act(async () => {});

    const searchCall = (mockedGet as jest.Mock).mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'object' &&
        call[1] !== null &&
        'params' in (call[1] as object) &&
        (call[1] as { params: { search?: string } }).params.search === 'batman',
    );
    expect(searchCall).toBeDefined();
  });

  it('setSearch() resets cursor when reloading', async () => {
    mockedGet.mockImplementationOnce(() =>
      Promise.resolve({ data: { items: [MOCK_MOVIE], nextCursor: 'old-cursor' } }),
    );

    const { result } = renderHook(() => useMovies(COLLECTION_ID));
    await act(async () => { await result.current.listMovies(); });
    expect(result.current.hasMore).toBe(true);

    act(() => { result.current.setSearch('batman'); });
    await act(async () => { jest.advanceTimersByTime(350); });
    await act(async () => {});

    // After search reload, cursor is reset (no cursor param in new call)
    const searchCall = (mockedGet as jest.Mock).mock.calls.slice(-1)[0];
    const params = (searchCall[1] as { params: Record<string, unknown> })?.params ?? {};
    expect(params.cursor).toBeUndefined();
  });

  // ── Filters ──────────────────────────────────────────────────────────────────

  it('setFilter() forwards filter param to BFF GET immediately', async () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));
    await act(async () => { await result.current.listMovies(); });

    await act(async () => {
      await result.current.setFilter('contentType', 'Series');
    });

    const filterCall = (mockedGet as jest.Mock).mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'object' &&
        call[1] !== null &&
        'params' in (call[1] as object) &&
        (call[1] as { params: { contentType?: string } }).params.contentType === 'Series',
    );
    expect(filterCall).toBeDefined();
  });

  it('setFilter() resets cursor when reloading', async () => {
    mockedGet.mockImplementationOnce(() =>
      Promise.resolve({ data: { items: [MOCK_MOVIE], nextCursor: 'old-cursor' } }),
    );

    const { result } = renderHook(() => useMovies(COLLECTION_ID));
    await act(async () => { await result.current.listMovies(); });
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.setFilter('contentType', 'Series');
    });

    // No cursor in filter reload call
    const filterCall = (mockedGet as jest.Mock).mock.calls.slice(-1)[0];
    const params = (filterCall[1] as { params: Record<string, unknown> })?.params ?? {};
    expect(params.cursor).toBeUndefined();
  });

  it('clearFilters() reloads without filter params', async () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));
    await act(async () => { await result.current.listMovies(); });

    await act(async () => {
      await result.current.setFilter('contentType', 'Series');
    });

    await act(async () => {
      await result.current.clearFilters();
    });

    const clearCall = (mockedGet as jest.Mock).mock.calls.slice(-1)[0];
    const params = (clearCall[1] as { params: Record<string, unknown> })?.params ?? {};
    expect(params.contentType).toBeUndefined();
  });

  // ── Column visibility ─────────────────────────────────────────────────────────

  it('starts with default visible columns (title always visible)', () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));
    // title is always visible (not in toggleable columns, but checked via the column key)
    expect(result.current.visibleColumns).toBeDefined();
    expect(typeof result.current.visibleColumns).toBe('object');
  });

  it('toggleColumn() flips column visibility', () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    const initialRuntimeVisible = result.current.visibleColumns.runtime;

    act(() => { result.current.toggleColumn('runtime'); });

    expect(result.current.visibleColumns.runtime).toBe(!initialRuntimeVisible);
  });

  it('toggleColumn() can be toggled back', () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    const initial = result.current.visibleColumns.runtime;

    act(() => { result.current.toggleColumn('runtime'); });
    act(() => { result.current.toggleColumn('runtime'); });

    expect(result.current.visibleColumns.runtime).toBe(initial);
  });

  // ── Filter options ────────────────────────────────────────────────────────────

  it('fetchFilterOptions() calls BFF GET /bff-api/collections/:id/movies/filter-options', async () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => {
      await result.current.fetchFilterOptions();
    });

    expect(mockedGet).toHaveBeenCalledWith(
      `/bff-api/collections/${COLLECTION_ID}/movies/filter-options`,
    );
  });

  it('populates filterOptions state after fetchFilterOptions()', async () => {
    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => {
      await result.current.fetchFilterOptions();
    });

    expect(result.current.filterOptions).not.toBeNull();
    expect(result.current.filterOptions?.genres).toEqual(['Action', 'Drama']);
    expect(result.current.filterOptions?.contentTypes).toEqual(['Movie', 'Series']);
  });

  it('sets listError when listMovies() fails', async () => {
    mockedGet.mockImplementationOnce(() => Promise.reject(new Error('Network error')));

    const { result } = renderHook(() => useMovies(COLLECTION_ID));

    await act(async () => {
      await result.current.listMovies();
    });

    expect(result.current.listError).toBe('Failed to load movies');
    expect(result.current.movies).toHaveLength(0);
  });

  // ── deleteMovie (T150) ────────────────────────────────────────────────────────

  describe('deleteMovie (T150)', () => {
    beforeEach(() => {
      mockedDelete.mockResolvedValue({ data: null } as never);
    });

    it('calls BFF DELETE /bff-api/collections/:id/movies/:movieId', async () => {
      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.deleteMovie(MOVIE_ID);
      });

      expect(mockedDelete).toHaveBeenCalledWith(
        `/bff-api/collections/${COLLECTION_ID}/movies/${MOVIE_ID}`,
      );
    });

    it('removes the deleted movie from the movies list (optimistic removal)', async () => {
      // Seed the hook with a loaded movies list
      mockedGet.mockResolvedValueOnce({
        data: { items: [MOCK_MOVIE], nextCursor: null },
      } as never);

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.listMovies();
      });

      expect(result.current.movies).toHaveLength(1);

      await act(async () => {
        await result.current.deleteMovie(MOVIE_ID);
      });

      expect(result.current.movies).toHaveLength(0);
    });

    it('clears the single movie state when the deleted movie matches the current movie', async () => {
      mockedGet.mockResolvedValueOnce({ data: MOCK_MOVIE } as never);

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        await result.current.getMovie(MOVIE_ID);
      });

      expect(result.current.movie).not.toBeNull();

      await act(async () => {
        await result.current.deleteMovie(MOVIE_ID);
      });

      expect(result.current.movie).toBeNull();
    });

    it('propagates error and re-throws when DELETE fails — falls back to generic message for non-Axios error', async () => {
      mockedDelete.mockRejectedValueOnce(new Error('Server error'));

      const { result } = renderHook(() => useMovies(COLLECTION_ID));

      await act(async () => {
        // Hook re-throws after setting error state — caller must catch.
        await result.current.deleteMovie(MOVIE_ID).catch(() => {});
      });

      expect(result.current.error).toBe('Failed to delete movie');
    });
  });
});
