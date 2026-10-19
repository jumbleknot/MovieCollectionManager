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
import { render, fireEvent } from '@/test-support/render';
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

async function renderDetail(movie: Movie, overrides: Record<string, unknown> = {}) {
  const onEdit = jest.fn();
  const onDelete = jest.fn();

  const utils = await render(
    <MovieDetail movie={movie} onEdit={onEdit} onDelete={onDelete} {...overrides} />
  );
  return { ...utils, onEdit, onDelete };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MovieDetail', () => {
  describe('required fields', () => {
    it('renders movie title', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-title').props.children).toBe('The Matrix');
    });

    it('renders movie year', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-year').props.children).toBe(1999);
    });

    it('renders content type', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-content-type').props.children).toBe('Movie');
    });

    it('renders language', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-language').props.children).toBe('English');
    });

    it('renders a neutral language placeholder when language is absent — 014 US1', async () => {
      const { getByTestId } = await renderDetail({ ...MINIMAL_MOVIE, language: null });
      expect(getByTestId('movie-detail-language').props.children).toBe('—');
    });

    it('renders a neutral language placeholder when language is undefined — 014 US1', async () => {
      const noLang = { ...MINIMAL_MOVIE };
      delete (noLang as { language?: string | null }).language;
      const { getByTestId } = await renderDetail(noLang);
      expect(getByTestId('movie-detail-language').props.children).toBe('—');
    });

    it('renders owned status', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-owned')).toBeTruthy();
    });

    it('renders ripped status', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-ripped')).toBeTruthy();
    });

    it('renders childrens flag', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-childrens')).toBeTruthy();
    });
  });

  describe('optional fields — present', () => {
    it('renders genres when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-genres')).toBeTruthy();
    });

    it('renders rating when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-rated')).toBeTruthy();
    });

    it('renders directors when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-directors')).toBeTruthy();
    });

    it('renders actors when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-actors')).toBeTruthy();
    });

    it('renders runtime when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-runtime')).toBeTruthy();
    });

    it('renders releaseDate when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-release-date')).toBeTruthy();
    });

    it('renders outline when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-outline')).toBeTruthy();
    });

    it('renders plot when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-plot')).toBeTruthy();
    });

    it('renders originalTitle when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-original-title')).toBeTruthy();
    });

    it('renders movieSet when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-movie-set')).toBeTruthy();
    });

    it('renders tags when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-tags')).toBeTruthy();
    });

    it('renders externalIds when present', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-external-ids')).toBeTruthy();
    });

    it('renders a tappable URL link for external IDs that have a url', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      // FULL_MOVIE.externalIds[0] has url set
      expect(getByTestId('movie-detail-ext-id-url-0')).toBeTruthy();
    });

    it('does not render a link element when external ID has no url', async () => {
      const movie: Movie = {
        ...FULL_MOVIE,
        externalIds: [{ system: 'imdb', uniqueId: 'tt0000001', url: null }],
      };
      const { queryByTestId } = await renderDetail(movie);
      expect(queryByTestId('movie-detail-ext-id-url-0')).toBeNull();
    });

    it('renders ownedMedia when owned and ownedMedia non-empty', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-owned-media')).toBeTruthy();
    });

    it('renders ripQuality when ripped and ripQuality non-empty', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-rip-quality')).toBeTruthy();
    });

    it('shows correct ownedMedia values (Blu-Ray, UHD Blu-Ray)', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-owned-media').props.children).toBe('Blu-Ray, UHD Blu-Ray');
    });

    it('shows correct tags content', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-tags').props.children).toBe('cyberpunk, classic');
    });
  });

  describe('optional fields — absent', () => {
    it('does not crash when optional fields are null/empty', async () => {
      // RNTL 14: render is async, so a render-time throw surfaces as a rejection.
      await expect(renderDetail(MINIMAL_MOVIE)).resolves.toBeDefined();
    });

    it('does not render genres section when genres is empty', async () => {
      const { queryByTestId } = await renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-genres')).toBeNull();
    });

    it('does not render rating section when rated is null', async () => {
      const { queryByTestId } = await renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-rated')).toBeNull();
    });

    it('does not render runtime section when runtime is null', async () => {
      const { queryByTestId } = await renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-runtime')).toBeNull();
    });

    it('does not render plot section when plot is null', async () => {
      const { queryByTestId } = await renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-plot')).toBeNull();
    });

    it('does not render originalTitle section when originalTitle is null', async () => {
      const { queryByTestId } = await renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-original-title')).toBeNull();
    });

    it('does not render tags section when tags is empty', async () => {
      const { queryByTestId } = await renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-tags')).toBeNull();
    });

    it('does not render externalIds section when externalIds is empty', async () => {
      const { queryByTestId } = await renderDetail(MINIMAL_MOVIE);
      expect(queryByTestId('movie-detail-external-ids')).toBeNull();
    });
  });

  describe('action buttons', () => {
    it('shows Edit button', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-edit-button')).toBeTruthy();
    });

    it('shows Delete button', async () => {
      const { getByTestId } = await renderDetail(FULL_MOVIE);
      expect(getByTestId('movie-detail-delete-button')).toBeTruthy();
    });

    it('calls onEdit when Edit button is pressed', async () => {
      const { getByTestId, onEdit } = await renderDetail(FULL_MOVIE);
      await fireEvent.press(getByTestId('movie-detail-edit-button'));
      expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it('calls onDelete when Delete button is pressed', async () => {
      const { getByTestId, onDelete } = await renderDetail(FULL_MOVIE);
      await fireEvent.press(getByTestId('movie-detail-delete-button'));
      expect(onDelete).toHaveBeenCalledTimes(1);
    });
  });
});
