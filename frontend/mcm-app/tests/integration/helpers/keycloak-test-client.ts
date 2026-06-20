/**
 * Keycloak test client (T002).
 *
 * Test-only helper for integration tests: acquires real tokens via the
 * Resource Owner Password Credentials (ROPC / "direct access") grant on the
 * dedicated `mcm-bff-test` client, and manages short-lived test users through
 * the Keycloak Admin REST API.
 *
 * Uses raw `fetch` against the Keycloak token + Admin endpoints, mirroring
 * `src/bff-server/keycloak.ts` (client-credentials admin token → bearer →
 * `/admin/realms/{realm}/...`). Deliberately NO `@keycloak/keycloak-admin-client`
 * dependency — the BFF itself uses raw `fetch`, and this feature adds no new deps.
 *
 * The ROPC grant is enabled ONLY on the test client and MUST never be enabled on
 * the production `movie-collection-manager` client. Never import this helper into
 * production code.
 */
import { randomUUID } from 'node:crypto';

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8099';
const REALM = process.env.KEYCLOAK_REALM ?? 'grumpyrobot';
const APP_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'movie-collection-manager';

// ROPC (direct-grant) test client — credentials from .env.e2e.local
const ROPC_CLIENT_ID = process.env.E2E_ROPC_CLIENT_ID ?? 'mcm-bff-test';
const ROPC_CLIENT_SECRET = process.env.E2E_ROPC_CLIENT_SECRET ?? '';

// Service account used for Admin REST calls (same account the BFF uses)
const SERVICE_CLIENT_ID = process.env.KEYCLOAK_SERVICE_CLIENT_ID ?? 'mcm-bff-service';
const SERVICE_CLIENT_SECRET = process.env.KEYCLOAK_SERVICE_CLIENT_SECRET ?? '';

const TOKEN_ENDPOINT = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`;
const ADMIN_BASE = `${KEYCLOAK_URL}/admin/realms/${REALM}`;

// Password meeting the realm policy; reused for created test users.
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'TestPass1!ok';

export interface TestTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

export interface TestUser {
  userId: string;
  username: string;
  password: string;
}

export interface KeycloakSession {
  id: string;
  userId: string;
  start: number;
  lastAccess: number;
}

// ─── Token acquisition (ROPC) ────────────────────────────────────────────────

/** Acquire real tokens for `username`/`password` via the direct-grant test client. */
export async function getTestTokens(username: string, password: string): Promise<TestTokens> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: ROPC_CLIENT_ID,
    client_secret: ROPC_CLIENT_SECRET,
    username,
    password,
    scope: 'openid',
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ROPC token request failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    id_token: string;
  };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, idToken: data.id_token };
}

// ─── Admin API ───────────────────────────────────────────────────────────────

async function getAdminToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SERVICE_CLIENT_ID,
    client_secret: SERVICE_CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Admin token request failed (${res.status}): ${detail}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Create a unique test user (username = `${prefix}-${uuid}`), enabled and
 * email-verified, with `TEST_PASSWORD`. Returns its id, username, and password.
 */
export async function createTestUser(usernamePrefix: string): Promise<TestUser> {
  const adminToken = await getAdminToken();
  const username = `${usernamePrefix}-${randomUUID().slice(0, 8)}`;

  const res = await fetch(`${ADMIN_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      username,
      email: `${username}@test.invalid`,
      firstName: 'Int',
      lastName: 'Test',
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: TEST_PASSWORD, temporary: false }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`createTestUser failed (${res.status}): ${detail}`);
  }

  const userId = (res.headers.get('Location') ?? '').split('/').pop() ?? '';
  if (!userId) throw new Error('createTestUser: no user id in Location header');
  return { userId, username, password: TEST_PASSWORD };
}

/** Delete a test user. Swallows 404 (already deleted) — cleanup is best-effort. */
export async function deleteTestUser(userId: string): Promise<void> {
  if (!userId) return;
  const adminToken = await getAdminToken();
  const res = await fetch(`${ADMIN_BASE}/users/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok && res.status !== 404) {
    // Non-fatal: log and continue so a teardown failure never breaks the suite.
    // eslint-disable-next-line no-console
    console.warn(`deleteTestUser(${userId}) returned ${res.status}`);
  }
}

/** Fetch a user representation via the Admin API (for registration verification). */
export async function getUserById(
  userId: string,
): Promise<{ id: string; username: string; emailVerified: boolean; enabled: boolean }> {
  const adminToken = await getAdminToken();
  const res = await fetch(`${ADMIN_BASE}/users/${userId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) throw new Error(`getUserById failed (${res.status})`);
  return (await res.json()) as { id: string; username: string; emailVerified: boolean; enabled: boolean };
}

/** Names of the app-client roles mapped to the user (e.g. ['mc-user']). */
export async function getUserClientRoles(userId: string): Promise<string[]> {
  const adminToken = await getAdminToken();
  const authz = { Authorization: `Bearer ${adminToken}` };

  const clientsRes = await fetch(
    `${ADMIN_BASE}/clients?clientId=${encodeURIComponent(APP_CLIENT_ID)}`,
    { headers: authz },
  );
  const clientInternalId = ((await clientsRes.json()) as Array<{ id: string }>)[0]?.id;
  if (!clientInternalId) throw new Error(`getUserClientRoles: client ${APP_CLIENT_ID} not found`);

  const rolesRes = await fetch(
    `${ADMIN_BASE}/users/${userId}/role-mappings/clients/${clientInternalId}`,
    { headers: authz },
  );
  if (!rolesRes.ok) return [];
  return ((await rolesRes.json()) as Array<{ name: string }>).map((r) => r.name);
}

/** Active Keycloak SSO sessions for the user (used to verify logout termination). */
export async function getUserSessions(userId: string): Promise<KeycloakSession[]> {
  const adminToken = await getAdminToken();
  const res = await fetch(`${ADMIN_BASE}/users/${userId}/sessions`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) throw new Error(`getUserSessions failed (${res.status})`);
  return (await res.json()) as KeycloakSession[];
}

/**
 * Ensure the ROPC test client issues access tokens whose `aud` includes the app
 * client (`movie-collection-manager`). Idempotent.
 *
 * `token-service.validateJwt` accepts a token only if `aud` includes the app
 * client id OR `azp === app client id`. A token from `mcm-bff-test` has
 * `azp=mcm-bff-test` and `aud=[account]` by default, so without this audience
 * mapper the real validator rejects every test token as "Invalid token audience".
 * Adding the mapper to the TEST client (never the production client) makes ROPC
 * tokens pass the same validation path the BFF uses in production.
 */
export async function ensureRopcAudienceMapper(): Promise<void> {
  const adminToken = await getAdminToken();
  const authz = { Authorization: `Bearer ${adminToken}` };

  const clientsRes = await fetch(
    `${ADMIN_BASE}/clients?clientId=${encodeURIComponent(ROPC_CLIENT_ID)}`,
    { headers: authz },
  );
  const ropc = ((await clientsRes.json()) as Array<{ id: string }>)[0];
  if (!ropc) throw new Error(`ROPC client ${ROPC_CLIENT_ID} not found`);

  const mappersRes = await fetch(
    `${ADMIN_BASE}/clients/${ropc.id}/protocol-mappers/models`,
    { headers: authz },
  );
  const mappers = (await mappersRes.json()) as Array<{ config?: Record<string, string> }>;
  const exists = mappers.some((m) => m.config?.['included.client.audience'] === APP_CLIENT_ID);
  if (exists) return;

  const res = await fetch(`${ADMIN_BASE}/clients/${ropc.id}/protocol-mappers/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authz },
    body: JSON.stringify({
      name: `aud-${APP_CLIENT_ID}`,
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      config: {
        'included.client.audience': APP_CLIENT_ID,
        'id.token.claim': 'false',
        'access.token.claim': 'true',
      },
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`ensureRopcAudienceMapper failed (${res.status})`);
  }
}

/**
 * Ensure the ROPC test client issues access tokens whose `aud` includes an ARBITRARY
 * client id. Idempotent. Used to satisfy Keycloak standard token exchange's precondition
 * that the requesting client be within the subject token's audience (T023: the BFF's
 * `agent-subject-token` requester must be in the user token's `aud`, otherwise Keycloak
 * returns `access_denied: "Client is not within the token audience"`). Added to the TEST
 * client only — production satisfies the same rule via realm config on the app client.
 */
export async function ensureRopcAudienceFor(audienceClientId: string): Promise<void> {
  const adminToken = await getAdminToken();
  const authz = { Authorization: `Bearer ${adminToken}` };

  const clientsRes = await fetch(
    `${ADMIN_BASE}/clients?clientId=${encodeURIComponent(ROPC_CLIENT_ID)}`,
    { headers: authz },
  );
  const ropc = ((await clientsRes.json()) as Array<{ id: string }>)[0];
  if (!ropc) throw new Error(`ROPC client ${ROPC_CLIENT_ID} not found`);

  const mappersRes = await fetch(
    `${ADMIN_BASE}/clients/${ropc.id}/protocol-mappers/models`,
    { headers: authz },
  );
  const mappers = (await mappersRes.json()) as Array<{ config?: Record<string, string> }>;
  if (mappers.some((m) => m.config?.['included.client.audience'] === audienceClientId)) return;

  const res = await fetch(`${ADMIN_BASE}/clients/${ropc.id}/protocol-mappers/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authz },
    body: JSON.stringify({
      name: `aud-${audienceClientId}`,
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      config: {
        'included.client.audience': audienceClientId,
        'id.token.claim': 'false',
        'access.token.claim': 'true',
      },
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`ensureRopcAudienceFor(${audienceClientId}) failed (${res.status})`);
  }
}

/**
 * Ensure an ARBITRARY client issues tokens whose `aud` includes `audienceClientId`,
 * by adding an `oidc-audience-mapper` to it. Idempotent. Used to make a downscope
 * audience "available" to a token-exchange requester (T023: `agent-subject-token` must be
 * able to produce `aud=agent-gateway`, else Keycloak returns `invalid_request: "Requested
 * audience not available"`). The production equivalent is applied by the T012 script
 * (configure-token-exchange.mjs); this keeps the integration test hermetic / CI-safe.
 * No-op (returns false) if `targetClientId` does not exist (T012 not applied → test skips).
 */
export async function ensureClientAudienceMapper(
  targetClientId: string,
  audienceClientId: string,
): Promise<boolean> {
  const adminToken = await getAdminToken();
  const authz = { Authorization: `Bearer ${adminToken}` };

  const clientsRes = await fetch(
    `${ADMIN_BASE}/clients?clientId=${encodeURIComponent(targetClientId)}`,
    { headers: authz },
  );
  const client = ((await clientsRes.json()) as Array<{ id: string }>)[0];
  if (!client) return false;

  const mappersRes = await fetch(
    `${ADMIN_BASE}/clients/${client.id}/protocol-mappers/models`,
    { headers: authz },
  );
  const mappers = (await mappersRes.json()) as Array<{ config?: Record<string, string> }>;
  if (mappers.some((m) => m.config?.['included.client.audience'] === audienceClientId)) return true;

  const res = await fetch(`${ADMIN_BASE}/clients/${client.id}/protocol-mappers/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authz },
    body: JSON.stringify({
      name: `aud-${audienceClientId}`,
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      config: {
        'included.client.audience': audienceClientId,
        'id.token.claim': 'false',
        'access.token.claim': 'true',
      },
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`ensureClientAudienceMapper(${targetClientId}->${audienceClientId}) failed (${res.status})`);
  }
  return true;
}

/** Assign a client role (e.g. `mc-user`) on the app client to the user. */
export async function assignRole(userId: string, roleName: string): Promise<void> {
  const adminToken = await getAdminToken();
  const authz = { Authorization: `Bearer ${adminToken}` };

  const clientsRes = await fetch(
    `${ADMIN_BASE}/clients?clientId=${encodeURIComponent(APP_CLIENT_ID)}`,
    { headers: authz },
  );
  const clientInternalId = ((await clientsRes.json()) as Array<{ id: string }>)[0]?.id;
  if (!clientInternalId) throw new Error(`assignRole: client ${APP_CLIENT_ID} not found`);

  const roleRes = await fetch(
    `${ADMIN_BASE}/clients/${clientInternalId}/roles/${encodeURIComponent(roleName)}`,
    { headers: authz },
  );
  if (!roleRes.ok) throw new Error(`assignRole: role ${roleName} not found (${roleRes.status})`);
  const role = (await roleRes.json()) as { id: string; name: string };

  const assignRes = await fetch(
    `${ADMIN_BASE}/users/${userId}/role-mappings/clients/${clientInternalId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authz },
      body: JSON.stringify([role]),
    },
  );
  if (!assignRes.ok) throw new Error(`assignRole: assignment failed (${assignRes.status})`);
}
