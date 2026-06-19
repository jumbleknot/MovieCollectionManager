/**
 * agent-config-store integration tests (T007 / T037) — FR-013 / FR-014 / FR-016.
 *
 * Exercises the per-user agent config store against REAL MongoDB (no mocking —
 * constitution v1.3.0). Verifies encrypt-at-rest round-trip (ciphertext ≠ plaintext,
 * decrypt yields original), that an omitted secret is preserved across a partial upsert,
 * and the clear() semantics (disable + wipe secrets, keep non-secret settings — R9).
 *
 * Requires a running MongoDB (the dev mc_db replica set). Each test uses a random userId
 * and tears down its own document in afterAll.
 */
import { randomUUID } from 'node:crypto';

import * as store from '@/bff-server/agent-config-store';
import { getAgentConfigCollection, closeMongo } from '@/bff-server/mongo-client';
import { encryptSecret, decryptSecret } from '@/bff-server/agent-config-crypto';

const TEST_KEY = Buffer.alloc(32, 11).toString('base64');
const userIds: string[] = [];
const newUser = () => {
  const id = `test-agentcfg-${randomUUID()}`;
  userIds.push(id);
  return id;
};

afterAll(async () => {
  const col = await getAgentConfigCollection();
  await col.deleteMany({ _id: { $in: userIds } });
  await closeMongo();
});

describe('agent-config-store — integration (real Mongo)', () => {
  it('upserts and reads back a config; tmdb secret round-trips and is encrypted at rest', async () => {
    const userId = newUser();
    const tmdbPlain = 'tmdb-secret-xyz';
    await store.upsert(userId, {
      enabled: true,
      provider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      tmdbKeyEnc: encryptSecret(tmdbPlain, TEST_KEY),
      costLimitUsd: null,
    });

    const doc = await store.getByUserId(userId);
    expect(doc?.enabled).toBe(true);
    expect(doc?.provider).toBe('ollama');
    expect(doc?.ollamaBaseUrl).toBe('http://localhost:11434');
    expect(doc?.tmdbKeyEnc).toBeDefined();
    expect(doc?.tmdbKeyEnc).not.toContain(tmdbPlain); // ciphertext ≠ plaintext
    expect(decryptSecret(doc!.tmdbKeyEnc!, TEST_KEY)).toBe(tmdbPlain);
  });

  it('leaves a stored secret intact when a later upsert omits it (FR-014)', async () => {
    const userId = newUser();
    const enc = encryptSecret('keep-me', TEST_KEY);
    await store.upsert(userId, { enabled: true, provider: 'ollama', ollamaBaseUrl: 'http://x', tmdbKeyEnc: enc, costLimitUsd: null });

    // Change only a non-secret field; do NOT pass tmdbKeyEnc.
    await store.upsert(userId, { ollamaBaseUrl: 'http://updated' });

    const doc = await store.getByUserId(userId);
    expect(doc?.ollamaBaseUrl).toBe('http://updated');
    expect(doc?.tmdbKeyEnc).toBe(enc); // secret preserved
  });

  it('clear() disables + wipes secrets but keeps non-secret settings (FR-016 / R9)', async () => {
    const userId = newUser();
    await store.upsert(userId, {
      enabled: true,
      provider: 'anthropic',
      ollamaBaseUrl: 'http://localhost:11434',
      anthropicKeyEnc: encryptSecret('a', TEST_KEY),
      tmdbKeyEnc: encryptSecret('t', TEST_KEY),
      costLimitUsd: 0.25,
    });

    await store.clear(userId);

    const doc = await store.getByUserId(userId);
    expect(doc?.enabled).toBe(false);
    expect(doc?.anthropicKeyEnc).toBeUndefined();
    expect(doc?.tmdbKeyEnc).toBeUndefined();
    // Non-secret settings retained:
    expect(doc?.provider).toBe('anthropic');
    expect(doc?.ollamaBaseUrl).toBe('http://localhost:11434');
    expect(doc?.costLimitUsd).toBe(0.25);
  });
});
