import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ColumnKey, ColumnVisibility } from '@/types/collection';

const DEFAULT_VISIBLE_COLUMNS: ColumnVisibility = {
  year: true,
  contentType: true,
  language: false,
  owned: true,
  ripped: true,
  childrens: false,
  genres: false,
  rated: false,
  ownedMedia: true,
  ripQuality: true,
  runtime: false,
  directors: false,
  actors: false,
};

function storageKey(userId: string): string {
  return `@mcm:columnVisibility:${userId}`;
}

export interface UseColumnVisibilityResult {
  visibleColumns: ColumnVisibility;
  toggleColumn: (col: ColumnKey) => void;
  isLoaded: boolean;
}

/**
 * Persists per-user column visibility in AsyncStorage.
 * Falls back to FR-018 defaults on first use or parse error.
 * On web, AsyncStorage uses localStorage; on native it uses the device store.
 */
export function useColumnVisibility(userId: string): UseColumnVisibilityResult {
  const [visibleColumns, setVisibleColumns] = useState<ColumnVisibility>(DEFAULT_VISIBLE_COLUMNS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(storageKey(userId))
      .then(raw => {
        if (cancelled) return;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Partial<ColumnVisibility>;
            setVisibleColumns(prev => ({ ...prev, ...parsed }));
          } catch {
            // Corrupted storage — fall back to defaults silently
          }
        }
        setIsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setIsLoaded(true);
      });
    return () => { cancelled = true; };
  }, [userId]);

  const toggleColumn = useCallback((col: ColumnKey): void => {
    setVisibleColumns(prev => {
      const next = { ...prev, [col]: !prev[col] };
      AsyncStorage.setItem(storageKey(userId), JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [userId]);

  return { visibleColumns, toggleColumn, isLoaded };
}
