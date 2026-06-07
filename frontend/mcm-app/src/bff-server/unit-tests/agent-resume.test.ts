/**
 * Unit tests for the agent resume-request validation (T044).
 *
 * The /bff-api/agent/resume route is the HITL approval authorization point (in-session, no
 * step-up — FR-006a). `parseResumeRequest` validates the client body before the BFF mints a
 * fresh subject token and resumes the checkpoint. Deny-by-default: a missing/blank field or
 * an unknown decision is a typed 400 (INVALID_INPUT), never forwarded to the gateway.
 */

import { parseResumeRequest } from '@/bff-server/agent-resume';
import { AuthError, AuthErrorCode } from '@/types/errors';

describe('parseResumeRequest', () => {
  it('accepts a well-formed approved decision', () => {
    const parsed = parseResumeRequest({ threadId: 't1', proposalId: 'p1', decision: 'approved' });
    expect(parsed).toEqual({ threadId: 't1', proposalId: 'p1', decision: 'approved' });
  });

  it('accepts a rejected decision', () => {
    const parsed = parseResumeRequest({ threadId: 't1', proposalId: 'p1', decision: 'rejected' });
    expect(parsed.decision).toBe('rejected');
  });

  it.each([
    ['missing threadId', { proposalId: 'p1', decision: 'approved' }],
    ['blank threadId', { threadId: '  ', proposalId: 'p1', decision: 'approved' }],
    ['missing proposalId', { threadId: 't1', decision: 'approved' }],
    ['missing decision', { threadId: 't1', proposalId: 'p1' }],
    ['unknown decision', { threadId: 't1', proposalId: 'p1', decision: 'maybe' }],
    ['non-string field', { threadId: 1, proposalId: 'p1', decision: 'approved' }],
    ['empty body', {}],
  ])('rejects %s with a 400 INVALID_INPUT', (_label, body) => {
    try {
      parseResumeRequest(body);
      throw new Error('expected parseResumeRequest to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).statusCode).toBe(400);
      expect((err as AuthError).code).toBe(AuthErrorCode.INVALID_INPUT);
    }
  });
});
