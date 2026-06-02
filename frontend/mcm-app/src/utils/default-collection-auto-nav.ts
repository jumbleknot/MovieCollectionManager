/**
 * Tracks whether the post-login auto-navigation to the user's default collection
 * has already fired this session, so the redirect happens once per login rather
 * than on every visit to /home.
 *
 * Traceability: implements requirement FR-009 (auto-navigate to default collection).
 *
 * `_sessionFired` is a module-level variable that persists across component
 * remounts for the lifetime of the JavaScript context (browser tab or native
 * app session). This prevents the "navigate to default collection" redirect
 * from firing every time the user visits /home within the same session.
 *
 * Responsibilities:
 *   isAutoNavDone()  — returns true if FR-009 has already fired this session
 *   markAutoNavDone() — call immediately before the redirect so re-visits skip it
 *   clearAutoNav()   — call on login and logout so the redirect fires fresh after login
 *
 * On web, sessionStorage backs the flag so it survives page.goto() reloads within
 * the same browser tab (needed for E2E test stability and F5-refresh correctness).
 * sessionStorage is automatically cleared when the browser tab is closed or the
 * browser is restarted — ensuring FR-009 fires correctly on every new login session.
 * On native, the module-level variable alone is sufficient.
 */

import { Platform } from 'react-native';

const AUTO_NAV_STORAGE_KEY = 'mcm_auto_nav_done';

/** Module-level: survives component unmount/remount within the same JS session */
let _sessionFired = false;

export function isAutoNavDone(): boolean {
  if (_sessionFired) return true;
  if (Platform.OS !== 'web') return false;
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(AUTO_NAV_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markAutoNavDone(): void {
  _sessionFired = true;
  if (Platform.OS !== 'web') return;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(AUTO_NAV_STORAGE_KEY, '1');
  } catch {}
}

/** Reset the flag — call on login (refreshAuth) and logout so FR-009 fires again after re-login. */
export function clearAutoNav(): void {
  _sessionFired = false;
  if (Platform.OS !== 'web') return;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(AUTO_NAV_STORAGE_KEY);
  } catch {}
}
