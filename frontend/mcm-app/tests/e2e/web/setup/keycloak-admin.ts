/**
 * Keycloak admin helper for web E2E (feature 040 US3 / T032).
 *
 * Mints and tears down throwaway realm users (e.g. a short-lived mc-admin) via the Keycloak Admin
 * REST API, using the SAME service account the BFF uses (client-credentials grant). Reachable from
 * the E2E runner at the published Keycloak port. Test-only — never imported by app code.
 *
 * Env: KEYCLOAK_URL (default the published loopback), KEYCLOAK_REALM, KEYCLOAK_SERVICE_CLIENT_ID,
 * KEYCLOAK_SERVICE_CLIENT_SECRET, KEYCLOAK_CLIENT_ID (the app client that owns mc-admin/mc-user).
 */
import { randomUUID } from 'node:crypto';

const KEYCLOAK_URL = process.env['KEYCLOAK_URL'] ?? 'http://localhost:8099';
const REALM = process.env['KEYCLOAK_REALM'] ?? 'grumpyrobot';
const APP_CLIENT_ID = process.env['KEYCLOAK_CLIENT_ID'] ?? 'movie-collection-manager';
const SERVICE_CLIENT_ID = process.env['KEYCLOAK_SERVICE_CLIENT_ID'] ?? 'mcm-bff-service';
const SERVICE_CLIENT_SECRET = process.env['KEYCLOAK_SERVICE_CLIENT_SECRET'] ?? '';

const TOKEN_EP = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`;
const ADMIN_BASE = `${KEYCLOAK_URL}/admin/realms/${REALM}`;

/** Strong enough for the realm password policy; the user is throwaway + deleted in afterAll. */
export const E2E_ADMIN_PASSWORD = 'E2eAdminP@ss123!';

export interface AdminUser {
  userId: string;
  username: string;
  password: string;
}

/** True when the service-account secret is present — the suite skips cleanly otherwise. */
export function keycloakAdminEnabled(): boolean {
  return SERVICE_CLIENT_SECRET !== '';
}

async function adminToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SERVICE_CLIENT_ID,
    client_secret: SERVICE_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_EP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`admin token failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function appClientInternalId(token: string): Promise<string> {
  const res = await fetch(
    `${ADMIN_BASE}/clients?clientId=${encodeURIComponent(APP_CLIENT_ID)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const id = ((await res.json()) as Array<{ id: string }>)[0]?.id;
  if (!id) throw new Error(`app client ${APP_CLIENT_ID} not found`);
  return id;
}

/**
 * Create an enabled, email-verified user with the given app-client roles + a known password.
 * Pass BOTH `mc-user` and `mc-admin` for an admin — the (app) layout AuthGuard requires `mc-user`,
 * so an mc-admin-only user is bounced from every protected screen (a real admin holds both).
 */
export async function createUserWithRoles(
  usernamePrefix: string,
  roleNames: string[],
): Promise<AdminUser> {
  const token = await adminToken();
  const username = `${usernamePrefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

  const createRes = await fetch(`${ADMIN_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username,
      email: `${username}@test.invalid`,
      firstName: 'E2E',
      lastName: 'Admin',
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: E2E_ADMIN_PASSWORD, temporary: false }],
    }),
  });
  if (!createRes.ok) throw new Error(`createUser failed (${createRes.status}): ${await createRes.text()}`);
  const userId = (createRes.headers.get('Location') ?? '').split('/').pop() ?? '';
  if (!userId) throw new Error('createUser: no id in Location header');

  const clientId = await appClientInternalId(token);
  const roles: Array<{ id: string; name: string }> = [];
  for (const roleName of roleNames) {
    const roleRes = await fetch(
      `${ADMIN_BASE}/clients/${clientId}/roles/${encodeURIComponent(roleName)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!roleRes.ok) throw new Error(`role ${roleName} not found (${roleRes.status})`);
    roles.push((await roleRes.json()) as { id: string; name: string });
  }
  const assignRes = await fetch(
    `${ADMIN_BASE}/users/${userId}/role-mappings/clients/${clientId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(roles),
    },
  );
  if (!assignRes.ok) throw new Error(`assign ${roleNames.join(',')} failed (${assignRes.status})`);

  return { userId, username, password: E2E_ADMIN_PASSWORD };
}

/** Delete a throwaway user. Swallows 404 — cleanup is best-effort. */
export async function deleteUser(userId: string): Promise<void> {
  if (!userId) return;
  const token = await adminToken();
  const res = await fetch(`${ADMIN_BASE}/users/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    // eslint-disable-next-line no-console
    console.warn(`deleteUser(${userId}) returned ${res.status}`);
  }
}
