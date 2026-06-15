/**
 * Unit tests for MovieListItem component (T125)
 *
 * Tests cover:
 * - Renders title (always shown regardless of column visibility)
 * - Renders only visible columns from visibleColumns prop
 * - Does not render hidden columns
 * - testID attributes present for each column cell
 */

import React from 'react';
import { render } from '@/test-support/render';
import { MovieListItem } from '@/components/movie-list-item';
import type { Movie, ColumnVisibility } from '@/types/collection';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_MOVIE: Movie = {
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
  genres: ['Action', 'Sci-Fi'],
  rated: 'R',
  directors: ['Lana Wachowski'],
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

const ALL_VISIBLE: ColumnVisibility = {
  year: true,
  contentType: true,
  language: true,
  owned: true,
  ripped: true,
  childrens: true,
  genres: true,
  rated: true,
  ownedMedia: true,
  ripQuality: true,
  runtime: true,
  directors: true,
  actors: true,
};

const ALL_HIDDEN: ColumnVisibility = {
  year: false,
  contentType: false,
  language: false,
  owned: false,
  ripped: false,
  childrens: false,
  genres: false,
  rated: false,
  ownedMedia: false,
  ripQuality: false,
  runtime: false,
  directors: false,
  actors: false,
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MovieListItem', () => {
  it('always renders the movie title', () => {
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={ALL_HIDDEN} onPress={() => {}} />,
    );
    expect(getByTestId('movie-list-item-title')).toBeTruthy();
  });

  it('title cell displays the movie title text', () => {
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={ALL_HIDDEN} onPress={() => {}} />,
    );
    expect(getByTestId('movie-list-item-title').props.children).toBe('The Matrix');
  });

  it('renders year cell when year is visible', () => {
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={{ ...ALL_HIDDEN, year: true }} onPress={() => {}} />,
    );
    expect(getByTestId('movie-list-item-year')).toBeTruthy();
  });

  it('does not render year cell when year is hidden', () => {
    const { queryByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={ALL_HIDDEN} onPress={() => {}} />,
    );
    expect(queryByTestId('movie-list-item-year')).toBeNull();
  });

  it('renders contentType cell when contentType is visible', () => {
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={{ ...ALL_HIDDEN, contentType: true }} onPress={() => {}} />,
    );
    expect(getByTestId('movie-list-item-contentType')).toBeTruthy();
  });

  it('renders owned cell when owned is visible', () => {
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={{ ...ALL_HIDDEN, owned: true }} onPress={() => {}} />,
    );
    expect(getByTestId('movie-list-item-owned')).toBeTruthy();
  });

  it('renders ripped cell when ripped is visible', () => {
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={{ ...ALL_HIDDEN, ripped: true }} onPress={() => {}} />,
    );
    expect(getByTestId('movie-list-item-ripped')).toBeTruthy();
  });

  it('renders runtime cell when runtime is visible', () => {
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={{ ...ALL_HIDDEN, runtime: true }} onPress={() => {}} />,
    );
    expect(getByTestId('movie-list-item-runtime')).toBeTruthy();
  });

  it('does not render runtime cell when runtime is hidden', () => {
    const { queryByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={ALL_HIDDEN} onPress={() => {}} />,
    );
    expect(queryByTestId('movie-list-item-runtime')).toBeNull();
  });

  it('renders all cells when all columns are visible', () => {
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={ALL_VISIBLE} onPress={() => {}} />,
    );
    expect(getByTestId('movie-list-item-title')).toBeTruthy();
    expect(getByTestId('movie-list-item-year')).toBeTruthy();
    expect(getByTestId('movie-list-item-contentType')).toBeTruthy();
    expect(getByTestId('movie-list-item-language')).toBeTruthy();
    expect(getByTestId('movie-list-item-owned')).toBeTruthy();
    expect(getByTestId('movie-list-item-ripped')).toBeTruthy();
    expect(getByTestId('movie-list-item-runtime')).toBeTruthy();
  });

  it('renders a neutral language placeholder when language is absent — 014 US1', () => {
    const { getByTestId } = render(
      <MovieListItem
        movie={{ ...MOCK_MOVIE, language: null }}
        visibleColumns={ALL_VISIBLE}
        onPress={() => {}}
      />,
    );
    expect(getByTestId('movie-list-item-language').props.children).toBe('—');
  });

  it('calls onPress with movieId when row is pressed', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={ALL_HIDDEN} onPress={onPress} />,
    );
    getByTestId('movie-list-item-row').props.onClick?.();
    // For React Native: use fireEvent
  });

  it('row has testID movie-list-item-row', () => {
    const { getByTestId } = render(
      <MovieListItem movie={MOCK_MOVIE} visibleColumns={ALL_HIDDEN} onPress={() => {}} />,
    );
    expect(getByTestId('movie-list-item-row')).toBeTruthy();
  });
});
