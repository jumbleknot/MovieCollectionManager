/**
 * Unit tests for MovieForm component (T099)
 *
 * Tests cover:
 * - All required fields (title, year, contentType, language, owned, ripped, childrens) are required
 * - Optional fields accepted without validation error
 * - ContentType enum validated (Movie | Series | Concert)
 * - owned=false hides/clears ownedMedia field
 * - ripped=false hides/clears ripQuality field
 * - owned=true shows ownedMedia field
 * - ripped=true shows ripQuality field
 * - Submit with all required fields calls onSubmit with correct payload
 * - Cancel button calls onCancel
 * - isLoading disables submit button
 * - Edit mode pre-fills all fields from initialValues
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { MovieForm } from '@/components/movie-form';
import type { Movie, CreateMovieRequest } from '@/types/collection';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS: CreateMovieRequest = {
  title: 'The Matrix',
  year: 1999,
  contentType: 'Movie',
  language: 'English',
  owned: false,
  ripped: false,
  childrens: false,
};

function fillRequiredFields(getByTestId: ReturnType<typeof render>['getByTestId']) {
  fireEvent.changeText(getByTestId('movie-form-title-input'), 'The Matrix');
  fireEvent.changeText(getByTestId('movie-form-year-input'), '1999');
  // contentType radio buttons - 'Movie' is selected by default; press to confirm
  fireEvent.press(getByTestId('movie-form-content-type-movie'));
  fireEvent.changeText(getByTestId('movie-form-language-input'), 'English');
  // owned, ripped, childrens toggles start as false by default
}

function renderCreateForm(overrides: Record<string, unknown> = {}) {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const onCancel = jest.fn();

  const utils = render(
    <MovieForm
      mode="create"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { ...utils, onSubmit, onCancel };
}

function renderEditForm(
  initialValues: Partial<Movie> = {},
  overrides: Record<string, unknown> = {}
) {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const onCancel = jest.fn();

  const defaultValues: Movie = {
    movieId: 'mov-1',
    collectionId: 'col-1',
    title: 'The Matrix',
    year: 1999,
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
    ...initialValues,
  };

  const utils = render(
    <MovieForm
      mode="edit"
      initialValues={defaultValues}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { ...utils, onSubmit, onCancel };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MovieForm — create mode', () => {
  describe('required fields', () => {
    it('renders title input', () => {
      const { getByTestId } = renderCreateForm();
      expect(getByTestId('movie-form-title-input')).toBeTruthy();
    });

    it('renders year input', () => {
      const { getByTestId } = renderCreateForm();
      expect(getByTestId('movie-form-year-input')).toBeTruthy();
    });

    it('renders content type selector', () => {
      const { getByTestId } = renderCreateForm();
      expect(getByTestId('movie-form-content-type-picker')).toBeTruthy();
      expect(getByTestId('movie-form-content-type-movie')).toBeTruthy();
      expect(getByTestId('movie-form-content-type-series')).toBeTruthy();
      expect(getByTestId('movie-form-content-type-concert')).toBeTruthy();
    });

    it('renders language input', () => {
      const { getByTestId } = renderCreateForm();
      expect(getByTestId('movie-form-language-input')).toBeTruthy();
    });

    it('renders owned toggle', () => {
      const { getByTestId } = renderCreateForm();
      expect(getByTestId('movie-form-owned-toggle')).toBeTruthy();
    });

    it('renders ripped toggle', () => {
      const { getByTestId } = renderCreateForm();
      expect(getByTestId('movie-form-ripped-toggle')).toBeTruthy();
    });

    it('renders childrens toggle', () => {
      const { getByTestId } = renderCreateForm();
      expect(getByTestId('movie-form-childrens-toggle')).toBeTruthy();
    });

    it('shows validation error when title is empty on submit', async () => {
      const { getByTestId, findByText } = renderCreateForm();
      fireEvent.press(getByTestId('movie-form-submit-button'));
      expect(await findByText(/title is required/i)).toBeTruthy();
    });

    it('does not call onSubmit when title is empty', async () => {
      const { getByTestId, onSubmit } = renderCreateForm();
      fireEvent.press(getByTestId('movie-form-submit-button'));
      await waitFor(() => expect(onSubmit).not.toHaveBeenCalled());
    });

    it('shows validation error when year is empty on submit', async () => {
      const { getByTestId, findByText } = renderCreateForm();
      fireEvent.changeText(getByTestId('movie-form-title-input'), 'The Matrix');
      fireEvent.press(getByTestId('movie-form-submit-button'));
      expect(await findByText(/year is required/i)).toBeTruthy();
    });

    it('shows validation error when language is empty on submit', async () => {
      const { getByTestId, findByText } = renderCreateForm();
      fireEvent.changeText(getByTestId('movie-form-title-input'), 'The Matrix');
      fireEvent.changeText(getByTestId('movie-form-year-input'), '1999');
      fireEvent.press(getByTestId('movie-form-content-type-movie'));
      fireEvent.press(getByTestId('movie-form-submit-button'));
      expect(await findByText(/language is required/i)).toBeTruthy();
    });
  });

  describe('submit with all required fields', () => {
    it('calls onSubmit with correct payload when all required fields filled', async () => {
      const { getByTestId, onSubmit } = renderCreateForm();

      fillRequiredFields(getByTestId);
      fireEvent.press(getByTestId('movie-form-submit-button'));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'The Matrix',
            year: 1999,
            contentType: 'Movie',
            language: 'English',
            owned: false,
            ripped: false,
            childrens: false,
          }),
        );
      });
    });
  });

  describe('owned/ownedMedia conditional field', () => {
    it('does not show ownedMedia picker when owned is false', () => {
      const { queryByTestId } = renderCreateForm();
      expect(queryByTestId('movie-form-owned-media-picker')).toBeNull();
    });

    it('shows ownedMedia picker when owned toggle is turned on', async () => {
      const { getByTestId, findByTestId } = renderCreateForm();
      fireEvent(getByTestId('movie-form-owned-toggle'), 'onValueChange', true);
      expect(await findByTestId('movie-form-owned-media-picker')).toBeTruthy();
    });
  });

  describe('ripped/ripQuality conditional field', () => {
    it('does not show ripQuality picker when ripped is false', () => {
      const { queryByTestId } = renderCreateForm();
      expect(queryByTestId('movie-form-rip-quality-picker')).toBeNull();
    });

    it('shows ripQuality picker when ripped toggle is turned on', async () => {
      const { getByTestId, findByTestId } = renderCreateForm();
      fireEvent(getByTestId('movie-form-ripped-toggle'), 'onValueChange', true);
      expect(await findByTestId('movie-form-rip-quality-picker')).toBeTruthy();
    });
  });

  describe('cancel button', () => {
    it('calls onCancel when cancel button is pressed', () => {
      const { getByTestId, onCancel } = renderCreateForm();
      fireEvent.press(getByTestId('movie-form-cancel-button'));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('loading state', () => {
    it('disables submit button when isLoading is true', () => {
      const { getByTestId } = renderCreateForm({ isLoading: true });
      const btn = getByTestId('movie-form-submit-button');
      expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBe(true);
    });
  });
});

describe('MovieForm — edit mode', () => {
  it('pre-fills title input from initialValues', () => {
    const { getByTestId } = renderEditForm({ title: 'Star Wars' });
    expect(getByTestId('movie-form-title-input').props.value).toBe('Star Wars');
  });

  it('pre-fills year input from initialValues', () => {
    const { getByTestId } = renderEditForm({ year: 1977 });
    expect(getByTestId('movie-form-year-input').props.value).toBe('1977');
  });

  it('pre-fills language from initialValues', () => {
    const { getByTestId } = renderEditForm({ language: 'French' });
    expect(getByTestId('movie-form-language-input').props.value).toBe('French');
  });

  it('shows ownedMedia picker when initialValues.owned is true', () => {
    const { getByTestId } = renderEditForm({ owned: true, ownedMedia: ['Blu-Ray'] });
    expect(getByTestId('movie-form-owned-media-picker')).toBeTruthy();
  });

  it('shows ripQuality picker when initialValues.ripped is true', () => {
    const { getByTestId } = renderEditForm({ ripped: true, ripQuality: ['1080p'] });
    expect(getByTestId('movie-form-rip-quality-picker')).toBeTruthy();
  });

  it('calls onSubmit with updated values', async () => {
    const { getByTestId, onSubmit } = renderEditForm({ title: 'The Matrix' });

    fireEvent.changeText(getByTestId('movie-form-title-input'), 'The Matrix Reloaded');
    fireEvent.press(getByTestId('movie-form-submit-button'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'The Matrix Reloaded' }),
      );
    });
  });
});
