/**
 * Agent Gateway BFF route auth-guard integration tests (T028a) — feature 012.
 *
 * COMPENSATING CONTROL for the documented Centralized Access Control deviation:
 * Expo Router has no runtime global middleware, so agent routes enforce auth per-handler
 * (requireAuth -> requireMcUser), like every existing BFF route. This test enumerates the
 * agent routes and asserts each is unreachable without auth (401) and without the mc-user
 * role (403) BEFORE any upstream gateway call. Any new bff-api/agent/* route MUST be added
 * here. HTTP-level against the running BFF + real Keycloak (no mocking, constitution v1.3.0).
 *
 * (The authorized 200 streaming path is validated separately once the gateway runs in the
 * test topology — it is not exercised here.)
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

// Every agent route + a minimal valid body. Add new agent routes here (the gate enumerates them).
const AGENT_ROUTES: { method: 'post'; path: string; body: unknown }[] = [
  { method: 'post', path: '/bff-api/agent/run', body: { message: 'hello', threadId: null } },
  {
    method: 'post',
    path: '/bff-api/agent/resume',
    body: { threadId: 't1', proposalId: 'p1', decision: 'approved' },
  },
];

describe('bff-api/agent/* — auth guard (real BFF + Keycloak)', () => {
  let mcUser: TestUser;
  let noRoleUser: TestUser;
  let noRoleToken: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    mcUser = await createTestUser('agent-auth-mc');
    await assignRole(mcUser.userId, 'mc-user');

    noRoleUser = await createTestUser('agent-auth-norole');
    ({ accessToken: noRoleToken } = await getTestTokens(noRoleUser.username, noRoleUser.password));
  });

  afterAll(async () => {
    await deleteTestUser(mcUser?.userId);
    await deleteTestUser(noRoleUser?.userId);
  });

  it.each(AGENT_ROUTES)('$method $path returns 401 with no auth', async ({ method, path, body }) => {
    const res = await bff[method](path, body);
    expect(res.status).toBe(401);
    expect(res.data.code).toBe('UNAUTHORIZED');
  });

  it.each(AGENT_ROUTES)('$method $path returns 403 for a user lacking mc-user', async ({ method, path, body }) => {
    const res = await bff[method](path, body, { headers: { Authorization: `Bearer ${noRoleToken}` } });
    expect(res.status).toBe(403);
    expect(res.data.code).toBe('FORBIDDEN');
  });
});
