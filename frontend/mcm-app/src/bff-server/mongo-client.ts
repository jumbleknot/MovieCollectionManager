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
import type { BackupDestination, BackupJob, BackupRun } from '@/types/backups';

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

// ─── Backups (feature 073) ─────────────────────────────────────────────────────
//
// Three collections, all keyed by the owning `userId`. The BFF's Mongo is a STANDALONE instance,
// not a replica set, so there are no multi-document transactions available here: every state
// change in this feature is a single-document atomic update, and a run record is deliberately an
// independent document rather than something tied to its job.

// Index creation runs ONCE per process, on first use of any backup collection. `createIndex` is
// idempotent, so a second process racing this one is harmless. The promise is cached rather than a
// boolean so two concurrent first-callers await the same work instead of both issuing it; a
// failure clears the cache so the next call retries rather than leaving the process permanently
// convinced the indexes exist.
let backupIndexesPromise: Promise<void> | null = null;

// Run history is diagnostic, not a record of account — 180 days and gone.
const RUN_HISTORY_TTL_DAYS = 180;
export const RUN_HISTORY_TTL_MS = RUN_HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000;

async function ensureBackupIndexes(db: Db): Promise<void> {
  if (!backupIndexesPromise) {
    backupIndexesPromise = (async () => {
      const destinations = db.collection(env.backupDestinationsCollection);
      const jobs = db.collection(env.backupJobsCollection);
      const runs = db.collection(env.backupRunsCollection);

      await Promise.all([
        destinations.createIndex({ userId: 1 }),
        // Two destinations with the same label are a usability trap at the moment it matters
        // most — choosing one in a job form, where the labels are all the user sees.
        destinations.createIndex({ userId: 1, label: 1 }, { unique: true }),
        jobs.createIndex({ userId: 1 }),
        // The tick's ONLY query: due-and-enabled. Leading with nextRunAt keeps it a range scan
        // over the few jobs actually due rather than a scan of every enabled job.
        jobs.createIndex({ nextRunAt: 1, enabled: 1 }),
        // No separate `{ userId: 1 }` on runs: this compound index has userId as its PREFIX, so
        // it already serves a userId-only query. A second index would be paid for on every write
        // and read by nothing.
        runs.createIndex({ userId: 1, jobId: 1, startedAt: -1 }),
        // TTL on `expiresAt`, a real BSON Date, and NOT on `startedAt`, which is an ISO string
        // like every other timestamp in this feature. MongoDB accepts a TTL index over a string
        // field without complaint and then expires NOTHING — the index exists, `getIndexes()`
        // shows it, and run history grows for ever. A separate Date field is the honest way to
        // have both a string timestamp everywhere else and a TTL that actually fires.
        runs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      ]);
      logger.info('BFF backup indexes ensured', { action: 'backup_indexes_ensure' });
    })().catch((err) => {
      backupIndexesPromise = null; // allow retry on next call
      throw err;
    });
  }
  return backupIndexesPromise;
}

export async function getBackupDestinationsCollection(): Promise<Collection<BackupDestination>> {
  const db = await getDb();
  await ensureBackupIndexes(db);
  return db.collection<BackupDestination>(env.backupDestinationsCollection);
}

export async function getBackupJobsCollection(): Promise<Collection<BackupJob>> {
  const db = await getDb();
  await ensureBackupIndexes(db);
  return db.collection<BackupJob>(env.backupJobsCollection);
}

export async function getBackupRunsCollection(): Promise<Collection<BackupRun>> {
  const db = await getDb();
  await ensureBackupIndexes(db);
  return db.collection<BackupRun>(env.backupRunsCollection);
}

// Test/teardown hook — closes the pooled connection so Jest can exit cleanly.
export async function closeMongo(): Promise<void> {
  if (clientPromise) {
    const client = await clientPromise;
    await client.close();
    clientPromise = null;
    // The next connection is to a fresh client (and, in tests, often a wiped database), so the
    // memo of "indexes already ensured" must not survive the close that invalidated it.
    backupIndexesPromise = null;
  }
}
