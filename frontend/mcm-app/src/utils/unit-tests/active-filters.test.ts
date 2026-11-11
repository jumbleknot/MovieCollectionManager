/**
 * countActiveFilters (098 T003, data-model ActiveFilterCount).
 *
 * Drives the view-options badge and its accessibility label (FR-008, FR-016). It must use the SAME
 * predicate as MovieFilterPanel's "Clear" visibility, so the badge and the panel cannot disagree.
 */
import { countActiveFilters } from '@/utils/active-filters';
import type { MovieListFilters } from '@/types/collection';

describe('countActiveFilters', () => {
  it('is 0 for no filters', () => {
    expect(countActiveFilters({})).toBe(0);
  });

  it('counts one set filter', () => {
    expect(countActiveFilters({ genre: 'Drama' })).toBe(1);
  });

  it('counts a false boolean as an active filter', () => {
    expect(countActiveFilters({ owned: false })).toBe(1);
  });

  it('ignores empty strings and explicit undefined', () => {
    expect(countActiveFilters({ genre: '', rated: undefined })).toBe(0);
  });

  it('counts every key when all are set', () => {
    const all: Required<MovieListFilters> = {
      contentType: 'Movie',
      genre: 'Drama',
      childrens: false,
      rated: 'PG',
      language: 'English',
      decade: 1990,
      owned: true,
      ownedMedia: 'Blu-ray',
      ripped: false,
      ripQuality: '1080p',
    };
    expect(countActiveFilters(all)).toBe(Object.keys(all).length);
  });
});
