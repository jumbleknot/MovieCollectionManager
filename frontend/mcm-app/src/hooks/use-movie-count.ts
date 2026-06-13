/**
 * useMovieCount hook (013 US2 / T025)
 *
 * Fetches the movie count for the collection's info line (FR-008/FR-009):
 *   - filtered → count WITH the active filter/search params (the numerator)
 *   - total    → when a filter is active, a second count with NO params (the denominator);
 *                when unfiltered, the single result is reused as the total.
 *
 * Auto-refreshes when the filter/search inputs change, and exposes refreshCount() for the
 * screen to call on focus (add/edit/delete) and on an approved assistant write
 * (useAssistantDataRefresh) — the same triggers the list uses.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { apiClient } from '@/bff-server/api-client';
import type { MovieListFilters, MovieCountLine, MovieCountResponse } from '@/types/collection';

function hasActiveFilter(filters: MovieListFilters, search: string): boolean {
  if (search.trim()) return true;
  return Object.values(filters).some((v) => v !== undefined && v !== null && v !== '');
}

function buildParams(filters: MovieListFilters, search: string): Record<string, unknown> {
  const params: Record<string, unknown> = { ...filters };
  if (search) params.search = search;
  return params;
}

export interface UseMovieCountReturn {
  count: MovieCountLine;
  refreshCount: () => Promise<void>;
}

export function useMovieCount(
  collectionId: string,
  filters: MovieListFilters,
  search: string,
): UseMovieCountReturn {
  const [count, setCount] = useState<MovieCountLine>({ filtered: 0, total: 0, isFiltered: false });

  // Refs for stable access inside the refresh callback (it is called from focus/assistant
  // triggers that should always read the latest filter/search, not a captured snapshot).
  // Synced in an effect (not during render) so refreshCount keeps a stable identity.
  const filtersRef = useRef(filters);
  const searchRef = useRef(search);
  useEffect(() => {
    filtersRef.current = filters;
    searchRef.current = search;
  });

  // Supersede stale in-flight responses (the second total call makes this two round-trips).
  const genRef = useRef(0);

  const refreshCount = useCallback(async (): Promise<void> => {
    const f = filtersRef.current;
    const s = searchRef.current;
    const isFiltered = hasActiveFilter(f, s);
    const gen = ++genRef.current;
    const base = `/bff-api/collections/${collectionId}/movies/count`;
    try {
      const filteredRes = await apiClient.get(base, { params: buildParams(f, s) });
      const filtered = (filteredRes.data as MovieCountResponse).count;
      let total = filtered;
      if (isFiltered) {
        const totalRes = await apiClient.get(base);
        total = (totalRes.data as MovieCountResponse).count;
      }
      if (genRef.current !== gen) return; // a newer refresh superseded this one
      setCount({ filtered, total, isFiltered });
    } catch {
      // Non-fatal: the count line is a UI enhancement; keep the previous value.
    }
  }, [collectionId]);

  // Re-fetch whenever the filter/search inputs change.
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    void refreshCount();
    // refreshCount is stable per collectionId; filterKey/search drive re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId, search, filterKey]);

  return { count, refreshCount };
}
