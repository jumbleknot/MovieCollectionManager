/**
 * The standing permission that lets a backup run while the user is away (feature 073, T060 —
 * FR-022/FR-023).
 *
 * `grant()` does not grant anything by itself — it asks the BFF for an authorization URL and
 * hands it back. The caller sends the user there, Keycloak brings them back to the consent
 * callback, and the BFF stores the result. That round trip is the point: the permission is
 * something the user gives at the identity provider, not something this app can award itself.
 */
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/bff-server/api-client';

const BASE = '/bff-api/backups/consent';

export interface ConsentStatus {
  granted: boolean;
  grantedAt: string | null;
}

export interface UseBackupConsentReturn extends ConsentStatus {
  loading: boolean;
  busy: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Returns the URL the user must be sent to, or null if it could not be started. */
  startGrant: () => Promise<string | null>;
  revoke: () => Promise<boolean>;
}

export function useBackupConsent(): UseBackupConsentReturn {
  const [status, setStatus] = useState<ConsentStatus>({ granted: false, grantedAt: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiClient.get<ConsentStatus>(BASE);
      setStatus(res.data);
      setError(null);
    } catch {
      setError('Could not check whether scheduled backups are permitted.');
    } finally {
      setLoading(false);
    }
  }, []);

  // The initial read is a promise CHAIN with an `active` guard, not `void reload()`, matching
  // use-backup-jobs. Calling the async reloader straight from an effect sets state on the
  // effect's own tick, which cascades renders — and it has no unmount guard, so a user who
  // leaves the screen before the request lands gets a setState on a gone component.
  useEffect(() => {
    let active = true;
    apiClient
      .get<ConsentStatus>(BASE)
      .then((res) => {
        if (active) {
          setStatus(res.data);
          setError(null);
        }
      })
      .catch(() => {
        if (active) setError('Could not check whether scheduled backups are permitted.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const startGrant = useCallback(async (): Promise<string | null> => {
    setBusy(true);
    try {
      const res = await apiClient.get<{ authorizationUrl: string }>(`${BASE}?start=1`);
      setError(null);
      return res.data.authorizationUrl;
    } catch {
      setError('Could not start the permission request. Try again.');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const revoke = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      await apiClient.delete(BASE);
      setStatus({ granted: false, grantedAt: null });
      setError(null);
      return true;
    } catch {
      // The BFF answers 502 and KEEPS the permission when the identity provider refused the
      // revocation. Saying "done" here would tell the user a live permission had been taken
      // away when it had not.
      setError('The permission could not be withdrawn just now. Try again in a moment.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { ...status, loading, busy, error, reload, startGrant, revoke };
}
