// BFF→MongoDB connection (feature 018). The BFF holds no Mongo connection elsewhere;
// this is a deliberate new dependency for durable, encrypted per-user credential storage
// (see specs/018-per-user-agent-config/research.md R1). Lazy singleton — connects on first
// use and is reused across requests. Uses BFF-scoped credentials (env.mongoUrl), separate
// from mc-service's MC_DB_URL.

import { MongoClient, type Db, type Collection } from 'mongodb';

import { env } from '@/config/env';
import { logger } from '@/bff-server/logger';
import type { UserAgentConfigDoc } from '@/types/agent-config';

let clientPromise: Promise<MongoClient> | null = null;

async function getClient(): Promise<MongoClient> {
  if (!clientPromise) {
    const client = new MongoClient(env.mongoUrl);
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

// Test/teardown hook — closes the pooled connection so Jest can exit cleanly.
export async function closeMongo(): Promise<void> {
  if (clientPromise) {
    const client = await clientPromise;
    await client.close();
    clientPromise = null;
  }
}
