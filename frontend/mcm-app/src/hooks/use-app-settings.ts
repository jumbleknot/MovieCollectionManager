/**
 * useAppSettings (feature 040 US3 / Item 1) — mc-admin only.
 * Reads/writes the global app settings via the requireMcAdmin-gated /bff-api/admin/settings.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/bff-server/api-client';
import { getErrorMessage } from '@/utils/errors';
import type { AppSettings } from '@/types/app-settings';

export interface UseAppSettingsReturn {
  settings: AppSettings | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setAllowSelfRegistration: (allowed: boolean) => Promise<void>;
}

export function useAppSettings(): UseAppSettingsReturn {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiClient.get<AppSettings>('/bff-api/admin/settings');
      setSettings(res.data);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load — inline promise chain so setState only runs in async callbacks (never
  // synchronously inside the effect body). `loading` starts true and is cleared in finally.
  useEffect(() => {
    let active = true;
    apiClient
      .get<AppSettings>('/bff-api/admin/settings')
      .then((res) => {
        if (active) {
          setSettings(res.data);
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

  const setAllowSelfRegistration = useCallback(async (allowed: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiClient.patch<AppSettings>('/bff-api/admin/settings', {
        allowSelfRegistration: allowed,
      });
      setSettings(res.data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, loading, saving, error, reload, setAllowSelfRegistration };
}
