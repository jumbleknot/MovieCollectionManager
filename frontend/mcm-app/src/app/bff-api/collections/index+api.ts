/**
 * BFF /bff-api/collections route (T050)
 *
 * GET  /bff-api/collections → list all collections for the authenticated user
 * POST /bff-api/collections → create a new collection
 *
 * Both handlers:
 *   1. Validate the JWT via requireAuth (throws UnauthorizedError if missing/invalid)
 *   2. Extract the raw JWT string via extractRawToken (safe after requireAuth validates)
 *   3. Forward the request to mc-service via createMcServiceClient(jwt)
 *   4. Return the mc-service response (status + body) to the client
 *   5. Propagate mc-service error responses (RFC 9457) unchanged
 */

import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { AuthError, AuthErrorCode } from '@/types/errors';
import axios from 'axios';

// ─── GET /bff-api/collections ──────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  return withRequestContext(() => _get(req));
}

async function _get(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const { status, data } = await client.get('/api/v1/collections');
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'collections_list');
  }
}

// ─── POST /bff-api/collections ─────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => _post(req));
}

async function _post(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const body = await req.json();
    const { status, data } = await client.post('/api/v1/collections', body);
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'collections_create');
  }
}

// ─── Shared error handler ──────────────────────────────────────────────────────

function handleError(err: unknown, action: string): Response {
  // Auth errors (401, 403) — audit-log and return as-is
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

  // Unexpected errors — log internally, never expose details
  logger.error(`${action}: unhandled error`, { action, error: err });
  return Response.json(
    { error: 'An unexpected error occurred.', code: AuthErrorCode.UNKNOWN_ERROR },
    { status: 500, headers: securityHeaders() },
  );
}
