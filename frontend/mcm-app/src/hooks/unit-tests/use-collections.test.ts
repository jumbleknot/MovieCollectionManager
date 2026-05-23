/**
 * Unit tests for useCollections hook (T053)
 *
 * Tests cover:
 * - Fetching collections on mount
 * - createCollection triggers POST and optimistic update
 * - updateCollection triggers PATCH
 * - setDefaultCollection triggers PATCH with isDefault: true
 * - deleteCollection triggers DELETE
 * - Error state propagation
 */

import { renderHook, act } from '@testing-library/react-native';
import { apiClient } from '@/bff-server/api-client';
import { useCollections } from '@/hooks/use-collections';
import type { CollectionSummary } from '@/types/collection';

jest.mock('@/bff-server/api-client', () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockedGet = jest.mocked(apiClient.get);
const mockedPost = jest.mocked(apiClient.post);
const mockedPatch = jest.mocked(apiClient.patch);
const mockedDelete = jest.mocked(apiClient.delete);

const COLLECTION_1: CollectionSummary = {
  collectionId: 'col-1',
  name: 'My Movies',
  description: null,
  isDefault: true,
  movieCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const COLLECTION_2: CollectionSummary = {
  collectionId: 'col-2',
  name: 'Classics',
  description: 'Old films',
  isDefault: false,
  movieCount: 10,
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

describe('useCollections', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('initial load', () => {
    it('starts with empty collections and loading true', () => {
      mockedGet.mockResolvedValueOnce({ data: { items: [] } } as never);
      const { result } = renderHook(() => useCollections());

      expect(result.current.collections).toEqual([]);
      expect(result.current.isLoading).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('fetches collections from GET /bff-api/collections on mount', async () => {
      mockedGet.mockResolvedValueOnce({
        data: { items: [COLLECTION_1, COLLECTION_2] },
      } as never);

      const { result } = renderHook(() => useCollections());

      await act(async () => {});

      expect(mockedGet).toHaveBeenCalledWith('/bff-api/collections');
      expect(result.current.collections).toEqual([COLLECTION_1, COLLECTION_2]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('sets error state when fetch fails', async () => {
      mockedGet.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useCollections());

      await act(async () => {});

      expect(result.current.collections).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBe('Failed to load collections');
    });
  });

  describe('createCollection', () => {
    it('sends POST to /bff-api/collections with name and description', async () => {
      mockedGet.mockResolvedValueOnce({ data: { items: [COLLECTION_1] } } as never);
      const newCollection: CollectionSummary = {
        collectionId: 'col-new',
        name: 'Action',
        description: null,
        isDefault: false,
        movieCount: 0,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      };
      mockedPost.mockResolvedValueOnce({ data: newCollection } as never);

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.createCollection({ name: 'Action', description: null });
      });

      expect(mockedPost).toHaveBeenCalledWith('/bff-api/collections', {
        name: 'Action',
        description: null,
      });
    });

    it('adds the new collection to state after successful POST', async () => {
      mockedGet.mockResolvedValueOnce({ data: { items: [COLLECTION_1] } } as never);
      const created: CollectionSummary = {
        collectionId: 'col-new',
        name: 'Action',
        description: null,
        isDefault: false,
        movieCount: 0,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      };
      mockedPost.mockResolvedValueOnce({ data: created } as never);

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.createCollection({ name: 'Action', description: null });
      });

      expect(result.current.collections).toContainEqual(
        expect.objectContaining({ collectionId: 'col-new', name: 'Action' })
      );
    });

    it('sets error and does not add collection on POST failure', async () => {
      mockedGet.mockResolvedValueOnce({ data: { items: [COLLECTION_1] } } as never);
      mockedPost.mockRejectedValueOnce({
        response: { data: { title: 'Conflict', status: 409 } },
      });

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.createCollection({ name: 'My Movies' });
      });

      expect(result.current.collections).toHaveLength(1);
      expect(result.current.error).toBe('Failed to create collection');
    });
  });

  describe('updateCollection', () => {
    it('sends PATCH to /bff-api/collections/:id with updated fields', async () => {
      mockedGet.mockResolvedValueOnce({ data: { items: [COLLECTION_1] } } as never);
      mockedPatch.mockResolvedValueOnce({
        data: { ...COLLECTION_1, name: 'Renamed' },
      } as never);

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.updateCollection('col-1', { name: 'Renamed' });
      });

      expect(mockedPatch).toHaveBeenCalledWith('/bff-api/collections/col-1', {
        name: 'Renamed',
      });
    });

    it('updates the collection in state after successful PATCH', async () => {
      mockedGet.mockResolvedValueOnce({
        data: { items: [COLLECTION_1, COLLECTION_2] },
      } as never);
      mockedPatch.mockResolvedValueOnce({
        data: { ...COLLECTION_1, name: 'Renamed' },
      } as never);

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.updateCollection('col-1', { name: 'Renamed' });
      });

      const updated = result.current.collections.find(c => c.collectionId === 'col-1');
      expect(updated?.name).toBe('Renamed');
      // Other collections unchanged
      expect(result.current.collections).toHaveLength(2);
    });

    it('sets error on PATCH failure', async () => {
      mockedGet.mockResolvedValueOnce({ data: { items: [COLLECTION_1] } } as never);
      mockedPatch.mockRejectedValueOnce({ response: { data: { status: 404 } } });

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.updateCollection('col-1', { name: 'X' });
      });

      expect(result.current.error).toBe('Failed to update collection');
    });
  });

  describe('setDefaultCollection', () => {
    it('sends PATCH with isDefault:true to /bff-api/collections/:id', async () => {
      mockedGet.mockResolvedValueOnce({
        data: { items: [COLLECTION_1, COLLECTION_2] },
      } as never);
      mockedPatch.mockResolvedValueOnce({
        data: { ...COLLECTION_2, isDefault: true },
      } as never);

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.setDefaultCollection('col-2');
      });

      expect(mockedPatch).toHaveBeenCalledWith('/bff-api/collections/col-2', {
        isDefault: true,
      });
    });

    it('updates isDefault flags in state after set-default', async () => {
      mockedGet.mockResolvedValueOnce({
        data: { items: [COLLECTION_1, COLLECTION_2] },
      } as never);
      mockedPatch.mockResolvedValueOnce({
        data: { ...COLLECTION_2, isDefault: true },
      } as never);

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.setDefaultCollection('col-2');
      });

      const newDefault = result.current.collections.find(c => c.collectionId === 'col-2');
      expect(newDefault?.isDefault).toBe(true);
    });
  });

  describe('deleteCollection', () => {
    it('sends DELETE to /bff-api/collections/:id', async () => {
      mockedGet.mockResolvedValueOnce({ data: { items: [COLLECTION_1, COLLECTION_2] } } as never);
      mockedDelete.mockResolvedValueOnce({} as never);

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.deleteCollection('col-1');
      });

      expect(mockedDelete).toHaveBeenCalledWith('/bff-api/collections/col-1');
    });

    it('removes the collection from state after successful DELETE', async () => {
      mockedGet.mockResolvedValueOnce({
        data: { items: [COLLECTION_1, COLLECTION_2] },
      } as never);
      mockedDelete.mockResolvedValueOnce({} as never);

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.deleteCollection('col-1');
      });

      expect(result.current.collections).toHaveLength(1);
      expect(result.current.collections[0].collectionId).toBe('col-2');
    });

    it('sets error on DELETE failure', async () => {
      mockedGet.mockResolvedValueOnce({ data: { items: [COLLECTION_1] } } as never);
      mockedDelete.mockRejectedValueOnce({ response: { data: { status: 404 } } });

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.deleteCollection('col-1');
      });

      expect(result.current.error).toBe('Failed to delete collection');
      // Collection not removed from state on failure
      expect(result.current.collections).toHaveLength(1);
    });
  });

  describe('error clearing', () => {
    it('clears error on a new successful operation', async () => {
      mockedGet.mockResolvedValueOnce({ data: { items: [COLLECTION_1] } } as never);
      mockedPost.mockRejectedValueOnce(new Error('fail'));

      const { result } = renderHook(() => useCollections());
      await act(async () => {});

      await act(async () => {
        await result.current.createCollection({ name: 'X' });
      });
      expect(result.current.error).toBe('Failed to create collection');

      const created: CollectionSummary = {
        collectionId: 'col-new2',
        name: 'Y',
        description: null,
        isDefault: false,
        movieCount: 0,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      };
      mockedPost.mockResolvedValueOnce({ data: created } as never);

      await act(async () => {
        await result.current.createCollection({ name: 'Y' });
      });
      expect(result.current.error).toBeNull();
    });
  });
});
