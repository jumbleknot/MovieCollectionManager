/**
 * useCollections hook (T054)
 *
 * Manages collection CRUD state, delegating all I/O to the BFF collection routes.
 *
 * API surface:
 *   collections        — current list (CollectionSummary[])
 *   isLoading          — true while any async operation is in flight
 *   error              — last error message, or null
 *   createCollection   — POST /bff-api/collections
 *   updateCollection   — PATCH /bff-api/collections/:id
 *   setDefaultCollection — PATCH /bff-api/collections/:id with isDefault:true
 *   deleteCollection   — DELETE /bff-api/collections/:id
 *   refresh            — re-fetch from server
 */

import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '@/bff-server/api-client';
import type {
  CollectionSummary,
  CreateCollectionRequest,
  UpdateCollectionRequest,
} from '@/types/collection';

interface UseCollectionsReturn {
  collections: CollectionSummary[];
  isLoading: boolean;
  error: string | null;
  createCollection: (req: CreateCollectionRequest) => Promise<void>;
  updateCollection: (id: string, req: UpdateCollectionRequest) => Promise<void>;
  setDefaultCollection: (id: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useCollections(): UseCollectionsReturn {
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCollections = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get('/bff-api/collections');
      setCollections((res.data as { items: CollectionSummary[] }).items);
      setError(null);
    } catch {
      setError('Failed to load collections');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  const createCollection = useCallback(
    async (req: CreateCollectionRequest): Promise<void> => {
      setError(null);
      try {
        const res = await apiClient.post('/bff-api/collections', req);
        const created = res.data as CollectionSummary;
        setCollections(prev => [...prev, created]);
      } catch {
        setError('Failed to create collection');
      }
    },
    []
  );

  const updateCollection = useCallback(
    async (id: string, req: UpdateCollectionRequest): Promise<void> => {
      setError(null);
      try {
        const res = await apiClient.patch(`/bff-api/collections/${id}`, req);
        const updated = res.data as CollectionSummary;
        setCollections(prev =>
          prev.map(c => (c.collectionId === id ? updated : c))
        );
      } catch {
        setError('Failed to update collection');
      }
    },
    []
  );

  const setDefaultCollection = useCallback(
    async (id: string): Promise<void> => {
      setError(null);
      try {
        const res = await apiClient.patch(`/bff-api/collections/${id}`, {
          isDefault: true,
        } satisfies UpdateCollectionRequest);
        const updated = res.data as CollectionSummary;
        setCollections(prev =>
          prev.map(c => (c.collectionId === id ? updated : c))
        );
      } catch {
        setError('Failed to set default collection');
      }
    },
    []
  );

  const deleteCollection = useCallback(
    async (id: string): Promise<void> => {
      setError(null);
      try {
        await apiClient.delete(`/bff-api/collections/${id}`);
        setCollections(prev => prev.filter(c => c.collectionId !== id));
      } catch {
        setError('Failed to delete collection');
      }
    },
    []
  );

  return {
    collections,
    isLoading,
    error,
    createCollection,
    updateCollection,
    setDefaultCollection,
    deleteCollection,
    refresh: fetchCollections,
  };
}
