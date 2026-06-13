/**
 * useMovies hook (T098 + T124 + T150)
 *
 * Manages movie state for both the movie detail/create/edit screen (US2)
 * and the movie list/search/filter screen (US3).
 *
 * Single-movie API surface (US2):
 *   movie          — currently loaded movie, or null
 *   isLoading      — true while any async operation is in flight
 *   error          — last error message, or null
 *   getMovie       — GET /bff-api/collections/:id/movies/:movieId
 *   createMovie    — POST /bff-api/collections/:id/movies
 *   updateMovie    — PUT /bff-api/collections/:id/movies/:movieId
 *   deleteMovie    — DELETE /bff-api/collections/:id/movies/:movieId + optimistic list removal (T150)
 *
 * Movie list API surface (US3):
 *   movies             — current page(s) of movies
 *   isLoadingList      — true while list is loading
 *   listError          — last list error message, or null
 *   hasMore            — true when nextCursor is non-null
 *   listMovies         — load (or reload) the first page
 *   loadMore           — append next page (no-op when hasMore=false)
 *   search             — current search term
 *   setSearch          — debounced (300ms); triggers reload with reset cursor
 *   filters            — current filter state
 *   setFilter          — set a single filter; triggers immediate reload with reset cursor
 *   clearFilters       — reset all filters; triggers immediate reload
 *   filterOptions      — dynamic filter values from the collection
 *   isLoadingFilterOptions — true while filter-options are loading
 *   fetchFilterOptions — explicit fetch of filter-options
 */

import { useState, useCallback, useRef } from 'react';
import axios from 'axios';
import { apiClient } from '@/bff-server/api-client';
import type {
  Movie,
  CreateMovieRequest,
  MovieListFilters,
  FilterOptionsData,
  MovieSortField,
  SortDirection,
} from '@/types/collection';

// ─── Error extraction ──────────────────────────────────────────────────────────

/**
 * Extracts a human-readable error message from an Axios error response.
 * Prefers RFC 9457 Problem Details `detail` field, falls back to `title`,
 * then a generic fallback string.
 */
function extractErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as Record<string, unknown> | undefined;
    if (typeof data?.detail === 'string' && data.detail) return data.detail;
    if (typeof data?.title === 'string' && data.title) return data.title;
    if (typeof data?.message === 'string' && data.message) return data.message;
  }
  return fallback;
}

const SEARCH_DEBOUNCE_MS = 300;

// ─── Hook return type ──────────────────────────────────────────────────────────

interface UseMoviesReturn {
  // ── Single-movie state (US2) ──────────────────────────────────────────────
  movie: Movie | null;
  isLoading: boolean;
  error: string | null;
  getMovie: (movieId: string) => Promise<void>;
  createMovie: (req: CreateMovieRequest) => Promise<void>;
  updateMovie: (movieId: string, req: CreateMovieRequest) => Promise<void>;
  deleteMovie: (movieId: string) => Promise<void>;

  // ── Movie list state (US3) ────────────────────────────────────────────────
  movies: Movie[];
  isLoadingList: boolean;
  listError: string | null;
  hasMore: boolean;
  listMovies: () => Promise<void>;
  loadMore: () => Promise<void>;

  // ── Search ────────────────────────────────────────────────────────────────
  search: string;
  setSearch: (term: string) => void;

  // ── Sort (013 US1) ──────────────────────────────────────────────────────────
  sortBy: MovieSortField;
  sortDir: SortDirection;
  setSort: (field: MovieSortField, dir: SortDirection) => Promise<void>;

  // ── Filters ───────────────────────────────────────────────────────────────
  filters: MovieListFilters;
  setFilter: <K extends keyof MovieListFilters>(key: K, value: MovieListFilters[K]) => Promise<void>;
  clearFilters: () => Promise<void>;

  // ── Filter options ────────────────────────────────────────────────────────
  filterOptions: FilterOptionsData | null;
  isLoadingFilterOptions: boolean;
  fetchFilterOptions: () => Promise<void>;
}

// ─── Hook implementation ───────────────────────────────────────────────────────

export function useMovies(collectionId: string): UseMoviesReturn {
  // ── Single-movie state ─────────────────────────────────────────────────────
  const [movie, setMovie] = useState<Movie | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Movie list state ───────────────────────────────────────────────────────
  const [movies, setMovies] = useState<Movie[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // ── Search & filter state ──────────────────────────────────────────────────
  const [search, setSearchState] = useState('');
  const [filters, setFilters] = useState<MovieListFilters>({});
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Sort state (013 US1) ───────────────────────────────────────────────────
  // Session-scoped (FR-007a): a fresh hook mount starts at the default title↑ — the chosen
  // order is never persisted, so re-opening a collection resets to the default.
  const [sortBy, setSortByState] = useState<MovieSortField>('title');
  const [sortDir, setSortDirState] = useState<SortDirection>('asc');

  // Refs for stable access inside async callbacks without re-renders
  const searchRef = useRef('');
  const filtersRef = useRef<MovieListFilters>({});
  const sortByRef = useRef<MovieSortField>('title');
  const sortDirRef = useRef<SortDirection>('asc');

  // ── Request generation counter ─────────────────────────────────────────────
  // Incremented by every "reset" list operation (listMovies, setSearch debounce,
  // setFilter, clearFilters). After each API call, we compare the counter to the
  // value captured before the call. If it changed, a newer request superseded
  // this one — discard the stale response instead of overwriting fresh results.
  // loadMore snapshots the counter WITHOUT incrementing, so it is discarded if a
  // reset was triggered while it was in flight.
  const listGenRef = useRef(0);

  // ── Filter options state ───────────────────────────────────────────────────
  const [filterOptions, setFilterOptions] = useState<FilterOptionsData | null>(null);
  const [isLoadingFilterOptions, setIsLoadingFilterOptions] = useState(false);

  // ─── List operations ──────────────────────────────────────────────────────

  const _fetchPage = useCallback(
    async (cursor: string | null, currentSearch: string, currentFilters: MovieListFilters) => {
      const params: Record<string, unknown> = { ...currentFilters };
      // 013 US1: always send the active sort so the server orders the page and the
      // compound cursor stays consistent across pages.
      params.sortBy = sortByRef.current;
      params.sortDir = sortDirRef.current;
      if (currentSearch) params.search = currentSearch;
      if (cursor) params.cursor = cursor;

      const res = await apiClient.get(
        `/bff-api/collections/${collectionId}/movies`,
        { params },
      );
      return res.data as { items: Movie[]; nextCursor: string | null };
    },
    [collectionId],
  );

  const listMovies = useCallback(async (): Promise<void> => {
    const gen = ++listGenRef.current; // this reset supersedes any prior request
    setIsLoadingList(true);
    setListError(null);
    try {
      const data = await _fetchPage(null, searchRef.current, filtersRef.current);
      if (listGenRef.current !== gen) return; // a newer request was started — discard
      setMovies(data.items);
      setNextCursor(data.nextCursor);
      setHasMore(data.nextCursor !== null);
    } catch {
      if (listGenRef.current !== gen) return;
      setListError('Failed to load movies');
      setMovies([]);
      setHasMore(false);
    } finally {
      setIsLoadingList(false);
    }
  }, [_fetchPage]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!hasMore || !nextCursor) return;
    const gen = listGenRef.current; // snapshot — don't increment (not a reset)
    setIsLoadingList(true);
    try {
      const data = await _fetchPage(nextCursor, searchRef.current, filtersRef.current);
      if (listGenRef.current !== gen) return; // list was reset while loading — discard
      setMovies((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
      setHasMore(data.nextCursor !== null);
    } catch {
      if (listGenRef.current !== gen) return;
      setListError('Failed to load more movies');
    } finally {
      setIsLoadingList(false);
    }
  }, [hasMore, nextCursor, _fetchPage]);

  // ─── Search ────────────────────────────────────────────────────────────────

  const setSearch = useCallback(
    (term: string): void => {
      setSearchState(term);
      searchRef.current = term;

      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(async () => {
        const gen = ++listGenRef.current; // debounce fired — increment to supersede
        setIsLoadingList(true);
        setListError(null);
        try {
          const data = await _fetchPage(null, term, filtersRef.current);
          if (listGenRef.current !== gen) return;
          setMovies(data.items);
          setNextCursor(data.nextCursor);
          setHasMore(data.nextCursor !== null);
        } catch {
          if (listGenRef.current !== gen) return;
          setListError('Failed to load movies');
        } finally {
          setIsLoadingList(false);
        }
      }, SEARCH_DEBOUNCE_MS);
    },
    [_fetchPage],
  );

  // ─── Sort (013 US1) ──────────────────────────────────────────────────────────

  // Changing the sort restarts pagination at page 1 (the compound cursor is only valid for the
  // sort it was minted under) and preserves the active filter (FR-006/FR-007).
  const setSort = useCallback(
    async (field: MovieSortField, dir: SortDirection): Promise<void> => {
      sortByRef.current = field;
      sortDirRef.current = dir;
      setSortByState(field);
      setSortDirState(dir);

      const gen = ++listGenRef.current;
      setIsLoadingList(true);
      setListError(null);
      try {
        const data = await _fetchPage(null, searchRef.current, filtersRef.current);
        if (listGenRef.current !== gen) return;
        setMovies(data.items);
        setNextCursor(data.nextCursor);
        setHasMore(data.nextCursor !== null);
      } catch {
        if (listGenRef.current !== gen) return;
        setListError('Failed to load movies');
      } finally {
        setIsLoadingList(false);
      }
    },
    [_fetchPage],
  );

  // ─── Filters ───────────────────────────────────────────────────────────────

  const setFilter = useCallback(
    async <K extends keyof MovieListFilters>(key: K, value: MovieListFilters[K]): Promise<void> => {
      const newFilters = { ...filtersRef.current, [key]: value };
      filtersRef.current = newFilters;
      setFilters(newFilters);

      const gen = ++listGenRef.current;
      setIsLoadingList(true);
      setListError(null);
      try {
        const data = await _fetchPage(null, searchRef.current, newFilters);
        if (listGenRef.current !== gen) return;
        setMovies(data.items);
        setNextCursor(data.nextCursor);
        setHasMore(data.nextCursor !== null);
      } catch {
        if (listGenRef.current !== gen) return;
        setListError('Failed to load movies');
      } finally {
        setIsLoadingList(false);
      }
    },
    [_fetchPage],
  );

  const clearFilters = useCallback(async (): Promise<void> => {
    filtersRef.current = {};
    setFilters({});

    const gen = ++listGenRef.current;
    setIsLoadingList(true);
    setListError(null);
    try {
      const data = await _fetchPage(null, searchRef.current, {});
      if (listGenRef.current !== gen) return;
      setMovies(data.items);
      setNextCursor(data.nextCursor);
      setHasMore(data.nextCursor !== null);
    } catch {
      if (listGenRef.current !== gen) return;
      setListError('Failed to load movies');
    } finally {
      setIsLoadingList(false);
    }
  }, [_fetchPage]);

  // ─── Filter options ────────────────────────────────────────────────────────

  const fetchFilterOptions = useCallback(async (): Promise<void> => {
    setIsLoadingFilterOptions(true);
    try {
      const res = await apiClient.get(
        `/bff-api/collections/${collectionId}/movies/filter-options`,
      );
      setFilterOptions(res.data as FilterOptionsData);
    } catch {
      // Non-fatal: filter options are a UI enhancement
    } finally {
      setIsLoadingFilterOptions(false);
    }
  }, [collectionId]);

  // ─── Single-movie operations (US2) ────────────────────────────────────────

  const getMovie = useCallback(
    async (movieId: string): Promise<void> => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await apiClient.get(
          `/bff-api/collections/${collectionId}/movies/${movieId}`,
        );
        setMovie(res.data as Movie);
      } catch {
        setError('Failed to load movie');
      } finally {
        setIsLoading(false);
      }
    },
    [collectionId],
  );

  const createMovie = useCallback(
    async (req: CreateMovieRequest): Promise<void> => {
      setError(null);
      try {
        const res = await apiClient.post(
          `/bff-api/collections/${collectionId}/movies`,
          req,
        );
        setMovie(res.data as Movie);
      } catch (err) {
        const msg = extractErrorMessage(err, 'Failed to create movie');
        setError(msg);
        throw err;
      }
    },
    [collectionId],
  );

  const updateMovie = useCallback(
    async (movieId: string, req: CreateMovieRequest): Promise<void> => {
      setError(null);
      try {
        const res = await apiClient.put(
          `/bff-api/collections/${collectionId}/movies/${movieId}`,
          req,
        );
        setMovie(res.data as Movie);
      } catch (err) {
        const msg = extractErrorMessage(err, 'Failed to update movie');
        setError(msg);
        throw err;
      }
    },
    [collectionId],
  );

  const deleteMovie = useCallback(
    async (movieId: string): Promise<void> => {
      setError(null);
      try {
        await apiClient.delete(
          `/bff-api/collections/${collectionId}/movies/${movieId}`,
        );
        // Optimistic list removal — remove from movies list if present
        setMovies((prev) => prev.filter((m) => m.movieId !== movieId));
        // Clear the single-movie state if it matches the deleted movie
        setMovie((prev) => (prev?.movieId === movieId ? null : prev));
      } catch (err) {
        const msg = extractErrorMessage(err, 'Failed to delete movie');
        setError(msg);
        throw err;
      }
    },
    [collectionId],
  );

  // ─── Return ────────────────────────────────────────────────────────────────

  return {
    // Single-movie (US2)
    movie,
    isLoading,
    error,
    getMovie,
    createMovie,
    updateMovie,
    deleteMovie,

    // Movie list (US3)
    movies,
    isLoadingList,
    listError,
    hasMore,
    listMovies,
    loadMore,

    // Search
    search,
    setSearch,

    // Sort (013 US1)
    sortBy,
    sortDir,
    setSort,

    // Filters
    filters,
    setFilter,
    clearFilters,

    // Filter options
    filterOptions,
    isLoadingFilterOptions,
    fetchFilterOptions,
  };
}
