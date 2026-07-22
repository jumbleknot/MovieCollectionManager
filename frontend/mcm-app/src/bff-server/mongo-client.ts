// BFF→MongoDB connection (feature 018). The BFF holds no Mongo connection elsewhere;
// this is a deliberate new dependency for durable, encrypted per-user credential storage
// (see specs/018-per-user-agent-config/research.md R1). Lazy singleton — connects on first
// use and is reused across requests. Uses BFF-scoped credentials (env.mongoUrl), separate
// from mc-service's MC_DB_URL.

import { MongoClient, type Db, type Collection } from 'mongodb';

import { env } from '@/config/env';
import { logger } from '@/bff-server/logger';
import type { UserAgentConfigDoc } from '@/types/agent-config';
import type { AppSettingsDoc } from '@/types/app-settings';

let clientPromise: Promise<MongoClient> | null = null;

// Fail fast when Mongo is unreachable instead of hanging on the driver's 30 s default. The BFF store
// is a STANDALONE instance (no replica set → no elections to wait through), so a short window is
// safe: it's either serving or it isn't. This also keeps the integration suite quick on a
// partial-down store — a port-open-but-not-serving Mongo (which the preflight's TCP probe can't
// catch) otherwise cost ~30 s PER test operation (~690 s across the suite vs ~5 s).
const SERVER_SELECTION_TIMEOUT_MS = 5000;

async function getClient(): Promise<MongoClient> {
  if (!clientPromise) {
    const client = new MongoClient(env.mongoUrl, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
    clientPromise = client.connect().then(
      (connected) => {
        logger.info('BFF Mongo connected', { action: 'mongo_connect', db: env.mongoDbName });
        return connected;
      },
      (err) => {
        clientPromise = null; // allow retry on next call
        logger.error('BFF Mongo connection failed', { action: 'mongo_connect', error: err });
        throw err;
      },
    );
  }
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(env.mongoDbName);
}

export async function getAgentConfigCollection(): Promise<Collection<UserAgentConfigDoc>> {
  const db = await getDb();
  return db.collection<UserAgentConfigDoc>(env.agentConfigCollection);
}

// Global application settings — a single-document collection (feature 040 US3 / Item 1).
export async function getAppSettingsCollection(): Promise<Collection<AppSettingsDoc>> {
  const db = await getDb();
  return db.collection<AppSettingsDoc>(env.appSettingsCollection);
}

// Test/teardown hook — closes the pooled connection so Jest can exit cleanly.
export async function closeMongo(): Promise<void> {
  if (clientPromise) {
    const client = await clientPromise;
    await client.close();
    clientPromise = null;
  }
}
