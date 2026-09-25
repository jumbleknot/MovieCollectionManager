/**
 * The account-deletion routes — authorization and contract (feature 076, T019 — FR-002, FR-005,
 * FR-010, FR-012).
 *
 * Real users, real Keycloak, the real BFF over HTTP. The pipeline's own behaviour is covered by
 * `account-deletion.integration.test.ts`; this covers the HTTP surface in front of it.
 *
 * THE FIRST TEST IS A POSITIVE CONTROL, for the same reason the consent suite has one: most of
 * the assertions below would also be satisfied by a BFF where these routes do not exist at all.
 * Without one case proving the happy path, "all green" would mean nothing.
 *
 * NOTHING HERE DELETES AN ACCOUNT, and that is the point being asserted rather than a limitation
 * of the test. Every route-level path that skips the step-up must refuse, so the only cases that
 * can reach the pipeline are ones this suite cannot construct without a real re-authentication.
 */
import { createBffClient } from './helpers/bff-test-server';
import {
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  findUsersByUsername,
  ensureRopcAudienceMapper,
  type TestUser,
} from './helpers/keycloak-test-client';
import { getAgentConfigCollection, closeMongo } from '@/bff-server/mongo-client';

const bff = createBffClient();
const CHALLENGE = '/bff-api/account/delete-challenge';
const CALLBACK = '/bff-api/account/delete';

const CREDS_PRESENT = Boolean(
  process.env.KEYCLOAK_SERVICE_CLIENT_SECRET && process.env.E2E_TEST_PASSWORD,
);
if (!CREDS_PRESENT && process.env.MCM_REQUIRE_LIVE_STACK === '1') {
  throw new Error('account-delete-routes requires KEYCLOAK_SERVICE_CLIENT_SECRET and E2E_TEST_PASSWORD');
}
const describeLive = CREDS_PRESENT ? describe : describe.skip;

jest.setTimeout(60_000);

describeLive('account deletion routes', () => {
  let userA: TestUser;
  let userB: TestUser;
  let tokenA: string;
  let tokenB: string;

  const authA = () => ({ headers: { Authorization: `Bearer ${tokenA}` } });
  const authB = () => ({ headers: { Authorization: `Bearer ${tokenB}` } });
  // The callback answers with a 302 by design; axios must not follow it, or the assertion
  // would be about wherever it landed rather than about what this route returned.
  const noFollowA = () => ({ ...authA(), maxRedirects: 0 });
  const noFollowB = () => ({ ...authB(), maxRedirects: 0 });

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    userA = await createTestUser('t019-route-a');
    userB = await createTestUser('t019-route-b');
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

  it('POSITIVE CONTROL — issues a step-up authorization URL to a signed-in user', async () => {
    const res = await bff.post(CHALLENGE, {}, authA());

    expect(res.status).toBe(200);
    expect(Object.keys(res.data)).toEqual(['authorizationUrl']);
  });

  it('forces a FRESH authentication, so a live session cannot satisfy the step-up', async () => {
    const res = await bff.post(CHALLENGE, {}, authA());
    const url = new URL(res.data.authorizationUrl);

    // Measured in T001: with max_age=0 Keycloak re-prompts even when the SSO session is live
    // and would otherwise be reused. Without these two, a stolen session completes the step-up.
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('asks for openid only — never an offline token', async () => {
    const res = await bff.post(CHALLENGE, {}, authA());
    const url = new URL(res.data.authorizationUrl);

    // The consent flow asks for offline_access because it establishes a standing permission.
    // Minting one inside the flow whose purpose is to destroy one would be perverse.
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(res.data.authorizationUrl).not.toContain('offline_access');
  });

  it('never returns the PKCE verifier to the caller', async () => {
    const res = await bff.post(CHALLENGE, {}, authA());

    // A verifier the browser holds is one an attacker with the authorization code can also use.
    expect(JSON.stringify(res.data)).not.toContain('codeVerifier');
    expect(new URL(res.data.authorizationUrl).searchParams.get('code_verifier')).toBeNull();
  });

  it('refuses an unauthenticated challenge with 401', async () => {
    expect((await bff.post(CHALLENGE, {})).status).toBe(401);
  });

  it('refuses an unauthenticated callback with 401, before taking anything from Redis', async () => {
    expect((await bff.get(`${CALLBACK}?code=made-up&state=made-up`)).status).toBe(401);
  });

  it('refuses a callback when no round trip is pending, and deletes nothing', async () => {
    const res = await bff.get(`${CALLBACK}?code=made-up&state=made-up`, noFollowB());

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=expired');
    await expect(findUsersByUsername(userB.username)).resolves.toHaveLength(1);
  });

  it('refuses a callback whose state does not match the pending request', async () => {
    await bff.post(CHALLENGE, {}, authA());

    const res = await bff.get(`${CALLBACK}?code=made-up&state=forged`, noFollowA());

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=');
    // The account is untouched — a forged state never reaches the pipeline.
    await expect(findUsersByUsername(userA.username)).resolves.toHaveLength(1);
  });

  it('refuses a callback carrying no code at all', async () => {
    const res = await bff.get(CALLBACK, noFollowA());

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=expired');
  });

  it('will not delete another user account, whatever the query string says', async () => {
    await bff.post(CHALLENGE, {}, authA());

    // userId in the query is ignored entirely — identity comes from the validated session.
    const res = await bff.get(
      `${CALLBACK}?code=made-up&state=forged&userId=${encodeURIComponent(userB.userId)}`,
      noFollowA(),
    );

    expect(res.status).toBe(302);
    await expect(findUsersByUsername(userB.username)).resolves.toHaveLength(1);
    await expect(findUsersByUsername(userA.username)).resolves.toHaveLength(1);
  });

  it('parks a request per user, so one user callback cannot consume another pending request', async () => {
    await bff.post(CHALLENGE, {}, authA());

    // B has started nothing, so B's callback finds no pending record of its own.
    const res = await bff.get(`${CALLBACK}?code=made-up&state=made-up`, noFollowB());

    expect(res.headers.location).toContain('error=expired');
  });

  it('does not expose a DELETE method that would bypass the step-up', async () => {
    const res = await bff.delete(CALLBACK, authA());

    // Anything other than a successful delete is acceptable; a 2xx would mean the destructive
    // operation is reachable without re-authenticating.
    expect(res.status).toBeGreaterThanOrEqual(400);
    await expect(findUsersByUsername(userA.username)).resolves.toHaveLength(1);
  });
});
