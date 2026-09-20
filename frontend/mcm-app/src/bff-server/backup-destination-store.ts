// Durable store for backup destinations (feature 073, FR-002/003/006/034).
//
// Two invariants live HERE rather than in the routes above, and both are deliberate:
//
//   1. `secretEnc` IS EXCLUDED BY THE READ PROJECTION. Not stripped per route, not deleted from
//      a spread — excluded by the query, so the field never enters the process in the first
//      place. A route added later that forgets to strip it CANNOT leak it. That is the
//      difference between a control and a convention, and conventions are what get forgotten
//      when a fifth route is added in a hurry.
//
//   2. `userId` IS ALWAYS A CALLER ARGUMENT, never read from a document or a request. Every
//      query filters on it. A route cannot ask for "destination X" — only for "this user's
//      destination X" — so a foreign id is indistinguishable from a missing one, which is what
//      makes the routes' 404-never-403 rule implementable (FR-034).
//
// Secrets are sealed and opened here under `backupSecretAad(userId, destinationId)`. Plaintext
// exists only in the argument to `createDestination` / `updateDestination` and in the return of
// `getDestinationSecret`; it is never persisted, never logged, and never returned by any of the
// view-shaped functions.

import { randomUUID } from 'node:crypto';

import {
  encryptSecret,
  decryptSecret,
  backupSecretAad,
  backupEncryptionKey,
} from '@/bff-server/agent-config-crypto';
import { getBackupDestinationsCollection, getBackupJobsCollection } from '@/bff-server/mongo-client';
import type {
  BackupDestination,
  BackupDestinationView,
  BackupTestResult,
} from '@/types/backups';

/** Thrown for input the store refuses outright, as distinct from "not found" (which is null). */
export class BackupDestinationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupDestinationInputError';
  }
}

export interface DestinationInput {
  type: 's3' | 'webdav';
  label: string;
  endpoint: string;
  basePath?: string;
  bucket?: string;
  region?: string;
  pathStyle?: boolean;
  accessKeyId?: string;
  username?: string;
  secret?: string;
}

export type DestinationPatch = Partial<DestinationInput>;

// The projection. `0` on a field excludes it; everything else comes back. Written as an
// exclusion rather than an inclusion list ON PURPOSE: with an inclusion list, a field added to
// the document later would silently stop being returned, and the bug would be a missing value
// in the UI with nothing pointing here.
const NO_SECRET = { projection: { secretEnc: 0 } } as const;

function toView(doc: Omit<BackupDestination, 'secretEnc'>): BackupDestinationView {
  const { _id, userId: _userId, ...rest } = doc as BackupDestination & { _id: string };
  void _userId; // the caller already knows whose it is; echoing it invites trusting it back
  return { id: _id, ...rest } as BackupDestinationView;
}

export async function createDestination(
  userId: string,
  input: DestinationInput,
): Promise<BackupDestinationView> {
  if (input.secret !== undefined && input.secret === '') {
    throw new BackupDestinationInputError('A destination secret cannot be empty');
  }
  const collection = await getBackupDestinationsCollection();
  const _id = randomUUID();
  const now = new Date().toISOString();

  const doc = {
    _id,
    userId,
    type: input.type,
    label: input.label,
    endpoint: input.endpoint,
    basePath: input.basePath || 'mcm-backups',
    ...(input.type === 's3'
      ? {
          bucket: input.bucket ?? '',
          region: input.region || 'us-east-1',
          pathStyle: input.pathStyle ?? true,
          accessKeyId: input.accessKeyId ?? '',
        }
      : { username: input.username ?? '' }),
    ...(input.secret
      ? { secretEnc: encryptSecret(input.secret, backupEncryptionKey(), backupSecretAad(userId, _id)) }
      : {}),
    createdAt: now,
    updatedAt: now,
  } as BackupDestination;

  try {
    await collection.insertOne(doc);
  } catch (err) {
    // The unique index on { userId, label } is the enforcement point; this turns its driver
    // error into the store's own vocabulary so a route need not know about Mongo error codes.
    if ((err as { code?: number }).code === 11000) {
      throw new BackupDestinationInputError('You already have a destination with that label');
    }
    throw err;
  }

  const { secretEnc: _secretEnc, ...withoutSecret } = doc;
  void _secretEnc;
  return toView(withoutSecret);
}

export async function listDestinations(userId: string): Promise<BackupDestinationView[]> {
  const collection = await getBackupDestinationsCollection();
  const docs = await collection.find({ userId }, NO_SECRET).sort({ label: 1 }).toArray();
  return docs.map((d) => toView(d as Omit<BackupDestination, 'secretEnc'>));
}

export async function getDestination(
  userId: string,
  destinationId: string,
): Promise<BackupDestinationView | null> {
  const collection = await getBackupDestinationsCollection();
  const doc = await collection.findOne({ _id: destinationId, userId }, NO_SECRET);
  return doc ? toView(doc as Omit<BackupDestination, 'secretEnc'>) : null;
}

/**
 * The ONE way to obtain a plaintext destination secret, named so that reaching for it is a
 * visible act in a diff. Returns null when the destination does not exist or is not this
 * user's; THROWS when the stored blob fails to authenticate under this destination's AAD —
 * which means the blob is not the one sealed for it, and continuing would present one
 * destination's credential to another.
 */
export async function getDestinationSecret(
  userId: string,
  destinationId: string,
): Promise<string | null> {
  const collection = await getBackupDestinationsCollection();
  const doc = await collection.findOne({ _id: destinationId, userId });
  if (!doc) return null;
  if (!doc.secretEnc) return null;
  return decryptSecret(doc.secretEnc, backupEncryptionKey(), backupSecretAad(userId, destinationId));
}

export async function updateDestination(
  userId: string,
  destinationId: string,
  patch: DestinationPatch,
): Promise<BackupDestinationView | null> {
  if (patch.secret !== undefined && patch.secret === '') {
    // NOT a clear. Blanking a credential silently is indistinguishable from a UI bug that
    // dropped the field, and the user finds out at the next scheduled run.
    throw new BackupDestinationInputError(
      'A destination secret cannot be set to empty. Omit it to keep the stored one.',
    );
  }
  const collection = await getBackupDestinationsCollection();

  // A partial $set: fields absent from the patch are LEFT INTACT, which is what makes an update
  // that omits `secret` preserve the stored secret (FR-003) rather than needing a read-modify-
  // write the caller could get wrong.
  const { secret, ...rest } = patch;
  const $set: Record<string, unknown> = { ...rest, updatedAt: new Date().toISOString() };
  if (secret !== undefined) {
    $set.secretEnc = encryptSecret(
      secret,
      backupEncryptionKey(),
      backupSecretAad(userId, destinationId),
    );
  }

  try {
    const doc = await collection.findOneAndUpdate({ _id: destinationId, userId }, { $set }, {
      returnDocument: 'after',
      projection: { secretEnc: 0 },
    });
    return doc ? toView(doc as Omit<BackupDestination, 'secretEnc'>) : null;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new BackupDestinationInputError('You already have a destination with that label');
    }
    throw err;
  }
}

/** Record the outcome of a probe. Normalised — never an upstream body (FR-004). */
export async function recordTestResult(
  userId: string,
  destinationId: string,
  result: BackupTestResult,
): Promise<void> {
  const collection = await getBackupDestinationsCollection();
  await collection.updateOne(
    { _id: destinationId, userId },
    { $set: { lastTestedAt: new Date().toISOString(), lastTestResult: result } },
  );
}

/**
 * Delete a destination, and DISABLE every job that referenced it (FR-006).
 *
 * The jobs are disabled rather than deleted: the user built them, and a job is recoverable by
 * pointing it at another destination while a deleted one is not. Leaving them enabled would be
 * worse than either — they would fail on every scheduled run, for ever, reporting a cause that
 * is invisible from the job itself.
 *
 * The two writes are NOT atomic, because the BFF's Mongo is standalone and has no transactions.
 * The order is chosen so the survivable failure is the one that happens: jobs are disabled
 * FIRST, so a crash between the two leaves disabled jobs pointing at a destination that still
 * exists (harmless, re-enableable) rather than enabled jobs pointing at nothing.
 */
export async function deleteDestination(userId: string, destinationId: string): Promise<boolean> {
  const jobs = await getBackupJobsCollection();
  await jobs.updateMany(
    { userId, destinationId },
    {
      $set: { enabled: false, updatedAt: new Date().toISOString() },
      // UNSET rather than set to null: `nextRunAt` is an optional ISO string, and the tick's
      // query is a range over it. A null would still be a present field of the wrong type,
      // which is the kind of thing an index range answers unpredictably.
      $unset: { nextRunAt: '' },
    },
  );

  const collection = await getBackupDestinationsCollection();
  const result = await collection.deleteOne({ _id: destinationId, userId });
  return result.deletedCount === 1;
}
