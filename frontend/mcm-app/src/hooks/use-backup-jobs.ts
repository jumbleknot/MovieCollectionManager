/**
 * useBackupJobs (feature 073, US2/US3) — the caller's backup jobs, runs and versions.
 *
 * Every call is session-scoped server-side; there is no userId to pass and the API has nowhere
 * to put one.
 */
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/bff-server/api-client';
import { getErrorMessage } from '@/utils/errors';
import type { BackupJob, BackupVersion, RunSummary, Schedule } from '@/types/backups';

const BASE = '/bff-api/backups/jobs';

export type JobView = Omit<BackupJob, '_id' | 'userId'> & { id: string };

export interface JobDraft {
  destinationId: string;
  label: string;
  collectionIds: string[];
  keepLast: number;
  enabled: boolean;
  schedule?: Schedule;
}

export interface RestoreOutcome {
  createdCollectionIds: string[];
  movieCount: number;
  partial: boolean;
}

export interface UseBackupJobsReturn {
  jobs: JobView[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (draft: JobDraft) => Promise<JobView | null>;
  update: (id: string, patch: Partial<JobDraft>) => Promise<JobView | null>;
  remove: (id: string) => Promise<boolean>;
  runNow: (id: string) => Promise<RunSummary | null>;
  listRuns: (id: string) => Promise<RunSummary[]>;
  listVersions: (id: string) => Promise<BackupVersion[]>;
  restore: (id: string, key: string) => Promise<RestoreOutcome | null>;
  downloadUrl: (id: string, key: string) => string;
}

export function useBackupJobs(): UseBackupJobsReturn {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiClient.get<JobView[]>(BASE);
      setJobs(res.data);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiClient
      .get<JobView[]>(BASE)
      .then((res) => {
        if (active) {
          setJobs(res.data);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const mutate = useCallback(
    async <T,>(work: () => Promise<T>, refresh = true): Promise<T | null> => {
      setBusy(true);
      try {
        const value = await work();
        setError(null);
        if (refresh) await reload();
        return value;
      } catch (err) {
        setError(getErrorMessage(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  return {
    jobs,
    loading,
    busy,
    error,
    reload,
    create: (draft) => mutate(async () => (await apiClient.post<JobView>(BASE, draft)).data),
    update: (id, patch) => mutate(async () => (await apiClient.patch<JobView>(`${BASE}/${id}`, patch)).data),
    remove: async (id) => (await mutate(async () => { await apiClient.delete(`${BASE}/${id}`); return true; })) ?? false,
    runNow: (id) => mutate(async () => (await apiClient.post<RunSummary>(`${BASE}/${id}/run`, {})).data),
    listRuns: async (id) => (await mutate(async () => (await apiClient.get<RunSummary[]>(`${BASE}/${id}/runs`)).data, false)) ?? [],
    listVersions: async (id) => (await mutate(async () => (await apiClient.get<BackupVersion[]>(`${BASE}/${id}/versions`)).data, false)) ?? [],
    restore: (id, key) => mutate(async () => (await apiClient.post<RestoreOutcome>(`${BASE}/${id}/restore`, { key })).data),
    // A plain link, so the browser handles the download. The key is guessable and the handle is
    // NOT a capability — the server re-checks ownership from the session on every request.
    downloadUrl: (id, key) => `${BASE}/${id}/download?key=${encodeURIComponent(key)}`,
  };
}
