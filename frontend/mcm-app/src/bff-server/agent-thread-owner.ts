/**
 * Agent thread-ownership binding (implementation-review 2026-06-09 follow-up).
 *
 * Security: a CopilotKit `thread_id` is generated client-side and, on its own, is not bound to
 * the authenticated user. The agent gateway keys its LangGraph checkpoint solely on that
 * thread_id, so a user who presents another user's thread_id could resume that thread and see the
 * checkpointed proposal's preview (collection/movie names). Cross-user *writes* are already
 * blocked — the subject token is re-minted from the resuming user's session, so mc-service DAC
 * 404s — but the preview disclosure is a real isolation gap.
 *
 * This binds each thread to the first user who uses it and rejects (403, before any gateway call)
 * any later request whose user does not own the thread. The owner's every use refreshes the claim
 * (spec 102). Fail-closed: a Redis outage or an inconclusive answer surfaces as a typed 503 from
 * `claimAgentThreadOwner`, not a silent bypass.
 */

import { claimAgentThreadOwner } from '@/bff-server/cache-service';
import { env } from '@/config/env';
import { ForbiddenError } from '@/types/errors';
import { logger } from '@/bff-server/logger';

/**
 * The claim lives TWICE the gateway's checkpoint retention, sliding on every use (spec 102, item
 * #975). The invariant is that a checkpoint never exists without its owner's claim. Both stores
 * slide on use: the claim is refreshed here BEFORE a run, and the gateway writes the checkpoint
 * DURING the run. So the claim outlives the checkpoint whenever its TTL exceeds the retention by
 * more than a run lasts. Nothing bounds a run's duration (the gateway stream is proxied without a
 * timeout), so the margin is a whole retention window, which no run reaches. A gateway restart only
 * shortens the checkpoint's life. The gateway reads the same `AGENT_THREAD_RETENTION_SECONDS`.
 */
function threadOwnerTtlSeconds(): number {
  return 2 * Math.max(1, env.agentThreadRetentionSeconds);
}

/**
 * Enforce that `userId` owns `threadId` before a run/resume reaches the gateway. Claims the
 * thread on first use; throws ForbiddenError (403) on a cross-user mismatch. A missing/blank
 * threadId is a no-op — there is nothing to bind (and nothing to resume without a thread id).
 */
export async function enforceAgentThreadOwnership(
  userId: string,
  threadId: string | undefined,
): Promise<void> {
  if (!threadId || threadId.trim().length === 0) return;
  const owner = await claimAgentThreadOwner(threadId, userId, threadOwnerTtlSeconds());
  if (owner !== userId) {
    logger.audit('agent_thread_ownership_denied', { userId, threadId });
    throw new ForbiddenError('This conversation does not belong to you.');
  }
}
