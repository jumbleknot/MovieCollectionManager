/**
 * Concurrent-session-cap integration test (009 FR-018) — US6.
 *
 * Simultaneous logins for one user must never leave the active-session count
 * above the configured maximum (the pre-add count check is TOCTOU-racy; the
 * post-add trim enforces the cap). Asserted against REAL Redis (db 1).
 */
import { randomUUID } from 'node:crypto';
import { createSession, getActiveSessionCount } from '@/bff-server/session-manager';
import { env } from '@/config/env';
import { redisFlushDb, closeRedis } from './helpers/redis-test-client';
import {
  captureLogEntries,
  auditEntriesFor,
  findCredentialLeaks,
} from './helpers/audit-log-capture';

describe('concurrent session cap — integration (real Redis db 1)', () => {
  beforeAll(async () => {
    await redisFlushDb();
  });
  afterAll(async () => {
    await redisFlushDb();
    await closeRedis();
  });
  beforeEach(async () => {
    await redisFlushDb();
  });

  it('never exceeds MAX_CONCURRENT_SESSIONS under simultaneous logins', async () => {
    const userId = randomUUID();
    const max = env.maxConcurrentSessions;

    // Fire max + 5 logins concurrently to exercise the race.
    await Promise.all(Array.from({ length: max + 5 }, () => createSession(userId)));

    expect(await getActiveSessionCount(userId)).toBeLessThanOrEqual(max);
  });

  // Feature 052 FR-001 — eviction was SILENT. `app-e2e` was diagnosed twice from configuration
  // alone because of it: the cap is 10 and there are 8 Playwright workers, which is "close", but no
  // eviction was ever observed and the BFF log had zero hits for `evict`, `concurrent` or `session`.
  // A cap that fires without saying so cannot be distinguished from one that never fires.
  it('emits a session_evicted audit event when the cap forces an eviction', async () => {
    const userId = randomUUID();
    const max = env.maxConcurrentSessions;

    // Fill exactly to the cap SEQUENTIALLY, so the next create is the one that must evict.
    // (The concurrent case above exercises the race; this one needs a deterministic trigger.)
    for (let i = 0; i < max; i += 1) await createSession(userId);

    const entries = await captureLogEntries(async () => {
      await createSession(userId);
    });

    const evictions = auditEntriesFor(entries, 'session_evicted');
    expect(evictions).toHaveLength(1);
    expect(evictions[0]).toMatchObject({ audit: true, userId });
  });

  // Feature 052 FR-004 — the event must not become a credential leak. The evicted session id is not
  // logged AT ALL. Logging it under `sessionId` would be redacted to a constant (useless) and would
  // still trip the `mcm-no-token-logging` SAST rule, which matches on the key name; logging it under
  // any other key would leak it. No form of including it is both useful and safe, and the counts do
  // not need it. The SAST gate caught the first attempt (run 1605).
  it('does not log the evicted session id in any form', async () => {
    const userId = randomUUID();
    const max = env.maxConcurrentSessions;

    const created: string[] = [];
    for (let i = 0; i < max; i += 1) created.push((await createSession(userId)).sessionId);

    const entries = await captureLogEntries(async () => {
      await createSession(userId);
    });

    const evictions = auditEntriesFor(entries, 'session_evicted');
    expect(evictions).toHaveLength(1);
    expect(evictions[0]).not.toHaveProperty('sessionId');
    // Belt and braces: no created session id appears anywhere in the serialised event, under any key.
    expect(findCredentialLeaks(evictions, created)).toEqual([]);
  });
});
