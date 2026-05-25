/**
 * Unit tests for MovieDetail component (T101)
 *
 * Tests cover:
 * - Renders all required Movie fields (title, year, contentType, language)
 * - Renders boolean flags (owned, ripped, childrens)
 * - Renders optional fields when present (genres, rated, directors, actors, runtime,
 *   releaseDate, outline, plot, originalTitle, movieSet, tags, externalIds)
 * - Does not crash when optional fields are null/empty
 * - Shows Edit button
 * - Shows Delete button
 * - Edit button calls onEdit callback
 * - Delete button calls onDelete callback
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { MovieDetail } from '@/components/movie-detail';
import type { Movie } from '@/types/collection';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const FULL_MOVIE: Movie = {
  movieId: 'mov-1',
  collectionId: 'col-1',
  title: 'The Matrix',
  year: 1999,
  contentType: 'Movie',
  language: 'English',
  owned: true,
  ripped: true,
  childrens: false,
  ownedMedia: ['Blu-Ray', 'UHD Blu-Ray'],
  ripQuality: ['Blu-Ray'],
  genres: ['Action', 'Sci-Fi'],
  rated: 'R',
  directors: ['Lana Wachowski', 'Lilly Wachowski'],
  actors: ['Keanu Reeves', 'Laurence Fishburne'],
  tags: ['cyberpunk', 'classic'],
  movieSet: 'The Matrix Collection',
  originalTitle: 'Matrix, The',
  releaseDate: '1999-03-31',
  outline: 'A hacker discovers the world is a simulation.',
  plot: 'Neo is a hacker who discovers that reality is a simulation controlled by machines.',
  runtime: 136,
  externalIds: [{ system: 'imdb', uniqueId: 'tt0133093', url: 'https://imdb.com/title/tt0133093' }],
  createdAt: '2026-05-23T00:00:00.000Z',
  updatedAt: '2026-05-23T00:00:00.000Z',
};

const MINIMAL_MOVIE: Movie = {
  movieId: 'mov-2',
  collectionId: 'col-1',
  title: 'Unknown Film',
  year: 2000,
  contentType: 'Movie',
  language: 'English',
  owned: false,
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

// ─── Helper ────────────────────────────────────────────────────────────────────

function renderDetail(movie: Movie, overrides: Record<string, unknown> = {}) {
  const onEdit = jest.fn();
  const onDelete = jest.fn();

  const utils = render(
    <MovieDetail movie={movie} onEdit={onEdit} onDelete={onDelete} {...overrides} />
  );
  return { ...utils, onEdit, onDelete };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MovieDetail', () => {
  describe('required fields', () => {
    it('renders movie title', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-title').props.children).toBe('The Matrix');
    });

    it('renders movie year', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-year').props.children).toBe(1999);
    });

    it('renders content type', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-content-type').props.children).toBe('Movie');
    });

    it('renders language', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-language').props.children).toBe('English');
    });

    it('renders owned status', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-owned')).toBeTruthy();
    });

    it('renders ripped status', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-ripped')).toBeTruthy();
    });

    it('renders childrens flag', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-childrens')).toBeTruthy();
    });
  });

  describe('optional fields — present', () => {
    it('renders genres when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-genres')).toBeTruthy();
    });

    it('renders rating when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-rated')).toBeTruthy();
    });

    it('renders directors when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-directors')).toBeTruthy();
    });

    it('renders actors when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-actors')).toBeTruthy();
    });

    it('renders runtime when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-runtime')).toBeTruthy();
    });

    it('renders releaseDate when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-release-date')).toBeTruthy();
    });

    it('renders outline when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-outline')).toBeTruthy();
    });

    it('renders plot when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-plot')).toBeTruthy();
    });

    it('renders originalTitle when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-original-title')).toBeTruthy();
    });

    it('renders movieSet when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-movie-set')).toBeTruthy();
    });

    it('renders tags when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-tags')).toBeTruthy();
    });

    it('renders externalIds when present', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-external-ids')).toBeTruthy();
    });

    it('renders ownedMedia when owned and ownedMedia non-empty', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-owned-media')).toBeTruthy();
    });

    it('renders ripQuality when ripped and ripQuality non-empty', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-rip-quality')).toBeTruthy();
    });

    it('shows correct ownedMedia values (Blu-Ray, UHD Blu-Ray)', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-owned-media').props.children).toBe('Blu-Ray, UHD Blu-Ray');
    });

    it('shows correct tags content', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-tags').props.children).toBe('cyberpunk, classic');
    });
  });

  describe('optional fields — absent', () => {
    it('does not crash when optional fields are null/empty', () => {
      expect(() => renderDetail(MINIMAL_MOVIE)).not.toThrow();
    });

    it('does not render genres section when genres is empty', () => {
      const { queryByTestId } = renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-genres')).toBeNull();
    });

    it('does not render rating section when rated is null', () => {
      const { queryByTestId } = renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-rated')).toBeNull();
    });

    it('does not render runtime section when runtime is null', () => {
      const { queryByTestId } = renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-runtime')).toBeNull();
    });

    it('does not render plot section when plot is null', () => {
      const { queryByTestId } = renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-plot')).toBeNull();
    });

    it('does not render originalTitle section when originalTitle is null', () => {
      const { queryByTestId } = renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-original-title')).toBeNull();
    });

    it('does not render tags section when tags is empty', () => {
      const { queryByTestId } = renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-tags')).toBeNull();
    });

    it('does not render externalIds section when externalIds is empty', () => {
      const { queryByTestId } = renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-external-ids')).toBeNull();
    });
  });

  describe('action buttons', () => {
    it('shows Edit button', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-edit-button')).toBeTruthy();
    });

    it('shows Delete button', () => {
      const { getByTestId } = renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-delete-button')).toBeTruthy();
    });

    it('calls onEdit when Edit button is pressed', () => {
      const { getByTestId, onEdit } = renderDetail(FULL_MOVIE);
      fireEvent.press(getByTestId('movie-detail-edit-button'));
      expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it('calls onDelete when Delete button is pressed', () => {
      const { getByTestId, onDelete } = renderDetail(FULL_MOVIE);
      fireEvent.press(getByTestId('movie-detail-delete-button'));
      expect(onDelete).toHaveBeenCalledTimes(1);
    });
  });
});
