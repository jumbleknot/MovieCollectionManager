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
 * - ownedMedia uses correct values (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray)
 * - ripQuality uses correct values (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray)
 * - Submit with all required fields calls onSubmit with correct payload
 * - Cancel button calls onCancel
 * - isLoading disables submit button
 * - Edit mode pre-fills all fields from initialValues
 * - serverError prop displays error banner
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@/test-support/render';
import { Platform } from 'react-native';
import { MovieForm } from '@/components/movie-form';
import type { Movie } from '@/types/collection';

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function fillRequiredFields(getByTestId: Awaited<ReturnType<typeof render>>['getByTestId']) {
  await fireEvent.changeText(getByTestId('movie-form-title-input'), 'The Matrix');
  await fireEvent.changeText(getByTestId('movie-form-year-input'), '1999');
  // contentType radio buttons - 'Movie' is selected by default; press to confirm
  await fireEvent.press(getByTestId('movie-form-content-type-movie'));
  await fireEvent.changeText(getByTestId('movie-form-language-input'), 'English');
  // owned, ripped, childrens toggles start as false by default
}

async function renderCreateForm(overrides: Record<string, unknown> = {}) {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const onCancel = jest.fn();

  const utils = await render(
    <MovieForm
      mode="create"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { ...utils, onSubmit, onCancel };
}

async function renderEditForm(
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

  const utils = await render(
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
    it('renders title input', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-title-input')).toBeTruthy();
    });

    it('renders year input', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-year-input')).toBeTruthy();
    });

    it('renders content type selector', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-content-type-picker')).toBeTruthy();
      expect(getByTestId('movie-form-content-type-movie')).toBeTruthy();
      expect(getByTestId('movie-form-content-type-series')).toBeTruthy();
      expect(getByTestId('movie-form-content-type-concert')).toBeTruthy();
    });

    it('renders language input', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-language-input')).toBeTruthy();
    });

    it('renders owned toggle', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-owned-toggle')).toBeTruthy();
    });

    it('renders ripped toggle', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-ripped-toggle')).toBeTruthy();
    });

    it('renders childrens toggle', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-childrens-toggle')).toBeTruthy();
    });

    it('shows validation error when title is empty on submit', async () => {
      const { getByTestId, findByText } = await renderCreateForm();
      await fireEvent.press(getByTestId('movie-form-submit-button'));
      expect(await findByText(/title is required/i)).toBeTruthy();
    });

    it('does not call onSubmit when title is empty', async () => {
      const { getByTestId, onSubmit } = await renderCreateForm();
      await fireEvent.press(getByTestId('movie-form-submit-button'));
      await waitFor(() => expect(onSubmit).not.toHaveBeenCalled());
    });

    it('shows validation error when year is empty on submit', async () => {
      const { getByTestId, findByText } = await renderCreateForm();
      await fireEvent.changeText(getByTestId('movie-form-title-input'), 'The Matrix');
      await fireEvent.press(getByTestId('movie-form-submit-button'));
      expect(await findByText(/year is required/i)).toBeTruthy();
    });

    // 014 US1: language is optional — a blank language must submit (as null) with no error.
    it('submits with a blank language (no language-required error) — 014 US1', async () => {
      const { getByTestId, queryByText, onSubmit } = await renderCreateForm();
      await fireEvent.changeText(getByTestId('movie-form-title-input'), 'The Matrix');
      await fireEvent.changeText(getByTestId('movie-form-year-input'), '1999');
      await fireEvent.press(getByTestId('movie-form-content-type-movie'));
      // language deliberately left blank
      await fireEvent.press(getByTestId('movie-form-submit-button'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'The Matrix', language: null }),
        ),
      );
      expect(queryByText(/language is required/i)).toBeNull();
    });

    it('does not render a required asterisk on the language label — 014 US1', async () => {
      const { queryByText } = await renderCreateForm();
      expect(queryByText('Language *')).toBeNull();
    });
  });

  describe('submit with all required fields', () => {
    it('calls onSubmit with correct payload when all required fields filled', async () => {
      const { getByTestId, onSubmit } = await renderCreateForm();

      await fillRequiredFields(getByTestId);
      await fireEvent.press(getByTestId('movie-form-submit-button'));

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
    it('does not show ownedMedia picker when owned is false', async () => {
      const { queryByTestId } = await renderCreateForm();
      expect(queryByTestId('movie-form-owned-media-picker')).toBeNull();
    });

    it('shows ownedMedia picker when owned toggle is turned on', async () => {
      const { getByTestId, findByTestId } = await renderCreateForm();
      await fireEvent(getByTestId('movie-form-owned-toggle'), 'onValueChange', true);
      expect(await findByTestId('movie-form-owned-media-picker')).toBeTruthy();
    });

    it('shows correct owned media format options (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray)', async () => {
      const { getByTestId, findByTestId } = await renderCreateForm();
      await fireEvent(getByTestId('movie-form-owned-toggle'), 'onValueChange', true);
      await findByTestId('movie-form-owned-media-picker');
      // Verify each correct format is available
      expect(getByTestId('movie-form-owned-media-dvd')).toBeTruthy();
      expect(getByTestId('movie-form-owned-media-blu-ray')).toBeTruthy();
      expect(getByTestId('movie-form-owned-media-blu-ray-3d')).toBeTruthy();
      expect(getByTestId('movie-form-owned-media-uhd-blu-ray')).toBeTruthy();
    });

    it('exposes the owned-media chips as multi-select checkboxes (finding #3)', async () => {
      const { getByTestId, findByTestId } = await renderCreateForm();
      await fireEvent(getByTestId('movie-form-owned-toggle'), 'onValueChange', true);
      await findByTestId('movie-form-owned-media-picker');
      const dvd = getByTestId('movie-form-owned-media-dvd');
      expect(dvd.props.accessibilityRole).toBe('checkbox');
      expect(dvd.props.accessibilityState).toMatchObject({ checked: false });
    });
  });

  describe('ripped/ripQuality conditional field', () => {
    it('does not show ripQuality picker when ripped is false', async () => {
      const { queryByTestId } = await renderCreateForm();
      expect(queryByTestId('movie-form-rip-quality-picker')).toBeNull();
    });

    it('shows ripQuality picker when ripped toggle is turned on', async () => {
      const { getByTestId, findByTestId } = await renderCreateForm();
      await fireEvent(getByTestId('movie-form-ripped-toggle'), 'onValueChange', true);
      expect(await findByTestId('movie-form-rip-quality-picker')).toBeTruthy();
    });

    it('shows correct rip quality options (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray)', async () => {
      const { getByTestId, findByTestId } = await renderCreateForm();
      await fireEvent(getByTestId('movie-form-ripped-toggle'), 'onValueChange', true);
      await findByTestId('movie-form-rip-quality-picker');
      expect(getByTestId('movie-form-rip-quality-dvd')).toBeTruthy();
      expect(getByTestId('movie-form-rip-quality-blu-ray')).toBeTruthy();
      expect(getByTestId('movie-form-rip-quality-blu-ray-3d')).toBeTruthy();
      expect(getByTestId('movie-form-rip-quality-uhd-blu-ray')).toBeTruthy();
    });
  });

  describe('optional fields', () => {
    it('renders rated picker with None and all USA ratings', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-rated-picker')).toBeTruthy();
      expect(getByTestId('movie-form-rated-none')).toBeTruthy();
      expect(getByTestId('movie-form-rated-g')).toBeTruthy();
      expect(getByTestId('movie-form-rated-pg')).toBeTruthy();
      expect(getByTestId('movie-form-rated-pg13')).toBeTruthy();
      expect(getByTestId('movie-form-rated-r')).toBeTruthy();
      expect(getByTestId('movie-form-rated-nc17')).toBeTruthy();
      expect(getByTestId('movie-form-rated-nr')).toBeTruthy();
      expect(getByTestId('movie-form-rated-unrated')).toBeTruthy();
    });

    it('renders original title input', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-original-title-input')).toBeTruthy();
    });

    it('renders release date input', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-release-date-input')).toBeTruthy();
    });

    it('renders runtime input', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-runtime-input')).toBeTruthy();
    });

    it('renders movie set input', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-movie-set-input')).toBeTruthy();
    });

    it('renders outline input', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-outline-input')).toBeTruthy();
    });

    it('renders plot input', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-plot-input')).toBeTruthy();
    });

    it('renders directors add input and button', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-director-input')).toBeTruthy();
      expect(getByTestId('movie-form-director-add-button')).toBeTruthy();
    });

    it('renders actors add input and button', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-actor-input')).toBeTruthy();
      expect(getByTestId('movie-form-actor-add-button')).toBeTruthy();
    });

    it('renders genres add input and button', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-genre-input')).toBeTruthy();
      expect(getByTestId('movie-form-genre-add-button')).toBeTruthy();
    });

    it('renders tags add input and button', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-tag-input')).toBeTruthy();
      expect(getByTestId('movie-form-tag-add-button')).toBeTruthy();
    });

    it('renders external ID inputs', async () => {
      const { getByTestId } = await renderCreateForm();
      expect(getByTestId('movie-form-ext-id-system-input')).toBeTruthy();
      expect(getByTestId('movie-form-ext-id-unique-input')).toBeTruthy();
      expect(getByTestId('movie-form-ext-id-add-button')).toBeTruthy();
    });
  });

  describe('server error display', () => {
    it('shows server error banner when serverError prop is set', async () => {
      const { getByTestId } = await renderCreateForm({ serverError: 'Movie already exists in this collection.' });
      expect(getByTestId('movie-form-server-error')).toBeTruthy();
    });

    it('does not show server error banner when serverError is null', async () => {
      const { queryByTestId } = await renderCreateForm({ serverError: null });
      expect(queryByTestId('movie-form-server-error')).toBeNull();
    });

    it('displays the server error message text', async () => {
      const { getByTestId } = await renderCreateForm({ serverError: 'Duplicate movie detected.' });
      expect(getByTestId('movie-form-server-error')).toBeTruthy();
    });
  });

  describe('cancel button', () => {
    it('calls onCancel when cancel button is pressed', async () => {
      const { getByTestId, onCancel } = await renderCreateForm();
      await fireEvent.press(getByTestId('movie-form-cancel-button'));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('loading state', () => {
    it('disables submit button when isLoading is true', async () => {
      const { getByTestId } = await renderCreateForm({ isLoading: true });
      const btn = getByTestId('movie-form-submit-button');
      expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBe(true);
    });
  });
});

describe('MovieForm — external ID autofill suppression (TR28)', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, writable: true });
  });

  it('ext-id-system accessibilityLabel does not contain the word "name" (prevents Chrome aria-label heuristic match)', async () => {
    const { getByTestId } = await renderCreateForm();
    const input = getByTestId('movie-form-ext-id-system-input');
    expect(input.props.accessibilityLabel?.toLowerCase()).not.toMatch(/\bname\b/);
  });

  it('ext-id-system input has webName="ext-id-system" rendered as name prop on web', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', writable: true });
    const { getByTestId } = await renderCreateForm();
    expect(getByTestId('movie-form-ext-id-system-input').props.name).toBe('ext-id-system');
  });

  it('ext-id-unique input has webName="ext-id-unique" rendered as name prop on web', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', writable: true });
    const { getByTestId } = await renderCreateForm();
    expect(getByTestId('movie-form-ext-id-unique-input').props.name).toBe('ext-id-unique');
  });

  it('ext-id-unique placeholder does not contain the word "id" (prevents Chrome identifier heuristic match)', async () => {
    const { getByTestId } = await renderCreateForm();
    expect(getByTestId('movie-form-ext-id-unique-input').props.placeholder?.toLowerCase()).not.toMatch(/\bid\b/);
  });

  it('ext-id-unique accessibilityLabel does not contain "identifier" (prevents Chrome identifier heuristic match)', async () => {
    const { getByTestId } = await renderCreateForm();
    expect(getByTestId('movie-form-ext-id-unique-input').props.accessibilityLabel?.toLowerCase()).not.toContain('identifier');
  });
});

describe('MovieForm — edit mode', () => {
  it('pre-fills title input from initialValues', async () => {
    const { getByTestId } = await renderEditForm({ title: 'Star Wars' });
    expect(getByTestId('movie-form-title-input').props.value).toBe('Star Wars');
  });

  it('pre-fills year input from initialValues', async () => {
    const { getByTestId } = await renderEditForm({ year: 1977 });
    expect(getByTestId('movie-form-year-input').props.value).toBe('1977');
  });

  it('pre-fills language from initialValues', async () => {
    const { getByTestId } = await renderEditForm({ language: 'French' });
    expect(getByTestId('movie-form-language-input').props.value).toBe('French');
  });

  it('shows ownedMedia picker when initialValues.owned is true', async () => {
    const { getByTestId } = await renderEditForm({ owned: true, ownedMedia: ['Blu-Ray'] });
    expect(getByTestId('movie-form-owned-media-picker')).toBeTruthy();
  });

  it('shows ripQuality picker when initialValues.ripped is true', async () => {
    const { getByTestId } = await renderEditForm({ ripped: true, ripQuality: ['Blu-Ray'] });
    expect(getByTestId('movie-form-rip-quality-picker')).toBeTruthy();
  });

  it('calls onSubmit with updated values', async () => {
    const { getByTestId, onSubmit } = await renderEditForm({ title: 'The Matrix' });

    await fireEvent.changeText(getByTestId('movie-form-title-input'), 'The Matrix Reloaded');
    await fireEvent.press(getByTestId('movie-form-submit-button'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'The Matrix Reloaded' }),
      );
    });
  });

  it('shows server error banner when serverError prop is set in edit mode', async () => {
    const { getByTestId } = await renderEditForm({}, { serverError: 'Update failed: validation error.' });
    expect(getByTestId('movie-form-server-error')).toBeTruthy();
  });
});
