/**
 * Shared error handler for BFF API routes that proxy to mc-service (T050–T121).
 *
 * Centralises the three-case pattern repeated in every collection/movie route:
 *   1. AuthError  → return typed auth response (401 / 403)
 *   2. Axios error with mc-service response → propagate RFC 9457 body unchanged
 *   3. Unexpected error → 500 with generic message (never exposes internals)
 *
 * Usage:
 *   import { handleMcApiError } from '@/bff-server/mc-api-error';
 *   ...
 *   } catch (err) {
 *     return handleMcApiError(err, 'collection_list');
 *   }
 */

import axios from 'axios';
import { logger } from '@/bff-server/logger';
import { securityHeaders } from '@/bff-server/security-headers';
import { AuthError, AuthErrorCode } from '@/types/errors';

/**
 * Security headers plus whatever the refusal itself carries: cookies clearing a session that has
 * just ended, and a Retry-After on a retryable 503 (feature 085). Each cookie is its own
 * Set-Cookie line; joining them with commas would let the browser keep all but the first.
 */
export function authErrorHeaders(err: AuthError): Headers {
  const headers = securityHeaders();
  for (const cookie of err.clearCookies ?? []) headers.append('Set-Cookie', cookie);
  if (err.retryAfterSeconds !== undefined) headers.set('Retry-After', String(err.retryAfterSeconds));
  return headers;
}

export function handleMcApiError(err: unknown, action: string): Response {
  // Auth errors (401, 403) — audit-log; other 4xx — warn-log (010 US2, FR-005–FR-007).
  // Every 4xx the boundary returns is logged, so a client error (e.g. a 400 from
  // validateObjectId) is never silently swallowed.
  if (err instanceof AuthError) {
    if (err.statusCode === 401) {
      logger.audit('auth_failed', { action, code: err.code });
    } else if (err.statusCode === 403) {
      logger.audit('access_denied', { action, code: err.code });
    } else if (err.statusCode >= 400 && err.statusCode < 500) {
      logger.warn('mc-api client error', { action, statusCode: err.statusCode, code: err.code });
    }
    return Response.json(
      { error: err.message, code: err.code },
      { status: err.statusCode, headers: authErrorHeaders(err) },
    );
  }

  // mc-service error response — propagate RFC 9457 body and status unchanged;
  // audit-log upstream 401/403
  if (axios.isAxiosError(err) && err.response) {
    if (err.response.status === 401) {
      logger.audit('auth_failed', { action, upstream: 'mc-service' });
    } else if (err.response.status === 403) {
      logger.audit('access_denied', { action, upstream: 'mc-service' });
    } else if (err.response.status >= 400 && err.response.status < 500) {
      logger.warn('mc-api upstream client error', {
        action,
        statusCode: err.response.status,
        upstream: 'mc-service',
      });
    }
    return Response.json(err.response.data, {
      status: err.response.status,
      headers: securityHeaders(),
    });
  }

  // Unexpected errors — log internally, never expose details to client
  logger.error(`${action}: unhandled error`, { action, error: err });
  return Response.json(
    { error: 'An unexpected error occurred.', code: AuthErrorCode.UNKNOWN_ERROR },
    { status: 500, headers: securityHeaders() },
  );
}
