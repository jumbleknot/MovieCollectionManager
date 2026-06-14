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
import { render, fireEvent, waitFor } from '@/test-support/render';
import { HomeScreen } from '@/screens/home/home-screen';
import type { CollectionSummary } from '@/types/collection';

import { clearAutoNav } from '@/utils/default-collection-auto-nav';

// ── Tests ──────────────────────────────────────────────────────────────────────

import { useCollections } from '@/hooks/use-collections';

// ── Mock dependencies ──────────────────────────────────────────────────────────

const mockCollections: CollectionSummary[] = [
  {
    collectionId: 'col-1',
    name: 'My Movies',
    description: null,
    isDefault: false, // false so FR-009 sets isFr009Checked=true (not redirect) in non-FR-009 tests
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
jest.mock('expo-router', () => {
  // jest.mock factories are hoisted before imports; use require() to access React.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useEffect } = require('react');
  return {
    useRouter: () => ({ push: mockPush, replace: mockReplace }),
    // Simulate useFocusEffect: call the callback twice to model real behaviour —
    // once for the initial mount (which HomeScreen skips via hasMountedRef) and
    // once for a subsequent focus event (which triggers the refresh).
    useFocusEffect: (cb: () => void) => {
      // The empty dep array is intentional: this mock must fire EXACTLY ONCE on
      // mount to simulate expo-router's mount + re-focus sequence. Adding `cb` to
      // the deps would re-run the effect on every render (cb is a fresh closure
      // each render), invoking the refresh repeatedly and breaking the test's
      // model of focus behaviour — so exhaustive-deps is disabled on the dep array.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useEffect(() => {
        cb(); // First call: initial mount — hasMountedRef skips this in HomeScreen
        cb(); // Second call: simulated re-focus — refresh IS called
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
  };
});
const mockUseCollections = jest.mocked(useCollections);

describe('HomeScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset FR-009 module-level flag so each test starts with a clean slate.
    // Without this, once a test triggers the redirect the module flag stays true
    // and subsequent tests that expect FR-009 to fire would find it already done.
    clearAutoNav();
    // Restore default mock implementation: jest.clearAllMocks() clears calls/results
    // but does NOT reset mockReturnValue/mockImplementation set in previous tests.
    // Explicitly re-apply the default so every test starts with the same mock state.
    mockUseCollections.mockImplementation(() => ({
      collections: mockCollections,
      isLoading: false,
      error: null,
      createCollection: mockCreateCollection,
      updateCollection: mockUpdateCollection,
      setDefaultCollection: mockSetDefaultCollection,
      deleteCollection: mockDeleteCollection,
      refresh: mockRefresh,
    }));
  });

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
      // Use mockImplementation (not ReturnValueOnce) so ALL renders during the test —
      // including the re-render triggered by isFr009Checked becoming true — see empty
      // collections. beforeEach restores the default implementation before the next test.
      mockUseCollections.mockImplementation(() => ({
        collections: [],
        isLoading: false,
        error: null,
        createCollection: mockCreateCollection,
        updateCollection: mockUpdateCollection,
        setDefaultCollection: mockSetDefaultCollection,
        deleteCollection: mockDeleteCollection,
        refresh: mockRefresh,
      }));

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

  describe('collections refresh on focus', () => {
    it('calls refresh when the screen gains focus (useFocusEffect)', async () => {
      render(<HomeScreen />);
      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
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

    it('does not navigate on re-mount when FR-009 already fired this session', async () => {
      // First mount: provide a default collection to trigger FR-009 redirect.
      mockUseCollections.mockReturnValue({
        collections: [{ ...mockCollections[0], isDefault: true }],
        isLoading: false,
        error: null,
        createCollection: mockCreateCollection,
        updateCollection: mockUpdateCollection,
        setDefaultCollection: mockSetDefaultCollection,
        deleteCollection: mockDeleteCollection,
        refresh: mockRefresh,
      });

      const { unmount } = render(<HomeScreen />);
      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledTimes(1);
      });
      unmount();
      mockReplace.mockClear();

      // Second mount (simulates user clicking "Home" in the nav bar):
      // The module-level flag is set, so the redirect must NOT fire again.
      render(<HomeScreen />);
      await waitFor(() => {});
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });
});
