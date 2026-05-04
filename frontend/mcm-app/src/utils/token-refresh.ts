/**
 * Token refresh utility (T-030)
 * Core silent background refresh logic — called by the Axios interceptor (T-068)
 * and the auth context when the access token is expiring.
 *
 * Refresh strategy:
 *   1. POST /bff-api/auth/refresh — BFF exchanges refresh token cookie for new tokens
 *   2. On success: BFF sets new HTTP-only cookies; client stores via SecureStore fallback
 *   3. On failure: Clear session and redirect to login
 *   4. Rate limit: 1/30s with max 2 retries (enforced server-side)
 */

import axios from 'axios';

// ─── State ─────────────────────────────────────────────────────────────────────

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

// ─── Refresh endpoint ──────────────────────────────────────────────────────────

const REFRESH_URL = '/bff-api/auth/refresh';

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
