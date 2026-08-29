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

/**
 * The username prefix global setup mints per-worker identities under (054 US4) — `e2e_w${index}`,
 * to which `createUserWithRoles` appends `_<10 hex>`.
 *
 * Exported so the reaper matches the MINT, rather than a second spelling of it that can drift.
 */
export const WORKER_USERNAME_PREFIX = 'e2e_w';

/**
 * The exact shape `createUserWithRoles(`${WORKER_USERNAME_PREFIX}${i}`, …)` produces.
 *
 * STRUCTURAL, not a `startsWith`. The reaper deletes realm users, so "which users are ours" has to
 * be a property of the name's whole shape rather than of its first five characters. `e2e-test-user`
 * (hyphens), `e2e-admin_…` (the admin-spec prefix) and any `intreg_*` cannot match this pattern —
 * item #183's second acceptance criterion, pinned in tests/unit/keycloak-worker-reaper.test.ts.
 */
const MINTED_WORKER_USERNAME = /^e2e_w\d+_[0-9a-f]{10}$/;

/**
 * How long a minted worker user must have existed before the reaper may delete it.
 *
 * The guard against deleting a CONCURRENTLY running suite's identities (item #183, third criterion).
 * Three hours sits well beyond any single run — the `app-e2e` job's own timeout is 75 minutes and
 * the web suite inside it is ~23 — while still bounding how long a killed run's leftovers survive.
 * An age threshold rather than a runner scope, because the realm carries no runner identity and a
 * leaked user has no record of where it came from; that absence is the defect.
 */
const REAP_MIN_AGE_MS = Number(process.env['E2E_WORKER_REAP_MIN_AGE_MS'] ?? 3 * 60 * 60 * 1000);

export interface RealmUser {
  id: string;
  username: string;
  createdTimestamp?: number;
}

/**
 * Which of the realm's users this run may delete: minted by the per-worker mint, and old enough that
 * they cannot belong to a suite still running.
 *
 * Pure and exported so the two rules that must never be got wrong — never touch a user that is not
 * ours, never touch one that might be in use — are testable without a Keycloak.
 */
export function selectReapableWorkerUsers(
  users: RealmUser[],
  { now = Date.now(), minAgeMs = REAP_MIN_AGE_MS }: { now?: number; minAgeMs?: number } = {},
): RealmUser[] {
  return users.filter((u) => {
    if (!MINTED_WORKER_USERNAME.test(u.username ?? '')) return false;
    // No timestamp means the age cannot be established, and an unestablished age must not read as
    // "old enough". Keycloak always sends one; a build that stopped would otherwise silently turn
    // the reaper into an unconditional delete.
    if (typeof u.createdTimestamp !== 'number') return false;
    return now - u.createdTimestamp >= minAgeMs;
  });
}

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

/**
 * Delete the per-worker identities left behind by runs that never reached teardown (item #183).
 *
 * WHY AT SETUP. Teardown deletes the users it recorded in `.auth/worker-identities.json`, but a run
 * that is KILLED never reaches teardown — and the next run's setup then overwrites that manifest,
 * destroying the only record of the previous run's users. Nothing would ever delete them again.
 * Measured 2026-08-13: five orphans (`e2e_w1…e2e_w5`) in the `grumpyrobot` realm after two runs were
 * stopped mid-flight, with no manifest referencing any of them.
 *
 * Setup always runs, so reaping here is self-healing; the manifest path only works on a clean exit,
 * and a mechanism that works on the happy path alone is one that quietly stops working.
 *
 * Best-effort by design, like teardown: a realm holding a few extra throwaway users is untidy, and a
 * setup that fails a run over untidiness is worse.
 *
 * @returns the number deleted, or null when the reaper could not look (no admin credential).
 */
export async function reapStaleWorkerUsers(
  opts: { now?: number; minAgeMs?: number } = {},
): Promise<number | null> {
  if (!keycloakAdminEnabled()) return null;
  let candidates: RealmUser[];
  try {
    const token = await adminToken();
    // Keycloak's `username` filter is an infix match, so this narrows the fetch; the authoritative
    // decision is selectReapableWorkerUsers, which matches the whole minted shape.
    const res = await fetch(
      `${ADMIN_BASE}/users?username=${encodeURIComponent(WORKER_USERNAME_PREFIX)}&max=1000`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`list users failed (${res.status})`);
    candidates = (await res.json()) as RealmUser[];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[global-setup] could not reap stale worker users: ${(err as Error).message}`);
    return null;
  }

  const stale = selectReapableWorkerUsers(candidates, opts);
  let deleted = 0;
  for (const user of stale) {
    try {
      await deleteUser(user.id);
      deleted += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[global-setup] could not delete ${user.username}: ${(err as Error).message}`);
    }
  }
  return deleted;
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
