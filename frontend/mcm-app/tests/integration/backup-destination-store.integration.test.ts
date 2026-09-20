/**
 * Backup destination store tests (feature 073, T018 — FR-002/003/006/034).
 *
 * AGAINST REAL MongoDB, not a mocked collection, and the reason is the subject matter. Every
 * property asserted here IS a Mongo behaviour: that a read PROJECTION excludes a field, that a
 * filter scopes by userId, that a partial `$set` leaves an omitted field intact. Mocking
 * findOne would assert those against my model of Mongo. The repo already draws the line here —
 * app-settings-store has a mocked unit test for its default-value LOGIC, while
 * agent-config-store, whose properties are exactly these, is an integration suite. tasks.md
 * placed this in the unit tier; this is the same subject as agent-config-store.
 *
 * THE CENTRAL ASSERTION is that leaking a secret is IMPOSSIBLE, not merely unlikely: `secretEnc`
 * is excluded at the STORE layer, so a route that forgets to strip it cannot leak it. That is
 * the difference between a control and a convention.
 */
import { randomUUID } from 'node:crypto';

import * as store from '@/bff-server/backup-destination-store';
import {
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';

const USER_A = `t018-a-${randomUUID()}`;
const USER_B = `t018-b-${randomUUID()}`;

const s3Input = (label: string) => ({
  type: 's3' as const,
  label,
  endpoint: 'https://s3.example.com',
  bucket: 'backups',
  region: 'us-east-1',
  pathStyle: true,
  accessKeyId: 'AKIDEXAMPLE',
  basePath: 'mcm-backups',
  secret: 'the-secret-access-key',
});

afterAll(async () => {
  const destinations = await getBackupDestinationsCollection();
  const jobs = await getBackupJobsCollection();
  await destinations.deleteMany({ userId: { $in: [USER_A, USER_B] } });
  await jobs.deleteMany({ userId: { $in: [USER_A, USER_B] } });
  await closeMongo();
});

describe('the read projection makes a secret leak impossible', () => {
  it('never returns secretEnc from create, get or list', async () => {
    const created = await store.createDestination(USER_A, s3Input(`proj-${randomUUID()}`));
    const fetched = await store.getDestination(USER_A, created.id);
    const [listed] = (await store.listDestinations(USER_A)).filter((d) => d.id === created.id);

    for (const view of [created, fetched, listed]) {
      // Asserted over the SERIALISED form as well: a field can survive a spread and be invisible
      // to a property check while still reaching the client in the response body.
      expect(JSON.stringify(view)).not.toContain('secretEnc');
      expect(JSON.stringify(view)).not.toContain('the-secret-access-key');
      expect((view as Record<string, unknown>).secretEnc).toBeUndefined();
    }
  });

  it('DID store the secret — the projection hides it, it does not drop it', async () => {
    // Without this, the test above would pass just as well against a store that silently
    // discarded the credential, and the failure would appear at the first backup run.
    const created = await store.createDestination(USER_A, s3Input(`stored-${randomUUID()}`));
    const raw = await (await getBackupDestinationsCollection()).findOne({ _id: created.id });
    expect(raw?.secretEnc).toBeTruthy();
    expect(raw?.secretEnc).not.toContain('the-secret-access-key'); // encrypted, not stored plain
  });

  it('exposes the secret only through an explicitly named accessor', async () => {
    const created = await store.createDestination(USER_A, s3Input(`explicit-${randomUUID()}`));
    const withSecret = await store.getDestinationSecret(USER_A, created.id);
    expect(withSecret).toBe('the-secret-access-key');
  });
});

describe('update preserves what it is not told about (FR-003)', () => {
  it('keeps the stored secret when the update omits it', async () => {
    const created = await store.createDestination(USER_A, s3Input(`keep-${randomUUID()}`));
    await store.updateDestination(USER_A, created.id, { label: 'renamed' });

    expect(await store.getDestinationSecret(USER_A, created.id)).toBe('the-secret-access-key');
    expect((await store.getDestination(USER_A, created.id))?.label).toBe('renamed');
  });

  it('REJECTS an empty-string secret instead of treating it as a clear', async () => {
    // Silently blanking a credential is indistinguishable from a UI bug, and the user would
    // find out at the next scheduled run.
    const created = await store.createDestination(USER_A, s3Input(`empty-${randomUUID()}`));
    await expect(store.updateDestination(USER_A, created.id, { secret: '' })).rejects.toThrow();
    expect(await store.getDestinationSecret(USER_A, created.id)).toBe('the-secret-access-key');
  });

  it('replaces the secret when a new one is supplied', async () => {
    const created = await store.createDestination(USER_A, s3Input(`replace-${randomUUID()}`));
    await store.updateDestination(USER_A, created.id, { secret: 'a-new-secret' });
    expect(await store.getDestinationSecret(USER_A, created.id)).toBe('a-new-secret');
  });
});

describe('every read is scoped to the caller (FR-034)', () => {
  it('returns null for another user’s destination', async () => {
    const created = await store.createDestination(USER_A, s3Input(`scope-${randomUUID()}`));
    expect(await store.getDestination(USER_B, created.id)).toBeNull();
    expect(await store.getDestinationSecret(USER_B, created.id)).toBeNull();
  });

  it('does not list another user’s destinations', async () => {
    await store.createDestination(USER_A, s3Input(`mine-${randomUUID()}`));
    expect(await store.listDestinations(USER_B)).toEqual([]);
  });

  it('will not update or delete another user’s destination', async () => {
    const created = await store.createDestination(USER_A, s3Input(`foreign-${randomUUID()}`));
    expect(await store.updateDestination(USER_B, created.id, { label: 'hijacked' })).toBeNull();
    expect(await store.deleteDestination(USER_B, created.id)).toBe(false);
    expect((await store.getDestination(USER_A, created.id))?.label).not.toBe('hijacked');
  });

  it('binds the secret to its OWN destination, so two of one user’s secrets are not interchangeable', async () => {
    // The AAD includes the destination id. Swap the blobs and decryption must FAIL rather than
    // hand the WebDAV password to S3.
    const one = await store.createDestination(USER_A, s3Input(`aad-1-${randomUUID()}`));
    const two = await store.createDestination(USER_A, s3Input(`aad-2-${randomUUID()}`));
    const collection = await getBackupDestinationsCollection();
    const rawOne = await collection.findOne({ _id: one.id });
    await collection.updateOne({ _id: two.id }, { $set: { secretEnc: rawOne!.secretEnc! } });

    await expect(store.getDestinationSecret(USER_A, two.id)).rejects.toThrow();
  });
});

describe('delete (FR-006)', () => {
  it('removes the destination and its stored secret', async () => {
    const created = await store.createDestination(USER_A, s3Input(`del-${randomUUID()}`));
    expect(await store.deleteDestination(USER_A, created.id)).toBe(true);
    expect(await store.getDestination(USER_A, created.id)).toBeNull();
    expect(await (await getBackupDestinationsCollection()).findOne({ _id: created.id })).toBeNull();
  });

  it('DISABLES referencing jobs rather than leaving them pointed at nothing', async () => {
    // A job whose destination is gone would otherwise fail on every scheduled run for ever,
    // reporting a failure the user cannot act on because the cause is invisible from the job.
    const created = await store.createDestination(USER_A, s3Input(`jobs-${randomUUID()}`));
    const jobs = await getBackupJobsCollection();
    const jobId = randomUUID();
    await jobs.insertOne({
      _id: jobId,
      userId: USER_A,
      destinationId: created.id,
      label: 'nightly',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
      nextRunAt: new Date().toISOString(),
      claimedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await store.deleteDestination(USER_A, created.id);

    const after = await jobs.findOne({ _id: jobId });
    expect(after?.enabled).toBe(false);
    // And it must not be left due, or the tick would keep picking it up.
    expect(after?.nextRunAt ?? null).toBeNull();
  });
});

describe('labels', () => {
  it('rejects a duplicate label for the same user', async () => {
    // Two destinations with the same label are a trap at the moment it matters most: choosing
    // one in a job form, where the label is all the user sees.
    const label = `dup-${randomUUID()}`;
    await store.createDestination(USER_A, s3Input(label));
    await expect(store.createDestination(USER_A, s3Input(label))).rejects.toThrow();
  });

  it('allows the SAME label for a different user', async () => {
    const label = `shared-${randomUUID()}`;
    await store.createDestination(USER_A, s3Input(label));
    await expect(store.createDestination(USER_B, s3Input(label))).resolves.toBeTruthy();
  });
});
