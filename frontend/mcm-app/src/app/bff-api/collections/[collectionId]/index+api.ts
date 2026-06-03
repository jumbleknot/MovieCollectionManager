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
import { requireMcUser } from '@/bff-server/role-check';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { validateObjectId } from '@/bff-server/resource-id';

// ─── GET /bff-api/collections/:id ─────────────────────────────────────────────

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

    const { status, data } = await client.get(`/api/v1/collections/${collectionId}`);
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'collection_get');
  }
}

// ─── PATCH /bff-api/collections/:id ───────────────────────────────────────────

export async function PATCH(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _patch(req, collectionId));
}

async function _patch(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    validateObjectId(collectionId, 'collectionId');
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const body = await req.json();
    const { status, data } = await client.patch(`/api/v1/collections/${collectionId}`, body);
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'collection_update');
  }
}

// ─── DELETE /bff-api/collections/:id ──────────────────────────────────────────

export async function DELETE(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _delete(req, collectionId));
}

async function _delete(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    validateObjectId(collectionId, 'collectionId');
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const { status } = await client.delete(`/api/v1/collections/${collectionId}`);
    // 204 No Content — no body
    return new Response(null, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'collection_delete');
  }
}

