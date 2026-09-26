/**
 * Axios API client with the BFF refresh interceptor (T-068 + T-069).
 *
 * Auth model: BFF cookies (constitution §Frontend App "Client Auth Model", Option A). The client
 * sends NO `Authorization: Bearer` header — `withCredentials: true` carries the BFF's HttpOnly
 * session/access cookies (web same-origin; native via RN's cookie jar). On a 401 the response
 * interceptor silently refreshes (POST /auth/refresh re-sets the cookies) and retries once.
 *
 * @client-safe: this is the CLIENT's transport TO the BFF, not BFF-server code. It runs in the
 * browser and in the RN runtime — carrying the caller's own cookies is the whole point of it — and
 * 18 hooks and screens import it by design. It sits under `src/bff-server/` only because of that
 * directory's name, which describes the thing it talks to rather than where it runs; relocating it
 * is tracked as item #566. Feature 077's server-import gate reads this marker
 * (scripts/check-no-server-imports.mjs) and exempts the module; the marker is here, rather than in
 * an allowlist inside the gate, so it is visible to whoever reads this file next.
 */

import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { silentRefresh, isRefreshInProgress, waitForRefresh } from '@/utils/token-refresh';
import { BFF_BASE_URL } from '@/config/bff-url';

const MAX_RETRY = 1;

function createApiClient(): AxiosInstance {
  const client = axios.create({
    baseURL: BFF_BASE_URL || '/',
    withCredentials: true, // send the BFF HttpOnly cookies (no client-side bearer token)
    timeout: 15_000,
    headers: { 'Content-Type': 'application/json' },
  });

  // Response interceptor — silently refresh on 401 and retry once
  client.interceptors.response.use(
    (res) => res,
    async (error: AxiosError) => {
      const originalReq = error.config as InternalAxiosRequestConfig & { _retryCount?: number };

      // Never retry the login endpoint — auth codes are single-use; a retry would
      // send the already-consumed code and receive AUTH_CODE_INVALID.
      const url = originalReq?.url ?? '';
      if (
        error.response?.status !== 401 ||
        !originalReq ||
        (originalReq._retryCount ?? 0) >= MAX_RETRY ||
        url.includes('/bff-api/auth/login')
      ) {
        return Promise.reject(error);
      }

      originalReq._retryCount = (originalReq._retryCount ?? 0) + 1;

      // If a refresh is already in flight, wait for it
      const refreshed = isRefreshInProgress()
        ? await waitForRefresh()
        : await silentRefresh();

      if (!refreshed) {
        return Promise.reject(error);
      }

      return client(originalReq);
    },
  );

  return client;
}

export const apiClient = createApiClient();
