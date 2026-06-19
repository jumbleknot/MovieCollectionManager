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

type Method = 'get' | 'post' | 'put' | 'delete';

// Method-aware call so the auth header lands in the right axios arg position (get/delete take
// (url, config); post/put take (url, body, config)). The guard rejects (401/403) before any
// body read, so the body is only meaningful for post/put.
function call(method: Method, path: string, body: unknown, headers?: Record<string, string>) {
  const config = headers ? { headers } : undefined;
  if (method === 'get' || method === 'delete') return bff[method](path, config);
  return bff[method](path, body, config);
}

// Every agent route + a minimal valid body. Add new agent routes here (the gate enumerates them).
const AGENT_ROUTES: { method: Method; path: string; body: unknown }[] = [
  { method: 'post', path: '/bff-api/agent/run', body: { message: 'hello', threadId: null } },
  // Per-user agent config (feature 018). POST /config/test is added with T035.
  { method: 'get', path: '/bff-api/agent/config', body: {} },
  { method: 'put', path: '/bff-api/agent/config', body: { enabled: false } },
  { method: 'delete', path: '/bff-api/agent/config', body: {} },
  {
    method: 'post',
    path: '/bff-api/agent/resume',
    body: { threadId: 't1', proposalId: 'p1', decision: 'approved' },
  },
  {
    method: 'post',
    path: '/bff-api/agent/ui-state',
    body: { current_screen: 'collection', collection_id: '0123456789abcdef01234567' },
  },
  {
    method: 'post',
    path: '/bff-api/agent/ui-action',
    body: { type: 'navigate', target: 'collection' },
  },
  // import-upload is multipart in production, but the auth guard rejects (401/403) BEFORE the
  // body is read, so any body exercises the guard (014 US2).
  {
    method: 'post',
    path: '/bff-api/agent/import-upload',
    body: { file: 'ignored' },
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
    const res = await call(method, path, body);
    expect(res.status).toBe(401);
    expect(res.data.code).toBe('UNAUTHORIZED');
  });

  it.each(AGENT_ROUTES)('$method $path returns 403 for a user lacking mc-user', async ({ method, path, body }) => {
    const res = await call(method, path, body, { Authorization: `Bearer ${noRoleToken}` });
    expect(res.status).toBe(403);
    expect(res.data.code).toBe('FORBIDDEN');
  });
});
