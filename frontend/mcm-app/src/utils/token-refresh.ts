/**
 * Token refresh utility (T-030)
 * Core silent background refresh logic — called by the Axios interceptor (T-068)
 * and the auth context when the access token is expiring.
 *
 * Refresh strategy (BFF cookie model — constitution §Frontend App "Client Auth Model", Option A):
 *   1. POST /bff-api/auth/refresh — BFF exchanges the refresh-token cookie for new tokens
 *   2. On success: the BFF sets new HttpOnly cookies via Set-Cookie. On BOTH web and native the
 *      client stores NO raw token — React Native's native cookie jar holds the rotated cookies, so
 *      the next request (incl. the CopilotKit agent /run XHR, which sends cookies via RN's
 *      `withCredentials=true` default) authenticates with the fresh access cookie. This function
 *      therefore persists nothing client-side by design (it previously claimed a SecureStore
 *      fallback that it never performed — removed for accuracy).
 *   3. On failure: clear session and redirect to login
 *   4. Rate limit: 1/30s with max 2 retries (enforced server-side)
 */

import axios from 'axios';
import { BFF_BASE_URL } from '@/config/bff-url';

// ─── State ─────────────────────────────────────────────────────────────────────

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

// ─── Refresh endpoint ──────────────────────────────────────────────────────────

// Must use raw axios (not apiClient) to avoid circular dependency with the interceptor.
const REFRESH_URL = `${BFF_BASE_URL}/bff-api/auth/refresh`;

// ─── Core refresh function ─────────────────────────────────────────────────────

/**
 * Perform a silent token refresh by calling the BFF /refresh endpoint.
 * Deduplicates concurrent refresh attempts (only one in-flight at a time).
 * Returns true if refresh succeeded, false if the user needs to re-login.
 */
export async function silentRefresh(): Promise<boolean> {
  // Deduplicate concurrent refresh calls
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }

  isRefreshing = true;
  refreshPromise = doRefresh().finally(() => {
    isRefreshing = false;
    refreshPromise = null;
  });

  return refreshPromise;
}

async function doRefresh(): Promise<boolean> {
  try {
    await axios.post(REFRESH_URL, null, {
      withCredentials: true, // Send HTTP-only cookies
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a refresh is currently in progress.
 * Used by the Axios interceptor to queue requests.
 */
export function isRefreshInProgress(): boolean {
  return isRefreshing;
}

/**
 * Wait for the current refresh to complete (if one is in progress).
 * Returns the result of the in-flight refresh.
 */
export async function waitForRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  return false;
}
