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
 * This binds each thread to the first user who uses it (Redis SET NX) and rejects (403, before
 * any gateway call) any later request whose user does not own the thread. Fail-closed: a Redis
 * outage surfaces as a typed error from `claimAgentThreadOwner`, not a silent bypass.
 */

import { claimAgentThreadOwner } from '@/bff-server/cache-service';
import { env } from '@/config/env';
import { ForbiddenError } from '@/types/errors';
import { logger } from '@/bff-server/logger';

/** Thread lifetime = the session's absolute window (threads expire with the session, per spec). */
function threadOwnerTtlSeconds(): number {
  return Math.max(1, Math.ceil(env.sessionAbsoluteTimeoutMs / 1000));
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
