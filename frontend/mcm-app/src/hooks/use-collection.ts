/**
 * useCollection hook (013 Enhancement 1)
 *
 * Fetches a SINGLE collection's display fields (currently just the name) so the collection
 * screen can show which collection the user is viewing. Read-only and best-effort: a failed
 * fetch leaves `name` null and the header simply hides — it never blocks the movie list.
 *
 * Distinct from useCollections (the list/CRUD hook): this is a lightweight by-id read keyed to
 * the route's collectionId, refreshed when the id changes.
 */

import { useState, useEffect } from 'react';
import { apiClient } from '@/bff-server/api-client';
import type { CollectionSummary } from '@/types/collection';

export interface UseCollectionReturn {
  /** The collection's name, or null until loaded (or on error). */
  name: string | null;
}

export function useCollection(collectionId: string): UseCollectionReturn {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!collectionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiClient.get(`/bff-api/collections/${collectionId}`);
        if (!cancelled) setName((res.data as CollectionSummary).name ?? null);
      } catch {
        // Best-effort: the header is a UI enhancement; keep it hidden on failure.
        if (!cancelled) setName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collectionId]);

  return { name };
}
