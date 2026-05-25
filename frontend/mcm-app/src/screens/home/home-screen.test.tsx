/**
 * Unit tests for HomeScreen component (T062)
 *
 * Tests cover:
 * - Empty state shown when user has no collections (mock useCollections returns [])
 * - Collection list renders when collections exist
 * - "Create Collection" button is visible
 * - Pressing "Create Collection" opens the collection form
 * - Tapping a collection card navigates to /collections/[collectionId]
 * - Loading indicator shown while collections are loading
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { HomeScreen } from '@/screens/home/home-screen';
import type { CollectionSummary } from '@/types/collection';

// ── Mock dependencies ──────────────────────────────────────────────────────────

const mockCollections: CollectionSummary[] = [
  {
    collectionId: 'col-1',
    name: 'My Movies',
    description: null,
    isDefault: true,
    movieCount: 5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const mockCreateCollection = jest.fn().mockResolvedValue(undefined);
const mockUpdateCollection = jest.fn().mockResolvedValue(undefined);
const mockSetDefaultCollection = jest.fn().mockResolvedValue(undefined);
const mockDeleteCollection = jest.fn().mockResolvedValue(undefined);
const mockRefresh = jest.fn().mockResolvedValue(undefined);

jest.mock('@/hooks/use-collections', () => ({
  useCollections: jest.fn(() => ({
    collections: mockCollections,
    isLoading: false,
    error: null,
    createCollection: mockCreateCollection,
    updateCollection: mockUpdateCollection,
    setDefaultCollection: mockSetDefaultCollection,
    deleteCollection: mockDeleteCollection,
    refresh: mockRefresh,
  })),
}));

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

// ── Tests ──────────────────────────────────────────────────────────────────────

import { useCollections } from '@/hooks/use-collections';
const mockUseCollections = jest.mocked(useCollections);

describe('HomeScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('loading state', () => {
    it('shows loading indicator while collections are loading', () => {
      mockUseCollections.mockReturnValueOnce({
        collections: [],
        isLoading: true,
        error: null,
        createCollection: mockCreateCollection,
        updateCollection: mockUpdateCollection,
        setDefaultCollection: mockSetDefaultCollection,
        deleteCollection: mockDeleteCollection,
        refresh: mockRefresh,
      });

      const { getByTestId } = render(<HomeScreen />);
      expect(getByTestId('home-screen-loading')).toBeTruthy();
    });
  });

  describe('empty state', () => {
    it('shows empty state when user has no collections', () => {
      mockUseCollections.mockReturnValueOnce({
        collections: [],
        isLoading: false,
        error: null,
        createCollection: mockCreateCollection,
        updateCollection: mockUpdateCollection,
        setDefaultCollection: mockSetDefaultCollection,
        deleteCollection: mockDeleteCollection,
        refresh: mockRefresh,
      });

      const { getByTestId } = render(<HomeScreen />);
      expect(getByTestId('collection-list-empty-state')).toBeTruthy();
    });
  });

  describe('collection list', () => {
    it('renders the CollectionList when collections exist', () => {
      const { getByTestId } = render(<HomeScreen />);
      expect(getByTestId('collection-card')).toBeTruthy();
    });

    it('renders collection names', () => {
      const { getByText } = render(<HomeScreen />);
      expect(getByText('My Movies')).toBeTruthy();
    });
  });

  describe('create collection button', () => {
    it('renders a "Create Collection" button', () => {
      const { getByTestId } = render(<HomeScreen />);
      expect(getByTestId('home-screen-create-button')).toBeTruthy();
    });

    it('opens the collection form when Create Collection is pressed', () => {
      const { getByTestId, queryByTestId } = render(<HomeScreen />);
      expect(queryByTestId('collection-form-name-input')).toBeNull();

      fireEvent.press(getByTestId('home-screen-create-button'));
      expect(getByTestId('collection-form-name-input')).toBeTruthy();
    });
  });

  describe('navigation', () => {
    it('navigates to /collections/[collectionId] when a card is tapped', () => {
      const { getByTestId } = render(<HomeScreen />);
      fireEvent.press(getByTestId('collection-card'));
      expect(mockPush).toHaveBeenCalledWith('/collections/col-1');
    });
  });

  describe('create form submission', () => {
    it('calls createCollection on form submit', async () => {
      const { getByTestId } = render(<HomeScreen />);

      fireEvent.press(getByTestId('home-screen-create-button'));
      fireEvent.changeText(getByTestId('collection-form-name-input'), 'New Collection');
      fireEvent.press(getByTestId('collection-form-submit-button'));

      await waitFor(() => {
        expect(mockCreateCollection).toHaveBeenCalledWith({
          name: 'New Collection',
          description: null,
        });
      });
    });
  });

  describe('edit collection', () => {
    it('opens edit modal pre-filled when Edit action is pressed', () => {
      const { getByTestId, getAllByTestId } = render(<HomeScreen />);

      // Press the edit action on the first card
      fireEvent.press(getAllByTestId('collection-card-action-edit')[0]);

      // Edit modal opens with the collection name pre-filled
      expect(getByTestId('collection-form-name-input').props.value).toBe('My Movies');
    });

    it('calls updateCollection on edit form submit', async () => {
      const { getByTestId, getAllByTestId } = render(<HomeScreen />);

      fireEvent.press(getAllByTestId('collection-card-action-edit')[0]);
      fireEvent.changeText(getByTestId('collection-form-name-input'), 'Renamed');
      fireEvent.press(getByTestId('collection-form-submit-button'));

      await waitFor(() => {
        expect(mockUpdateCollection).toHaveBeenCalledWith(
          'col-1',
          expect.objectContaining({ name: 'Renamed' }),
        );
      });
    });

    it('closes edit modal on cancel without calling updateCollection', () => {
      const { getByTestId, getAllByTestId, queryByTestId } = render(<HomeScreen />);

      fireEvent.press(getAllByTestId('collection-card-action-edit')[0]);
      expect(getByTestId('collection-form-name-input')).toBeTruthy();

      fireEvent.press(getByTestId('collection-form-cancel-button'));
      expect(queryByTestId('collection-form-name-input')).toBeNull();
      expect(mockUpdateCollection).not.toHaveBeenCalled();
    });
  });

  describe('delete collection', () => {
    it('shows delete confirmation dialog when Delete action is pressed', () => {
      const { getByTestId, getAllByTestId } = render(<HomeScreen />);

      fireEvent.press(getAllByTestId('collection-card-action-delete')[0]);

      expect(getByTestId('delete-dialog')).toBeTruthy();
    });

    it('calls deleteCollection when confirm button is pressed', async () => {
      const { getByTestId, getAllByTestId } = render(<HomeScreen />);

      fireEvent.press(getAllByTestId('collection-card-action-delete')[0]);
      fireEvent.press(getByTestId('delete-dialog-confirm-button'));

      await waitFor(() => {
        expect(mockDeleteCollection).toHaveBeenCalledWith('col-1');
      });
    });

    it('closes dialog without deleting when cancel button is pressed', () => {
      const { getByTestId, getAllByTestId, queryByTestId } = render(<HomeScreen />);

      fireEvent.press(getAllByTestId('collection-card-action-delete')[0]);
      expect(getByTestId('delete-dialog')).toBeTruthy();

      fireEvent.press(getByTestId('delete-dialog-cancel-button'));
      expect(queryByTestId('delete-dialog')).toBeNull();
      expect(mockDeleteCollection).not.toHaveBeenCalled();
    });
  });

  describe('default collection auto-navigation (FR-009)', () => {
    it('navigates to default collection with router.replace after collections load', async () => {
      mockUseCollections.mockReturnValueOnce({
        collections: [{ ...mockCollections[0], isDefault: true }],
        isLoading: false,
        error: null,
        createCollection: mockCreateCollection,
        updateCollection: mockUpdateCollection,
        setDefaultCollection: mockSetDefaultCollection,
        deleteCollection: mockDeleteCollection,
        refresh: mockRefresh,
      });

      render(<HomeScreen />);

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith('/collections/col-1');
      });
    });

    it('does not navigate when no collection is marked as default', async () => {
      mockUseCollections.mockReturnValueOnce({
        collections: [{ ...mockCollections[0], isDefault: false }],
        isLoading: false,
        error: null,
        createCollection: mockCreateCollection,
        updateCollection: mockUpdateCollection,
        setDefaultCollection: mockSetDefaultCollection,
        deleteCollection: mockDeleteCollection,
        refresh: mockRefresh,
      });

      render(<HomeScreen />);

      // Give effects time to run
      await waitFor(() => {});
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('does not navigate while collections are still loading', () => {
      mockUseCollections.mockReturnValueOnce({
        collections: [],
        isLoading: true,
        error: null,
        createCollection: mockCreateCollection,
        updateCollection: mockUpdateCollection,
        setDefaultCollection: mockSetDefaultCollection,
        deleteCollection: mockDeleteCollection,
        refresh: mockRefresh,
      });

      render(<HomeScreen />);

      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('does not navigate when collections list is empty', async () => {
      mockUseCollections.mockReturnValueOnce({
        collections: [],
        isLoading: false,
        error: null,
        createCollection: mockCreateCollection,
        updateCollection: mockUpdateCollection,
        setDefaultCollection: mockSetDefaultCollection,
        deleteCollection: mockDeleteCollection,
        refresh: mockRefresh,
      });

      render(<HomeScreen />);

      await waitFor(() => {});
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });
});
