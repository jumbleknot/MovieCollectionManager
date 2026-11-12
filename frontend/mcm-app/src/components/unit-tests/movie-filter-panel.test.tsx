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
import { render, fireEvent } from '@/test-support/render';
import { ClearFiltersButton, MovieFilterPanel } from '@/components/movie-filter-panel';
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
  it('renders the filter panel container', async () => {
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('movie-filter-panel')).toBeTruthy();
  });

  it('renders genre filter chips from filterOptions', async () => {
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-genre-Action')).toBeTruthy();
    expect(getByTestId('filter-chip-genre-Drama')).toBeTruthy();
  });

  it('renders contentType filter chips from filterOptions', async () => {
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-contentType-Movie')).toBeTruthy();
    expect(getByTestId('filter-chip-contentType-Series')).toBeTruthy();
  });

  it('renders language filter chips from filterOptions', async () => {
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-language-English')).toBeTruthy();
    expect(getByTestId('filter-chip-language-French')).toBeTruthy();
  });

  it('renders decade filter chips from filterOptions', async () => {
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-decade-1990')).toBeTruthy();
    expect(getByTestId('filter-chip-decade-2000')).toBeTruthy();
  });

  it('only shows options present in filterOptions (no hardcoded values)', async () => {
    const limitedOptions: FilterOptionsData = {
      ...FILTER_OPTIONS,
      genres: ['Action'], // Only Action, no Drama
    };
    const { getByTestId, queryByTestId } = await render(
      <MovieFilterPanel
        filterOptions={limitedOptions}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-genre-Action')).toBeTruthy();
    expect(queryByTestId('filter-chip-genre-Drama')).toBeNull();
  });

  it('calls onFilterChange with genre key and value when genre chip is pressed', async () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={onFilterChange}
      />,
    );
    await fireEvent.press(getByTestId('filter-chip-genre-Action'));
    expect(onFilterChange).toHaveBeenCalledWith('genre', 'Action');
  });

  it('calls onFilterChange with contentType key and value when contentType chip is pressed', async () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={onFilterChange}
      />,
    );
    await fireEvent.press(getByTestId('filter-chip-contentType-Series'));
    expect(onFilterChange).toHaveBeenCalledWith('contentType', 'Series');
  });

  it('ClearFiltersButton calls onPress (099 FR-004 — it now lives in the pane header)', async () => {
    const onPress = jest.fn();
    const { getByTestId } = await render(<ClearFiltersButton onPress={onPress} />);
    expect(getByTestId('filter-clear-button').props.accessibilityLabel).toBe('Clear all filters');
    await fireEvent.press(getByTestId('filter-clear-button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not render the clear button itself, even with an active filter (099 FR-004)', async () => {
    const { queryByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={{ genre: 'Action' }}
        onFilterChange={() => {}}
      />,
    );
    expect(queryByTestId('filter-clear-button')).toBeNull();
  });

  it('has no height cap of its own (099 FR-002)', async () => {
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    const style = Object.assign(
      {},
      ...[getByTestId('movie-filter-panel').props.style].flat(Infinity),
    );
    expect(style.maxHeight).toBeUndefined();
  });

  it("wraps each category's chips instead of scrolling sideways (099 FR-003)", async () => {
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    const chips = getByTestId('filter-chips-genre');
    expect(chips.props.horizontal).toBeFalsy();
    const style = Object.assign({}, ...[chips.props.style].flat(Infinity));
    expect(style.flexWrap).toBe('wrap');
  });

  it('renders with empty filterOptions without crashing', async () => {
    const emptyOptions: FilterOptionsData = {
      genres: [],
      contentTypes: [],
      rated: [],
      languages: [],
      decades: [],
      ownedMedia: [],
      ripQuality: [],
    };
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={emptyOptions}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('movie-filter-panel')).toBeTruthy();
  });

  // ── TR39: owned/ripped static filter chips ─────────────────────────────────

  it('renders owned Yes and No filter chips (TR39)', async () => {
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-owned-Yes')).toBeTruthy();
    expect(getByTestId('filter-chip-owned-No')).toBeTruthy();
  });

  it('renders ripped Yes and No filter chips (TR39)', async () => {
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-ripped-Yes')).toBeTruthy();
    expect(getByTestId('filter-chip-ripped-No')).toBeTruthy();
  });

  it('pressing owned-Yes chip calls onFilterChange with owned and "Yes" (TR39)', async () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={onFilterChange}
      />,
    );
    await fireEvent.press(getByTestId('filter-chip-owned-Yes'));
    expect(onFilterChange).toHaveBeenCalledWith('owned', 'Yes');
  });

  it('pressing ripped-No chip calls onFilterChange with ripped and "No" (TR39)', async () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={onFilterChange}
      />,
    );
    await fireEvent.press(getByTestId('filter-chip-ripped-No'));
    expect(onFilterChange).toHaveBeenCalledWith('ripped', 'No');
  });

  it('owned and ripped chips render even when all filterOptions arrays are empty (TR39)', async () => {
    const emptyOptions: FilterOptionsData = {
      genres: [],
      contentTypes: [],
      rated: [],
      languages: [],
      decades: [],
      ownedMedia: [],
      ripQuality: [],
    };
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={emptyOptions}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    expect(getByTestId('filter-chip-owned-Yes')).toBeTruthy();
    expect(getByTestId('filter-chip-ripped-No')).toBeTruthy();
  });

  // ── TR41: filter section display order ────────────────────────────────────

  it('renders filter sections in the correct order: contentType, owned, ownedMedia, ripped, ripQuality, genre, decade, language, rated (TR41)', async () => {
    const { getAllByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={() => {}}
      />,
    );
    const sections = getAllByTestId(/^filter-section-/);
    const ids = sections.map((s) => s.props.testID);
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

  it('pressing an inactive chip calls onFilterChange with the value (TR43)', async () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={NO_ACTIVE_FILTERS}
        onFilterChange={onFilterChange}
      />,
    );
    await fireEvent.press(getByTestId('filter-chip-genre-Action'));
    expect(onFilterChange).toHaveBeenCalledWith('genre', 'Action');
  });

  it('pressing an already-active chip calls onFilterChange with undefined to deselect (TR43)', async () => {
    const onFilterChange = jest.fn();
    const { getByTestId } = await render(
      <MovieFilterPanel
        filterOptions={FILTER_OPTIONS}
        activeFilters={{ genre: 'Action' }}
        onFilterChange={onFilterChange}
      />,
    );
    await fireEvent.press(getByTestId('filter-chip-genre-Action'));
    expect(onFilterChange).toHaveBeenCalledWith('genre', undefined);
  });
});
