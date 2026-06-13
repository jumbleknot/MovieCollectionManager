/**
 * Session storage utility (T-029; simplified for the BFF cookie model — constitution §Frontend
 * App "Client Auth Model", Option A).
 *
 * Auth lives entirely in the BFF's `HttpOnly` cookies (web + native): the client holds NO raw
 * access or refresh token. On native, the only thing persisted here is the OPAQUE session id —
 * used purely as a startup "do I appear to be signed in?" hint (`hasStoredSession`), since the
 * HttpOnly cookies are not readable by JS. On web nothing is stored client-side at all (the
 * cookies are the source of truth).
 *
 * (Historical note: this module previously also stored the raw access/refresh tokens in SecureStore
 * and exposed `getAccessToken` for an `Authorization: Bearer` path. That bearer path was never
 * actually used — login always stored empty tokens — and is removed under Option A.)
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// ─── Storage key ────────────────────────────────────────────────────────────────

const SESSION_ID_KEY = 'mcm_session_id';

// ─── Cookie-vs-SecureStore platform split ────────────────────────────────────────

/**
 * Web persists the session in the BFF's HttpOnly cookie (nothing client-side). Native stores only
 * the opaque session id in SecureStore as a startup hydration hint (the cookies drive auth).
 */
function isCookiesPreferred(): boolean {
  return Platform.OS === 'web';
}

// ─── Public API ──────────────────────────────────────────────────────────────────

/**
 * Persist the opaque session id after login (native only; no-op on web where the BFF cookie is the
 * source of truth). The id is a non-sensitive reference, never a raw token.
 */
export async function storeSession(sessionId: string): Promise<void> {
  if (isCookiesPreferred()) return; // BFF cookie handles this on web
  await SecureStore.setItemAsync(SESSION_ID_KEY, sessionId, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Clear the stored session id on logout (native only; no-op on web — the BFF clears its cookies via
 * Set-Cookie).
 */
export async function clearSession(): Promise<void> {
  if (isCookiesPreferred()) return;
  await SecureStore.deleteItemAsync(SESSION_ID_KEY);
}

/**
 * Whether the user appears to be authenticated, for the initial hydration check on app startup.
 * On web this returns true and the BFF `/user` call determines the real auth state; on native it
 * checks the stored opaque session id.
 */
export async function hasStoredSession(): Promise<boolean> {
  if (isCookiesPreferred()) {
    return true; // web: let the BFF /user call validate the session cookie
  }
  return (await SecureStore.getItemAsync(SESSION_ID_KEY)) !== null;
}
