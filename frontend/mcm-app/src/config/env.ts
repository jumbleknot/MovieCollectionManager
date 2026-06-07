/**
 * Environment variable loader (T-019)
 * All env vars must be prefixed with EXPO_PUBLIC_ to be available client-side.
 * Server-side (BFF) vars are read directly from process.env.
 */

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

const keycloakUrl = requireEnv('KEYCLOAK_URL', 'http://localhost:8099');
const keycloakRealm = requireEnv('KEYCLOAK_REALM', 'jumbleknot');

export const env = {
  // Keycloak (server-side BFF — not exposed to client)
  // keycloakUrl is the INTERNAL connect URL the BFF uses to reach Keycloak (JWKS, token,
  // admin). keycloakPublicUrl is the BROWSER-facing issuer URL — what the user authenticates
  // against, and therefore the `iss` stamped on tokens. They differ only when the BFF reaches
  // Keycloak at a different host than the browser (e.g. Dockerized BFF: connect via
  // keycloak-service:8080 while the browser + token issuer are localhost:8099). Defaults to
  // keycloakUrl, so single-URL dev and production deployments are unchanged.
  keycloakUrl,
  keycloakPublicUrl: optionalEnv('KEYCLOAK_PUBLIC_URL') || keycloakUrl,
  keycloakRealm,
  // Admin REST API base — derived from the INTERNAL keycloakUrl (runtime), so admin calls
  // (user creation, role assignment, SSO logout, email verification) reach Keycloak from
  // inside a container instead of the build-inlined localhost:8099.
  keycloakAdminApiBase: `${keycloakUrl}/admin/realms/${keycloakRealm}`,
  keycloakClientId: requireEnv('KEYCLOAK_CLIENT_ID', 'movie-collection-manager'),
  keycloakClientSecret: requireEnv('KEYCLOAK_CLIENT_SECRET', ''),

  // Keycloak service account for Admin API calls (server-side BFF only)
  keycloakServiceClientId: requireEnv('KEYCLOAK_SERVICE_CLIENT_ID', 'mcm-bff-service'),
  keycloakServiceClientSecret: requireEnv('KEYCLOAK_SERVICE_CLIENT_SECRET', ''),

  // Redis (server-side BFF only)
  redisUrl: requireEnv('REDIS_URL', 'redis://localhost:6379'),

  // Cookie signing (server-side BFF only)
  cookieSecret: requireEnv('COOKIE_SECRET', ''),

  // Session config
  sessionIdleTimeoutMs: parseInt(optionalEnv('SESSION_IDLE_TIMEOUT_MS', '1800000'), 10),  // 30 min
  sessionAbsoluteTimeoutMs: parseInt(optionalEnv('SESSION_ABSOLUTE_TIMEOUT_MS', '86400000'), 10), // 24 hr
  maxConcurrentSessions: parseInt(optionalEnv('MAX_CONCURRENT_SESSIONS', '10'), 10),

  // mc-service (server-side BFF only — never exposed to client)
  mcServiceUrl: requireEnv('MC_SERVICE_URL', 'http://localhost:3001'),

  // Rate-limit client identity (009 finding #4). When true, the BFF runs behind a
  // trusted reverse proxy that sets X-Forwarded-For, so the client IP is derived
  // from it (right-most hop). When false (default), client-supplied XFF is NOT
  // trusted and IP-scoped rate limiting is skipped (no shared lockout bucket).
  // Non-loopback deployments MUST set TRUSTED_PROXY=true behind the proxy.
  trustProxy: optionalEnv('TRUSTED_PROXY', 'false') === 'true',

  // Agent assistant rate/cost limits (feature 012, FR-020a / SC-011). Per-user
  // request rate limit (default 20 req / 60 s) + per-user/session cost ceiling
  // (default $0.50; per-turn cost supplied by LangFuse via T030). Breach → friendly
  // "try again later" with no action; reuses the existing Redis rate-limiter.
  agentRateLimitRequests: parseInt(optionalEnv('AGENT_RATE_LIMIT_REQUESTS', '20'), 10),
  agentRateLimitWindowMs: parseInt(optionalEnv('AGENT_RATE_LIMIT_WINDOW_MS', '60000'), 10),
  agentSessionCostCeilingUsd: parseFloat(optionalEnv('AGENT_SESSION_COST_CEILING_USD', '0.50')),

  // App
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  isDevelopment: optionalEnv('NODE_ENV', 'development') === 'development',
} as const;
