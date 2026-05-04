/**
 * Keycloak configuration (T-019)
 * Client-facing constants for Auth Code + PKCE flow via expo-auth-session.
 * Server-side secrets are loaded from env.ts in BFF server context only.
 */

// ─── Development / Production redirect URIs ────────────────────────────────────

const DEV_REDIRECT_URI = 'exp://localhost:8081/--/bff-api/auth/callback';
const PROD_REDIRECT_URI = 'mcm-app://bff-api/auth/callback';

const isDev = process.env['NODE_ENV'] !== 'production';

// ─── Exported Keycloak config ──────────────────────────────────────────────────

export const KEYCLOAK_REALM = process.env['KEYCLOAK_REALM'] ?? 'jumbleknot';
export const KEYCLOAK_URL = process.env['KEYCLOAK_URL'] ?? 'http://localhost:8080';
export const KEYCLOAK_CLIENT_ID = process.env['KEYCLOAK_CLIENT_ID'] ?? 'movie-collection-manager';

export const KEYCLOAK_ISSUER = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;

export const KEYCLOAK_DISCOVERY_ENDPOINT = `${KEYCLOAK_ISSUER}/.well-known/openid-configuration`;

export const REDIRECT_URI = isDev ? DEV_REDIRECT_URI : PROD_REDIRECT_URI;

export const keycloakConfig = {
  realm: KEYCLOAK_REALM,
  url: KEYCLOAK_URL,
  clientId: KEYCLOAK_CLIENT_ID,
  issuer: KEYCLOAK_ISSUER,
  discoveryEndpoint: KEYCLOAK_DISCOVERY_ENDPOINT,
  redirectUri: REDIRECT_URI,

  // Token lifetimes
  accessTokenTtlSeconds: 900,      // 15 minutes
  refreshTokenTtlSeconds: 604800,  // 7 days

  // PKCE code challenge method
  codeChallengeMethod: 'S256' as const,

  // Keycloak Admin API
  adminApiBase: `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}`,
} as const;

export default keycloakConfig;
