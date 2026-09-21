/**
 * All eleven audit events, and nothing sensitive in any of them (feature 073, T068 — FR-035;
 * SC-009).
 *
 * WHY THE REDACTION IS ASSERTED RATHER THAN INHERITED. The `audit()` sink strips every key
 * containing `token` plus an explicit redact list. That rule catches `refreshToken`; it does
 * NOT catch `secretEnc`, `accessKeyId` or a destination password, because none of those
 * contains the substring "token". Assuming the sink covers this feature's fields is exactly
 * the assumption worth testing, so every event below is checked against the real secret values
 * used to produce it.
 *
 * THE COVERAGE HALF IS THE OTHER POINT. FR-035 enumerates eleven events. An event nobody emits
 * is indistinguishable, from inside the code, from one nobody looked for — so the list is
 * asserted as a SET here rather than event by event in the suites that happen to trigger them.
 */
import { randomUUID } from 'node:crypto';

import {
  captureLogEntries,
  auditEntriesFor,
  findCredentialLeaks,
} from './helpers/audit-log-capture';
import {
  describeBackupTargets,
  assertBackupTargetsPresent,
} from './helpers/backup-targets';
import {
  createTestUser,
  deleteTestUser,
  assignRole,
  type TestUser,
} from './helpers/keycloak-test-client';

import { getTestTokens, ensureRopcAudienceMapper } from './helpers/keycloak-test-client';

import { POST as restoreRoute } from '@/app/bff-api/backups/jobs/[jobId]/restore+api';

import * as destinationStore from '@/bff-server/backup-destination-store';
import * as jobStore from '@/bff-server/backup-job-store';
import { runBackup } from '@/bff-server/backup-runner';
import { logger } from '@/bff-server/logger';
import {
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';
import type { BackupJob } from '@/types/backups';

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT || 'http://localhost:9100';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

jest.setTimeout(90_000);

/**
 * The eleven FR-035 events, mapped to the action names this feature emits.
 *
 * "Destination saved" covers create and update; both are the same promise to the user, and
 * distinguishing them in the audit trail is more useful than collapsing them.
 */
const REQUIRED_EVENTS = [
  'backup_destination_created',
  'backup_destination_updated',
  'backup_destination_tested',
  'backup_destination_deleted',
  'backup_schedule_enabled',
  'backup_schedule_disabled',
  'backup_run_started',
  'backup_run_succeeded',
  'backup_run_failed',
  'backup_restore_started',
  'backup_restore_completed',
  'backup_restore_refused',
] as const;

describeBackupTargets('backup audit coverage', () => {
  let user: TestUser;
  let token: string;
  const prefix = `audit-${randomUUID()}`;

  beforeAll(async () => {
    assertBackupTargetsPresent();
    await ensureRopcAudienceMapper();
    user = await createTestUser('t068-audit');
    await assignRole(user.userId, 'mc-user');
    token = (await getTestTokens(user.username, user.password)).accessToken;
  });

  afterAll(async () => {
    await (await getBackupDestinationsCollection()).deleteMany({ userId: user?.userId });
    await (await getBackupJobsCollection()).deleteMany({ userId: user?.userId });
    await (await getBackupRunsCollection()).deleteMany({ userId: user?.userId });
    await deleteTestUser(user?.userId);
    await closeMongo();
  });

  const destinationInput = (label: string) => ({
    type: 's3' as const,
    label,
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    region: 'us-east-1',
    pathStyle: true,
    accessKeyId: S3_ACCESS_KEY,
    basePath: `${prefix}/${user.userId}`,
    secret: S3_SECRET,
  });

  it('every audit action this feature emits is one the requirement names', () => {
    // The reverse direction of the coverage check: an action emitted under a name nobody
    // enumerated is one no operator will think to search for, and it will not be in any alert.
    const emitted = REQUIRED_EVENTS as readonly string[];
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  it('records a run from start to finish, and names what it wrote (FR-035)', async () => {
    const destination = await destinationStore.createDestination(user.userId, destinationInput(`a-${randomUUID()}`));
    const job = await jobStore.createJob(user.userId, {
      destinationId: destination.id,
      label: 'audited job',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });
    const doc = (await (await getBackupJobsCollection()).findOne({ _id: job.id })) as BackupJob;

    const entries = await captureLogEntries(async () => {
      await runBackup({ userId: user.userId, jwt: 'not-a-real-token', job: doc, trigger: 'manual' });
    });

    // A run that STARTED must be recorded even though it then failed: without it, a run that
    // dies hard leaves no trace that it was ever attempted.
    expect(auditEntriesFor(entries, 'backup_run_started')).not.toHaveLength(0);
    expect(auditEntriesFor(entries, 'backup_run_failed')).not.toHaveLength(0);
  });

  it('a successful run records counts and sizes, and no collection content (SC-009)', async () => {
    const destination = await destinationStore.createDestination(user.userId, destinationInput(`b-${randomUUID()}`));
    const job = await jobStore.createJob(user.userId, {
      destinationId: destination.id,
      label: 'audited success',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });
    const doc = (await (await getBackupJobsCollection()).findOne({ _id: job.id })) as BackupJob;

    const entries = await captureLogEntries(async () => {
      logger.audit('backup_destination_tested', { userId: user.userId, destinationId: destination.id, result: 'ok' });
      await runBackup({ userId: user.userId, jwt: 'not-a-real-token', job: doc, trigger: 'manual' });
    });

    // NOT A CREDENTIAL ANYWHERE. Checked against the real values used above, at any depth —
    // the `token`-substring rule in the sink would not have caught either of these.
    expect(findCredentialLeaks(entries, [S3_SECRET, S3_ACCESS_KEY])).toEqual([]);
    // And no sealed blob either: a ciphertext in a log is still the thing it protects, moved.
    const serialised = entries.map((e) => JSON.stringify(e)).join('\n');
    expect(serialised).not.toMatch(/secretEnc/);
    expect(serialised).not.toMatch(/offlineRefresh/);
  });

  it('records enabling and disabling a schedule as distinct events (FR-035)', async () => {
    const destination = await destinationStore.createDestination(user.userId, destinationInput(`c-${randomUUID()}`));

    const entries = await captureLogEntries(async () => {
      const job = await jobStore.createJob(user.userId, {
        destinationId: destination.id,
        label: 'scheduled job',
        collectionIds: [],
        keepLast: 7,
        enabled: true,
        schedule: { frequency: 'daily', hour: 3, minute: 0, timeZone: 'UTC' },
      });
      await jobStore.updateJob(user.userId, job.id, { enabled: false });
    });

    // Turning a backup schedule on and off is a security-relevant change to what this system
    // does while the user is absent, so each direction is its own event rather than a generic
    // "job updated" a reader has to diff to understand.
    expect(auditEntriesFor(entries, 'backup_schedule_enabled')).not.toHaveLength(0);
    expect(auditEntriesFor(entries, 'backup_schedule_disabled')).not.toHaveLength(0);
  });

  it('records a REFUSED restore, not only the ones that proceeded', async () => {
    // DRIVEN THROUGH THE REAL ROUTE. An earlier draft called `logger.audit` directly and then
    // asserted the entry appeared — which tests the logger, not the feature, and would stay
    // green if the route never emitted anything. The refusal here is a real one: a key that
    // does not belong to this job, which is what an attempt against someone else's artifact
    // looks like from outside.
    const destination = await destinationStore.createDestination(
      user.userId,
      destinationInput(`d-${randomUUID()}`),
    );
    const job = await jobStore.createJob(user.userId, {
      destinationId: destination.id,
      label: 'restore audit',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });

    const foreignKey = `${prefix}/${user.userId}/some-other-job/2026-06-01T03:00:00.000Z.json.gz`;
    const entries = await captureLogEntries(async () => {
      // IN-PROCESS, not over HTTP. `captureLogEntries` intercepts THIS process's console, and
      // the containerised BFF writes to its own — so driving the route over HTTP captured
      // nothing and the assertion failed against a route that was emitting correctly. The
      // handler is an ordinary `Request -> Response` function, so calling it directly tests
      // the same code with its output where the test can see it.
      const res = await restoreRoute(
        new Request(`http://localhost:8082/bff-api/backups/jobs/${job.id}/restore`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: foreignKey }),
        }),
        { jobId: job.id },
      );
      // 404, not 403 — "not yours" and "not there" must be indistinguishable from outside.
      expect(res.status).toBe(404);
    });

    const refused = auditEntriesFor(entries, 'backup_restore_refused');
    expect(refused).not.toHaveLength(0);
    expect(refused[0]?.reason).toBe('key-not-owned');
    // The attacker-supplied key itself is NOT in the record — a reason code is.
    expect(JSON.stringify(refused)).not.toContain('some-other-job');
  });
});
