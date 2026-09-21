/**
 * The consent route — authorization and contract (feature 073, T053 — FR-022/FR-023/FR-034).
 *
 * Real users, real Keycloak, the real BFF over HTTP.
 *
 * THE FIRST TEST IS A POSITIVE CONTROL, for the same reason as in the other backups authz
 * suites: most assertions below are satisfied by a BFF where this route does not exist at all,
 * so without one case proving the happy path, "all green" would mean nothing.
 *
 * NOTE THE DIFFERENCE FROM THE TICK ROUTE, which 404s rather than 401s. This one is
 * user-facing and reached with a session, so an unauthenticated caller gets the ordinary 401
 * every other user route gives. The tick is internal and must not admit it exists; conflating
 * the two would either leak the tick or make this route behave unlike its neighbours.
 */
import { randomUUID } from 'node:crypto';

import { createBffClient } from './helpers/bff-test-server';
import {
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  ensureRopcAudienceMapper,
  type TestUser,
} from './helpers/keycloak-test-client';
import { getAgentConfigCollection, closeMongo } from '@/bff-server/mongo-client';

const bff = createBffClient();
const CONSENT = '/bff-api/backups/consent';

const CREDS_PRESENT = Boolean(process.env.KEYCLOAK_SERVICE_CLIENT_SECRET && process.env.E2E_TEST_PASSWORD);
if (!CREDS_PRESENT && process.env.MCM_REQUIRE_LIVE_STACK === '1') {
  throw new Error('backup-consent-routes requires KEYCLOAK_SERVICE_CLIENT_SECRET and E2E_TEST_PASSWORD');
}
const describeLive = CREDS_PRESENT ? describe : describe.skip;

jest.setTimeout(60_000);

describeLive('backup consent route', () => {
  let userA: TestUser;
  let userB: TestUser;
  let tokenA: string;
  let tokenB: string;

  const authA = () => ({ headers: { Authorization: `Bearer ${tokenA}` } });
  const authB = () => ({ headers: { Authorization: `Bearer ${tokenB}` } });

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    userA = await createTestUser('t053-consent-a');
    userB = await createTestUser('t053-consent-b');
    await assignRole(userA.userId, 'mc-user');
    await assignRole(userB.userId, 'mc-user');
    tokenA = (await getTestTokens(userA.username, userA.password)).accessToken;
    tokenB = (await getTestTokens(userB.username, userB.password)).accessToken;
  });

  afterAll(async () => {
    const config = await getAgentConfigCollection();
    await config.deleteMany({ _id: { $in: [userA?.userId, userB?.userId] } });
    await deleteTestUser(userA?.userId);
    await deleteTestUser(userB?.userId);
    await closeMongo();
  });

  it('POSITIVE CONTROL — reports "not granted" for a user who has never consented', async () => {
    const res = await bff.get(CONSENT, authA());
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ granted: false, grantedAt: null });
  });

  it('refuses an unauthenticated caller with 401, not 404', async () => {
    // Unlike the tick route. This one is user-facing, so it behaves like its neighbours.
    expect((await bff.get(CONSENT)).status).toBe(401);
    expect((await bff.delete(CONSENT)).status).toBe(401);
  });

  it('starts a round trip that asks Keycloak for offline access, with PKCE', async () => {
    const res = await bff.get(`${CONSENT}?start=1`, authA());
    expect(res.status).toBe(200);

    const url = new URL(res.data.authorizationUrl);
    expect(url.searchParams.get('scope')?.split(' ')).toContain('offline_access');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    // THE VERIFIER MUST NOT BE IN THE RESPONSE AT ALL. A verifier the browser holds is one an
    // attacker who has intercepted the authorization code can also use — which is the whole
    // attack PKCE exists to prevent. It stays server-side in Redis.
    expect(JSON.stringify(res.data)).not.toContain('codeVerifier');
    expect(Object.keys(res.data)).toEqual(['authorizationUrl']);
  });

  it('refuses a callback when no round trip is pending', async () => {
    // Nothing started, so there is no verifier and no state to match. A route that tried the
    // exchange anyway would be accepting an authorization code from anywhere.
    const res = await bff.get(`${CONSENT}?code=made-up&state=made-up`, authB());
    expect(res.status).toBe(400);
  });

  it('refuses a callback whose state does not match the one that was started', async () => {
    await bff.get(`${CONSENT}?start=1`, authA());
    const res = await bff.get(`${CONSENT}?code=made-up&state=${randomUUID()}`, authA());
    expect(res.status).toBe(400);
  });

  it('consumes the pending request, so a code cannot be replayed', async () => {
    await bff.get(`${CONSENT}?start=1`, authA());
    // First callback attempt takes the stashed request (and fails on the bogus state).
    await bff.get(`${CONSENT}?code=made-up&state=wrong`, authA());
    // Second finds nothing pending at all — single use.
    const res = await bff.get(`${CONSENT}?code=made-up&state=wrong`, authA());
    expect(res.status).toBe(400);
    expect(String(res.data.detail ?? res.data.title)).toMatch(/start again/i);
  });

  it('one user cannot start or complete another user\'s consent', async () => {
    // A started in the line below; B's callback must not be able to complete it. The pending
    // request is keyed by the AUTHENTICATED user, so B's callback simply finds nothing.
    await bff.get(`${CONSENT}?start=1`, authA());
    const res = await bff.get(`${CONSENT}?code=made-up&state=whatever`, authB());
    expect(res.status).toBe(400);
    // And A's pending request is untouched by B's attempt.
    expect((await bff.get(CONSENT, authA())).data.granted).toBe(false);
  });

  it('withdrawing a permission nobody granted is a no-op, not an error', async () => {
    const res = await bff.delete(CONSENT, authB());
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ granted: false });
  });
});
