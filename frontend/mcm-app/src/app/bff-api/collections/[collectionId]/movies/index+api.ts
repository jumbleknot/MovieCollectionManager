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
import { requireMcUser } from '@/bff-server/role-check';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { validateObjectId } from '@/bff-server/resource-id';

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
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    validateObjectId(collectionId, 'collectionId');
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
    return handleMcApiError(err, 'movie_list');
  }
}

// ─── POST /bff-api/collections/:id/movies ─────────────────────────────────────

export async function POST(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _post(req, collectionId));
}

async function _post(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    validateObjectId(collectionId, 'collectionId');
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const body = await req.json();
    const { status, data } = await client.post(`/api/v1/collections/${collectionId}/movies`, body);
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'movie_create');
  }
}

