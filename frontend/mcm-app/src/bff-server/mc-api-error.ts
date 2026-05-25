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

export function handleMcApiError(err: unknown, action: string): Response {
  // Auth errors (401, 403) — audit-log and return structured response
  if (err instanceof AuthError) {
    if (err.statusCode === 401) {
      logger.audit('auth_failed', { action, code: err.code });
    } else if (err.statusCode === 403) {
      logger.audit('access_denied', { action, code: err.code });
    }
    return Response.json(
      { error: err.message, code: err.code },
      { status: err.statusCode, headers: securityHeaders() },
    );
  }

  // mc-service error response — propagate RFC 9457 body and status unchanged;
  // audit-log upstream 401/403
  if (axios.isAxiosError(err) && err.response) {
    if (err.response.status === 401) {
      logger.audit('auth_failed', { action, upstream: 'mc-service' });
    } else if (err.response.status === 403) {
      logger.audit('access_denied', { action, upstream: 'mc-service' });
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
