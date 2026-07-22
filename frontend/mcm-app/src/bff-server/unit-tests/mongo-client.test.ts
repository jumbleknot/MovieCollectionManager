/**
 * Unit test for bff-server/mongo-client.ts — pins the fail-fast connection config.
 *
 * The BFF Mongo client MUST pass a short `serverSelectionTimeoutMS`. Without it the driver default
 * (30 s) makes a partial-down store (port open but not serving — which the integration preflight's
 * TCP probe cannot catch) cost ~30 s PER operation (~690 s across the suite). The store is a
 * STANDALONE instance (no elections), so a short window is prod-safe. This test guards against the
 * option being silently dropped.
 */
import { MongoClient } from 'mongodb';

import { getDb } from '@/bff-server/mongo-client';

jest.mock('mongodb', () => {
  const instance: { connect: jest.Mock; db: jest.Mock; close: jest.Mock } = {
    connect: jest.fn(() => Promise.resolve(instance)),
    db: jest.fn(() => ({ collection: jest.fn() })),
    close: jest.fn(() => Promise.resolve()),
  };
  return { __esModule: true, MongoClient: jest.fn(() => instance) };
});

jest.mock('@/config/env', () => ({
  env: {
    mongoUrl: 'mongodb://localhost:27018',
    mongoDbName: 'mcm_bff',
    agentConfigCollection: 'user_agent_config',
    appSettingsCollection: 'app_settings',
  },
}));

jest.mock('@/bff-server/logger', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));

describe('bff-server/mongo-client', () => {
  it('constructs MongoClient with a fail-fast serverSelectionTimeoutMS (not the 30s default)', async () => {
    await getDb();
    expect(MongoClient).toHaveBeenCalledWith(
      'mongodb://localhost:27018',
      expect.objectContaining({ serverSelectionTimeoutMS: 5000 }),
    );
  });
});
