/**
 * BFF /bff-api/agent/resume route (T044) — HITL approval authorization point.
 *
 * Resumes an interrupted agent run after a human approve/reject decision. In-session auth is
 * sufficient — no step-up (FR-006a). Responsibilities (contract: agent-bff-routes.md):
 *   1. requireAuth → requireMcUser (401/403 exactly as every BFF route; proven by T028a).
 *   2. Validate the decision body (deny-by-default → 400; never forwarded if invalid).
 *   3. Mint a FRESH run-scoped subject token — the paused run held none (SC-004); the gateway
 *      re-exchanges it for the approved writes. Best-effort like /run (the tool-free graph
 *      resumes without it; once US1 tools are deployed the writes require it).
 *   4. Record an ApprovalDecision to the audit trail (SC-002). OpenSearch is the eventual
 *      append-only sink (T030); `logger.audit` is the MVP record — userId (never PII), thread,
 *      proposal, decision, requestId.
 *   5. Forward the resume to the gateway and proxy the continuation AG-UI stream unchanged.
 *
 * No raw token is ever returned to the client, logged, or checkpointed.
 */

import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { parseResumeRequest } from '@/bff-server/agent-resume';
import { enforceAgentThreadOwnership } from '@/bff-server/agent-thread-owner';
import { resumeMovieAssistantRun } from '@/bff-server/agent-gateway-client';
import { mintSubjectToken, isSubjectTokenExchangeConfigured } from '@/bff-server/agent-subject-token';
import { logger } from '@/bff-server/logger';
import { audit } from '@/bff-server/audit-sink';

/**
 * Best-effort fresh subject-token mint for the resume (paused run held none). Returns
 * undefined when token exchange is unconfigured, no user token is present, or the mint fails
 * — the tool-free graph still resumes. Never logged or checkpointed (SC-004).
 */
async function resolveSubjectToken(
  headers: Record<string, string | string[] | undefined>,
): Promise<string | undefined> {
  if (!isSubjectTokenExchangeConfigured()) return undefined;
  const userToken = extractRawToken(headers);
  if (!userToken) return undefined;
  try {
    const { token } = await mintSubjectToken(userToken);
    return token;
  } catch {
    logger.warn('Proceeding without agent subject token on resume', { action: 'agent_resume' });
    return undefined;
  }
}

async function gated(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);

    const body = await req.json().catch(() => ({}));
    const { threadId, proposalId, decision } = parseResumeRequest(body);

    // Bind the thread to its owner BEFORE minting a token or touching the gateway — a cross-user
    // thread_id throws ForbiddenError → 403, so one user cannot resume another's checkpointed
    // run (implementation-review 2026-06-09 cross-user resume guard).
    await enforceAgentThreadOwnership(user.id, threadId);

    const subjectToken = await resolveSubjectToken(headers);

    // Approval decision audit (SC-002). userId is the Keycloak UUID — never email/username.
    audit('approval_decision', { userId: user.id, threadId, proposalId, decision });

    return resumeMovieAssistantRun({ threadId, proposalId, decision, subjectToken });
  } catch (err) {
    return handleMcApiError(err, 'agent_resume');
  }
}

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => gated(req));
}
