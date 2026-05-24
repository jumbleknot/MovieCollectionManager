/**
 * BFF /bff-api/collections/[collectionId]/movies route (T094 + T120)
 *
 * GET  /bff-api/collections/:id/movies → list movies with cursor-based pagination and filters (T120)
 * POST /bff-api/collections/:id/movies → create a movie in the collection (T094)
 *
 * Handler:
 *   1. Validate the JWT via requireAuth (throws UnauthorizedError if missing/invalid)
 *   2. Extract the raw JWT string via extractRawToken (safe after requireAuth validates)
 *   3. Forward the request to mc-service via createMcServiceClient(jwt)
 *   4. Return the mc-service response (status + body) to the client
 *   5. Propagate mc-service error responses (RFC 9457) unchanged
 *
 * GET query params forwarded to mc-service:
 *   cursor, search, contentType, genre, childrens, rated, language,
 *   decade, owned, ownedMedia, ripped, ripQuality
 */

import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { AuthError, AuthErrorCode } from '@/types/errors';
import axios from 'axios';

// ─── Query params forwarded for GET (movie list) ───────────────────────────────

const LIST_QUERY_PARAMS = [
  'cursor', 'search', 'contentType', 'genre', 'childrens', 'rated',
  'language', 'decade', 'owned', 'ownedMedia', 'ripped', 'ripQuality',
] as const;

// ─── GET /bff-api/collections/:id/movies ──────────────────────────────────────

export async function GET(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _get(req, collectionId));
}

async function _get(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    // Forward all list query params to mc-service
    const url = new URL(req.url);
    const queryParams: Record<string, string | string[]> = {};
    for (const key of LIST_QUERY_PARAMS) {
      const all = url.searchParams.getAll(key);
      if (all.length === 1) queryParams[key] = all[0];
      else if (all.length > 1) queryParams[key] = all;
    }

    const { status, data } = await client.get(
      `/api/v1/collections/${collectionId}/movies`,
      { params: queryParams },
    );
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'movie_list');
  }
}

// ─── POST /bff-api/collections/:id/movies ─────────────────────────────────────

export async function POST(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _post(req, collectionId));
}

async function _post(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    await requireAuth(headers);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const body = await req.json();
    const { status, data } = await client.post(`/api/v1/collections/${collectionId}/movies`, body);
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleError(err, 'movie_create');
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
