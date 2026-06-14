/**
 * Unit tests for CollectionCard component (T055)
 *
 * Tests cover:
 * - Renders collection name and description
 * - Shows "Default" badge when isDefault is true
 * - Hides badge when isDefault is false
 * - Action menu: "Open", "Edit", "Set as Default", "Delete" items visible
 * - Tapping "Open" fires onOpen callback
 * - Tapping "Edit" fires onEdit callback
 * - Tapping "Set as Default" fires onSetDefault callback
 * - Tapping "Delete" fires onDelete callback
 * - "Set as Default" hidden when already default
 */

import React from 'react';
import { render, fireEvent } from '@/test-support/render';
import { CollectionCard } from '@/components/collection-card';
import type { CollectionSummary } from '@/types/collection';

const BASE_COLLECTION: CollectionSummary = {
  collectionId: 'col-1',
  name: 'My Movies',
  description: 'A great collection',
  isDefault: false,
  movieCount: 5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const DEFAULT_COLLECTION: CollectionSummary = {
  ...BASE_COLLECTION,
  isDefault: true,
};

function renderCard(collection: CollectionSummary, overrides = {}) {
  const onOpen = jest.fn();
  const onEdit = jest.fn();
  const onSetDefault = jest.fn();
  const onDelete = jest.fn();

  const utils = render(
    <CollectionCard
      collection={collection}
      onOpen={onOpen}
      onEdit={onEdit}
      onSetDefault={onSetDefault}
      onDelete={onDelete}
      {...overrides}
    />
  );
  return { ...utils, onOpen, onEdit, onSetDefault, onDelete };
}

describe('CollectionCard', () => {
  it('renders collection name', () => {
    const { getByText } = renderCard(BASE_COLLECTION);
    expect(getByText('My Movies')).toBeTruthy();
  });

  it('renders description when present', () => {
    const { getByText } = renderCard(BASE_COLLECTION);
    expect(getByText('A great collection')).toBeTruthy();
  });

  it('does not render description when null', () => {
    const { queryByTestId } = renderCard({ ...BASE_COLLECTION, description: null });
    expect(queryByTestId('collection-card-description')).toBeNull();
  });

  it('shows movie count', () => {
    const { getByText } = renderCard(BASE_COLLECTION);
    expect(getByText(/5/)).toBeTruthy();
  });

  it('shows default badge when isDefault is true', () => {
    const { getByTestId } = renderCard(DEFAULT_COLLECTION);
    expect(getByTestId('collection-card-default-badge')).toBeTruthy();
  });

  it('does not show default badge when isDefault is false', () => {
    const { queryByTestId } = renderCard(BASE_COLLECTION);
    expect(queryByTestId('collection-card-default-badge')).toBeNull();
  });

  it('calls onOpen when Open action is pressed', () => {
    const { getByTestId, onOpen } = renderCard(BASE_COLLECTION);
    fireEvent.press(getByTestId('collection-card-action-open'));
    expect(onOpen).toHaveBeenCalledWith('col-1');
  });

  it('calls onEdit when Edit action is pressed', () => {
    const { getByTestId, onEdit } = renderCard(BASE_COLLECTION);
    fireEvent.press(getByTestId('collection-card-action-edit'));
    expect(onEdit).toHaveBeenCalledWith(BASE_COLLECTION);
  });

  it('calls onSetDefault when Set as Default action is pressed', () => {
    const { getByTestId, onSetDefault } = renderCard(BASE_COLLECTION);
    fireEvent.press(getByTestId('collection-card-action-set-default'));
    expect(onSetDefault).toHaveBeenCalledWith('col-1');
  });

  it('does not show Set as Default action when already default', () => {
    const { queryByTestId } = renderCard(DEFAULT_COLLECTION);
    expect(queryByTestId('collection-card-action-set-default')).toBeNull();
  });

  it('calls onDelete when Delete action is pressed', () => {
    const { getByTestId, onDelete } = renderCard(BASE_COLLECTION);
    fireEvent.press(getByTestId('collection-card-action-delete'));
    expect(onDelete).toHaveBeenCalledWith('col-1');
  });

  it('calls onOpen when card is tapped directly', () => {
    const { getByTestId, onOpen } = renderCard(BASE_COLLECTION);
    fireEvent.press(getByTestId('collection-card'));
    expect(onOpen).toHaveBeenCalledWith('col-1');
  });
});
