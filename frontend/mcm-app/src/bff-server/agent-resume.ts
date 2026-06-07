/**
 * Agent HITL resume-request validation (T044).
 *
 * The /bff-api/agent/resume route resumes an interrupted run after a human approval
 * decision. This is the approval authorization point — in-session auth is sufficient, no
 * step-up (FR-006a). `parseResumeRequest` validates the client body (deny-by-default) before
 * the route mints a fresh subject token and resumes the gateway checkpoint; an invalid body
 * is a typed 400 and never reaches the gateway.
 */

import { AuthError, AuthErrorCode } from '@/types/errors';

export type ResumeDecision = 'approved' | 'rejected';

export interface ResumeRequest {
  threadId: string;
  proposalId: string;
  decision: ResumeDecision;
}

function requireNonBlankString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AuthError(AuthErrorCode.INVALID_INPUT, `Invalid or missing '${field}'.`, 400);
  }
  return value;
}

/**
 * Validate and normalise a resume request body. Throws AuthError(INVALID_INPUT, 400) for a
 * missing/blank `threadId`/`proposalId` or a `decision` outside {approved, rejected}.
 */
export function parseResumeRequest(body: unknown): ResumeRequest {
  const obj = (body ?? {}) as Record<string, unknown>;
  const threadId = requireNonBlankString(obj.threadId, 'threadId');
  const proposalId = requireNonBlankString(obj.proposalId, 'proposalId');
  const decision = obj.decision;
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new AuthError(
      AuthErrorCode.INVALID_INPUT,
      "Invalid 'decision' (expected 'approved' or 'rejected').",
      400,
    );
  }
  return { threadId, proposalId, decision };
}
