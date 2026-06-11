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

export interface ApprovalDecision {
  threadId?: string;
  proposalId?: string;
  decision: ResumeDecision;
}

/**
 * Extract a HITL approval decision from a CopilotKit runtime /run POST body, or null when the
 * run is not an interrupt resume. CopilotKit's `useInterrupt` resumes through /run (not
 * /resume), forwarding `body.forwardedProps.command.resume` (the decision) + `command.
 * interruptEvent` (the original approval_request JSON string, carrying the proposalId). This
 * lets /run record the SC-002 `approval_decision` audit on the path CopilotKit actually uses.
 * Tolerant by design — any shape mismatch returns null (never throws); the audit is best-effort
 * and must not affect the run.
 */
export function extractApprovalDecision(bodyText: string): ApprovalDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const body = (parsed as { body?: Record<string, unknown> })?.body;
  const command = (body?.forwardedProps as { command?: Record<string, unknown> })?.command;
  const resume = command?.resume as { decision?: unknown } | string | undefined;
  if (resume === undefined || resume === null) return null;

  const raw = typeof resume === 'string' ? resume : resume.decision;
  if (raw !== 'approved' && raw !== 'rejected') return null;

  let proposalId: string | undefined;
  const interruptEvent = command?.interruptEvent;
  if (typeof interruptEvent === 'string') {
    try {
      proposalId = (JSON.parse(interruptEvent) as { proposalId?: string }).proposalId;
    } catch {
      /* proposalId stays undefined — the decision audit is still recorded */
    }
  }
  const threadId = typeof body?.threadId === 'string' ? body.threadId : undefined;
  return { threadId, proposalId, decision: raw };
}

/**
 * Extract the client-supplied `thread_id` from a CopilotKit runtime /run POST body (it rides at
 * `body.threadId`, the same shape `extractApprovalDecision` reads — captured from a real resume).
 * Returns undefined for any shape mismatch (never throws). Used to bind a thread to its owner
 * (`enforceAgentThreadOwnership`) so one user cannot resume another user's checkpointed thread.
 */
export function extractThreadId(bodyText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const body = (parsed as { body?: Record<string, unknown> })?.body;
  return typeof body?.threadId === 'string' ? body.threadId : undefined;
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
