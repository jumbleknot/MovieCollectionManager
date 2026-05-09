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

export const env = {
  // Keycloak (server-side BFF — not exposed to client)
  keycloakUrl: requireEnv('KEYCLOAK_URL', 'http://localhost:8099'),
  keycloakRealm: requireEnv('KEYCLOAK_REALM', 'jumbleknot'),
  keycloakClientId: requireEnv('KEYCLOAK_CLIENT_ID', 'movie-collection-manager'),
  keycloakClientSecret: requireEnv('KEYCLOAK_CLIENT_SECRET', ''),

  // Keycloak Admin (server-side BFF only)
  keycloakAdminUser: requireEnv('KEYCLOAK_ADMIN_USER', 'admin'),
  keycloakAdminPassword: requireEnv('KEYCLOAK_ADMIN_PASSWORD', ''),

  // Redis (server-side BFF only)
  redisUrl: requireEnv('REDIS_URL', 'redis://localhost:6379'),

  // Cookie signing (server-side BFF only)
  cookieSecret: requireEnv('COOKIE_SECRET', ''),

  // Session config
  sessionIdleTimeoutMs: parseInt(optionalEnv('SESSION_IDLE_TIMEOUT_MS', '1800000'), 10),  // 30 min
  sessionAbsoluteTimeoutMs: parseInt(optionalEnv('SESSION_ABSOLUTE_TIMEOUT_MS', '86400000'), 10), // 24 hr
  maxConcurrentSessions: parseInt(optionalEnv('MAX_CONCURRENT_SESSIONS', '10'), 10),

  // App
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  isDevelopment: optionalEnv('NODE_ENV', 'development') === 'development',
} as const;
