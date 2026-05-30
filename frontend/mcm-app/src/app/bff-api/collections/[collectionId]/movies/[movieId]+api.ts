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
import { requireMcUser } from '@/bff-server/role-check';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';

// ─── GET /bff-api/collections/:id/movies/:movieId ─────────────────────────────

export async function GET(req: Request, { collectionId, movieId }: { collectionId: string; movieId: string }): Promise<Response> {
  return withRequestContext(() => _get(req, collectionId, movieId));
}

async function _get(req: Request, collectionId: string, movieId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const { status, data } = await client.get(
      `/api/v1/collections/${collectionId}/movies/${movieId}`,
    );
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'movie_get');
  }
}

// ─── PUT /bff-api/collections/:id/movies/:movieId ─────────────────────────────

export async function PUT(req: Request, { collectionId, movieId }: { collectionId: string; movieId: string }): Promise<Response> {
  return withRequestContext(() => _put(req, collectionId, movieId));
}

async function _put(req: Request, collectionId: string, movieId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const body = await req.json();
    const { status, data } = await client.put(
      `/api/v1/collections/${collectionId}/movies/${movieId}`,
      body,
    );
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'movie_update');
  }
}

// ─── DELETE /bff-api/collections/:id/movies/:movieId ──────────────────────────

export async function DELETE(req: Request, { collectionId, movieId }: { collectionId: string; movieId: string }): Promise<Response> {
  return withRequestContext(() => _delete(req, collectionId, movieId));
}

async function _delete(req: Request, collectionId: string, movieId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    await client.delete(`/api/v1/collections/${collectionId}/movies/${movieId}`);
    return new Response(null, { status: 204, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'movie_delete');
  }
}

