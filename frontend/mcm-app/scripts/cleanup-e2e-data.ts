/**
 * T019 — on-demand E2E data cleanup (FR-015, SC-008).
 *
 * Use after a crashed/aborted test run that left data behind. Deletes:
 *   1. Every non-fixture collection for the E2E user (via the BFF, authenticated
 *      through a one-off OIDC login — reuses the same flow as global setup).
 *   2. Orphaned test users in Keycloak (via the Admin REST API using the
 *      service-account client-credentials grant — same mechanism as the BFF).
 *      The login account (E2E_TEST_USER) is NEVER deleted.
 *
 * Run from frontend/mcm-app with the BFF/Keycloak env available:
 *   npx tsx scripts/cleanup-e2e-data.ts
 *
 * Env: E2E_TEST_USER, E2E_TEST_PASSWORD (login),
 *      KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_SERVICE_CLIENT_ID,
 *      KEYCLOAK_SERVICE_CLIENT_SECRET (user cleanup; skipped if absent).
 *
 * Note: this is dev tooling, not production code — it calls Keycloak Admin directly
 * with the existing service-account credentials rather than adding a BFF user-delete
 * endpoint (the spec forbids new production code for this feature).
 */

import { chromium, request, type APIRequestContext } from '@playwright/test';
import { cleanupNonFixtureCollections } from '../tests/e2e/web/setup/e2e-cleanup';
import { requireEnv } from '../tests/e2e/web/setup/load-e2e-env';

const BASE = 'http://localhost:8081';
// Feature 027 US4: credentials from .env.e2e.local / env — no hardcoded fallback.
const USER = requireEnv('E2E_TEST_USER');
const PASS = requireEnv('E2E_TEST_PASSWORD');

const KC_URL = process.env['KEYCLOAK_URL'] ?? 'http://localhost:8099';
const REALM = process.env['KEYCLOAK_REALM'] ?? 'grumpyrobot';
const SVC_ID = process.env['KEYCLOAK_SERVICE_CLIENT_ID'];
const SVC_SECRET = process.env['KEYCLOAK_SERVICE_CLIENT_SECRET'];

// Username prefixes used by registration test flows. The login account (USER) is
// always excluded so this never deletes the dedicated E2E user.
const TEST_USER_PREFIXES = ['pw', 'e2e_'];

async function loginAndCleanCollections(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/(auth)/login`);
    await page.waitForSelector('[data-testid="login-screen"]', { timeout: 20000 });
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 20000 }),
      page.click('[data-testid="btn-login-with-keycloak"]'),
    ]);
    try {
      await popup.waitForSelector('input[name="username"]', { timeout: 15000 });
      await popup.fill('input[name="username"]', USER);
      await popup.fill('input[name="password"]', PASS);
      await popup.press('input[name="password"]', 'Enter');
    } catch {
      // SSO session already active.
    }
    await popup.waitForEvent('close', { timeout: 25000 }).catch(() => {});
    await page.goto(`${BASE}/home`);
    await Promise.race([
      page.waitForSelector('[data-testid="home-route"]', { state: 'visible', timeout: 60000 }),
      page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }),
    ]);

    const api: APIRequestContext = await request.newContext({
      baseURL: BASE,
      storageState: await ctx.storageState(),
    });
    try {
      await cleanupNonFixtureCollections(api);
      console.log('collections: non-fixture collections deleted');
    } finally {
      await api.dispose();
    }
  } finally {
    await browser.close();
  }
}

async function cleanTestUsers(): Promise<void> {
  if (!SVC_ID || !SVC_SECRET) {
    console.log('users: skipped (set KEYCLOAK_SERVICE_CLIENT_ID/SECRET to enable)');
    return;
  }
  const tokenRes = await fetch(`${KC_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SVC_ID,
      client_secret: SVC_SECRET,
    }),
  });
  if (!tokenRes.ok) {
    console.log('users: failed to obtain admin token', tokenRes.status);
    return;
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const adminBase = `${KC_URL}/admin/realms/${REALM}`;
  const seen = new Set<string>();
  let deleted = 0;

  for (const prefix of TEST_USER_PREFIXES) {
    const res = await fetch(`${adminBase}/users?username=${encodeURIComponent(prefix)}&max=1000`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!res.ok) continue;
    const users = (await res.json()) as Array<{ id: string; username: string }>;
    for (const u of users) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      if (u.username === USER) continue; // never delete the login account
      if (!TEST_USER_PREFIXES.some((p) => u.username.startsWith(p))) continue;
      const del = await fetch(`${adminBase}/users/${u.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (del.ok) deleted++;
    }
  }
  console.log(`users: deleted ${deleted} orphaned test user(s)`);
}

async function main(): Promise<void> {
  await loginAndCleanCollections();
  await cleanTestUsers();
  console.log('cleanup complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
