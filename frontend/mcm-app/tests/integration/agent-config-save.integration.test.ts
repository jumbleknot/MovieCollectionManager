/**
 * T020 — PUT validate-on-save integration tests (US2, FR-012/013/014).
 *
 * Drives PUT /bff-api/agent/config over HTTP against the live BFF + real Keycloak + real Mongo
 * + real probes (Ollama + TMDB). Asserts the contract:
 *   - valid body → 200 non-secret view + encrypted persist (tmdbKeyEnc round-trips);
 *   - probe failure (bad key) → 422 per-field, NOTHING persisted (prior doc unchanged);
 *   - malformed body → 400, nothing persisted;
 *   - a secret omitted from a later PUT leaves the stored secret intact (FR-014).
 *
 * The BFF process and this harness share AGENT_CONFIG_ENC_KEY via .env.local, so the test can
 * decrypt what the BFF stored. Requires the live stack (BFF :8081, Keycloak, mc_db, Ollama).
 *
 * Run: pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-save"
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
import { decryptSecret, secretAad } from '@/bff-server/agent-config-crypto';
import { env } from '@/config/env';

const bff = createBffClient();
// This suite sends ollamaBaseUrl to the CONTAINER BFF for it to probe — so the default is the
// container-reachable host Ollama (`host.docker.internal`, Docker Desktop), NOT `localhost` (= the
// container itself → probe 422). The in-process probes suite uses localhost; these are distinct.
const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://host.docker.internal:11434';
const TMDB_KEY = process.env['TMDB_API_KEY'] ?? '';

describe('PUT /bff-api/agent/config — validate-on-save (real BFF + Keycloak + Mongo + probes)', () => {
  let user: TestUser;
  let token: string;
  const auth = () => ({ headers: { Authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    expect(TMDB_KEY).not.toBe('');
    await ensureRopcAudienceMapper();
    user = await createTestUser('agentcfg-save');
    await assignRole(user.userId, 'mc-user');
    ({ accessToken: token } = await getTestTokens(user.username, user.password));
  });

  afterAll(async () => {
    const col = await getAgentConfigCollection();
    await col.deleteMany({ _id: user?.userId });
    await closeMongo();
    await deleteTestUser(user?.userId);
  });

  it('valid Ollama+TMDB body → 200 non-secret view + encrypted persist', async () => {
    const res = await bff.put(
      '/bff-api/agent/config',
      { enabled: true, provider: 'ollama', ollamaBaseUrl: OLLAMA_BASE_URL, tmdbKey: TMDB_KEY },
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data.enabled).toBe(true);
    expect(res.data.hasTmdbKey).toBe(true);
    expect(res.data).not.toHaveProperty('tmdbKey');
    expect(res.data).not.toHaveProperty('tmdbKeyEnc');

    const doc = await store.getByUserId(user.userId);
    expect(doc?.tmdbKeyEnc).toBeDefined();
    expect(decryptSecret(doc!.tmdbKeyEnc!, env.agentConfigEncKey, secretAad(user.userId, 'tmdbKey'))).toBe(TMDB_KEY);
  });

  it('bad TMDB key → 422 per-field, nothing persisted (prior doc unchanged)', async () => {
    const before = await store.getByUserId(user.userId);
    const res = await bff.put(
      '/bff-api/agent/config',
      { enabled: true, provider: 'ollama', ollamaBaseUrl: OLLAMA_BASE_URL, tmdbKey: 'bad-key-xyz' },
      auth(),
    );
    expect(res.status).toBe(422);
    expect(res.data.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'tmdbKey' })]),
    );
    // Reason carries no secret value.
    for (const e of res.data.errors) expect(e.reason).not.toContain('bad-key-xyz');

    const after = await store.getByUserId(user.userId);
    expect(after?.tmdbKeyEnc).toBe(before?.tmdbKeyEnc); // unchanged
  });

  it('malformed body (unknown provider) → 400, nothing persisted', async () => {
    const before = await store.getByUserId(user.userId);
    const res = await bff.put(
      '/bff-api/agent/config',
      { provider: 'bogus-provider' },
      auth(),
    );
    expect(res.status).toBe(400);
    const after = await store.getByUserId(user.userId);
    expect(after?.updatedAt).toBe(before?.updatedAt); // untouched
  });

  it('omitting the TMDB secret on a later PUT keeps the stored value (FR-014)', async () => {
    const before = await store.getByUserId(user.userId);
    expect(before?.tmdbKeyEnc).toBeDefined();
    const res = await bff.put(
      '/bff-api/agent/config',
      { costLimitUsd: 0.25 }, // no secret in the body
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data.costLimitUsd).toBe(0.25);

    const after = await store.getByUserId(user.userId);
    expect(after?.tmdbKeyEnc).toBe(before?.tmdbKeyEnc); // secret preserved
    expect(decryptSecret(after!.tmdbKeyEnc!, env.agentConfigEncKey, secretAad(user.userId, 'tmdbKey'))).toBe(TMDB_KEY);
  });
});
