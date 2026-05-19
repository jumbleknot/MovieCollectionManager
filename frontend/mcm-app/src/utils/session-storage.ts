/**
 * Session storage utility (T-029)
 * Handles JWT and session ID persistence across platforms.
 *
 * Strategy:
 *   - Primary: Secure HTTP-only cookies (set by BFF server via Set-Cookie)
 *   - Fallback: expo-secure-store (for platforms where cookies are restricted)
 *
 * The BFF always sets HTTP-only cookies. This utility provides a fallback
 * for client-side token storage on platforms that do not persist cookies
 * (e.g., certain Expo Go environments on Android).
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// ─── Storage keys ──────────────────────────────────────────────────────────────

const KEYS = {
  ACCESS_TOKEN: 'mcm_access_token',
  REFRESH_TOKEN: 'mcm_refresh_token',
  SESSION_ID: 'mcm_session_id',
} as const;

// ─── Cookie support detection ──────────────────────────────────────────────────

/**
 * Returns true if the platform supports persistent HTTP-only cookies
 * set by the BFF (i.e., web and React Native with full cookie support).
 * On Android/iOS in some Expo environments, cookies may not persist
 * across requests — use SecureStore as fallback.
 */
function isCookiesPreferred(): boolean {
  return Platform.OS === 'web';
}

// ─── Secure Store helpers ──────────────────────────────────────────────────────

async function storeSecure(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

async function retrieveSecure(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

async function deleteSecure(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Store tokens in SecureStore (fallback for non-web platforms).
 * On web, tokens are stored in HTTP-only cookies by the BFF; this is a no-op.
 */
export async function storeTokens(
  accessToken: string,
  refreshToken: string,
  sessionId: string,
): Promise<void> {
  if (isCookiesPreferred()) return; // BFF cookies handle storage on web

  await Promise.all([
    storeSecure(KEYS.ACCESS_TOKEN, accessToken),
    storeSecure(KEYS.REFRESH_TOKEN, refreshToken),
    storeSecure(KEYS.SESSION_ID, sessionId),
  ]);
}

/**
 * Retrieve the access token (SecureStore fallback path only).
 * On web, access token comes from HTTP-only cookies via BFF.
 */
export async function getAccessToken(): Promise<string | null> {
  if (isCookiesPreferred()) return null; // Token is in cookie, not accessible client-side
  return retrieveSecure(KEYS.ACCESS_TOKEN);
}

/**
 * Retrieve the session ID (used by non-web platforms to send in requests).
 */
export async function getSessionId(): Promise<string | null> {
  if (isCookiesPreferred()) return null; // Session ID is in cookie
  return retrieveSecure(KEYS.SESSION_ID);
}

/**
 * Clear all stored auth data (called on logout).
 */
export async function clearTokens(): Promise<void> {
  if (isCookiesPreferred()) return; // BFF clears cookies via Set-Cookie on logout

  await Promise.all([
    deleteSecure(KEYS.ACCESS_TOKEN),
    deleteSecure(KEYS.REFRESH_TOKEN),
    deleteSecure(KEYS.SESSION_ID),
  ]);
}

/**
 * Check whether the user appears to be authenticated based on stored state.
 * Used for initial hydration check on app startup.
 */
export async function hasStoredSession(): Promise<boolean> {
  if (isCookiesPreferred()) {
    // On web, we rely on BFF to validate the session cookie — return true and
    // let the BFF /profile call determine actual auth state.
    return true;
  }

  const sessionId = await retrieveSecure(KEYS.SESSION_ID);
  return sessionId !== null;
}
