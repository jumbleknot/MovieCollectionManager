/**
 * BFF /bff-api/backups/tick — INTERNAL (feature 073, T058 — FR-017/FR-018/FR-020).
 *
 * The only place scheduled work happens. `server.js` calls it on a timer over loopback (T059);
 * nothing user-facing reaches it, and it holds no session.
 *
 * WHY IT 404s RATHER THAN 401s. A 401 says "this exists and you guessed wrong", which turns the
 * route into something worth attacking and worth enumerating. A 404 says nothing at all. The
 * comparison is constant-time, because a byte-at-a-time comparison against a secret is
 * measurable over enough requests and there is no reason to leave that on the table for what
 * costs one function call.
 *
 * WHY `leader: false` IS A 200. With more than one instance running, exactly one does the work
 * on each tick and the others correctly do nothing. That is routine operation, not a fault, and
 * reporting it as an error would make a healthy two-instance deployment log a failure every
 * minute for ever.
 *
 * EXACTLY-ONCE DOES NOT COME FROM THE LOCK. The Redis leader lock below is an optimisation: it
 * stops every instance scanning on every tick, and its safety rests on a TTL, which is a guess.
 * The guarantee is the single-document atomic claim in `backup-job-store` — see the note there.
 */
import { timingSafeEqual } from 'node:crypto';

import * as jobStore from '@/bff-server/backup-job-store';
import { computeNextRun } from '@/bff-server/backup-schedule';
import { runScheduledBackup } from '@/bff-server/backup-runner';
import { withLeaderLock } from '@/bff-server/redis-lock';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { logger } from '@/bff-server/logger';
import { env } from '@/config/env';

/** Longer than any single run this feature permits, so a slow run does not lose the lock. */
const LEADER_LOCK_TTL_SECONDS = 15 * 60;
const LEADER_LOCK = 'scheduler-tick';

const notFound = () =>
  Response.json(
    { type: 'about:blank', title: 'Not found', status: 404 },
    { status: 404, headers: securityHeaders() },
  );

/**
 * Constant-time secret comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the length, so the
 * lengths are checked first and a mismatch falls through to the SAME 404 — the caller cannot
 * tell a wrong length from wrong content.
 */
function secretMatches(presented: string | null): boolean {
  const expected = env.backupTickSecret;
  // No secret configured means the scheduler is not enabled. It must not then accept an empty
  // header and run everything.
  if (!expected) return false;
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  if (!secretMatches(req.headers.get('x-backup-tick-secret'))) return notFound();
  return withRequestContext(() => runTick(req));
}

async function runTick(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const override = url.searchParams.get('now');

  if (override !== null && !env.backupTickAllowTimeOverride) {
    // Deny by default. With the tick secret alone, "it is 03:00" would otherwise be something
    // a caller could assert — every schedule becomes runnable on demand.
    return Response.json(
      {
        type: 'about:blank',
        title: 'Time override not permitted',
        status: 400,
        detail: 'This deployment does not accept a supplied instant.',
      },
      { status: 400, headers: securityHeaders() },
    );
  }

  const now = override ? new Date(override) : new Date();
  if (Number.isNaN(now.getTime())) {
    return Response.json(
      { type: 'about:blank', title: 'Invalid instant', status: 400 },
      { status: 400, headers: securityHeaders() },
    );
  }

  const outcome = await withLeaderLock(LEADER_LOCK, LEADER_LOCK_TTL_SECONDS, () =>
    claimAndRunDueJobs(now),
  );

  if (!outcome.leader) {
    return Response.json({ leader: false, claimed: 0 }, { headers: securityHeaders() });
  }
  return Response.json({ leader: true, ...outcome.value }, { headers: securityHeaders() });
}

async function claimAndRunDueJobs(now: Date): Promise<{ due: number; claimed: number }> {
  const due = await jobStore.findDueJobs(now);
  let claimed = 0;

  // SEQUENTIAL, not `Promise.all`. Each run holds the whole artifact in memory (that is the
  // deliberate cost of not streaming), so running every due job at once turns a busy tick into
  // a memory spike on the application server — the exact resource exhaustion the size ceiling
  // exists to prevent, arriving by a different route.
  for (const candidate of due) {
    const job = await jobStore.claimDueJob(candidate._id, now);
    // `null` means another instance got there first. Normal, and not worth a log line.
    if (!job) continue;
    claimed += 1;

    try {
      await runScheduledBackup(job.userId, job._id);
    } catch (err) {
      // `runScheduledBackup` records its own failures as runs; reaching here means something
      // outside that, and one job must not stop the rest of the tick.
      logger.error('Scheduled backup threw outside the run recorder', {
        action: 'backup_tick_job_failed',
        userId: job.userId,
        jobId: job._id,
        error: err,
      });
    } finally {
      // ALWAYS released, and always with the next occurrence computed — in `finally`, because
      // a job left claimed is a job that does not run again until the reclaim ceiling expires,
      // and one left on its old `nextRunAt` runs again on the very next tick.
      //
      // FR-020: computed forward from NOW, not from the missed occurrence. A job that was due
      // three weeks ago gets its next run in the future and runs ONCE on recovery — advancing
      // occurrence by occurrence would fire twenty-one times and, with keep-last retention,
      // prune away the real history the downtime was supposed to have preserved.
      const nextRunAt = job.schedule && job.enabled ? computeNextRun(job.schedule, now) : null;
      await jobStore.releaseClaim(job._id, nextRunAt);
    }
  }

  if (claimed > 0) {
    logger.info('Scheduling tick ran due backup jobs', {
      action: 'backup_tick_completed',
      due: due.length,
      claimed,
    });
  }
  return { due: due.length, claimed };
}
