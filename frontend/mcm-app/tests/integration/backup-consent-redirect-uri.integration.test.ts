/**
 * The consent callback URI is registered, and the existing ones survive (feature 073, T056 —
 * FR-022).
 *
 * THE WAY THIS TASK GOES WRONG is not the new URI failing to appear — it is one of the existing
 * three quietly disappearing. `ensureClientRedirectUris` is handed a LIST and writes a list, so
 * a caller that passes only the new URI silently unregisters web login, email verification and
 * the native callback. Nothing fails at deploy time; the app keeps working until somebody hits
 * the flow whose URI went missing, and the error surfaces at Keycloak with nothing pointing
 * back at this change. So all four are asserted, not just the new one.
 *
 * Against REAL Keycloak: the claim is about what the identity provider has recorded.
 */
import { ensureClientRedirectUris, __clearDiscoveryCache } from '@/bff-server/keycloak';
import { env } from '@/config/env';

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8099';
const REALM = process.env.KEYCLOAK_REALM ?? 'grumpyrobot';
const BASE_URL = process.env['EXPO_PUBLIC_BFF_BASE_URL'] ?? 'http://localhost:8081';

const CREDS_PRESENT = Boolean(process.env.KEYCLOAK_SERVICE_CLIENT_SECRET);
if (!CREDS_PRESENT && process.env.MCM_REQUIRE_LIVE_STACK === '1') {
  throw new Error('backup-consent-redirect-uri requires KEYCLOAK_SERVICE_CLIENT_SECRET');
}
const describeLive = CREDS_PRESENT ? describe : describe.skip;

async function registeredRedirectUris(): Promise<string[]> {
  const tokenRes = await fetch(`${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.KEYCLOAK_SERVICE_CLIENT_ID ?? 'mcm-bff-service',
      client_secret: process.env.KEYCLOAK_SERVICE_CLIENT_SECRET ?? '',
    }).toString(),
  });
  const { access_token: adminToken } = (await tokenRes.json()) as { access_token: string };
  const res = await fetch(
    `${KEYCLOAK_URL}/admin/realms/${REALM}/clients?clientId=${encodeURIComponent(env.keycloakClientId)}`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  const [client] = (await res.json()) as { redirectUris: string[] }[];
  return client.redirectUris;
}

describeLive('consent callback redirect URI', () => {
  beforeAll(() => {
    __clearDiscoveryCache();
  });

  it('registers the consent callback without dropping the three that were already there', async () => {
    await ensureClientRedirectUris([
      `${BASE_URL}/auth-callback`,
      `${BASE_URL}/login?verified=true`,
      'mcm-app://native-auth-callback',
      `${BASE_URL}/bff-api/backups/consent`,
    ]);

    const registered = await registeredRedirectUris();

    expect(registered).toContain(`${BASE_URL}/bff-api/backups/consent`);
    // The three that must survive.
    expect(registered).toContain(`${BASE_URL}/auth-callback`);
    expect(registered).toContain(`${BASE_URL}/login?verified=true`);
    expect(registered).toContain('mcm-app://native-auth-callback');
  });

  it('is idempotent — a second call adds no duplicate', async () => {
    const before = await registeredRedirectUris();
    await ensureClientRedirectUris([`${BASE_URL}/bff-api/backups/consent`]);
    const after = await registeredRedirectUris();

    expect(after.sort()).toEqual(before.sort());
    expect(new Set(after).size).toBe(after.length);
  });
});
