/**
 * Keycloak configuration (T-019)
 * Client-facing constants for Auth Code + PKCE flow via expo-auth-session.
 * Server-side secrets are loaded from env.ts in BFF server context only.
 */

import { Platform } from 'react-native';

// ─── Redirect URI helpers ──────────────────────────────────────────────────────

// On web browsers, exp:// and mcm-app:// custom schemes are not navigable.
// Must use a dedicated path (not bare origin) so expo-auth-session's popup
// only fires maybeCompleteAuthSession when it actually lands with a code param.
const WEB_REDIRECT_URI = `${process.env['EXPO_PUBLIC_BFF_BASE_URL'] ?? 'http://localhost:8081'}/auth-callback`;

// Always use the custom scheme on native. The exp:// scheme from makeRedirectUri()
// is intercepted by Expo Go if it is installed on the device, routing the deep link
// to the wrong app and breaking the OAuth callback.
const NATIVE_REDIRECT_URI = 'mcm-app://bff-api/auth/callback';

function computeRedirectUri(): string {
  if (Platform.OS === 'web') return WEB_REDIRECT_URI;
  return NATIVE_REDIRECT_URI;
}

// ─── Exported Keycloak config ──────────────────────────────────────────────────

export const KEYCLOAK_REALM = process.env['KEYCLOAK_REALM'] ?? 'jumbleknot';

// Web uses KEYCLOAK_URL (localhost:8099). Native needs EXPO_PUBLIC_KEYCLOAK_NATIVE_URL
// because the emulator/device cannot reach "localhost" on the host machine.
export const KEYCLOAK_URL =
  Platform.OS !== 'web'
    ? (process.env['EXPO_PUBLIC_KEYCLOAK_NATIVE_URL'] ?? 'http://10.0.2.2:8099')
    : (process.env['KEYCLOAK_URL'] ?? 'http://localhost:8099');

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
