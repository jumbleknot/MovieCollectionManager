/**
 * What the member is told when an assistant turn is refused (feature 085, item #844 — US1 AS-1/AS-3).
 *
 * The BFF now refuses a turn it cannot attribute instead of running it identity-less. CopilotKit
 * surfaces a refused `/run` as an `onError` whose message is the response body, so the BFF's error
 * `code` decides what the member reads. Before 085 the dock showed nothing at all for a failed run.
 */
import { assistantRunFailureNotice } from '@/components/agent/assistant-run-failure';

const body = (code: string) => new Error(JSON.stringify({ error: 'x', code }));

describe('assistantRunFailureNotice', () => {
  it.each(['AGENT_IDENTITY_UNAVAILABLE', 'KEYCLOAK_UNAVAILABLE', 'SESSION_RENEWAL_PENDING'])(
    '%s says the assistant is temporarily unavailable and can be retried (AS-3)',
    (code) => {
      expect(assistantRunFailureNotice(body(code))).toBe(
        'The assistant is temporarily unavailable. Please try again.',
      );
    },
  );

  it.each(['AGENT_IDENTITY_REJECTED', 'REFRESH_FAILED', 'SESSION_NOT_FOUND', 'SESSION_IDLE_TIMEOUT'])(
    '%s says the sign-in is no longer valid (AS-1)',
    (code) => {
      expect(assistantRunFailureNotice(body(code))).toBe('Your session has expired. Please sign in again.');
    },
  );

  it('anything else is a generic, retryable failure that names no internals', () => {
    expect(assistantRunFailureNotice(new Error('Internal Server Error'))).toBe(
      "The assistant couldn't respond. Please try again.",
    );
    expect(assistantRunFailureNotice('not an error')).toBe("The assistant couldn't respond. Please try again.");
  });
});
