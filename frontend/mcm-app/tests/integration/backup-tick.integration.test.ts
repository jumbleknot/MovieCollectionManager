/**
 * The scheduling tick (feature 073, T057 — FR-017/FR-018/FR-020; US4-AC1, US4-AC4, US4-AC6).
 *
 * TIME IS DRIVEN, NEVER AWAITED. Every case supplies the instant through `?now=`. A scheduling
 * test that sleeps until a job is due is slow when it passes and flaky when it does not, and
 * this repository has paid for flaky E2E more than once.
 *
 * THE HANDLER IS CALLED IN-PROCESS, with a `Request` this suite constructs. That is not a
 * convenience: case 4 is "the run succeeds with EVERY cookie cleared", and the only way to be
 * certain no cookie was sent is to build the request and know there is no cookie header on it.
 * Driving a browser or an HTTP client leaves room for one to be added by something else.
 *
 * ON THE RED FOR CASE 1: before the route exists it 404s for every request, which coincides
 * with case 1's expected result. Case 1 is therefore NOT meaningful at RED — it becomes
 * meaningful only once the other cases pass and a 404 can no longer be explained by absence.
 * tasks.md calls this out and it is recorded here rather than counted as a genuine RED.
 */
import { randomUUID } from 'node:crypto';

import {
  createTestUser,
  deleteTestUser,
  assignRole,
  type TestUser,
} from './helpers/keycloak-test-client';
import { acquireOfflineRefreshToken } from './helpers/offline-token-flow';
import { describeBackupTargets, assertBackupTargetsPresent } from './helpers/backup-targets';

import * as offlineToken from '@/bff-server/backup-offline-token';
import * as destinationStore from '@/bff-server/backup-destination-store';
import * as jobStore from '@/bff-server/backup-job-store';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import {
  getAgentConfigCollection,
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';
import { env } from '@/config/env';
import type { S3BackupDestination } from '@/types/backups';

import { POST as tick } from '@/app/bff-api/backups/tick+api';

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT || 'http://localhost:9100';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

const TICK_SECRET = process.env.BACKUP_TICK_SECRET || '';
const NOW = '2026-07-15T03:00:00.000Z';

jest.setTimeout(90_000);

/** No cookie header, ever. That absence is the assertion in case 4. */
function tickRequest(
  opts: { secret?: string | null; now?: string | null } = {},
): Request {
  const url = new URL('http://localhost:8081/bff-api/backups/tick');
  if (opts.now !== null) url.searchParams.set('now', opts.now ?? NOW);
  const headers: Record<string, string> = {};
  const secret = opts.secret === undefined ? TICK_SECRET : opts.secret;
  if (secret !== null) headers['x-backup-tick-secret'] = secret;
  return new Request(url, { method: 'POST', headers });
}

describeBackupTargets('the scheduling tick', () => {
  let user: TestUser;
  let destinationId: string;
  const prefix = `tick-${randomUUID()}`;

  beforeAll(async () => {
    assertBackupTargetsPresent();
    expect(TICK_SECRET).not.toBe(''); // without it every case below 404s and proves nothing
    user = await createTestUser('t057-tick');
    await assignRole(user.userId, 'mc-user');
    const token = await acquireOfflineRefreshToken(user.username, user.password);
    await offlineToken.storeOfflineToken(user.userId, token);
    destinationId = (
      await destinationStore.createDestination(user.userId, {
        type: 's3',
        label: `tick-${randomUUID()}`,
        endpoint: S3_ENDPOINT,
        bucket: S3_BUCKET,
        region: 'us-east-1',
        pathStyle: true,
        accessKeyId: S3_ACCESS_KEY,
        basePath: `${prefix}/${user.userId}`,
        secret: S3_SECRET,
      })
    ).id;
  });

  afterAll(async () => {
    await (await getBackupDestinationsCollection()).deleteMany({ userId: user?.userId });
    await (await getBackupJobsCollection()).deleteMany({ userId: user?.userId });
    await (await getBackupRunsCollection()).deleteMany({ userId: user?.userId });
    await (await getAgentConfigCollection()).deleteMany({ _id: user?.userId });
    await deleteTestUser(user?.userId);
    await closeMongo();
  });

  afterEach(async () => {
    await (await getBackupJobsCollection()).deleteMany({ userId: user.userId });
    await (await getBackupRunsCollection()).deleteMany({ userId: user.userId });
  });

  async function scheduledJob(nextRunAt: string | undefined): Promise<string> {
    const job = await jobStore.createJob(user.userId, {
      destinationId,
      label: `tick-job-${randomUUID().slice(0, 8)}`,
      collectionIds: [],
      keepLast: 7,
      enabled: true,
      schedule: { frequency: 'daily', hour: 3, minute: 0, timeZone: 'UTC' },
    });
    await (await getBackupJobsCollection()).updateOne(
      { _id: job.id },
      nextRunAt === undefined ? { $unset: { nextRunAt: '' } } : { $set: { nextRunAt } },
    );
    return job.id;
  }

  const artifactsFor = async (jobId: string) => {
    const driver = await createBackupDriver(
      {
        _id: 'probe',
        userId: user.userId,
        type: 's3',
        label: 'probe',
        endpoint: S3_ENDPOINT,
        bucket: S3_BUCKET,
        region: 'us-east-1',
        pathStyle: true,
        accessKeyId: S3_ACCESS_KEY,
        basePath: `${prefix}/${user.userId}`,
        createdAt: NOW,
        updatedAt: NOW,
      } as S3BackupDestination,
      S3_SECRET,
    );
    return driver.list(`${prefix}/${user.userId}/${jobId}/`);
  };

  describe('the route does not advertise itself', () => {
    // CASE 1 — see the header note: not meaningful at RED, meaningful here.
    it('answers 404, not 401, with no secret at all', async () => {
      expect((await tick(tickRequest({ secret: null }))).status).toBe(404);
    });

    it('answers 404 to a wrong secret', async () => {
      expect((await tick(tickRequest({ secret: 'not-the-secret' }))).status).toBe(404);
    });

    it('answers 404 to a secret of the right length but wrong content', async () => {
      // A constant-time comparison must still REJECT. A length-only check would pass this.
      const sameLength = 'x'.repeat(TICK_SECRET.length);
      expect((await tick(tickRequest({ secret: sameLength }))).status).toBe(404);
    });
  });

  describe('due and not due', () => {
    it('runs a due job and writes exactly one artifact', async () => {
      const jobId = await scheduledJob('2026-07-15T03:00:00.000Z');

      const res = await tick(tickRequest());
      const body = (await res.json()) as { leader: boolean; claimed: number };

      expect(res.status).toBe(200);
      expect(body.leader).toBe(true);
      expect(body.claimed).toBe(1);
      expect(await artifactsFor(jobId)).toHaveLength(1);
    });

    it('leaves a job that is not yet due alone', async () => {
      const jobId = await scheduledJob('2026-07-15T03:00:00.001Z');

      const body = (await (await tick(tickRequest())).json()) as { claimed: number };

      expect(body.claimed).toBe(0);
      expect(await artifactsFor(jobId)).toHaveLength(0);
    });

    it('leaves an on-demand-only job alone for ever', async () => {
      const jobId = await scheduledJob(undefined);

      const body = (await (await tick(tickRequest())).json()) as { claimed: number };

      expect(body.claimed).toBe(0);
      expect(await artifactsFor(jobId)).toHaveLength(0);
    });

    it('moves the job forward to its next occurrence', async () => {
      const jobId = await scheduledJob('2026-07-15T03:00:00.000Z');

      await tick(tickRequest());

      const stored = await (await getBackupJobsCollection()).findOne({ _id: jobId });
      // Next day, same local 03:00 — and the claim released, or the job would be stuck.
      expect(stored?.nextRunAt).toBe('2026-07-16T03:00:00.000Z');
      expect(stored?.claimedAt).toBeNull();
    });
  });

  describe('two instances, one run', () => {
    it('claims exactly once across two concurrent ticks', async () => {
      const jobId = await scheduledJob('2026-07-15T03:00:00.000Z');

      const [a, b] = await Promise.all([tick(tickRequest()), tick(tickRequest())]);
      const bodies = (await Promise.all([a.json(), b.json()])) as {
        leader: boolean;
        claimed: number;
      }[];

      // `leader: false` is a NORMAL outcome — another instance is doing the work — so it is a
      // 200 with a plain answer, not an error. Reporting it as a fault would make routine
      // multi-instance operation look broken in every log and every metric.
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(bodies.reduce((n, x) => n + x.claimed, 0)).toBe(1);
      expect(await artifactsFor(jobId)).toHaveLength(1);
    });
  });

  describe('unattended — no session, no cookie (US4-AC1)', () => {
    it('runs on the stored standing permission alone', async () => {
      const jobId = await scheduledJob('2026-07-15T03:00:00.000Z');
      const request = tickRequest();
      // The assertion behind the assertion: nothing resembling a session travelled with this.
      expect(request.headers.get('cookie')).toBeNull();
      expect(request.headers.get('authorization')).toBeNull();

      const body = (await (await tick(request)).json()) as { claimed: number };

      expect(body.claimed).toBe(1);
      expect(await artifactsFor(jobId)).toHaveLength(1);
    });

    it('fails the run, without an artifact, once the grant is revoked', async () => {
      await offlineToken.revokeOfflineToken(user.userId);
      const jobId = await scheduledJob('2026-07-15T03:00:00.000Z');

      const body = (await (await tick(tickRequest())).json()) as { claimed: number };

      expect(body.claimed).toBe(1); // claimed and attempted…
      expect(await artifactsFor(jobId)).toHaveLength(0); // …but nothing written
      const run = await (await getBackupRunsCollection()).findOne({ jobId });
      expect(run?.status).toBe('failed');
      expect(run?.failureReason).toMatch(/re-enable/i);

      // Restore the grant for the remaining cases.
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);
    });
  });

  describe('recovery after downtime (FR-020)', () => {
    it('runs ONCE for a job whose time passed weeks ago, not once per missed occurrence', async () => {
      // Three weeks of missed daily occurrences. A scheduler that enumerated them would write
      // twenty-one artifacts and, with keep-last retention, immediately prune the real history
      // away — the downtime would destroy the backups rather than delay them.
      const jobId = await scheduledJob('2026-06-24T03:00:00.000Z');

      const body = (await (await tick(tickRequest())).json()) as { claimed: number };

      expect(body.claimed).toBe(1);
      expect(await artifactsFor(jobId)).toHaveLength(1);
      const stored = await (await getBackupJobsCollection()).findOne({ _id: jobId });
      // And it lands in the FUTURE, not on the next missed occurrence — otherwise the next
      // tick runs again, and the catch-up becomes a loop.
      expect(new Date(stored!.nextRunAt!).getTime()).toBeGreaterThan(new Date(NOW).getTime());
    });
  });

  describe('the time override is not a production capability', () => {
    it('is rejected unless the deployment explicitly allows it', async () => {
      const allowed = env.backupTickAllowTimeOverride;
      expect(allowed).toBe(true); // the integration env opts in; production never does

      // Simulate a deployment that has not opted in. `env` is `as const`, which is a
      // COMPILE-TIME assertion only — at runtime it is an ordinary mutable object, so the flag
      // is set directly rather than through a getter spy, which has nothing to intercept.
      const mutableEnv = env as unknown as { backupTickAllowTimeOverride: boolean };
      mutableEnv.backupTickAllowTimeOverride = false;
      try {
        const res = await tick(tickRequest({ now: '2026-07-15T03:00:00.000Z' }));
        expect(res.status).toBe(400);
        // And the refusal is total: nothing ran on the supplied instant.
        expect((await res.json()).title).toMatch(/override/i);
      } finally {
        mutableEnv.backupTickAllowTimeOverride = allowed;
      }
    });

    it('ticks on the real clock when no override is supplied', async () => {
      // Nothing is due at the real `now`, so this asserts the route works without the
      // override at all — the production path.
      await scheduledJob('2099-01-01T00:00:00.000Z');

      const res = await tick(tickRequest({ now: null }));
      const body = (await res.json()) as { leader: boolean; claimed: number };

      expect(res.status).toBe(200);
      expect(body.claimed).toBe(0);
    });
  });
});
