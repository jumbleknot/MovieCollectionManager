/**
 * /bff-api/auth/user integration tests (T009) — FR-015.
 *
 * HTTP-level against the running BFF (http://localhost:8081) + real Keycloak —
 * no mocking (constitution v1.3.0). Each member signs in the way a member does — Keycloak's
 * code + PKCE flow, then the BFF login (helpers/bff-session.ts) — and every call carries only the
 * resulting session cookie: since feature 085 the BFF honours no bearer credential, in any
 * environment.
 */
import {
  createTestUser,
  deleteTestUser,
  assignRole,
  ensureRopcAudienceMapper,
  type TestUser,
} from './helpers/keycloak-test-client';
import { loginSession, loginSessionWithoutAppRole } from './helpers/bff-session';
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
    roleToken = (await loginSession(roleUser.username, roleUser.password)).cookie;

    noRoleUser = await createTestUser('int-user-norole');
    noRoleToken = (await loginSessionWithoutAppRole(noRoleUser)).cookie;
  });

  afterAll(async () => {
    await deleteTestUser(roleUser?.userId);
    await deleteTestUser(noRoleUser?.userId);
  });

  it('returns 200 + profile for an mc-user (FR-015)', async () => {
    const res = await bff.get('/bff-api/auth/user', {
      headers: { Cookie: roleToken },
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
      headers: { Cookie: noRoleToken },
    });
    expect(res.status).toBe(403);
    expect(res.data.code).toBe('FORBIDDEN');
  });
});
