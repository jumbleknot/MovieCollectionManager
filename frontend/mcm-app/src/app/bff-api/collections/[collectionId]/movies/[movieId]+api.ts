/**
 * BFF /bff-api/collections/[collectionId]/movies/[movieId] route (T095 + T147)
 *
 * GET    /bff-api/collections/:id/movies/:movieId → get a single movie (T095)
 * PUT    /bff-api/collections/:id/movies/:movieId → full replacement update (T095)
 * DELETE /bff-api/collections/:id/movies/:movieId → permanently delete a movie (T147)
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

// ─── Route parameter type ──────────────────────────────────────────────────────

interface MovieRouteParams {
  params: { collectionId: string; movieId: string };
}

// ─── GET /bff-api/collections/:id/movies/:movieId ─────────────────────────────

export async function GET(req: Request, { params }: MovieRouteParams): Promise<Response> {
  return withRequestContext(() => _get(req, params.collectionId, params.movieId));
}

async function _get(req: Request, collectionId: string, movieId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const { status, data } = await client.get(
      `/api/v1/collections/${collectionId}/movies/${movieId}`,
    );
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'movie_get');
  }
}

// ─── PUT /bff-api/collections/:id/movies/:movieId ─────────────────────────────

export async function PUT(req: Request, { params }: MovieRouteParams): Promise<Response> {
  return withRequestContext(() => _put(req, params.collectionId, params.movieId));
}

async function _put(req: Request, collectionId: string, movieId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const body = await req.json();
    const { status, data } = await client.put(
      `/api/v1/collections/${collectionId}/movies/${movieId}`,
      body,
    );
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'movie_update');
  }
}

// ─── DELETE /bff-api/collections/:id/movies/:movieId ──────────────────────────

export async function DELETE(req: Request, { params }: MovieRouteParams): Promise<Response> {
  return withRequestContext(() => _delete(req, params.collectionId, params.movieId));
}

async function _delete(req: Request, collectionId: string, movieId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    await client.delete(`/api/v1/collections/${collectionId}/movies/${movieId}`);
    return new Response(null, { status: 204, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'movie_delete');
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
