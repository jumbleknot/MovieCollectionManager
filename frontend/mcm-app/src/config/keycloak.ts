/**
 * Keycloak configuration (T-019)
 * Client-facing constants for Auth Code + PKCE flow via expo-auth-session.
 * Server-side secrets are loaded from env.ts in BFF server context only.
 */

import { Platform } from 'react-native';

// ─── Redirect URI helpers ──────────────────────────────────────────────────────

// Always use the custom scheme on native. The exp:// scheme from makeRedirectUri()
// is intercepted by Expo Go if it is installed on the device, routing the deep link
// to the wrong app and breaking the OAuth callback.
const NATIVE_REDIRECT_URI = 'mcm-app://native-auth-callback';

function computeRedirectUri(): string {
  if (Platform.OS === 'web') {
    // Use window.location.origin at runtime so the redirect URI is correct for any
    // deployment without requiring EXPO_PUBLIC_BFF_BASE_URL to be set at build time.
    // Falls back to the build-time env var (or localhost default) during SSR.
    const base = typeof window !== 'undefined' && window.location != null
      ? window.location.origin
      : (process.env['EXPO_PUBLIC_BFF_BASE_URL'] || 'http://localhost:8081');
    return `${base}/auth-callback`;
  }
  return NATIVE_REDIRECT_URI;
}

// ─── Exported Keycloak config ──────────────────────────────────────────────────

export const KEYCLOAK_REALM = process.env['KEYCLOAK_REALM'] ?? 'grumpyrobot';

// The browser performs the OAuth authorize redirect, so on web the Keycloak host must be inlinable
// into the client bundle — i.e. an EXPO_PUBLIC_* var (Metro only inlines that prefix). A plain
// KEYCLOAK_URL is NOT visible in the browser, so a deployed web build silently used the localhost:8099
// default (prod bug). Prefer EXPO_PUBLIC_KEYCLOAK_URL (baked at web-export = https://auth.<domain>),
// then KEYCLOAK_URL (SSR/tests), then the local default. Native uses EXPO_PUBLIC_KEYCLOAK_NATIVE_URL
// because the emulator/device cannot reach "localhost" on the host machine.
export const KEYCLOAK_URL =
  Platform.OS !== 'web'
    ? (process.env['EXPO_PUBLIC_KEYCLOAK_NATIVE_URL'] ?? 'http://10.0.2.2:8099')
    : (process.env['EXPO_PUBLIC_KEYCLOAK_URL'] ?? process.env['KEYCLOAK_URL'] ?? 'http://localhost:8099');

export const KEYCLOAK_CLIENT_ID = process.env['KEYCLOAK_CLIENT_ID'] ?? 'movie-collection-manager';

export const KEYCLOAK_ISSUER = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;

export const KEYCLOAK_DISCOVERY_ENDPOINT = `${KEYCLOAK_ISSUER}/.well-known/openid-configuration`;

export const keycloakConfig = {
  realm: KEYCLOAK_REALM,
  url: KEYCLOAK_URL,
  clientId: KEYCLOAK_CLIENT_ID,
  issuer: KEYCLOAK_ISSUER,
  discoveryEndpoint: KEYCLOAK_DISCOVERY_ENDPOINT,

  // Getter so makeRedirectUri() is evaluated lazily, not at import time.
  get redirectUri(): string { return computeRedirectUri(); },

  // Token lifetimes
  accessTokenTtlSeconds: 900,      // 15 minutes
  refreshTokenTtlSeconds: 604800,  // 7 days

  // PKCE code challenge method
  codeChallengeMethod: 'S256' as const,

  // Keycloak Admin API
  adminApiBase: `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}`,
};

export default keycloakConfig;
