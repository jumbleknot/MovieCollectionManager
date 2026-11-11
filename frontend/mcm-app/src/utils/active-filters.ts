/**
 * Active-filter count (098, data-model ActiveFilterCount).
 *
 * A filter is active when its value is set: not `undefined` and not the empty string. `false` IS
 * active ("Owned: No"). This is the single predicate behind both MovieFilterPanel's "Clear" button
 * and the view-options badge, so the two cannot disagree.
 */
import type { MovieListFilters } from '@/types/collection';

export function isActiveFilterValue(v: unknown): boolean {
  return v !== undefined && v !== '';
}

export function countActiveFilters(filters: MovieListFilters): number {
  return Object.values(filters).filter(isActiveFilterValue).length;
}
