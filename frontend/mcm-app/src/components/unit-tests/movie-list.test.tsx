/**
 * Unit tests for MovieList component (T127a)
 *
 * Tests cover:
 * - Renders a column header row with labels matching visible columns
 * - Shows header even when the list is empty
 * - Renders MovieListItem rows from items prop
 * - Shows empty state message when items is empty
 * - Triggers onLoadMore callback when scrolled to end (onEndReached)
 */

import React from 'react';
import { render, fireEvent } from '@/test-support/render';
import { MovieList } from '@/components/movie-list';
import type { Movie, ColumnVisibility } from '@/types/collection';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

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

function makeMovie(id: string, title: string): Movie {
  return {
    movieId: id,
    collectionId: 'col-1',
    title,
    year: 2000,
    contentType: 'Movie',
    language: 'English',
    owned: true,
    ripped: false,
    childrens: false,
    ownedMedia: [],
    ripQuality: [],
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
    runtime: null,
    externalIds: [],
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
  };
}

const MOVIES = [
  makeMovie('mov-1', 'The Matrix'),
  makeMovie('mov-2', 'Inception'),
  makeMovie('mov-3', 'Interstellar'),
];

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MovieList', () => {
  describe('column header', () => {
    it('renders the header row', () => {
      const { getByTestId } = render(
        <MovieList
          items={MOVIES}
          visibleColumns={VISIBLE_COLS}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          onMoviePress={() => {}}
        />,
      );
      expect(getByTestId('movie-list-header')).toBeTruthy();
    });

    // NOTE: feature 015 split this into a web data table (movie-list.tsx, with
    // per-column Outfit headers) and a native card list (movie-list.native.tsx,
    // a slim "Movies" section header). jest-expo resolves the NATIVE variant, so
    // these tests assert the native header contract; the web column-header labels
    // (Year/Type/Own/Rip + primary bottom-border) are covered by the web E2E
    // (movies.spec.ts asserts movie-list-header) + manual visual review.
    it('renders a section header (movie-list-header present)', () => {
      const { getByTestId } = render(
        <MovieList
          items={MOVIES}
          visibleColumns={VISIBLE_COLS}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          onMoviePress={() => {}}
        />,
      );
      expect(getByTestId('movie-list-header')).toBeTruthy();
    });

    it('renders header even when the list is empty', () => {
      const { getByTestId } = render(
        <MovieList
          items={[]}
          visibleColumns={VISIBLE_COLS}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          onMoviePress={() => {}}
        />,
      );
      expect(getByTestId('movie-list-header')).toBeTruthy();
    });
  });

  it('renders a row for each movie in items', () => {
    const { getAllByTestId } = render(
      <MovieList
        items={MOVIES}
        visibleColumns={VISIBLE_COLS}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        onMoviePress={() => {}}
      />,
    );
    const rows = getAllByTestId('movie-list-item-row');
    expect(rows).toHaveLength(3);
  });

  it('renders movie titles in each row', () => {
    const { getAllByTestId } = render(
      <MovieList
        items={MOVIES}
        visibleColumns={VISIBLE_COLS}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        onMoviePress={() => {}}
      />,
    );
    const titles = getAllByTestId('movie-list-item-title');
    expect(titles[0].props.children).toBe('The Matrix');
    expect(titles[1].props.children).toBe('Inception');
  });

  it('shows empty state when items is empty', () => {
    const { getByTestId } = render(
      <MovieList
        items={[]}
        visibleColumns={VISIBLE_COLS}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        onMoviePress={() => {}}
      />,
    );
    expect(getByTestId('movie-list-empty')).toBeTruthy();
  });

  it('does not show empty state when items is non-empty', () => {
    const { queryByTestId } = render(
      <MovieList
        items={MOVIES}
        visibleColumns={VISIBLE_COLS}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        onMoviePress={() => {}}
      />,
    );
    expect(queryByTestId('movie-list-empty')).toBeNull();
  });

  it('calls onLoadMore when scrolled to end (onEndReached)', () => {
    const onLoadMore = jest.fn();
    const { getByTestId } = render(
      <MovieList
        items={MOVIES}
        visibleColumns={VISIBLE_COLS}
        hasMore={true}
        isLoadingMore={false}
        onLoadMore={onLoadMore}
        onMoviePress={() => {}}
      />,
    );
    const list = getByTestId('movie-list-container');
    // Simulate FlatList onEndReached
    list.props.onEndReached?.();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does not call onLoadMore when hasMore is false', () => {
    const onLoadMore = jest.fn();
    const { getByTestId } = render(
      <MovieList
        items={MOVIES}
        visibleColumns={VISIBLE_COLS}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={onLoadMore}
        onMoviePress={() => {}}
      />,
    );
    const list = getByTestId('movie-list-container');
    list.props.onEndReached?.();
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('calls onMoviePress with movieId when a row is pressed', () => {
    const onMoviePress = jest.fn();
    const { getAllByTestId } = render(
      <MovieList
        items={MOVIES}
        visibleColumns={VISIBLE_COLS}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        onMoviePress={onMoviePress}
      />,
    );
    fireEvent.press(getAllByTestId('movie-list-item-row')[0]);
    expect(onMoviePress).toHaveBeenCalledWith('mov-1');
  });
});
