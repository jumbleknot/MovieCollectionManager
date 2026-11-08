/**
 * Tell the member why an assistant turn did not run (feature 085, item #844 — US1 AS-1/AS-3).
 *
 * The BFF refuses a turn it cannot attribute — 401 when the sign-in is no longer valid, a
 * retryable 503 when the identity provider is unreachable — rather than running it without the
 * member's identity. CopilotKit reports a refused `/run` through its `onError` subscription, never
 * as a rejected promise, and for a non-2xx response the error's message IS the response body, so
 * the BFF's `code` is what decides the text. Before 085 a failed turn showed nothing at all.
 */
import { useEffect, useState } from 'react';
import { useCopilotKit } from '@copilotkit/react-native';

const TEMPORARILY_UNAVAILABLE = 'The assistant is temporarily unavailable. Please try again.';
const SIGN_IN_AGAIN = 'Your session has expired. Please sign in again.';
const GENERIC = "The assistant couldn't respond. Please try again.";

const RETRYABLE_CODES = new Set([
  'AGENT_IDENTITY_UNAVAILABLE',
  'KEYCLOAK_UNAVAILABLE',
  'SESSION_RENEWAL_PENDING',
]);
const SIGN_IN_CODES = new Set([
  'AGENT_IDENTITY_REJECTED',
  'REFRESH_FAILED',
  'SESSION_NOT_FOUND',
  'SESSION_EXPIRED',
  'SESSION_IDLE_TIMEOUT',
  'SESSION_ABSOLUTE_TIMEOUT',
  'UNAUTHORIZED',
]);

/** The run-failure codes CopilotKit core emits for a turn that did not complete. */
const RUN_FAILURE_CODES = new Set([
  'agent_run_failed',
  'agent_run_failed_event',
  'agent_run_error_event',
]);

function bffCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    const body: unknown = JSON.parse(error.message);
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The member-facing text for a failed turn. Never echoes the error itself. */
export function assistantRunFailureNotice(error: unknown): string {
  const code = bffCodeOf(error);
  if (code && RETRYABLE_CODES.has(code)) return TEMPORARILY_UNAVAILABLE;
  if (code && SIGN_IN_CODES.has(code)) return SIGN_IN_AGAIN;
  return GENERIC;
}

/**
 * The notice for the most recent failed turn, cleared when the next turn starts. Both happen in
 * CopilotKit's own subscriber callbacks (never synchronously inside an effect). `subscribe` is
 * optional-chained because test doubles of the CopilotKit core commonly omit it.
 */
export function useAssistantRunFailureNotice(): string | null {
  const { copilotkit } = useCopilotKit();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const subscription = copilotkit?.subscribe?.({
      onError: ({ error, code }: { error: unknown; code: string }) => {
        if (RUN_FAILURE_CODES.has(code)) setNotice(assistantRunFailureNotice(error));
      },
      onAgentRunStarted: () => setNotice(null),
    });
    return () => subscription?.unsubscribe();
  }, [copilotkit]);

  return notice;
}
