// BFF→MongoDB connection (feature 018). The BFF holds no Mongo connection elsewhere;
// this is a deliberate new dependency for durable, encrypted per-user credential storage
// (see specs/018-per-user-agent-config/research.md R1). Lazy singleton — connects on first
// use and is reused across requests. Uses BFF-scoped credentials (env.mongoUrl), separate
// from mc-service's MC_DB_URL.

import * as os from 'node:os';

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
    // `runtimeAdapters.os` is supplied EXPLICITLY, and it is not a preference — item #264.
    //
    // mongodb 7.6.0 moved the os adapter to a dynamic `import('os')` (lib/runtime_adapters.js). Jest's
    // CJS runtime cannot execute a dynamic import without --experimental-vm-modules, so that promise
    // rejects — and the driver SWALLOWS the rejection by design (connection_string.js:
    // `mongoOptions.runtime.then(undefined, squashError)`, commented for "runtimes where the dynamic
    // import of the default os adapter fails"). makeClientMetadata awaits it, and the client metadata
    // document collapses to `{}` SILENTLY.
    //
    // The server then refuses the handshake with `Missing required sub-document 'driver' in the client
    // metadata document`, which reads like a driver/server version incompatibility and is not one.
    // MEASURED 2026-08-28: driver 7.6.0 connects fine to the SAME mongodb-community-server:8.0.8-ubi9
    // from plain Node (`ping={"ok":1}`) and fails only under Jest, where the metadata prints as `{}`
    // against 7.5.0's full document. It reddened app-e2e on PR #261 and PR #263 at once.
    //
    // Passing the adapter takes the first branch of the driver's own `options.runtimeAdapters?.os ??
    // (await import('os'))`, so the dynamic import never runs. Production was never affected — real
    // Node executes it fine — but a static import is the honest dependency anyway, and it keeps the
    // test harness and production on ONE code path instead of two. Do NOT replace this with
    // NODE_OPTIONS=--experimental-vm-modules: that turns on experimental module handling for all 30
    // integration suites to work around two lines here.
    const client = new MongoClient(env.mongoUrl, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      runtimeAdapters: { os },
    });
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
