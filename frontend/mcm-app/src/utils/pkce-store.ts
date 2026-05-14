/**
 * Module-level store for PKCE code verifier and redirect URI.
 *
 * On native, Expo Router intercepts the mcm-app:// deep link before
 * expo-auth-session can capture it, so the callback screen needs the
 * codeVerifier to complete the PKCE exchange independently.
 * Stored at module scope (lives for the JS context lifetime — seconds only).
 */

let _codeVerifier: string | null = null;
let _redirectUri: string | null = null;

export function storePkce(codeVerifier: string, redirectUri: string): void {
  _codeVerifier = codeVerifier;
  _redirectUri = redirectUri;
}

export function consumePkce(): { codeVerifier: string | null; redirectUri: string | null } {
  const result = { codeVerifier: _codeVerifier, redirectUri: _redirectUri };
  _codeVerifier = null;
  _redirectUri = null;
  return result;
}
