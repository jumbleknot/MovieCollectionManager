/**
 * T013a — caller-scoping (IDOR) integration test (US1, FR-017).
 *
 * Deny-by-Default / Least-Privilege: the owning userId is taken from the validated session,
 * NEVER from the request body. Authenticated as user A, a request carrying a spoofed body
 * `userId`/`_id` = user B must act ONLY on A's document — B's row is untouched.
 *
 * HTTP-level against the running BFF + real Keycloak + real Mongo (no mocking — constitution
 * v1.3.0). GET + DELETE + PUT are all covered (PUT lands with T026, US2).
 *
 * Requires the live stack (BFF on :8081, Keycloak, mc_db). Seeds A's and B's docs directly
 * via the store, drives the BFF over HTTP, then asserts via the store.
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
import * as store from '@/bff-server/agent-config-store';
import { getAgentConfigCollection, closeMongo } from '@/bff-server/mongo-client';
import { encryptSecret, secretAad } from '@/bff-server/agent-config-crypto';

const bff = createBffClient();
const KEY = Buffer.alloc(32, 13).toString('base64');

const seedRunnable = (userId: string) =>
  store.upsert(userId, {
    enabled: true,
    provider: 'ollama',
    ollamaBaseUrl: 'http://localhost:11434',
    tmdbKeyEnc: encryptSecret('tmdb', KEY, secretAad(userId, 'tmdbKey')),
    costLimitUsd: null,
  });

describe('agent-config — caller scoping / IDOR (real BFF + Keycloak + Mongo)', () => {
  let userA: TestUser;
  let userB: TestUser;
  let tokenA: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    userA = await createTestUser('agentcfg-scope-a');
    await assignRole(userA.userId, 'mc-user');
    ({ accessToken: tokenA } = await getTestTokens(userA.username, userA.password));
    userB = await createTestUser('agentcfg-scope-b');
    await assignRole(userB.userId, 'mc-user');
  });

  afterAll(async () => {
    const col = await getAgentConfigCollection();
    await col.deleteMany({ _id: { $in: [userA?.userId, userB?.userId].filter(Boolean) as string[] } });
    await closeMongo();
    await deleteTestUser(userA?.userId);
    await deleteTestUser(userB?.userId);
  });

  it('DELETE with a spoofed body userId clears ONLY the caller (A), leaving B intact', async () => {
    await seedRunnable(userA.userId);
    await seedRunnable(userB.userId);

    // A authenticates; body tries to target B.
    const res = await bff.delete('/bff-api/agent/config', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { userId: userB.userId, _id: userB.userId },
    });
    expect(res.status).toBe(200);

    const aDoc = await store.getByUserId(userA.userId);
    const bDoc = await store.getByUserId(userB.userId);
    expect(aDoc?.enabled).toBe(false);            // A cleared
    expect(aDoc?.tmdbKeyEnc).toBeUndefined();
    expect(bDoc?.enabled).toBe(true);             // B untouched
    expect(bDoc?.tmdbKeyEnc).toBeDefined();
  });

  it('PUT with a spoofed body userId writes ONLY the caller (A), leaving B intact', async () => {
    await seedRunnable(userA.userId);
    await seedRunnable(userB.userId);
    const bBefore = await store.getByUserId(userB.userId);

    // A authenticates; body tries to target B while also changing the cost limit.
    const res = await bff.put(
      '/bff-api/agent/config',
      { userId: userB.userId, _id: userB.userId, costLimitUsd: 0.99 },
      { headers: { Authorization: `Bearer ${tokenA}` } },
    );
    expect(res.status).toBe(200);

    const aDoc = await store.getByUserId(userA.userId);
    const bDoc = await store.getByUserId(userB.userId);
    expect(aDoc?.costLimitUsd).toBe(0.99);            // A written
    expect(bDoc?.costLimitUsd).toBe(bBefore?.costLimitUsd ?? null); // B untouched
    expect(bDoc?.updatedAt).toBe(bBefore?.updatedAt);
  });

  it('GET returns the caller (A) view regardless of any spoofed body', async () => {
    await seedRunnable(userA.userId);
    const res = await bff.get('/bff-api/agent/config', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { userId: userB.userId },
    });
    expect(res.status).toBe(200);
    // A's seeded config is enabled/ollama with a tmdb key present — never B's.
    expect(res.data.enabled).toBe(true);
    expect(res.data.hasTmdbKey).toBe(true);
    expect(res.data).not.toHaveProperty('tmdbKeyEnc');
  });
});
