/**
 * The BFF honours no bearer credential — in this environment or any other (feature 085 US3,
 * FR-008/FR-009, SC-004, SC-010).
 *
 * HTTP-level against the running dev BFF + real Keycloak, no mocks. A REAL, signature-valid access
 * token for a real member — exactly what the removed bearer path used to accept — is presented
 * directly, and refused on every route class. With a session cookie as well, the cookie alone
 * decides who the caller is: member B's bearer cannot turn member A's session into B's.
 */
import {
  assignRole,
  createTestUser,
  deleteTestUser,
  ensureRopcAudienceMapper,
  getTestTokens,
  type TestUser,
} from './helpers/keycloak-test-client';
import { createBffClient } from './helpers/bff-test-server';
import { loginSession } from './helpers/bff-session';

const bff = createBffClient();

describe('the BFF refuses a bearer credential (feature 085 US3)', () => {
  let memberA: TestUser;
  let memberB: TestUser;
  let bearerB: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    memberA = await createTestUser('int-bearer-a');
    memberB = await createTestUser('int-bearer-b');
    await assignRole(memberA.userId, 'mc-user');
    await assignRole(memberB.userId, 'mc-user');
    ({ accessToken: bearerB } = await getTestTokens(memberB.username, memberB.password));
  });

  afterAll(async () => {
    await deleteTestUser(memberA?.userId);
    await deleteTestUser(memberB?.userId);
  });

  it.each([
    ['GET', '/bff-api/auth/user'],
    ['GET', '/bff-api/collections'],
    ['GET', '/bff-api/agent/run'],
    ['GET', '/bff-api/agent/config'],
  ])(
    'a valid bearer alone on %s %s is refused as unauthenticated (AS-1, SC-004)',
    async (method, path) => {
      const res = await bff.request({
        method,
        url: path,
        headers: { Authorization: `Bearer ${bearerB}` },
      });
      expect(res.status).toBe(401);
    },
  );

  it("a bearer beside a session cookie is ignored: the caller is the SESSION's member (AS-2)", async () => {
    const a = await loginSession(memberA.username, memberA.password);
    const res = await bff.get('/bff-api/auth/user', {
      headers: { Cookie: a.cookie, Authorization: `Bearer ${bearerB}` },
    });
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(memberA.userId);
  });
});
