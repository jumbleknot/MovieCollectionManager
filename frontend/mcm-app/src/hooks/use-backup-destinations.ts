/**
 * useBackupDestinations (feature 073, US1) — the caller's own backup destinations.
 *
 * Every call is scoped by the session server-side; there is no userId to pass, and the API
 * deliberately has nowhere to put one.
 *
 * A destination's secret is WRITE-ONLY throughout. Nothing here ever holds one after it has been
 * sent, and nothing the server returns contains one — so an edit form starts with an empty
 * secret field, and that is a property of the design rather than an oversight in the form.
 */
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/bff-server/api-client';
import { backupErrorMessage } from '@/hooks/backup-error-message';
import type { BackupDestinationView, BackupTestResult } from '@/types/backups';

const BASE = '/bff-api/backups/destinations';

export interface DestinationDraft {
  type: 's3' | 'webdav';
  label: string;
  endpoint: string;
  basePath?: string;
  bucket?: string;
  region?: string;
  pathStyle?: boolean;
  accessKeyId?: string;
  username?: string;
  secret?: string;
}

export interface UseBackupDestinationsReturn {
  destinations: BackupDestinationView[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (draft: DestinationDraft) => Promise<BackupDestinationView | null>;
  update: (id: string, patch: Partial<DestinationDraft>) => Promise<BackupDestinationView | null>;
  remove: (id: string) => Promise<boolean>;
  test: (input: DestinationDraft | { destinationId: string }) => Promise<BackupTestResult>;
}

export function useBackupDestinations(): UseBackupDestinationsReturn {
  const [destinations, setDestinations] = useState<BackupDestinationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiClient.get<BackupDestinationView[]>(BASE);
      setDestinations(res.data);
      setError(null);
    } catch (err) {
      setError(backupErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiClient
      .get<BackupDestinationView[]>(BASE)
      .then((res) => {
        if (active) {
          setDestinations(res.data);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(backupErrorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const create = useCallback(
    async (draft: DestinationDraft) => {
      setBusy(true);
      try {
        const res = await apiClient.post<BackupDestinationView>(BASE, draft);
        setError(null);
        await reload();
        return res.data;
      } catch (err) {
        setError(backupErrorMessage(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const update = useCallback(
    async (id: string, patch: Partial<DestinationDraft>) => {
      setBusy(true);
      try {
        // An omitted `secret` PRESERVES the stored one (FR-003). The form sends the field only
        // when the user actually typed a new value, so "save without retyping the password" is
        // the default behaviour rather than a special case.
        const res = await apiClient.patch<BackupDestinationView>(`${BASE}/${id}`, patch);
        setError(null);
        await reload();
        return res.data;
      } catch (err) {
        setError(backupErrorMessage(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await apiClient.delete(`${BASE}/${id}`);
        setError(null);
        await reload();
        return true;
      } catch (err) {
        setError(backupErrorMessage(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const test = useCallback(async (input: DestinationDraft | { destinationId: string }) => {
    setBusy(true);
    try {
      const res = await apiClient.post<BackupTestResult>(`${BASE}/test`, input);
      return res.data;
    } catch (err) {
      return { ok: false as const, reason: backupErrorMessage(err) };
    } finally {
      setBusy(false);
    }
  }, []);

  return { destinations, loading, busy, error, reload, create, update, remove, test };
}
