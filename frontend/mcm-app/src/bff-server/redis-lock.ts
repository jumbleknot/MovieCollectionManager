// Redis leader lock for the scheduling tick (feature 073, FR-018).
//
// WHAT THIS IS FOR: with more than one BFF instance running, every instance would otherwise scan
// for due jobs on every tick. The lock means one does.
//
// WHAT THIS IS NOT: the exactly-once guarantee. Its safety rests on a TTL — a guess at how long a
// run can take — and a guess is not a guarantee. If a run overruns its TTL, a second instance
// acquires the lock legitimately and both are live at once. Exactly-once comes from the
// single-document atomic claim on the job itself (backup-job-store), which has no timing
// assumption in it at all. The two are independent on purpose, and a passing lock test must never
// be read as proof that a scheduled run cannot double-fire.

import { setLockIfAbsent, releaseLockIfHeld } from '@/bff-server/cache-service';
import { logger } from '@/bff-server/logger';

const lockKey = (name: string) => `backup-lock:${name}`;

/** Take the named lock for `holderId`. False means someone else holds it — a normal outcome. */
export async function acquireLock(
  name: string,
  holderId: string,
  ttlSeconds: number,
): Promise<boolean> {
  return setLockIfAbsent(lockKey(name), holderId, ttlSeconds);
}

/**
 * Release the named lock, but ONLY if `holderId` still holds it.
 *
 * The holder check is not defensive tidiness. Without it: instance A overruns its TTL, the lock
 * expires, instance B acquires it and starts working, then A finishes and releases — deleting
 * B's lock mid-run and letting a third instance start a second concurrent pass. A blind DEL
 * turns one late run into an unbounded fan-out.
 */
export async function releaseLock(name: string, holderId: string): Promise<boolean> {
  return releaseLockIfHeld(lockKey(name), holderId);
}

export type LeaderResult<T> = { leader: true; value: T } | { leader: false };

/**
 * Run `body` if this instance can take the lock, and always release it afterwards.
 *
 * `{ leader: false }` is a normal, non-error outcome — another instance is doing the work — so
 * it is returned rather than thrown. A throw here would make routine multi-instance operation
 * look like a fault in every log and every metric.
 */
export async function withLeaderLock<T>(
  name: string,
  ttlSeconds: number,
  body: () => Promise<T>,
): Promise<LeaderResult<T>> {
  const holderId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (!(await acquireLock(name, holderId, ttlSeconds))) {
    return { leader: false };
  }
  try {
    return { leader: true, value: await body() };
  } finally {
    // In `finally`, so a throwing body does not hold the lock for its whole TTL — that would
    // silence the scheduler until it expired, and the symptom would be "backups stopped" with
    // nothing saying why. A failed release is logged and swallowed: the TTL is the backstop, and
    // re-throwing here would mask the body's own error with a cleanup error.
    try {
      await releaseLock(name, holderId);
    } catch (err) {
      logger.warn('Backup leader lock release failed; falling back to its TTL', {
        action: 'backup_lock_release_failed',
        lock: name,
        error: err,
      });
    }
  }
}
