/**
 * BFF /bff-api/collections/[collectionId] route (T051)
 *
 * GET    /bff-api/collections/:id → get a single collection
 * PATCH  /bff-api/collections/:id → update a collection (name, description, isDefault)
 * DELETE /bff-api/collections/:id → delete a collection and all its movies
 *
 * All handlers:
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

// ─── GET /bff-api/collections/:id ─────────────────────────────────────────────

export async function GET(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _get(req, collectionId));
}

async function _get(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const { status, data } = await client.get(`/api/v1/collections/${collectionId}`);
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'collection_get');
  }
}

// ─── PATCH /bff-api/collections/:id ───────────────────────────────────────────

export async function PATCH(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _patch(req, collectionId));
}

async function _patch(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const body = await req.json();
    const { status, data } = await client.patch(`/api/v1/collections/${collectionId}`, body);
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'collection_update');
  }
}

// ─── DELETE /bff-api/collections/:id ──────────────────────────────────────────

export async function DELETE(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _delete(req, collectionId));
}

async function _delete(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const { status } = await client.delete(`/api/v1/collections/${collectionId}`);
    // 204 No Content — no body
    return new Response(null, { status, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'collection_delete');
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
