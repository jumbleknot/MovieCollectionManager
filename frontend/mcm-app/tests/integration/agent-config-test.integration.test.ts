/**
 * T033 — POST /bff-api/agent/config/test integration tests (US3, FR-013/015).
 *
 * Re-probes the already-stored, server-decrypted credentials without re-entry. Drives
 * POST /bff-api/agent/config/test over HTTP against the live BFF + real Keycloak + real
 * Mongo + real probes (Ollama + TMDB). Asserts the contract (contracts/bff-agent-config-api.md):
 *   - stored valid creds → 200 per-credential `{ ollama: "ok", tmdb: "ok" }`, NO secret returned;
 *   - a spoiled stored credential → that field reports `{ reason }`, the others still `ok`;
 *   - nothing on file to test → 409.
 *
 * The BFF process and this harness share AGENT_CONFIG_ENC_KEY via .env.local, so the test can
 * plant a spoiled (but well-formed) ciphertext the BFF will decrypt. Requires the live stack
 * (BFF :8081, Keycloak, mc_db, Ollama).
 *
 * Run: pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-test"
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
import { isOllamaReachable } from './helpers/ollama';
import * as store from '@/bff-server/agent-config-store';
import { getAgentConfigCollection, closeMongo } from '@/bff-server/mongo-client';
import { encryptSecret, secretAad } from '@/bff-server/agent-config-crypto';
import { env } from '@/config/env';

const bff = createBffClient();
// Sent to the CONTAINER BFF to probe → default to container-reachable host Ollama
// (`host.docker.internal`), not `localhost` (= the container itself). See agent-config-save.
const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://host.docker.internal:11434';
const TMDB_KEY = process.env['TMDB_API_KEY'] ?? '';

describe('POST /bff-api/agent/config/test — re-probe stored credentials (real BFF + Keycloak + Mongo + probes)', () => {
  let user: TestUser;
  let token: string;
  // Feature 041: the stored-valid and spoiled-credential tests re-probe a stored Ollama config, so
  // they need a real Ollama; app-e2e (MODEL_PROVIDER=anthropic) has none → self-skip when unreachable
  // (legitimate "ollama not reachable" skip). The nothing-on-file (409) test needs no Ollama.
  let ollamaReachable = false;
  const auth = () => ({ headers: { Authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    expect(TMDB_KEY).not.toBe('');
    await ensureRopcAudienceMapper();
    user = await createTestUser('agentcfg-test');
    await assignRole(user.userId, 'mc-user');
    ({ accessToken: token } = await getTestTokens(user.username, user.password));
    ollamaReachable = await isOllamaReachable(OLLAMA_BASE_URL);
  });

  afterAll(async () => {
    const col = await getAgentConfigCollection();
    await col.deleteMany({ _id: user?.userId });
    await closeMongo();
    await deleteTestUser(user?.userId);
  });

  it('nothing on file to test → 409', async () => {
    // Fresh user, no config document yet.
    const res = await bff.post('/bff-api/agent/config/test', undefined, auth());
    expect(res.status).toBe(409);
    expect(res.data).not.toHaveProperty('tmdbKey');
    expect(res.data).not.toHaveProperty('anthropicKey');
  });

  it('stored valid Ollama+TMDB creds → 200 per-credential ok, no secret returned', async () => {
    if (!ollamaReachable) {
      console.warn(`SKIP: ollama not reachable at ${OLLAMA_BASE_URL}`);
      return;
    }
    const save = await bff.put(
      '/bff-api/agent/config',
      { enabled: true, provider: 'ollama', ollamaBaseUrl: OLLAMA_BASE_URL, tmdbKey: TMDB_KEY },
      auth(),
    );
    expect(save.status).toBe(200);

    const res = await bff.post('/bff-api/agent/config/test', undefined, auth());
    expect(res.status).toBe(200);
    expect(res.data.ollama).toBe('ok');
    expect(res.data.tmdb).toBe('ok');
    // No anthropic key on file → omitted.
    expect(res.data).not.toHaveProperty('anthropic');
    // Never echoes a secret value.
    expect(JSON.stringify(res.data)).not.toContain(TMDB_KEY);
    expect(JSON.stringify(res.data)).not.toContain(OLLAMA_BASE_URL.replace(/\/+$/, ''));
  });

  it('a spoiled stored credential → that field reports {reason}, the others still ok', async () => {
    if (!ollamaReachable) {
      // Asserts ollama:"ok" alongside the spoiled tmdb → needs the stored valid Ollama config above.
      console.warn(`SKIP: ollama not reachable at ${OLLAMA_BASE_URL}`);
      return;
    }
    // Plant a well-formed-but-invalid TMDB ciphertext directly (validate-on-save would reject it).
    await store.upsert(user.userId, {
      tmdbKeyEnc: encryptSecret('spoiled-tmdb-key-xyz', env.agentConfigEncKey, secretAad(user.userId, 'tmdbKey')),
    });

    const res = await bff.post('/bff-api/agent/config/test', undefined, auth());
    expect(res.status).toBe(200);
    expect(res.data.ollama).toBe('ok'); // still reachable
    expect(res.data.tmdb).toMatchObject({ reason: expect.any(String) });
    // The safe reason never leaks the spoiled secret value.
    expect(res.data.tmdb.reason).not.toContain('spoiled-tmdb-key-xyz');
  });
});
