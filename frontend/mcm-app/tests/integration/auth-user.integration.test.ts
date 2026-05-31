/**
 * /bff-api/auth/user integration tests (T009) — FR-015.
 *
 * HTTP-level against the running BFF (http://localhost:8081) + real Keycloak —
 * no mocking (constitution v1.3.0). `requireAuth` accepts a raw token via the
 * `Authorization: Bearer` header (auth.ts extractToken), so no session seeding is
 * needed: a real ROPC access token drives the success and role paths.
 *
 * NOTE: PKCE code exchange is out of scope (feature-003 E2E). These begin after
 * token acquisition.
 */
import {
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  ensureRopcAudienceMapper,
  type TestUser,
} from './helpers/keycloak-test-client';
import { createBffClient } from './helpers/bff-test-server';

const bff = createBffClient();

describe('/bff-api/auth/user — integration (real BFF + Keycloak)', () => {
  let roleUser: TestUser;
  let noRoleUser: TestUser;
  let roleToken: string;
  let noRoleToken: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    roleUser = await createTestUser('int-user');
    await assignRole(roleUser.userId, 'mc-user');
    ({ accessToken: roleToken } = await getTestTokens(roleUser.username, roleUser.password));

    noRoleUser = await createTestUser('int-user-norole');
    ({ accessToken: noRoleToken } = await getTestTokens(noRoleUser.username, noRoleUser.password));
  });

  afterAll(async () => {
    await deleteTestUser(roleUser?.userId);
    await deleteTestUser(noRoleUser?.userId);
  });

  it('returns 200 + profile for an mc-user (FR-015)', async () => {
    const res = await bff.get('/bff-api/auth/user', {
      headers: { Authorization: `Bearer ${roleToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.data.username).toBe(roleUser.username);
    expect(res.data.roles).toContain('mc-user');
  });

  it('returns 401 with no auth (US-unauthorized)', async () => {
    const res = await bff.get('/bff-api/auth/user');
    expect(res.status).toBe(401);
    expect(res.data.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 for an authenticated user lacking mc-user (US-forbidden)', async () => {
    const res = await bff.get('/bff-api/auth/user', {
      headers: { Authorization: `Bearer ${noRoleToken}` },
    });
    expect(res.status).toBe(403);
    expect(res.data.code).toBe('FORBIDDEN');
  });
});
