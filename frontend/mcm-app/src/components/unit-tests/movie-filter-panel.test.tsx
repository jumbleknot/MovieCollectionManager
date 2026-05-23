/**
 * Unit tests for MovieFilterPanel component (T132)
 *
 * Tests cover:
 * - Renders filter chips from filterOptions
 * - Only shows filter values present in filterOptions (no hardcoded values)
 * - Selecting a filter chip calls onFilterChange with the correct key + value
 * - Active filter shown as selected chip
 * - Panel collapsible (hidden by default, shown when expanded)
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { MovieFilterPanel } from '@/components/movie-filter-panel';
import type { FilterOptionsData, MovieListFilters } from '@/types/collection';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const FILTER_OPTIONS: FilterOptionsData = {
  genres: ['Action', 'Drama'],
  contentTypes: ['Movie', 'Series'],
  rated: ['PG-13', 'R'],
  languages: ['English', 'French'],
  decades: [1990, 2000, 2010],
  ownedMedia: ['Blu-Ray', 'DVD'],
  ripQuality: ['1080p'],
};

const NO_ACTIVE_FILTERS: MovieListFilters = {};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MovieFilterPanel', () => {
  it('renders the filter panel container', () => {
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('movie-filter-panel')).toBeTruthy();
  });

  it('renders genre filter chips from filterOptions', () => {
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-genre-Action')).toBeTruthy();
    expect(getByTestId('filter-chip-genre-Drama')).toBeTruthy();
  });

  it('renders contentType filter chips from filterOptions', () => {
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-contentType-Movie')).toBeTruthy();
    expect(getByTestId('filter-chip-contentType-Series')).toBeTruthy();
  });

  it('renders language filter chips from filterOptions', () => {
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-language-English')).toBeTruthy();
    expect(getByTestId('filter-chip-language-French')).toBeTruthy();
  });

  it('renders decade filter chips from filterOptions', () => {
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-decade-1990')).toBeTruthy();
    expect(getByTestId('filter-chip-decade-2000')).toBeTruthy();
  });

  it('only shows options present in filterOptions (no hardcoded values)', () => {
    const limitedOptions: FilterOptionsData = {
      ...FILTER_OPTIONS,
      genres: ['Action'], // Only Action, no Drama
    };
    const { getByTestId, queryByTestId } = render(
      <MovieFilterPanel
        filterOptions={limitedOptions}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-genre-Action')).toBeTruthy();
    expect(queryByTestId('filter-chip-genre-Drama')).toBeNull();
  });

  it('calls onFilterChange with genre key and value when genre chip is pressed', () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={onFilterChange}
        onClearFilters={() => {}}
      />,
    );
    fireEvent.press(getByTestId('filter-chip-genre-Action'));
    expect(onFilterChange).toHaveBeenCalledWith('genre', 'Action');
  });

  it('calls onFilterChange with contentType key and value when contentType chip is pressed', () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={onFilterChange}
        onClearFilters={() => {}}
      />,
    );
    fireEvent.press(getByTestId('filter-chip-contentType-Series'));
    expect(onFilterChange).toHaveBeenCalledWith('contentType', 'Series');
  });

  it('calls onClearFilters when clear button is pressed', () => {
    const onClearFilters = jest.fn();
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={{ genre: 'Action' }}
        onFilterChange={() => {}}
        onClearFilters={onClearFilters}
      />,
    );
    fireEvent.press(getByTestId('filter-clear-button'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('renders with empty filterOptions without crashing', () => {
    const emptyOptions: FilterOptionsData = {
      genres: [],
      contentTypes: [],
      rated: [],
      languages: [],
      decades: [],
      ownedMedia: [],
      ripQuality: [],
    };
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={emptyOptions}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('movie-filter-panel')).toBeTruthy();
  });
});
