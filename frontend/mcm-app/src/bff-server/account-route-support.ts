/**
 * Shared helpers for the two account-deletion routes (feature 076).
 *
 * Separate from `backup-route-support` because these are not backup routes; sharing a
 * backup-named module for account deletion would make both harder to reason about.
 */

import { AuthError, UnauthorizedError, ForbiddenError, RateLimitError } from '@/types/errors';
import { securityHeaders } from '@/bff-server/security-headers';

/**
 * The deletion callback, on the origin THIS REQUEST arrived at.
 *
 * Both OAuth legs must present an identical value or the exchange fails `invalid_grant`, which
 * is why the authorize leg stashes what it used rather than letting the callback recompute it.
 */
export function deletionCallbackUri(req: Request): string {
  return `${new URL(req.url).origin}/bff-api/account/delete`;
}

/** RFC 9457 Problem Details, consistent with the rest of the BFF. */
export function problemResponse(title: string, status: number, detail?: string): Response {
  const headers = new Headers(securityHeaders());
  headers.set('Content-Type', 'application/problem+json');
  return new Response(
    JSON.stringify({ type: 'about:blank', title, status, ...(detail ? { detail } : {}) }),
    { status, headers },
  );
}

/**
 * Map a thrown error to a status without letting its message escape.
 *
 * The message is deliberately discarded by every caller: a failure here can carry a hostname, a
 * connection string or a Keycloak diagnostic, and the constitution forbids any of that reaching
 * the client. The status is the only thing derived from the error.
 */
export function errorStatus(err: unknown): number {
  if (err instanceof RateLimitError) return 429;
  if (err instanceof UnauthorizedError) return 401;
  if (err instanceof ForbiddenError) return 403;
  if (err instanceof AuthError) return err.statusCode ?? 500;
  const status = (err as { status?: number } | null)?.status;
  return typeof status === 'number' ? status : 500;
}

/** Where the callback sends the browser when the deletion did not happen. */
export const ACCOUNT_SETTINGS_PATH = '/settings/account';

/** Public, session-less confirmation page. */
export const ACCOUNT_DELETED_PATH = '/account-deleted';

/**
 * A redirect, not JSON.
 *
 * Keycloak sent the user's BROWSER to the callback, so whatever it returns is what they look at
 * next — and a page of JSON is not an answer to "is my account gone?".
 */
export function redirectTo(location: string, extraCookies: string[] = []): Response {
  const headers = new Headers(securityHeaders());
  headers.set('Location', location);
  for (const cookie of extraCookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}
