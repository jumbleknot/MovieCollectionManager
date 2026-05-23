/**
 * Unit tests for CollectionList component (T061a)
 *
 * Tests cover:
 * - Renders a CollectionCard for each collection in the list prop
 * - Shows an empty state message when collections=[]
 * - Fires onCollectionTap with collectionId when a card is tapped
 * - Fires onEdit with the collection when Edit is pressed
 * - Fires onSetDefault with collectionId when Set as Default is pressed
 * - Fires onDelete with collectionId when Delete is pressed
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { CollectionList } from '@/components/collection-list';
import type { CollectionSummary } from '@/types/collection';

const COL_1: CollectionSummary = {
  collectionId: 'col-1',
  name: 'My Movies',
  description: null,
  isDefault: true,
  movieCount: 5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const COL_2: CollectionSummary = {
  collectionId: 'col-2',
  name: 'Classics',
  description: 'Old films',
  isDefault: false,
  movieCount: 12,
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

function renderList(
  collections: CollectionSummary[],
  overrides: Record<string, unknown> = {}
) {
  const onCollectionTap = jest.fn();
  const onEdit = jest.fn();
  const onSetDefault = jest.fn();
  const onDelete = jest.fn();

  const utils = render(
    <CollectionList
      collections={collections}
      onCollectionTap={onCollectionTap}
      onEdit={onEdit}
      onSetDefault={onSetDefault}
      onDelete={onDelete}
      {...overrides}
    />
  );
  return { ...utils, onCollectionTap, onEdit, onSetDefault, onDelete };
}

describe('CollectionList', () => {
  it('renders a card for each collection', () => {
    const { getAllByTestId } = renderList([COL_1, COL_2]);
    expect(getAllByTestId('collection-card')).toHaveLength(2);
  });

  it('renders collection names', () => {
    const { getByText } = renderList([COL_1, COL_2]);
    expect(getByText('My Movies')).toBeTruthy();
    expect(getByText('Classics')).toBeTruthy();
  });

  it('shows empty state message when collections is empty', () => {
    const { getByTestId } = renderList([]);
    expect(getByTestId('collection-list-empty-state')).toBeTruthy();
  });

  it('does not show empty state when collections is non-empty', () => {
    const { queryByTestId } = renderList([COL_1]);
    expect(queryByTestId('collection-list-empty-state')).toBeNull();
  });

  it('calls onCollectionTap with collectionId when card is tapped', () => {
    const { getAllByTestId, onCollectionTap } = renderList([COL_1, COL_2]);
    fireEvent.press(getAllByTestId('collection-card')[0]);
    expect(onCollectionTap).toHaveBeenCalledWith('col-1');
  });

  it('calls onEdit with the collection when edit action is pressed', () => {
    const { getAllByTestId, onEdit } = renderList([COL_1, COL_2]);
    fireEvent.press(getAllByTestId('collection-card-action-edit')[0]);
    expect(onEdit).toHaveBeenCalledWith(COL_1);
  });

  it('calls onSetDefault with collectionId when set-default is pressed on non-default card', () => {
    const { getByTestId, onSetDefault } = renderList([COL_1, COL_2]);
    // COL_1 is default (no set-default button), COL_2 is not
    fireEvent.press(getByTestId('collection-card-action-set-default'));
    expect(onSetDefault).toHaveBeenCalledWith('col-2');
  });

  it('calls onDelete with collectionId when delete action is pressed', () => {
    const { getAllByTestId, onDelete } = renderList([COL_1, COL_2]);
    fireEvent.press(getAllByTestId('collection-card-action-delete')[1]);
    expect(onDelete).toHaveBeenCalledWith('col-2');
  });
});
