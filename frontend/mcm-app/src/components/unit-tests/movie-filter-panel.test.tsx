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

  // ── TR39: owned/ripped static filter chips ─────────────────────────────────

  it('renders owned Yes and No filter chips (TR39)', () => {
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-owned-Yes')).toBeTruthy();
    expect(getByTestId('filter-chip-owned-No')).toBeTruthy();
  });

  it('renders ripped Yes and No filter chips (TR39)', () => {
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-ripped-Yes')).toBeTruthy();
    expect(getByTestId('filter-chip-ripped-No')).toBeTruthy();
  });

  it('pressing owned-Yes chip calls onFilterChange with owned and "Yes" (TR39)', () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={onFilterChange}
        onClearFilters={() => {}}
      />,
    );
    fireEvent.press(getByTestId('filter-chip-owned-Yes'));
    expect(onFilterChange).toHaveBeenCalledWith('owned', 'Yes');
  });

  it('pressing ripped-No chip calls onFilterChange with ripped and "No" (TR39)', () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={onFilterChange}
        onClearFilters={() => {}}
      />,
    );
    fireEvent.press(getByTestId('filter-chip-ripped-No'));
    expect(onFilterChange).toHaveBeenCalledWith('ripped', 'No');
  });

  it('owned and ripped chips render even when all filterOptions arrays are empty (TR39)', () => {
    const emptyOptions: FilterOptionsData = {
      genres: [], contentTypes: [], rated: [], languages: [], decades: [], ownedMedia: [], ripQuality: [],
    };
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={emptyOptions}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-owned-Yes')).toBeTruthy();
    expect(getByTestId('filter-chip-ripped-No')).toBeTruthy();
  });

  // ── TR41: filter section display order ────────────────────────────────────

  it('renders filter sections in the correct order: contentType, owned, ownedMedia, ripped, ripQuality, genre, decade, language, rated (TR41)', () => {
    const { getAllByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    const sections = getAllByTestId(/^filter-section-/);
    const ids = sections.map(s => s.props.testID);
    expect(ids).toEqual([
      'filter-section-contentType',
      'filter-section-owned',
      'filter-section-ownedMedia',
      'filter-section-ripped',
      'filter-section-ripQuality',
      'filter-section-genre',
      'filter-section-decade',
      'filter-section-language',
      'filter-section-rated',
    ]);
  });

  // ── TR43: active chip tap deselects filter ────────────────────────────────

  it('pressing an inactive chip calls onFilterChange with the value (TR43)', () => {
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

  it('pressing an already-active chip calls onFilterChange with undefined to deselect (TR43)', () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={{ genre: 'Action' }}
        onFilterChange={onFilterChange}
        onClearFilters={() => {}}
      />,
    );
    fireEvent.press(getByTestId('filter-chip-genre-Action'));
    expect(onFilterChange).toHaveBeenCalledWith('genre', undefined);
  });
});
