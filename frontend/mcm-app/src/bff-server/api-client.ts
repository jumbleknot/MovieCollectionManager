/**
 * Axios API client with JWT injection and refresh interceptor (T-068 + T-069)
 * Wire the silent refresh interceptor: on 401, attempt token refresh then retry.
 */

import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { silentRefresh, isRefreshInProgress, waitForRefresh } from '@/utils/token-refresh';
import { getAccessToken } from '@/utils/session-storage';

const MAX_RETRY = 1;

function createApiClient(): AxiosInstance {
  const client = axios.create({
    baseURL: '/',
    withCredentials: true,
    timeout: 15_000,
    headers: { 'Content-Type': 'application/json' },
  });

  // Request interceptor — attach access token if available
  client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    const token = await getAccessToken();
    if (token) {
      config.headers.set('Authorization', `Bearer ${token}`);
    }
    return config;
  });

  // Response interceptor — silently refresh on 401 and retry once
  client.interceptors.response.use(
    (res) => res,
    async (error: AxiosError) => {
      const originalReq = error.config as InternalAxiosRequestConfig & { _retryCount?: number };

      if (
        error.response?.status !== 401 ||
        !originalReq ||
        (originalReq._retryCount ?? 0) >= MAX_RETRY
      ) {
        return Promise.reject(error);
      }

      originalReq._retryCount = (originalReq._retryCount ?? 0) + 1;

      // If a refresh is already in flight, wait for it
      if (isRefreshInProgress()) {
        await waitForRefresh();
      } else {
        await silentRefresh();
      }

      return client(originalReq);
    },
  );

  return client;
}

export const apiClient = createApiClient();
