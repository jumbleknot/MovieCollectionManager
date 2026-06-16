/**
 * Unit tests for CollectionForm component (T057)
 *
 * Tests cover:
 * - Create mode: renders blank name and description inputs
 * - Edit mode: pre-fills name and description from initial values
 * - Name is required (submit without name shows error)
 * - Name exceeding 50 chars shows validation error
 * - Submitting valid data calls onSubmit with correct payload
 * - Cancel button calls onCancel
 * - isLoading disables submit button
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@/test-support/render';
import { Platform } from 'react-native';
import { CollectionForm } from '@/components/collection-form';

function renderCreateForm(overrides = {}) {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const onCancel = jest.fn();

  const utils = render(
    <CollectionForm
      mode="create"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { ...utils, onSubmit, onCancel };
}

function renderEditForm(
  initial = { name: 'Existing Collection', description: 'Some desc' },
  overrides = {}
) {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const onCancel = jest.fn();

  const utils = render(
    <CollectionForm
      mode="edit"
      initialValues={initial}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { ...utils, onSubmit, onCancel };
}

describe('CollectionForm — create mode', () => {
  it('renders empty name input', () => {
    const { getByTestId } = renderCreateForm();
    const nameInput = getByTestId('collection-form-name-input');
    expect(nameInput.props.value ?? '').toBe('');
  });

  it('renders empty description input', () => {
    const { getByTestId } = renderCreateForm();
    const descInput = getByTestId('collection-form-description-input');
    expect(descInput.props.value ?? '').toBe('');
  });

  it('calls onSubmit with name and description on valid submit', async () => {
    const { getByTestId, onSubmit } = renderCreateForm();

    fireEvent.changeText(getByTestId('collection-form-name-input'), 'New Collection');
    fireEvent.changeText(getByTestId('collection-form-description-input'), 'Some description');
    fireEvent.press(getByTestId('collection-form-submit-button'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'New Collection',
        description: 'Some description',
      });
    });
  });

  it('calls onSubmit with null description when description is empty', async () => {
    const { getByTestId, onSubmit } = renderCreateForm();

    fireEvent.changeText(getByTestId('collection-form-name-input'), 'New Collection');
    fireEvent.press(getByTestId('collection-form-submit-button'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'New Collection',
        description: null,
      });
    });
  });

  it('shows validation error when name is empty on submit', async () => {
    const { getByTestId, findByText } = renderCreateForm();
    fireEvent.press(getByTestId('collection-form-submit-button'));

    expect(await findByText(/name is required/i)).toBeTruthy();
  });

  it('does not call onSubmit when name is empty', async () => {
    const { getByTestId, onSubmit } = renderCreateForm();
    fireEvent.press(getByTestId('collection-form-submit-button'));

    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  it('shows validation error when name exceeds 50 chars', async () => {
    const { getByTestId, findByText } = renderCreateForm();
    fireEvent.changeText(
      getByTestId('collection-form-name-input'),
      'a'.repeat(51)
    );
    fireEvent.press(getByTestId('collection-form-submit-button'));

    expect(await findByText(/50 characters/i)).toBeTruthy();
  });

  it('does not call onSubmit when name exceeds 50 chars', async () => {
    const { getByTestId, onSubmit } = renderCreateForm();
    fireEvent.changeText(getByTestId('collection-form-name-input'), 'a'.repeat(51));
    fireEvent.press(getByTestId('collection-form-submit-button'));

    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  it('calls onCancel when cancel button is pressed', () => {
    const { getByTestId, onCancel } = renderCreateForm();
    fireEvent.press(getByTestId('collection-form-cancel-button'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables submit button when isLoading is true', () => {
    const { getByTestId } = renderCreateForm({ isLoading: true });
    const btn = getByTestId('collection-form-submit-button');
    expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBe(true);
  });
});

describe('CollectionForm — autofill suppression (TR27)', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, writable: true });
  });

  it('collection name placeholder does not contain the word "name" (prevents Chrome heuristic match)', () => {
    const { getByTestId } = renderCreateForm();
    const input = getByTestId('collection-form-name-input');
    expect(input.props.placeholder?.toLowerCase()).not.toMatch(/\bname\b/);
  });

  it('collection name input has webName="collection-name-entry" rendered as name prop on web', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', writable: true });
    const { getByTestId } = renderCreateForm();
    const input = getByTestId('collection-form-name-input');
    expect(input.props.name).toBe('collection-name-entry');
  });

  it('collection name accessibilityLabel does not contain the word "name" (prevents Chrome aria-label heuristic match)', () => {
    const { getByTestId } = renderCreateForm();
    const input = getByTestId('collection-form-name-input');
    expect(input.props.accessibilityLabel?.toLowerCase()).not.toMatch(/\bname\b/);
  });
});

describe('CollectionForm — edit mode', () => {
  it('pre-fills name input with initialValues.name', () => {
    const { getByTestId } = renderEditForm();
    const nameInput = getByTestId('collection-form-name-input');
    expect(nameInput.props.value).toBe('Existing Collection');
  });

  it('pre-fills description input with initialValues.description', () => {
    const { getByTestId } = renderEditForm();
    const descInput = getByTestId('collection-form-description-input');
    expect(descInput.props.value).toBe('Some desc');
  });

  it('calls onSubmit with updated values', async () => {
    const { getByTestId, onSubmit } = renderEditForm();

    fireEvent.changeText(getByTestId('collection-form-name-input'), 'Renamed');
    fireEvent.press(getByTestId('collection-form-submit-button'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Renamed',
        description: 'Some desc',
      });
    });
  });
});
