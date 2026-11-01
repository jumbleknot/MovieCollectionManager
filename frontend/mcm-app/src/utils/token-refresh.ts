/**
 * Token refresh utility (T-030)
 * Core silent background refresh logic — called by the Axios interceptor (T-068)
 * and the auth context when the access token is expiring.
 *
 * Refresh strategy (BFF cookie model — constitution §Frontend App "Client Auth Model", Option A):
 *   1. POST /bff-api/auth/refresh — the BFF renews the member's tokens, which it holds server-side
 *      inside the session (feature 085). The request carries only the session cookie.
 *   2. On success: nothing is stored client-side, on web or native — there is no token to store. The
 *      BFF re-sets only the session cookie; the next request (incl. the CopilotKit agent /run XHR,
 *      which sends cookies via RN's `withCredentials=true` default) authenticates with it.
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
