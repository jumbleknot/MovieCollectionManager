/**
 * useRegistrationStatus (feature 040 US3 / Item 1).
 * Reads the PUBLIC /bff-api/auth/registration-status so the signed-out login/register screens
 * can show/hide the "Create Account" entry point. Defaults to allowed until known (and on error)
 * — the authoritative block is server-side at /register.
 */

import { useEffect, useState } from 'react';
import { apiClient } from '@/bff-server/api-client';

export interface RegistrationStatus {
  allowed: boolean;
  loading: boolean;
}

export function useRegistrationStatus(): RegistrationStatus {
  const [allowed, setAllowed] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    apiClient
      .get<{ allowed: boolean }>('/bff-api/auth/registration-status')
      .then((res) => {
        if (active) setAllowed(res.data.allowed !== false);
      })
      .catch(() => {
        if (active) setAllowed(true); // never hide the link on a read error
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { allowed, loading };
}
