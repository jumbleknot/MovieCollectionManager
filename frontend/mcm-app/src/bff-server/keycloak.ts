/**
 * Keycloak client service (T-021)
 * Server-side only — never imported by client-side code.
 * Handles OAuth2 token exchange, user management, and email verification
 * via the Keycloak REST API (token endpoint) and Admin API.
 */

import { env } from '@/config/env';
import { keycloakConfig } from '@/config/keycloak';
import type { JWTPayload, KeycloakUser, RegisterRequest } from '@/types/auth';
import { AuthError, AuthErrorCode } from '@/types/errors';

// ─── Token response from Keycloak token endpoint ───────────────────────────────

interface KeycloakTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in: number;
  scope: string;
}

// ─── Discovery document ────────────────────────────────────────────────────────

interface OidcDiscovery {
  token_endpoint: string;
  authorization_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint: string;
  jwks_uri: string;
}

let cachedDiscovery: OidcDiscovery | null = null;

async function getDiscovery(): Promise<OidcDiscovery> {
  if (cachedDiscovery) return cachedDiscovery;

  const res = await fetch(keycloakConfig.discoveryEndpoint);
  if (!res.ok) {
    throw new AuthError(
      AuthErrorCode.KEYCLOAK_UNAVAILABLE,
      'Failed to fetch Keycloak discovery document',
      503,
    );
  }
  cachedDiscovery = (await res.json()) as OidcDiscovery;
  return cachedDiscovery;
}

// ─── Admin API helpers ──────────────────────────────────────────────────────────

async function getAdminToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: env.keycloakAdminUser,
    password: env.keycloakAdminPassword,
  });

  const res = await fetch(
    `${env.keycloakUrl}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  );

  if (!res.ok) {
    throw new AuthError(
      AuthErrorCode.KEYCLOAK_UNAVAILABLE,
      'Failed to obtain Keycloak admin token',
      503,
    );
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Exchange an authorization code + PKCE code verifier for tokens.
 * Called by the BFF /login endpoint after receiving the auth code from the client.
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<KeycloakTokenResponse> {
  const discovery = await getDiscovery();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.keycloakClientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  // Include client secret only for confidential clients
  if (env.keycloakClientSecret) {
    body.set('client_secret', env.keycloakClientSecret);
  }

  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errData = (await res.json().catch(() => ({}))) as { error?: string };
    if (errData.error === 'invalid_grant') {
      throw new AuthError(AuthErrorCode.AUTH_CODE_INVALID, 'Invalid or expired authorization code', 400);
    }
    throw new AuthError(AuthErrorCode.INVALID_CREDENTIALS, 'Token exchange failed', 400);
  }

  return res.json() as Promise<KeycloakTokenResponse>;
}

/**
 * Exchange a refresh token for new access + refresh tokens (silent refresh).
 */
export async function refreshTokens(refreshToken: string): Promise<KeycloakTokenResponse> {
  const discovery = await getDiscovery();

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.keycloakClientId,
    refresh_token: refreshToken,
  });

  if (env.keycloakClientSecret) {
    body.set('client_secret', env.keycloakClientSecret);
  }

  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new AuthError(AuthErrorCode.REFRESH_FAILED, 'Token refresh failed', 401);
  }

  return res.json() as Promise<KeycloakTokenResponse>;
}

/**
 * Revoke a token (access or refresh) at Keycloak.
 * Used during logout.
 */
export async function revokeToken(token: string, tokenTypeHint: 'access_token' | 'refresh_token'): Promise<void> {
  const body = new URLSearchParams({
    client_id: env.keycloakClientId,
    token,
    token_type_hint: tokenTypeHint,
  });

  if (env.keycloakClientSecret) {
    body.set('client_secret', env.keycloakClientSecret);
  }

  const revokeUrl = `${keycloakConfig.issuer}/protocol/openid-connect/revoke`;
  await fetch(revokeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  // Revocation errors are non-fatal — token will expire naturally
}

/**
 * Create a new user in Keycloak via the Admin API.
 * Returns the new user's Keycloak UUID.
 */
export async function createUser(request: RegisterRequest): Promise<string> {
  const adminToken = await getAdminToken();

  const res = await fetch(`${keycloakConfig.adminApiBase}/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      username: request.username,
      email: request.email,
      firstName: request.firstName,
      lastName: request.lastName,
      enabled: true,
      emailVerified: false,
      credentials: [
        {
          type: 'password',
          value: request.password,
          temporary: false,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errData = (await res.json().catch(() => ({}))) as { errorMessage?: string };
    if (res.status === 409) {
      if (errData.errorMessage?.toLowerCase().includes('username')) {
        throw new AuthError(AuthErrorCode.DUPLICATE_USERNAME, 'Username already exists', 409);
      }
      throw new AuthError(AuthErrorCode.DUPLICATE_EMAIL, 'Email already registered', 409);
    }
    throw new AuthError(AuthErrorCode.INVALID_INPUT, 'Failed to create user', 400);
  }

  // Keycloak returns the user URL in the Location header
  const location = res.headers.get('Location') ?? '';
  const userId = location.split('/').pop() ?? '';
  if (!userId) {
    throw new AuthError(AuthErrorCode.UNKNOWN, 'Failed to retrieve new user ID', 500);
  }

  return userId;
}

/**
 * Assign the mc-user client role to a newly registered user.
 */
export async function assignMcUserRole(userId: string): Promise<void> {
  const adminToken = await getAdminToken();

  // Fetch the mc-user role representation from the client
  const clientsRes = await fetch(
    `${keycloakConfig.adminApiBase}/clients?clientId=${env.keycloakClientId}`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  const clients = (await clientsRes.json()) as Array<{ id: string }>;
  const clientInternalId = clients[0]?.id;

  if (!clientInternalId) {
    throw new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Client not found in Keycloak', 500);
  }

  const rolesRes = await fetch(
    `${keycloakConfig.adminApiBase}/clients/${clientInternalId}/roles/mc-user`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  const role = await rolesRes.json() as { id: string; name: string };

  await fetch(
    `${keycloakConfig.adminApiBase}/users/${userId}/role-mappings/clients/${clientInternalId}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify([role]),
    },
  );
}

/**
 * Trigger Keycloak to send a verification email for the given user.
 * Pass redirectUri so Keycloak redirects back to the app after verification.
 */
export async function sendVerificationEmail(userId: string, redirectUri?: string): Promise<void> {
  const adminToken = await getAdminToken();

  const params = new URLSearchParams({ client_id: env.keycloakClientId });
  if (redirectUri) {
    params.set('redirect_uri', redirectUri);
  }

  const res = await fetch(
    `${keycloakConfig.adminApiBase}/users/${userId}/send-verify-email?${params.toString()}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
    },
  );

  if (!res.ok) {
    throw new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Failed to send verification email', 502);
  }
}

/**
 * Retrieve user details from Keycloak Admin API by user ID.
 */
export async function getUserById(userId: string): Promise<KeycloakUser> {
  const adminToken = await getAdminToken();

  const res = await fetch(
    `${keycloakConfig.adminApiBase}/users/${userId}`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );

  if (!res.ok) {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'User not found', 404);
  }

  return res.json() as Promise<KeycloakUser>;
}

/**
 * Decode (but not verify) a JWT payload.
 * Verification is done separately in token-service.ts using the JWKS endpoint.
 */
export function decodeJwtPayload(token: string): JWTPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthError(AuthErrorCode.AUTH_CODE_INVALID, 'Malformed JWT token', 400);
  }
  const payload = parts[1];
  if (!payload) {
    throw new AuthError(AuthErrorCode.AUTH_CODE_INVALID, 'Malformed JWT token', 400);
  }
  const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
  return JSON.parse(decoded) as JWTPayload;
}

/** @internal For testing only — resets the OIDC discovery cache. */
export function __clearDiscoveryCache(): void {
  cachedDiscovery = null;
}

// ─── Keycloak Client Configuration ─────────────────────────────────────────────

// Module-level cache: track whether redirect URIs have been verified this process lifetime.
let redirectUrisEnsured = false;

/**
 * Ensure the Keycloak client's redirectUris list includes all required URIs.
 * Called once per process lifetime. Safe to call multiple times (no-op if already done).
 * Used to register the web redirect URI (http://localhost:8081) which is needed
 * for PKCE login flow in web browsers.
 */
export async function ensureClientRedirectUris(uris: string[]): Promise<void> {
  if (redirectUrisEnsured) return;

  try {
    const adminToken = await getAdminToken();

    // Find the client's internal Keycloak ID
    const clientsRes = await fetch(
      `${keycloakConfig.adminApiBase}/clients?clientId=${encodeURIComponent(env.keycloakClientId)}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    if (!clientsRes.ok) return;

    const clients = (await clientsRes.json()) as Array<{ id: string }>;
    const clientId = clients[0]?.id;
    if (!clientId) return;

    // Fetch the full client representation
    const clientRes = await fetch(
      `${keycloakConfig.adminApiBase}/clients/${clientId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    if (!clientRes.ok) return;

    const client = (await clientRes.json()) as Record<string, unknown> & { redirectUris?: string[] };
    const existing = client.redirectUris ?? [];
    const missing = uris.filter((u) => !existing.includes(u));

    if (missing.length > 0) {
      await fetch(
        `${keycloakConfig.adminApiBase}/clients/${clientId}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ ...client, redirectUris: [...existing, ...missing] }),
        },
      );
    }

    redirectUrisEnsured = true;
  } catch {
    // Non-fatal — the user may need to add the redirect URI manually
  }
}
